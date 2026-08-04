import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyModelError,
    describeModelError,
    formatBrainDisconnectMessage,
    getLastModelFailure,
    getOutage,
    handleModelRequestError,
    isModelFailureMessage,
    isModelHealthy,
    noteModelFailure,
    noteModelSuccess,
    resetOutage,
    setOutageHandler,
} from '../src/models/quota_guard.js';

// Shape of the error the openai sdk throws when the account has no credits left.
function creditsExhaustedError() {
    const err = new Error('429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.');
    err.status = 429;
    err.code = 'credit_balance_exhausted';
    err.type = 'insufficient_quota';
    return err;
}

function rateLimitedError() {
    const err = new Error('429 Rate limit reached for gpt-5.4-mini in organization org-x on requests per min.');
    err.status = 429;
    err.code = 'rate_limit_exceeded';
    err.type = 'requests';
    return err;
}

test.beforeEach(() => {
    setOutageHandler(null);
    resetOutage();
});

test('classifies exhausted credits as a fatal quota failure', () => {
    assert.equal(classifyModelError(creditsExhaustedError()), 'quota');
});

test('treats ordinary rate limiting as transient so the breaker stays closed', () => {
    assert.equal(classifyModelError(rateLimitedError()), null);
    noteModelFailure(rateLimitedError());
    assert.equal(isModelHealthy(), true);
    assert.equal(getOutage(), null);
});

test('classifies revoked credentials as an auth failure', () => {
    const err = new Error('401 Incorrect API key provided');
    err.status = 401;
    err.code = 'invalid_api_key';
    assert.equal(classifyModelError(err), 'auth');
});

test('recognizes billing failures from the message when no code is set', () => {
    const err = new Error('You exceeded your current quota, please check your plan and billing details.');
    err.status = 429;
    assert.equal(classifyModelError(err), 'quota');
});

test('ignores transient failures that carry no billing signal', () => {
    const timeout = new Error('Request timed out');
    timeout.status = 500;
    assert.equal(classifyModelError(timeout), null);
    assert.equal(classifyModelError(new Error('Context length exceeded')), null);
    assert.equal(classifyModelError(null), null);
});

test('reports a fatal failure once per burst instead of once per request', () => {
    const reported = [];
    setOutageHandler(outage => reported.push(outage));

    for (let attempt = 0; attempt < 25; attempt += 1) {
        noteModelFailure(creditsExhaustedError());
    }

    assert.equal(reported.length, 1);
    assert.equal(reported[0].kind, 'quota');
    assert.equal(reported[0].code, 'credit_balance_exhausted');
    assert.equal(isModelHealthy(), false);
});

test('a successful request closes the breaker and re-arms reporting', () => {
    const reported = [];
    setOutageHandler(outage => reported.push(outage));

    noteModelFailure(creditsExhaustedError());
    assert.equal(isModelHealthy(), false);

    noteModelSuccess();
    assert.equal(isModelHealthy(), true);
    assert.equal(getOutage(), null);
    assert.equal(getLastModelFailure(), null);

    noteModelFailure(creditsExhaustedError());
    assert.equal(reported.length, 2, 'a new outage after recovery must be reported again');
});

test('a throwing outage handler does not break failure recording', () => {
    setOutageHandler(() => {
        throw new Error('handler exploded');
    });
    assert.doesNotThrow(() => noteModelFailure(creditsExhaustedError()));
    assert.equal(isModelHealthy(), false);
});

test('a rejecting async outage handler does not produce an unhandled rejection', async () => {
    setOutageHandler(() => Promise.reject(new Error('async handler exploded')));
    noteModelFailure(creditsExhaustedError());
    // Let the rejection settle so an unattached catch would surface as a test failure.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(isModelHealthy(), false);
});

test('describes common Cursor-style failures with actionable kinds', () => {
    const rate = describeModelError(rateLimitedError());
    assert.equal(rate.kind, 'rate_limit');
    assert.equal(rate.retryable, true);
    assert.equal(rate.fatalKind, null);

    const timeout = new Error('Cursor agent run timed out after 120000ms');
    assert.equal(describeModelError(timeout).kind, 'timeout');

    const stale = new Error('Agent is busy');
    stale.name = 'AgentBusyError';
    assert.equal(describeModelError(stale).kind, 'stale');

    const network = new Error('fetch failed');
    network.code = 'ECONNREFUSED';
    assert.equal(describeModelError(network).kind, 'network');
});

test('soft Cursor session auth is classified as auth but not a fatal outage', () => {
    const soft = new Error(
        'Cursor agent run error: Authentication error If you are logged in, try logging out and back in.'
    );
    const info = describeModelError(soft);
    assert.equal(info.kind, 'auth');
    assert.equal(info.retryable, true);
    assert.equal(info.fatalKind, null);

    noteModelFailure(soft, { provider: 'cursor' });
    assert.equal(isModelHealthy(), true, 'soft auth must not pause the colony');
    assert.equal(getOutage(), null);

    assert.match(
        formatBrainDisconnectMessage(soft, { provider: 'cursor' }),
        /auth glitch via cursor/i
    );
    assert.equal(
        isModelFailureMessage(formatBrainDisconnectMessage(soft, { provider: 'cursor' })),
        true
    );
});

test('hard auth (401 / invalid key) still trips the breaker', () => {
    const err = new Error('401 Incorrect API key provided');
    err.status = 401;
    err.code = 'invalid_api_key';
    const info = describeModelError(err);
    assert.equal(info.kind, 'auth');
    assert.equal(info.fatalKind, 'auth');
    assert.equal(info.retryable, false);

    noteModelFailure(err);
    assert.equal(isModelHealthy(), false);
});

test('legacy opaque disconnect strings are treated as model failure messages', () => {
    assert.equal(isModelFailureMessage('My brain disconnected, try again.'), true);
    assert.equal(isModelFailureMessage('My brain disconnected via cursor (unknown). Check server logs.'), true);
});

test('formats chat messages that name the failure instead of a blank disconnect', () => {
    assert.match(
        formatBrainDisconnectMessage(rateLimitedError(), { provider: 'cursor' }),
        /rate limit via cursor/i
    );
    assert.match(
        formatBrainDisconnectMessage(new Error('Cursor agent run timed out after 120000ms'), { provider: 'cursor' }),
        /timed out via cursor/i
    );
    assert.match(
        formatBrainDisconnectMessage(creditsExhaustedError(), { provider: 'openai' }),
        /credits\/quota via openai/i
    );
});

test('records transient failures for UI while leaving the breaker closed', () => {
    noteModelFailure(rateLimitedError(), { provider: 'cursor', model: 'composer-2.5' });
    const last = getLastModelFailure();
    assert.equal(isModelHealthy(), true);
    assert.equal(last.kind, 'rate_limit');
    assert.equal(last.provider, 'cursor');
    assert.equal(last.model, 'composer-2.5');
    assert.equal(last.retryable, true);
});

test('handleModelRequestError returns a diagnostic chat string', () => {
    const msg = handleModelRequestError(rateLimitedError(), { provider: 'cursor', model: 'composer-2.5' });
    assert.match(msg, /rate limit/i);
    assert.equal(isModelFailureMessage(msg), true);
    assert.equal(isModelFailureMessage('Going mining for iron.'), false);
});
