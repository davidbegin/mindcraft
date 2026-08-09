import assert from 'node:assert/strict';
import test from 'node:test';
import { SurvivorGame } from '../src/mindcraft/survivor/survivor_game.js';
import {
    buildCouncilTranscript,
    buildPlayerBriefing,
    collectCouncilRecord,
} from '../src/mindcraft/survivor/survivor_memory.js';

const CAST = ['Alice', 'Billy', 'Cara', 'Dev'];

function playToCouncil() {
    const game = new SurvivorGame({
        participantIds: CAST,
        mergeAt: 4,
        finalistCount: 2,
        random: () => 0,
    });
    game.startChallenge({ id: 'cake_race' });
    game.completeChallenge({ winnerId: 'Alice' });
    game.openCouncil();
    return game;
}

test('the transcript keeps every public answer, attributed', () => {
    const game = playToCouncil();
    game.askCouncilQuestion({
        id: 'q1',
        prompt: 'Who is running this tribe?',
        targetIds: ['Billy', 'Cara'],
    });
    game.answerCouncilQuestion('Billy', 'Cara is, and she knows it.');
    game.answerCouncilQuestion('Cara', 'That is Billy deflecting.');

    const [council] = collectCouncilRecord(game.state);
    assert.equal(council.kind, 'tribal');
    assert.deepEqual(council.questions[0].answers.map(item => item.playerId), ['Billy', 'Cara']);

    const transcript = buildCouncilTranscript(game.state);
    assert.match(transcript, /TRIBAL COUNCIL, ROUND 1/);
    assert.match(transcript, /Billy said: "Cara is, and she knows it\."/);
    assert.match(transcript, /Cara said: "That is Billy deflecting\."/);
});

test('a briefing leads with how the jury decides the winner', () => {
    const game = playToCouncil();
    const briefing = buildPlayerBriefing(game.state, 'Billy');
    assert.equal(briefing, '', 'nothing has happened yet, so there is nothing to remember');

    game.askCouncilQuestion({ id: 'q1', prompt: 'Why you?', targetIds: ['Billy'] });
    game.answerCouncilQuestion('Billy', 'Because I am useful.');
    assert.match(
        buildPlayerBriefing(game.state, 'Cara'),
        /THE PUBLIC RECORD[\s\S]*Billy said: "Because I am useful\."/
    );
});

test('the council window is long enough to cover a whole short season', () => {
    // A four-player season is over in three councils. A window that only held
    // the last couple of them would drop the very grudges the finale turns on,
    // so the default has to span more councils than a short season contains.
    const game = playToCouncil();
    for (let round = 1; round <= 5; round++) {
        game.state.council = {
            id: `c${round}`,
            kind: 'tribal',
            attendeeIds: [...CAST],
            questions: [],
        };
        game.state.events.push(
            {
                type: 'council.opened',
                councilId: `c${round}`,
                kind: 'tribal',
                round,
                attendeeIds: [...CAST],
            },
            { type: 'council.question', councilId: `c${round}`, id: `q${round}`, prompt: `Question ${round}`, targetIds: ['Billy'] },
            { type: 'council.answer', councilId: `c${round}`, questionId: `q${round}`, playerId: 'Billy', answer: `Answer ${round}` }
        );
    }

    const transcript = buildCouncilTranscript(game.state);
    assert.match(transcript, /Answer 1/, 'the first council is still remembered');
    assert.match(transcript, /Answer 5/);

    // The window is a window, not unlimited: an explicitly short one still trims.
    const short = buildCouncilTranscript(game.state, { rounds: 2 });
    assert.doesNotMatch(short, /Answer 1/);
    assert.match(short, /Answer 5/);
});

test('a bot is never briefed on a private room it was not in', () => {
    const game = playToCouncil();
    const privateLog = [
        {
            type: 'room.message',
            roomId: 'room-1',
            senderId: 'Billy',
            memberIds: ['Billy', 'Cara'],
            message: 'we cut Dev tonight',
        },
        {
            type: 'room.message',
            roomId: 'room-2',
            senderId: 'Dev',
            memberIds: ['Dev', 'Alice'],
            message: 'Billy is the threat',
        },
    ];

    const cara = buildPlayerBriefing(game.state, 'Cara', { privateLog });
    assert.match(cara, /Billy told you privately: "we cut Dev tonight"/);
    assert.doesNotMatch(cara, /Billy is the threat/, 'Cara was not in room-2');

    const dev = buildPlayerBriefing(game.state, 'Dev', { privateLog });
    assert.match(dev, /you told \[Alice\]: "Billy is the threat"/);
    assert.doesNotMatch(dev, /we cut Dev tonight/, 'Dev must not learn he is the target');
});

test('refusals to talk are remembered by both sides and nobody else', () => {
    const game = playToCouncil();
    const privateLog = [{
        type: 'talk.declined',
        requestId: 'talk-1',
        requesterId: 'Billy',
        inviteeId: 'Cara',
        reason: 'I have nothing to say to you',
    }];

    assert.match(
        buildPlayerBriefing(game.state, 'Billy', { privateLog }),
        /Cara refused to talk to you \("I have nothing to say to you"\)/
    );
    assert.match(
        buildPlayerBriefing(game.state, 'Cara', { privateLog }),
        /you refused to talk to Billy/
    );
    assert.equal(buildPlayerBriefing(game.state, 'Dev', { privateLog }), '');
});

test('revealed votes become public memory, and grudges are named', () => {
    const game = playToCouncil();
    game.beginReevaluation();
    game.beginVoting();
    game.castVote('Billy', 'Dev');
    game.castVote('Cara', 'Dev');
    game.castVote('Dev', 'Billy');
    game.castVote('Alice', 'Dev');
    game.revealVotes();

    const billy = buildPlayerBriefing(game.state, 'Billy');
    assert.match(billy, /VOTES AGAINST YOU: round 1 — Dev/);
    assert.match(billy, /YOUR PAST VOTES: round 1 — Dev/);
    assert.match(
        billy,
        /THE JURY \(1\): Dev\..*You voted for Dev/s,
        'Billy is told he cut the juror who now judges him'
    );

    const alice = buildPlayerBriefing(game.state, 'Alice');
    assert.doesNotMatch(alice, /VOTES AGAINST YOU/, 'nobody voted for Alice');
});

test('a juror is told to judge rather than play', () => {
    const game = playToCouncil();
    game.beginReevaluation();
    game.beginVoting();
    for (const voter of ['Alice', 'Billy', 'Cara']) game.castVote(voter, 'Dev');
    game.castVote('Dev', 'Billy');
    game.revealVotes();

    assert.match(buildPlayerBriefing(game.state, 'Dev'), /You are on the jury/);
});
