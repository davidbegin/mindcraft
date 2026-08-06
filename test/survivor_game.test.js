import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    createSurvivorState,
    SurvivorGame,
} from '../src/mindcraft/survivor/survivor_game.js';
import { SurvivorCoordinator } from '../src/mindcraft/survivor/survivor_coordinator.js';

const PLAYERS = Array.from({ length: 12 }, (_, index) => `Player${index + 1}`);

function beginPreMergeVote(game, winningTribe = 'Ember') {
    game.startChallenge({ id: 'cake_race' });
    game.completeChallenge({ winningTribe });
    game.beginVoting();
    return game.snapshot();
}

function castPlurality(game, targetId) {
    const state = game.snapshot();
    for (const voterId of state.eligibleVoterIds) {
        const legalTarget = voterId === targetId
            ? state.eligibleTargetIds.find(id => id !== voterId)
            : targetId;
        game.castVote(voterId, legalTarget);
    }
    return game.revealVotes();
}

test('creates two balanced tribes and requires a roster larger than merge threshold', () => {
    const state = createSurvivorState({ participantIds: PLAYERS, mergeAt: 10 });
    assert.equal(state.tribes.Ember.length, 6);
    assert.equal(state.tribes.Tide.length, 6);
    assert.throws(
        () => createSurvivorState({ participantIds: PLAYERS.slice(0, 10), mergeAt: 10 }),
        /more than 10/
    );
});

test('losing tribe votes, winning tribe is safe, and the merge boot is not a juror', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    let state = beginPreMergeVote(game, 'Ember');
    assert.deepEqual(state.eligibleVoterIds, PLAYERS.filter((_, index) => index % 2 === 1));
    castPlurality(game, 'Player2');

    state = beginPreMergeVote(game, 'Tide');
    castPlurality(game, 'Player1');
    state = game.snapshot();
    assert.equal(state.merged, true);
    assert.deepEqual(state.preMergeBootIds, ['Player2', 'Player1']);
    assert.deepEqual(state.juryIds, []);
});

test('post-merge challenge winner is immune and boot joins jury', () => {
    const state = createSurvivorState({ participantIds: PLAYERS, mergeAt: 10 });
    state.players.Player1.active = false;
    state.players.Player2.active = false;
    state.preMergeBootIds = ['Player1', 'Player2'];
    state.bootOrder = ['Player1', 'Player2'];
    state.merged = true;
    state.round = 3;
    const game = new SurvivorGame({ state });

    game.startChallenge({ id: 'tower_battle' });
    game.completeChallenge({ winnerId: 'Player3' });
    game.beginVoting();
    assert.ok(!game.snapshot().eligibleTargetIds.includes('Player3'));
    castPlurality(game, 'Player4');
    assert.deepEqual(game.snapshot().juryIds, ['Player4']);
});

test('a one-member losing tribe is eliminated without softlocking Tribal Council', () => {
    const players = Array.from({ length: 20 }, (_, index) => `Cast${index + 1}`);
    const state = createSurvivorState({ participantIds: players, mergeAt: 10 });
    for (const id of state.tribes.Ember.slice(1)) state.players[id].active = false;
    const game = new SurvivorGame({ state });
    game.startChallenge({ id: 'cake_race' });
    const resolved = game.completeChallenge({ winningTribe: 'Tide' });
    assert.equal(resolved.merged, true);
    assert.equal(resolved.phase, 'challenge');
    assert.equal(resolved.bootOrder.at(-1), state.tribes.Ember[0]);
});

test('tie triggers a revote where tied players cannot vote', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    const state = beginPreMergeVote(game);
    const [a, b] = state.eligibleTargetIds;
    state.eligibleVoterIds.forEach((voterId, index) => {
        const target = index % 2 === 0 ? a : b;
        game.castVote(voterId, voterId === target ? (target === a ? b : a) : target);
    });
    const revote = game.revealVotes();
    assert.equal(revote.phase, 'revote');
    assert.deepEqual(revote.tiedIds, [a, b].sort());
    assert.ok(!revote.eligibleVoterIds.includes(a));
    assert.ok(!revote.eligibleVoterIds.includes(b));
});

test('deadlocked revote reaches unanimous decision or rocks', () => {
    const base = createSurvivorState({ participantIds: PLAYERS, mergeAt: 10 });
    base.phase = 'deadlock';
    base.tiedIds = ['Player2', 'Player4'];
    base.eligibleTargetIds = [...base.tiedIds];
    base.eligibleVoterIds = ['Player6', 'Player8'];
    base.councilVoterIds = ['Player2', 'Player4', 'Player6', 'Player8'];

    const unanimous = new SurvivorGame({ state: base, random: () => 0 });
    unanimous.submitDeadlockDecision('Player6', 'Player2');
    unanimous.submitDeadlockDecision('Player8', 'Player2');
    assert.equal(unanimous.resolveDeadlock().bootOrder.at(-1), 'Player2');

    const rocks = new SurvivorGame({ state: base, random: () => 0 });
    rocks.submitDeadlockDecision('Player6', 'Player2');
    rocks.submitDeadlockDecision('Player8', 'Player4');
    const resolved = rocks.resolveDeadlock();
    assert.equal(resolved.bootOrder.at(-1), 'Player6');
    assert.equal(resolved.events.at(-2).type, 'rocks.drawn');
});

test('final four deadlock uses fire-making', () => {
    const state = createSurvivorState({ participantIds: PLAYERS, mergeAt: 10 });
    for (const id of PLAYERS.slice(0, 8)) state.players[id].active = false;
    state.merged = true;
    state.phase = 'deadlock';
    state.tiedIds = ['Player9', 'Player10'];
    state.eligibleTargetIds = [...state.tiedIds];
    state.eligibleVoterIds = ['Player11', 'Player12'];
    state.councilVoterIds = ['Player9', 'Player10', 'Player11', 'Player12'];
    const game = new SurvivorGame({ state });
    game.submitDeadlockDecision('Player11', 'Player9');
    game.submitDeadlockDecision('Player12', 'Player10');
    assert.equal(game.resolveDeadlock().phase, 'fire_making');
    const resolved = game.resolveFireMaking('Player9');
    assert.equal(resolved.phase, 'jury_questioning');
    assert.ok(resolved.juryIds.includes('Player10'));
});

test('a full multi-way tie uses a deterministic tiebreak instead of invalid fire-making', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10, random: () => 0 });
    const state = beginPreMergeVote(game);
    state.eligibleVoterIds.forEach((voterId, index) => {
        const targetId = state.eligibleTargetIds[(index + 1) % state.eligibleTargetIds.length];
        game.castVote(voterId, targetId === voterId
            ? state.eligibleTargetIds[(index + 2) % state.eligibleTargetIds.length]
            : targetId);
    });
    const resolved = game.revealVotes();
    assert.equal(resolved.phase, 'challenge');
    assert.equal(resolved.events.at(-2).type, 'vote.no_voter_tiebreak');
});

test('jury selects a winner and third finalist breaks a two-way tie', () => {
    const state = createSurvivorState({ participantIds: PLAYERS, mergeAt: 10 });
    const finalists = ['Player10', 'Player11', 'Player12'];
    for (const id of PLAYERS.slice(0, 9)) {
        state.players[id].active = false;
        state.players[id].jury = true;
    }
    state.merged = true;
    state.juryIds = PLAYERS.slice(0, 4);
    state.finalistIds = finalists;
    state.phase = 'jury_questioning';
    const game = new SurvivorGame({ state });
    game.beginJuryVote();
    game.castVote('Player1', 'Player10');
    game.castVote('Player2', 'Player10');
    game.castVote('Player3', 'Player11');
    game.castVote('Player4', 'Player11');
    const tiebreak = game.revealVotes();
    assert.equal(tiebreak.phase, 'finalist_tiebreak');
    assert.deepEqual(tiebreak.eligibleVoterIds, ['Player12']);
    game.castVote('Player12', 'Player11');
    const completed = game.revealVotes();
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.winnerIds, ['Player11']);
});

test('coordinator persists state and journals public events without ballot targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'survivor-'));
    const coordinator = await SurvivorCoordinator.create({ root, random: () => 0 });
    await coordinator.start({ participantIds: PLAYERS, mergeAt: 10, id: 'season-1' });
    await coordinator.apply('startChallenge', { id: 'cake_race' });
    await coordinator.apply('completeChallenge', { winningTribe: 'Ember' });
    await coordinator.apply('beginVoting');
    await coordinator.apply('castVote', 'Player2', 'Player4');

    const loaded = await SurvivorCoordinator.load({ root, random: () => 0 });
    assert.equal(loaded.view().ballots.Player2, 'Player4');
    const journal = await readFile(path.join(root, 'journal.jsonl'), 'utf8');
    const ballotEvent = journal.split('\n').find(line => line.includes('ballot.cast'));
    assert.ok(ballotEvent);
    assert.ok(!ballotEvent.includes('Player4'));
});
