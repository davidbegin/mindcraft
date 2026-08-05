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

test('builds a blank self-destruct plain with no hazards, mobs, or kit', async () => {
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

    for (const hazard of ['lava', 'water', 'cactus', 'gravel', 'sand', 'ladder[', 'stone']) {
        assert.equal(
            commands.some(command => command.includes(` ${hazard}`)),
            false,
            `self-destruct arena must not place ${hazard}`
        );
    }
    assert.equal(commands.some(command => command.startsWith('summon ')), false);
    assert.equal(
        commands.filter(command => command.startsWith('gamerule doMobSpawning ')).at(-1),
        'gamerule doMobSpawning false',
        'mob spawning must end up disabled so creepers never spawn'
    );
    assert.ok(commands.includes('difficulty normal'));
    assert.equal(commands.includes('time set midnight'), false);
    assert.ok(commands.includes('time set noon'));

    const blocksPlaced = new Set(
        commands
            .filter(command => command.startsWith('fill ') || command.startsWith('setblock '))
            .map(command => command.split(' ').at(-1))
    );
    assert.deepEqual([...blocksPlaced].sort(), ['air', 'barrier', 'bedrock', 'dirt', 'grass_block']);

    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`clear ${name}`));
        assert.ok(commands.includes(`effect give ${name} weakness infinite 255 true`));
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

async function prepareDogArena(seed) {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob']);
            return 'ok';
        },
    });

    const result = await manager.prepare(
        getContestGamePreset('dog_race'),
        ['alice', 'bob'],
        { spectators: [], ...(seed === undefined ? {} : { seed }) }
    );
    return { commands, result };
}

const ARENA_CENTER = 100000;

/**
 * Footprints of every placed block or summoned mob, skipping the arena-wide
 * floor, air, and barrier layers that always reach the walls.
 */
function dogFeatureFootprints(commands) {
    const footprints = [];
    for (const command of commands) {
        const parts = command.split(' ');
        let corners = null;
        if (parts[0] === 'fill') {
            corners = [Number(parts[1]), Number(parts[3]), Number(parts[4]), Number(parts[6])];
        } else if (parts[0] === 'setblock') {
            corners = [Number(parts[1]), Number(parts[3]), Number(parts[1]), Number(parts[3])];
        } else if (parts[0] === 'summon') {
            corners = [Number(parts[2]), Number(parts[4]), Number(parts[2]), Number(parts[4])];
        }
        if (!corners) continue;

        const [x1, z1, x2, z2] = corners.map(value => value - ARENA_CENTER);
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minZ = Math.min(z1, z2);
        const maxZ = Math.max(z1, z2);
        const maxOffset = Math.max(Math.abs(minX), maxX, Math.abs(minZ), maxZ);
        if (maxOffset >= 32) continue;

        footprints.push({
            raw: command,
            maxOffset,
            clearance: Math.hypot(
                Math.max(minX, 0, -maxX),
                Math.max(minZ, 0, -maxZ)
            ),
        });
    }
    return footprints;
}

function summonOffsets(commands, entity) {
    return commands
        .filter(command => command.startsWith(`summon ${entity} `))
        .map(command => {
            const [, , x, , z] = command.split(' ');
            return { dx: Number(x) - 100000, dz: Number(z) - 100000 };
        });
}

test('builds a dog wilderness that keeps spawn clear and hides the wolves', async () => {
    const { commands, result } = await prepareDogArena(1234);

    assert.equal(result.seed, 1234);
    assert.ok(commands.includes('time set midnight'));

    const wolves = summonOffsets(commands, 'wolf');
    const skeletons = summonOffsets(commands, 'skeleton');
    assert.ok(wolves.length >= 3 && wolves.length <= 5, `unexpected wolf count ${wolves.length}`);
    assert.ok(skeletons.length >= 5, `unexpected skeleton count ${skeletons.length}`);
    for (const { dx, dz } of wolves) {
        assert.ok(
            Math.hypot(dx, dz) >= 21,
            `wolf spawned inside the starting plain at ${dx},${dz}`
        );
    }

    const logs = commands.filter(command => / (?:oak|birch|spruce)_log$/.test(command));
    assert.ok(logs.length >= 12, `expected a forest, got ${logs.length} trunks`);

    // Spawn stays a bare plain: no wilderness feature reaches the starting radius.
    const features = dogFeatureFootprints(commands);
    assert.ok(features.length >= 20, `expected a populated wilderness, got ${features.length}`);
    for (const feature of features) {
        assert.ok(
            feature.clearance > 15,
            `feature intrudes on the starting plain: ${feature.raw}`
        );
        assert.ok(
            feature.maxOffset <= 31,
            `feature escapes the arena walls: ${feature.raw}`
        );
    }

    const spawns = commands.filter(command => command.startsWith('tp '));
    assert.equal(spawns.length, 2);
    for (const command of spawns) {
        const [, , x, , z] = command.split(' ');
        assert.ok(
            Math.hypot(x - ARENA_CENTER, z - ARENA_CENTER) <= 12,
            `dog racer starts off the bare plain: ${command}`
        );
    }

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

test('randomizes the dog wilderness per contest and replays from a seed', async () => {
    const first = await prepareDogArena();
    const second = await prepareDogArena();
    assert.notDeepEqual(first.commands, second.commands);
    assert.notEqual(first.result.seed, second.result.seed);

    const replay = await prepareDogArena(first.result.seed);
    assert.deepEqual(replay.commands, first.commands);
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
