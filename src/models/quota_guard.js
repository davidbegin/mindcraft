// Model adapters used to swallow request errors and return an opaque fallback string,
// which made exhausted keys, rate limits, and timeouts indistinguishable. This module
// classifies failures, logs them with enough detail to debug, formats chat-facing
// messages, and trips a circuit breaker on non-retryable (quota/auth) outages.

const REPORT_COOLDOWN_MS = 30000;

// Codes that mean "retrying will not help until a human or billing event intervenes".
const FATAL_CODES = new Set([
    'credit_balance_exhausted',
    'insufficient_quota',
    'billing_hard_limit_reached',
    'account_deactivated',
    'invalid_api_key',
]);

const FATAL_TYPES = new Set([
    'insufficient_quota',
]);

// Providers that do not set structured codes still describe the condition in the message.
const FATAL_MESSAGE_PATTERNS = [
    /no credits remaining/i,
    /insufficient (?:quota|credit|balance|funds)/i,
    /exceeded your current quota/i,
    /billing (?:hard limit|details|is not active)/i,
    /add credits to continue/i,
    /quota exceeded/i,
];

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
]);

const KIND_HINTS = {
    auth: 'check API key / credentials',
    quota: 'check billing / plan credits',
    rate_limit: 'back off; too many requests',
    timeout: 'provider took too long',
    context_length: 'shorten conversation context',
    network: 'check network / provider reachability',
    server: 'provider-side failure; retry later',
    stale: 'stale agent session; retry will recreate',
    cancelled: 'request was cancelled',
    vision: 'model does not support images',
    unknown: 'see server logs for details',
};

let outage = null;
let lastFailure = null;
let lastReportAt = 0;
let handler = null;

function errorCode(err) {
    return err?.code ?? err?.error?.code ?? null;
}

function errorType(err) {
    return err?.type ?? err?.error?.type ?? null;
}

function errorMessage(err) {
    return err?.error?.message ?? err?.message ?? '';
}

function errorStatus(err) {
    const status = err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
    return typeof status === 'number' ? status : null;
}

function errorName(err) {
    return err?.name || '';
}

function truncate(text, max = 180) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= max) return cleaned;
    return `${cleaned.slice(0, max - 1)}…`;
}

function isFatalQuota(code, type, status, message) {
    if (FATAL_CODES.has(code) || FATAL_TYPES.has(type)) return true;
    if (status === 402) return true;
    if (status === 429 && FATAL_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return true;
    if (!status && FATAL_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) return true;
    return false;
}

/**
 * Full diagnosis of a model-provider failure for logging, chat messages, and state.
 * `fatalKind` is 'auth' | 'quota' | null (same contract as classifyModelError).
 */
export function describeModelError(err) {
    if (!err) {
        return {
            kind: 'unknown',
            fatalKind: null,
            retryable: true,
            status: null,
            code: null,
            type: null,
            name: null,
            message: '',
            hint: KIND_HINTS.unknown,
        };
    }

    const code = errorCode(err);
    const type = errorType(err);
    const status = errorStatus(err);
    const message = errorMessage(err);
    const name = errorName(err);
    const lower = message.toLowerCase();

    let kind = 'unknown';
    let fatalKind = null;
    let retryable = true;

    // Soft Cursor-session auth ("Authentication error… try logging out") is often a
    // stale local Agent handle — recoverable by recreating the agent. Hard auth
    // (401/403/invalid_api_key) will not recover without human intervention.
    const softAuth = /authentication error/i.test(message)
        || /try logging out and back in/i.test(message)
        || /not (?:logged|signed) in/i.test(message)
        || /unauthorized/i.test(message);
    if (code === 'invalid_api_key' || status === 401 || status === 403) {
        kind = 'auth';
        fatalKind = 'auth';
        retryable = false;
    } else if (softAuth) {
        kind = 'auth';
        fatalKind = null;
        retryable = true;
    } else if (isFatalQuota(code, type, status, message)) {
        kind = 'quota';
        fatalKind = 'quota';
        retryable = false;
    } else if (
        status === 429
        || code === 'rate_limit_exceeded'
        || /rate limit/i.test(message)
    ) {
        kind = 'rate_limit';
    } else if (
        name === 'TimeoutError'
        || code === 'ETIMEDOUT'
        || /timed?\s*out/i.test(message)
        || /deadline exceeded/i.test(message)
    ) {
        kind = 'timeout';
    } else if (
        code === 'context_length_exceeded'
        || /context length/i.test(message)
        || /maximum context/i.test(message)
        || /too many tokens/i.test(message)
    ) {
        kind = 'context_length';
    } else if (
        NETWORK_CODES.has(code)
        || /fetch failed/i.test(message)
        || /network/i.test(message)
        || /socket/i.test(message)
        || /econnrefused/i.test(message)
    ) {
        kind = 'network';
    } else if (
        name === 'AgentBusyError'
        || /agent (?:is )?busy/i.test(message)
        || /agent .* not found/i.test(message)
        || /disposed/i.test(message)
    ) {
        kind = 'stale';
    } else if (
        name === 'AbortError'
        || /aborted|cancelled|canceled/i.test(message)
    ) {
        kind = 'cancelled';
    } else if (
        /does not support image/i.test(message)
        || /vision/i.test(message) && /not support|only supported/i.test(message)
    ) {
        kind = 'vision';
        retryable = false;
    } else if (typeof status === 'number' && status >= 500) {
        kind = 'server';
    } else if (/server error|internal error|bad gateway|service unavailable/i.test(lower)) {
        kind = 'server';
    }

    return {
        kind,
        fatalKind,
        retryable,
        status,
        code: code != null ? String(code) : null,
        type: type != null ? String(type) : null,
        name: name || null,
        message,
        hint: KIND_HINTS[kind] || KIND_HINTS.unknown,
    };
}

/**
 * Returns 'quota' or 'auth' for failures that will keep failing until billing or
 * credentials change, and null for transient failures such as ordinary rate limiting,
 * timeouts, and context-length problems.
 */
export function classifyModelError(err) {
    return describeModelError(err).fatalKind;
}

/** Short in-game / UI message that names the failure class instead of a blank disconnect. */
export function formatBrainDisconnectMessage(err, { provider = null } = {}) {
    const info = describeModelError(err);
    const where = provider ? ` via ${provider}` : '';
    const detail = truncate(info.message, 100);

    switch (info.kind) {
        case 'auth':
            return info.retryable
                ? `My brain hit an auth glitch${where}; retrying with a fresh session.`
                : `My brain can't authenticate${where} — check the API key.`;
        case 'quota':
            return `My brain is out of credits/quota${where} — check billing.`;
        case 'rate_limit':
            return `My brain hit a rate limit${where}; backing off, then try again.`;
        case 'timeout':
            return `My brain timed out${where}. Try again.`;
        case 'context_length':
            return `My brain ran out of context space${where}. Try again with a shorter history.`;
        case 'network':
            return `My brain can't reach the model provider${where} (network). Try again.`;
        case 'server':
            return `Model provider error${where}${info.status ? ` (${info.status})` : ''}. Try again.`;
        case 'stale':
            return `My brain session went stale${where}; retrying next turn.`;
        case 'cancelled':
            return `My brain request was cancelled${where}. Try again.`;
        case 'vision':
            return 'Vision is only supported by certain models.';
        default:
            return detail
                ? `My brain disconnected${where} (${info.kind}): ${detail}`
                : `My brain disconnected${where} (${info.kind}). Check server logs.`;
    }
}

/** True when a model response is one of our synthetic failure strings (not real LLM output). */
export function isModelFailureMessage(text) {
    if (typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    return /^My brain (?:disconnected|can't|hit|timed|ran out|session|request)/i.test(trimmed)
        || /^Model provider error/i.test(trimmed)
        || trimmed === 'Vision is only supported by certain models.';
}

/**
 * Structured console logging so "brain disconnected" incidents leave a greppable trail.
 * Emits one JSON line plus a human summary; includes the stack when present.
 */
export function logModelFailure(provider, err, { model = null } = {}) {
    const info = describeModelError(err);
    const payload = {
        at: new Date().toISOString(),
        provider: provider || null,
        model: model || null,
        kind: info.kind,
        fatal: info.fatalKind,
        retryable: info.retryable,
        status: info.status,
        code: info.code,
        type: info.type,
        name: info.name,
        hint: info.hint,
        message: truncate(info.message, 500),
    };
    console.error('[model-failure]', JSON.stringify(payload));
    console.error(
        `[model:${provider || 'unknown'}] ${info.kind}`
        + `${info.status != null ? ` status=${info.status}` : ''}`
        + `${info.code ? ` code=${info.code}` : ''}`
        + ` retryable=${info.retryable}`
        + `${model ? ` model=${model}` : ''}`
        + `: ${truncate(info.message, 300) || '(no message)'}`
        + ` — ${info.hint}`
    );
    if (err?.stack) {
        console.error(err.stack);
    }
    return info;
}

/**
 * Shared catch-path for model adapters: record, log, and return a chat-facing message.
 */
export function handleModelRequestError(err, { provider = null, model = null } = {}) {
    noteModelFailure(err, { provider, model });
    logModelFailure(provider, err, { model });
    return formatBrainDisconnectMessage(err, { provider });
}

export function setOutageHandler(fn) {
    handler = fn;
}

export function getOutage() {
    return outage ? { ...outage } : null;
}

/** Most recent provider failure (fatal or transient), for UI / debugging. */
export function getLastModelFailure() {
    return lastFailure ? { ...lastFailure } : null;
}

export function isModelHealthy() {
    return outage === null;
}

/** Clears a recorded outage so the next failure is reported again. */
export function resetOutage() {
    outage = null;
    lastFailure = null;
    lastReportAt = 0;
}

export function noteModelSuccess() {
    if (outage !== null) {
        outage = null;
        lastReportAt = 0;
    }
    if (lastFailure !== null) {
        lastFailure = null;
    }
}

/**
 * Records a provider failure. Always updates lastFailure. Fatal failures also invoke the
 * outage handler, rate limited so a burst of concurrent requests reports once.
 */
export function noteModelFailure(err, { provider = null, model = null } = {}) {
    const info = describeModelError(err);
    lastFailure = {
        kind: info.kind,
        fatalKind: info.fatalKind,
        retryable: info.retryable,
        status: info.status,
        code: info.code ?? (info.status != null ? String(info.status) : 'unknown'),
        message: info.message || 'Model provider rejected the request',
        hint: info.hint,
        provider: provider || null,
        model: model || null,
        at: Date.now(),
    };

    if (!info.fatalKind) return null;

    outage = {
        kind: info.fatalKind,
        code: lastFailure.code,
        message: lastFailure.message,
        at: lastFailure.at,
        detailKind: info.kind,
        provider: provider || null,
        model: model || null,
    };

    const now = Date.now();
    if (handler && now - lastReportAt >= REPORT_COOLDOWN_MS) {
        lastReportAt = now;
        try {
            const result = handler({ ...outage });
            if (result && typeof result.catch === 'function') {
                result.catch(error => console.error('Model outage handler failed:', error));
            }
        } catch (error) {
            console.error('Model outage handler failed:', error);
        }
    }
    return { ...outage };
}
