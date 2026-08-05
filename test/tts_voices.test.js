import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Point the module at a sandbox config before importing it, so the tests
// never touch the real voices.json.
const configPath = path.join(mkdtempSync(path.join(tmpdir(), 'voices-test-')), 'voices.json');
process.env.MINDCRAFT_VOICES_PATH = configPath;

const {
    VOICE_POOL, VOICE_DESCRIPTIONS, DEFAULT_ELEVENLABS_MODEL,
    getVoicesConfig, saveVoicesConfig, autoVoiceName, resolveVoice, resolveVoiceName,
    getElevenLabsModel,
} = await import('../src/agent/tts_voices.js');

test('every pool voice has a description', () => {
    for (const name of Object.keys(VOICE_POOL)) {
        assert.ok(VOICE_DESCRIPTIONS[name], `missing description for ${name}`);
    }
});

test('defaults when no config file exists', () => {
    assert.equal(existsSync(configPath), false);
    assert.deepEqual(getVoicesConfig(), {
        elevenlabs_model: DEFAULT_ELEVENLABS_MODEL,
        default_voice: null,
        bots: {},
    });
    assert.equal(getElevenLabsModel(), DEFAULT_ELEVENLABS_MODEL);
    // Unpinned bots get a stable auto-assigned pool voice.
    assert.equal(resolveVoiceName('andy'), autoVoiceName('andy'));
    assert.equal(resolveVoice('andy'), VOICE_POOL[autoVoiceName('andy')]);
    assert.equal(resolveVoice('andy'), resolveVoice('andy'));
});

test('saveVoicesConfig writes and resolveVoice honors priority', () => {
    saveVoicesConfig({
        elevenlabs_model: 'eleven_turbo_v2_5',
        default_voice: 'Giggles',
        bots: { andy: 'grimblewood', custom_bot: 'RawVoiceId123', empty: '  ' },
    });

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.ok(written._readme);
    assert.equal(written.elevenlabs_model, 'eleven_turbo_v2_5');
    assert.equal(written.default_voice, 'Giggles');
    assert.deepEqual(written.bots, { andy: 'grimblewood', custom_bot: 'RawVoiceId123' });

    assert.equal(getElevenLabsModel(), 'eleven_turbo_v2_5');
    // Pinned beats default; pool names are case-insensitive.
    assert.equal(resolveVoiceName('andy'), 'Grimblewood');
    assert.equal(resolveVoice('andy'), VOICE_POOL.Grimblewood);
    // Non-pool values pass through as raw ElevenLabs voice IDs.
    assert.equal(resolveVoiceName('custom_bot'), 'RawVoiceId123');
    assert.equal(resolveVoice('custom_bot'), 'RawVoiceId123');
    // Unpinned bots use the default voice when one is set.
    assert.equal(resolveVoice('someone_else'), VOICE_POOL.Giggles);
    // An explicit speak_model voice beats everything.
    assert.equal(resolveVoiceName('andy', 'inferno'), 'Inferno');
    assert.equal(resolveVoice('andy', 'Inferno'), VOICE_POOL.Inferno);
});

test('clearing default_voice restores auto assignment', () => {
    saveVoicesConfig({ bots: { andy: 'Grimblewood' } });
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal('default_voice' in written, false);
    assert.equal(written.elevenlabs_model, DEFAULT_ELEVENLABS_MODEL);
    assert.equal(resolveVoice('someone_else'), VOICE_POOL[autoVoiceName('someone_else')]);
});
