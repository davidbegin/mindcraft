import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import {
    CURSOR_FAMILIES,
    REASONING_PRESETS,
    effortValue,
    getCursorProfiles,
} from '../src/mindcraft/model_profiles.js';

test('generates every family and supported effort combination', () => {
    const profiles = getCursorProfiles();

    const expected = CURSOR_FAMILIES.reduce(
        (total, family) => total + Math.max(family.presets.length, 1),
        0
    );
    assert.equal(profiles.length, expected);
    assert.equal(new Set(profiles.map(profile => profile.id)).size, profiles.length);
    assert.equal(new Set(profiles.map(profile => profile.name)).size, profiles.length);

    for (const family of CURSOR_FAMILIES) {
        for (const presetId of family.presets) {
            const preset = REASONING_PRESETS.find(candidate => candidate.id === presetId);
            const effort = effortValue(family, preset);
            const profile = profiles.find(candidate =>
                candidate.profile.model.model === family.model &&
                candidate.profile.model.params[family.param] === effort
            );

            assert.ok(profile, `missing ${family.id} ${presetId}`);
            assert.match(profile.model, new RegExp(`${preset.effort}$`));
        }
    }

    for (const profile of profiles) {
        const family = CURSOR_FAMILIES.find(candidate =>
            familyMatch(candidate, profile)
        );
        assert.ok(family, `${profile.id} is not tagged with its model family`);
        assert.equal(profile.provider, family.provider || 'cursor');
        assert.equal(profile.profile.model.api, family.api || 'cursor');
        assert.equal(profile.profile.name, profile.name);
        assert.ok(profile.name.length <= 16, `${profile.name} exceeds Minecraft's name limit`);
    }
});

function familyMatch(family, profile) {
    return family.id === profile.family && family.model === profile.profile.model.model;
}

test('offers every model family the bots can be run on', () => {
    const models = new Set(getCursorProfiles().map(profile => profile.profile.model.model));

    for (const model of [
        'composer-2.5',
        'kimi-k3',
        'glm-5.2',
        'claude-opus-5',
        'claude-fable-5',
        'claude-sonnet-5',
        'grok-4.5',
        'gemini-3.6-flash',
        'gemini-3.1-pro',
        'gpt-5.5',
        'meta/muse-spark-1.2',
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'qwen/qwen3.8-max',
        'mistralai/mistral-large-2512',
        'meta-llama/llama-4-maverick',
        'gpt-5.6-terra',
    ]) {
        assert.ok(models.has(model), `${model} is not offered as a profile`);
    }
});

test('keeps the profile ids that contest presets and saved colonies reference', () => {
    const ids = new Set(getCursorProfiles().map(profile => profile.id));

    for (const id of [
        'gpt-5-6-terra-balanced',
        'gpt-5-6-terra-thorough',
        'gpt-5-6-terra-fast',
        'gpt-5-6-sol-instant',
        'gpt-5-6-luna-instant',
        'claude-fable-5-fast',
        'claude-sonnet-5-fast',
        'grok-4-5-fast',
        'kimi-k3-fast',
        'gemini-3-6-flash',
        'meta-muse-spark-1-2',
        'composer-2-5',
        'deepseek-deepseek-v4-flash',
        'qwen-qwen3-8-max',
    ]) {
        assert.ok(ids.has(id), `${id} no longer resolves to a profile`);
    }
});

test('sends no effort parameter for models that expose no effort dial', () => {
    const composer = getCursorProfiles().find(profile => profile.id === 'composer-2-5');

    assert.equal(composer.name, 'composer');
    assert.equal(composer.model, 'composer-2.5');
    assert.deepEqual(composer.profile.model, { api: 'cursor', model: 'composer-2.5' });
});

test('bot names stay distinct from the hand-written profiles', () => {
    const profilesDir = new URL('../profiles/', import.meta.url);
    const fileNames = readdirSync(profilesDir)
        .filter(file => file.endsWith('.json'))
        .map(file => JSON.parse(readFileSync(new URL(file, profilesDir), 'utf8')).name);

    for (const profile of getCursorProfiles()) {
        assert.ok(
            !fileNames.includes(profile.name),
            `${profile.name} collides with the profiles/ bot of the same name`
        );
    }
});

test('returns fresh profiles that callers can safely customize', () => {
    const terra = getCursorProfiles().find(profile => profile.id === 'gpt-5-6-terra-instant');
    terra.profile.name = 'changed';
    terra.profile.model.params.reasoning = 'changed';

    const again = getCursorProfiles().find(profile => profile.id === 'gpt-5-6-terra-instant');
    assert.equal(again.profile.name, 'terra_instant');
    assert.equal(again.profile.model.params.reasoning, 'none');
});

test('offers the cheap, quick model families before the expensive ones', () => {
    const fastest = [];
    for (const profile of getCursorProfiles()) {
        if (!fastest.some(candidate => candidate.family === profile.family)) {
            fastest.push(profile);
        }
    }

    assert.deepEqual(
        fastest.map(profile => profile.id),
        [
            'composer-2-5',
            'deepseek-deepseek-v4-flash',
            'grok-4-5-fast',
            'gpt-5-6-luna-instant',
            'claude-fable-5-fast',
            'gemini-3-6-flash',
            'claude-sonnet-5-fast',
            'kimi-k3-fast',
            'gpt-5-6-terra-instant',
            'meta-muse-spark-1-2',
            'meta-llama-llama-4-maverick',
            'qwen-qwen3-8-max',
            'mistralai-mistral-large-2512',
            'deepseek-deepseek-v4-pro',
            'gpt-5-5-instant',
            'gemini-3-1-pro',
            'glm-5-2-thorough',
            'gpt-5-6-sol-instant',
            'claude-opus-5-fast',
        ]
    );
});

test('routes Muse Spark and other non-Cursor models through OpenRouter', () => {
    const openrouter = getCursorProfiles().filter(profile => profile.provider === 'openrouter');

    assert.deepEqual(
        openrouter.map(profile => profile.id).sort(),
        [
            'deepseek-deepseek-v4-flash',
            'deepseek-deepseek-v4-pro',
            'meta-llama-llama-4-maverick',
            'meta-muse-spark-1-2',
            'mistralai-mistral-large-2512',
            'qwen-qwen3-8-max',
        ]
    );

    const muse = openrouter.find(profile => profile.id === 'meta-muse-spark-1-2');
    assert.deepEqual(muse.profile.model, {
        api: 'openrouter',
        model: 'meta/muse-spark-1.2',
    });
});

test('maps GPT-5.5 deep effort to extra-high', () => {
    const profile = getCursorProfiles().find(candidate => candidate.id === 'gpt-5-5-deep');
    assert.equal(profile.profile.model.params.reasoning, 'extra-high');
});
