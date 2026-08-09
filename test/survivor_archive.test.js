import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    SurvivorSeasonArchive,
    buildSeasons,
    parseJournal,
} from '../src/mindcraft/survivor/survivor_archive.js';
import { SurvivorCoordinator } from '../src/mindcraft/survivor/survivor_coordinator.js';

const PLAYERS = ['Ana', 'Bo', 'Cy', 'Di'];

function makeRoot() {
    return mkdtemp(path.join(os.tmpdir(), 'survivor-archive-'));
}

// A full four-player season: two councils, a jury vote, a winner.
async function playSeason(coordinator, { players = PLAYERS } = {}) {
    await coordinator.start({ participantIds: players, mergeAt: 10 });
    const seasonId = coordinator.view().id;

    await coordinator.apply('startChallenge', { id: 'cake_race' });
    await coordinator.apply('completeChallenge', { winnerId: players[0] });
    await coordinator.apply('openCouncil');
    await coordinator.apply('askCouncilQuestion', {
        id: 'q1',
        prompt: 'Who here has already lied to you?',
        targetIds: [players[1]],
    });
    await coordinator.apply('answerCouncilQuestion', players[1], 'Nobody, yet.');
    await coordinator.apply('beginReevaluation');
    await coordinator.apply('beginVoting');
    await coordinator.apply('castVote', players[0], players[3], 'He is the bigger threat.');
    await coordinator.apply('castVote', players[1], players[3]);
    await coordinator.apply('castVote', players[2], players[3]);
    await coordinator.apply('castVote', players[3], players[1]);
    await coordinator.apply('revealVotes');

    await coordinator.apply('startChallenge', { id: 'spleef' });
    await coordinator.apply('completeChallenge', { winnerId: players[0] });
    await coordinator.apply('openCouncil');
    await coordinator.apply('beginReevaluation');
    await coordinator.apply('beginVoting');
    await coordinator.apply('castVote', players[0], players[2]);
    await coordinator.apply('castVote', players[1], players[2]);
    await coordinator.apply('castVote', players[2], players[1]);
    await coordinator.apply('revealVotes');

    await coordinator.apply('beginJuryVote');
    await coordinator.apply('castVote', players[3], players[0], 'He ran the vote.');
    await coordinator.apply('castVote', players[2], players[0]);
    await coordinator.apply('revealVotes');
    return seasonId;
}

test('a finished season is readable from the journal alone', async () => {
    const root = await makeRoot();
    const coordinator = await SurvivorCoordinator.create({ root });
    const seasonId = await playSeason(coordinator);

    // Only the journal: no state.json, no archived snapshot.
    const entries = parseJournal(await readFile(path.join(root, 'journal.jsonl'), 'utf8'));
    const [season] = buildSeasons({ entries });

    assert.equal(season.id, seasonId);
    assert.equal(season.seasonNumber, 1);
    assert.equal(season.status, 'completed');
    assert.equal(season.winnerId, 'Ana');
    assert.deepEqual(season.participantIds.sort(), [...PLAYERS].sort());
    assert.deepEqual(season.finalistIds, ['Ana', 'Bo']);
    assert.equal(season.roundsPlayed, 2);
    assert.ok(season.durationMs >= 0);

    // Every ballot of the first council, with the reasoning that came with it.
    const [firstRound] = season.rounds;
    const [firstVote] = firstRound.votes;
    assert.deepEqual(firstVote.ballots, {
        Ana: 'Di',
        Bo: 'Di',
        Cy: 'Di',
        Di: 'Bo',
    });
    assert.deepEqual(firstVote.counts, { Di: 3, Bo: 1 });
    assert.equal(firstVote.reasons.Ana, 'He is the bigger threat.');
    assert.equal(firstRound.challenge.id, 'cake_race');
    assert.equal(firstRound.challenge.winnerId, 'Ana');
    assert.equal(firstRound.council.questions[0].answers[0].answer, 'Nobody, yet.');
    assert.deepEqual(
        firstRound.eliminations.map(boot => [boot.playerId, boot.placement]),
        [['Di', 4]]
    );

    // The jury vote is a vote like any other, and it decides the season.
    const juryVote = season.rounds[1].votes.find(vote => vote.kind === 'jury');
    assert.deepEqual(juryVote.counts, { Ana: 2 });
    assert.equal(season.finalVote.decidedBy, 'jury');

    assert.deepEqual(
        season.bootOrder.map(boot => boot.playerId),
        ['Di', 'Cy']
    );
    assert.deepEqual(
        season.players.map(player => [player.id, player.placement]),
        [['Ana', 1], ['Bo', 2], ['Cy', 3], ['Di', 4]]
    );
    const ana = season.players.find(player => player.id === 'Ana');
    assert.equal(ana.individualImmunityWins, 2);
    assert.equal(ana.juryVotesReceived, 2);
    assert.equal(ana.votesAgainst, 0);
    const di = season.players.find(player => player.id === 'Di');
    assert.equal(di.votesAgainst, 3);
    assert.equal(di.jury, true);
});

test('a finished season is filed under seasons/ so the next one cannot erase it', async () => {
    const root = await makeRoot();
    const coordinator = await SurvivorCoordinator.create({ root });
    const finishedId = await playSeason(coordinator);

    const archived = JSON.parse(
        await readFile(path.join(root, 'seasons', `${finishedId}.json`), 'utf8')
    );
    assert.equal(archived.id, finishedId);
    assert.equal(archived.status, 'completed');

    // The next season takes over state.json entirely.
    await coordinator.start({ participantIds: ['Eve', 'Fay', 'Gus', 'Hal'], mergeAt: 10 });
    const live = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8'));
    assert.notEqual(live.id, finishedId);

    const archive = new SurvivorSeasonArchive({ root });
    const seasons = await archive.list();
    assert.equal(seasons.length, 2);
    assert.deepEqual(seasons.map(season => season.seasonNumber), [2, 1]);
    assert.equal(seasons[1].winnerId, 'Ana');
    assert.equal(seasons[0].status, 'running');
    assert.deepEqual(seasons[0].participantIds, ['Eve', 'Fay', 'Gus', 'Hal']);
});

test('a cancelled season keeps its reason and its cast', async () => {
    const root = await makeRoot();
    const coordinator = await SurvivorCoordinator.create({ root });
    await coordinator.start({ participantIds: PLAYERS, mergeAt: 10 });
    await coordinator.apply('cancel', 'Bots never joined');

    const archive = new SurvivorSeasonArchive({ root });
    const [season] = await archive.list();
    assert.equal(season.status, 'cancelled');
    assert.equal(season.castSize, 4);
    assert.equal(season.winnerId, null);

    const detail = await archive.get(season.id);
    assert.equal(detail.endReason, 'Bots never joined');
    assert.equal(detail.roundsPlayed, 0);
    assert.equal((await readdir(path.join(root, 'seasons'))).length, 1);
});

test('private conversations are read back into per-season threads', async () => {
    const root = await makeRoot();
    const coordinator = await SurvivorCoordinator.create({ root });
    await coordinator.start({ participantIds: PLAYERS, mergeAt: 10 });
    await coordinator.recordPrivateEvent({
        type: 'room.created',
        roomId: 'room-1',
        ownerId: 'Ana',
        memberIds: ['Ana'],
        invitedIds: ['Bo'],
        pitch: 'Let us count the votes.',
    });
    await coordinator.recordPrivateEvent({
        type: 'room.joined',
        roomId: 'room-1',
        memberId: 'Bo',
        memberIds: ['Ana', 'Bo'],
    });
    await coordinator.recordPrivateEvent({
        type: 'room.message',
        roomId: 'room-1',
        senderId: 'Ana',
        memberIds: ['Ana', 'Bo'],
        message: 'Di goes home tonight.',
    });
    await coordinator.recordPrivateEvent({
        type: 'talk.declined',
        requestId: 'req-1',
        requesterId: 'Cy',
        inviteeId: 'Di',
        reason: 'not talking to you',
    });

    const archive = new SurvivorSeasonArchive({ root });
    const [summary] = await archive.list();
    assert.equal(summary.threadCount, 1);
    assert.equal(summary.messageCount, 1);

    const season = await archive.get(summary.id);
    const [thread] = season.conversations.threads;
    assert.deepEqual(thread.memberIds, ['Ana', 'Bo']);
    assert.equal(thread.pitch, 'Let us count the votes.');
    assert.equal(thread.messages[0].message, 'Di goes home tonight.');
    assert.deepEqual(season.conversations.refusals.map(item => item.inviteeId), ['Di']);

    const ana = season.players.find(player => player.id === 'Ana');
    assert.equal(ana.spokenCount, 1);
    assert.deepEqual(ana.partnerIds, ['Bo']);
    const bo = season.players.find(player => player.id === 'Bo');
    assert.equal(bo.heardCount, 1);
});

test('a season whose opening was never journaled still yields its cast and votes', () => {
    // What the journal looked like before season.started carried the cast: only
    // the season id, with everyone's name arriving through later events.
    const entries = [
        { at: 10, type: 'season.started', data: { seasonId: 'old' } },
        {
            at: 20,
            type: 'vote.revealed',
            data: {
                seasonId: 'old',
                round: 1,
                phase: 'voting',
                ballots: { Ana: 'Di', Bo: 'Di' },
                counts: { Di: 2 },
            },
        },
        {
            at: 30,
            type: 'player.eliminated',
            data: { seasonId: 'old', round: 1, playerId: 'Di', reason: 'vote', placement: 3 },
        },
    ];
    const [season] = buildSeasons({ entries });
    assert.deepEqual(season.participantIds, ['Ana', 'Bo', 'Di']);
    assert.equal(season.status, 'unfinished');
    assert.equal(season.roundsPlayed, 1);
    assert.deepEqual(season.bootOrder.map(boot => boot.playerId), ['Di']);
});

test('a torn journal line is skipped rather than losing the seasons around it', () => {
    const contents = [
        '{"at":1,"type":"season.started","data":{"seasonId":"a"}}',
        '{"at":2,"type":"season.completed","data":{"seasonId":"a","round":1,"winnerId":"An',
        '{"at":3,"type":"season.started","data":{"seasonId":"b"}}',
    ].join('\n');
    const entries = parseJournal(contents);
    assert.equal(entries.length, 2);
    assert.deepEqual(buildSeasons({ entries }).map(season => season.id), ['b', 'a']);
});

test('seasons are numbered oldest first and listed newest first', () => {
    const entries = [
        { at: 300, type: 'season.started', data: { seasonId: 'third' } },
        { at: 100, type: 'season.started', data: { seasonId: 'first' } },
        { at: 200, type: 'season.started', data: { seasonId: 'second' } },
    ];
    const seasons = buildSeasons({ entries });
    assert.deepEqual(
        seasons.map(season => [season.id, season.seasonNumber]),
        [['third', 3], ['second', 2], ['first', 1]]
    );
});
