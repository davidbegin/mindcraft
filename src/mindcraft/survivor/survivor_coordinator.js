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
        this.seasonsDir = path.join(this.root, 'seasons');
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
            // state.json only ever holds the newest season, so the one being
            // replaced is filed away first. Without this, starting a season
            // erases the full record of the one before it.
            await this._archive(this.game?.snapshot());
            this.game = new SurvivorGame({
                ...specification,
                id: specification?.id || randomUUID(),
                random: this.random,
            });
            const snapshot = this.game.snapshot();
            await this._persist();
            // The opening events carry the cast and the tribe split, which is
            // the only record of who played once state.json has moved on.
            for (const event of snapshot.events) {
                await this._appendJournal(event.type, {
                    seasonId: snapshot.id,
                    ...event,
                });
            }
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
            await this._archive(snapshot);
            return clone(result);
        });
    }

    recordPrivateEvent(event) {
        return this._enqueue(async () => {
            if (!this.game) return false;
            const snapshot = this.game.snapshot();
            // Round and phase are stamped here, at journal time, so recovery can
            // replay a private event back into the round it actually happened in
            // rather than the round the server restarted in. The raw registry
            // event carries neither.
            const data = {
                seasonId: snapshot.id,
                round: snapshot.round ?? null,
                phase: snapshot.phase ?? null,
                ...clone(event || {}),
            };
            await this._appendJournal(`private.${event?.type || 'event'}`, data);
            return true;
        });
    }

    // Every private event ever journaled for a season, in the order it happened,
    // with the enclosing `private.` prefix stripped back off so the shapes match
    // what the registries emitted. A torn final line (a crash mid-append) is
    // skipped rather than throwing the whole recovery away.
    async readPrivateEvents(seasonId = null) {
        let contents;
        try {
            contents = await readFile(this.journalPath, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const events = [];
        for (const line of contents.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let entry;
            try {
                entry = JSON.parse(trimmed);
            } catch {
                continue;
            }
            if (typeof entry?.type !== 'string' || !entry.type.startsWith('private.')) continue;
            const { seasonId: entrySeasonId, ...event } = entry.data || {};
            if (seasonId && entrySeasonId && entrySeasonId !== seasonId) continue;
            if (event.at == null) event.at = entry.at ?? null;
            events.push(event);
        }
        return events;
    }

    // A season that has stopped moving gets its own file under seasons/, keyed
    // by season id, so post-season analysis reads a finished snapshot instead of
    // replaying the journal from scratch.
    async _archive(snapshot) {
        if (!snapshot || !['completed', 'cancelled'].includes(snapshot.status)) return false;
        await mkdir(this.seasonsDir, { recursive: true });
        const target = path.join(this.seasonsDir, `${snapshot.id}.json`);
        const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
            await rename(temporaryPath, target);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
        return true;
    }

    // Files the current season if it has already finished. The server calls this
    // at boot so a season that ended before archiving existed is not lost the
    // next time somebody starts a new one.
    archiveFinishedSeason() {
        return this._enqueue(() => this._archive(this.game?.snapshot()));
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
