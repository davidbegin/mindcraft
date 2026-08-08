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
    scoreTeamBaseSiege,
    survivingTeamsForSiege,
} from '../src/mindcraft/contest/team_base_siege.js';

function siegeContest(overrides = {}) {
    return {
        participantIds: ['alice', 'amy', 'bob', 'ben'],
        startedAt: 1_000,
        completedAt: 61_000,
        eliminations: {},
        rules: {
            type: 'team_base_siege',
            maxPressureRounds: 3,
            shrinkStep: 8,
            minHalfSize: 8,
        },
        metadata: {
            gameSession: {
                teamNames: ['Ember', 'Tide'],
                teamByParticipant: {
                    alice: 'Ember',
                    amy: 'Ember',
                    bob: 'Tide',
                    ben: 'Tide',
                },
                pressureRound: 0,
                arenaHalfSize: 32,
            },
        },
        ...overrides,
    };
}

test('Base Siege scoring keeps surviving teammates tied and ranks eliminated by survival time', () => {
    const contest = siegeContest({
        eliminations: {
            bob: { eliminatedAt: 21_000, reason: 'death' },
            ben: { eliminatedAt: 31_000, reason: 'death' },
            amy: { eliminatedAt: 41_000, reason: 'death' },
        },
    });
    const results = scoreTeamBaseSiege(contest, 61_000);
    const byId = Object.fromEntries(results.map(result => [result.participantId, result]));
    assert.equal(byId.alice.details.surviving, true);
    assert.equal(byId.amy.details.surviving, false);
    assert.equal(byId.bob.details.surviving, false);
    assert.equal(byId.ben.details.surviving, false);
    assert.equal(byId.alice.score, byId.amy.score);
    assert.equal(byId.bob.score, byId.ben.score);
    assert.ok(byId.alice.score > byId.ben.score);
});

test('Base Siege detects when both teams still have survivors', () => {
    const contest = siegeContest({
        eliminations: {
            bob: { eliminatedAt: 21_000, reason: 'death' },
        },
    });
    assert.deepEqual(survivingTeamsForSiege(contest).sort(), ['Ember', 'Tide']);
    assert.equal(bothSiegeTeamsAlive(contest), true);
    assert.equal(canDeferSiegeDeadline(contest), true);

    contest.eliminations.alice = { eliminatedAt: 30_000, reason: 'death' };
    contest.eliminations.amy = { eliminatedAt: 31_000, reason: 'death' };
    assert.deepEqual(survivingTeamsForSiege(contest), ['Tide']);
    assert.equal(bothSiegeTeamsAlive(contest), false);
    assert.equal(canDeferSiegeDeadline(contest), false);
});

test('Base Siege pressure rounds shrink the arena until the cap', () => {
    assert.equal(nextSiegeHalfSize(32, 8, 8), 24);
    assert.equal(nextSiegeHalfSize(16, 8, 8), 8);
    assert.equal(nextSiegeHalfSize(8, 8, 8), 8);

    const contest = siegeContest({
        metadata: {
            gameSession: {
                teamNames: ['Ember', 'Tide'],
                teamByParticipant: {
                    alice: 'Ember',
                    amy: 'Ember',
                    bob: 'Tide',
                    ben: 'Tide',
                },
                pressureRound: 3,
            },
        },
    });
    assert.equal(canDeferSiegeDeadline(contest), false);
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

test('Base Siege planning and build directives ban early combat', () => {
    const planning = buildBaseSiegePlanningDirective({
        planningMs: 30_000,
        participantName: 'alice',
        teamId: 'Ember',
        teammateIds: ['amy'],
        enemyIds: ['bob', 'ben'],
        captainId: 'alice',
    });
    assert.match(planning, /PLANNING PHASE/);
    assert.match(planning, /do NOT place or break blocks/i);
    assert.match(planning, /arena shrinks/i);

    const build = buildBaseSiegeBuildDirective({
        buildPhaseMs: 30_000,
        participantName: 'alice',
        teamId: 'Ember',
        teammateIds: ['amy'],
        enemyIds: ['bob', 'ben'],
        captainId: 'alice',
    });
    assert.match(build, /BUILD PHASE/);
    assert.match(build, /Do NOT attack enemies yet/i);
    assert.match(build, /30 seconds/i);
});
