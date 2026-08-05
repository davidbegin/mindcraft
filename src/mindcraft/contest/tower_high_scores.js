import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const DEFAULT_FILE_NAME = 'tower_high_scores.json';

function defaultState() {
    return {
        version: STATE_VERSION,
        scores: [],
    };
}

function assertState(state) {
    if (
        !state
        || state.version !== STATE_VERSION
        || !Array.isArray(state.scores)
    ) {
        throw new Error('Invalid tower high-score state');
    }
}

function compareScores(left, right) {
    return right.height - left.height
        || left.seconds - right.seconds
        || left.model.localeCompare(right.model)
        || left.participantId.localeCompare(right.participantId);
}

function participantModels(contest) {
    return new Map(
        (contest.metadata?.gameSession?.participants || []).map(participant => [
            participant.name,
            participant.model || participant.profileId || 'unknown',
        ])
    );
}

function contestScores(contest) {
    if (
        contest?.status !== 'completed'
        || contest.rules?.type !== 'tower_battle'
        || !Number.isFinite(contest.startedAt)
        || !Number.isFinite(contest.completedAt)
    ) {
        return [];
    }

    const endedAt = Number.isFinite(contest.deadlineAt)
        ? Math.min(contest.completedAt, contest.deadlineAt)
        : contest.completedAt;
    const seconds = Math.max(0, (endedAt - contest.startedAt) / 1000);
    const models = participantModels(contest);

    return (contest.results || [])
        .filter(result => Number.isFinite(result.score) && !result.disqualified)
        .map(result => ({
            id: `${contest.id}:${result.participantId}`,
            contestId: contest.id,
            participantId: result.participantId,
            model: String(models.get(result.participantId) || 'unknown'),
            height: result.score,
            seconds,
            completedAt: contest.completedAt,
        }));
}

export class TowerHighScoreStore {
    constructor(options = {}) {
        if (typeof options.root !== 'string' || options.root.trim() === '') {
            throw new TypeError('root must be a non-empty string');
        }
        this.root = path.resolve(options.root);
        this.statePath = path.join(
            this.root,
            options.fileName || DEFAULT_FILE_NAME
        );
        this.state = options.state || defaultState();
        assertState(this.state);
        this._operation = Promise.resolve();
    }

    static async create(options) {
        const store = new TowerHighScoreStore(options);
        await mkdir(store.root, { recursive: true });
        try {
            store.state = JSON.parse(await readFile(store.statePath, 'utf8'));
            assertState(store.state);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await store._persist();
        }
        return store;
    }

    list(limit = null) {
        const scores = this.state.scores
            .map(score => ({ ...score }))
            .sort(compareScores);
        return Number.isInteger(limit) && limit >= 0
            ? scores.slice(0, limit)
            : scores;
    }

    async recordContest(contest) {
        return this._enqueue(async () => {
            const knownIds = new Set(this.state.scores.map(score => score.id));
            const additions = contestScores(contest)
                .filter(score => !knownIds.has(score.id));
            if (additions.length === 0) return [];

            this.state.scores.push(...additions);
            this.state.scores.sort(compareScores);
            await this._persist();
            return additions.map(score => ({ ...score }));
        });
    }

    async recordContests(contests = []) {
        const additions = [];
        for (const contest of contests) {
            additions.push(...await this.recordContest(contest));
        }
        return additions;
    }

    async _persist() {
        const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
        try {
            await writeFile(
                temporaryPath,
                `${JSON.stringify(this.state, null, 2)}\n`
            );
            await rename(temporaryPath, this.statePath);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
    }

    _enqueue(operation) {
        const result = this._operation.then(operation, operation);
        this._operation = result.catch(() => {});
        return result;
    }
}
