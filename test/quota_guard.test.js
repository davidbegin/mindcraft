import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyModelError,
    getOutage,
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
