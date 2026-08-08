import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestArenaManager,
    buildContestTeamCommands,
    getArenaJoinInfo,
    parseOnlinePlayers,
} from '../src/mindcraft/contest/arena_manager.js';
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

test('builds a farm scramble where racers must gather every cake ingredient', async () => {
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
        getContestGamePreset('cake_race'),
        ['alice', 'bob'],
        { spectators: [] }
    );

    assert.ok(commands.includes('gamerule doMobSpawning false'));
    assert.ok(commands.includes('difficulty peaceful'));
    assert.equal(commands.filter(command => command.startsWith('summon cow ')).length, 8);
    assert.equal(commands.filter(command => command.startsWith('summon chicken ')).length, 8);
    assert.ok(commands.some(command => command.endsWith('{EggLayTime:100}')));
    assert.ok(commands.some(command => command.endsWith(' sugar_cane')));
    assert.ok(commands.some(command => command.endsWith(' wheat[age=7]')));

    const cakeIngredients = ['milk_bucket', 'sugar', 'egg', 'wheat', 'cake'];
    for (const name of ['alice', 'bob']) {
        assert.ok(commands.includes(`give ${name} bucket 3`));
        assert.ok(commands.includes(`give ${name} crafting_table 1`));
        for (const ingredient of cakeIngredients) {
            assert.equal(
                commands.some(command => command.startsWith(`give ${name} ${ingredient} `)),
                false,
                `${name} must gather ${ingredient} during the race`
            );
        }
    }
});

test('builds ranked podiums and warps every competitor onto them', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') {
                return listReply(['alice', 'bob', 'charlie', 'human']);
            }
            return 'ok';
        },
    });

    const result = await manager.presentResults({
        status: 'completed',
        participantIds: ['alice', 'bob', 'charlie'],
        winnerIds: ['bob'],
        results: [
            { participantId: 'bob', rank: 1 },
            { participantId: 'charlie', rank: 2 },
            { participantId: 'alice', rank: 3 },
        ],
    });

    assert.equal(result.presented, true);
    assert.ok(commands.includes('fill 99999 101 99999 100001 103 100001 gold_block'));
    assert.ok(commands.includes('fill 99995 101 99999 99997 102 100001 iron_block'));
    assert.ok(commands.includes('fill 100003 101 99999 100005 101 100001 copper_block'));
    assert.ok(commands.includes('tp bob 100000 104 100000 0 0'));
    assert.ok(commands.includes('tp charlie 99996 103 100000 0 0'));
    assert.ok(commands.includes('tp alice 100004 102 100000 0 0'));
    for (const name of ['alice', 'bob', 'charlie']) {
        assert.ok(commands.includes(`gamemode adventure ${name}`));
        assert.ok(commands.includes(`effect give ${name} slowness infinite 255 true`));
        assert.ok(commands.includes(`effect give ${name} jump_boost infinite 128 true`));
        assert.ok(commands.includes(`effect give ${name} resistance infinite 255 true`));
    }
    assert.ok(commands.includes(
        'tp human 100000 107 100014 facing 100000 103 100000'
    ));
});

test('reveals the winner location to competitors and spectators before the podiums', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(['alice', 'bob', 'human']);
            return 'ok';
        },
    });

    const result = await manager.presentWinner({
        status: 'completed',
        participantIds: ['alice', 'bob'],
        winnerIds: ['alice'],
        submissions: {
            alice: {
                payload: {
                    position: { x: 100012.5, y: 74, z: 99991.5 },
                },
            },
        },
    });

    assert.deepEqual(result.position, { x: 100012.5, y: 74, z: 99991.5 });
    assert.deepEqual(result.spectators, ['human']);
    assert.ok(commands.includes(
        'tp alice 100012.5 74 99991.5 facing 100012.5 74 99992.5'
    ));
    assert.ok(commands.includes(
        'tp bob 100012.5 74 99991.5 facing 100012.5 74 99992.5'
    ));
    assert.ok(commands.includes(
        'tp human 100018.5 77 99997.5 facing 100012.5 75 99991.5'
    ));
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

test('team tower preserves inventory, clusters team spawns, and disables friendly fire', async () => {
    const commands = [];
    const participants = ['alice', 'amy', 'bob', 'ben'];
    const options = {
        spectators: [],
        teamNames: ['Ember', 'Tide'],
        teamByParticipant: {
            alice: 'Ember',
            amy: 'Ember',
            bob: 'Tide',
            ben: 'Tide',
        },
    };
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') return listReply(participants);
            return 'ok';
        },
    });
    await manager.prepare(
        getContestGamePreset('team_tower_battle'),
        participants,
        options
    );

    assert.ok(commands.includes('gamerule keepInventory true'));
    assert.ok(commands.includes('team modify mcgame_1 friendlyFire false'));
    assert.ok(commands.includes('team modify mcgame_2 friendlyFire false'));
    assert.ok(commands.includes('team modify mcgame_1 collisionRule pushOtherTeams'));
    assert.ok(commands.includes('team join mcgame_1 alice'));
    assert.ok(commands.includes('team join mcgame_2 bob'));
    for (const name of participants) {
        assert.ok(commands.includes(`give ${name} iron_sword 1`));
        assert.ok(commands.includes(`give ${name} iron_pickaxe 1`));
    }
    assert.ok(commands.includes('tp alice 99982 101 100000'));
    assert.ok(commands.includes('tp amy 99982 101 100001'));
    assert.ok(commands.includes('tp bob 100018 101 100000'));
    assert.ok(commands.includes('tp ben 100018 101 100001'));
    assert.ok(buildContestTeamCommands(participants, options).length > 0);
});

test('team nametags keep the model name alongside the team name', () => {
    const participants = ['alice', 'amy', 'bob', 'ben'];
    const commands = buildContestTeamCommands(participants, {
        teamNames: ['Ember', 'Tide'],
        teamByParticipant: {
            alice: 'Ember',
            amy: 'Ember',
            bob: 'Tide',
            ben: 'Tide',
        },
        modelByParticipant: {
            alice: { api: 'cursor', model: 'gpt-5.6-sol' },
            amy: { api: 'cursor', model: 'claude-opus-5' },
            bob: 'gpt-5.6-sol',
            ben: 'gpt-5.6-sol',
        },
    });

    const suffixOf = teamId => commands.find(command =>
        command.startsWith(`team modify ${teamId} suffix `)
    );
    assert.deepEqual(
        JSON.parse(suffixOf('mcgame_1_gpt56sol').replace('team modify mcgame_1_gpt56sol suffix ', '')),
        {
            text: ' [Ember]',
            color: 'red',
            extra: [{ text: ' [gpt-5.6-sol]', color: 'gold' }],
        }
    );
    assert.ok(commands.includes('team join mcgame_1_gpt56sol alice'));
    assert.ok(commands.includes('team join mcgame_1_claudeopus5 amy'));
    // A side on one model stays a single team, so friendly fire stays off.
    assert.ok(commands.includes('team join mcgame_2_gpt56sol bob'));
    assert.ok(commands.includes('team join mcgame_2_gpt56sol ben'));
    assert.equal(
        commands.filter(command => command.startsWith('team add mcgame_2')).length,
        1
    );
    for (const teamId of ['mcgame_1_gpt56sol', 'mcgame_1_claudeopus5', 'mcgame_2_gpt56sol']) {
        assert.ok(commands.includes(`team modify ${teamId} friendlyFire false`));
    }
});

test('contest teams from an earlier match are removed before the next one', () => {
    const options = {
        teamNames: ['Ember', 'Tide'],
        teamByParticipant: { alice: 'Ember', bob: 'Tide' },
        modelByParticipant: { alice: 'kimi-k3', bob: 'glm-5.2' },
    };
    buildContestTeamCommands(['alice', 'bob'], options);
    const commands = buildContestTeamCommands(['alice', 'bob'], {
        ...options,
        modelByParticipant: { alice: 'grok-4.5', bob: 'gemini-3.1-pro' },
    });

    assert.ok(commands.includes('team remove mcgame_1_kimik3'));
    assert.ok(commands.includes('team remove mcgame_2_glm52'));
    assert.ok(commands.includes('team join mcgame_1_grok45 alice'));
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

test('does not read team and model nametag tags as extra players', async () => {
    assert.deepEqual(
        parseOnlinePlayers(
            'There are 3 of a max of 20 players online: beginbot, '
            + 'Billy [Tide] [grok-4.5], glm_thorough [Surf] [glm-4.7]'
        ),
        ['beginbot', 'Billy', 'glm_thorough']
    );
});

test('skips a spectator who logs out between the player list and the warp', async () => {
    const commands = [];
    const manager = new ContestArenaManager({
        runCommand: async command => {
            commands.push(command);
            if (command === 'list') {
                return 'There are 3 of a max of 20 players online: beginbot, ghost, alice';
            }
            if (command.includes('ghost')) {
                throw new Error(`Minecraft rejected "${command}": No player was found`);
            }
            return 'ok';
        },
    });

    const result = await manager.prepare(
        getContestGamePreset('tower_battle'),
        ['alice'],
        { spectators: ['beginbot', 'ghost'] }
    );

    assert.deepEqual(result.spectators, ['beginbot']);
    assert.ok(commands.includes('gamemode spectator beginbot'));
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
