import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TowerHighScoreStore } from '../src/mindcraft/contest/tower_high_scores.js';

function completedContest(overrides = {}) {
    return {
        id: 'tower-1',
        status: 'completed',
        rules: { type: 'tower_battle' },
        startedAt: 1_000,
        deadlineAt: 151_000,
        completedAt: 152_000,
        metadata: {
            gameSession: {
                participants: [
                    { name: 'stacky', model: 'model-tall' },
                    { name: 'quick', model: 'model-fast' },
                ],
            },
        },
        results: [
            { participantId: 'stacky', score: 42, disqualified: false },
            { participantId: 'quick', score: 18, disqualified: false },
        ],
        ...overrides,
    };
}

test('persists model, tower height, and elapsed seconds locally', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-high-scores-'));
    try {
        const store = await TowerHighScoreStore.create({ root });
        const additions = await store.recordContest(completedContest());

        assert.equal(additions.length, 2);
        assert.deepEqual(
            store.list().map(({ model, height, seconds }) => ({
                model,
                height,
                seconds,
            })),
            [
                { model: 'model-tall', height: 42, seconds: 150 },
                { model: 'model-fast', height: 18, seconds: 150 },
            ]
        );

        const persisted = JSON.parse(await readFile(
            path.join(root, 'tower_high_scores.json'),
            'utf8'
        ));
        assert.equal(persisted.scores[0].model, 'model-tall');
        assert.equal(persisted.scores[0].height, 42);
        assert.equal(persisted.scores[0].seconds, 150);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('reloads scores, avoids duplicates, and uses time to break height ties', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-high-scores-'));
    try {
        const store = await TowerHighScoreStore.create({ root });
        await store.recordContest(completedContest());

        const reloaded = await TowerHighScoreStore.create({ root });
        assert.deepEqual(await reloaded.recordContest(completedContest()), []);
        await reloaded.recordContest(completedContest({
            id: 'tower-2',
            deadlineAt: 121_000,
            completedAt: 121_000,
            metadata: {
                gameSession: {
                    participants: [{ name: 'speedy', model: 'model-speedy' }],
                },
            },
            results: [
                { participantId: 'speedy', score: 42, disqualified: false },
            ],
        }));

        assert.deepEqual(
            reloaded.list().slice(0, 2).map(score => [
                score.model,
                score.height,
                score.seconds,
            ]),
            [
                ['model-speedy', 42, 120],
                ['model-tall', 42, 150],
            ]
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('ignores unfinished and non-tower contests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-high-scores-'));
    try {
        const store = await TowerHighScoreStore.create({ root });
        assert.deepEqual(
            await store.recordContest(completedContest({ status: 'running' })),
            []
        );
        assert.deepEqual(
            await store.recordContest(completedContest({
                id: 'race-1',
                rules: { type: 'diamond_race' },
            })),
            []
        );
        assert.deepEqual(store.list(), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
