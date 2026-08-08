import assert from 'node:assert/strict';
import test from 'node:test';

import {
    contestHasTeamSession,
    isTeamContestType,
    isTeamItemRaceContest,
    scoreTeamFirstFinish,
} from '../src/mindcraft/contest/team_games.js';

test('first cake is a team item race', () => {
    assert.equal(isTeamContestType('cake_race'), true);
    assert.equal(isTeamItemRaceContest('cake_race'), true);
    assert.equal(isTeamItemRaceContest('team_tower_battle'), false);
});

test('team first-finish scoring crowns every member of the finishing side', () => {
    const results = scoreTeamFirstFinish({
        participantIds: ['Billy', 'Kimmy', 'Marcus', 'Dario', 'ChipChipperson', 'bridget'],
        rules: { type: 'cake_race', winItem: 'cake' },
        submissions: {
            Kimmy: {
                participantId: 'Kimmy',
                payload: { item: 'cake', elapsedMs: 42_000 },
            },
        },
        metadata: {
            gameSession: {
                teamNames: ['Ember', 'Tide'],
                teamByParticipant: {
                    Billy: 'Ember',
                    Kimmy: 'Ember',
                    Marcus: 'Ember',
                    Dario: 'Tide',
                    ChipChipperson: 'Tide',
                    bridget: 'Tide',
                },
            },
        },
    });

    assert.deepEqual(
        results.filter(result => result.score === 1).map(result => result.participantId),
        ['Billy', 'Kimmy', 'Marcus']
    );
    assert.equal(results.find(result => result.participantId === 'Kimmy').details.finisherId, 'Kimmy');
    assert.equal(results.find(result => result.participantId === 'Billy').details.elapsedMs, 42_000);
    assert.equal(results.find(result => result.participantId === 'Dario').score, 0);
    assert.equal(results.every(result => !result.disqualified), true);
    assert.equal(contestHasTeamSession({
        metadata: { gameSession: { teamNames: ['Ember', 'Tide'] } },
    }), true);
    assert.equal(contestHasTeamSession({ metadata: {} }), false);
});

test('team first-finish with no crafts disqualifies everyone', () => {
    const results = scoreTeamFirstFinish({
        participantIds: ['Billy', 'Dario'],
        submissions: {},
        metadata: {
            gameSession: {
                teamNames: ['Ember', 'Tide'],
                teamByParticipant: { Billy: 'Ember', Dario: 'Tide' },
            },
        },
    });
    assert.ok(results.every(result => result.disqualified));
});
