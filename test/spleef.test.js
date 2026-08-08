import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ContestArenaManager,
    buildParticipantCommands,
    buildWorldResetCommands,
    participantSpawnPositions,
    verifyParticipantPlacement,
} from '../src/mindcraft/contest/arena_manager.js';
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
    const spawns = participantSpawnPositions('spleef', ['alice', 'bob']);
    const manager = new ContestArenaManager({
        runCommand: command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            if (command.startsWith('data get entity ') && command.endsWith(' Pos')) {
                const name = command.split(' ')[3];
                const { x, y, z } = spawns.get(name);
                return `${name} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
            }
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

test('repairs the Spleef platform last and starts every player in a wide circle', () => {
    const worldCommands = buildWorldResetCommands('spleef');
    assert.equal(
        worldCommands.at(-1),
        'fill 99968 100 99968 100032 100 100032 snow_block',
        'the final world-build command repairs the complete platform'
    );

    const participants = ['alice', 'bob', 'chip', 'dana'];
    const teleports = buildParticipantCommands('spleef', participants)
        .filter(command => command.startsWith('tp '));
    assert.equal(teleports.length, participants.length);

    // The platform spans center ± 32 with a barrier wall on the perimeter, so the
    // ring is pushed right out to the lip of the course: radius 30, two blocks off
    // the wall, far wider than a timid huddle near the center.
    for (const command of teleports) {
        const [, , x, y, z] = command.split(' ');
        assert.equal(Number(y), 101);
        assert.ok(
            Math.abs(Math.hypot(Number(x) - 100000, Number(z) - 100000) - 30) < 0.75,
            `Spleef spawn is not on the wide starting circle: ${command}`
        );
        assert.ok(
            Math.abs(Number(x) - 100000) <= 30 && Math.abs(Number(z) - 100000) <= 30,
            `Spleef spawn is off the snow course or in the wall: ${command}`
        );
    }
    assert.equal(new Set(teleports).size, participants.length);
});

test('the Spleef ring scales to the cast and spreads them as far as the course allows', () => {
    const center = 100000;
    // Points evenly spaced on a ring of radius R sit 2*R*sin(PI/N) apart, so the
    // spacing has to change with the head count while the ring hugs the platform.
    for (const count of [2, 3, 5, 8, 12]) {
        const participants = Array.from({ length: count }, (_, index) => `bot${index}`);
        const spots = participantSpawnPositions('spleef', participants);
        assert.equal(spots.size, count);

        const points = participants.map(name => spots.get(name));
        for (const point of points) {
            assert.equal(point.y, 101, 'a Spleef player did not start on the top snow layer');
            assert.ok(
                Math.abs(Math.hypot(point.x - center, point.z - center) - 30) < 0.75,
                `count ${count}: a player is not on the course-edge ring`
            );
        }

        // Every nearest-neighbour gap matches the ideal even spacing, so nobody is
        // bunched up: the cast is spread as far apart as a radius-30 ring permits.
        const expectedGap = 2 * 30 * Math.sin(Math.PI / count);
        let closest = Infinity;
        for (let i = 0; i < points.length; i += 1) {
            for (let j = i + 1; j < points.length; j += 1) {
                closest = Math.min(
                    closest,
                    Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z)
                );
            }
        }
        assert.ok(
            Math.abs(closest - expectedGap) < 2,
            `count ${count}: closest pair ${closest.toFixed(1)} is not the even-spacing ideal ${expectedGap.toFixed(1)}`
        );
    }
});

test('every Spleef round rebuilds the arena before anyone is teleported onto it', async () => {
    const spawns = participantSpawnPositions('spleef', ['alice', 'bob']);
    const rounds = [];
    const manager = new ContestArenaManager({
        runCommand: command => {
            rounds.at(-1).push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            if (command.startsWith('data get entity ') && command.endsWith(' Pos')) {
                const name = command.split(' ')[3];
                const { x, y, z } = spawns.get(name);
                return `${name} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
            }
            return 'ok';
        },
    });

    // Two back-to-back rounds: the second must rebuild just as completely as the
    // first, so a platform chewed up by the previous match never carries over.
    for (const _round of [1, 2]) {
        rounds.push([]);
        const reset = await manager.prepare(
            getContestGamePreset('spleef'),
            ['alice', 'bob'],
            { spectators: [] }
        );
        assert.deepEqual(
            reset.placementAudits.map(audit => [audit.participantId, audit.onTopLayer]),
            [['alice', true], ['bob', true]]
        );
    }

    for (const commands of rounds) {
        const repair = commands.indexOf('fill 99968 100 99968 100032 100 100032 snow_block');
        assert.ok(repair >= 0, 'the round never repaired the snow platform');
        assert.ok(
            commands.some(command => command.includes(' water')),
            'the round never refilled the pit under the platform'
        );
        const firstMove = commands.findIndex(command => command.includes('tp alice'));
        assert.ok(firstMove >= 0, 'the round never teleported alice');
        assert.ok(repair < firstMove, 'a player was teleported before the platform was repaired');
    }
});

test('a cast the teleport rig never moved is still forced into the ring', async () => {
    // The rig silently did nothing. Because the arena rebuild lays fresh snow
    // under everyone, all four bots read as standing on the top layer at y=101 —
    // they are simply scattered wherever the previous round left them. Altitude
    // alone must not be mistaken for a starting ring.
    const participants = ['alice', 'bob', 'chip', 'dana'];
    const positions = new Map([
        ['alice', { x: 100003, y: 101, z: 100001 }],
        ['bob', { x: 100004, y: 101, z: 99998 }],
        ['chip', { x: 99996, y: 101, z: 100002 }],
        ['dana', { x: 100001, y: 101, z: 100005 }],
    ]);
    const teleported = [];
    const audits = await verifyParticipantPlacement(
        command => {
            if (command.startsWith('tp ')) {
                const [, name, x, y, z] = command.split(' ');
                positions.set(name, { x: Number(x), y: Number(y), z: Number(z) });
                teleported.push(name);
                return 'ok';
            }
            const name = command.split(' ')[3];
            const { x, y, z } = positions.get(name);
            return `${name} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
        },
        'spleef',
        participants
    );

    assert.deepEqual(teleported, participants, 'every unmoved bot should be put on its mark');
    for (const audit of audits) {
        assert.equal(audit.atAssignedSpot, true, `${audit.participantId} never reached its mark`);
    }

    const points = participants.map(name => positions.get(name));
    for (const point of points) {
        assert.equal(point.y, 101);
        assert.ok(
            Math.abs(Math.hypot(point.x - 100000, point.z - 100000) - 30) < 0.75,
            'a recovered bot is not on the course-edge ring'
        );
    }
    // Four bots on a radius-30 ring sit 2*30*sin(PI/4) apart, equally spaced.
    let closest = Infinity;
    for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
            closest = Math.min(
                closest,
                Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z)
            );
        }
    }
    assert.ok(
        Math.abs(closest - 2 * 30 * Math.sin(Math.PI / 4)) < 2,
        `recovered cast is not evenly spaced: closest pair ${closest.toFixed(1)}`
    );
});

test('a player the teleport rig missed is put back on the top layer', async () => {
    const commands = [];
    const positions = new Map([
        ['alice', { x: 100030, y: 101, z: 100000 }],
        // The chain skipped bob, so he is still standing where he logged in.
        ['bob', { x: 99990, y: 71, z: 100010 }],
    ]);
    const audits = await verifyParticipantPlacement(
        command => {
            commands.push(command);
            if (command.startsWith('tp ')) {
                const [, name, x, y, z] = command.split(' ');
                positions.set(name, { x: Number(x), y: Number(y), z: Number(z) });
                return 'ok';
            }
            const name = command.split(' ')[3];
            const { x, y, z } = positions.get(name);
            return `${name} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
        },
        'spleef',
        ['alice', 'bob']
    );

    const alice = audits.find(audit => audit.participantId === 'alice');
    assert.equal(alice.onTopLayer, true);
    assert.equal(alice.repaired, false, 'a bot already on the snow was teleported again');

    const bob = audits.find(audit => audit.participantId === 'bob');
    assert.equal(bob.repaired, true);
    assert.equal(bob.onTopLayer, true);
    assert.equal(bob.actual.y, 101);
    assert.ok(
        Math.abs(Math.hypot(bob.actual.x - 100000, bob.actual.z - 100000) - 30) < 0.75,
        'the recovered bot was not returned to the wide starting circle'
    );
    assert.equal(
        commands.filter(command => command.startsWith('tp ')).length,
        1,
        'only the bot that was off the platform should be teleported again'
    );
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
