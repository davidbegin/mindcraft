import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    COLONY_PHASES,
    ColonyCoordinator,
} from '../src/mindcraft/colony/colony_coordinator.js';

async function withColony(run, options = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-colony-'));
    let sequence = 0;
    try {
        const coordinator = await ColonyCoordinator.create({
            root,
            idFactory: () => `id-${++sequence}`,
            ...options,
        });
        await run({ coordinator, root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function validCompletion(task) {
    if (task.id === 'bootstrap-first-food') {
        return 'Built an irrigated farm with 20 planted wheat crops at x:1 y:64 z:1.';
    }
    return `Finished ${task.title} at x:1 y:64 z:1.`;
}

test('persists state, plan, journal, and reloads a snapshot', async () => {
    await withColony(async ({ coordinator, root }) => {
        await coordinator.registerAgent('alice', 'builder');
        const task = await coordinator.proposeTask({
            id: 'safe-house',
            title: 'Build a safe house',
            priority: 10,
        });
        await coordinator.claimTask(task.id, 'alice');
        await coordinator.writeArtifact('notes/settlement.md', '# Settlement\n');

        const reloaded = await ColonyCoordinator.load({ root });
        const snapshot = reloaded.snapshot();
        assert.equal(snapshot.agents.alice.role, 'builder');
        assert.equal(snapshot.tasks['safe-house'].claimedBy, 'alice');
        assert.equal(snapshot.phase, 'bootstrap');

        const stateOnDisk = JSON.parse(await readFile(path.join(root, 'state.json')));
        assert.deepEqual(stateOnDisk, snapshot);
        assert.match(await readFile(path.join(root, 'plan.md'), 'utf8'), /safe-house/);
        assert.equal(
            await readFile(path.join(root, 'notes/settlement.md'), 'utf8'),
            '# Settlement\n'
        );

        const journal = (await readFile(path.join(root, 'journal.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map(line => JSON.parse(line));
        assert.deepEqual(
            journal.map(event => event.type),
            [
                'colony.initialized',
                'agent.registered',
                'task.proposed',
                'task.claimed',
                'artifact.written',
            ]
        );
    });
});

test('records why the colony paused and surfaces it to agents and reloads', async () => {
    await withColony(async ({ coordinator, root }) => {
        await coordinator.registerAgent('alice', 'miner');
        assert.equal(coordinator.snapshot().pauseReason, null);

        await coordinator.pause('Model provider quota exhausted: no credits remaining');
        const paused = coordinator.snapshot();
        assert.equal(paused.paused, true);
        assert.equal(paused.pauseReason, 'Model provider quota exhausted: no credits remaining');

        const directive = coordinator.directiveFor('alice');
        assert.equal(directive.paused, true);
        assert.equal(directive.pauseReason, 'Model provider quota exhausted: no credits remaining');
        assert.match(directive.instruction, /no credits remaining/);
        assert.match(await readFile(path.join(root, 'plan.md'), 'utf8'), /paused \(Model provider quota/);

        // The reason has to survive a restart so a fresh MindServer still shows the outage.
        const reloaded = await ColonyCoordinator.load({ root });
        assert.equal(reloaded.snapshot().pauseReason, 'Model provider quota exhausted: no credits remaining');

        await reloaded.resume();
        assert.equal(reloaded.snapshot().paused, false);
        assert.equal(reloaded.snapshot().pauseReason, null);
    });
});

test('defaults a missing pauseReason when loading pre-existing colony state', async () => {
    await withColony(async ({ coordinator, root }) => {
        await coordinator.registerAgent('alice', 'miner');
        const statePath = path.join(root, 'state.json');
        const onDisk = JSON.parse(await readFile(statePath, 'utf8'));
        delete onDisk.pauseReason;
        await writeFile(statePath, JSON.stringify(onDisk));

        const reloaded = await ColonyCoordinator.load({ root });
        assert.equal(reloaded.snapshot().pauseReason, null);
    });
});

test('expires task leases and permits a new claimant', async () => {
    let now = 1_000;
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'miner');
        await coordinator.registerAgent('bob', 'builder');
        await coordinator.proposeTask({ id: 'iron', title: 'Mine iron' });
        await coordinator.claimTask('iron', 'alice', 100);

        now = 1_101;
        const expired = await coordinator.expireLeases();
        assert.deepEqual(expired, ['iron']);

        const claimed = await coordinator.claimTask('iron', 'bob');
        assert.equal(claimed.claimedBy, 'bob');
        await assert.rejects(
            coordinator.completeTask('iron', 'alice', 'late'),
            /not claimed by this agent/
        );
    }, { clock: () => now });
});

test('heartbeats renew leases for active work', async () => {
    let now = 1_000;
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'miner');
        await coordinator.proposeTask({ id: 'iron', title: 'Mine iron' });
        await coordinator.claimTask('iron', 'alice', 100);
        now = 1_050;
        await coordinator.heartbeat('alice', 'busy');
        now = 1_149;
        assert.deepEqual(await coordinator.expireLeases(), []);
        assert.equal(coordinator.snapshot().tasks.iron.status, 'claimed');
    }, { clock: () => now, leaseMs: 100 });
});

test('rejects partial completion language and supports reopening bad results', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'builder');
        await coordinator.proposeTask({ id: 'beds', title: 'Build beds' });
        await coordinator.claimTask('beds', 'alice');
        await assert.rejects(
            coordinator.completeTask('beds', 'alice', 'Found one wool; hunting continues to finish the beds.'),
            /unfinished work/
        );
        await coordinator.completeTask('beds', 'alice', 'Crafted and placed all required beds at x:1 y:64 z:1.');
        const reopened = await coordinator.reopenTask('beds', 'Independent audit found only one bed');
        assert.equal(reopened.status, 'proposed');
        assert.equal(reopened.claimedBy, null);
    });
});

test('rejects artifact path traversal and absolute paths', async () => {
    await withColony(async ({ coordinator, root }) => {
        await assert.rejects(
            coordinator.writeArtifact('../escape.txt', 'no'),
            /must remain within/
        );
        await assert.rejects(
            coordinator.writeArtifact('notes/../../escape.txt', 'no'),
            /must remain within/
        );
        await assert.rejects(
            coordinator.writeArtifact(path.join(root, 'absolute.txt'), 'no'),
            /must remain within/
        );
        await assert.rejects(
            coordinator.writeArtifact('other/file.txt', 'no'),
            /must remain within/
        );
    });
});

test('advances through every survival phase without skipping', async () => {
    await withColony(async ({ coordinator }) => {
        assert.equal(coordinator.snapshot().phase, COLONY_PHASES[0]);
        await assert.rejects(
            coordinator.advancePhase('iron-age'),
            /exactly one step/
        );

        for (const expected of COLONY_PHASES.slice(1)) {
            assert.equal(await coordinator.advancePhase(), expected);
        }
        await assert.rejects(coordinator.advancePhase(), /No valid next phase/);
        assert.equal(
            coordinator.snapshot().phase,
            'postgame-civilization'
        );
    });
});

test('enforces spawn cooldown and maxAgents cap', async () => {
    let now = 10_000;
    await withColony(async ({ coordinator }) => {
        const first = await coordinator.requestSpawn('builder', 'overseer');
        assert.equal(first.accepted, true);

        now += 5_000;
        const cappedByPendingRequest = await coordinator.requestSpawn('miner', 'overseer');
        assert.deepEqual(cappedByPendingRequest, {
            accepted: false,
            reason: 'max-agents',
        });

        await coordinator.resolveSpawnRequest(first.request.id, 'failed');
        const coolingDown = await coordinator.requestSpawn('miner', 'overseer');
        assert.equal(coolingDown.accepted, false);
        assert.equal(coolingDown.reason, 'cooldown');

        now += 5_000;
        const second = await coordinator.requestSpawn('miner', 'overseer');
        assert.equal(second.accepted, true);
    }, {
        clock: () => now,
        maxAgents: 1,
        spawnCooldownMs: 10_000,
    });
});

test('rejects registering more than maxAgents desired workers', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'builder');
        await assert.rejects(
            coordinator.registerAgent('bob', 'miner'),
            /Agent cap reached/
        );
    }, { maxAgents: 1 });
});

test('applies an updated maxAgents setting when loading state', async () => {
    await withColony(async ({ root }) => {
        const reloaded = await ColonyCoordinator.load({ root, maxAgents: 3 });
        assert.equal(reloaded.snapshot().maxAgents, 3);
    }, { maxAgents: 8 });
});

test('re-registration preserves an explicit stopped state', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'builder');
        await coordinator.updateAgent('alice', { desired: false, status: 'stopped' });
        const registered = await coordinator.registerAgent(
            'alice',
            'builder',
            'spawning',
            { desired: true }
        );
        assert.equal(registered.desired, false);
        assert.equal(registered.status, 'stopped');
    });
});

test('serializes competing claim-next requests', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'builder');
        await coordinator.registerAgent('bob', 'builder');
        const taskIds = Object.keys(coordinator.snapshot().tasks);
        for (const taskId of taskIds.slice(1)) {
            await coordinator.claimTask(taskId, 'alice');
            await coordinator.completeTask(taskId, 'alice', validCompletion(
                coordinator.snapshot().tasks[taskId]
            ));
        }
        const results = await Promise.allSettled([
            coordinator.claimNextTask('alice'),
            coordinator.claimNextTask('bob'),
        ]);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    });
});

test('automatically advances after every required phase task completes', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'generalist');
        await coordinator.proposeTask({ id: 'optional-road', title: 'Mark a future road' });
        const bootstrapTasks = Object.values(coordinator.snapshot().tasks)
            .filter(task => task.required);
        for (const task of bootstrapTasks) {
            await coordinator.claimTask(task.id, 'alice');
            await coordinator.completeTask(task.id, 'alice', validCompletion(task));
        }

        const state = coordinator.snapshot();
        assert.equal(state.phase, 'shelter');
        assert.ok(
            Object.values(state.tasks).some(task =>
                task.phase === 'shelter' && task.status === 'proposed'
            )
        );
        assert.equal(coordinator.view().phase.title, 'Shelter and Logistics');
    });
});

test('reconciles back to the earliest incomplete required phase', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'generalist');
        const bootstrapTasks = Object.values(coordinator.snapshot().tasks)
            .filter(task => task.required);
        for (const task of bootstrapTasks) {
            await coordinator.claimTask(task.id, 'alice');
            await coordinator.completeTask(task.id, 'alice', validCompletion(task));
        }
        assert.equal(coordinator.snapshot().phase, 'shelter');
        const shelterTask = Object.values(coordinator.snapshot().tasks)
            .find(task => task.phase === 'shelter');
        await coordinator.claimTask(shelterTask.id, 'alice');
        await coordinator.reopenTask(bootstrapTasks[0].id, 'Audit failed');
        assert.equal(await coordinator.reconcilePhase(), 'bootstrap');
        assert.equal(coordinator.snapshot().tasks[shelterTask.id].status, 'proposed');
    });
});

test('cycles postgame civilization into a new epoch', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'generalist');
        for (const phase of COLONY_PHASES.slice(1)) {
            await coordinator.advancePhase(phase);
        }
        const postgameTasks = Object.values(coordinator.snapshot().tasks)
            .filter(task => task.phase === 'postgame-civilization');
        for (const task of postgameTasks) {
            await coordinator.claimTask(task.id, 'alice');
            await coordinator.completeTask(task.id, 'alice', `completed ${task.id}`);
        }

        const state = coordinator.snapshot();
        assert.equal(state.phase, 'postgame-civilization');
        assert.equal(state.epoch, 2);
        assert.ok(Object.keys(state.tasks).some(id => id.endsWith('-e2')));
    });
});
