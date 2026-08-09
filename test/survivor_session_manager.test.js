import assert from 'node:assert/strict';
import test from 'node:test';
import { getSurvivorSeasonPreset } from '../src/mindcraft/contest/game_presets.js';
import { PrivateRoomRegistry } from '../src/mindcraft/survivor/private_rooms.js';
import { BASELINE_SURVIVOR_CHALLENGE_GAME_IDS } from '../src/mindcraft/survivor/survivor_challenges.js';
import { SurvivorCoordinator } from '../src/mindcraft/survivor/survivor_coordinator.js';
import { SurvivorSessionManager } from '../src/mindcraft/survivor/survivor_session_manager.js';
import { createManager, openPrivateRoom, participants } from './helpers/survivor_harness.js';

test('provisions a persistent roster and starts a team challenge', async () => {
    const {
        manager,
        coordinator,
        contestCoordinator,
        directives,
        agentSettings,
    } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    assert.equal(manager.view().createdAgents.length, 11);
    assert.equal(coordinator.view().phase, 'challenge');
    assert.ok(contestCoordinator.activeContestId);
    assert.ok(directives.some(item => item.prompt.includes('Tribe:')));
    assert.equal(manager.view().recordingEnabled, false);
    assert.equal(manager.view().autoRecordingEnabled, false);
    assert.ok(agentSettings.every(settings => settings.gameSession.recordBotView === false));
    assert.ok(agentSettings.every(settings => settings.gameSession.autoRecordingEnabled === false));
});

test('passes the selected Survivor recording mode to every bot', async () => {
    const full = await createManager();
    await full.manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
        recordingEnabled: true,
        autoRecordingEnabled: true,
    });
    assert.ok(full.agentSettings.every(settings => settings.gameSession.recordBotView === true));
    assert.ok(full.agentSettings.every(settings => settings.gameSession.autoRecordingEnabled === false));

    const automatic = await createManager();
    await automatic.manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
        autoRecordingEnabled: true,
    });
    assert.ok(automatic.agentSettings.every(
        settings => settings.gameSession.recordBotView === false
            && settings.gameSession.autoRecordingEnabled === true
    ));
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

test('starts a six-player season in tribes with every boot eligible for the jury', async () => {
    const { manager, coordinator, contestCoordinator, directives } = await createManager();
    await manager.start({
        participants: participants(6),
        mergeAt: 4,
        finalistCount: 2,
        juryEligibility: 'all_eliminated',
        challengeGameIds: ['cake_race'],
    });

    const game = coordinator.view();
    assert.equal(game.merged, false);
    assert.equal(game.juryEligibility, 'all_eliminated');
    assert.deepEqual(game.tribes.Ember, ['Bot1', 'Bot3', 'Bot5']);
    assert.deepEqual(game.tribes.Tide, ['Bot2', 'Bot4', 'Bot6']);
    assert.equal(
        contestCoordinator.contests[manager.view().challengeContestId].metadata.survivorMode,
        'tribe'
    );
    assert.ok(directives.some(item => item.prompt.includes('Tribe: Ember')));
    assert.ok(directives.some(item => item.prompt.includes('Tribe: Tide')));
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

    const VOTE_PHASES = new Set(['voting', 'revote', 'jury_voting', 'finalist_tiebreak']);
    const REEVAL_PHASE = 'reevaluation';
    const phases = [];
    for (let step = 0; step < 30; step++) {
        const game = coordinator.view();
        if (game.status !== 'running') break;
        if (game.phase === 'challenge') {
            contestCoordinator.completeCurrent(manager, 'Bot1');
            await manager.syncContestView(contestCoordinator.view());
        } else if (game.phase === REEVAL_PHASE) {
            await manager.control('advance');
        } else if (VOTE_PHASES.has(game.phase)) {
            for (const voterId of game.eligibleVoterIds) {
                const targetId = game.eligibleTargetIds.find(id => id !== voterId);
                try {
                    await manager.handleAgentCommand(voterId, 'cast-vote', {
                        targetId,
                        reason: 'test ballot',
                    });
                } catch (error) {
                    if (!/already voted/i.test(error.message)) throw error;
                }
            }
            await manager.control('reveal-votes');
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
        ['strategy', 'tribal_council', 'reevaluation', 'voting', 'jury_questioning', 'jury_voting', 'completed']
    );
    assert.equal(manager.view().status, 'completed');
});

test('a Spleef tribe wins immunity on its longest survivor, not on result order', async () => {
    const { manager, coordinator, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(6),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['spleef'],
    });
    const contestId = manager.view().challengeContestId;
    // Ember is Bot1/Bot3/Bot5 and Tide is Bot2/Bot4/Bot6. Ember's Bot1 outlasted
    // everyone, so Ember takes immunity even though a Tide bot leads the results.
    contestCoordinator.completeWithResults(contestId, ['Bot2'], [
        { participantId: 'Bot2', score: 8_000, details: { surviving: false, survivedMs: 8_000 } },
        { participantId: 'Bot1', score: 9_000, details: { surviving: true, survivedMs: 9_000 } },
        { participantId: 'Bot4', score: 2_000, details: { surviving: false, survivedMs: 2_000 } },
        { participantId: 'Bot3', score: 1_000, details: { surviving: false, survivedMs: 1_000 } },
        { participantId: 'Bot6', score: 3_000, details: { surviving: false, survivedMs: 3_000 } },
        { participantId: 'Bot5', score: 4_000, details: { surviving: false, survivedMs: 4_000 } },
    ]);
    await manager.syncContestView(contestCoordinator.view());

    const game = coordinator.view();
    assert.equal(game.councilTribe, 'Tide');
    assert.deepEqual([...game.immunityIds].sort(), ['Bot1', 'Bot3', 'Bot5']);
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
    assert.equal(coordinator.view().phase, 'reevaluation');
    await manager.control('advance');
    assert.equal(coordinator.view().phase, 'voting');
});

test('voting is host-held: no clock, no advance autofill, reveal blocks on missing ballots', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    assert.equal(coordinator.view().phase, 'strategy');
    assert.ok(coordinator.view().eligibleTargetIds.includes('Bot2')
        || coordinator.view().eligibleTargetIds.length >= 3);
    await manager.control('open-council');
    await manager.control('end-council');
    assert.equal(coordinator.view().phase, 'reevaluation');
    await manager.control('advance');
    assert.equal(coordinator.view().phase, 'voting');
    assert.equal(manager.view().phaseDeadlineAt, null, 'voting has no auto clock');
    assert.deepEqual(
        [...(manager.view().game.missingVoterIds || [])].sort(),
        ['Bot1', 'Bot2', 'Bot3', 'Bot4']
    );

    await assert.rejects(
        manager.control('advance'),
        /host-held|Reveal votes/i
    );
    assert.equal(coordinator.view().phase, 'voting');
    await assert.rejects(
        manager.control('reveal-votes'),
        /Missing ballots from/
    );

    for (const voterId of coordinator.view().eligibleVoterIds) {
        const targetId = coordinator.view().eligibleTargetIds.find(id => id !== voterId);
        await manager.handleAgentCommand(voterId, 'cast-vote', {
            targetId,
            reason: 'test ballot',
        });
    }
    assert.deepEqual(manager.view().game.missingVoterIds, []);
    await manager.control('reveal-votes');
    assert.notEqual(coordinator.view().phase, 'voting');
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
    assert.equal(coordinator.view().phase, 'reevaluation');
    await assert.rejects(
        manager.handleAgentCommand('Bot2', 'cast-vote', { targetId: 'Bot3' }),
        /not accepted during reevaluation/
    );
    await manager.control('advance');
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

test('council is spoken aloud: the host asks, the player answers in their own voice', async () => {
    const { manager, contestCoordinator, spoken, advance } = await createManager();
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
    assert.ok(
        spoken.some(line => line.speaker === 'narrator' && /Tribal Council is now in session/.test(line.text)),
        'opening council is narrated'
    );

    spoken.length = 0;
    await manager.control('council-question', {
        prompt: 'Who here has been playing you?',
        targetIds: ['Bot2'],
    });
    await manager.handleAgentCommand('Bot2', 'council-answer', {
        answer: 'Bot4 has been running this whole thing.',
    });
    assert.deepEqual(spoken, [
        { speaker: 'narrator', text: 'Bot2. Who here has been playing you?' },
        { speaker: 'Bot2', text: 'Bot4 has been running this whole thing.' },
    ]);

    spoken.length = 0;
    await manager.control('end-council');
    assert.deepEqual(spoken, [
        { speaker: 'narrator', text: 'Council is closed. Reconsider what you heard before anyone votes.' },
    ]);
    spoken.length = 0;
    await manager.control('advance');
    assert.deepEqual(spoken, [
        { speaker: 'narrator', text: 'Re-evaluation is over. It is time to vote.' },
    ]);
});

test('a failed announcement is reported without stopping council', async () => {
    const { manager, contestCoordinator, notifications, advance } = await createManager();
    manager.announce = () => Promise.reject(new Error('ElevenLabs is unreachable'));
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

    await manager.control('council-question', { prompt: 'Why you?', targetIds: ['Bot2'] });
    assert.ok(
        notifications.some(item => item.event === 'survivor-council-question'),
        'the question still reaches the bot'
    );
    assert.ok(manager.view().problems.some(problem => problem.stage === 'narration'));
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
    await manager.control('advance');
    const state = coordinator.view();
    const voterId = state.eligibleVoterIds[0];
    const targetId = state.eligibleTargetIds.find(id => id !== voterId);
    await manager.handleAgentCommand(voterId, 'cast-vote', {
        targetId,
        reason: 'He is the only one who can beat me.',
    });
    const status = await manager.handleAgentCommand(voterId, 'status');
    assert.equal(status.data.ballotReceived, true);
    assert.ok(!Object.hasOwn(status.data, 'ballots'));
    assert.deepEqual(manager.view().game.ballots, {});
    assert.equal(manager.view().game.ballotCount, 1);

    // The reason reaches the game sealed, and the dashboard is told no more than
    // it is told about the ballot itself until the votes are read.
    assert.equal(
        coordinator.view().ballotReasons[voterId],
        'He is the only one who can beat me.'
    );
    assert.deepEqual(manager.view().game.ballotReasons, {});
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

test('a restart parks the running season instead of putting its cast back', async () => {
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
    const spawned = [];
    const directives = [];
    const recovered = new SurvivorSessionManager({
        ...options,
        coordinator: recoveredCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => 'recovered-room' }),
        createAgent: settings => {
            spawned.push(settings.profile.name);
            return { success: true, agentId: `agent-${settings.profile.name}` };
        },
        sendDirective: (id, prompt) => directives.push({ id, prompt }),
    });
    const view = await recovered.recover();

    assert.equal(view.id, manager.view().id);
    assert.equal(view.game.phase, 'challenge');
    assert.equal(view.participantIds.length, 11);
    assert.equal(view.status, 'suspended');
    assert.equal(view.suspendedReason, 'server-restart');
    assert.deepEqual(spawned, [], 'no bot is put back in the world without being asked');
    assert.deepEqual(directives, [], 'no survivor prompt goes out to a parked season');
    // The old contest died with the process, so nothing is waiting on it.
    assert.equal(view.challengeContestId, null);
});

test('a parked season lets another game have the world and refuses to play', async () => {
    const { manager, root, options } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    await manager._persistOperation;

    const recovered = new SurvivorSessionManager({
        ...options,
        coordinator: await SurvivorCoordinator.load({ root, random: () => 0 }),
        rooms: new PrivateRoomRegistry({ idFactory: () => 'recovered-room' }),
    });
    await recovered.recover();

    assert.equal(recovered.occupiesWorld(), false);
    // Nothing about a parked season may move on its own while something else
    // is using the world.
    assert.equal(await recovered.tick(), null);
    await assert.rejects(recovered.control('advance'), /suspended/i);
    await assert.rejects(recovered.control('pause'), /suspended/i);
    await assert.rejects(
        recovered.handleAgentCommand('Bot1', 'status'),
        /suspended/i
    );
    await assert.rejects(
        recovered.start({ participants: participants(4), mergeAt: 4 }),
        /Resume it or cancel it/
    );
});

test('suspending frees the world and resuming brings the same season back', async () => {
    const { manager, coordinator, contestCoordinator, directives } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    // Get off the challenge phase: a season mid-challenge cannot be suspended.
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    const seasonId = manager.view().id;
    assert.equal(manager.view().game.phase, 'strategy');

    await manager.control('suspend');
    assert.equal(manager.view().status, 'suspended');
    assert.equal(manager.view().suspendedReason, 'operator');
    assert.equal(manager.view().createdAgents.length, 0, 'the cast leaves the world');
    assert.equal(manager.occupiesWorld(), false);
    // The season itself is untouched — only the session is parked.
    assert.equal(coordinator.view().status, 'running');
    assert.equal(coordinator.view().phase, 'strategy');

    directives.length = 0;
    await manager.control('resume-season');

    assert.equal(manager.view().status, 'running');
    assert.equal(manager.view().suspendedReason, null);
    assert.equal(manager.view().id, seasonId, 'the same season picks up where it left off');
    assert.equal(manager.view().createdAgents.length, 4, 'the cast is back');
    assert.equal(manager.occupiesWorld(), true);
    assert.ok(
        directives.some(item => item.prompt.includes('strategy')),
        'everyone is told where the season stands'
    );
});

test('a season parked during a challenge is refused, not torn in half', async () => {
    const { manager } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    assert.equal(manager.view().game.phase, 'challenge');
    await assert.rejects(manager.control('park'), /immunity challenge/);
    assert.equal(manager.view().status, 'running');
});

test('pause freezes the phase clock and preserves the cast', async () => {
    const muteCalls = [];
    const { manager, contestCoordinator, advance, options } = await createManager();
    options.onPauseMute = () => {
        muteCalls.push('soft');
        return 'soft';
    };
    options.onResumeMute = mode => muteCalls.push(`resume:${mode}`);
    Object.assign(manager, {
        onPauseMute: options.onPauseMute,
        onResumeMute: options.onResumeMute,
    });

    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
        phaseDurationsMs: { strategy: 60_000 },
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    assert.equal(manager.view().game.phase, 'strategy');
    const beforeAgents = manager.view().createdAgents.map(agent => agent.id);
    const deadlineAt = manager.view().phaseDeadlineAt;
    assert.ok(deadlineAt > 0);

    advance(10_000);
    await manager.control('pause');
    const paused = manager.view();
    assert.equal(paused.paused, true);
    assert.equal(paused.phaseDeadlineAt, null);
    assert.equal(paused.pausedDeadlineRemainingMs, 50_000);
    assert.equal(paused.operatorRunState.mode, 'paused');
    assert.equal(paused.operatorRunState.clocks, 'frozen');
    assert.equal(paused.operatorRunState.bots, 'paused');
    assert.equal(paused.operatorRunState.voices, 'soft');
    assert.equal(paused.operatorRunState.castPreserved, true);
    assert.deepEqual(
        paused.createdAgents.map(agent => agent.id),
        beforeAgents,
        'pause must not tear down the cast'
    );
    assert.deepEqual(muteCalls, ['soft']);

    // Wall-clock advancing while paused must not auto-advance the phase.
    advance(100_000);
    assert.equal(await manager.tick(), null);
    assert.equal(manager.view().game.phase, 'strategy');

    await manager.control('resume');
    const resumed = manager.view();
    assert.equal(resumed.paused, false);
    assert.equal(resumed.pausedDeadlineRemainingMs, null);
    assert.equal(resumed.phaseDeadlineAt, 110_000 + 50_000);
    assert.equal(resumed.operatorRunState.mode, 'running');
    assert.equal(resumed.operatorRunState.voices, 'live');
    assert.deepEqual(muteCalls, ['soft', 'resume:soft']);
});

test('park alias evicts bots; unpark restores the same season', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    await manager.control('park');
    assert.equal(manager.view().status, 'suspended');
    assert.equal(manager.view().operatorRunState.mode, 'parked');
    assert.equal(manager.view().operatorRunState.bots, 'evicted');
    assert.equal(manager.view().operatorRunState.castPreserved, false);
    assert.equal(manager.view().createdAgents.length, 0);

    await manager.control('unpark');
    assert.equal(manager.view().status, 'running');
    assert.equal(manager.view().createdAgents.length, 4);
    assert.equal(manager.view().operatorRunState.mode, 'running');
});

test('resuming a season parked in the challenge phase runs its challenge again', async () => {
    const { manager, root, options, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    await manager._persistOperation;
    // A restart kills the contest that was driving the challenge.
    contestCoordinator.activeContestId = null;

    const recovered = new SurvivorSessionManager({
        ...options,
        coordinator: await SurvivorCoordinator.load({ root, random: () => 0 }),
        rooms: new PrivateRoomRegistry({ idFactory: () => 'recovered-room' }),
    });
    await recovered.recover();
    await recovered.control('resume-season');

    assert.equal(recovered.view().status, 'running');
    assert.ok(
        recovered.view().challengeContestId,
        'the round gets a live challenge instead of waiting on a dead one'
    );
});

test('cancelling clears a season stranded on disk with no session record', async () => {
    const { manager, root, options } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });

    const orphanCoordinator = await SurvivorCoordinator.load({ root, random: () => 0 });
    const orphaned = new SurvivorSessionManager({
        ...options,
        coordinator: orphanCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => 'orphan-room' }),
    });
    // No recover() call, so there is no session overlay — but the season on
    // disk is still running and would otherwise block every later game.
    assert.equal(orphaned.view(), null);
    assert.equal(orphaned.occupiesWorld(), true);

    await orphaned.cancel('clearing the orphan');

    assert.equal(orphanCoordinator.view().status, 'cancelled');
    assert.equal(orphaned.occupiesWorld(), false);
});

test('recovery replays private alliance memory from the journal', async () => {
    const { manager, root, options, coordinator, contestCoordinator } = await createManager();
    // Mirror production wiring: private events are both kept in memory for the
    // operator feed and journaled through the coordinator so a restart can
    // replay them.
    manager.rooms.onEvent = event => {
        manager.recordRoomEvent(event);
        coordinator.recordPrivateEvent(event);
    };
    manager.conversations.onEvent = event => {
        manager.recordConversationEvent(event);
        coordinator.recordPrivateEvent(event);
    };
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    await openPrivateRoom(manager, 'Bot2', ['Bot3']);
    await manager.handleAgentCommand('Bot2', 'room-send', { message: 'final two, you and me' });
    await manager._persistOperation;
    // The journal is appended fire-and-forget from the event handlers, so wait
    // for the coordinator's queue to drain before reloading from disk.
    await coordinator._operation;

    const recovered = new SurvivorSessionManager({
        ...options,
        coordinator: await SurvivorCoordinator.load({ root, random: () => 0 }),
        rooms: new PrivateRoomRegistry({ idFactory: () => 'recovered-room' }),
    });
    await recovered.recover();

    assert.ok(
        recovered.secretEvents().some(event =>
            event.type === 'room.message' && event.message === 'final two, you and me'
        ),
        'the private message is back in the secret feed'
    );
    const [thread] = recovered.roomHistory;
    assert.deepEqual(thread.memberIds.sort(), ['Bot2', 'Bot3']);
    assert.equal(thread.messageCount, 1);
    assert.match(recovered.briefingFor('Bot3'), /told you privately/);
});

test('a resume that cannot get a bot back stays parked and names it', async () => {
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

    await recovered.recover();
    await assert.rejects(recovered.control('resume-season'), /Bot3/);
    assert.deepEqual(attempted, ['Bot3']);
    assert.equal(recovered.lastFailure.stage, 'resume');
    assert.match(recovered.lastFailure.error, /did not join/);
    assert.ok(recovered.lastFailure.agents.some(agent => agent.name === 'Bot3'));
    // A failed resume must not leave a season half-running with no cast.
    assert.equal(recovered.view().status, 'suspended');
    assert.equal(recovered.occupiesWorld(), false);
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
    await manager.handleAgentCommand('Bot2', 'room-send', { message: 'final two?' });
    assert.equal(manager.view().rooms.length, 1);

    // Walking out is the only thing that ends a two-player room now.
    await manager.handleAgentCommand('Bot3', 'room-leave');
    assert.equal(manager.view().rooms.length, 0);

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

test('a private room outlives every phase change so the talk never stops', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
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

    advance(2);
    await manager.tick();
    assert.equal(coordinator.view().phase, 'tribal_council');
    assert.equal(manager.view().rooms.length, 1, 'the mat does not break up the room');
    await manager.handleAgentCommand('Bot3', 'room-send', { message: 'do not blink out there' });

    await manager.control('end-council');
    assert.equal(coordinator.view().phase, 'reevaluation');
    await manager.handleAgentCommand('Bot2', 'room-send', { message: 'still thinking' });
    await manager.control('advance');
    assert.equal(coordinator.view().phase, 'voting');
    const sent = await manager.handleAgentCommand('Bot2', 'room-send', {
        message: 'writing Bot4, you too',
    });
    assert.equal(sent.success, true, 'an open ballot no longer closes the room');

    const [thread] = manager.conversationTranscripts().threads;
    assert.equal(thread.open, true);
    assert.deepEqual(
        thread.messages.map(message => message.phase),
        ['strategy', 'tribal_council', 'reevaluation', 'voting']
    );
});

test('transcripts index every thread by the castaway who was in it', async () => {
    const { manager, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    await openPrivateRoom(manager, 'Bot2', ['Bot3'], { pitch: 'final two' });
    await manager.handleAgentCommand('Bot2', 'room-send', { message: 'we write Bot4' });
    await manager.handleAgentCommand('Bot3', 'room-send', { message: 'agreed' });
    await manager.handleAgentCommand('Bot3', 'room-leave');
    await openPrivateRoom(manager, 'Bot3', ['Bot4']);
    await manager.handleAgentCommand('Bot3', 'room-send', { message: 'Bot2 is coming for you' });

    const transcripts = manager.conversationTranscripts();
    assert.equal(transcripts.threads.length, 2);

    const bot3 = transcripts.players.find(player => player.id === 'Bot3');
    assert.deepEqual(bot3.partnerIds, ['Bot2', 'Bot4']);
    assert.equal(bot3.threadCount, 2);
    assert.equal(bot3.openThreadCount, 1);
    assert.equal(bot3.spokenCount, 2, 'one line to Bot2 and one to Bot4');
    assert.equal(bot3.messageCount, 3, 'everything said in the rooms it sat in');

    // Bot4 was never in the first room, so it stays out of Bot4's index.
    const bot4 = transcripts.players.find(player => player.id === 'Bot4');
    assert.deepEqual(bot4.partnerIds, ['Bot3']);
    assert.equal(bot4.threadCount, 1);
    assert.equal(bot4.spokenCount, 0);

    const firstThread = transcripts.threads[0];
    assert.equal(firstThread.pitch, 'final two');
    assert.deepEqual(firstThread.memberIds.sort(), ['Bot2', 'Bot3']);
    assert.deepEqual(
        firstThread.messages.map(message => [message.senderId, message.message]),
        [['Bot2', 'we write Bot4'], ['Bot3', 'agreed']]
    );
    assert.deepEqual(transcripts.threads[1].currentMemberIds.sort(), ['Bot3', 'Bot4']);
});

test('a refusal stays readable even though it never opened a room', async () => {
    const { manager, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    await manager.control('set-phase-deadline', { seconds: null });

    await openPrivateRoom(manager, 'Bot2', ['Bot3'], {
        declineIds: ['Bot3'],
        reason: 'I am not working with you',
    });
    assert.deepEqual(manager.conversationTranscripts().refusals.map(item => [
        item.requesterId,
        item.inviteeId,
        item.reason,
    ]), [['Bot2', 'Bot3', 'I am not working with you']]);

    // Silence is a refusal too, and only the resolution knows who never answered.
    manager.conversations.requestTtlMs = 10;
    await manager.handleAgentCommand('Bot4', 'talk-request', { inviteeIds: ['Bot3'] });
    advance(1000);
    await manager.tick();
    assert.deepEqual(
        manager.conversationTranscripts().refusals.at(-1),
        {
            requestId: 'talk-2',
            requesterId: 'Bot4',
            inviteeId: 'Bot3',
            reason: 'never answered',
            at: 1000,
            round: 1,
            phase: 'strategy',
        }
    );
});

test('before the merge a bot works its own camp, not the tribe going to council', async () => {
    const { manager, coordinator, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(),
        mergeAt: 10,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    const game = coordinator.view();
    const safe = game.participantIds.filter(id => game.players[id].tribe !== game.councilTribe);
    const doomed = game.participantIds.find(id => game.players[id].tribe === game.councilTribe);

    // The safe tribe used to be frozen out of private talk entirely.
    const opened = await manager.handleAgentCommand(safe[0], 'talk-request', {
        inviteeIds: [safe[1]],
    });
    assert.ok(opened.data.requestId);

    await assert.rejects(
        manager.handleAgentCommand(safe[1], 'talk-request', { inviteeIds: [doomed] }),
        /Not available to talk/
    );
});

test('settled talk requests age out instead of piling up all season', async () => {
    const { manager, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    await manager.control('set-phase-deadline', { seconds: null });
    manager.conversations.resolvedRetentionMs = 500;

    await openPrivateRoom(manager, 'Bot2', ['Bot3']);
    assert.equal(manager.view().conversationRequests.length, 1);

    advance(1000);
    await manager.tick();
    assert.deepEqual(manager.view().conversationRequests, []);
    assert.equal(manager.view().rooms.length, 1, 'pruning the ask does not close the room');
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

    // Closing council enters re-evaluation first; the briefing still carries the
    // public accusation so bots can change targets before ballots open.
    assert.equal(coordinator.view().phase, 'reevaluation');
    const reevalDirective = directives.at(-1).prompt;
    assert.match(reevalDirective, /Bot3 has an alliance nobody is talking about/);
    assert.match(reevalDirective, /reconsider the public record/i);
    assert.match(reevalDirective, /you win because the people/);
    await manager.control('advance');
    assert.equal(coordinator.view().phase, 'voting');
    const voteDirective = directives.at(-1).prompt;
    assert.match(voteDirective, /cite what happened at council/i);
});

test('a challenge directive is about winning the challenge and nothing else', async () => {
    const { manager, coordinator, directives } = await createManager();
    await manager.start({
        participants: participants(6),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['deepest_2_5'],
    });

    assert.equal(coordinator.view().phase, 'challenge');
    const directive = directives.at(-1).prompt;
    // The contest's own rules are the goal, and how the tribe is scored is the
    // part that changes what a bot should do with them.
    assert.match(directive, /CONTEST: Deepest Wins/);
    assert.match(directive, /AVERAGE depth/);
    assert.match(directive, /losing tribe goes to Tribal Council/);
    // None of the season's social game rides along with it.
    assert.doesNotMatch(directive, /you win because the people/);
    assert.doesNotMatch(directive, /!requestPrivateChat/);
    assert.doesNotMatch(directive, /!castSurvivorVote/);
});

test('after the merge a challenge is played for one immunity, not for a tribe', async () => {
    const { manager, directives } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });

    const directive = directives.at(-1).prompt;
    assert.match(directive, /CONTEST: First Cake/);
    assert.match(directive, /the winner cannot be voted out tonight/);
    assert.doesNotMatch(directive, /Tribe:/);
});

test('the social phases keep the memory, the jury lens, and the private toolbox', async () => {
    const { manager, coordinator, contestCoordinator, directives } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    assert.equal(coordinator.view().phase, 'strategy');
    const directive = directives.at(-1).prompt;
    assert.match(directive, /you win because the people/);
    assert.match(directive, /!requestPrivateChat/);
    // The challenge is over, so its rules are no longer anybody's goal.
    assert.doesNotMatch(directive, /CONTEST: First Cake/);
});

test('an immunity challenge closes private talk without erasing the alliance', async () => {
    const { manager, coordinator, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(6),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race', 'spleef'],
        councilAutoAdvance: true,
    });

    await assert.rejects(
        manager.handleAgentCommand('Bot2', 'talk-request', { inviteeIds: ['Bot4'] }),
        /closed during an immunity challenge/
    );

    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    assert.equal(coordinator.view().phase, 'strategy');
    await openPrivateRoom(manager, 'Bot2', ['Bot4']);
    await manager.handleAgentCommand('Bot2', 'room-send', {
        message: 'we go to the end together',
    });
    assert.equal(manager.view().rooms.length, 1);

    const VOTE_PHASES = new Set(['voting', 'revote', 'jury_voting', 'finalist_tiebreak']);
    const REEVAL_PHASE = 'reevaluation';
    for (let step = 0; step < 20 && coordinator.view().round === 1; step++) {
        const game = coordinator.view();
        if (game.phase === REEVAL_PHASE) {
            await manager.control('advance');
            continue;
        }
        if (VOTE_PHASES.has(game.phase)) {
            for (const voterId of game.eligibleVoterIds) {
                const targetId = game.eligibleTargetIds.find(id => id !== voterId);
                try {
                    await manager.handleAgentCommand(voterId, 'cast-vote', {
                        targetId,
                        reason: 'test ballot',
                    });
                } catch (error) {
                    if (!/already voted/i.test(error.message)) throw error;
                }
            }
            await manager.control('reveal-votes');
            continue;
        }
        advance(2);
        await manager.tick();
    }

    assert.equal(coordinator.view().phase, 'challenge');
    assert.equal(manager.view().rooms.length, 0, 'the room is closed for the challenge');
    assert.match(
        manager.briefingFor('Bot4'),
        /we go to the end together/,
        'the alliance is on hold, not forgotten'
    );
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

test('harness can skip a challenge, set immunity, and jump to Tribal', async () => {
    const { manager, coordinator, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    assert.equal(coordinator.view().phase, 'challenge');
    const contestId = manager.view().challengeContestId;
    assert.ok(contestId);
    assert.equal(contestCoordinator.contests[contestId].status, 'running');
    await manager.control('jump-to-council', {
        winnerId: 'Bot1',
        immunityIds: ['Bot1'],
    });
    assert.equal(coordinator.view().phase, 'tribal_council');
    assert.deepEqual(coordinator.view().immunityIds, ['Bot1']);
    assert.ok(coordinator.view().eligibleTargetIds.every(id => id !== 'Bot1'));
    assert.equal(manager.view().challengeContestId, null);
    assert.equal(contestCoordinator.contests[contestId].status, 'cancelled');
    assert.equal(contestCoordinator.activeContestId, null);
});

test('pre-merge challenges wire tribes into contest gameSession for Minecraft teams', async () => {
    const { manager, coordinator, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(6),
        mergeAt: 4,
        finalistCount: 2,
        tribeNames: ['Ember', 'Tide'],
        challengeGameIds: ['cake_race'],
    });
    assert.equal(coordinator.view().merged, false);
    const contestId = manager.view().challengeContestId;
    const contest = contestCoordinator.contests[contestId];
    assert.deepEqual(contest.metadata.gameSession.teamNames, ['Ember', 'Tide']);
    assert.equal(
        contest.metadata.gameSession.teamByParticipant.Bot1,
        coordinator.view().players.Bot1.tribe
    );
    assert.equal(
        contest.metadata.gameSession.participants.find(p => p.name === 'Bot1').team,
        coordinator.view().players.Bot1.tribe
    );
});

test('host can declare a challenge winner through challenge-result', async () => {
    const { manager, coordinator, contestCoordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    const contestId = manager.view().challengeContestId;
    await manager.control('challenge-result', { winnerId: 'Bot2' });
    assert.equal(coordinator.view().phase, 'strategy');
    assert.deepEqual(coordinator.view().immunityIds, ['Bot2']);
    assert.equal(manager.view().challengeContestId, null);
    assert.equal(contestCoordinator.contests[contestId].status, 'cancelled');
});

test('baseline Survivor scenario decks stay on proven challenge games', async () => {
    for (const scenarioId of ['classic', 'four_player', 'six_player']) {
        const deck = getSurvivorSeasonPreset(scenarioId).challengeGameIds;
        for (const gameId of deck) {
            assert.ok(
                BASELINE_SURVIVOR_CHALLENGE_GAME_IDS.includes(gameId),
                `${scenarioId} includes non-baseline ${gameId}`
            );
        }
    }
});

test('talk invites stay open until strategy ends and stats count ask/accept/refuse', async () => {
    const { manager, contestCoordinator, advance } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    const opened = await manager.handleAgentCommand('Bot1', 'talk-request', {
        inviteeIds: ['Bot2', 'Bot3'],
        pitch: 'three-person deal',
    });
    const requestId = opened.data.requestId;
    const pending = manager.view().conversationRequests.find(item => item.id === requestId);
    assert.equal(pending.expiresAt, null, 'no mid-strategy TTL');
    assert.equal(manager.view().conversationStats.asked, 1);

    // Wall-clock far past the old 30s TTL must not expire the invite.
    advance(120_000);
    assert.equal(manager.conversations.dueRequests().length, 0);
    assert.equal(manager.view().conversationRequests.find(item => item.id === requestId).status, 'pending');

    await manager.handleAgentCommand('Bot2', 'talk-respond', {
        requestId,
        accepted: true,
    });
    await manager.handleAgentCommand('Bot3', 'talk-respond', {
        requestId,
        accepted: false,
        reason: 'not today',
    });
    const stats = manager.view().conversationStats;
    assert.equal(stats.accepted, 1);
    assert.equal(stats.declined, 1);
    assert.equal(stats.roomsOpened, 1);
    assert.ok(manager.view().rooms.some(room =>
        room.memberIds.includes('Bot1') && room.memberIds.includes('Bot2')
    ));
});

test('host can force a private meet for harness drills', async () => {
    const { manager, contestCoordinator, notifications } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());

    await manager.control('force-private-meet', {
        memberIds: ['Bot1', 'Bot2', 'Bot3'],
        pitch: 'forced alliance',
    });
    const room = manager.view().rooms.find(item => item.memberIds.includes('Bot1'));
    assert.ok(room);
    assert.deepEqual([...room.memberIds].sort(), ['Bot1', 'Bot2', 'Bot3']);
    assert.equal(manager.view().conversationStats.roomsOpened, 1);
    assert.ok(notifications.some(item =>
        item.event === 'survivor-talk-resolved' && item.payload.forced === true
    ));
});

test('fire-making requires operator confirmation', async () => {
    const { manager, coordinator } = await createManager();
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    coordinator.game.state.phase = 'fire_making';
    coordinator.game.state.tiedIds = ['Bot2', 'Bot3'];
    await assert.rejects(manager.control('advance'), /operator confirmation|Confirm fire/i);
    await assert.rejects(manager.control('fire-result', {}), /Confirm fire-making/);
});
