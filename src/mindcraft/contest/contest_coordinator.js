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

export const CONTEST_STATUSES = Object.freeze([
    'draft',
    'running',
    'judging',
    'completed',
    'cancelled',
]);

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function assertNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${name} must be a non-empty string`);
    }
}

function assertPositiveNumber(value, name) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be positive`);
    }
}

function defaultState() {
    return {
        version: 1,
        activeContestId: null,
        contests: {},
    };
}

function assertState(state) {
    if (!state || state.version !== 1 || typeof state.contests !== 'object') {
        throw new Error('Invalid contest coordinator state');
    }
    for (const contest of Object.values(state.contests)) {
        if (!CONTEST_STATUSES.includes(contest.status)) {
            throw new Error(`Invalid contest status: ${contest.status}`);
        }
    }
}

function valueAtPath(value, propertyPath) {
    return propertyPath.split('.').reduce(
        (current, property) => current?.[property],
        value
    );
}

function scoreSubmission(contest, submission) {
    const metrics = contest.rules?.metrics;
    if (!Array.isArray(metrics) || metrics.length === 0) {
        const submittedScore = submission?.payload?.score;
        return {
            score: Number.isFinite(submittedScore) ? submittedScore : 0,
            details: submission
                ? 'Score supplied by submission payload'
                : 'No submission received before the deadline',
        };
    }

    const breakdown = metrics.map((metric, index) => {
        const path = metric.path ?? metric.name;
        assertNonEmptyString(path, `rules.metrics[${index}].path`);
        const weight = metric.weight ?? 1;
        if (!Number.isFinite(weight)) {
            throw new TypeError(`rules.metrics[${index}].weight must be finite`);
        }
        const direction = metric.direction ?? 'maximize';
        if (!['maximize', 'minimize'].includes(direction)) {
            throw new Error(
                `rules.metrics[${index}].direction must be maximize or minimize`
            );
        }
        const rawValue = valueAtPath(submission?.payload, path);
        const value = Number.isFinite(rawValue) ? rawValue : 0;
        const contribution = value * weight * (direction === 'minimize' ? -1 : 1);
        return { path, value, weight, direction, contribution };
    });
    return {
        score: breakdown.reduce((total, metric) => total + metric.contribution, 0),
        details: { breakdown },
    };
}

export function defaultJudge(contest) {
    return contest.participantIds.map(participantId => {
        const submission = contest.submissions[participantId];
        return {
            participantId,
            ...scoreSubmission(contest, submission),
            disqualified: !submission,
        };
    });
}

function rankResults(contest, judgedResults) {
    const byParticipant = new Map();
    for (const result of judgedResults) {
        assertNonEmptyString(result?.participantId, 'result.participantId');
        if (!contest.participantIds.includes(result.participantId)) {
            throw new Error(`Judge returned unknown participant: ${result.participantId}`);
        }
        if (byParticipant.has(result.participantId)) {
            throw new Error(`Judge returned duplicate participant: ${result.participantId}`);
        }
        if (!Number.isFinite(result.score)) {
            throw new TypeError(`Judge score for ${result.participantId} must be finite`);
        }
        byParticipant.set(result.participantId, {
            participantId: result.participantId,
            score: result.score,
            details: result.details ?? null,
            submitted: Boolean(contest.submissions[result.participantId]),
            disqualified: result.disqualified === true,
        });
    }

    const results = contest.participantIds.map(participantId =>
        byParticipant.get(participantId) ?? {
            participantId,
            score: null,
            details: 'Judge did not return a result',
            submitted: Boolean(contest.submissions[participantId]),
            disqualified: true,
        }
    );
    results.sort((left, right) => {
        if (left.disqualified !== right.disqualified) {
            return left.disqualified ? 1 : -1;
        }
        if (left.score === null && right.score === null) {
            return left.participantId.localeCompare(right.participantId);
        }
        if (left.score === null) return 1;
        if (right.score === null) return -1;
        return right.score - left.score ||
            left.participantId.localeCompare(right.participantId);
    });

    let previousScore = null;
    let previousRank = 0;
    for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.disqualified || result.score === null) {
            result.rank = null;
        } else if (index === 0 || result.score !== previousScore) {
            result.rank = index + 1;
            previousRank = result.rank;
        } else {
            result.rank = previousRank;
        }
        previousScore = result.score;
    }
    return results;
}

export class ContestCoordinator {
    constructor(options = {}) {
        const {
            root,
            clock = () => Date.now(),
            idFactory = randomUUID,
            judge = defaultJudge,
            onDeadline = null,
            state,
        } = options;

        assertNonEmptyString(root, 'root');
        if (typeof clock !== 'function') throw new TypeError('clock must be a function');
        if (typeof idFactory !== 'function') {
            throw new TypeError('idFactory must be a function');
        }
        if (typeof judge !== 'function') throw new TypeError('judge must be a function');
        if (onDeadline != null && typeof onDeadline !== 'function') {
            throw new TypeError('onDeadline must be a function');
        }

        this.root = path.resolve(root);
        this.statePath = path.join(this.root, 'state.json');
        this.journalPath = path.join(this.root, 'journal.jsonl');
        this.clock = clock;
        this.idFactory = idFactory;
        this.judge = judge;
        this.onDeadline = onDeadline;
        this.state = state ? clone(state) : defaultState();
        assertState(this.state);
        this._operation = Promise.resolve();
    }

    static async create(options) {
        const coordinator = new ContestCoordinator(options);
        await coordinator._initialize();
        return coordinator;
    }

    static async load(options) {
        assertNonEmptyString(options?.root, 'root');
        const state = JSON.parse(await readFile(
            path.join(path.resolve(options.root), 'state.json'),
            'utf8'
        ));
        const coordinator = new ContestCoordinator({ ...options, state });
        await mkdir(coordinator.root, { recursive: true });
        return coordinator;
    }

    snapshot() {
        return clone(this.state);
    }

    view() {
        const state = this.snapshot();
        const activeContest = state.activeContestId
            ? state.contests[state.activeContestId]
            : null;
        return {
            ...state,
            activeContest,
            contests: Object.values(state.contests)
                .sort((left, right) => right.createdAt - left.createdAt),
        };
    }

    async createContest(specification) {
        const {
            id = this.idFactory(),
            title,
            prompt,
            durationMs,
            participantIds = [],
            rules = {},
            metadata = {},
        } = specification ?? {};
        assertNonEmptyString(id, 'id');
        assertNonEmptyString(title, 'title');
        assertNonEmptyString(prompt, 'prompt');
        assertPositiveNumber(durationMs, 'durationMs');
        const uniqueParticipants = [...new Set(participantIds)];
        uniqueParticipants.forEach((participantId, index) =>
            assertNonEmptyString(participantId, `participantIds[${index}]`)
        );

        return this._enqueue(async () => {
            if (this.state.contests[id]) throw new Error(`Contest already exists: ${id}`);
            const now = this.clock();
            const contest = {
                id,
                title,
                prompt,
                durationMs,
                participantIds: uniqueParticipants,
                rules: clone(rules),
                metadata: clone(metadata),
                status: 'draft',
                submissions: {},
                eliminations: {},
                deaths: {},
                results: [],
                winnerIds: [],
                createdAt: now,
                startedAt: null,
                deadlineAt: null,
                completedAt: null,
                cancelledAt: null,
                cancellationReason: null,
            };
            this.state.contests[id] = contest;
            await this._commit('contest.created', { contestId: id });
            return clone(contest);
        });
    }

    async registerParticipant(contestId, participantId) {
        assertNonEmptyString(participantId, 'participantId');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (contest.status !== 'draft') {
                throw new Error('Participants can only be changed while a contest is a draft');
            }
            if (!contest.participantIds.includes(participantId)) {
                contest.participantIds.push(participantId);
                await this._commit('participant.registered', {
                    contestId,
                    participantId,
                });
            }
            return clone(contest);
        });
    }

    async startContest(contestId) {
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (this.state.activeContestId) {
                throw new Error(`Contest already active: ${this.state.activeContestId}`);
            }
            if (contest.status !== 'draft') throw new Error('Contest is not a draft');
            if (contest.participantIds.length === 0) {
                throw new Error('Contest requires at least one participant');
            }
            const now = this.clock();
            contest.status = 'running';
            contest.startedAt = now;
            contest.deadlineAt = now + contest.durationMs;
            this.state.activeContestId = contest.id;
            await this._commit('contest.started', {
                contestId,
                deadlineAt: contest.deadlineAt,
            });
            return clone(contest);
        });
    }

    async submit(contestId, participantId, payload) {
        assertNonEmptyString(participantId, 'participantId');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (contest.status !== 'running') throw new Error('Contest is not accepting submissions');
            if (!contest.participantIds.includes(participantId)) {
                throw new Error(`Participant is not registered: ${participantId}`);
            }
            if (contest.submissions[participantId]) {
                throw new Error(`Participant already submitted: ${participantId}`);
            }
            const now = this.clock();
            if (now >= contest.deadlineAt) {
                await this._finalizeContest(contest, 'deadline');
                throw new Error('Contest deadline has passed');
            }
            contest.submissions[participantId] = {
                participantId,
                payload: clone(payload),
                submittedAt: now,
            };
            await this._commit('submission.received', { contestId, participantId });

            if (Object.keys(contest.submissions).length === contest.participantIds.length) {
                await this._finalizeContest(contest, 'all-submitted');
            }
            return clone(contest.submissions[participantId]);
        });
    }

    async declareWinner(contestId, participantId, payload = {}) {
        assertNonEmptyString(participantId, 'participantId');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (contest.status !== 'running') {
                throw new Error('Contest is not accepting a winner');
            }
            if (!contest.participantIds.includes(participantId)) {
                throw new Error(`Participant is not registered: ${participantId}`);
            }
            const now = this.clock();
            if (now >= contest.deadlineAt) {
                await this._finalizeContest(contest, 'deadline');
                throw new Error('Contest deadline has passed');
            }
            contest.submissions[participantId] = {
                participantId,
                payload: clone(payload),
                submittedAt: now,
            };
            await this._commit('winner.detected', {
                contestId,
                participantId,
                payload: clone(payload),
            });
            await this._finalizeContest(contest, 'winner-detected');
            return clone(contest);
        });
    }

    async eliminate(contestId, participantId, payload = {}) {
        assertNonEmptyString(participantId, 'participantId');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (contest.status !== 'running') {
                throw new Error('Contest is not accepting eliminations');
            }
            if (!contest.participantIds.includes(participantId)) {
                throw new Error(`Participant is not registered: ${participantId}`);
            }
            if (!contest.eliminations || typeof contest.eliminations !== 'object') {
                contest.eliminations = {};
            }
            if (contest.eliminations[participantId]) {
                throw new Error(`Participant already eliminated: ${participantId}`);
            }
            const now = this.clock();
            if (now >= contest.deadlineAt) {
                await this._finalizeContest(contest, 'deadline');
                throw new Error('Contest deadline has passed');
            }
            contest.eliminations[participantId] = {
                participantId,
                eliminatedAt: now,
                reason: payload?.reason ?? 'fell',
                payload: clone(payload),
            };
            await this._commit('participant.eliminated', {
                contestId,
                participantId,
                reason: contest.eliminations[participantId].reason,
            });

            const survivors = contest.participantIds.filter(
                id => !contest.eliminations[id]
            );
            if (contest.rules?.type === 'hot_button') {
                this._ensurePressedIds(contest);
                if (!contest.metadata.pressedIds.includes(participantId)) {
                    contest.metadata.pressedIds.push(participantId);
                }
                if (survivors.length === 1) {
                    const winnerId = survivors[0];
                    if (contest.metadata.pressedIds.includes(winnerId)) {
                        await this._finalizeHotButtonWinner(contest, winnerId, now);
                    }
                } else if (survivors.length === 0) {
                    await this._finalizeContest(contest, 'all-eliminated');
                }
                return clone(contest);
            }
            if (survivors.length === 1) {
                const winnerId = survivors[0];
                contest.submissions[winnerId] = {
                    participantId: winnerId,
                    payload: {
                        event: 'last_standing',
                        elapsedMs: now - contest.startedAt,
                    },
                    submittedAt: now,
                };
                await this._commit('winner.detected', {
                    contestId,
                    participantId: winnerId,
                    payload: clone(contest.submissions[winnerId].payload),
                });
                await this._finalizeContest(contest, 'last-standing');
            } else if (survivors.length === 0) {
                await this._finalizeContest(contest, 'all-eliminated');
            }
            return clone(contest);
        });
    }

    /**
     * Record that a Hot Button competitor pressed a station. A confirmed safe
     * press crowns them immediately. Otherwise they only win early when they
     * are already the sole survivor; a lone chicken is never crowned here.
     */
    async markPressed(contestId, participantId, payload = {}) {
        assertNonEmptyString(participantId, 'participantId');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (contest.status !== 'running') {
                throw new Error('Contest is not accepting presses');
            }
            if (!contest.participantIds.includes(participantId)) {
                throw new Error(`Participant is not registered: ${participantId}`);
            }
            if (contest.eliminations?.[participantId]) {
                return clone(contest);
            }
            const now = this.clock();
            if (now >= contest.deadlineAt) {
                await this._finalizeContest(contest, 'deadline');
                throw new Error('Contest deadline has passed');
            }
            this._ensurePressedIds(contest);
            if (!contest.metadata.pressedIds.includes(participantId)) {
                contest.metadata.pressedIds.push(participantId);
                await this._commit('participant.pressed', {
                    contestId,
                    participantId,
                    payload: clone(payload),
                });
            }
            if (payload?.safe === true) {
                contest.submissions[participantId] = {
                    participantId,
                    payload: {
                        event: 'safe_button',
                        item: payload?.item || null,
                        elapsedMs: now - contest.startedAt,
                    },
                    submittedAt: now,
                };
                await this._commit('winner.detected', {
                    contestId,
                    participantId,
                    payload: clone(contest.submissions[participantId].payload),
                });
                await this._finalizeContest(contest, 'winner-detected');
                return clone(contest);
            }
            const survivors = contest.participantIds.filter(
                id => !contest.eliminations?.[id]
            );
            if (survivors.length === 1 && survivors[0] === participantId) {
                await this._finalizeHotButtonWinner(contest, participantId, now);
            }
            return clone(contest);
        });
    }

    async noteHotButtonLayout(contestId, layout = {}) {
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (!contest.metadata || typeof contest.metadata !== 'object') {
                contest.metadata = {};
            }
            if (Number.isInteger(layout.safeIndex)) {
                contest.metadata.hotButtonSafeIndex = layout.safeIndex;
            }
            this._ensurePressedIds(contest);
            if (layout.seed != null) {
                contest.metadata.hotButtonSeed = layout.seed;
            }
            await this._commit('hot_button.layout', {
                contestId,
                safeIndex: contest.metadata.hotButtonSafeIndex ?? null,
                seed: contest.metadata.hotButtonSeed ?? null,
            });
            return clone(contest);
        });
    }

    async noteSeries(contestId, series) {
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (!contest.metadata || typeof contest.metadata !== 'object') {
                contest.metadata = {};
            }
            contest.metadata.series = clone(series);
            await this._commit('contest.series_updated', {
                contestId,
                series: clone(series),
            });
            return clone(contest);
        });
    }

    _ensurePressedIds(contest) {
        if (!contest.metadata || typeof contest.metadata !== 'object') {
            contest.metadata = {};
        }
        if (!Array.isArray(contest.metadata.pressedIds)) {
            contest.metadata.pressedIds = [];
        }
    }

    async _finalizeHotButtonWinner(contest, winnerId, now) {
        contest.submissions[winnerId] = {
            participantId: winnerId,
            payload: {
                event: 'last_standing',
                elapsedMs: now - contest.startedAt,
            },
            submittedAt: now,
        };
        await this._commit('winner.detected', {
            contestId: contest.id,
            participantId: winnerId,
            payload: clone(contest.submissions[winnerId].payload),
        });
        await this._finalizeContest(contest, 'last-standing');
    }

    async recordDeath(contestId, participantId, payload = {}) {
        assertNonEmptyString(participantId, 'participantId');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (contest.status !== 'running') {
                throw new Error('Contest is not accepting deaths');
            }
            if (!contest.participantIds.includes(participantId)) {
                throw new Error(`Participant is not registered: ${participantId}`);
            }
            const now = this.clock();
            if (now >= contest.deadlineAt) {
                throw new Error('Contest deadline has passed');
            }
            if (!contest.deaths || typeof contest.deaths !== 'object') {
                contest.deaths = {};
            }
            contest.deaths[participantId] = (contest.deaths[participantId] ?? 0) + 1;
            await this._commit('participant.death', {
                contestId,
                participantId,
                total: contest.deaths[participantId],
                payload: clone(payload),
            });
            return clone(contest);
        });
    }

    /**
     * Append a game event to the journal without touching contest state. Used
     * for high-volume, read-only records (in-game chat, inventory audits) that
     * feed the archive but should never mutate scoring or status. Queued behind
     * the same operation chain so a burst of messages never interleaves with a
     * state commit mid-write.
     */
    async recordGameEvent(type, data = {}) {
        assertNonEmptyString(type, 'type');
        return this._enqueue(async () => {
            await this._appendJournal(type, data);
            return true;
        });
    }

    async tick() {
        return this._enqueue(async () => {
            const contest = this.state.activeContestId
                ? this.state.contests[this.state.activeContestId]
                : null;
            if (!contest) return { changed: false, reason: 'no-active-contest' };
            if (contest.status === 'judging') {
                await this._finalizeContest(contest, 'judging-retry');
                return { changed: true, reason: 'judged', contest: clone(contest) };
            }
            if (contest.status !== 'running' || this.clock() < contest.deadlineAt) {
                return { changed: false, reason: 'waiting', contest: clone(contest) };
            }
            if (typeof this.onDeadline === 'function') {
                const deferred = await this.onDeadline(contest);
                if (deferred) {
                    await this._commit('contest.deadline_deferred', {
                        contestId: contest.id,
                        reason: deferred.reason || 'deadline-deferred',
                        deadlineAt: contest.deadlineAt,
                    });
                    return {
                        changed: true,
                        reason: deferred.reason || 'deadline-deferred',
                        contest: clone(contest),
                    };
                }
            }
            await this._finalizeContest(contest, 'deadline');
            return { changed: true, reason: 'deadline', contest: clone(contest) };
        });
    }

    async cancelContest(contestId, reason = 'Cancelled') {
        assertNonEmptyString(reason, 'reason');
        return this._enqueue(async () => {
            const contest = this._requireContest(contestId);
            if (['completed', 'cancelled'].includes(contest.status)) {
                throw new Error('Contest is already finished');
            }
            contest.status = 'cancelled';
            contest.cancelledAt = this.clock();
            contest.cancellationReason = reason;
            if (this.state.activeContestId === contest.id) {
                this.state.activeContestId = null;
            }
            await this._commit('contest.cancelled', { contestId, reason });
            return clone(contest);
        });
    }

    async _finalizeContest(contest, trigger) {
        if (contest.status === 'running') {
            contest.status = 'judging';
            await this._commit('contest.judging', {
                contestId: contest.id,
                trigger,
            });
        }
        const judged = await this.judge(clone(contest));
        if (!Array.isArray(judged)) throw new TypeError('judge must return an array');
        contest.results = rankResults(contest, judged);
        if (
            contest.rules?.type === 'team_tower_battle'
            || (
                contest.rules?.type === 'cake_race'
                && Array.isArray(contest.metadata?.gameSession?.teamNames)
                && contest.metadata.gameSession.teamNames.length === 2
            )
        ) {
            const teamScores = [...new Set(
                contest.results
                    .filter(result => !result.disqualified && Number.isFinite(result.score))
                    .map(result => result.score)
            )].sort((left, right) => right - left);
            for (const result of contest.results) {
                result.rank = result.disqualified || !Number.isFinite(result.score)
                    ? null
                    : teamScores.indexOf(result.score) + 1;
            }
        }
        contest.winnerIds = contest.results
            .filter(result => result.rank === 1)
            .map(result => result.participantId);
        contest.status = 'completed';
        contest.completedAt = this.clock();
        if (this.state.activeContestId === contest.id) {
            this.state.activeContestId = null;
        }
        await this._commit('contest.completed', {
            contestId: contest.id,
            trigger,
            winnerIds: contest.winnerIds,
        });
    }

    _requireContest(contestId) {
        assertNonEmptyString(contestId, 'contestId');
        const contest = this.state.contests[contestId];
        if (!contest) throw new Error(`Unknown contest: ${contestId}`);
        return contest;
    }

    async _initialize() {
        await mkdir(this.root, { recursive: true });
        await this._persist();
        await this._appendJournal('coordinator.initialized', {});
    }

    async _commit(type, data) {
        await this._persist();
        await this._appendJournal(type, data);
    }

    async _persist() {
        const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
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

    async _appendJournal(type, data) {
        await appendFile(this.journalPath, `${JSON.stringify({
            at: this.clock(),
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
