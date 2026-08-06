import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';
import { PrivateRoomRegistry } from '../src/mindcraft/survivor/private_rooms.js';
import { SurvivorCoordinator } from '../src/mindcraft/survivor/survivor_coordinator.js';
import { SurvivorSessionManager } from '../src/mindcraft/survivor/survivor_session_manager.js';

class FakeContestCoordinator {
    constructor() {
        this.contests = {};
        this.activeContestId = null;
        this.sequence = 0;
    }

    snapshot() {
        return {
            activeContestId: this.activeContestId,
            contests: JSON.parse(JSON.stringify(this.contests)),
        };
    }

    view() {
        return {
            ...this.snapshot(),
            contests: Object.values(this.contests),
        };
    }

    createContest(specification) {
        const contest = {
            ...specification,
            id: `contest-${++this.sequence}`,
            status: 'draft',
            results: [],
            winnerIds: [],
            deadlineAt: null,
        };
        this.contests[contest.id] = contest;
        return { ...contest };
    }

    startContest(id) {
        this.activeContestId = id;
        this.contests[id].status = 'running';
        this.contests[id].deadlineAt = 10000;
        return { ...this.contests[id] };
    }

    complete(id, winnerId) {
        this.activeContestId = null;
        this.contests[id].status = 'completed';
        this.contests[id].winnerIds = [winnerId];
        this.contests[id].results = [{
            participantId: winnerId,
            score: 1,
            details: {},
        }];
    }

    completeCurrent(manager, winnerId) {
        const contestId = manager.view().challengeContestId;
        const contest = this.contests[contestId];
        this.complete(contestId, winnerId ?? contest.participantIds[0]);
        return contestId;
    }

    cancelContest(id) {
        this.activeContestId = null;
        this.contests[id].status = 'cancelled';
    }
}

function participants(count = 11) {
    return Array.from({ length: count }, (_, index) => ({
        name: `Bot${index + 1}`,
        profileId: 'test',
        voice: '',
        systemPrompt: `Personality ${index + 1}`,
    }));
}

async function createManager() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'survivor-session-'));
    const coordinator = await SurvivorCoordinator.create({ root, random: () => 0 });
    const contestCoordinator = new FakeContestCoordinator();
    let now = 0;
    const directives = [];
    const options = {
        coordinator,
        contestCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => 'room-1' }),
        getProfiles: () => [{
            id: 'test',
            configured: true,
            model: 'test-model',
            provider: 'test',
            profile: {},
        }],
        getExistingAgentNames: () => [],
        resolveParticipantVoice: (_name, voice) => voice,
        reclaimNames: () => Promise.resolve(),
        buildAgentSettings: profile => ({ profile }),
        createAgent: settings => ({
            success: true,
            agentId: `agent-${settings.profile.name}`,
        }),
        destroyAgent: () => Promise.resolve(),
        isAgentReady: () => true,
        getContestPreset: getContestGamePreset,
        prepareArena: () => ({}),
        sendDirective: (id, prompt) => directives.push({ id, prompt }),
        sendChallengeConfig: () => Promise.resolve(),
        phaseDurationsMs: {
            strategy: 1,
            voting: 1,
            revote: 1,
            deadlock: 1,
            jury_questioning: 1,
            jury_voting: 1,
        },
        clock: () => now,
        sleep: () => Promise.resolve(),
    };
    const manager = new SurvivorSessionManager(options);
    return {
        root,
        options,
        manager,
        coordinator,
        contestCoordinator,
        directives,
        advance: milliseconds => {
            now += milliseconds;
        },
    };
}

test('provisions a persistent roster and starts a team challenge', async () => {
    const { manager, coordinator, contestCoordinator, directives } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    assert.equal(manager.view().createdAgents.length, 11);
    assert.equal(coordinator.view().phase, 'challenge');
    assert.ok(contestCoordinator.activeContestId);
    assert.ok(directives.some(item => item.prompt.includes('Tribe:')));
});

test('starts a four-player season already merged', async () => {
    const { manager, coordinator, contestCoordinator, directives } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    assert.equal(manager.view().createdAgents.length, 4);
    assert.equal(coordinator.view().merged, true);
    assert.equal(
        contestCoordinator.contests[manager.view().challengeContestId].metadata.survivorMode,
        'individual'
    );
    // Nobody should be told they have a tribe in a season that never had one.
    assert.ok(directives.every(item => !item.prompt.includes('Tribe:')));
    assert.ok(directives.some(item => item.prompt.includes('no tribes')));
});

test('a four-player season runs end to end to a two-juror finale', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race', 'tower_battle'],
    });

    const phases = [];
    for (let step = 0; step < 20; step++) {
        const game = coordinator.view();
        if (game.status !== 'running') break;
        if (game.phase === 'challenge') {
            contestCoordinator.completeCurrent(manager, 'Bot1');
            await manager.syncContestView(contestCoordinator.view());
        } else {
            advance(2);
            await manager.tick();
        }
        phases.push(coordinator.view().phase);
    }

    const final = coordinator.view();
    assert.equal(final.status, 'completed');
    assert.equal(final.round, 2, 'four players owe the jury two Tribal Councils');
    assert.equal(final.juryIds.length, 2);
    assert.equal(final.finalistIds.length, 2);
    assert.deepEqual(final.winnerIds, ['Bot1']);
    assert.ok(
        Object.values(final.players).every(player => Number.isInteger(player.placement)),
        'every player is ranked when the season ends'
    );
    assert.deepEqual(
        [...new Set(phases)].filter(phase => phase !== 'challenge'),
        ['strategy', 'voting', 'jury_questioning', 'jury_voting', 'completed']
    );
    assert.equal(manager.view().status, 'completed');
});

test('challenge result opens strategy and timeout opens secret voting', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    const contestId = manager.view().challengeContestId;
    contestCoordinator.complete(contestId, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    assert.equal(coordinator.view().phase, 'strategy');
    assert.equal(coordinator.view().councilTribe, 'Tide');

    advance(2);
    await manager.tick();
    assert.equal(coordinator.view().phase, 'voting');
    assert.ok(coordinator.view().eligibleVoterIds.every(
        id => coordinator.view().players[id].tribe === 'Tide'
    ));
});

test('agent commands keep ballot contents private from status responses', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.complete(manager.view().challengeContestId, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    advance(2);
    await manager.tick();
    const state = coordinator.view();
    const voterId = state.eligibleVoterIds[0];
    const targetId = state.eligibleTargetIds.find(id => id !== voterId);
    await manager.handleAgentCommand(voterId, 'cast-vote', { targetId });
    const status = await manager.handleAgentCommand(voterId, 'status');
    assert.equal(status.data.ballotReceived, true);
    assert.ok(!Object.hasOwn(status.data, 'ballots'));
    assert.deepEqual(manager.view().game.ballots, {});
    assert.equal(manager.view().game.ballotCount, 1);
});

test('failed challenge resolution remains retryable', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    const contestId = manager.view().challengeContestId;
    contestCoordinator.complete(contestId, undefined);
    await assert.rejects(
        manager.syncContestView(contestCoordinator.view()),
        /without a winner/
    );
    assert.equal(manager.view().challengeContestId, contestId);
});

test('recovers a running season from persisted coordinator and session state', async () => {
    const { manager, root, options } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    await manager._persistOperation;

    const recoveredCoordinator = await SurvivorCoordinator.load({
        root,
        random: () => 0,
    });
    const recovered = new SurvivorSessionManager({
        ...options,
        coordinator: recoveredCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => 'recovered-room' }),
    });
    const view = await recovered.recover();
    assert.equal(view.id, manager.view().id);
    assert.equal(view.game.phase, 'challenge');
    assert.equal(view.participantIds.length, 11);
});

test('recovery respawns every reachable bot even when one fails to launch', async () => {
    const { manager, root, options } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    await manager._persistOperation;

    const attempted = [];
    let clock = 0;
    const recovered = new SurvivorSessionManager({
        ...options,
        coordinator: await SurvivorCoordinator.load({ root, random: () => 0 }),
        rooms: new PrivateRoomRegistry({ idFactory: () => 'recovered-room' }),
        isAgentReady: name => name !== 'Bot3',
        clock: () => clock,
        sleep: () => {
            clock += 500;
            return Promise.resolve();
        },
        createAgent: settings => {
            attempted.push(settings.profile.name);
            return settings.profile.name === 'Bot3'
                ? { success: false, error: 'spawn refused' }
                : { success: true, agentId: `agent-${settings.profile.name}` };
        },
    });

    await assert.rejects(recovered.recover(), /Bot3/);
    assert.deepEqual(attempted, ['Bot3']);
    assert.equal(recovered.lastFailure.stage, 'recovery');
    assert.match(recovered.lastFailure.error, /did not join/);
    assert.ok(recovered.lastFailure.agents.some(agent => agent.name === 'Bot3'));
});

test('provisioning reports which bots the season is still waiting on', async () => {
    const { options, coordinator, contestCoordinator } = await createManager();
    let clock = 0;
    const updates = [];
    const manager = new SurvivorSessionManager({
        ...options,
        coordinator,
        contestCoordinator,
        isAgentReady: name => name !== 'Bot3',
        clock: () => clock,
        sleep: () => {
            clock += 500;
            return Promise.resolve();
        },
        onUpdate: view => updates.push(view),
    });

    await assert.rejects(manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    }));

    const progress = updates.map(view => view?.readiness).filter(Boolean);
    assert.ok(progress.length > 0, 'readiness progress is broadcast while provisioning');
    const latest = progress.at(-1);
    assert.equal(latest.stage, 'startup');
    assert.equal(latest.total, 4);
    assert.equal(latest.ready, 3);
    assert.deepEqual(latest.pending, ['Bot3']);
});

test('readiness failures name the stuck bots and their launch stage', async () => {
    const { options, coordinator, contestCoordinator } = await createManager();
    let clock = 0;
    const manager = new SurvivorSessionManager({
        ...options,
        coordinator,
        contestCoordinator,
        isAgentReady: name => name !== 'Bot7',
        clock: () => clock,
        sleep: () => {
            clock += 500;
            return Promise.resolve();
        },
        getAgentLaunchStatus: name => (name === 'Bot7'
            ? { name, registered: true, socketConnected: true, inGame: false }
            : { name, registered: true, socketConnected: true, inGame: true }),
    });

    await assert.rejects(
        manager.start({
            participants: participants(),
            mergeAt: 10,
            challengeGameIds: ['cake_race'],
        }),
        /Bot7 \(connected, never joined Minecraft\)/
    );
    assert.equal(manager.lastFailure.stage, 'startup');
});
