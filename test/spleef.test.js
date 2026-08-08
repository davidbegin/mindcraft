import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContestArenaManager } from '../src/mindcraft/contest/arena_manager.js';
import { ContestCoordinator } from '../src/mindcraft/contest/contest_coordinator.js';
import { formatContestScore } from '../src/mindcraft/contest/contest_hud.js';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';
import {
    spleefProtectedColumns,
    spleefTargetBlocks,
} from '../src/agent/library/skills.js';
import {
    remainingSpleefSurvivors,
    scoreSpleef,
} from '../src/mindcraft/contest/spleef.js';
import {
    resolveIndividualChallenge,
    resolveTeamChallenge,
} from '../src/mindcraft/survivor/survivor_challenges.js';

function listReply(names) {
    return `There are ${names.length} of a max of 20 players online: ${names.join(', ')}`;
}

async function withCoordinator(run, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-spleef-'));
    try {
        const coordinator = await ContestCoordinator.create({
            root,
            idFactory: () => 'contest-spleef',
            ...options,
        });
        await run({ coordinator, root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('builds a snow platform over a water pit with shovel kits', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            return 'ok';
        },
    });

    await manager.prepare(
        getContestGamePreset('spleef'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.ok(commands.some(command => command.includes('snow_block')));
    assert.ok(commands.some(command => command.includes(' water')));
    assert.equal(
        commands.filter(command => command.startsWith('gamerule doMobSpawning ')).at(-1),
        'gamerule doMobSpawning false'
    );
    assert.ok(commands.includes('difficulty peaceful'));
    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`give ${name} diamond_shovel 1`));
        assert.ok(commands.includes(`give ${name} bread 16`));
        assert.ok(commands.includes(`effect give ${name} weakness infinite 255 true`));
    }
});

test('a bot never targets the floor holding itself up, however a rival moves', () => {
    const floorY = 100;
    // A bot straddling a block boundary still has to protect both columns.
    for (const own of [
        { x: 100000.5, y: floorY + 1, z: 100000.5 },
        { x: 100000.02, y: floorY + 1, z: 99999.98 },
    ]) {
        const protectedColumns = spleefProtectedColumns(own);
        for (const velocity of [
            { x: 0, z: 0 },
            { x: 0.25, z: 0 },
            { x: -0.25, z: 0.25 },
            { x: 0, z: -0.25 },
        ]) {
            // The worst case: a rival standing right on top of the bot.
            const targets = spleefTargetBlocks({ position: own, velocity }, floorY);
            const reachable = targets.filter(target =>
                !protectedColumns.has(`${target.x},${target.z}`)
            );
            for (const target of reachable) {
                assert.ok(
                    Math.max(
                        Math.abs(target.x - Math.floor(own.x)),
                        Math.abs(target.z - Math.floor(own.z))
                    ) > 1,
                    `would dig its own footing at ${target.x},${target.z}`
                );
            }
        }
    }
});

test('scoreSpleef ranks survivors above later falls above earlier falls', () => {
    const ranked = scoreSpleef({
        participantIds: ['alice', 'bob', 'chip'],
        startedAt: 1_000,
        completedAt: 10_000,
        eliminations: {
            alice: { eliminatedAt: 4_000, reason: 'fell' },
            bob: { eliminatedAt: 7_000, reason: 'fell' },
        },
    }, 10_000);

    ranked.sort((left, right) => right.score - left.score);
    assert.deepEqual(
        ranked.map(result => result.participantId),
        ['chip', 'bob', 'alice']
    );
    assert.equal(ranked[0].details.surviving, true);
    assert.equal(remainingSpleefSurvivors({
        participantIds: ['alice', 'bob', 'chip'],
        eliminations: {
            alice: { eliminatedAt: 4_000 },
            bob: { eliminatedAt: 7_000 },
        },
    }).join(','), 'chip');
});

test('eliminating all but one contestant crowns the last standing', async () => {
    let now = 5_000;
    await withCoordinator(async ({ coordinator, root }) => {
        const contest = await coordinator.createContest({
            title: 'Spleef',
            prompt: 'Dig snow under rivals.',
            durationMs: 60_000,
            participantIds: ['alice', 'bob', 'chip'],
            rules: { type: 'spleef', scoring: 'last-standing', floorY: 100 },
        });
        assert.deepEqual(contest.eliminations, {});
        await coordinator.startContest(contest.id);

        now = 8_000;
        const afterFirst = await coordinator.eliminate(contest.id, 'alice', { reason: 'fell' });
        assert.equal(afterFirst.status, 'running');
        assert.equal(afterFirst.eliminations.alice.reason, 'fell');

        now = 12_000;
        const completed = await coordinator.eliminate(contest.id, 'bob', { reason: 'fell' });
        assert.equal(completed.status, 'completed');
        assert.deepEqual(completed.winnerIds, ['chip']);
        assert.equal(completed.submissions.chip.payload.event, 'last_standing');
        assert.equal(
            completed.results.find(result => result.participantId === 'chip').rank,
            1
        );
        assert.equal(
            completed.results.find(result => result.participantId === 'bob').rank,
            2
        );

        const events = (await readFile(
            path.join(root, 'journal.jsonl'),
            'utf8'
        )).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(events.some(event =>
            event.type === 'participant.eliminated'
            && event.data.participantId === 'alice'
        ));
        assert.ok(events.some(event =>
            event.type === 'winner.detected'
            && event.data.participantId === 'chip'
        ));
    }, {
        clock: () => now,
        judge: contest => scoreSpleef(contest, now),
    });
});

test('spleef deadline ranks remaining survivors first', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contest = await coordinator.createContest({
            title: 'Spleef',
            prompt: 'Dig snow under rivals.',
            durationMs: 5_000,
            participantIds: ['alice', 'bob', 'chip'],
            rules: { type: 'spleef', scoring: 'last-standing' },
        });
        await coordinator.startContest(contest.id);
        now = 3_000;
        await coordinator.eliminate(contest.id, 'alice', { reason: 'fell' });
        now = 6_000;
        const transition = await coordinator.tick();
        assert.equal(transition.changed, true);
        assert.equal(transition.reason, 'deadline');
        const completed = coordinator.snapshot().contests[contest.id];
        assert.equal(completed.status, 'completed');
        assert.ok(completed.winnerIds.includes('bob'));
        assert.ok(completed.winnerIds.includes('chip'));
        assert.equal(
            completed.results.find(result => result.participantId === 'alice').rank,
            3
        );
    }, {
        clock: () => now,
        judge: contest => scoreSpleef(contest, now),
    });
});

test('HUD celebrates last standing', () => {
    const contest = {
        rules: { type: 'spleef', scoring: 'last-standing' },
        results: [
            {
                participantId: 'chip',
                score: 1_000_009_000,
                rank: 1,
                details: { surviving: true, survivedMs: 9_000 },
            },
            {
                participantId: 'bob',
                score: 6_000,
                rank: 2,
                details: { surviving: false, survivedMs: 6_000 },
            },
        ],
    };
    assert.equal(formatContestScore(contest, contest.results[0]), 'last standing');
    assert.equal(formatContestScore(contest, contest.results[1]), 'fell at 0:06');
});

test('Survivor scoring prefers longer Spleef survival', () => {
    const preset = getContestGamePreset('spleef');
    assert.equal(resolveIndividualChallenge(preset, [
        { participantId: 'Alice', survivedMs: 4_000 },
        { participantId: 'Billy', surviving: true, survivedMs: 10_000 },
    ]).winnerId, 'Billy');

    const tribes = {
        Alice: 'Ember',
        Billy: 'Tide',
        Dario: 'Ember',
        Marcus: 'Tide',
    };
    const team = resolveTeamChallenge(preset, [
        { participantId: 'Alice', survivedMs: 2_000 },
        { participantId: 'Billy', survivedMs: 8_000 },
        { participantId: 'Dario', surviving: true, survivedMs: 9_000 },
        { participantId: 'Marcus', survivedMs: 1_000 },
    ], tribes);
    assert.equal(team.winningTribe, 'Ember');
});
