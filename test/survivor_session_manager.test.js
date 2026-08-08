import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';
import { ConversationRequestRegistry } from '../src/mindcraft/survivor/conversation_requests.js';
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

// Bots reach a private room by asking and being told yes, so tests that only
// care about the room still have to walk through the negotiation.
async function openPrivateRoom(manager, requesterId, inviteeIds, options = {}) {
    const opened = await manager.handleAgentCommand(requesterId, 'talk-request', {
        inviteeIds,
        pitch: options.pitch,
    });
    const requestId = opened.data.requestId;
    for (const inviteeId of inviteeIds) {
        await manager.handleAgentCommand(inviteeId, 'talk-respond', {
            requestId,
            accepted: options.declineIds ? !options.declineIds.includes(inviteeId) : true,
            reason: options.reason,
        });
    }
    return requestId;
}

async function createManager() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'survivor-session-'));
    const coordinator = await SurvivorCoordinator.create({ root, random: () => 0 });
    const contestCoordinator = new FakeContestCoordinator();
    let now = 0;
    const directives = [];
    const notifications = [];
    let requestSequence = 0;
    const options = {
        coordinator,
        contestCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => 'room-1' }),
        conversations: new ConversationRequestRegistry({
            idFactory: () => `talk-${++requestSequence}`,
        }),
        notifyAgent: (id, event, payload) => {
            notifications.push({ id, event, payload });
            return Promise.resolve({ success: true });
        },
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
            tribal_council: 1,
            jury_voting: 1,
        },
        clock: () => now,
        sleep: () => Promise.resolve(),
    };
    const manager = new SurvivorSessionManager(options);
    manager.rooms.onEvent = event => manager.recordRoomEvent(event);
    manager.conversations.onEvent = event => manager.recordConversationEvent(event);
    return {
        root,
        options,
        manager,
        coordinator,
        contestCoordinator,
        directives,
        notifications,
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
    assert.ok(directives.some(item => item.prompt.includes('tribes have merged')));
});

test('a four-player season runs end to end to a two-juror finale', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race', 'tower_battle'],
        councilAutoAdvance: true,
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
        ['strategy', 'tribal_council', 'voting', 'jury_questioning', 'jury_voting', 'completed']
    );
    assert.equal(manager.view().status, 'completed');
});

test('strategy leads to Tribal Council, and only the host opens voting', async () => {
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
    assert.equal(coordinator.view().phase, 'tribal_council');
    assert.ok(coordinator.view().eligibleVoterIds.every(
        id => coordinator.view().players[id].tribe === 'Tide'
    ));
    // No clock on council by default, so the season waits for the host.
    assert.equal(manager.view().phaseDeadlineAt, null);
    advance(60_000);
    await manager.tick();
    assert.equal(coordinator.view().phase, 'tribal_council', 'council does not time out');

    await manager.control('end-council');
    assert.equal(coordinator.view().phase, 'voting');
});

test('nobody can vote while Tribal Council is still in session', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    advance(2);
    await manager.tick();
    assert.equal(coordinator.view().phase, 'tribal_council');

    await assert.rejects(
        manager.handleAgentCommand('Bot2', 'cast-vote', { targetId: 'Bot3' }),
        /not accepted during tribal_council/
    );

    await manager.control('end-council');
    const accepted = await manager.handleAgentCommand('Bot2', 'cast-vote', { targetId: 'Bot3' });
    assert.equal(accepted.success, true);
});

test('the host questions players and every other bot hears the answer', async () => {
    const { manager, coordinator, contestCoordinator, notifications, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    advance(2);
    await manager.tick();

    const asked = await manager.control('council-question', {
        prompt: 'Who here has been playing you?',
        targetIds: ['Bot2', 'Bot3'],
    });
    const questionId = asked.lastQuestion.questionId;
    assert.deepEqual(asked.lastQuestion.targetIds, ['Bot2', 'Bot3']);
    assert.deepEqual(
        notifications
            .filter(item => item.event === 'survivor-council-question')
            .map(item => item.id),
        ['Bot2', 'Bot3']
    );

    await manager.handleAgentCommand('Bot2', 'council-answer', {
        answer: 'Bot4 has been running this whole thing.',
    });

    // The answer is public, so everyone still in the game is told about it.
    const heard = notifications
        .filter(item => item.event === 'survivor-council-answer')
        .map(item => item.id);
    assert.deepEqual(heard.sort(), ['Bot1', 'Bot3', 'Bot4']);

    const council = manager.view().council;
    const question = council.questions.find(item => item.id === questionId);
    assert.deepEqual(question.answers.map(item => item.playerId), ['Bot2']);
    assert.deepEqual(question.pendingIds, ['Bot3'], 'the host can see who still owes an answer');

    // And the answer reaches the next round of prompts as remembered history.
    assert.match(
        manager.briefingFor('Bot4', coordinator.view()),
        /Bot4 has been running this whole thing/
    );
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
    await manager.control('end-council');
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

test('reordering the deck rewrites only the challenges still to come', async () => {
    const { manager } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race', 'tower_battle', 'dog_race'],
    });
    // The opening challenge already dealt itself off the top of the deck.
    const played = manager.view().challengeDeck.slice(0, manager.view().challengeIndex);
    assert.equal(played.length, 1);

    await manager.control('set-challenge-deck', {
        gameIds: ['dog_race', 'cake_race'],
    });

    const view = manager.view();
    assert.deepEqual(view.challengeDeck, [...played, 'dog_race', 'cake_race']);
    assert.deepEqual(
        view.upcomingChallenges.map(item => item.gameId),
        ['dog_race', 'cake_race']
    );
    assert.deepEqual(
        view.upcomingChallenges.map(item => item.round),
        [1, 2]
    );
});

test('rejects a deck that names a game nobody has a preset for', async () => {
    const { manager } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    const before = manager.view().challengeDeck;

    await assert.rejects(
        manager.control('set-challenge-deck', { gameIds: ['cake_race', 'not_a_game'] }),
        /not_a_game/
    );
    await assert.rejects(
        manager.control('set-challenge-deck', { gameIds: [] }),
        /non-empty array/
    );
    assert.deepEqual(manager.view().challengeDeck, before);
});

test('remembers private rooms after they close so alliances stay visible', async () => {
    const { manager, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    await openPrivateRoom(manager, 'Bot2', ['Bot3']);
    await manager.handleAgentCommand('Bot2', 'room-send', { message: 'final two?' });

    assert.equal(manager.view().rooms.length, 1);
    advance(2);
    await manager.tick();
    assert.equal(manager.view().rooms.length, 0, 'voting closes the room');

    const [history] = manager.roomHistory;
    assert.deepEqual(history.memberIds.sort(), ['Bot2', 'Bot3']);
    assert.equal(history.messageCount, 1);
    assert.ok(history.closedAt != null);

    const edge = manager.view().relationships.edges.find(item =>
        item.a === 'Bot2' && item.b === 'Bot3'
    );
    assert.equal(edge.roomsShared, 1);
    assert.equal(edge.messagesExchanged, 1);
});

test('a private room opening pushes a fresh view to the dashboard', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    const updates = [];
    manager.onUpdate = view => updates.push(view);
    await openPrivateRoom(manager, 'Bot2', ['Bot3']);

    // Without this the rooms panel would not notice until the phase changed.
    assert.ok(updates.length > 0, 'room events refresh the operator view');
    assert.equal(updates.at(-1).rooms.length, 1);
});

test('keeps a replayable secret feed and caps how far back it goes', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    manager.secretEventLimit = 3;
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    await openPrivateRoom(manager, 'Bot2', ['Bot3']);
    for (const message of ['one', 'two', 'three']) {
        await manager.handleAgentCommand('Bot2', 'room-send', { message });
    }

    const events = manager.secretEvents();
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(event => event.message), ['one', 'two', 'three']);
    assert.equal(events[0].round, 1);
});

test('a new season starts from an empty feed and relationship graph', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    await openPrivateRoom(manager, 'Bot2', ['Bot3']);
    assert.ok(manager.secretEvents().length > 0);

    await manager.cancel('done');
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    assert.deepEqual(manager.secretEvents(), []);
    assert.deepEqual(manager.roomHistory, []);
    assert.deepEqual(manager.view().relationships.edges, []);
});

test('a refused conversation opens no room and the requester is told who froze them out', async () => {
    const { manager, contestCoordinator, notifications } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    const asked = await manager.handleAgentCommand('Bot2', 'talk-request', {
        inviteeIds: ['Bot3', 'Bot4'],
        pitch: 'final three, right now',
    });
    const requestId = asked.data.requestId;
    assert.deepEqual(
        notifications.filter(item => item.event === 'survivor-talk-request').map(item => item.id),
        ['Bot3', 'Bot4']
    );

    await manager.handleAgentCommand('Bot3', 'talk-respond', { requestId, accepted: true });
    assert.equal(manager.view().rooms.length, 0, 'the room waits until everyone has answered');

    await manager.handleAgentCommand('Bot4', 'talk-respond', {
        requestId,
        accepted: false,
        reason: 'I am not working with you',
    });

    const [room] = manager.view().rooms;
    assert.deepEqual(room.memberIds.sort(), ['Bot2', 'Bot3'], 'only Bot3 accepted');
    const resolution = notifications.find(item =>
        item.event === 'survivor-talk-resolved' && item.id === 'Bot2'
    );
    assert.deepEqual(resolution.payload.declinerIds, ['Bot4']);
    assert.equal(resolution.payload.reasons.Bot4, 'I am not working with you');

    // Bot2 remembers the refusal; Bot1 never hears about it.
    assert.match(manager.briefingFor('Bot2'), /Bot4 refused to talk to you/);
    assert.doesNotMatch(manager.briefingFor('Bot1'), /refused to talk/);
});

test('an unanswered chat request expires into a refusal', async () => {
    const { manager, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    // Hold strategy open so the tick only sweeps the request rather than also
    // ending the phase, which would clear the board.
    await manager.control('set-phase-deadline', { seconds: null });
    manager.conversations.requestTtlMs = 10;
    await manager.handleAgentCommand('Bot2', 'talk-request', { inviteeIds: ['Bot3'] });
    assert.equal(manager.view().conversationRequests[0].status, 'pending');

    advance(1000);
    await manager.tick();

    assert.equal(manager.view().conversationRequests[0].status, 'declined');
    assert.equal(manager.view().rooms.length, 0, 'silence opens nothing');
});

test('closing council leaves the record available to the bots who then vote', async () => {
    const { manager, coordinator, contestCoordinator, directives, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    advance(2);
    await manager.tick();

    await manager.control('council-question', {
        prompt: 'Who is running this game?',
        targetIds: ['Bot2'],
    });
    await manager.handleAgentCommand('Bot2', 'council-answer', {
        answer: 'Bot3 has an alliance nobody is talking about.',
    });
    await manager.control('end-council');

    // The voting directive carries both the accusation and the jury framing, so a
    // bot can change its target because of what it just heard.
    const voteDirective = directives.at(-1).prompt;
    assert.match(voteDirective, /Bot3 has an alliance nobody is talking about/);
    assert.match(voteDirective, /reconsider everything that just came out on the mat/);
    assert.match(voteDirective, /you win because the people/);
    assert.equal(coordinator.view().phase, 'voting');
});

test('the host can hold a phase open or cut it short', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    assert.ok(manager.view().phaseDeadlineAt, 'strategy runs on a clock');

    await manager.control('set-phase-deadline', { seconds: null });
    assert.equal(manager.view().phaseDeadlineAt, null);
    await manager.tick();
    assert.equal(manager.view().game.phase, 'strategy', 'a held phase never times out');

    await manager.control('set-phase-deadline', { seconds: 0 });
    await manager.tick();
    assert.equal(manager.view().game.phase, 'tribal_council');
    await assert.rejects(
        manager.control('set-phase-deadline', { seconds: -5 }),
        /non-negative number or null/
    );
});

test('a bot that cannot be reached is reported instead of silently skipped', async () => {
    const { options, coordinator, contestCoordinator } = await createManager();
    const manager = new SurvivorSessionManager({
        ...options,
        coordinator,
        contestCoordinator,
        notifyAgent: id => (id === 'Bot3'
            ? Promise.reject(new Error('socket closed'))
            : Promise.resolve({ success: true })),
    });
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    await manager.control('open-council');

    const asked = await manager.control('council-question', {
        prompt: 'Who is in trouble tonight?',
        targetIds: ['Bot2', 'Bot3'],
    });
    assert.deepEqual(asked.lastQuestion.undelivered, ['Bot3']);
    const problem = manager.view().problems.at(-1);
    assert.equal(problem.stage, 'council-question');
    assert.match(problem.message, /Could not reach Bot3/);
});
