import assert from 'node:assert/strict';
import test from 'node:test';
import { SurvivorGame } from '../src/mindcraft/survivor/survivor_game.js';
import { buildSurvivorStandings } from '../src/mindcraft/survivor/survivor_standings.js';

const PLAYERS = Array.from({ length: 6 }, (_, index) => `Player${index + 1}`);

function rowFor(standings, id) {
    const row = standings.find(entry => entry.id === id);
    assert.ok(row, `expected standings row for ${id}`);
    return row;
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

function playIndividualRound(game, immuneId, targetId) {
    game.startChallenge({ id: 'cake_race' });
    game.completeChallenge({ winnerId: immuneId });
    game.openCouncil();
    game.beginVoting();
    return castPlurality(game, targetId);
}

test('returns a row per participant before anything has happened', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    const standings = buildSurvivorStandings(game.snapshot());
    assert.equal(standings.length, PLAYERS.length);
    for (const row of standings) {
        assert.equal(row.status, 'active');
        assert.equal(row.immunityWins, 0);
        assert.equal(row.votesReceived, 0);
        assert.equal(row.votesCast, 0);
        assert.equal(row.placement, null);
    }
});

test('counts individual immunity wins and votes from the event log', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    playIndividualRound(game, PLAYERS[0], PLAYERS[5]);
    playIndividualRound(game, PLAYERS[0], PLAYERS[4]);

    const standings = buildSurvivorStandings(game.snapshot());
    const winner = rowFor(standings, PLAYERS[0]);
    assert.equal(winner.individualImmunityWins, 2);
    assert.equal(winner.immunityWins, 2);
    assert.equal(winner.votesReceived, 0);
    assert.equal(winner.votesCast, 2);
    assert.equal(winner.councilsAttended, 2);

    const firstBoot = rowFor(standings, PLAYERS[5]);
    assert.equal(firstBoot.status, 'jury');
    assert.equal(firstBoot.votesReceived, 5);
    assert.equal(firstBoot.eliminationReason, 'vote');
    assert.equal(firstBoot.eliminatedRound, 1);
});

test('credits every member of a winning tribe with a pre-merge immunity win', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 4 });
    game.startChallenge({ id: 'cake_race' });
    const state = game.completeChallenge({ winningTribe: 'Ember' });

    const standings = buildSurvivorStandings(state);
    for (const id of state.tribes.Ember) {
        const row = rowFor(standings, id);
        assert.equal(row.tribeImmunityWins, 1);
        assert.equal(row.individualImmunityWins, 0);
        assert.equal(row.hasImmunity, true);
    }
    for (const id of state.tribes.Tide) {
        assert.equal(rowFor(standings, id).tribeImmunityWins, 0);
    }
});

test('a revote adds votes without double-counting the council', () => {
    const players = PLAYERS.slice(0, 4);
    const game = new SurvivorGame({ participantIds: players, mergeAt: 10 });
    game.startChallenge({ id: 'cake_race' });
    game.completeChallenge({ winnerId: players[0] });
    game.openCouncil();
    game.beginVoting();
    game.castVote(players[0], players[1]);
    game.castVote(players[1], players[2]);
    game.castVote(players[2], players[1]);
    game.castVote(players[3], players[2]);
    const tied = game.revealVotes();
    assert.equal(tied.phase, 'revote');

    game.castVote(players[0], players[1]);
    game.castVote(players[3], players[1]);
    game.revealVotes();

    const standings = buildSurvivorStandings(game.snapshot());
    assert.equal(rowFor(standings, players[1]).votesReceived, 4);
    assert.equal(rowFor(standings, players[0]).votesCast, 2);
    assert.equal(rowFor(standings, players[0]).councilsAttended, 1);
});

test('ranks a completed season by placement with the winner first', () => {
    const players = PLAYERS.slice(0, 4);
    const game = new SurvivorGame({ participantIds: players, mergeAt: 10 });
    playIndividualRound(game, players[0], players[1]);
    playIndividualRound(game, players[0], players[2]);
    game.beginJuryVote();
    game.castVote(players[1], players[0]);
    game.castVote(players[2], players[0]);
    const completed = game.revealVotes();
    assert.equal(completed.status, 'completed');

    const standings = buildSurvivorStandings(completed);
    assert.deepEqual(
        standings.map(row => row.id),
        [players[0], players[3], players[2], players[1]]
    );
    assert.equal(standings[0].status, 'winner');
    assert.equal(standings[0].juryVotesReceived, 2);
    assert.equal(standings[1].status, 'runner_up');
    assert.equal(standings[2].status, 'jury');
});

test('tolerates a missing or empty game', () => {
    assert.deepEqual(buildSurvivorStandings(null), []);
    assert.deepEqual(buildSurvivorStandings({}), []);
});
