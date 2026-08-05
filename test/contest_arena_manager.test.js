import assert from 'node:assert/strict';
import test from 'node:test';

import { ContestArenaManager, getArenaJoinInfo, parseOnlinePlayers } from '../src/mindcraft/contest/arena_manager.js';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';

test('radically resets the arena and every diamond-race participant', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => commands.push(command),
    });

    const result = await manager.prepare(
        getContestGamePreset('diamond_race'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.equal(result.id, 'simple-arena-v1');
    assert.equal(result.size, 65);
    assert.equal(result.resetCommandCount, commands.length);
    assert.ok(commands.some(command => command.startsWith('forceload add ')));
    assert.ok(commands.some(command => command.includes(' diamond_ore')));
    assert.ok(commands.includes('clear alice'));
    assert.ok(commands.includes('clear bob'));
    assert.ok(commands.includes('give alice iron_pickaxe 1'));
    assert.ok(commands.includes('gamemode survival bob'));
    assert.ok(commands.some(command => command.startsWith('tp alice ')));
    assert.ok(commands.some(command => command.startsWith('spawnpoint bob ')));

    for (const command of commands.filter(command => command.startsWith('fill '))) {
        const [, x1, y1, z1, x2, y2, z2] = command.split(' ').map(Number);
        const volume = (Math.abs(x2 - x1) + 1)
            * (Math.abs(y2 - y1) + 1)
            * (Math.abs(z2 - z1) + 1);
        assert.ok(volume <= 32768, `fill command exceeds Minecraft limit: ${command}`);
    }
});

test('builds a blank tower arena with equal kits and no diamond ore', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => commands.push(command),
    });

    await manager.prepare(
        getContestGamePreset('tower_battle'),
        ['alice', 'bob', 'charlie'],
        { spectators: [] }
    );

    assert.equal(commands.some(command => command.includes('diamond_ore')), false);
    for (const name of ['alice', 'bob', 'charlie']) {
        assert.ok(commands.includes(`clear ${name}`));
        assert.ok(commands.includes(`give ${name} cobblestone 256`));
        assert.ok(commands.includes(`give ${name} wooden_sword 1`));
    }
});

test('rejects unsafe player names before issuing server commands', async () => {
    let commandCount = 0;
    const manager = new ContestArenaManager({
        runCommand: async () => {
            commandCount += 1;
        },
    });

    await assert.rejects(
        manager.prepare(
            getContestGamePreset('tower_battle'),
            ['alice @a'],
            { spectators: [] }
        ),
        /Invalid Minecraft player name/
    );
    assert.equal(commandCount, 0);
});

test('parses online players and strips team suffixes from list output', async () => {
    assert.deepEqual(
        parseOnlinePlayers(
            'There are 3 of a max of 20 players online: beginbot, logistics [gpt-5.4-mini], builder [gpt-5.4-mini]'
        ),
        ['beginbot', 'logistics', 'builder']
    );
});

test('warps human spectators above the same arena without changing the join server', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') {
                return 'There are 3 of a max of 20 players online: beginbot, alice, bob';
            }
            return 'ok';
        },
    });

    const result = await manager.prepare(
        getContestGamePreset('tower_battle'),
        ['alice', 'bob']
    );

    assert.equal(result.sameServer, true);
    assert.deepEqual(result.spectators, ['beginbot']);
    assert.ok(commands.includes('gamemode spectator beginbot'));
    assert.ok(commands.some(command => command.startsWith('tp beginbot 100000 140 100000')));
    assert.equal(getArenaJoinInfo().teleportCommand, '/tp @s 100000 140 100000');
});
