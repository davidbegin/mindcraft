import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_CAKE_INGREDIENTS,
    cakeRelevantCounts,
    formatCakeRaceBossbarSummary,
    formatCakeTeamProgress,
    measureCakeRaceProgress,
} from '../src/mindcraft/contest/cake_progress.js';

test('sugar cane counts toward sugar for cake progress', () => {
    assert.deepEqual(
        cakeRelevantCounts({ sugar: 1, sugar_cane: 2, wheat: 1, egg: 1, milk_bucket: 2 }),
        { milk_bucket: 2, sugar: 3, egg: 1, wheat: 1, cake: 0 }
    );
});

test('team cake progress aggregates split inventories and ranks the fuller side', () => {
    const { teamResults, neededTotal } = measureCakeRaceProgress({
        teamNames: ['Ember', 'Tide'],
        teamByParticipant: {
            Billy: 'Ember',
            Kimmy: 'Ember',
            Marcus: 'Ember',
            Dario: 'Tide',
            Chip: 'Tide',
            Bridget: 'Tide',
        },
        participantIds: ['Billy', 'Kimmy', 'Marcus', 'Dario', 'Chip', 'Bridget'],
        ingredients: DEFAULT_CAKE_INGREDIENTS,
        inventories: {
            Billy: { milk_bucket: 3 },
            Kimmy: { wheat: 3, egg: 1 },
            Marcus: { sugar_cane: 2 },
            Dario: { milk_bucket: 1, wheat: 1 },
            Chip: { egg: 1 },
            Bridget: {},
        },
    });

    assert.equal(neededTotal, 9);
    assert.equal(teamResults[0].teamName, 'Ember');
    assert.equal(teamResults[0].gathered, 9);
    assert.equal(teamResults[0].complete, true);
    assert.equal(teamResults[0].hasCake, false);
    assert.deepEqual(
        Object.fromEntries(teamResults[0].ingredients.map(slot => [slot.item, slot.have])),
        { milk_bucket: 3, sugar: 2, egg: 1, wheat: 3 }
    );
    assert.equal(teamResults[1].teamName, 'Tide');
    assert.equal(teamResults[1].gathered, 3);
    assert.equal(teamResults[1].rank, 2);
});

test('crafting a cake marks the team complete and tops the score', () => {
    const { teamResults } = measureCakeRaceProgress({
        teamNames: ['Ember', 'Tide'],
        teamByParticipant: { Billy: 'Ember', Dario: 'Tide' },
        participantIds: ['Billy', 'Dario'],
        inventories: {
            Billy: { cake: 1 },
            Dario: {
                milk_bucket: 3,
                sugar: 2,
                egg: 1,
                wheat: 3,
            },
        },
    });

    assert.equal(teamResults[0].teamName, 'Ember');
    assert.equal(teamResults[0].hasCake, true);
    assert.ok(teamResults[0].gathered > teamResults[1].gathered);
    assert.match(formatCakeTeamProgress(teamResults[0], { compact: true }), /CAKE/);
    assert.match(formatCakeRaceBossbarSummary(teamResults), /Ember/);
});
