import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    buildPrompt,
    ensureLocalModelCatalog,
    isRateLimitError,
    isStaleAgentError,
    rateLimitBackoffMs,
    resetCursorAdapterGates,
    toModelSelection,
} from '../src/models/cursor.js';
import { selectAPI } from '../src/models/_model_map.js';

test.beforeEach(() => {
    resetCursorAdapterGates();
});

test('uses Cursor for the default Andy profile', () => {
    const profile = JSON.parse(readFileSync(new URL('../andy.json', import.meta.url), 'utf8'));

    assert.equal(profile.model.api, 'cursor');
});

test('routes cursor models to the cursor api', () => {
    assert.deepEqual(selectAPI('cursor/composer-2.5'), { api: 'cursor', model: 'composer-2.5' });
    assert.deepEqual(selectAPI('composer-2'), { api: 'cursor', model: 'composer-2' });
});

test('defaults the model and sends no parameters when the profile sets none', () => {
    assert.deepEqual(toModelSelection(null), { id: 'composer-2.5' });
    assert.deepEqual(toModelSelection('gpt-5.6-terra'), { id: 'gpt-5.6-terra' });
});

test('forwards profile params as cursor model parameters', () => {
    assert.deepEqual(toModelSelection('claude-opus-5', { thinking: true, effort: 'high' }), {
        id: 'claude-opus-5',
        params: [
            { id: 'thinking', value: 'true' },
            { id: 'effort', value: 'high' },
        ],
    });
});

test('keeps adapter options out of the model parameters', () => {
    const selection = toModelSelection('composer-2.5', {
        timeout_ms: 30000,
        cwd: '/tmp/scratch',
        sandbox: true,
        mode: 'plan',
        settingSources: ['all'],
        max_sends_per_agent: 10,
        fast: true,
    });

    assert.deepEqual(selection, { id: 'composer-2.5', params: [{ id: 'fast', value: 'true' }] });
});

test('prompts with instructions alone when there are no turns', () => {
    const prompt = buildPrompt([], 'Reply with OK.');

    assert.match(prompt, /<instructions>\nReply with OK\.\n<\/instructions>/);
    assert.doesNotMatch(prompt, /<conversation>/);
});

test('includes the conversation and forbids tool use when there are turns', () => {
    const prompt = buildPrompt(
        [
            { role: 'user', content: 'miner_bob: follow me' },
            { role: 'assistant', content: 'Coming!' },
        ],
        'You are a Minecraft bot named andy.'
    );

    assert.match(prompt, /Do not call tools/);
    assert.match(prompt, /<conversation>\nUser input: miner_bob: follow me\nYour output:\nComing!\n<\/conversation>/);
    assert.match(prompt, /Reply with your next output only\.$/);
});

test('seeds a local model catalog so Agent.create can skip GET /v1/models', () => {
    const env = {};
    const catalog = ensureLocalModelCatalog('gpt-5.4-mini', env);

    assert.equal(catalog, JSON.stringify([{ id: 'gpt-5.4-mini' }]));
    assert.equal(env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON, catalog);
});

test('merges missing models into an existing local catalog without dropping entries', () => {
    const env = {
        CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: JSON.stringify([{ id: 'composer-2.5' }]),
    };

    ensureLocalModelCatalog('gpt-5.4-mini', env);

    assert.deepEqual(JSON.parse(env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON), [
        { id: 'composer-2.5' },
        { id: 'gpt-5.4-mini' },
    ]);
});

test('keeps an existing catalog entry intact when the model is already listed', () => {
    const env = {
        CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON: JSON.stringify({
            items: [{ id: 'gpt-5.4-mini', displayName: 'GPT' }],
        }),
    };

    const before = env.CURSOR_SDK_LOCAL_MODEL_CATALOG_JSON;
    assert.equal(ensureLocalModelCatalog('gpt-5.4-mini', env), before);
});

test('detects Cursor get_models rate limits as retryable', () => {
    const err = new Error('You have exceeded the rate limit of 30 requests per minute for the get_models endpoint');
    err.status = 429;
    err.code = 'rate_limit_exceeded';

    assert.equal(isRateLimitError(err), true);
    assert.equal(isRateLimitError(new Error('Cursor agent run timed out after 120000ms')), false);
});

test('detects stale reused-agent failures that should force a recreate', () => {
    const busy = new Error('Agent is busy');
    busy.name = 'AgentBusyError';
    assert.equal(isStaleAgentError(busy), true);
    assert.equal(isStaleAgentError(new Error('normal failure')), false);
});

test('rate-limit backoff grows with the attempt and stays bounded', () => {
    const first = rateLimitBackoffMs(0);
    const later = rateLimitBackoffMs(4);
    assert.ok(first >= 20000 && first < 26000);
    assert.ok(later >= 120000 && later < 126000);
});
