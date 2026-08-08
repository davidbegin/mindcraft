import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ContestArenaManager,
    HOT_BUTTON,
    addHotButtonStations,
    buildParticipantCommands,
    buildWorldResetCommands,
    hotButtonStationLayout,
    participantSpawnPositions,
} from '../src/mindcraft/contest/arena_manager.js';
import { ContestCoordinator } from '../src/mindcraft/contest/contest_coordinator.js';
import { formatContestScore } from '../src/mindcraft/contest/contest_hud.js';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';
import {
    pickHotButtonSafeIndex,
    remainingHotButtonSurvivors,
    resolveHotButtonPressedIds,
    scoreHotButton,
} from '../src/mindcraft/contest/hot_button.js';
import { hotButtonCommandRejection } from '../src/agent/commands/command_guard.js';
import { buildParticipantGameDirective } from '../src/mindcraft/contest/game_content.js';

function listReply(names) {
    return `There are ${names.length} of a max of 20 players online: ${names.join(', ')}`;
}

async function withCoordinator(run, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-hot-button-'));
    try {
        const coordinator = await ContestCoordinator.create({
            root,
            idFactory: () => 'contest-hot-button',
            ...options,
        });
        await run({ coordinator, root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('hot button preset is a last-standing courage game', () => {
    const preset = getContestGamePreset('hot_button');
    assert.equal(preset.rules.type, 'hot_button');
    assert.equal(preset.rules.scoring, 'last-standing');
    assert.equal(preset.durationMs, 180_000);
    assert.equal(preset.metadata.pvp, false);
    assert.equal(preset.metadata.arena, 'hot-button-v1');
    assert.match(preset.prompt, /exactly ONE station is safe/i);
    assert.match(preset.prompt, /chicken/i);
    assert.match(preset.prompt, /!playHotButton/i);
});

test('builds one button station per player with exactly one safe pad', () => {
    const participants = ['alice', 'bob', 'chip', 'dana'];
    const seed = 42;
    const commands = buildWorldResetCommands('hot_button', {
        participantCount: participants.length,
        seed,
    });
    assert.ok(commands.some(command => command.includes('stone_button')));
    assert.ok(commands.some(command => command.includes('stone_pressure_plate')));
    assert.ok(commands.some(command => command.includes(' tnt') || command.endsWith(' tnt')));
    assert.ok(commands.some(command => command.includes('summon tnt')));
    assert.ok(commands.some(command => command.includes('tag @s add hot_button_pressed')));
    assert.ok(commands.includes('tag @a remove hot_button_pressed'));
    assert.ok(commands.includes('difficulty peaceful'));

    const buttonCommands = commands.filter(command => command.includes('stone_button[face=wall'));
    assert.equal(buttonCommands.length, participants.length);

    const { safeIndex, stations } = hotButtonStationLayout(participants.length, seed);
    assert.equal(stations.length, participants.length);
    assert.equal(stations.filter(station => station.safe).length, 1);
    assert.equal(stations[safeIndex].safe, true);
    assert.equal(safeIndex, pickHotButtonSafeIndex(participants.length, seed));

    const tntCommands = commands.filter(command =>
        /setblock -?\d+ \d+ -?\d+ tnt$/.test(command)
    );
    assert.equal(tntCommands.length, participants.length - 1);
});

test('hot button stations clear the button so each is one-shot', () => {
    const commands = [];
    const { stations } = addHotButtonStations(commands, 3, 7);
    for (const station of stations) {
        assert.ok(
            commands.some(command =>
                command.includes(
                    `setblock ${station.buttonX} ${station.buttonY} ${station.buttonZ} air`
                )
            ),
            `station ${station.index} never clears its button`
        );
    }
});

test('hot button spawns sit outside the station ring', () => {
    const participants = ['alice', 'bob', 'chip'];
    const spots = participantSpawnPositions('hot_button', participants);
    assert.equal(spots.size, 3);
    for (const name of participants) {
        const point = spots.get(name);
        assert.equal(point.y, 101);
        assert.ok(
            Math.abs(Math.hypot(point.x - 100000, point.z - 100000) - HOT_BUTTON.spawnRadius) < 0.75,
            `${name} is not on the outer spawn ring`
        );
    }
    const effects = buildParticipantCommands('hot_button', participants)
        .filter(command => command.includes('weakness'));
    assert.equal(effects.length, participants.length);
});

test('prepare stamps the safe station index from the arena seed', async () => {
    const spawns = participantSpawnPositions('hot_button', ['alice', 'bob']);
    const manager = new ContestArenaManager({
        runCommand: command => {
            if (command === 'list') return listReply(['alice', 'bob']);
            if (command.startsWith('data get entity ') && command.endsWith(' Pos')) {
                const name = command.split(' ')[3];
                const { x, y, z } = spawns.get(name);
                return `${name} has the following entity data: [${x}.0d, ${y}.0d, ${z}.0d]`;
            }
            return 'ok';
        },
    });
    const reset = await manager.prepare(
        getContestGamePreset('hot_button'),
        ['alice', 'bob'],
        { spectators: [], seed: 99 }
    );
    assert.equal(reset.seed, 99);
    assert.equal(reset.hotButtonSafeIndex, pickHotButtonSafeIndex(2, 99));
});

test('scoreHotButton ranks pressed survivors above chickens above exploded', () => {
    const now = 10_000;
    const contest = {
        participantIds: ['safe', 'chicken', 'boom'],
        startedAt: 0,
        completedAt: now,
        metadata: { pressedIds: ['safe'] },
        eliminations: {
            boom: { participantId: 'boom', eliminatedAt: 4_000, reason: 'exploded' },
        },
    };
    const ranked = scoreHotButton(contest, {}, now)
        .sort((left, right) => right.score - left.score);
    assert.deepEqual(
        ranked.map(result => result.participantId),
        ['safe', 'chicken', 'boom']
    );
    assert.equal(ranked[0].details.pressed, true);
    assert.equal(ranked[0].details.chicken, false);
    assert.equal(ranked[1].details.chicken, true);
    assert.equal(ranked[2].details.surviving, false);
});

test('exploded players count as pressed for early-win bookkeeping', () => {
    const pressed = resolveHotButtonPressedIds({
        metadata: { pressedIds: ['safe'] },
        eliminations: {
            boom: { reason: 'exploded' },
            other: { reason: 'fell' },
        },
    });
    assert.deepEqual(pressed.sort(), ['boom', 'safe']);
});

test('coordinator does not crown a lone chicken early', async () => {
    await withCoordinator(async ({ coordinator }) => {
        let clock = 1_000;
        coordinator.clock = () => clock;
        const contest = await coordinator.createContest({
            title: 'Hot Button',
            prompt: 'press',
            durationMs: 60_000,
            participantIds: ['alice', 'bob', 'chip'],
            rules: { type: 'hot_button', scoring: 'last-standing' },
            metadata: { pressedIds: [] },
        });
        await coordinator.startContest(contest.id);
        clock = 2_000;
        await coordinator.eliminate(contest.id, 'alice', { reason: 'exploded' });
        clock = 3_000;
        await coordinator.eliminate(contest.id, 'bob', { reason: 'exploded' });
        const view = coordinator.view().activeContest;
        assert.equal(view.status, 'running');
        assert.deepEqual(remainingHotButtonSurvivors(view), ['chip']);
        assert.ok(view.metadata.pressedIds.includes('alice'));
        assert.ok(view.metadata.pressedIds.includes('bob'));
        assert.ok(!view.metadata.pressedIds.includes('chip'));
    });
});

test('safe press crowns the sole survivor immediately', async () => {
    await withCoordinator(async ({ coordinator }) => {
        let clock = 1_000;
        coordinator.clock = () => clock;
        const contest = await coordinator.createContest({
            title: 'Hot Button',
            prompt: 'press',
            durationMs: 60_000,
            participantIds: ['alice', 'bob'],
            rules: { type: 'hot_button', scoring: 'last-standing' },
            metadata: { pressedIds: [] },
        });
        await coordinator.startContest(contest.id);
        clock = 2_000;
        await coordinator.eliminate(contest.id, 'alice', { reason: 'exploded' });
        clock = 3_000;
        await coordinator.markPressed(contest.id, 'bob', { event: 'button_pressed' });
        const view = coordinator.view();
        assert.equal(view.activeContest, null);
        const completed = view.contests.find(entry => entry.id === contest.id);
        assert.equal(completed.status, 'completed');
        assert.deepEqual(completed.winnerIds, ['bob']);
    });
});

test('HUD labels chickens and explosions', () => {
    const contest = { rules: { type: 'hot_button' } };
    assert.equal(
        formatContestScore(contest, {
            score: 1,
            details: { chicken: true, surviving: true, survivedMs: 30_000 },
        }),
        'chickened out'
    );
    assert.equal(
        formatContestScore(contest, {
            score: 1,
            details: { pressed: true, surviving: true },
        }),
        'last standing'
    );
    assert.equal(
        formatContestScore(contest, {
            score: 1,
            details: { surviving: false, survivedMs: 45_000 },
        }),
        'exploded at 0:45'
    );
});

test('game directive and command guard keep bots on the button path', () => {
    const preset = getContestGamePreset('hot_button');
    const directive = buildParticipantGameDirective(
        preset.prompt,
        ['alice', 'bob'],
        'alice',
        { contestType: 'hot_button' }
    );
    assert.match(directive, /!playHotButton/);
    assert.match(directive, /Refusing to press loses/);
    assert.match(hotButtonCommandRejection('!digDown'), /banned during Hot Button/);
    assert.equal(hotButtonCommandRejection('!playHotButton'), null);
});
