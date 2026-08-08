import { runMinecraftCommand } from '../minecraft_server.js';
import { modelInfo } from '../skins.js';
import { buildDogRaceResetCommand } from './dog_race.js';
import { diffAgainstKit, parseInventory } from './inventory_audit.js';

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

// One redstone pulse into a row of command blocks runs every teleport on the
// same server tick, so the whole cast lands together instead of popping in one
// at a time as separate RCON calls trickle through. The rig is parked just
// above bedrock — below the depth-race floor, so no game's world rebuild lands
// on it — and inside the force-loaded arena footprint so its chunks are always
// ticking. It is torn back down the moment it fires.
const TELEPORT_RIG = Object.freeze({
    startX: ARENA.centerX - ARENA.halfSize + 1,
    y: ARENA.worldBottomY + 2,
    z: ARENA.centerZ,
});

const DOG_ARENA = Object.freeze({
    plainRadius: 15,
    wolfMinRadius: 22,
    moundExtent: 5,
    pondExtent: 4,
    treeExtent: 2,
});

const CAKE_FARM_STATIONS = Object.freeze([
    Object.freeze({ dx: 0, dz: -23 }),
    Object.freeze({ dx: 16, dz: -16 }),
    Object.freeze({ dx: 23, dz: 0 }),
    Object.freeze({ dx: 16, dz: 16 }),
    Object.freeze({ dx: 0, dz: 23 }),
    Object.freeze({ dx: -16, dz: 16 }),
    Object.freeze({ dx: -23, dz: 0 }),
    Object.freeze({ dx: -16, dz: -16 }),
]);

const DIAMOND_RACE_ORES = Object.freeze([
    [-21, 78, -17], [-14, 72, 19], [-6, 83, 11], [3, 69, -24],
    [9, 76, 22], [16, 81, -8], [23, 70, 14], [27, 86, -20],
]);

const NETHERITE_RACE_DIAMOND_ORES = Object.freeze([
    [-27, 90, -21], [-24, 85, -7], [-22, 94, 12], [-19, 87, 25],
    [-14, 92, -17], [-11, 84, 3], [-9, 96, 20], [-5, 89, -27],
    [-2, 86, -12], [1, 93, 8], [4, 84, 25], [7, 95, -20],
    [10, 88, -4], [13, 91, 16], [16, 85, 28], [19, 94, -11],
    [22, 87, 5], [25, 92, 22], [27, 84, -25], [29, 96, 1],
    [-28, 88, 27], [-16, 95, -29], [6, 90, 29], [24, 86, -30],
]);

const NETHERITE_RACE_ANCIENT_DEBRIS = Object.freeze([
    [-29, 72, -24], [-27, 79, -9], [-25, 75, 8], [-23, 81, 24],
    [-20, 70, -16], [-18, 77, 1], [-16, 73, 18], [-13, 80, -28],
    [-11, 76, -11], [-9, 71, 7], [-7, 78, 26], [-4, 74, -21],
    [-2, 81, -5], [1, 72, 13], [3, 79, 29], [6, 75, -14],
    [8, 70, 4], [10, 77, 21], [13, 73, -26], [15, 80, -8],
    [17, 76, 10], [20, 71, 27], [22, 78, -19], [24, 74, -2],
    [26, 81, 15], [28, 72, -29], [30, 79, -12], [29, 75, 6],
    [-30, 70, 29], [-21, 78, 30], [5, 73, -30], [18, 80, 30],
]);

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
// How often the world rebuild reports in. Every command would flood the launch
// log for no extra insight.
const PROGRESS_COMMAND_INTERVAL = 25;

// Every game stands its cast on the block directly above the arena floor. In
// Spleef that layer is the snow platform and everything below it is the pit, so
// "did the teleport land?" and "is this bot still in the game?" are the same
// question.
const TOP_LAYER_Y = ARENA.floorY + 1;

const DEPTH_RACE_KIT = Object.freeze([
    'diamond_pickaxe 1',
    'bread 16',
    'torch 64',
    'ladder 128',
]);

export function buildSurvivorEliminationCommands(playerId) {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(playerId)) {
        throw new Error(`Invalid Minecraft player name: ${playerId}`);
    }
    return [
        `gamemode spectator ${playerId}`,
        `tellraw @a ${JSON.stringify({
            text: `${playerId}, the tribe has spoken.`,
            color: 'gold',
            bold: true,
        })}`,
    ];
}

const GAME_KITS = Object.freeze({
    cake_race: Object.freeze([
        'bucket 3',
        'crafting_table 1',
        'bread 16',
    ]),
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
    team_tower_battle: Object.freeze([
        'cobblestone 256',
        'oak_planks 128',
        'iron_sword 1',
        'iron_pickaxe 1',
        'bread 16',
    ]),
    team_base_siege: Object.freeze([
        'cobblestone 128',
        'oak_planks 64',
        'dirt 64',
        'iron_sword 1',
        'shield 1',
        'bow 1',
        'arrow 32',
        'bread 16',
        'golden_apple 2',
    ]),
    spleef: Object.freeze([
        'diamond_shovel 1',
        'bread 16',
    ]),
    deepest_2_5: DEPTH_RACE_KIT,
    deepest_5: DEPTH_RACE_KIT,
});

function isTeamArenaGame(gameId) {
    return gameId === 'cake_race'
        || gameId === 'team_tower_battle'
        || gameId === 'team_base_siege';
}

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
            halfSize: ARENA.halfSize,
        },
        teleportCommand:
            `/tp @s ${ARENA.centerX} ${ARENA.spectatorY} ${ARENA.centerZ}`,
    };
}

function absoluteLandmarks(label, offsets) {
    return offsets.map(([dx, y, dz], index) => ({
        label: `${label} ${index + 1}`,
        position: { x: ARENA.centerX + dx, y, z: ARENA.centerZ + dz },
    }));
}

export function getArenaWorldKnowledge(gameId, options = {}) {
    const halfSize = Number.isFinite(options.halfSize)
        ? Math.max(4, Math.min(ARENA.halfSize, Math.floor(options.halfSize)))
        : ARENA.halfSize;
    const knowledge = {
        gameId: gameId || null,
        arena: {
            center: { x: ARENA.centerX, y: ARENA.floorY, z: ARENA.centerZ },
            floorY: ARENA.floorY,
            bounds: {
                minX: ARENA.centerX - halfSize,
                maxX: ARENA.centerX + halfSize,
                minZ: ARENA.centerZ - halfSize,
                maxZ: ARENA.centerZ + halfSize,
            },
        },
        landmarks: [],
        zones: [],
    };
    if (gameId === 'cake_race') {
        knowledge.landmarks = CAKE_FARM_STATIONS.map(({ dx, dz }, index) => ({
            label: `Cake resource station ${index + 1} (wheat, sugar cane, cow, chicken)`,
            position: { x: ARENA.centerX + dx, y: ARENA.floorY + 1, z: ARENA.centerZ + dz },
        }));
    } else if (gameId === 'diamond_race') {
        knowledge.landmarks = absoluteLandmarks('Diamond ore', DIAMOND_RACE_ORES);
    } else if (gameId === 'netherite_race') {
        knowledge.landmarks = [
            ...absoluteLandmarks('Diamond ore', NETHERITE_RACE_DIAMOND_ORES),
            ...absoluteLandmarks('Ancient debris', NETHERITE_RACE_ANCIENT_DEBRIS),
        ];
    } else if (gameId === 'dog_race') {
        knowledge.zones = [
            {
                label: 'Spawn plain',
                description: `within ${DOG_ARENA.plainRadius} blocks of the arena center`,
            },
            {
                label: 'Wolf and bone wilderness',
                description: `server-generated outside radius ${DOG_ARENA.plainRadius}; wolves begin beyond radius ${DOG_ARENA.wolfMinRadius}`,
            },
        ];
    } else if (isDepthRaceGame(gameId)) {
        knowledge.zones = [{
            label: 'Depth race mine',
            description: `solid stone/deepslate from y ${ARENA.floorY - 2} down to y ${ARENA.depthBottomY}, with bedrock below`,
        }];
    } else if (gameId === 'spleef') {
        knowledge.zones = [{
            label: 'Spleef floor',
            description: `snow blocks at y ${ARENA.floorY}; water from y ${ARENA.floorY - 7} through ${ARENA.floorY - 1}`,
        }];
    }
    return knowledge;
}

/**
 * Slam barrier walls inward so campers cannot hide at the far edges.
 * Outer blocks stay; the new walls simply cut the playable footprint.
 */
export function buildArenaShrinkCommands(halfSize = ARENA.halfSize) {
    const clamped = Math.max(4, Math.min(ARENA.halfSize, Math.floor(halfSize)));
    const minX = ARENA.centerX - clamped;
    const maxX = ARENA.centerX + clamped;
    const minZ = ARENA.centerZ - clamped;
    const maxZ = ARENA.centerZ + clamped;
    return [
        `fill ${minX} ${ARENA.floorY + 1} ${minZ} `
        + `${minX} ${ARENA.clearTopY} ${maxZ} barrier`,
        `fill ${maxX} ${ARENA.floorY + 1} ${minZ} `
        + `${maxX} ${ARENA.clearTopY} ${maxZ} barrier`,
        `fill ${minX} ${ARENA.floorY + 1} ${minZ} `
        + `${maxX} ${ARENA.clearTopY} ${minZ} barrier`,
        `fill ${minX} ${ARENA.floorY + 1} ${maxZ} `
        + `${maxX} ${ARENA.clearTopY} ${maxZ} barrier`,
    ];
}

export function buildPressureRoundCommands({
    survivors = [],
    teamNames = [],
    teamByParticipant = {},
    halfSize = ARENA.halfSize,
    kit = GAME_KITS.team_base_siege,
} = {}) {
    const commands = [...buildArenaShrinkCommands(halfSize)];
    const positions = teamSpawnPositions(survivors, teamNames, teamByParticipant, halfSize);
    for (const name of survivors) {
        assertPlayerName(name);
        const position = positions.get(name) || {
            x: ARENA.centerX,
            z: ARENA.centerZ,
        };
        commands.push(
            `clear ${name}`,
            `effect clear ${name}`,
            `gamemode survival ${name}`,
            `tp ${name} ${position.x} ${ARENA.floorY + 1} ${position.z}`,
            `spawnpoint ${name} ${position.x} ${ARENA.floorY + 1} ${position.z}`,
            `effect give ${name} saturation 2 10 true`,
            `effect give ${name} instant_health 1 1 true`
        );
        for (const item of kit || []) {
            commands.push(`give ${name} ${item}`);
        }
    }
    return commands;
}

/**
 * Parse `rcon-cli list`, stripping scoreboard team decorations like
 * `bot [Team] [model]`. `list` prints display names, so every bracketed
 * prefix and suffix we attach to a nametag comes back with the name; an entry
 * that still has loose text after the brackets are removed is not a name we
 * can target safely, so it is dropped rather than guessed at.
 */
export function parseOnlinePlayers(listOutput) {
    const namesSection = String(listOutput).split(':').slice(1).join(':').trim();
    if (!namesSection) return [];
    const names = [];
    for (const entry of namesSection.split(',')) {
        const name = entry.replace(/\[[^\]]*\]/g, ' ').trim();
        if (/^[A-Za-z0-9_]{1,16}$/.test(name)) names.push(name);
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

function spawnPositions(participantCount, maxRadius = 22, minRadius = 8) {
    const radius = Math.min(maxRadius, Math.max(minRadius, participantCount * 3));
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

function addCakeFarm(commands) {
    for (const { dx, dz } of CAKE_FARM_STATIONS) {
        const x = ARENA.centerX + dx;
        const z = ARENA.centerZ + dz;
        commands.push(
            `setblock ${x} ${ARENA.floorY} ${z} water`,
            `fill ${x + 1} ${ARENA.floorY + 1} ${z} `
            + `${x + 1} ${ARENA.floorY + 2} ${z} sugar_cane`,
            `fill ${x - 1} ${ARENA.floorY + 1} ${z} `
            + `${x - 1} ${ARENA.floorY + 2} ${z} sugar_cane`,
            `fill ${x} ${ARENA.floorY + 1} ${z + 1} `
            + `${x} ${ARENA.floorY + 2} ${z + 1} sugar_cane`,
            `fill ${x - 2} ${ARENA.floorY} ${z + 2} `
            + `${x + 2} ${ARENA.floorY} ${z + 4} farmland`,
            `fill ${x - 2} ${ARENA.floorY + 1} ${z + 2} `
            + `${x + 2} ${ARENA.floorY + 1} ${z + 4} wheat[age=7]`,
            `summon cow ${x - 1} ${ARENA.floorY + 1} ${z - 3}`,
            `summon chicken ${x + 1} ${ARENA.floorY + 1} ${z - 3} {EggLayTime:100}`
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
    if (gameId === 'team_tower_battle') {
        commands.push('gamerule keepInventory true');
    }

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

    if (gameId === 'cake_race') {
        commands.push(
            'gamerule doMobSpawning false',
            'difficulty peaceful',
            ...flatFloorCommands(bounds)
        );
        addCakeFarm(commands);
    } else if (gameId === 'dog_race') {
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

        for (const [dx, y, dz] of DIAMOND_RACE_ORES) {
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

        for (const [dx, y, dz] of NETHERITE_RACE_DIAMOND_ORES) {
            commands.push(
                `setblock ${ARENA.centerX + dx} ${y} `
                + `${ARENA.centerZ + dz} diamond_ore`
            );
        }

        for (const [dx, y, dz] of NETHERITE_RACE_ANCIENT_DEBRIS) {
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
    } else if (gameId === 'spleef') {
        const pitBottomY = ARENA.floorY - 8;
        commands.push(
            'gamerule doMobSpawning false',
            'difficulty peaceful',
            `fill ${minX} ${pitBottomY} ${minZ} `
            + `${maxX} ${pitBottomY} ${maxZ} bedrock`,
            `fill ${minX} ${pitBottomY + 1} ${minZ} `
            + `${maxX} ${ARENA.floorY - 1} ${maxZ} water`
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
    if (gameId === 'spleef') {
        // Repair every hole as the final world-build operation. Participant
        // setup and the synchronized starting teleport happen only after this
        // command completes, so every round begins on a pristine platform.
        commands.push(
            `fill ${minX} ${ARENA.floorY} ${minZ} `
            + `${maxX} ${ARENA.floorY} ${maxZ} snow_block`
        );
    }

    return commands;
}

function teamSpawnPositions(participants, teamNames, teamByParticipant, halfSize = ARENA.halfSize) {
    const positions = new Map();
    const sharedBaseOffsets = [
        { x: 0, z: 0 },
        { x: 0, z: 1 },
        { x: 0, z: -1 },
        { x: 1, z: 0 },
        { x: -1, z: 0 },
        { x: 1, z: 1 },
        { x: -1, z: -1 },
        { x: 1, z: -1 },
        { x: -1, z: 1 },
    ];
    const playableHalf = Number.isFinite(halfSize) ? halfSize : ARENA.halfSize;
    const sideOffset = Math.max(3, Math.min(18, playableHalf - 6));
    teamNames.forEach((teamName, teamIndex) => {
        const members = participants.filter(name => teamByParticipant[name] === teamName);
        members.forEach((name, index) => {
            const offset = sharedBaseOffsets[index % sharedBaseOffsets.length];
            positions.set(name, {
                x: ARENA.centerX + (teamIndex === 0 ? -sideOffset : sideOffset) + offset.x,
                z: ARENA.centerZ + offset.z,
            });
        });
    });
    return positions;
}

// A nametag suffix belongs to a scoreboard team, not to a player, and joining
// a contest team drops a bot from the `model_*` team that spells out its model.
// So each side gets one team per model: bots that share a model share a team
// (keeping friendly fire off between them) and every nametag still ends in
// "[Team] [model]". Sides whose bots all run one model collapse to one team.
const contestTeamIds = new Set(['mcgame_1', 'mcgame_2']);

function contestTeamModel(model) {
    if (!model) return null;
    const info = modelInfo(model);
    const slug = info.label.replace(/[^A-Za-z0-9]/g, '').toLowerCase().slice(0, 24);
    return slug ? { slug, label: info.label, color: info.mcColor } : null;
}

function contestTeamSuffix(teamName, color, model) {
    const suffix = { text: ` [${teamName}]`, color };
    if (model) suffix.extra = [{ text: ` [${model.label}]`, color: model.color }];
    return suffix;
}

function groupSideByModel(participants, teamName, teamByParticipant, modelByParticipant) {
    const groups = new Map();
    participants
        .filter(name => teamByParticipant[name] === teamName)
        .forEach(name => {
            assertPlayerName(name);
            const model = contestTeamModel(modelByParticipant[name]);
            const key = model?.slug ?? '';
            if (!groups.has(key)) groups.set(key, { model, members: [] });
            groups.get(key).members.push(name);
        });
    // An empty side still gets its team so the match has both colors defined.
    if (groups.size === 0) groups.set('', { model: null, members: [] });
    return groups;
}

export function buildContestTeamCommands(participants, options = {}) {
    const teamNames = Array.isArray(options.teamNames) ? options.teamNames : [];
    const teamByParticipant = options.teamByParticipant || {};
    const modelByParticipant = options.modelByParticipant || {};
    if (teamNames.length !== 2) return [];
    const colors = ['red', 'blue'];
    // Teams left over from earlier matches would keep coloring the nametags of
    // bots that are not playing this one.
    const commands = [...contestTeamIds].map(teamId => `team remove ${teamId}`);
    contestTeamIds.clear();
    teamNames.forEach((teamName, index) => {
        const color = colors[index];
        const groups = groupSideByModel(
            participants,
            teamName,
            teamByParticipant,
            modelByParticipant
        );
        for (const [slug, group] of groups) {
            const teamId = slug ? `mcgame_${index + 1}_${slug}` : `mcgame_${index + 1}`;
            contestTeamIds.add(teamId);
            commands.push(
                `team remove ${teamId}`,
                `team add ${teamId}`,
                `team modify ${teamId} color ${color}`,
                `team modify ${teamId} friendlyFire false`,
                `team modify ${teamId} collisionRule pushOtherTeams`,
                `team modify ${teamId} suffix `
                + JSON.stringify(contestTeamSuffix(teamName, color, group.model))
            );
            for (const name of group.members) {
                commands.push(`team join ${teamId} ${name}`);
            }
        }
    });
    return commands;
}

/**
 * The exact block each participant is sent to at the opening bell, keyed by
 * name. The starting teleport and the placement audit that checks it both read
 * from here, so a bot can never be graded against a spot it was never sent to.
 */
export function participantSpawnPositions(gameId, participants, options = {}) {
    // Dog racers start inside the wilderness ring. Spleef players always use
    // a wide circle, even with a small cast, so nobody begins clustered at the
    // center of the freshly repaired platform.
    const spawnRadius = gameId === 'dog_race'
        ? DOG_ARENA.plainRadius - 3
        : gameId === 'spleef'
            ? ARENA.halfSize - 8
            : undefined;
    const positions = spawnPositions(
        participants.length,
        spawnRadius,
        gameId === 'spleef' ? spawnRadius : undefined
    );
    const teamPositions = isTeamArenaGame(gameId)
        ? teamSpawnPositions(participants, options.teamNames || [], options.teamByParticipant || {}, options.halfSize)
        : null;
    const assigned = new Map();
    participants.forEach((name, index) => {
        assertPlayerName(name);
        const position = teamPositions?.get(name) || positions[index];
        assigned.set(name, { x: position.x, y: TOP_LAYER_Y, z: position.z });
    });
    return assigned;
}

function buildParticipantCommands(gameId, participants, options = {}) {
    const commands = [];
    const positions = participantSpawnPositions(gameId, participants, options);
    participants.forEach(name => {
        const position = positions.get(name);
        commands.push(
            `clear ${name}`,
            `effect clear ${name}`,
            `experience set ${name} 0 points`,
            `experience set ${name} 0 levels`,
            `gamemode survival ${name}`,
            `tp ${name} ${position.x} ${position.y} ${position.z}`,
            `spawnpoint ${name} ${position.x} ${position.y} ${position.z}`,
            `effect give ${name} saturation 2 10 true`
        );
        if (gameId === 'dog_race') {
            commands.push(buildDogRaceResetCommand(name));
        }
        if (gameId === 'death_race') {
            commands.push(`effect give ${name} weakness infinite 255 true`);
        }
        if (gameId === 'spleef') {
            commands.push(`effect give ${name} weakness infinite 255 true`);
        }
        for (const item of GAME_KITS[gameId] || []) {
            commands.push(`give ${name} ${item}`);
        }
    });
    return commands;
}

function buildKitRepairCommands(gameId, name) {
    const commands = [`clear ${name}`];
    for (const item of GAME_KITS[gameId] || []) {
        commands.push(`give ${name} ${item}`);
    }
    return commands;
}

/**
 * Prove — and, if needed, repair — that every contestant starts with exactly the
 * game's kit and nothing carried over from a previous match. Reads each bot's
 * inventory over RCON, diffs it against `GAME_KITS[gameId]`, and on any surplus
 * or shortfall re-clears and re-gives the kit once before re-reading. Returns one
 * audit per participant so the launch can journal a permanent record that the
 * field was even.
 */
export async function verifyParticipantInventories(runCommand, gameId, participants, options = {}) {
    const run = runCommand || runMinecraftCommand;
    const kit = GAME_KITS[gameId] || [];
    const allowRepair = options.repair !== false;
    const audits = [];
    for (const name of participants) {
        assertPlayerName(name);
        let actual = parseInventory(await run(`data get entity ${name} Inventory`));
        let diff = diffAgainstKit(actual, kit);
        let repaired = false;
        if (!diff.matches && allowRepair) {
            for (const command of buildKitRepairCommands(gameId, name)) {
                await run(command);
            }
            repaired = true;
            actual = parseInventory(await run(`data get entity ${name} Inventory`));
            diff = diffAgainstKit(actual, kit);
        }
        audits.push({
            participantId: name,
            expected: diff.expected,
            actual: diff.actual,
            matches: diff.matches,
            extras: diff.extras,
            missing: diff.missing,
            repaired,
        });
    }
    return audits;
}

/**
 * A bot standing on the arena floor rests at exactly `TOP_LAYER_Y`. Allow a hair
 * of downward physics jitter and the block of headroom above, so a bot caught
 * mid-step still reads as standing while anything that fell into the Spleef pit
 * or never left its login spot does not.
 */
function onTopLayer(position) {
    if (!position) return false;
    return position.y >= TOP_LAYER_Y - 0.1 && position.y < TOP_LAYER_Y + 1;
}

/**
 * Prove — and, if needed, repair — that every contestant is standing on the
 * arena's top layer before the opening bell. The starting teleport fires through
 * a command-block rig that is torn down on the same tick, so a dropped link in
 * that chain leaves a bot wherever it logged in with nothing to report it. In
 * Spleef that is the difference between starting on the snow and starting in the
 * water pit, which is an instant elimination. Reads every position back over
 * RCON, re-teleports anyone off the floor once, and re-reads. Returns one audit
 * per participant so a launch can journal that the whole cast started level.
 */
export async function verifyParticipantPlacement(runCommand, gameId, participants, options = {}) {
    const run = runCommand || runMinecraftCommand;
    const allowRepair = options.repair !== false;
    const assigned = participantSpawnPositions(gameId, participants, options);
    const audits = [];
    for (const name of participants) {
        assertPlayerName(name);
        const expected = assigned.get(name);
        let actual = parsePlayerPosition(await run(`data get entity ${name} Pos`));
        let repaired = false;
        if (!onTopLayer(actual) && allowRepair) {
            await run(`tp ${name} ${expected.x} ${expected.y} ${expected.z}`);
            repaired = true;
            actual = parsePlayerPosition(await run(`data get entity ${name} Pos`));
        }
        audits.push({
            participantId: name,
            expected,
            actual,
            onTopLayer: onTopLayer(actual),
            repaired,
        });
    }
    return audits;
}

/**
 * Split a participant command list into the setup work (clear/give/effect/
 * spawnpoint) and the `tp` lines, so the teleports can be fired together on a
 * single tick while everything else still runs in order.
 */
export function partitionTeleportCommands(commands = []) {
    const setup = [];
    const teleports = [];
    for (const command of commands) {
        if (typeof command === 'string' && command.startsWith('tp ')) {
            teleports.push(command);
        } else {
            setup.push(command);
        }
    }
    return { setup, teleports };
}

/**
 * Turn a batch of `tp` commands into a chain-command-block rig: one impulse
 * block that waits for redstone, then one always-active chain block per
 * remaining teleport. A single redstone pulse under the impulse cascades the
 * whole chain in the same tick, so every bot moves simultaneously no matter how
 * many separate RCON round-trips it took to build the rig. The rig is then torn
 * down. Returns the ordered RCON commands to build, fire, and clear it.
 */
export function buildSimultaneousTeleportCommands(teleportCommands = []) {
    const teleports = teleportCommands.filter(
        command => typeof command === 'string' && command.length > 0
    );
    if (teleports.length === 0) return [];

    const { startX, y, z } = TELEPORT_RIG;
    const endX = startX + teleports.length - 1;
    const triggerY = y - 1;
    const commands = [
        // Wipe any leftover rig (and the block the trigger sits in) before rebuilding.
        `fill ${startX} ${triggerY} ${z} ${endX} ${y} ${z} air`,
    ];
    teleports.forEach((teleport, index) => {
        const block = index === 0 ? 'command_block' : 'chain_command_block';
        // The impulse waits for redstone (auto:0b); chain blocks fire whenever
        // the block pointing into them runs (auto:1b), all in one tick.
        const auto = index === 0 ? '0b' : '1b';
        commands.push(
            `setblock ${startX + index} ${y} ${z} `
            + `${block}[facing=east]{Command:${JSON.stringify(teleport)},auto:${auto}}`
        );
    });
    commands.push(
        // Rising edge under the impulse fires the whole chain on this tick.
        `setblock ${startX} ${triggerY} ${z} redstone_block`,
        // Teleports have landed — pull the rig so it never shows in play or
        // stacks up between rounds.
        `setblock ${startX} ${triggerY} ${z} air`,
        `fill ${startX} ${y} ${z} ${endX} ${y} ${z} air`
    );
    return commands;
}

function buildResetCommands(gameId, participants, options = {}) {
    return [
        ...buildWorldResetCommands(gameId, options),
        ...buildParticipantCommands(gameId, participants, options),
        ...buildContestTeamCommands(participants, options),
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

function finitePosition(position) {
    if (!position || typeof position !== 'object') return null;
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

export function parsePlayerPosition(response) {
    const number = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?`;
    const match = String(response || '').match(
        new RegExp(
            `\\[\\s*(${number})[dDfF]?\\s*,\\s*(${number})[dDfF]?\\s*,\\s*`
            + `(${number})[dDfF]?\\s*\\]`
        )
    );
    if (!match) return null;
    return finitePosition({ x: match[1], y: match[2], z: match[3] });
}

function winnerPositionFromContest(contest) {
    for (const winnerId of contest?.winnerIds || []) {
        const position = finitePosition(contest?.submissions?.[winnerId]?.payload?.position);
        if (position) return position;
    }
    return null;
}

export function buildWinnerRevealCommands(contest, position, spectatorNames = []) {
    const winnerId = contest?.winnerIds?.[0];
    const participants = Array.isArray(contest?.participantIds) ? contest.participantIds : [];
    const target = finitePosition(position);
    if (!winnerId || !target || participants.length === 0) return [];
    participants.forEach(assertPlayerName);
    spectatorNames.forEach(assertPlayerName);

    const { x, y, z } = target;
    const commands = [];
    for (const name of participants) {
        commands.push(
            `effect clear ${name}`,
            `effect give ${name} slowness infinite 255 true`,
            `effect give ${name} jump_boost infinite 128 true`,
            `effect give ${name} resistance infinite 255 true`,
            `gamemode adventure ${name}`,
            `tp ${name} ${x} ${y} ${z} facing ${x} ${y} ${z + 1}`
        );
    }
    for (const name of spectatorNames) {
        commands.push(
            `gamemode spectator ${name}`,
            `tp ${name} ${x + 6} ${y + 3} ${z + 6} facing ${x} ${y + 1} ${z}`
        );
    }
    return commands;
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

export function buildPodiumCeremonyCommands(contest, spectatorNames = []) {
    if (contest?.status !== 'completed' || !contest.winnerIds?.length) return [];

    const results = orderedContestResults(contest);
    if (results.length === 0) return [];
    results.forEach(result => assertPlayerName(result.participantId));
    spectatorNames.forEach(assertPlayerName);

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
            `effect give ${podium.name} slowness infinite 255 true`,
            `effect give ${podium.name} jump_boost infinite 128 true`,
            `effect give ${podium.name} resistance infinite 255 true`,
            `gamemode adventure ${podium.name}`,
            `tp ${podium.name} ${podium.x} `
            + `${ARENA.floorY + podium.height + 1} ${ARENA.centerZ} 0 0`,
            `spawnpoint ${podium.name} ${podium.x} `
            + `${ARENA.floorY + podium.height + 1} ${ARENA.centerZ}`
        );
    }
    const spectatorX = ARENA.centerX;
    const spectatorY = ARENA.floorY + Math.max(...podiums.map(podium => podium.height)) + 4;
    const spectatorZ = ARENA.centerZ + 14;
    for (const name of spectatorNames) {
        commands.push(
            `gamemode spectator ${name}`,
            `tp ${name} ${spectatorX} ${spectatorY} ${spectatorZ} `
            + `facing ${ARENA.centerX} ${ARENA.floorY + 3} ${ARENA.centerZ}`
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

    async waitForPlayersOnline(participants, onProgress = null) {
        const needed = [...new Set(participants)];
        const deadline = Date.now() + this.playerWaitTimeoutMs;
        let missing = needed;
        while (Date.now() < deadline) {
            const online = new Set(await this.listOnlinePlayers());
            missing = needed.filter(name => !online.has(name));
            if (missing.length === 0) return;
            onProgress?.(`Waiting for Minecraft to show ${missing.join(', ')}`);
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

        // Rebuilding the world is the longest silent stretch of a launch — a few
        // hundred RCON calls with nothing to show for them — so the caller gets
        // a running count instead of one unchanging line.
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
        const seed = options.seed ?? randomSeed();
        const worldCommands = buildWorldResetCommands(preset.id, { seed });
        let done = 0;
        for (const command of worldCommands) {
            await this.runCommand(command);
            done += 1;
            if (done % PROGRESS_COMMAND_INTERVAL === 0 || done === worldCommands.length) {
                onProgress?.(`Rebuilding the arena (${done}/${worldCommands.length} commands)`);
            }
        }

        // Player-targeted commands (/clear, /tp, /give) fail with
        // "No player was found" if bots dropped between MindServer ready and
        // RCON setup — wait on `list` so the error is clear and early.
        onProgress?.('Checking that every bot is visible to Minecraft');
        await this.waitForPlayersOnline(participants, onProgress);

        onProgress?.(`Teleporting and equipping ${participants.length} bots`);
        const participantCommands = buildParticipantCommands(preset.id, participants, options);
        // Equip and prep each bot in order, but hold their teleports so every bot
        // lands on the same tick via the command-block rig instead of popping in
        // one at a time as the RCON calls trickle through.
        const { setup: participantSetup, teleports } = partitionTeleportCommands(participantCommands);
        for (const command of participantSetup) {
            await this.runCommand(command);
        }
        const teleportRigCommands = buildSimultaneousTeleportCommands(teleports);
        for (const command of teleportRigCommands) {
            await this.runCommand(command);
        }

        // The rig is fire-and-forget, so read every bot's position back and
        // re-send anyone who is not standing on the arena floor. A Spleef player
        // the chain skipped would otherwise open the match in the pit.
        onProgress?.('Verifying every bot is standing on the arena floor');
        let placementAudits = [];
        let placementCommandCount = 0;
        try {
            placementAudits = await verifyParticipantPlacement(
                command => {
                    placementCommandCount += 1;
                    return this.runCommand(command);
                },
                preset.id,
                participants,
                options
            );
            const misplaced = placementAudits.filter(audit => !audit.onTopLayer);
            if (misplaced.length) {
                console.warn(
                    '[contest] Not standing on the arena floor after re-teleport: '
                    + misplaced.map(audit => audit.participantId).join(', ')
                );
            }
        } catch (error) {
            console.warn(`Could not verify starting positions: ${error.message}`);
        }

        const teamCommands = isTeamArenaGame(preset.id)
            ? buildContestTeamCommands(participants, options)
            : [];
        if (teamCommands.length) onProgress?.('Assigning teams and nametags');
        for (const command of teamCommands) {
            await this.runCommand(command);
        }

        // Confirm everyone begins with the identical kit and nothing extra
        // carried over. A mismatch is re-kitted once and re-checked; whatever
        // remains is reported so the launch can flag it.
        onProgress?.('Verifying starting inventories are identical');
        let inventoryAudits = [];
        let inventoryCommandCount = 0;
        try {
            inventoryAudits = await verifyParticipantInventories(
                command => {
                    inventoryCommandCount += 1;
                    return this.runCommand(command);
                },
                preset.id,
                participants
            );
            const unclean = inventoryAudits.filter(audit => !audit.matches);
            if (unclean.length) {
                console.warn(
                    '[contest] Inventory still not clean after repair for: '
                    + unclean.map(audit => audit.participantId).join(', ')
                );
            }
        } catch (error) {
            console.warn(`Could not verify starting inventories: ${error.message}`);
        }

        const commands = [
            ...worldCommands,
            ...participantSetup,
            ...teleportRigCommands,
            ...teamCommands,
        ];
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

        // Seating the audience is cosmetic, so a spectator who logs out between
        // `list` and `gamemode` is skipped instead of failing the whole launch.
        if (spectators.length) onProgress?.(`Seating ${spectators.length} spectators`);
        const warpedSpectators = [];
        for (const name of spectators) {
            try {
                for (const command of spectatorWarpCommands([name])) {
                    await this.runCommand(command);
                }
                warpedSpectators.push(name);
            } catch (error) {
                console.warn(`Could not warp spectator ${name}: ${error.message}`);
            }
        }

        const join = getArenaJoinInfo();
        return {
            ...join.arena,
            seed,
            // Placement and inventory verification run their reads and any repair
            // through the same RCON channel, so those calls count toward the
            // reset total alongside the world/participant/team commands.
            resetCommandCount: commands.length + placementCommandCount + inventoryCommandCount,
            spectators: warpedSpectators,
            inventoryAudits,
            placementAudits,
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

    async presentWinner(contest) {
        const winnerId = contest?.winnerIds?.[0];
        if (!winnerId) return { presented: false, position: null, spectators: [] };
        assertPlayerName(winnerId);

        let position = winnerPositionFromContest(contest);
        if (!position) {
            position = parsePlayerPosition(
                await this.runCommand(`data get entity ${winnerId} Pos`)
            );
        }
        if (!position) {
            return { presented: false, position: null, spectators: [] };
        }

        const participantSet = new Set(contest.participantIds || []);
        const spectators = (await this.listOnlinePlayers())
            .filter(name => !participantSet.has(name));
        const commands = buildWinnerRevealCommands(contest, position, spectators);
        for (const command of commands) {
            await this.runCommand(command);
        }
        return {
            presented: commands.length > 0,
            commandCount: commands.length,
            position,
            spectators,
        };
    }

    async presentResults(contest) {
        const participantSet = new Set(contest?.participantIds || []);
        const spectators = (await this.listOnlinePlayers())
            .filter(name => !participantSet.has(name));
        const commands = buildPodiumCeremonyCommands(contest, spectators);
        for (const command of commands) {
            await this.runCommand(command);
        }
        return {
            presented: commands.length > 0,
            commandCount: commands.length,
            spectators,
        };
    }
}

export {
    buildResetCommands,
    buildWorldResetCommands,
    buildParticipantCommands,
    spectatorWarpCommands,
    ARENA,
    TOP_LAYER_Y,
    GAME_KITS,
    DIAMOND_RACE_ORES,
    NETHERITE_RACE_DIAMOND_ORES,
    NETHERITE_RACE_ANCIENT_DEBRIS,
};
