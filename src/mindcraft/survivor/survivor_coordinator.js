import { randomUUID } from 'node:crypto';
import {
    appendFile,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SurvivorGame } from './survivor_game.js';

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
}

export class SurvivorCoordinator {
    constructor(options = {}) {
        if (typeof options.root !== 'string' || options.root.trim() === '') {
            throw new TypeError('root must be a non-empty string');
        }
        this.root = path.resolve(options.root);
        this.statePath = path.join(this.root, 'state.json');
        this.journalPath = path.join(this.root, 'journal.jsonl');
        this.random = options.random || Math.random;
        this.game = options.state
            ? new SurvivorGame({ state: options.state, random: this.random })
            : null;
        this._operation = Promise.resolve();
    }

    static async create(options) {
        const coordinator = new SurvivorCoordinator(options);
        await mkdir(coordinator.root, { recursive: true });
        return coordinator;
    }

    static async load(options) {
        const state = JSON.parse(await readFile(
            path.join(path.resolve(options.root), 'state.json'),
            'utf8'
        ));
        const coordinator = new SurvivorCoordinator({ ...options, state });
        await mkdir(coordinator.root, { recursive: true });
        return coordinator;
    }

    view() {
        return this.game?.snapshot() || null;
    }

    start(specification) {
        return this._enqueue(async () => {
            if (this.game?.snapshot().status === 'running') {
                throw new Error('A Survivor season is already running');
            }
            this.game = new SurvivorGame({
                ...specification,
                id: specification?.id || randomUUID(),
                random: this.random,
            });
            await this._commit('season.started', {
                seasonId: this.game.snapshot().id,
            });
            return this.view();
        });
    }

    apply(method, ...args) {
        return this._enqueue(async () => {
            if (!this.game) throw new Error('No Survivor season exists');
            if (typeof this.game[method] !== 'function' || method.startsWith('_')) {
                throw new Error(`Unknown Survivor operation: ${method}`);
            }
            const beforeEvents = this.game.snapshot().events.length;
            const result = this.game[method](...clone(args));
            const snapshot = this.game.snapshot();
            const newEvents = snapshot.events.slice(beforeEvents);
            await this._persist();
            for (const event of newEvents) {
                await this._appendJournal(event.type, {
                    seasonId: snapshot.id,
                    ...event,
                });
            }
            return clone(result);
        });
    }

    recordPrivateEvent(event) {
        return this._enqueue(async () => {
            if (!this.game) return false;
            await this._appendJournal(`private.${event?.type || 'event'}`, {
                seasonId: this.game.snapshot().id,
                ...clone(event || {}),
            });
            return true;
        });
    }

    async _commit(type, data) {
        await this._persist();
        await this._appendJournal(type, data);
    }

    async _persist() {
        if (!this.game) return;
        const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporaryPath,
                `${JSON.stringify(this.game.snapshot(), null, 2)}\n`
            );
            await rename(temporaryPath, this.statePath);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    async _appendJournal(type, data) {
        await appendFile(this.journalPath, `${JSON.stringify({
            at: Date.now(),
            type,
            data,
        })}\n`);
    }

    _enqueue(operation) {
        const result = this._operation.then(operation, operation);
        this._operation = result.catch(() => {});
        return result;
    }
}
