import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import {
    CURSOR_FAMILIES,
    REASONING_PRESETS,
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
            const profile = profiles.find(candidate =>
                candidate.profile.model.model === family.model &&
                candidate.profile.model.params[family.param] === preset.effort
            );

            assert.ok(profile, `missing ${family.id} ${presetId}`);
            assert.match(profile.model, new RegExp(`${preset.effort}$`));
        }
    }

    for (const profile of profiles) {
        assert.equal(profile.provider, 'cursor');
        assert.ok(
            CURSOR_FAMILIES.some(family =>
                family.id === profile.family && family.model === profile.profile.model.model
            ),
            `${profile.id} is not tagged with its model family`
        );
        assert.equal(profile.profile.model.api, 'cursor');
        assert.equal(profile.profile.name, profile.name);
        assert.ok(profile.name.length <= 16, `${profile.name} exceeds Minecraft's name limit`);
    }
});

test('offers every Cursor model family the bots can be run on', () => {
    const models = new Set(getCursorProfiles().map(profile => profile.profile.model.model));

    for (const model of [
        'composer-2.5',
        'kimi-k3',
        'glm-5.2',
        'claude-opus-5',
        'claude-fable-5',
        'grok-4.5',
        'gemini-3.1-pro',
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
        'grok-4-5-fast',
        'kimi-k3-fast',
        'gemini-3-1-pro',
        'composer-2-5',
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
            'grok-4-5-fast',
            'gpt-5-6-luna-instant',
            'claude-fable-5-fast',
            'gemini-3-1-pro',
            'kimi-k3-fast',
            'gpt-5-6-terra-instant',
            'glm-5-2-thorough',
            'gpt-5-6-sol-instant',
            'claude-opus-5-fast',
        ]
    );
});
