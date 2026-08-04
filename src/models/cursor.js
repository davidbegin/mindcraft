import { Agent, JsonlLocalAgentStore } from '@cursor/sdk';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getKey } from '../utils/keys.js';
import { stringifyTurns } from '../utils/text.js';
import { handleModelRequestError, noteModelSuccess } from './quota_guard.js';

// Cursor exposes agents, not chat completions. The bot's own history stays authoritative:
// each send embeds the full conversation in the prompt. We still reuse one local Agent per
// adapter instance so Agent.create does not hammer GET /v1/models (30 RPM) on every turn.
const DEFAULT_MODEL = 'composer-2.5';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_SENDS_PER_AGENT = 25;
const MAX_RATE_LIMIT_RETRIES = 3;
const CREATE_MIN_INTERVAL_MS = 2500;
const RATE_LIMIT_BASE_MS = 20000;
const CATALOG_ENV = 'CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON';

// Options consumed by this adapter rather than forwarded as model parameters.
const ADAPTER_PARAMS = new Set([
    'cwd',
    'settingSources',
    'sandbox',
    'mode',
    'timeout_ms',
    'max_sends_per_agent',
]);

const DIRECTIVE = [
    'You are answering as the character described in the instructions below, not acting as a coding assistant.',
    'Do not call tools, read or write files, or run commands.',
    'Your whole reply is used verbatim, so respond with the answer alone: no preamble, no explanation, no markdown fences.',
].join(' ');

// Process-local gates shared by every CursorSDK instance in this agent process.
let createChain = Promise.resolve();
let lastCreateAt = 0;
let rateLimitUntil = 0;

export class CursorSDK {
    static prefix = 'cursor';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params || {};
        if (url) {
            console.warn("Cursor doesn't support custom urls!");
        }
        this.api_key = getKey('CURSOR_API_KEY');
        this.timeout_ms = this.params.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        this.max_sends_per_agent = this.params.max_sends_per_agent ?? MAX_SENDS_PER_AGENT;
        this.cwd = this.params.cwd || null;
        this._agent = null;
        this._sends = 0;
        this._run_mutex = Promise.resolve();
        // Seed before the first create so concurrent colony bots skip GET /v1/models.
        ensureLocalModelCatalog(this.model_name || DEFAULT_MODEL);
    }

    async sendRequest(turns, systemMessage, stop_seq = '***') {
        const prompt = buildPrompt(turns, systemMessage);
        try {
            console.log('Awaiting cursor agent response from model', this.model_name || DEFAULT_MODEL);
            let res = await this.#runWithRetries(prompt);
            console.log('Received.');
            const stop_seq_index = res.indexOf(stop_seq);
            if (stop_seq_index !== -1) {
                res = res.slice(0, stop_seq_index);
            }
            noteModelSuccess();
            return res;
        }
        catch (err) {
            await this.#backoffIfRateLimited(err);
            return handleModelRequestError(err, {
                provider: 'cursor',
                model: this.model_name || DEFAULT_MODEL,
            });
        }
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        const images = [{ data: imageBuffer.toString('base64'), mimeType: 'image/jpeg' }];
        const prompt = buildPrompt(turns, systemMessage);
        try {
            console.log('Awaiting cursor agent vision response from model', this.model_name || DEFAULT_MODEL);
            const res = await this.#runWithRetries(prompt, images);
            console.log('Received.');
            noteModelSuccess();
            return res;
        }
        catch (err) {
            await this.#backoffIfRateLimited(err);
            return handleModelRequestError(err, {
                provider: 'cursor',
                model: this.model_name || DEFAULT_MODEL,
            });
        }
    }

    async embed(_) {
        throw new Error('Embeddings are not supported by Cursor.');
    }

    async #runWithRetries(text, images = null) {
        let lastErr = null;
        // Rate-limit retries + one extra slot so a stale-session auth failure can
        // drop the Agent handle and succeed on a fresh create.
        const maxAttempts = MAX_RATE_LIMIT_RETRIES + 1;
        let authRetried = false;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                await waitOutRateLimit();
                return await this.#run(text, images);
            }
            catch (err) {
                lastErr = err;
                if (isRateLimitError(err) && attempt < MAX_RATE_LIMIT_RETRIES - 1) {
                    await this.#dropAgent();
                    await this.#backoffIfRateLimited(err, attempt);
                    continue;
                }
                if (isRecoverableAuthError(err) && !authRetried) {
                    authRetried = true;
                    console.warn(
                        'Cursor agent auth failed on existing session; '
                        + 'dropping handle and retrying once with a fresh agent.'
                    );
                    await this.#dropAgent();
                    await sleep(500);
                    continue;
                }
                if (isStaleAgentError(err) && attempt < maxAttempts - 1) {
                    await this.#dropAgent();
                    await sleep(250);
                    continue;
                }
                throw err;
            }
        }
        throw lastErr;
    }

    async #run(text, images = null) {
        const runExclusive = this._run_mutex.then(() => this.#runExclusive(text, images));
        this._run_mutex = runExclusive.catch(() => {});
        return runExclusive;
    }

    async #runExclusive(text, images = null) {
        const agent = await this.#getAgent();
        try {
            const run = await agent.send(images ? { text, images } : text);
            this._sends += 1;
            const result = await this.#wait(run);
            if (result.status !== 'finished') {
                throw new Error(`Cursor agent run ${result.status}: ${result.error?.message || 'no details'}`);
            }
            if (this._sends >= this.max_sends_per_agent) {
                await this.#dropAgent();
            }
            return (result.result || '').trim();
        }
        catch (err) {
            // A broken/busy/auth-poisoned handle should not poison every later turn.
            if (isRateLimitError(err) || isStaleAgentError(err) || isRecoverableAuthError(err)) {
                await this.#dropAgent();
            }
            throw err;
        }
    }

    async #getAgent() {
        if (this._agent) {
            return this._agent;
        }
        ensureLocalModelCatalog(this.model_name || DEFAULT_MODEL);
        this._agent = await withCreateGate(() => Agent.create({
            apiKey: this.api_key,
            model: toModelSelection(this.model_name, this.params),
            mode: this.params.mode || 'agent',
            local: {
                cwd: this.#workspace(),
                // Default Cursor store needs node:sqlite (Node >= 22.13). Use JSONL so
                // bots keep working on the Node 20 runtime this project pins.
                store: this.#store(),
                // Ambient project/user/team settings would drag this machine's rules and
                // hooks into every bot turn.
                settingSources: this.params.settingSources || [],
                ...(this.params.sandbox ? { sandboxOptions: { enabled: true } } : {}),
            },
        }));
        this._sends = 0;
        return this._agent;
    }

    async #dropAgent() {
        const agent = this._agent;
        this._agent = null;
        this._sends = 0;
        if (!agent) {
            return;
        }
        await agent[Symbol.asyncDispose]().catch(err => {
            console.warn('Failed to dispose cursor agent:', err?.message || err);
        });
    }

    async #backoffIfRateLimited(err, attempt = 0) {
        if (!isRateLimitError(err)) {
            return 0;
        }
        const delay = rateLimitBackoffMs(attempt);
        markRateLimited(delay);
        console.warn(`Cursor rate limited; backing off ${Math.round(delay / 1000)}s`);
        await sleep(delay);
        return delay;
    }

    async #wait(run) {
        if (!this.timeout_ms || this.timeout_ms < 0) {
            return run.wait();
        }
        const waiting = run.wait();
        waiting.catch(() => {}); // the losing side of the race must not surface as an unhandled rejection
        let timer = null;
        try {
            return await Promise.race([
                waiting,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error(`Cursor agent run timed out after ${this.timeout_ms}ms`)),
                        this.timeout_ms
                    );
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
            if (run.status === 'running' && run.supports('cancel')) {
                await run.cancel().catch(err => console.warn('Failed to cancel cursor run:', err.message));
            }
        }
    }

    // Local agents always get a workspace. An empty scratch directory keeps a run that
    // reaches for a tool anyway away from the mindcraft repo.
    #workspace() {
        if (!this.cwd) {
            this.cwd = mkdtempSync(path.join(tmpdir(), 'mindcraft-cursor-'));
        }
        return this.cwd;
    }

    #store() {
        if (!this._store) {
            this._store = new JsonlLocalAgentStore(path.join(this.#workspace(), '.cursor-store'));
        }
        return this._store;
    }
}

export function buildPrompt(turns, systemMessage) {
    const sections = [DIRECTIVE, `<instructions>\n${systemMessage}\n</instructions>`];
    if (turns && turns.length > 0) {
        sections.push(`<conversation>\n${stringifyTurns(turns)}\n</conversation>`);
        sections.push('Reply with your next output only.');
    }
    return sections.join('\n\n');
}

/** Profile params double as Cursor model parameters, e.g. `{"fast": true}` or `{"effort": "high"}`. */
export function toModelSelection(model_name, params = {}) {
    const selection = { id: model_name || DEFAULT_MODEL };
    const model_params = Object.entries(params)
        .filter(([id]) => !ADAPTER_PARAMS.has(id))
        .map(([id, value]) => ({ id, value: String(value) }));
    if (model_params.length > 0) {
        selection.params = model_params;
    }
    return selection;
}

/**
 * Seeds CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON so Agent.create can validate the model
 * without calling GET /v1/models (hard-capped at 30 RPM and cleared on every 429).
 */
export function ensureLocalModelCatalog(modelId, env = process.env) {
    const id = modelId || DEFAULT_MODEL;
    const existing = env[CATALOG_ENV];
    if (existing) {
        try {
            const parsed = JSON.parse(existing);
            const items = Array.isArray(parsed) ? parsed : parsed?.items;
            if (Array.isArray(items) && items.some(item => item && item.id === id)) {
                return env[CATALOG_ENV];
            }
            const merged = Array.isArray(items) ? [...items, { id }] : [{ id }];
            env[CATALOG_ENV] = JSON.stringify(merged);
            return env[CATALOG_ENV];
        }
        catch {
            // Fall through and rewrite an invalid value.
        }
    }
    env[CATALOG_ENV] = JSON.stringify([{ id }]);
    return env[CATALOG_ENV];
}

export function isRateLimitError(err) {
    if (!err) return false;
    if (err.status === 429) return true;
    if (err.code === 'rate_limit_exceeded') return true;
    const message = err.message || err.error?.message || '';
    return /rate limit/i.test(message);
}

export function isStaleAgentError(err) {
    const name = err?.name || '';
    const message = err?.message || '';
    return name === 'AgentBusyError'
        || /agent (?:is )?busy/i.test(message)
        || /agent .* not found/i.test(message)
        || /disposed/i.test(message);
}

/**
 * Soft auth failures from a long-lived local Agent session. A fresh Agent.create
 * usually recovers; hard 401/403 / invalid_api_key are NOT treated as recoverable here.
 */
export function isRecoverableAuthError(err) {
    if (!err) return false;
    if (err.status === 401 || err.status === 403 || err.code === 'invalid_api_key') {
        return false;
    }
    const message = err.message || err.error?.message || '';
    return /authentication error/i.test(message)
        || /try logging out and back in/i.test(message);
}

export function rateLimitBackoffMs(attempt = 0) {
    const exp = Math.min(RATE_LIMIT_BASE_MS * (2 ** attempt), 120000);
    return exp + Math.floor(Math.random() * 5000);
}

/** Test helper: clears process-local create/rate-limit gates. */
export function resetCursorAdapterGates() {
    createChain = Promise.resolve();
    lastCreateAt = 0;
    rateLimitUntil = 0;
}

function markRateLimited(delayMs) {
    rateLimitUntil = Math.max(rateLimitUntil, Date.now() + delayMs);
}

async function waitOutRateLimit() {
    const wait = Math.max(0, rateLimitUntil - Date.now());
    if (wait > 0) {
        await sleep(wait);
    }
}

function withCreateGate(fn) {
    const run = createChain.then(async () => {
        await waitOutRateLimit();
        const spacing = Math.max(0, CREATE_MIN_INTERVAL_MS - (Date.now() - lastCreateAt));
        if (spacing > 0) {
            await sleep(spacing);
        }
        lastCreateAt = Date.now();
        return fn();
    });
    createChain = run.catch(() => {});
    return run;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
