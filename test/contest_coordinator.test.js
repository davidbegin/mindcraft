import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    ContestCoordinator,
} from '../src/mindcraft/contest/contest_coordinator.js';
import { ContestLoop } from '../src/mindcraft/contest/contest_loop.js';

async function withCoordinator(run, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-contest-'));
    try {
        const coordinator = await ContestCoordinator.create({
            root,
            idFactory: () => 'contest-1',
            ...options,
        });
        await run({ coordinator, root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function createAndStart(coordinator, overrides = {}) {
    const contest = await coordinator.createContest({
        title: 'Build a lighthouse',
        prompt: 'Build the best lighthouse before time expires.',
        durationMs: 60_000,
        participantIds: ['alice', 'bob'],
        rules: { primaryMetric: 'score' },
        ...overrides,
    });
    await coordinator.startContest(contest.id);
    return contest.id;
}

test('completes and ranks a contest when every participant submits', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator);
        await coordinator.submit(contestId, 'alice', { score: 8 });
        await coordinator.submit(contestId, 'bob', { score: 12 });

        const contest = coordinator.snapshot().contests[contestId];
        assert.equal(contest.status, 'completed');
        assert.deepEqual(contest.winnerIds, ['bob']);
        assert.deepEqual(
            contest.results.map(result => [result.participantId, result.rank]),
            [['bob', 1], ['alice', 2]]
        );
        assert.equal(coordinator.snapshot().activeContestId, null);
    }, { clock: () => now });
});

test('supports injected judging rules and preserves ties', async () => {
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator);
        await coordinator.submit(contestId, 'alice', { blocks: 20 });
        await coordinator.submit(contestId, 'bob', { blocks: 20 });

        const contest = coordinator.snapshot().contests[contestId];
        assert.deepEqual(contest.winnerIds, ['alice', 'bob']);
        assert.deepEqual(contest.results.map(result => result.rank), [1, 1]);
    }, {
        judge: contest => contest.participantIds.map(participantId => ({
            participantId,
            score: contest.submissions[participantId].payload.blocks,
        })),
    });
});

test('team tower ranks teams rather than counting tied teammates as places', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator, {
            participantIds: ['alice', 'amy', 'bob', 'ben'],
            rules: { type: 'team_tower_battle' },
        });
        now = 61_000;
        await coordinator.tick();
        const contest = coordinator.snapshot().contests[contestId];
        assert.deepEqual(
            contest.results.map(result => [result.participantId, result.rank]),
            [['alice', 1], ['amy', 1], ['ben', 2], ['bob', 2]]
        );
        assert.deepEqual(contest.winnerIds, ['alice', 'amy']);
    }, {
        clock: () => now,
        judge: contest => contest.participantIds.map(participantId => ({
            participantId,
            score: ['alice', 'amy'].includes(participantId) ? 20 : 10,
        })),
    });
});

test('first detected win item completes the contest immediately', async () => {
    let now = 5_000;
    await withCoordinator(async ({ coordinator, root }) => {
        const contestId = await createAndStart(coordinator, {
            rules: {
                type: 'diamond_race',
                winItem: 'diamond',
                metrics: [{
                    path: 'elapsedMs',
                    weight: 1,
                    direction: 'minimize',
                }],
            },
        });
        now = 8_250;
        const completed = await coordinator.declareWinner(
            contestId,
            'alice',
            { item: 'diamond', elapsedMs: 3_250 }
        );

        assert.equal(completed.status, 'completed');
        assert.deepEqual(completed.winnerIds, ['alice']);
        assert.equal(completed.completedAt, now);
        assert.equal(coordinator.snapshot().activeContestId, null);
        assert.equal(completed.submissions.alice.payload.item, 'diamond');
        assert.equal(completed.results.find(result => result.participantId === 'bob').rank, null);

        await assert.rejects(
            coordinator.declareWinner(contestId, 'bob', {
                item: 'diamond',
                elapsedMs: 3_251,
            }),
            /not accepting a winner/
        );
        const events = (await readFile(
            path.join(root, 'journal.jsonl'),
            'utf8'
        )).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(events.some(event =>
            event.type === 'winner.detected'
            && event.data.participantId === 'alice'
        ));
    }, { clock: () => now });
});

test('deadline tick judges missing submissions and persists reloadable state', async () => {
    let now = 10_000;
    await withCoordinator(async ({ coordinator, root }) => {
        const contestId = await createAndStart(coordinator, {
            durationMs: 500,
            rules: {
                metrics: [{
                    path: 'elapsedMs',
                    weight: 1,
                    direction: 'minimize',
                }],
            },
        });
        await coordinator.submit(contestId, 'alice', { elapsedMs: 400 });
        now = 10_500;

        const transition = await coordinator.tick();
        assert.equal(transition.changed, true);
        assert.equal(transition.reason, 'deadline');

        const reloaded = await ContestCoordinator.load({ root, clock: () => now });
        const contest = reloaded.snapshot().contests[contestId];
        assert.equal(contest.status, 'completed');
        assert.deepEqual(contest.winnerIds, ['alice']);
        const missingResult = contest.results.find(result =>
            result.participantId === 'bob'
        );
        assert.equal(missingResult.submitted, false);
        assert.equal(missingResult.disqualified, true);
        assert.equal(missingResult.rank, null);

        const eventTypes = (await readFile(
            path.join(root, 'journal.jsonl'),
            'utf8'
        )).trim().split('\n').map(line => JSON.parse(line).type);
        assert.ok(eventTypes.includes('contest.judging'));
        assert.ok(eventTypes.includes('contest.completed'));
    }, { clock: () => now });
});

test('rejects late submissions after finalizing the contest', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator, { durationMs: 100 });
        now = 1_100;

        await assert.rejects(
            coordinator.submit(contestId, 'alice', { score: 100 }),
            /deadline has passed/
        );
        assert.equal(
            coordinator.snapshot().contests[contestId].status,
            'completed'
        );
    }, { clock: () => now });
});

test('contest loop waits for each tick before scheduling the next one', async () => {
    const scheduled = [];
    let releaseTick;
    let ticks = 0;
    let updates = 0;
    const coordinator = {
        tick: () => new Promise(resolve => {
            releaseTick = () => resolve({ changed: true });
        }),
        view: () => ({ activeContest: null }),
    };
    const loop = new ContestLoop({
        coordinator,
        intervalMs: 10,
        onTick: () => {
            ticks += 1;
        },
        onUpdate: () => {
            updates += 1;
        },
        setTimer: callback => {
            scheduled.push(callback);
            return {};
        },
        clearTimer: () => {},
    });

    loop.start();
    assert.equal(scheduled.length, 1);
    const firstRun = scheduled.shift()();
    assert.equal(scheduled.length, 0);
    releaseTick();
    await firstRun;
    assert.equal(ticks, 1);
    assert.equal(updates, 1);
    assert.equal(scheduled.length, 1);
    loop.stop();
});

test('contest loop reports unchanged ticks for live HUD updates', async () => {
    let ticks = 0;
    let updates = 0;
    const coordinator = {
        tick: async () => ({ changed: false, reason: 'waiting' }),
        view: () => ({ activeContest: { status: 'running' } }),
    };
    const loop = new ContestLoop({
        coordinator,
        onTick: () => {
            ticks += 1;
        },
        onUpdate: () => {
            updates += 1;
        },
    });

    await loop.runOnce();

    assert.equal(ticks, 1);
    assert.equal(updates, 0);
});

test('records repeated deaths without eliminating or ending a running contest', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator);
        await coordinator.recordDeath(contestId, 'alice', { reason: 'fall' });
        now = 2_000;
        await coordinator.recordDeath(contestId, 'alice', { reason: 'pvp' });

        const contest = coordinator.snapshot().contests[contestId];
        assert.equal(contest.status, 'running');
        assert.equal(contest.deaths.alice, 2);
        assert.deepEqual(contest.eliminations, {});

        now = contest.deadlineAt;
        await assert.rejects(
            coordinator.recordDeath(contestId, 'alice'),
            /deadline has passed/
        );
    }, { clock: () => now });
});

test('Base Siege ends when only one competitor remains', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator, {
            participantIds: ['alice', 'bob', 'chip'],
            rules: { type: 'team_base_siege', scoring: 'last-standing' },
        });
        now = 5_000;
        await coordinator.eliminate(contestId, 'bob', { reason: 'death' });
        assert.equal(coordinator.snapshot().contests[contestId].status, 'running');
        now = 6_000;
        const completed = await coordinator.eliminate(contestId, 'chip', { reason: 'death' });
        assert.equal(completed.status, 'completed');
        assert.deepEqual(completed.winnerIds, ['alice']);
    }, { clock: () => now });
});

test('Base Siege deadlines no longer open pressure rounds by default', async () => {
    let now = 1_000;
    await withCoordinator(async ({ coordinator }) => {
        const contestId = await createAndStart(coordinator, {
            durationMs: 1_000,
            participantIds: ['alice', 'bob'],
            rules: { type: 'team_base_siege', scoring: 'last-standing' },
        });
        now = 2_500;
        const result = await coordinator.tick();
        assert.equal(result.reason, 'deadline');
        assert.equal(coordinator.snapshot().contests[contestId].status, 'completed');
    }, { clock: () => now });
});
