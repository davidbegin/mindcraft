import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ContestCoordinator } from '../src/mindcraft/contest/contest_coordinator.js';
import { measureTowers, scoreTowerBattle } from '../src/mindcraft/contest/tower_scoring.js';

const FLOOR_Y = 100;

function pillar(x, z, height, startY = FLOOR_Y + 1) {
    return Array.from({ length: height }, (_, index) => ({
        x,
        y: startY + index,
        z,
    }));
}

test('the tallest standing tower wins without anyone submitting', () => {
    const results = scoreTowerBattle({
        floorY: FLOOR_Y,
        participantIds: ['sky', 'ground'],
        reports: [
            { participantId: 'sky', blocks: pillar(10, 10, 42) },
            { participantId: 'ground', blocks: pillar(-10, -10, 7) },
        ],
    });

    assert.deepEqual(
        results.map(result => [result.participantId, result.score, result.disqualified]),
        [['sky', 42, false], ['ground', 7, false]]
    );
    assert.equal(results[0].details.measuredFrom, 'placed-blocks');
});

test('a shared tower belongs to whoever laid the most of its blocks', () => {
    const results = scoreTowerBattle({
        floorY: FLOOR_Y,
        participantIds: ['helper', 'builder'],
        reports: [
            { participantId: 'builder', blocks: pillar(0, 0, 20) },
            { participantId: 'helper', blocks: pillar(1, 0, 4) },
        ],
    });

    const byId = new Map(results.map(result => [result.participantId, result]));
    assert.equal(byId.get('builder').score, 20);
    assert.equal(byId.get('helper').score, 0);
    assert.equal(byId.get('helper').details.measuredFrom, 'helped-another-tower');
    assert.equal(byId.get('helper').details.blocksStanding, 4);
    assert.deepEqual(byId.get('builder').details.contributions, { builder: 20, helper: 4 });
});

test('towers far apart stay separate and floor blocks are ignored', () => {
    const towers = measureTowers({
        floorY: FLOOR_Y,
        reports: [
            {
                participantId: 'a',
                blocks: [
                    ...pillar(0, 0, 12),
                    ...pillar(0, 0, 1, FLOOR_Y),
                    ...pillar(30, 30, 5),
                ],
            },
        ],
    });

    assert.deepEqual(towers.map(tower => tower.height), [12, 5]);
});

test('falls back to the pillar a bot is standing on when placements were missed', () => {
    const [result] = scoreTowerBattle({
        floorY: FLOOR_Y,
        participantIds: ['reconnected'],
        reports: [
            {
                participantId: 'reconnected',
                blocks: [],
                standingOn: { x: 4, y: FLOOR_Y + 31, z: 4 },
            },
        ],
    });

    assert.equal(result.score, 31);
    assert.equal(result.details.measuredFrom, 'standing-pillar');
});

test('bots that built nothing score zero instead of being disqualified', () => {
    const [result] = scoreTowerBattle({
        floorY: FLOOR_Y,
        participantIds: ['idle'],
        reports: [{ participantId: 'idle', blocks: [], standingOn: { x: 0, y: FLOOR_Y, z: 0 } }],
    });

    assert.equal(result.score, 0);
    assert.equal(result.disqualified, false);
    assert.equal(result.details.measuredFrom, 'no-tower');
});

test('a contest judged from tower measurements completes with a winner at the deadline', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-tower-'));
    let now = 1_000;
    try {
        const coordinator = await ContestCoordinator.create({
            root,
            clock: () => now,
            idFactory: () => 'tower-1',
            judge: contest => scoreTowerBattle({
                floorY: FLOOR_Y,
                participantIds: contest.participantIds,
                reports: [
                    { participantId: 'stacky', blocks: pillar(0, 0, 61) },
                    { participantId: 'brawler', blocks: [] },
                ],
            }),
        });
        const contest = await coordinator.createContest({
            title: 'Tallest Tower',
            prompt: 'Build high.',
            durationMs: 5_000,
            participantIds: ['stacky', 'brawler'],
            rules: { type: 'tower_battle', scoring: 'tallest-standing-tower' },
        });
        await coordinator.startContest(contest.id);
        now += 6_000;
        await coordinator.tick();

        const finished = coordinator.snapshot().contests[contest.id];
        assert.equal(finished.status, 'completed');
        assert.deepEqual(finished.winnerIds, ['stacky']);
        assert.deepEqual(finished.submissions, {});
        assert.equal(finished.results[0].score, 61);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
