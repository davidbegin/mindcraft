import assert from 'node:assert/strict';
import test from 'node:test';

import {
    isJournalableContestStatus,
    resolveContestMessageTarget,
} from '../src/mindcraft/contest/contest_messages.js';

test('journalable statuses cover draft through judging', () => {
    assert.equal(isJournalableContestStatus('draft'), true);
    assert.equal(isJournalableContestStatus('running'), true);
    assert.equal(isJournalableContestStatus('judging'), true);
    assert.equal(isJournalableContestStatus('completed'), false);
    assert.equal(isJournalableContestStatus('cancelled'), false);
});

test('draft planning chatter journals against the game-session contest', () => {
    const target = resolveContestMessageTarget({
        agentName: 'Billy',
        activeContestId: null,
        contests: {
            'game-1': {
                status: 'draft',
                participantIds: ['Billy', 'Kimmy'],
            },
        },
        gameSession: {
            contestId: 'game-1',
            participantIds: ['Billy', 'Kimmy'],
        },
    });
    assert.deepEqual(target, {
        contestId: 'game-1',
        participantId: 'Billy',
        status: 'draft',
    });
});

test('active contest wins over a stale session id when both are present', () => {
    const target = resolveContestMessageTarget({
        agentName: 'Billy',
        activeContestId: 'game-2',
        contests: {
            'game-1': { status: 'completed', participantIds: ['Billy'] },
            'game-2': { status: 'running', participantIds: ['Billy', 'Kimmy'] },
        },
        gameSession: {
            contestId: 'game-2',
            participantIds: ['Billy', 'Kimmy'],
        },
    });
    assert.equal(target.contestId, 'game-2');
    assert.equal(target.status, 'running');
});

test('non-participants and finished contests are not journaled', () => {
    assert.equal(resolveContestMessageTarget({
        agentName: 'Outsider',
        activeContestId: 'game-1',
        contests: {
            'game-1': { status: 'running', participantIds: ['Billy'] },
        },
        gameSession: { contestId: 'game-1', participantIds: ['Billy'] },
    }), null);

    assert.equal(resolveContestMessageTarget({
        agentName: 'Billy',
        activeContestId: null,
        contests: {
            'game-1': { status: 'completed', participantIds: ['Billy'] },
        },
        gameSession: { contestId: 'game-1', participantIds: ['Billy'] },
    }), null);
});
