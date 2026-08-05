import assert from 'node:assert/strict';
import test from 'node:test';

import { DYING_PHRASES, getDyingPhrase } from '../src/agent/dying_phrases.js';

test('dying phrase pool has a large set of unique messages', () => {
    assert.ok(DYING_PHRASES.length >= 100);
    assert.equal(new Set(DYING_PHRASES).size, DYING_PHRASES.length);
    assert.ok(DYING_PHRASES.every(phrase => typeof phrase === 'string' && phrase.length > 0));
});

test('each bot uses every dying phrase before repeating one', () => {
    const bot = {};
    const firstCycle = Array.from(
        { length: DYING_PHRASES.length },
        () => getDyingPhrase(bot, () => 0)
    );

    assert.equal(new Set(firstCycle).size, DYING_PHRASES.length);
    assert.equal(getDyingPhrase(bot, () => 0), DYING_PHRASES[0]);
});

test('bots maintain independent phrase pools', () => {
    const firstBot = {};
    const secondBot = {};

    assert.equal(getDyingPhrase(firstBot, () => 0), DYING_PHRASES[0]);
    assert.equal(getDyingPhrase(firstBot, () => 0), DYING_PHRASES[1]);
    assert.equal(getDyingPhrase(secondBot, () => 0), DYING_PHRASES[0]);
});
