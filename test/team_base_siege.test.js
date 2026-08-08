import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildArenaShrinkCommands,
    buildPressureRoundCommands,
    getArenaJoinInfo,
} from '../src/mindcraft/contest/arena_manager.js';
import {
    buildBaseSiegeBuildDirective,
    buildBaseSiegePlanningDirective,
} from '../src/mindcraft/contest/game_content.js';
import {
    bothSiegeTeamsAlive,
    canDeferSiegeDeadline,
    nextSiegeHalfSize,
    remainingTeamSiegeSurvivors,
    scoreTeamBaseSiege,
    survivingTeamsForSiege,
} from '../src/mindcraft/contest/team_base_siege.js';

function siegeContest(overrides = {}) {
    return {
        participantIds: ['alice', 'bob', 'chip', 'dana'],
        startedAt: 1_000,
        completedAt: 61_000,
        eliminations: {},
        rules: {
            type: 'team_base_siege',
            scoring: 'last-standing',
            buildPhaseMs: 180_000,
            floorY: 100,
        },
        metadata: {
            gameSession: {
                buildPhaseMs: 180_000,
            },
        },
        ...overrides,
    };
}

test('Base Siege scoring ranks survivors above eliminated players by survival time', () => {
    const contest = siegeContest({
        eliminations: {
            bob: { eliminatedAt: 21_000, reason: 'death' },
            chip: { eliminatedAt: 31_000, reason: 'death' },
            dana: { eliminatedAt: 41_000, reason: 'fell' },
        },
    });
    const results = scoreTeamBaseSiege(contest, 61_000);
    const byId = Object.fromEntries(results.map(result => [result.participantId, result]));
    assert.equal(byId.alice.details.surviving, true);
    assert.equal(byId.bob.details.surviving, false);
    assert.equal(byId.chip.details.surviving, false);
    assert.equal(byId.dana.details.surviving, false);
    assert.ok(byId.alice.score > byId.dana.score);
    assert.ok(byId.dana.score > byId.chip.score);
    assert.ok(byId.chip.score > byId.bob.score);
    assert.deepEqual(remainingTeamSiegeSurvivors(contest), ['alice']);
});

test('Base Siege no longer defers deadlines for team pressure rounds', () => {
    assert.equal(canDeferSiegeDeadline(), false);
    assert.equal(bothSiegeTeamsAlive(), false);
    assert.deepEqual(survivingTeamsForSiege(), []);
    assert.equal(nextSiegeHalfSize(32, 8, 8), 24);
    assert.equal(nextSiegeHalfSize(8, 8, 8), 8);
});

test('arena shrink and pressure-round commands confine survivors', () => {
    const halfSize = 16;
    const shrink = buildArenaShrinkCommands(halfSize);
    assert.equal(shrink.length, 4);
    assert.ok(shrink.every(command => command.includes('barrier')));
    assert.ok(shrink.some(command => command.includes('99984')));

    const commands = buildPressureRoundCommands({
        survivors: ['alice', 'bob'],
        teamNames: ['Ember', 'Tide'],
        teamByParticipant: { alice: 'Ember', bob: 'Tide' },
        halfSize,
    });
    assert.ok(commands.some(command => command.startsWith('tp alice ')));
    assert.ok(commands.some(command => command.startsWith('tp bob ')));
    assert.ok(commands.some(command => command.includes('give alice iron_sword 1')));
    assert.ok(commands.some(command => command.includes('give bob shield 1')));
    assert.equal(getArenaJoinInfo().arena.halfSize, 32);
});

test('Base Siege waiting and build directives ban early combat', () => {
    const waiting = buildBaseSiegePlanningDirective({
        planningMs: 30_000,
        participantName: 'alice',
    });
    assert.match(waiting, /WAITING/);
    assert.match(waiting, /Do not build, craft, dig, attack/i);

    const build = buildBaseSiegeBuildDirective({
        buildPhaseMs: 180_000,
        participantName: 'alice',
        rivalIds: ['bob', 'chip'],
    });
    assert.match(build, /BUILD PHASE/);
    assert.match(build, /Do NOT attack anyone yet/i);
    assert.match(build, /180 seconds/i);
    assert.match(build, /bob, chip/);
});
