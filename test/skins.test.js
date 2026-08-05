import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
    renderSkin, modelInfo, hashName, detectProvider, logoBitmap, LOGOS_DIR,
} from '../src/mindcraft/skins.js';

test('modelInfo maps model families to words, colors, and teams', () => {
    assert.equal(modelInfo('gpt-5.4-mini').word, 'MINI');
    assert.equal(modelInfo('gpt-5.4-mini').mcColor, 'aqua');
    assert.equal(modelInfo({ api: 'cursor', model: 'gpt-5.6-sol' }).word, 'SOL');
    assert.equal(modelInfo('gpt-5.6-terra').teamId, 'model_terra');
    assert.equal(modelInfo('gpt-5.6-luna').mcColor, 'light_purple');
    assert.equal(modelInfo('gpt-5.6-sol').provider, 'openai');
    // Unknown models still get a usable word and team.
    const other = modelInfo('claude-4');
    assert.equal(other.word, 'CLAU');
    assert.equal(other.mcColor, 'white');
});

test('detectProvider identifies the model maker, not the serving API', () => {
    const cases = [
        ['gpt-5.4-mini', 'openai'],
        [{ api: 'cursor', model: 'gpt-5.6-sol' }, 'openai'],
        ['o3-mini', 'openai'],
        ['claude-4-sonnet', 'anthropic'],
        ['gemini-2.5-pro', 'gemini'],
        ['gemma-3-27b', 'gemini'],
        ['mistral-large', 'mistral'],
        ['mixtral-8x7b', 'mistral'],
        [{ api: 'groq', model: 'llama-3.3-70b' }, 'meta'],
        ['deepseek-r2', 'deepseek'],
        ['qwen-2.5-coder', 'qwen'],
        ['grok-4', 'xai'],
        [{ api: 'huggingface', model: 'some-community-model' }, 'huggingface'],
        ['composer-2.5-fast', 'cursor'],
        ['totally-unknown-model', null],
    ];
    for (const [model, expected] of cases) {
        assert.equal(detectProvider(model), expected, `detectProvider(${JSON.stringify(model)})`);
    }
});

const CORE_PROVIDERS = [
    'openai', 'anthropic', 'gemini', 'mistral', 'meta', 'deepseek', 'qwen',
    'xai', 'groq', 'huggingface', 'cerebras', 'replicate', 'ollama', 'cursor',
];

test('official logo assets exist and are tracked in the manifest', () => {
    const manifestPath = path.join(LOGOS_DIR, 'manifest.json');
    assert.ok(existsSync(manifestPath), 'assets/model-logos/manifest.json is missing');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const provider of CORE_PROVIDERS) {
        assert.ok(existsSync(path.join(LOGOS_DIR, `${provider}.png`)), `${provider}.png is missing`);
        assert.ok(manifest[provider]?.source, `${provider} has no source recorded in manifest`);
    }
});

test('logoBitmap rasterizes every official logo into a usable 8x8 glyph', () => {
    for (const provider of CORE_PROVIDERS) {
        const bitmap = logoBitmap(provider);
        assert.equal(bitmap.length, 8, `${provider} bitmap height`);
        for (const row of bitmap) {
            assert.equal(row.length, 8, `${provider} bitmap width`);
            assert.match(row, /^[#.]+$/, `${provider} bitmap characters`);
        }
        const set = bitmap.join('').split('#').length - 1;
        assert.ok(set >= 4 && set <= 60, `${provider} glyph density out of range (${set}/64)`);
        // Real assets must not silently fall back to the generic diamond.
        assert.notDeepEqual(bitmap, logoBitmap('no-such-provider'),
            `${provider} fell back to the generic glyph`);
        // Deterministic across calls (cached or not).
        assert.deepEqual(bitmap, logoBitmap(provider), `${provider} bitmap not deterministic`);
    }
});

test('logoBitmap falls back gracefully for unknown providers', () => {
    const fallback = logoBitmap('no-such-provider');
    assert.equal(fallback.length, 8);
    const nullProvider = logoBitmap(null);
    assert.equal(nullProvider.length, 8);
});

test('skins differ when the model provider differs', () => {
    const openai = renderSkin('samebot', 'gpt-5.4-mini');
    const anthropic = renderSkin('samebot', 'claude-4-sonnet');
    assert.notDeepEqual(openai.toBuffer('image/png'), anthropic.toBuffer('image/png'));
});

test('renderSkin produces a 64x64 canvas, deterministic per name', () => {
    const a1 = renderSkin('explorer', 'gpt-5.4-mini');
    assert.equal(a1.width, 64);
    assert.equal(a1.height, 64);
    const a2 = renderSkin('explorer', 'gpt-5.4-mini');
    assert.deepEqual(a1.toBuffer('image/png'), a2.toBuffer('image/png'));
    // Different bots on the same model still get distinct skins.
    const b = renderSkin('miner', 'gpt-5.4-mini');
    assert.notDeepEqual(a1.toBuffer('image/png'), b.toBuffer('image/png'));
});

test('hashName is stable and unsigned', () => {
    assert.equal(hashName('explorer'), hashName('explorer'));
    assert.ok(hashName('explorer') >= 0);
    assert.notEqual(hashName('explorer'), hashName('miner'));
});
