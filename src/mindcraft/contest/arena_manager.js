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

const DOG_ARENA = Object.freeze({
    plainRadius: 15,
    wolfMinRadius: 22,
    moundExtent: 5,
    pondExtent: 4,
    treeExtent: 2,
});

const DOG_TREE_SPECIES = Object.freeze([
    Object.freeze({ log: 'oak_log', leaves: 'oak_leaves' }),
    Object.freeze({ log: 'birch_log', leaves: 'birch_leaves' }),
    Object.freeze({ log: 'spruce_log', leaves: 'spruce_leaves' }),
]);

const PODIUM_BLOCKS = Object.freeze([
    'gold_block',
    'iron_block',
    'copper_block',
]);
const PODIUM_WIDTH = 3;
const PODIUM_GAP = 1;

const DEPTH_RACE_KIT = Object.freeze([
    'diamond_pickaxe 1',
    'bread 16',
    'torch 64',
    'ladder 128',
]);

const GAME_KITS = Object.freeze({
    death_race: Object.freeze([]),
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

function flatFloorCommands({ minX, maxX, minZ, maxZ }) {
    return [
        `fill ${minX} ${ARENA.floorY - 3} ${minZ} `
        + `${maxX} ${ARENA.floorY - 3} ${maxZ} bedrock`,
        `fill ${minX} ${ARENA.floorY - 2} ${minZ} `
        + `${maxX} ${ARENA.floorY - 1} ${maxZ} dirt`,
        `fill ${minX} ${ARENA.floorY} ${minZ} `
        + `${maxX} ${ARENA.floorY} ${maxZ} grass_block`,
    ];
}

function spawnPositions(participantCount, maxRadius = 22) {
    const radius = Math.min(maxRadius, Math.max(8, participantCount * 3));
    return Array.from({ length: participantCount }, (_, index) => {
        const angle = (index / participantCount) * Math.PI * 2;
        return {
            x: Math.round(ARENA.centerX + Math.cos(angle) * radius),
            z: Math.round(ARENA.centerZ + Math.sin(angle) * radius),
        };
    });
}

/** Deterministic mulberry32 so a contest layout can be replayed from its seed. */
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function randomSeed() {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

function randomInt(random, min, max) {
    return min + Math.floor(random() * (max - min + 1));
}

function randomPick(random, values) {
    return values[Math.floor(random() * values.length)];
}

/** Shortest distance from the arena center to a feature's square footprint. */
function footprintClearance(dx, dz, extent) {
    return Math.hypot(
        Math.max(0, Math.abs(dx) - extent),
        Math.max(0, Math.abs(dz) - extent)
    );
}

/**
 * Scatters feature positions around the spawn plain: everything lands in the
 * ring outside `plainRadius`, inside the barrier walls, and clear of features
 * already placed.
 */
function createScatter(random, plainRadius) {
    const taken = [];
    const limit = ARENA.halfSize - 1;
    return function scatter(count, { extent, spacing, minRadius = plainRadius }) {
        const spots = [];
        const outerRadius = limit - extent;
        for (let attempt = 0; spots.length < count && attempt < count * 60; attempt += 1) {
            const angle = random() * Math.PI * 2;
            const radius = minRadius + random() * (outerRadius - minRadius);
            const dx = Math.round(Math.cos(angle) * radius);
            const dz = Math.round(Math.sin(angle) * radius);
            if (footprintClearance(dx, dz, extent) <= plainRadius) continue;
            if (Math.abs(dx) + extent > limit || Math.abs(dz) + extent > limit) continue;
            if (taken.some(spot => Math.hypot(spot.dx - dx, spot.dz - dz) < spacing)) continue;
            taken.push({ dx, dz });
            spots.push({ dx, dz });
        }
        return spots;
    };
}

function addDogWilderness(commands, random) {
    const { plainRadius, moundExtent, pondExtent, treeExtent, wolfMinRadius } = DOG_ARENA;
    const scatter = createScatter(random, plainRadius);

    // Wolves claim their rim spots first so terrain never crowds them out.
    const wolfSpots = scatter(randomInt(random, 3, 5), {
        extent: 1,
        spacing: 6,
        minRadius: wolfMinRadius,
    });

    for (const { dx, dz } of scatter(randomInt(random, 5, 9), { extent: moundExtent, spacing: 8 })) {
        const x = ARENA.centerX + dx;
        const z = ARENA.centerZ + dz;
        const height = randomInt(random, 1, 4);
        const baseRadius = randomInt(random, 2, moundExtent);
        for (let layer = 1; layer <= height; layer += 1) {
            const radius = Math.max(1, baseRadius - (layer - 1));
            const block = layer === height ? 'grass_block' : 'dirt';
            commands.push(
                `fill ${x - radius} ${ARENA.floorY + layer} ${z - radius} `
                + `${x + radius} ${ARENA.floorY + layer} ${z + radius} ${block}`
            );
        }
    }

    for (const { dx, dz } of scatter(randomInt(random, 2, 4), { extent: pondExtent, spacing: 9 })) {
        const x = ARENA.centerX + dx;
        const z = ARENA.centerZ + dz;
        const radius = randomInt(random, 2, pondExtent);
        const depth = randomInt(random, 1, 2);
        commands.push(
            `fill ${x - radius} ${ARENA.floorY - depth} ${z - radius} `
            + `${x + radius} ${ARENA.floorY} ${z + radius} water`
        );
    }

    for (const { dx, dz } of scatter(randomInt(random, 12, 20), { extent: treeExtent, spacing: 4 })) {
        const x = ARENA.centerX + dx;
        const z = ARENA.centerZ + dz;
        const { log, leaves } = randomPick(random, DOG_TREE_SPECIES);
        const top = ARENA.floorY + randomInt(random, 4, 7);
        commands.push(
            `fill ${x - 2} ${top - 2} ${z - 2} ${x + 2} ${top - 1} ${z + 2} ${leaves}`,
            `fill ${x - 1} ${top} ${z - 1} ${x + 1} ${top} ${z + 1} ${leaves}`,
            `fill ${x} ${ARENA.floorY + 1} ${z} ${x} ${top} ${z} ${log}`,
            `setblock ${x} ${top + 1} ${z} ${leaves}`
        );
    }

    for (const { dx, dz } of scatter(randomInt(random, 5, 9), { extent: 1, spacing: 4 })) {
        commands.push(
            `summon skeleton ${ARENA.centerX + dx} ${ARENA.floorY + 1} ${ARENA.centerZ + dz}`
        );
    }

    for (const { dx, dz } of wolfSpots) {
        commands.push(
            `summon wolf ${ARENA.centerX + dx} ${ARENA.floorY + 1} ${ARENA.centerZ + dz}`
        );
    }
}

function buildWorldResetCommands(gameId, options = {}) {
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
            // Summoned skeletons would burn away at noon, taking the bone hunt with them.
            'time set midnight',
            ...flatFloorCommands(bounds)
        );
        addDogWilderness(commands, createRandom(options.seed ?? randomSeed()));
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
        // Nothing but the plain itself: every death has to be improvised.
        commands.push(
            'gamerule doMobSpawning false',
            'difficulty normal',
            ...flatFloorCommands(bounds)
        );
    } else {
        commands.push(...flatFloorCommands(bounds));
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
    // Dog racers must all start on the bare plain, inside the wilderness ring.
    const positions = spawnPositions(
        participants.length,
        gameId === 'dog_race' ? DOG_ARENA.plainRadius - 3 : undefined
    );
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
        if (gameId === 'death_race') {
            commands.push(`effect give ${name} weakness infinite 255 true`);
        }
        for (const item of GAME_KITS[gameId] || []) {
            commands.push(`give ${name} ${item}`);
        }
    });
    return commands;
}

function buildResetCommands(gameId, participants, options = {}) {
    return [
        ...buildWorldResetCommands(gameId, options),
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

function podiumXOffset(index) {
    if (index === 0) return 0;
    const distance = Math.ceil(index / 2) * (PODIUM_WIDTH + PODIUM_GAP);
    return index % 2 === 1 ? -distance : distance;
}

function orderedContestResults(contest) {
    const participantIds = Array.isArray(contest?.participantIds)
        ? contest.participantIds
        : [];
    const participantSet = new Set(participantIds);
    const seen = new Set();
    const results = [];

    for (const result of contest?.results || []) {
        if (!participantSet.has(result?.participantId) || seen.has(result.participantId)) {
            continue;
        }
        seen.add(result.participantId);
        results.push(result);
    }
    for (const participantId of participantIds) {
        if (!seen.has(participantId)) {
            results.push({ participantId, rank: null });
        }
    }
    return results;
}

export function buildPodiumCeremonyCommands(contest) {
    if (contest?.status !== 'completed' || !contest.winnerIds?.length) return [];

    const results = orderedContestResults(contest);
    if (results.length === 0) return [];
    results.forEach(result => assertPlayerName(result.participantId));

    const podiums = results.map((result, index) => {
        const rank = Number.isInteger(result.rank) && result.rank > 0
            ? result.rank
            : index + 1;
        return {
            name: result.participantId,
            rank,
            height: Math.max(1, results.length - rank + 1),
            x: ARENA.centerX + podiumXOffset(index),
        };
    });
    const minX = Math.min(...podiums.map(podium => podium.x - 1));
    const maxX = Math.max(...podiums.map(podium => podium.x + 1));
    const minZ = ARENA.centerZ - 1;
    const maxZ = ARENA.centerZ + 1;
    const commands = [
        `fill ${minX} ${ARENA.floorY + 1} ${minZ} `
        + `${maxX} ${ARENA.clearTopY} ${maxZ} air`,
    ];

    for (const podium of podiums) {
        const block = PODIUM_BLOCKS[podium.rank - 1] || 'polished_andesite';
        commands.push(
            `fill ${podium.x - 1} ${ARENA.floorY + 1} ${minZ} `
            + `${podium.x + 1} ${ARENA.floorY + podium.height} ${maxZ} ${block}`,
            `effect clear ${podium.name}`,
            `gamemode adventure ${podium.name}`,
            `tp ${podium.name} ${podium.x} `
            + `${ARENA.floorY + podium.height + 1} ${ARENA.centerZ} 0 0`,
            `spawnpoint ${podium.name} ${podium.x} `
            + `${ARENA.floorY + podium.height + 1} ${ARENA.centerZ}`
        );
    }
    return commands;
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

        const seed = options.seed ?? randomSeed();
        const worldCommands = buildWorldResetCommands(preset.id, { seed });
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
            seed,
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

    async presentResults(contest) {
        const commands = buildPodiumCeremonyCommands(contest);
        for (const command of commands) {
            await this.runCommand(command);
        }
        return {
            presented: commands.length > 0,
            commandCount: commands.length,
        };
    }
}

export { buildResetCommands, buildWorldResetCommands, buildParticipantCommands, spectatorWarpCommands };
