import assert from 'node:assert/strict';
import test from 'node:test';
import { SurvivorGame } from '../src/mindcraft/survivor/survivor_game.js';
import { buildSurvivorRelationships } from '../src/mindcraft/survivor/survivor_relationships.js';

const PLAYERS = Array.from({ length: 5 }, (_, index) => `Player${index + 1}`);

function edgeBetween(graph, left, right) {
    const edge = graph.edges.find(item =>
        (item.a === left && item.b === right) || (item.a === right && item.b === left)
    );
    assert.ok(edge, `expected an edge between ${left} and ${right}`);
    return edge;
}

function playCouncil(game, ballots) {
    game.startChallenge({ id: 'cake_race' });
    game.completeChallenge({ winnerId: PLAYERS[0] });
    game.openCouncil();
    game.beginVoting();
    for (const [voterId, targetId] of Object.entries(ballots)) {
        game.castVote(voterId, targetId);
    }
    return game.revealVotes();
}

test('emits a node per participant and no edges without any signal', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    const graph = buildSurvivorRelationships(game.snapshot(), []);
    assert.equal(graph.nodes.length, PLAYERS.length);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.nodes[0].active, true);
});

test('counts shared rooms and messages between every pair of members', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    const roomHistory = [{
        roomId: 'room-1',
        memberIds: [PLAYERS[0], PLAYERS[1], PLAYERS[2]],
        messageCount: 5,
        messageCountBySender: { [PLAYERS[0]]: 3, [PLAYERS[1]]: 2 },
    }];

    const graph = buildSurvivorRelationships(game.snapshot(), roomHistory);
    assert.equal(graph.edges.length, 3);
    const pair = edgeBetween(graph, PLAYERS[0], PLAYERS[1]);
    assert.equal(pair.roomsShared, 1);
    assert.equal(pair.messagesExchanged, 5);
    assert.ok(pair.bond > 0);
    assert.equal(pair.friction, 0);

    // A silent third member still shares the room, just with less to show for it.
    const quiet = edgeBetween(graph, PLAYERS[1], PLAYERS[2]);
    assert.equal(quiet.roomsShared, 1);
    assert.equal(quiet.messagesExchanged, 2);
});

test('records vote direction and voting blocs from revealed ballots', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    playCouncil(game, {
        [PLAYERS[1]]: PLAYERS[4],
        [PLAYERS[2]]: PLAYERS[4],
        [PLAYERS[3]]: PLAYERS[4],
        [PLAYERS[4]]: PLAYERS[1],
        [PLAYERS[0]]: PLAYERS[4],
    });

    const graph = buildSurvivorRelationships(game.snapshot(), []);
    const hostile = edgeBetween(graph, PLAYERS[1], PLAYERS[4]);
    const [fromOne, fromFour] = hostile.a === PLAYERS[1]
        ? [hostile.votesFromAToB, hostile.votesFromBToA]
        : [hostile.votesFromBToA, hostile.votesFromAToB];
    assert.equal(fromOne, 1);
    assert.equal(fromFour, 1);
    assert.ok(hostile.friction > 0);
    assert.ok(hostile.score < 0);

    // Four players wrote the same name down, so each pairing is a bloc of one vote.
    const bloc = edgeBetween(graph, PLAYERS[1], PLAYERS[2]);
    assert.equal(bloc.sharedVoteTargets, 1);
    assert.equal(bloc.votesFromAToB + bloc.votesFromBToA, 0);
    assert.ok(bloc.score > 0);
});

test('treats a jury vote as a positive bond toward the finalist', () => {
    const players = PLAYERS.slice(0, 4);
    const game = new SurvivorGame({ participantIds: players, mergeAt: 10 });
    for (const target of [players[1], players[2]]) {
        game.startChallenge({ id: 'cake_race' });
        game.completeChallenge({ winnerId: players[0] });
        game.openCouncil();
        game.beginVoting();
        const state = game.snapshot();
        for (const voterId of state.eligibleVoterIds) {
            const legalTarget = voterId === target
                ? state.eligibleTargetIds.find(id => id !== voterId)
                : target;
            game.castVote(voterId, legalTarget);
        }
        game.revealVotes();
    }
    game.beginJuryVote();
    game.castVote(players[1], players[0]);
    game.castVote(players[2], players[0]);
    const completed = game.revealVotes();
    assert.equal(completed.status, 'completed');

    const graph = buildSurvivorRelationships(completed, []);
    assert.equal(edgeBetween(graph, players[1], players[0]).juryVotesFor, 1);
    assert.equal(edgeBetween(graph, players[2], players[0]).juryVotesFor, 1);
});

test('sorts the strongest relationships first and ignores unknown players', () => {
    const game = new SurvivorGame({ participantIds: PLAYERS, mergeAt: 10 });
    const roomHistory = [
        { roomId: 'a', memberIds: [PLAYERS[0], PLAYERS[1]], messageCountBySender: {} },
        { roomId: 'b', memberIds: [PLAYERS[0], PLAYERS[1]], messageCountBySender: {} },
        { roomId: 'c', memberIds: [PLAYERS[2], PLAYERS[3]], messageCountBySender: {} },
        { roomId: 'd', memberIds: [PLAYERS[0], 'GhostBot'], messageCountBySender: {} },
    ];

    const graph = buildSurvivorRelationships(game.snapshot(), roomHistory);
    assert.equal(graph.edges.length, 2);
    assert.equal(graph.edges[0].roomsShared, 2);
    assert.ok(!graph.edges.some(edge => edge.a === 'GhostBot' || edge.b === 'GhostBot'));
});

test('tolerates a missing game', () => {
    assert.deepEqual(buildSurvivorRelationships(null), { nodes: [], edges: [] });
});
