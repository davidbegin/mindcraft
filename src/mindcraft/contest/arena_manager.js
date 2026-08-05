import { runMinecraftCommand } from '../minecraft_server.js';

const ARENA = Object.freeze({
    centerX: 100000,
    centerZ: 100000,
    floorY: 100,
    halfSize: 32,
    clearTopY: 220,
    mineBottomY: 68,
    spectatorY: 140,
});

const GAME_KITS = Object.freeze({
    diamond_race: Object.freeze([
        'iron_pickaxe 1',
        'bread 16',
        'torch 32',
    ]),
    tower_battle: Object.freeze([
        'cobblestone 256',
        'oak_planks 128',
        'wooden_sword 1',
        'bread 16',
    ]),
});

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
        `kill @e[type=!player,x=${minX},y=${ARENA.mineBottomY},z=${minZ},`
        + `dx=${maxX - minX},dy=${ARENA.clearTopY - ARENA.mineBottomY},`
        + `dz=${maxZ - minZ}]`
    );

    if (gameId === 'diamond_race') {
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
