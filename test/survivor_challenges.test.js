import assert from 'node:assert/strict';
import test from 'node:test';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';
import {
    buildChallengeDeck,
    resolveIndividualChallenge,
    resolveTeamChallenge,
} from '../src/mindcraft/survivor/survivor_challenges.js';

const tribes = {
    Alice: 'Ember',
    Billy: 'Tide',
    Dario: 'Ember',
    Marcus: 'Tide',
};

test('first-finish team challenge uses the fastest member', () => {
    const result = resolveTeamChallenge(getContestGamePreset('cake_race'), [
        { participantId: 'Alice', elapsedMs: 4000 },
        { participantId: 'Billy', elapsedMs: 3000 },
        { participantId: 'Dario', elapsedMs: 2000 },
        { participantId: 'Marcus', elapsedMs: 5000 },
    ], tribes);
    assert.equal(result.winningTribe, 'Ember');
    assert.equal(result.tied, false);
});

test('depth challenge uses lowest team average', () => {
    const result = resolveTeamChallenge(getContestGamePreset('deepest_5'), [
        { participantId: 'Alice', y: -20 },
        { participantId: 'Billy', y: -30 },
        { participantId: 'Dario', y: -40 },
        { participantId: 'Marcus', y: -10 },
    ], tribes);
    assert.equal(result.winningTribe, 'Ember');
});

test('tower challenge sums member heights', () => {
    const result = resolveTeamChallenge(getContestGamePreset('tower_battle'), [
        { participantId: 'Alice', height: 10 },
        { participantId: 'Billy', height: 18 },
        { participantId: 'Dario', height: 12 },
        { participantId: 'Marcus', height: 2 },
    ], tribes);
    assert.equal(result.winningTribe, 'Ember');
});

test('team challenge reports a tie instead of silently choosing a tribe', () => {
    const result = resolveTeamChallenge(getContestGamePreset('tower_battle'), [
        { participantId: 'Alice', height: 10 },
        { participantId: 'Billy', height: 10 },
        { participantId: 'Dario', height: 10 },
        { participantId: 'Marcus', height: 10 },
    ], tribes);
    assert.equal(result.tied, true);
    assert.equal(result.standings[0].score, result.standings[1].score);
});

test('post-merge challenge preserves individual game semantics', () => {
    assert.equal(resolveIndividualChallenge(getContestGamePreset('deepest_2_5'), [
        { participantId: 'Alice', y: -10 },
        { participantId: 'Billy', y: -20 },
    ]).winnerId, 'Billy');
    assert.equal(resolveIndividualChallenge(getContestGamePreset('tower_battle'), [
        { participantId: 'Alice', height: 10 },
        { participantId: 'Billy', height: 20 },
    ]).winnerId, 'Billy');
});

test('challenge deck does not repeat until every game is used', () => {
    const deck = buildChallengeDeck(['a', 'b', 'c'], {
        rounds: 6,
        random: () => 0,
    });
    assert.deepEqual(deck, ['a', 'b', 'c', 'a', 'b', 'c']);
});
