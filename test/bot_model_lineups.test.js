import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BOT_MODEL_LINEUPS,
    CONTEST_BOT_CHARACTERS,
    CONTEST_BOT_PERSONAS,
    DEFAULT_BOT_MODEL_LINEUP_ID,
    SURVIVOR_SEASON_CAST,
    SURVIVOR_SEASON_PERSONAS,
    charactersForLineup,
    getBotModelLineup,
    listBotModelLineups,
    survivorVarietyProfileIds,
} from '../src/mindcraft/contest/game_presets.js';
import { getCursorProfiles } from '../src/mindcraft/model_profiles.js';

test('model packs keep the usual voices and prompts', () => {
    const opus = charactersForLineup('opus');
    assert.equal(opus.length, 5);
    assert.deepEqual(
        opus.map(({ name, voice }) => ({ name, voice })),
        CONTEST_BOT_PERSONAS.slice(0, 5).map(({ name, voice }) => ({ name, voice }))
    );
    assert.equal(opus[0].systemPrompt, CONTEST_BOT_PERSONAS[0].systemPrompt);
    assert.deepEqual(
        opus.map(character => character.profileId),
        [
            'claude-opus-5-fast',
            'claude-opus-5-balanced',
            'claude-opus-5-thorough',
            'claude-opus-5-deep',
            'claude-opus-5-max',
        ]
    );
});

test('lists every named model pack for the setup UI', () => {
    const packs = listBotModelLineups();
    assert.deepEqual(
        packs.map(pack => pack.id).sort(),
        ['chinese', 'fable', 'fast', 'max', 'openai', 'opus', 'thorough', 'usa', 'variety'].sort()
    );
    assert.equal(DEFAULT_BOT_MODEL_LINEUP_ID, 'variety');
    assert.equal(getBotModelLineup().id, 'variety');
    assert.ok(getBotModelLineup('variety').survivorProfileIds.length === 11);
});

test('every pack profile id resolves in the cursor catalog', () => {
    const profiles = new Set(getCursorProfiles().map(profile => profile.id));
    for (const lineup of Object.values(BOT_MODEL_LINEUPS)) {
        for (const profileId of lineup.profileIds) {
            assert.ok(
                profiles.has(profileId),
                `${lineup.id} references unknown profile ${profileId}`
            );
        }
    }
    for (const profileId of survivorVarietyProfileIds()) {
        assert.ok(profiles.has(profileId), `survivor variety unknown profile ${profileId}`);
    }
});

test('default variety cast still matches the contest characters export', () => {
    assert.deepEqual(
        charactersForLineup('variety', {
            personas: CONTEST_BOT_PERSONAS,
            count: CONTEST_BOT_PERSONAS.length,
        }),
        CONTEST_BOT_CHARACTERS.map(character => ({ ...character }))
    );
});

test('survivor variety personas skip Carl and keep eleven named seats', () => {
    assert.equal(SURVIVOR_SEASON_PERSONAS.length, 11);
    assert.ok(!SURVIVOR_SEASON_PERSONAS.some(persona => persona.name === 'Carl'));
    assert.deepEqual(
        SURVIVOR_SEASON_CAST.map(character => character.profileId),
        [...survivorVarietyProfileIds()]
    );
    assert.deepEqual(
        SURVIVOR_SEASON_CAST.map(character => character.name),
        SURVIVOR_SEASON_PERSONAS.map(persona => persona.name)
    );
});

test('short packs pad by cycling models when a larger cast is requested', () => {
    const padded = charactersForLineup('chinese', {
        personas: CONTEST_BOT_PERSONAS,
        count: 8,
    });
    assert.equal(padded.length, 8);
    assert.equal(padded[5].profileId, 'kimi-k3-fast');
    assert.equal(padded[5].name, 'bridget');
    assert.equal(padded[5].voice, 'Bridget');
});
