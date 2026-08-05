import { runMinecraftCommand } from '../minecraft_server.js';
import { buildDogRaceResetCommand } from './dog_race.js';

const ARENA = Object.freeze({
    centerX: 100000,
    centerZ: 100000,
    floorY: 100,
    halfSize: 32,
    clearTopY: 220,
    mineBottomY: 68,
    depthBottomY: -60,
    worldBottomY: -64,
    spectatorY: 140,
});

const DEPTH_RACE_KIT = Object.freeze([
    'diamond_pickaxe 1',
    'bread 16',
    'torch 64',
    'ladder 128',
]);

const GAME_KITS = Object.freeze({
    death_race: Object.freeze([
        'wooden_sword 1',
    ]),
    dog_race: Object.freeze([
        'stone_sword 1',
        'bread 16',
    ]),
    diamond_race: Object.freeze([
        'iron_pickaxe 1',
        'bread 16',
        'torch 32',
    ]),
    netherite_race: Object.freeze([
        'iron_pickaxe 1',
        'stick 2',
        'crafting_table 1',
        'furnace 1',
        'coal 4',
        'gold_ingot 4',
        'bread 16',
        'torch 32',
    ]),
    tower_battle: Object.freeze([
        'cobblestone 256',
        'oak_planks 128',
        'wooden_sword 1',
        'bread 16',
    ]),
    deepest_2_5: DEPTH_RACE_KIT,
    deepest_5: DEPTH_RACE_KIT,
});

function isDepthRaceGame(gameId) {
    return gameId === 'deepest_2_5' || gameId === 'deepest_5';
}

function assertPlayerName(name) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) {
        throw new Error(`Invalid Minecraft player name: ${name}`);
    }
}

export function getArenaJoinInfo() {
    return {
        sameServer: true,
        note: 'Contests use the same Minecraft server and world. Bots are teleported to a remote arena — not a different port.',
        arena: {
            id: 'simple-arena-v1',
            center: {
                x: ARENA.centerX,
                y: ARENA.floorY,
                z: ARENA.centerZ,
            },
            spectator: {
                x: ARENA.centerX,
                y: ARENA.spectatorY,
                z: ARENA.centerZ,
            },
            size: ARENA.halfSize * 2 + 1,
        },
        teleportCommand:
            `/tp @s ${ARENA.centerX} ${ARENA.spectatorY} ${ARENA.centerZ}`,
    };
}

/** Parse `rcon-cli list`, stripping scoreboard team suffixes like `bot [model]`. */
export function parseOnlinePlayers(listOutput) {
    const namesSection = String(listOutput).split(':').slice(1).join(':').trim();
    if (!namesSection) return [];
    const names = [];
    for (const match of namesSection.matchAll(/([A-Za-z0-9_]{1,16})(?:\s*\[[^\]]*\])?/g)) {
        names.push(match[1]);
    }
    return [...new Set(names)];
}

function fillLayers(commands, bounds, bottomY, topY, block, layerHeight = 6) {
    for (let y = bottomY; y <= topY; y += layerHeight) {
        const endY = Math.min(y + layerHeight - 1, topY);
        commands.push(
            `fill ${bounds.minX} ${y} ${bounds.minZ} `
            + `${bounds.maxX} ${endY} ${bounds.maxZ} ${block}`
        );
    }
}

function spawnPositions(participantCount) {
    const radius = Math.min(22, Math.max(8, participantCount * 3));
    return Array.from({ length: participantCount }, (_, index) => {
        const angle = (index / participantCount) * Math.PI * 2;
        return {
            x: Math.round(ARENA.centerX + Math.cos(angle) * radius),
            z: Math.round(ARENA.centerZ + Math.sin(angle) * radius),
        };
    });
}

function addDogForest(commands) {
    const treeOffsets = [
        [-27, -25], [-26, -8], [-25, 14], [-22, 27],
        [-14, -18], [-12, 4], [-10, 22],
        [0, -27], [2, -10], [4, 13], [1, 28],
        [13, -20], [15, 1], [12, 23],
        [25, -27], [27, -9], [24, 11], [27, 26],
    ];
    for (const [dx, dz] of treeOffsets) {
        const x = ARENA.centerX + dx;
        const z = ARENA.centerZ + dz;
        commands.push(
            `fill ${x - 2} ${ARENA.floorY + 3} ${z - 2} `
            + `${x + 2} ${ARENA.floorY + 5} ${z + 2} spruce_leaves`,
            `fill ${x} ${ARENA.floorY + 1} ${z} `
            + `${x} ${ARENA.floorY + 5} ${z} spruce_log`,
            `setblock ${x} ${ARENA.floorY + 6} ${z} spruce_leaves`
        );
    }

    const wolfOffsets = [
        [-28, -17], [-20, 19], [-8, -26], [-4, 17],
        [9, -14], [16, 27], [24, 6], [29, -24],
    ];
    for (const [dx, dz] of wolfOffsets) {
        commands.push(
            `summon wolf ${ARENA.centerX + dx} ${ARENA.floorY + 1} ${ARENA.centerZ + dz}`
        );
    }

    const skeletonOffsets = [
        [-30, -29], [-30, -13], [-29, 3], [-30, 20],
        [-22, -22], [-21, -4], [-20, 12], [-19, 29],
        [-11, -30], [-10, -15], [-9, 8], [-8, 25],
        [0, -21], [1, -3], [0, 20], [7, 30],
        [10, -29], [11, -11], [10, 6], [12, 24],
        [20, -20], [21, -2], [20, 15], [22, 29],
        [29, -29], [30, -12], [29, 5], [30, 22],
    ];
    for (const [dx, dz] of skeletonOffsets) {
        commands.push(
            `summon skeleton ${ARENA.centerX + dx} ${ARENA.floorY + 1} ${ARENA.centerZ + dz}`
        );
    }
}

function buildWorldResetCommands(gameId) {
    const minX = ARENA.centerX - ARENA.halfSize;
    const maxX = ARENA.centerX + ARENA.halfSize;
    const minZ = ARENA.centerZ - ARENA.halfSize;
    const maxZ = ARENA.centerZ + ARENA.halfSize;
    const bounds = { minX, maxX, minZ, maxZ };
    const commands = [
        `forceload add ${minX} ${minZ} ${maxX} ${maxZ}`,
        'gamerule doDaylightCycle false',
        'gamerule doWeatherCycle false',
        'gamerule keepInventory false',
        'gamerule doImmediateRespawn true',
        'gamerule doMobSpawning true',
        'difficulty normal',
        'time set noon',
        'weather clear',
    ];

    fillLayers(
        commands,
        bounds,
        ARENA.floorY + 1,
        ARENA.clearTopY,
        'air'
    );
    commands.push(
        `kill @e[type=!player,x=${minX},y=${ARENA.worldBottomY},z=${minZ},`
        + `dx=${maxX - minX},dy=${ARENA.clearTopY - ARENA.worldBottomY},`
        + `dz=${maxZ - minZ}]`
    );

    if (gameId === 'dog_race') {
        commands.push(
            'gamerule doMobSpawning false',
            'difficulty normal',
            'time set midnight'
        );
        commands.push(
            `fill ${minX} ${ARENA.floorY - 3} ${minZ} `
            + `${maxX} ${ARENA.floorY - 3} ${maxZ} bedrock`,
            `fill ${minX} ${ARENA.floorY - 2} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`
        );
        addDogForest(commands);
    } else if (isDepthRaceGame(gameId)) {
        commands.push(
            'gamerule doMobSpawning false',
            'difficulty peaceful'
        );
        fillLayers(
            commands,
            bounds,
            ARENA.worldBottomY,
            ARENA.depthBottomY - 1,
            'bedrock'
        );
        fillLayers(
            commands,
            bounds,
            ARENA.depthBottomY,
            -1,
            'deepslate'
        );
        fillLayers(
            commands,
            bounds,
            0,
            ARENA.floorY - 2,
            'stone'
        );
        commands.push(
            `fill ${minX} ${ARENA.floorY - 1} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`,
            `fill ${minX} ${ARENA.worldBottomY} ${minZ} `
            + `${minX} ${ARENA.floorY} ${maxZ} bedrock`,
            `fill ${maxX} ${ARENA.worldBottomY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} bedrock`,
            `fill ${minX} ${ARENA.worldBottomY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${minZ} bedrock`,
            `fill ${minX} ${ARENA.worldBottomY} ${maxZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} bedrock`
        );
    } else if (gameId === 'diamond_race') {
        fillLayers(
            commands,
            bounds,
            ARENA.mineBottomY,
            ARENA.floorY - 2,
            'stone'
        );
        commands.push(
            `fill ${minX} ${ARENA.floorY - 1} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`
        );

        const ores = [
            [-21, 78, -17], [-14, 72, 19], [-6, 83, 11],
            [3, 69, -24], [9, 76, 22], [16, 81, -8],
            [23, 70, 14], [27, 86, -20],
        ];
        for (const [dx, y, dz] of ores) {
            commands.push(
                `setblock ${ARENA.centerX + dx} ${y} `
                + `${ARENA.centerZ + dz} diamond_ore`
            );
        }
    } else if (gameId === 'netherite_race') {
        fillLayers(
            commands,
            bounds,
            ARENA.mineBottomY,
            82,
            'netherrack'
        );
        fillLayers(
            commands,
            bounds,
            83,
            ARENA.floorY - 2,
            'stone'
        );
        commands.push(
            `fill ${minX} ${ARENA.floorY - 1} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`
        );

        const diamondOres = [
            [-27, 90, -21], [-24, 85, -7], [-22, 94, 12], [-19, 87, 25],
            [-14, 92, -17], [-11, 84, 3], [-9, 96, 20], [-5, 89, -27],
            [-2, 86, -12], [1, 93, 8], [4, 84, 25], [7, 95, -20],
            [10, 88, -4], [13, 91, 16], [16, 85, 28], [19, 94, -11],
            [22, 87, 5], [25, 92, 22], [27, 84, -25], [29, 96, 1],
            [-28, 88, 27], [-16, 95, -29], [6, 90, 29], [24, 86, -30],
        ];
        for (const [dx, y, dz] of diamondOres) {
            commands.push(
                `setblock ${ARENA.centerX + dx} ${y} `
                + `${ARENA.centerZ + dz} diamond_ore`
            );
        }

        const ancientDebris = [
            [-29, 72, -24], [-27, 79, -9], [-25, 75, 8], [-23, 81, 24],
            [-20, 70, -16], [-18, 77, 1], [-16, 73, 18], [-13, 80, -28],
            [-11, 76, -11], [-9, 71, 7], [-7, 78, 26], [-4, 74, -21],
            [-2, 81, -5], [1, 72, 13], [3, 79, 29], [6, 75, -14],
            [8, 70, 4], [10, 77, 21], [13, 73, -26], [15, 80, -8],
            [17, 76, 10], [20, 71, 27], [22, 78, -19], [24, 74, -2],
            [26, 81, 15], [28, 72, -29], [30, 79, -12], [29, 75, 6],
            [-30, 70, 29], [-21, 78, 30], [5, 73, -30], [18, 80, 30],
        ];
        for (const [dx, y, dz] of ancientDebris) {
            commands.push(
                `setblock ${ARENA.centerX + dx} ${y} `
                + `${ARENA.centerZ + dz} ancient_debris`
            );
        }
    } else if (gameId === 'death_race') {
        commands.push(
            `fill ${minX} ${ARENA.floorY - 3} ${minZ} `
            + `${maxX} ${ARENA.floorY - 3} ${maxZ} bedrock`,
            `fill ${minX} ${ARENA.floorY - 2} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`,
            `fill ${ARENA.centerX - 4} ${ARENA.floorY} ${ARENA.centerZ - 4} `
            + `${ARENA.centerX + 4} ${ARENA.floorY} ${ARENA.centerZ + 4} lava`
        );
    } else {
        commands.push(
            `fill ${minX} ${ARENA.floorY - 3} ${minZ} `
            + `${maxX} ${ARENA.floorY - 3} ${maxZ} bedrock`,
            `fill ${minX} ${ARENA.floorY - 2} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`
        );
    }

    commands.push(
        `fill ${minX} ${ARENA.floorY + 1} ${minZ} `
        + `${minX} ${ARENA.clearTopY} ${maxZ} barrier`,
        `fill ${maxX} ${ARENA.floorY + 1} ${minZ} `
        + `${maxX} ${ARENA.clearTopY} ${maxZ} barrier`,
        `fill ${minX} ${ARENA.floorY + 1} ${minZ} `
        + `${maxX} ${ARENA.clearTopY} ${minZ} barrier`,
        `fill ${minX} ${ARENA.floorY + 1} ${maxZ} `
        + `${maxX} ${ARENA.clearTopY} ${maxZ} barrier`
    );

    return commands;
}

function buildParticipantCommands(gameId, participants) {
    const commands = [];
    const positions = spawnPositions(participants.length);
    participants.forEach((name, index) => {
        assertPlayerName(name);
        const position = positions[index];
        commands.push(
            `clear ${name}`,
            `effect clear ${name}`,
            `experience set ${name} 0 points`,
            `experience set ${name} 0 levels`,
            `gamemode survival ${name}`,
            `tp ${name} ${position.x} ${ARENA.floorY + 1} ${position.z}`,
            `spawnpoint ${name} ${position.x} ${ARENA.floorY + 1} ${position.z}`,
            `effect give ${name} saturation 2 10 true`
        );
        if (gameId === 'dog_race') {
            commands.push(buildDogRaceResetCommand(name));
        }
        for (const item of GAME_KITS[gameId] || []) {
            commands.push(`give ${name} ${item}`);
        }
    });
    return commands;
}

function buildResetCommands(gameId, participants) {
    return [
        ...buildWorldResetCommands(gameId),
        ...buildParticipantCommands(gameId, participants),
    ];
}

function spectatorWarpCommands(spectatorNames) {
    const join = getArenaJoinInfo();
    const { x, y, z } = join.arena.spectator;
    return spectatorNames.flatMap(name => {
        assertPlayerName(name);
        return [
            `gamemode spectator ${name}`,
            `tp ${name} ${x} ${y} ${z}`,
        ];
    });
}

export class ContestArenaManager {
    constructor(options = {}) {
        this.runCommand = options.runCommand || runMinecraftCommand;
        this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.playerWaitTimeoutMs = options.playerWaitTimeoutMs ?? 60_000;
        this.playerWaitPollMs = options.playerWaitPollMs ?? 500;
    }

    async listOnlinePlayers() {
        const output = await this.runCommand('list');
        return parseOnlinePlayers(output);
    }

    async waitForPlayersOnline(participants) {
        const needed = [...new Set(participants)];
        const deadline = Date.now() + this.playerWaitTimeoutMs;
        let missing = needed;
        while (Date.now() < deadline) {
            const online = new Set(await this.listOnlinePlayers());
            missing = needed.filter(name => !online.has(name));
            if (missing.length === 0) return;
            await this.sleep(this.playerWaitPollMs);
        }
        throw new Error(
            `Timed out waiting for Minecraft players before arena setup: ${missing.join(', ')}`
        );
    }

    async prepare(preset, participants, options = {}) {
        if (!preset?.id) throw new Error('Arena reset requires a game preset');
        if (!Array.isArray(participants) || participants.length === 0) {
            throw new Error('Arena reset requires at least one participant');
        }
        participants.forEach(assertPlayerName);

        const worldCommands = buildWorldResetCommands(preset.id);
        for (const command of worldCommands) {
            await this.runCommand(command);
        }

        // Player-targeted commands (/clear, /tp, /give) fail with
        // "No player was found" if bots dropped between MindServer ready and
        // RCON setup — wait on `list` so the error is clear and early.
        await this.waitForPlayersOnline(participants);

        const participantCommands = buildParticipantCommands(preset.id, participants);
        for (const command of participantCommands) {
            await this.runCommand(command);
        }

        const commands = [...worldCommands, ...participantCommands];
        const participantSet = new Set(participants);
        let spectators = Array.isArray(options.spectators)
            ? [...new Set(options.spectators)]
            : [];
        if (!Array.isArray(options.spectators)) {
            try {
                spectators = (await this.listOnlinePlayers())
                    .filter(name => !participantSet.has(name));
            } catch (error) {
                console.warn(`Could not list online players for spectator warp: ${error.message}`);
                spectators = [];
            }
        }

        const warpedSpectators = [];
        for (const command of spectatorWarpCommands(spectators)) {
            await this.runCommand(command);
        }
        warpedSpectators.push(...spectators);

        const join = getArenaJoinInfo();
        return {
            ...join.arena,
            resetCommandCount: commands.length,
            spectators: warpedSpectators,
            teleportCommand: join.teleportCommand,
            sameServer: true,
        };
    }

    async warpSpectators(participantIds = []) {
        const participantSet = new Set(participantIds);
        const spectators = (await this.listOnlinePlayers())
            .filter(name => !participantSet.has(name));
        for (const command of spectatorWarpCommands(spectators)) {
            await this.runCommand(command);
        }
        return {
            ...getArenaJoinInfo(),
            spectators,
        };
    }
}

export { buildResetCommands, buildWorldResetCommands, buildParticipantCommands, spectatorWarpCommands };
