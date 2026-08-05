import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    COLONY_PHASES,
    ColonyCoordinator,
    EPIC_MEGABASE_MISSION,
    WELL_ROUNDED_KIT_RULE,
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
    switch (task.id) {
        case 'epic-megabase-site-hub':
            return 'Published hub at x:10 y:70 z:10 with a layout covering rooms and shared wings.';
        case 'epic-megabase-shell':
            return 'Finished megabase shell with walls, roof, floor, entrance, and lights.';
        case 'epic-megabase-agent-rooms':
            return 'Built uniquely decorated rooms with bed and chest for every agent.';
        case 'epic-megabase-themed-rooms':
            return 'Built a decorated chess room, treasure vault, trophy hall, and creative lounge.';
        case 'epic-megabase-shared-halls':
            return 'Shared crafting, storage, and armory halls are open at x:12 y:70 z:14.';
        case 'epic-megabase-food-wing':
            return 'Attached an irrigated planted crop farm wing to the megabase.';
        case 'epic-megabase-gear-supply':
            return 'Mined and smelted an iron reserve for full agent kits.';
        case 'epic-megabase-gear-equip':
            return 'Delivered the best available armor weapons and tools kit to every agent.';
        case 'epic-megabase-defenses':
            return 'Perimeter walls and torch lighting make the entrance night safe.';
        case 'bootstrap-first-food':
            return 'Built an irrigated farm with 20 planted wheat crops at x:1 y:64 z:1.';
        default:
            return `Finished ${task.title} at x:1 y:64 z:1.`;
    }
}

test('starts on epic-megabase and seeds the megabase required tasks', async () => {
    await withColony(async ({ coordinator }) => {
        assert.equal(coordinator.snapshot().phase, 'epic-megabase');
        const required = Object.values(coordinator.snapshot().tasks)
            .filter(task => task.required);
        assert.deepEqual(
            required.map(task => task.id).sort(),
            [
                'epic-megabase-agent-rooms',
                'epic-megabase-defenses',
                'epic-megabase-food-wing',
                'epic-megabase-gear-equip',
                'epic-megabase-gear-supply',
                'epic-megabase-shared-halls',
                'epic-megabase-shell',
                'epic-megabase-site-hub',
                'epic-megabase-themed-rooms',
            ]
        );
        assert.equal(coordinator.view().phase.title, 'Epic Megabase');
    });
});

test('idle directives always restate the epic megabase standing mission', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'builder');
        const directive = coordinator.directiveFor('alice');
        assert.match(directive.prompt, new RegExp(EPIC_MEGABASE_MISSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(directive.prompt, /Standing colony mission/);
        assert.equal(directive.phase, 'epic-megabase');
    });
});

test('directives require every role to stay well-rounded with swords and upgrades', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('miner', 'miner');
        const directive = coordinator.directiveFor('miner');
        assert.match(directive.prompt, new RegExp(WELL_ROUNDED_KIT_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(directive.prompt, /sword/i);
        assert.match(directive.prompt, /upgrade/i);
        assert.match(
            coordinator.snapshot().tasks['epic-megabase-gear-equip'].title,
            /sword/i
        );
    });
});

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
        assert.equal(snapshot.phase, 'epic-megabase');

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

test('migrates legacy bootstrap chicken-work onto the epic megabase mission', async () => {
    await withColony(async ({ coordinator, root }) => {
        await coordinator.registerAgent('farmer', 'farmer');
        const statePath = path.join(root, 'state.json');
        const onDisk = JSON.parse(await readFile(statePath, 'utf8'));
        onDisk.phase = 'bootstrap';
        onDisk.tasks = {
            'bootstrap-first-food': {
                id: 'bootstrap-first-food',
                title: 'Secure a renewable early food source',
                description: 'Chicken chase',
                phase: 'bootstrap',
                priority: 80,
                role: 'farmer',
                required: true,
                status: 'claimed',
                createdAt: 1,
                updatedAt: 1,
                claimedBy: 'farmer',
                leaseExpiresAt: Date.now() + 60_000,
                result: null,
                error: null,
                attempts: 1,
            },
            'chicken-uuid': {
                id: 'chicken-uuid',
                title: 'Establish chicken pen',
                description: 'Find chickens',
                phase: 'bootstrap',
                priority: 50,
                role: 'explorer',
                required: false,
                status: 'proposed',
                createdAt: 1,
                updatedAt: 1,
                claimedBy: null,
                leaseExpiresAt: null,
                result: null,
                error: null,
                attempts: 0,
            },
        };
        await writeFile(statePath, JSON.stringify(onDisk));

        const reloaded = await ColonyCoordinator.load({ root });
        const snapshot = reloaded.snapshot();
        assert.equal(snapshot.phase, 'epic-megabase');
        assert.equal(snapshot.tasks['bootstrap-first-food'].status, 'failed');
        assert.equal(snapshot.tasks['chicken-uuid'].status, 'failed');
        assert.ok(snapshot.tasks['epic-megabase-shell']);
        assert.ok(snapshot.tasks['epic-megabase-agent-rooms']);
        assert.ok(snapshot.tasks['epic-megabase-gear-equip']);
        assert.match(await readFile(path.join(root, 'plan.md'), 'utf8'), /Epic Megabase/);
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

test('enforces spawn cooldown', async () => {
    let now = 10_000;
    await withColony(async ({ coordinator }) => {
        const first = await coordinator.requestSpawn('builder', 'overseer');
        assert.equal(first.accepted, true);

        now += 5_000;
        const coolingDown = await coordinator.requestSpawn('miner', 'overseer');
        assert.equal(coolingDown.accepted, false);
        assert.equal(coolingDown.reason, 'cooldown');

        now += 5_000;
        const second = await coordinator.requestSpawn('miner', 'overseer');
        assert.equal(second.accepted, true);
    }, {
        clock: () => now,
        spawnCooldownMs: 10_000,
    });
});

test('allows registering any number of desired workers', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'builder');
        await coordinator.registerAgent('bob', 'miner');
        assert.equal(Object.keys(coordinator.snapshot().agents).length, 2);
    });
});

test('strips legacy maxAgents when loading state', async () => {
    await withColony(async ({ root, coordinator }) => {
        const state = coordinator.snapshot();
        state.maxAgents = 1;
        await writeFile(
            path.join(root, 'state.json'),
            `${JSON.stringify(state, null, 2)}\n`
        );
        const reloaded = await ColonyCoordinator.load({ root });
        assert.equal(reloaded.snapshot().maxAgents, undefined);
    });
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
        const megabaseTasks = Object.values(coordinator.snapshot().tasks)
            .filter(task => task.required);
        for (const task of megabaseTasks) {
            await coordinator.claimTask(task.id, 'alice');
            await coordinator.completeTask(task.id, 'alice', validCompletion(task));
        }

        const state = coordinator.snapshot();
        assert.equal(state.phase, 'bootstrap');
        assert.ok(
            Object.values(state.tasks).some(task =>
                task.phase === 'bootstrap' && task.status === 'proposed'
            )
        );
        assert.equal(coordinator.view().phase.title, 'Bootstrap');
    });
});

test('reconciles back to the earliest incomplete required phase', async () => {
    await withColony(async ({ coordinator }) => {
        await coordinator.registerAgent('alice', 'generalist');
        const megabaseTasks = Object.values(coordinator.snapshot().tasks)
            .filter(task => task.required);
        for (const task of megabaseTasks) {
            await coordinator.claimTask(task.id, 'alice');
            await coordinator.completeTask(task.id, 'alice', validCompletion(task));
        }
        assert.equal(coordinator.snapshot().phase, 'bootstrap');
        const bootstrapTask = Object.values(coordinator.snapshot().tasks)
            .find(task => task.phase === 'bootstrap' && task.required);
        await coordinator.claimTask(bootstrapTask.id, 'alice');
        await coordinator.reopenTask(megabaseTasks[0].id, 'Audit failed');
        assert.equal(await coordinator.reconcilePhase(), 'epic-megabase');
        assert.equal(coordinator.snapshot().tasks[bootstrapTask.id].status, 'proposed');
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
