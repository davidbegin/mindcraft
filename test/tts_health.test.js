import assert from 'node:assert/strict';
import test from 'node:test';

import {
    describeVoiceError,
    formatVoiceProblem,
    getLastVoiceFailure,
    getVoiceHealth,
    getVoiceOutage,
    isVoiceHealthy,
    noteVoiceFailure,
    noteVoiceFailureReport,
    noteVoiceSuccess,
    resetVoiceHealth,
    setVoiceHealthHandler,
} from '../src/agent/tts_health.js';
import { ElevenLabsTTSError } from '../src/models/elevenlabs.js';

// The exact response that silenced the cast: ElevenLabs reports an exhausted
// account with 401, the same status it uses for a bad key.
function quotaExhaustedError() {
    return new ElevenLabsTTSError({
        status: 401,
        code: 'quota_exceeded',
        message: 'ElevenLabs TTS request failed (401): This request exceeds your quota of 90000. '
            + 'You have 0 credits remaining, while 18 credits are required for this request.',
        body: '{"detail":{"code":"quota_exceeded"}}',
    });
}

function badKeyError() {
    return new ElevenLabsTTSError({
        status: 401,
        code: 'unauthorized',
        message: 'ElevenLabs TTS request failed (401): The API key you used is invalid.',
        body: '',
    });
}

test.beforeEach(() => {
    setVoiceHealthHandler(null);
    resetVoiceHealth();
});

test('reads an exhausted quota as quota, not as a bad key, despite the 401', () => {
    const info = describeVoiceError(quotaExhaustedError());
    assert.equal(info.kind, 'quota');
    assert.equal(info.fatal, true);
    assert.equal(info.status, 401);
    assert.equal(info.code, 'quota_exceeded');
});

test('still separates a genuinely rejected key from an exhausted one', () => {
    assert.equal(describeVoiceError(badKeyError()).kind, 'auth');
});

test('recognizes an exhausted account from the message when no code is set', () => {
    const err = new Error('ElevenLabs TTS request failed: You have 0 credits remaining');
    assert.equal(describeVoiceError(err).kind, 'quota');
});

test('reads a missing api key as a configuration problem', () => {
    const missing = new Error('API key "ELEVENLABS_API_KEY" not found in keys.json or environment variables!');
    assert.equal(describeVoiceError(missing).kind, 'config');
    assert.equal(describeVoiceError(new Error('ELEVENLABS_API_KEY is not configured')).kind, 'config');
});

test('treats rate limiting as transient so it never becomes a sticky banner', () => {
    const err = new ElevenLabsTTSError({ status: 429, code: null, message: 'too many requests', body: '' });
    const info = describeVoiceError(err);
    assert.equal(info.kind, 'rate_limit');
    assert.equal(info.fatal, false);

    noteVoiceFailure(err);
    assert.equal(isVoiceHealthy(), true);
    assert.equal(getVoiceOutage(), null);
    // The failure is still recorded for the UI even though it raises no outage.
    assert.equal(getLastVoiceFailure().kind, 'rate_limit');
});

test('an exhausted quota raises an outage the operator can see', () => {
    noteVoiceFailure(quotaExhaustedError(), { botName: 'andy' });

    const health = getVoiceHealth();
    assert.equal(health.ok, false);
    assert.equal(health.outage.kind, 'quota');
    assert.equal(health.outage.botName, 'andy');
    assert.match(health.summary, /out of TTS credits/i);
});

test('reports a fatal failure to the handler exactly once per burst', () => {
    const reported = [];
    setVoiceHealthHandler(health => reported.push(health));

    // A chatty cast: many bots hit the same exhausted account back to back.
    for (let i = 0; i < 5; i++) noteVoiceFailure(quotaExhaustedError());

    assert.equal(reported.length, 1);
    assert.equal(reported[0].outage.kind, 'quota');
});

test('counts one rejection once even though several layers report it', () => {
    const err = quotaExhaustedError();
    // Generation records it, then the playback queue reports the same object.
    noteVoiceFailure(err);
    noteVoiceFailure(err);
    noteVoiceFailure(err);

    assert.equal(getVoiceHealth().failureCount, 1);
});

test('a line that reaches the speakers clears the banner and says so', () => {
    const reported = [];
    noteVoiceFailure(quotaExhaustedError());
    setVoiceHealthHandler(health => reported.push(health));

    assert.equal(noteVoiceSuccess(), true);
    assert.equal(isVoiceHealthy(), true);
    assert.equal(getVoiceHealth().outage, null);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].ok, true);
});

test('a success while healthy does not spam the handler', () => {
    const reported = [];
    setVoiceHealthHandler(health => reported.push(health));
    assert.equal(noteVoiceSuccess(), false);
    assert.equal(reported.length, 0);
});

test('ingests a failure relayed from an agent process', () => {
    // Agents generate their own audio, so the server only learns of the
    // failure through the relayed report.
    noteVoiceFailureReport({
        kind: 'quota',
        fatal: true,
        status: 401,
        code: 'quota_exceeded',
        message: 'no credits',
        provider: 'elevenlabs',
        botName: 'builder',
        at: Date.now(),
    });

    const outage = getVoiceOutage();
    assert.equal(outage.kind, 'quota');
    assert.equal(outage.botName, 'builder');
    assert.equal(isVoiceHealthy(), false);
});

test('blames the host, not the provider, when playback is what failed', () => {
    const err = new Error('spawn ffplay ENOENT');
    err.code = 'ENOENT';
    assert.equal(describeVoiceError(err).kind, 'playback');
    assert.match(formatVoiceProblem({ kind: 'playback' }), /could not be played/i);
});

test('a handler that throws does not take down the caller', () => {
    setVoiceHealthHandler(() => { throw new Error('dashboard exploded'); });
    assert.doesNotThrow(() => noteVoiceFailure(quotaExhaustedError()));
    assert.equal(getVoiceOutage().kind, 'quota');
});
