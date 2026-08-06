import { runMinecraftCommand } from '../minecraft_server.js';
import { parseOnlinePlayers, parsePlayerPosition } from './arena_manager.js';

const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_MOVE_DISTANCE = 0.35;

function assertPlayerName(name) {
    if (!PLAYER_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid Minecraft player name: ${name}`);
    }
}

function distanceBetween(left, right) {
    if (!left || !right) return 0;
    return Math.hypot(
        left.x - right.x,
        left.y - right.y,
        left.z - right.z
    );
}

function chooseRandom(values, random) {
    if (!values.length) return null;
    return values[Math.floor(random() * values.length)];
}

export class SpectatorDirector {
    constructor(options = {}) {
        this.runCommand = options.runCommand || runMinecraftCommand;
        this.random = options.random || Math.random;
        this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
        this.moveDistance = options.moveDistance ?? DEFAULT_MOVE_DISTANCE;
        this.setInterval = options.setInterval || globalThis.setInterval;
        this.clearInterval = options.clearInterval || globalThis.clearInterval;
        this.onUpdate = options.onUpdate || (() => {});
        this.isContestActive = options.isContestActive || (() => true);
        this.timer = null;
        this.enabled = false;
        this.contestId = null;
        this.participantIds = [];
        this.spectators = [];
        this.currentTarget = null;
        this.positions = new Map();
        this.moving = new Map();
        this.switching = false;
    }

    view() {
        return {
            enabled: this.enabled,
            contestId: this.contestId,
            spectators: [...this.spectators],
            currentTarget: this.currentTarget,
        };
    }

    async start(contest) {
        const participantIds = [...new Set(contest?.participantIds || [])];
        if (!contest?.id || participantIds.length === 0) {
            throw new Error('An active contest with participants is required');
        }
        participantIds.forEach(assertPlayerName);
        await this.stop({ release: true, notify: false });

        const online = parseOnlinePlayers(await this.runCommand('list'));
        const participantSet = new Set(participantIds);
        const spectators = online.filter(name => !participantSet.has(name));
        if (spectators.length === 0) {
            throw new Error('No human spectator is online in Minecraft');
        }
        spectators.forEach(assertPlayerName);

        this.enabled = true;
        this.contestId = contest.id;
        this.participantIds = participantIds;
        this.spectators = spectators;
        try {
            await Promise.all(spectators.map(name =>
                this.runCommand(`gamemode spectator ${name}`)
            ));
            await this._readMovement();
            const availableParticipants = participantIds.filter(name =>
                this.positions.has(name)
            );
            if (availableParticipants.length === 0) {
                throw new Error('No contest participant is online to spectate');
            }

            const initialTarget = chooseRandom(availableParticipants, this.random);
            await this._switchTo(initialTarget);
            this.timer = this.setInterval(() => {
                this.tick().catch(error => {
                    console.warn(`Spectator auto camera failed: ${error.message}`);
                });
            }, this.pollMs);
            this.onUpdate(this.view());
            return this.view();
        } catch (error) {
            await this.stop({ notify: false });
            throw error;
        }
    }

    async stop(options = {}) {
        const { release = true, notify = true } = options;
        if (this.timer) {
            this.clearInterval(this.timer);
            this.timer = null;
        }
        const spectators = [...this.spectators];
        const wasEnabled = this.enabled;
        this.enabled = false;
        this.contestId = null;
        this.participantIds = [];
        this.spectators = [];
        this.currentTarget = null;
        this.positions.clear();
        this.moving.clear();

        if (release) {
            await Promise.allSettled(spectators.map(name =>
                this.runCommand(`execute as ${name} run spectate`)
            ));
        }
        if (notify && wasEnabled) this.onUpdate(this.view());
        return this.view();
    }

    async tick() {
        if (!this.enabled || this.switching) return this.view();
        if (!this.isContestActive(this.contestId)) {
            return this.stop();
        }

        this.switching = true;
        try {
            const startedMoving = await this._readMovement();
            if (startedMoving.length === 0) return this.view();

            const movingNow = this.participantIds.filter(name => this.moving.get(name));
            const alternatives = movingNow.filter(name => name !== this.currentTarget);
            const target = chooseRandom(
                alternatives.length ? alternatives : startedMoving,
                this.random
            );
            if (target && target !== this.currentTarget) {
                await this._switchTo(target);
                this.onUpdate(this.view());
            }
            return this.view();
        } finally {
            this.switching = false;
        }
    }

    async _readMovement() {
        const startedMoving = [];
        for (const name of this.participantIds) {
            const previousPosition = this.positions.get(name);
            const previousMoving = this.moving.get(name) === true;
            let position;
            try {
                position = parsePlayerPosition(
                    await this.runCommand(`data get entity ${name} Pos`)
                );
            } catch (error) {
                position = null;
            }
            if (!position) {
                this.moving.set(name, false);
                continue;
            }
            const isMoving = distanceBetween(previousPosition, position) >= this.moveDistance;
            if (isMoving && !previousMoving) startedMoving.push(name);
            this.positions.set(name, position);
            this.moving.set(name, isMoving);
        }
        return startedMoving;
    }

    async _switchTo(target) {
        assertPlayerName(target);
        await Promise.all(this.spectators.map(spectator =>
            this.runCommand(`spectate ${target} ${spectator}`)
        ));
        this.currentTarget = target;
    }
}
