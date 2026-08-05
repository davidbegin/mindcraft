import assert from 'node:assert/strict';
import test from 'node:test';

import { ContestArenaManager, getArenaJoinInfo, parseOnlinePlayers } from '../src/mindcraft/contest/arena_manager.js';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';

function listReply(names) {
    return `There are ${names.length} of a max of 20 players online: ${names.join(', ')}`;
}

test('radically resets the arena and every diamond-race participant', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            return 'ok';
        },
    });

    const result = await manager.prepare(
        getContestGamePreset('diamond_race'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.equal(result.id, 'simple-arena-v1');
    assert.equal(result.size, 65);
    assert.equal(result.resetCommandCount, commands.filter(command => command !== 'list').length);
    assert.ok(commands.some(command => command.startsWith('forceload add ')));
    assert.ok(commands.some(command => command.includes(' diamond_ore')));
    assert.ok(commands.includes('clear alice'));
    assert.ok(commands.includes('clear bob'));
    assert.ok(commands.includes('give alice iron_pickaxe 1'));
    assert.ok(commands.includes('gamemode survival bob'));
    assert.ok(commands.some(command => command.startsWith('tp alice ')));
    assert.ok(commands.some(command => command.startsWith('spawnpoint bob ')));
    assert.ok(
        commands.indexOf('list') < commands.indexOf('clear alice'),
        'must confirm players are online before clear/tp'
    );

    for (const command of commands.filter(command => command.startsWith('fill '))) {
        const [, x1, y1, z1, x2, y2, z2] = command.split(' ').map(Number);
        const volume = (Math.abs(x2 - x1) + 1)
            * (Math.abs(y2 - y1) + 1)
            * (Math.abs(z2 - z1) + 1);
        assert.ok(volume <= 32768, `fill command exceeds Minecraft limit: ${command}`);
    }
});

test('builds a netherite race that requires crafting a diamond pickaxe', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            return 'ok';
        },
    });

    await manager.prepare(
        getContestGamePreset('netherite_race'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.ok(commands.some(command => command.endsWith(' diamond_ore')));
    assert.ok(commands.some(command => command.endsWith(' ancient_debris')));
    assert.ok(commands.some(command => command.endsWith(' netherrack')));
    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`give ${name} iron_pickaxe 1`));
        assert.ok(commands.includes(`give ${name} stick 2`));
        assert.ok(commands.includes(`give ${name} crafting_table 1`));
        assert.ok(commands.includes(`give ${name} furnace 1`));
        assert.ok(commands.includes(`give ${name} coal 4`));
        assert.ok(commands.includes(`give ${name} gold_ingot 4`));
        assert.equal(
            commands.some(command => command.startsWith(`give ${name} diamond_pickaxe`)),
            false
        );
    }
});

test('builds a blank tower arena with equal kits and no diamond ore', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob', 'charlie']);
            return 'ok';
        },
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

test('builds a peaceful self-destruct arena with a lava hazard and no weapons', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            return 'ok';
        },
    });

    await manager.prepare(
        getContestGamePreset('death_race'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.ok(commands.some(command => command.endsWith(' lava')));
    assert.ok(commands.includes('gamerule doMobSpawning false'));
    assert.ok(commands.includes('difficulty peaceful'));
    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`clear ${name}`));
        assert.equal(
            commands.some(command => command.startsWith(`give ${name} `)),
            false
        );
    }
});

test('builds a deep enclosed mine with equal depth-race kits', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: command => {
            commands.push(command);
            return Promise.resolve(
                command === 'list' ? listReply(['alice', 'bob']) : 'ok'
            );
        },
    });

    await manager.prepare(
        getContestGamePreset('deepest_2_5'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.ok(commands.some(command => command.endsWith(' deepslate')));
    assert.ok(commands.some(command => command.includes('-64') && command.endsWith(' bedrock')));
    assert.ok(commands.includes('difficulty peaceful'));
    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`give ${name} diamond_pickaxe 1`));
        assert.ok(commands.includes(`give ${name} ladder 128`));
        assert.ok(commands.includes(`give ${name} torch 64`));
    }
});

test('builds a dog forest that requires finding bones and taming a wolf', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            return 'ok';
        },
    });

    await manager.prepare(
        getContestGamePreset('dog_race'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.ok(commands.some(command => command.startsWith('summon wolf ')));
    assert.ok(commands.some(command => command.startsWith('summon skeleton ')));
    assert.ok(commands.some(command => command.includes(' spruce_log')));
    assert.ok(commands.some(command => command.includes(' spruce_leaves')));
    assert.ok(commands.includes('time set midnight'));
    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`give ${name} stone_sword 1`));
        assert.ok(commands.includes(
            `advancement revoke ${name} only minecraft:husbandry/tame_an_animal`
        ));
        assert.equal(
            commands.some(command => command.startsWith(`give ${name} bone`)),
            false
        );
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

test('waits for missing Minecraft players before clear/tp and times out clearly', async () => {
    const commands = [];
    let lists = 0;
    const manager = new ContestArenaManager({
        playerWaitTimeoutMs: 50,
        playerWaitPollMs: 10,
        sleep: async () => {},
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') {
                lists += 1;
                return listReply(lists >= 3 ? ['alice', 'bob'] : ['alice']);
            }
            return 'ok';
        },
    });

    await manager.prepare(
        getContestGamePreset('tower_battle'),
        ['alice', 'bob'],
        { spectators: [] }
    );
    assert.ok(lists >= 3);
    assert.ok(commands.indexOf('list') < commands.indexOf('clear bob'));

    const failing = new ContestArenaManager({
        playerWaitTimeoutMs: 30,
        playerWaitPollMs: 5,
        sleep: async () => {},
        runCommand: async command => {
            if (command === 'list') return listReply(['alice']);
            return 'ok';
        },
    });
    await assert.rejects(
        failing.prepare(getContestGamePreset('tower_battle'), ['alice', 'bob'], { spectators: [] }),
        /Timed out waiting for Minecraft players before arena setup: bob/
    );
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
