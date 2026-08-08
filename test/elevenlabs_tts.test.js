import assert from 'node:assert/strict';
import test from 'node:test';

import { TTSConfig, ElevenLabsTTSError } from '../src/models/elevenlabs.js';

// The key is only read when a request is made, not at import time, so this is
// enough to exercise the adapter on a machine with no keys.json and no account.
process.env.ELEVENLABS_API_KEY ||= 'test-key';

function stubFetch(response) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => {
        calls.push({ url, options });
        return Promise.resolve(response);
    };
    return {
        calls,
        restore() {
            globalThis.fetch = original;
        },
    };
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(JSON.stringify(body)),
    };
}

test('surfaces the provider status code so an exhausted quota is not read as a bad key', async () => {
    const fetchStub = stubFetch(jsonResponse(401, {
        detail: {
            type: 'invalid_request',
            code: 'quota_exceeded',
            status: 'quota_exceeded',
            message: 'This request exceeds your quota of 90000. You have 0 credits remaining.',
        },
    }));

    try {
        await assert.rejects(
            () => TTSConfig.sendAudioRequest('hello', 'eleven_flash_v2_5', 'voice-1'),
            error => {
                assert.ok(error instanceof ElevenLabsTTSError);
                assert.equal(error.status, 401);
                assert.equal(error.code, 'quota_exceeded');
                assert.equal(error.provider, 'elevenlabs');
                assert.match(error.message, /0 credits remaining/);
                return true;
            }
        );
    } finally {
        fetchStub.restore();
    }
});

test('keeps a bare string detail readable', async () => {
    const fetchStub = stubFetch(jsonResponse(422, { detail: 'voice_id is required' }));
    try {
        await assert.rejects(
            () => TTSConfig.sendAudioRequest('hello', 'model', 'voice-1'),
            error => {
                assert.equal(error.status, 422);
                assert.equal(error.code, null);
                assert.match(error.message, /voice_id is required/);
                return true;
            }
        );
    } finally {
        fetchStub.restore();
    }
});

test('falls back to the raw body when the error is not json', async () => {
    const fetchStub = stubFetch({
        ok: false,
        status: 502,
        text: () => Promise.resolve('<html>Bad Gateway</html>'),
    });
    try {
        await assert.rejects(
            () => TTSConfig.sendAudioRequest('hello', 'model', 'voice-1'),
            error => {
                assert.equal(error.status, 502);
                assert.match(error.message, /Bad Gateway/);
                return true;
            }
        );
    } finally {
        fetchStub.restore();
    }
});

test('returns base64 audio and sends the voice and model that were asked for', async () => {
    const fetchStub = stubFetch({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode('fake-mp3').buffer),
    });
    try {
        const audio = await TTSConfig.sendAudioRequest('hello', 'eleven_flash_v2_5', 'voice-42');
        assert.equal(atob(audio), 'fake-mp3');

        const [call] = fetchStub.calls;
        assert.match(call.url, /\/text-to-speech\/voice-42\?/);
        assert.equal(JSON.parse(call.options.body).model_id, 'eleven_flash_v2_5');
        // Never assert the key's value: a real one is present on dev machines.
        assert.ok(call.options.headers['xi-api-key']);
    } finally {
        fetchStub.restore();
    }
});
