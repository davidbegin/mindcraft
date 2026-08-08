import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    appendSpeechStylePrompt,
    appendSystemPromptAddendum,
} from '../src/models/prompter.js';
import { ContestCoordinator } from '../src/mindcraft/contest/contest_coordinator.js';
import {
    GameSessionManager,
    resolveBuildPhaseMs,
    resolvePlanningMs,
    validateGameParticipants,
    validateTeamSetup,
} from '../src/mindcraft/contest/game_session_manager.js';
import {
    filterRecordingManifest,
    serializeRecordingManifest,
} from '../src/mindcraft/contest/recording_exports.js';
import {
    buildGameSystemPrompt,
    buildParticipantGameDirective,
    buildTeamPlanningDirective,
    pickTeamAttacker,
} from '../src/mindcraft/contest/game_content.js';

const profiles = [
    {
        id: 'fast',
        name: 'fast',
        model: 'model-fast',
        provider: 'cursor',
        configured: true,
        profile: { name: 'fast', model: 'model-fast' },
    },
    {
        id: 'smart',
        name: 'smart',
        model: 'model-smart',
        provider: 'cursor',
        configured: true,
        profile: { name: 'smart', model: 'model-smart' },
    },
];

const preset = {
    id: 'tower',
    title: 'Tower',
    prompt: 'Build the tallest tower.',
    durationMs: 60_000,
    rules: { type: 'diamond_race', metrics: [], winItem: 'diamond' },
    metadata: {},
};

async function withManager(run, overrides = {}, coordinatorOverrides = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-game-session-'));
    const calls = [];
    try {
        const coordinator = await ContestCoordinator.create({
            root,
            idFactory: () => 'game-1',
            ...coordinatorOverrides,
        });
        const manager = new GameSessionManager({
            coordinator,
            getPreset: () => preset,
            getProfiles: () => profiles,
            getExistingAgentNames: () => ['colony_bot'],
            resolveParticipantVoice: (name, voice) => voice || `AutoVoice-${name}`,
            buildAgentSettings: (profile, gameSession) => ({ profile, game_session: gameSession }),
            createAgent: async settings => {
                calls.push(['create', settings]);
                return { success: true, agentId: `${settings.profile.name}#${calls.length}` };
            },
            destroyAgent: async name => calls.push(['destroy', name]),
            isAgentReady: () => true,
            prepareArena: async (_game, participants) => {
                calls.push(['arena', participants]);
                return { center: { x: 1, y: 2, z: 3 } };
            },
            presentWinner: async contest => calls.push([
                'present-winner',
                contest.id,
            ]),
            presentResults: async contest => calls.push([
                'present-results',
                contest.id,
                contest.results.map(result => [result.participantId, result.rank]),
            ]),
            startRecording: async options => {
                calls.push(['record-start', options]);
                return { sessionId: `contest-${options.contestId}`, cameraCount: 4 };
            },
            stopRecording: async contestId => calls.push(['record-stop', contestId]),
            queueHighlight: ({ session, contest }) => calls.push([
                'highlight',
                session.sessionId,
                contest.id,
            ]),
            sendDirective: async (name, prompt, options) =>
                calls.push(['directive', name, prompt, options]),
            clearQueuedVoice: async contest => calls.push(['clear-voice', contest.id]),
            announceStart: contest => {
                calls.push(['announce-start', contest.id]);
                return Promise.resolve();
            },
            announcePlanning: (contest, options) => {
                calls.push(['announce-planning', contest.id, options?.planningMs]);
                return Promise.resolve();
            },
            announceBuildPhase: (contest, options) => {
                calls.push(['announce-build', contest.id, options?.buildPhaseMs]);
                return Promise.resolve();
            },
            announcePressureRound: options => {
                calls.push(['announce-pressure', options?.halfSize, options?.pressureRound]);
                return Promise.resolve();
            },
            announceResult: contest => {
                calls.push(['announce-result', contest.id, contest.winnerIds]);
                return Promise.resolve();
            },
            announceVisualResult: contest => {
                calls.push(['announce-visual-result', contest.id, contest.winnerIds]);
                return Promise.resolve();
            },
            announceSeriesIntermission: (series, contest) => {
                calls.push(['announce-series-intermission', contest?.id, series?.matchIndex, series?.scores]);
                return Promise.resolve();
            },
            announceSeriesResult: series => {
                calls.push(['announce-series-result', series?.seriesWinnerIds, series?.scores]);
                return Promise.resolve();
            },
            sleep: async ms => { calls.push(['sleep', ms]); },
            ...overrides,
        });
        await run({ manager, coordinator, calls });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('provisions, records, and holds competitors on podiums until cleanup', async () => {
    await withManager(async ({ manager, coordinator, calls }) => {
        const result = await manager.start({
            gameId: 'tower',
            participants: [
                {
                    profileId: 'fast',
                    name: 'speedy',
                    voice: 'Trickster',
                    systemPrompt: 'Be a reckless optimist.',
                },
                { profileId: 'smart', name: 'thinker' },
            ],
            systemPrompt: 'Be entertaining.',
            durationMs: 150_000,
            recordingEnabled: true,
        });

        assert.equal(result.contest.status, 'running');
        assert.equal(result.contest.durationMs, 150_000);
        assert.equal(manager.view().recording.enabled, true);
        const announceStartIndex = calls.findIndex(([type]) => type === 'announce-start');
        const directiveIndex = calls.findIndex(([type]) => type === 'directive');
        assert.ok(announceStartIndex < directiveIndex, 'countdown finishes before directives are sent');
        assert.deepEqual(
            calls.filter(([type]) => type === 'directive').map(([, name]) => name),
            ['speedy', 'thinker']
        );
        const createdAgents = calls.filter(([type]) => type === 'create').map(([, settings]) => settings);
        const createdSettings = createdAgents[0];
        assert.equal(createdSettings.game_session.systemPrompt, 'Be entertaining.');
        assert.deepEqual(createdSettings.game_session.participantIds, ['speedy', 'thinker']);
        assert.deepEqual(createdSettings.game_session.rivalIds, ['thinker']);
        assert.equal(createdSettings.game_session.winItem, 'diamond');
        assert.equal(createdSettings.game_session.contestType, 'diamond_race');
        assert.equal(createdSettings.game_session.voice, 'Trickster');
        assert.equal(createdSettings.game_session.personalityPrompt, 'Be a reckless optimist.');
        assert.equal(createdSettings.profile.name, 'speedy');
        assert.deepEqual(createdSettings.profile.speak_model, {
            api: 'elevenlabs',
            voice: 'Trickster',
        });
        assert.deepEqual(createdAgents[1].profile.speak_model, {
            api: 'elevenlabs',
            voice: 'AutoVoice-thinker',
        });
        assert.equal(manager.view().participants[0].voice, 'Trickster');
        assert.equal(manager.view().participants[1].voice, 'AutoVoice-thinker');
        assert.equal(
            coordinator.snapshot().contests['game-1'].metadata.gameSession.participants[1].voice,
            'AutoVoice-thinker'
        );
        const speedyDirective = calls.find(
            ([type, name]) => type === 'directive' && name === 'speedy'
        )[2];
        assert.match(speedyDirective, /COMPETITORS: speedy, thinker/);
        assert.match(speedyDirective, /Your rivals are thinker/);

        await coordinator.submit('game-1', 'speedy', {});
        await coordinator.submit('game-1', 'thinker', {});
        await manager.syncWithContestView(coordinator.view());

        assert.equal(manager.view().status, 'awaiting-next-game');
        assert.equal(manager.view().recording.enabled, false);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy'),
            [],
            'temporary bots remain online for the podium ceremony'
        );
        await manager.finish('game-1');
        assert.equal(manager.view(), null);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy').map(([, id]) => id),
            ['speedy#1', 'thinker#2'],
            'temporary bots are destroyed by instance id, not by name'
        );
        const stopIndex = calls.findIndex(([type]) => type === 'record-stop');
        const destroyIndex = calls.findIndex(([type]) => type === 'destroy');
        const highlightIndex = calls.findIndex(([type]) => type === 'highlight');
        const presentWinnerIndex = calls.findIndex(([type]) => type === 'present-winner');
        const presentResultsIndex = calls.findIndex(([type]) => type === 'present-results');
        const announceVisualResultIndex = calls.findIndex(
            ([type]) => type === 'announce-visual-result'
        );
        const announceResultIndex = calls.findIndex(([type]) => type === 'announce-result');
        const clearVoiceIndexes = calls
            .map(([type], index) => type === 'clear-voice' ? index : -1)
            .filter(index => index >= 0);
        assert.ok(
            presentWinnerIndex < announceVisualResultIndex,
            'everyone reaches the winning location before the result appears'
        );
        assert.ok(
            announceVisualResultIndex < presentResultsIndex,
            'the winning location is shown before the podium ceremony'
        );
        assert.ok(announceResultIndex < presentResultsIndex, 'the narrator speaks before the podium warp');
        const pauseDirectives = calls.filter(
            ([type, , , options]) => type === 'directive'
                && options?.pause === true
                && options?.react !== true
        );
        assert.equal(pauseDirectives.length, 2);
        assert.ok(pauseDirectives.every(([, , , options]) => options?.pause === true));
        const reactions = calls.filter(
            ([type, , , options]) => type === 'directive' && options?.react === true
        );
        assert.equal(reactions.length, 2);
        assert.ok(reactions.every(([, , prompt]) => /speedy/i.test(prompt)));
        assert.ok(reactions.every(([, , prompt]) => /one excited, natural sentence/i.test(prompt)));
        assert.equal(clearVoiceIndexes.length, 2);
        assert.deepEqual(
            calls.filter(([type]) => type === 'clear-voice').map(([, contestId]) => contestId),
            ['game-1', 'game-1']
        );
        assert.ok(clearVoiceIndexes[1] < announceResultIndex, 'stale speech is cleared before the winner call');
        assert.ok(reactions.every(call => calls.indexOf(call) > announceResultIndex));
        assert.ok(announceResultIndex < stopIndex, 'winner is announced before recording stops');
        assert.ok(stopIndex < highlightIndex, 'highlight encoding starts after recordings are finalized');
        assert.ok(highlightIndex < destroyIndex, 'highlight job is queued before temporary agents are destroyed');
        assert.ok(stopIndex < destroyIndex, 'recording stops before temporary agents are destroyed');
    });
});

test('keeps recording off by default and can arm action clips without full cameras', async () => {
    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
            autoRecordingEnabled: true,
        });

        const session = manager.view();
        assert.equal(session.recordingEnabled, false);
        assert.equal(session.autoRecordingEnabled, true);
        assert.equal(session.recording, null);
        assert.equal(session.launch.steps.some(step => step.id === 'start_recording'), false);
        assert.equal(calls.some(([type]) => type === 'record-start'), false);
        const createdSettings = calls.find(([type]) => type === 'create')[1];
        assert.equal(createdSettings.game_session.recordBotView, false);
        assert.equal(createdSettings.game_session.autoRecordingEnabled, true);

        await coordinator.submit('game-1', 'speedy', {});
        await manager.syncWithContestView(coordinator.view());
        await manager.finish('game-1');
        assert.equal(calls.some(([type]) => type === 'record-stop'), false);
        assert.equal(calls.some(([type]) => type === 'highlight'), false);
    });
});

test('publishes a launch timeline so a slow start is legible', async () => {
    const updates = [];
    await withManager(async ({ manager }) => {
        await manager.start({
            gameId: 'tower',
            participants: [
                { profileId: 'fast', name: 'speedy' },
                { profileId: 'smart', name: 'thinker' },
            ],
            recordingEnabled: true,
        });

        const launch = manager.view().launch;
        assert.deepEqual(
            launch.steps.map(step => step.id),
            [
                'reclaim_names',
                'create_agent',
                'wait_ready',
                'prepare_arena',
                'start_recording',
                'announce',
                'send_goals',
            ]
        );
        assert.ok(
            launch.steps.every(step => step.status === 'done'),
            'every step is closed out once the game is running'
        );
        assert.ok(
            launch.steps.every(step => step.startedAt && step.endedAt >= step.startedAt),
            'each step is timed so the dashboard can show how long it took'
        );
        assert.ok(launch.endedAt >= launch.startedAt);

        // The long steps have to be reported while they run, not only in
        // hindsight, or the dashboard goes quiet for minutes.
        const stagesSeen = updates
            .filter(session => session?.progress?.stage)
            .map(session => session.progress.stage);
        for (const stage of ['create_agent', 'wait_ready', 'prepare_arena', 'start_recording', 'send_goals']) {
            assert.ok(stagesSeen.includes(stage), `stage ${stage} was broadcast while launching`);
        }
        assert.ok(
            updates.some(session => session?.progress?.detail === 'Rebuilding the arena (7/7 commands)'),
            'arena progress is passed through to the dashboard'
        );
        assert.ok(
            updates.some(session => session?.progress?.detail === 'thinker has its goal (2/2)'),
            'each bot reports when its goal lands'
        );
    }, {
        onUpdate: session => updates.push(session),
        prepareArena: async (_game, _participants, options) => {
            for (let done = 1; done <= 7; done += 1) {
                options.onProgress?.(`Rebuilding the arena (${done}/7 commands)`);
            }
            return { center: { x: 1, y: 2, z: 3 } };
        },
    });
});

test('a launch that stalls names the bots it is waiting on', async () => {
    const updates = [];
    const readyAfter = { speedy: 0, thinker: 2 };
    let polls = 0;
    await withManager(async ({ manager }) => {
        await manager.start({
            gameId: 'tower',
            participants: [
                { profileId: 'fast', name: 'speedy' },
                { profileId: 'smart', name: 'thinker' },
            ],
        });

        const waiting = updates.find(session =>
            session?.progress?.stage === 'wait_ready' && session.progress.pending?.length
        );
        assert.deepEqual(waiting.progress.pending, ['thinker']);
        assert.equal(waiting.progress.ready, 1);
        assert.ok(waiting.progress.waitingUntil > 0, 'the wait publishes its own deadline');
    }, {
        onUpdate: session => updates.push(session),
        isAgentReady: name => polls >= readyAfter[name],
        sleep: async () => { polls += 1; },
    });
});

test('a failed launch marks the step that broke', async () => {
    await withManager(async ({ manager }) => {
        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [{ profileId: 'fast', name: 'speedy' }],
                recordingEnabled: true,
            }),
            /arena is flooded/
        );
        const steps = manager.lastFailure.session.launch.steps;
        assert.equal(steps.find(step => step.id === 'prepare_arena').status, 'failed');
        assert.equal(steps.find(step => step.id === 'wait_ready').status, 'done');
        assert.equal(steps.find(step => step.id === 'start_recording').status, 'pending');
    }, {
        prepareArena: async () => { throw new Error('arena is flooded'); },
    });
});

test('a lost camera angle costs footage, not the match', async () => {
    const incomplete = [];
    await withManager(async ({ manager, calls }) => {
        const result = await manager.start({
            gameId: 'tower',
            participants: [
                { profileId: 'fast', name: 'speedy' },
                { profileId: 'smart', name: 'thinker' },
            ],
            recordingEnabled: true,
        });

        assert.equal(result.contest.status, 'running');
        assert.equal(manager.view().status, 'running');
        assert.deepEqual(
            calls.filter(([type]) => type === 'directive').map(([, name]) => name),
            ['speedy', 'thinker'],
            'both competitors are told to play even though one has no camera'
        );
        assert.deepEqual(manager.view().recording.failures, [
            { agentName: 'thinker', error: 'start-contest-recording timed out for thinker' },
        ]);
        assert.deepEqual(incomplete, [
            [{ agentName: 'thinker', error: 'start-contest-recording timed out for thinker' }],
        ]);
    }, {
        startRecording: async options => ({
            sessionId: `contest-${options.contestId}`,
            participants: ['speedy'],
            cameraCount: 4,
            failures: [
                { agentName: 'thinker', error: 'start-contest-recording timed out for thinker' },
            ],
        }),
        onRecordingIncomplete: failures => incomplete.push(failures),
    });
});

test('a launch that never reaches the starting gun clears the arena without waiting on media', async () => {
    let releaseStop;
    const stopRequested = new Promise(resolve => { releaseStop = resolve; });
    await withManager(async ({ manager, coordinator, calls }) => {
        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [{ profileId: 'fast', name: 'speedy' }],
                recordingEnabled: true,
            }),
            /arena is flooded/
        );

        assert.equal(manager.view(), null);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy').map(([, id]) => id),
            ['speedy#1'],
            'the bot is removed instead of standing in a half-built arena'
        );
        assert.deepEqual(
            calls.filter(([type]) => type === 'highlight'),
            [],
            'a launch with no match has no highlight reel'
        );
        assert.equal(coordinator.snapshot().contests['game-1'].status, 'cancelled');
        await stopRequested;
    }, {
        prepareArena: async () => { throw new Error('arena is flooded'); },
        stopRecording: async () => {
            releaseStop();
            // A stop that never settles must not delay the teardown.
            return new Promise(() => {});
        },
    });
});

test('an explicit next-game start ends the podium ceremony early', async () => {
    let now = 1_000;
    let nextId = 0;
    await withManager(async ({ manager, coordinator, calls }) => {
        const request = {
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        };
        await manager.start(request);
        await coordinator.submit('game-1', 'speedy', {});
        await manager.syncWithContestView(coordinator.view());

        assert.equal(manager.view().status, 'awaiting-next-game');
        assert.equal(manager.view().podiumHoldUntil, 301_000);

        // Still well inside the five-minute hold. The operator can start the
        // next game anyway: it cleans up the medalists and launches immediately
        // instead of forcing a wait.
        const next = await manager.start(request);
        assert.equal(next.contest.id, 'game-2');
        const oldDestroyIndex = calls.findIndex(
            ([type, id]) => type === 'destroy' && id === 'speedy#1'
        );
        const newCreateIndex = calls.findIndex(
            ([type], index) => type === 'create' && index > oldDestroyIndex
        );
        assert.ok(oldDestroyIndex >= 0, 'the podium competitor is cleaned up');
        assert.ok(newCreateIndex > oldDestroyIndex, 'the next game provisions after cleanup');

        await coordinator.cancelContest('game-2', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        clock: () => now,
    }, {
        idFactory: () => `game-${++nextId}`,
    });
});

test('releasing the podium hold frees the arena for a different game mode', async () => {
    const now = 1_000;
    let nextId = 0;
    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        });
        await coordinator.submit('game-1', 'speedy', {});
        await manager.syncWithContestView(coordinator.view());
        assert.equal(manager.view().status, 'awaiting-next-game');

        // Nothing ends the ceremony on a timer, so a Survivor season would see a
        // finished game as still active forever unless it can clear the hold.
        const released = await manager.releasePodiumHold();
        assert.equal(released.contestId, 'game-1');
        assert.equal(manager.view(), null);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy').map(([, name]) => name),
            ['speedy#1']
        );

        // A hold that is already gone is not an error, and a running game is
        // never torn down by mistake.
        assert.equal(await manager.releasePodiumHold(), null);
        await manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        });
        assert.equal(await manager.releasePodiumHold(), null);
        assert.equal(manager.view().status, 'running');

        await coordinator.cancelContest('game-2', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        clock: () => now,
    }, {
        idFactory: () => `game-${++nextId}`,
    });
});

test('disables survival instincts for self-destruct race agents', async () => {
    const deathPreset = {
        ...preset,
        id: 'death_race',
        title: 'Self-Destruct Race',
        rules: {
            type: 'death_race',
            metrics: [{ path: 'elapsedMs', direction: 'minimize' }],
        },
    };
    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'death_race',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        });

        const settings = calls.find(([type]) => type === 'create')[1];
        assert.equal(settings.game_session.contestType, 'death_race');
        assert.deepEqual(settings.profile.modes, {
            self_preservation: false,
            cowardice: false,
            self_defense: false,
        });

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        getPreset: () => deathPreset,
    });
});

test('rolls back agents and cancels the draft after partial startup failure', async () => {
    let attempts = 0;
    await withManager(async ({ manager, coordinator, calls }) => {
        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [
                    { profileId: 'fast', name: 'speedy' },
                    { profileId: 'smart', name: 'thinker' },
                ],
            }),
            /provider unavailable/
        );

        assert.equal(coordinator.snapshot().contests['game-1'].status, 'cancelled');
        assert.equal(manager.view(), null);
        assert.ok(manager.lastFailure?.error);
        assert.match(manager.lastFailure.error, /provider unavailable/);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy').map(([, name]) => name),
            ['speedy']
        );
    }, {
        createAgent: async settings => {
            attempts += 1;
            if (attempts === 2) return { success: false, error: 'provider unavailable' };
            return { success: true, settings };
        },
    });
});

test('ready timeout explains connected vs in-game agent state', async () => {
    await withManager(async ({ manager }) => {
        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [{ profileId: 'fast', name: 'speedy' }],
            }),
            /connected, not in-game yet/
        );
        assert.match(manager.lastFailure.error, /connected, not in-game yet/);
        assert.equal(manager.lastFailure.session.status, 'failed');
        assert.equal(manager.lastFailure.session.progress.stage, 'wait_ready');
    }, {
        isAgentReady: () => false,
        getAgentLaunchStatus: name => ({
            name,
            registered: true,
            socketConnected: true,
            inGame: false,
        }),
        readyTimeoutMs: 20,
        readyPollMs: 5,
    });
});

test('frees names held by leftover bots instead of refusing the roster', async () => {
    let online = ['leftover'];
    const reclaimed = [];
    await withManager(async ({ manager, coordinator }) => {
        await manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'leftover' }],
        });

        assert.deepEqual(reclaimed, [['leftover']]);
        assert.equal(manager.view().status, 'running');

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        getExistingAgentNames: () => online,
        reclaimNames: names => {
            reclaimed.push(names);
            online = online.filter(name => !names.includes(name));
        },
    });
});

test('team tower persists assignments and gives agents teammate and enemy context', async () => {
    const teamPreset = {
        ...preset,
        id: 'team_tower_battle',
        rules: {
            type: 'team_tower_battle',
            minimumPlayersPerTeam: 2,
            deathPenaltyBlocks: 5,
        },
    };
    let arenaOptions;
    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'team_tower_battle',
            teamNames: ['Ember', 'Tide'],
            participants: [
                { profileId: 'fast', name: 'alice', team: 'Ember' },
                { profileId: 'smart', name: 'amy', team: 'Ember' },
                { profileId: 'fast', name: 'bob', team: 'Tide' },
                { profileId: 'smart', name: 'ben', team: 'Tide' },
            ],
        });

        const contest = coordinator.snapshot().contests['game-1'];
        assert.deepEqual(contest.metadata.gameSession.teams, {
            Ember: ['alice', 'amy'],
            Tide: ['bob', 'ben'],
        });
        assert.equal(manager.view().participants[0].team, 'Ember');
        const aliceSettings = calls.find(
            ([type, settings]) => type === 'create' && settings.profile.name === 'alice'
        )[1].game_session;
        assert.deepEqual(aliceSettings.teammateIds, ['amy']);
        assert.deepEqual(aliceSettings.enemyIds, ['bob', 'ben']);
        assert.deepEqual(aliceSettings.rivalIds, ['bob', 'ben']);
        assert.deepEqual(arenaOptions.teamNames, ['Ember', 'Tide']);
        const directive = calls.find(
            ([type, name]) => type === 'directive' && name === 'alice'
        )[2];
        assert.match(directive, /YOUR TEAM: Ember/);
        assert.match(directive, /teammates are amy/);

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        getPreset: () => teamPreset,
        prepareArena: async (_game, _participants, options) => {
            arenaOptions = options;
            return { center: { x: 1, y: 2, z: 3 } };
        },
    });
});

test('team tower plans before the clock starts and points every teammate at one tower', async () => {
    const teamPreset = {
        ...preset,
        id: 'team_tower_battle',
        title: 'Team Tower Battle',
        rules: {
            type: 'team_tower_battle',
            minimumPlayersPerTeam: 2,
            planningMs: 60_000,
        },
    };
    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'team_tower_battle',
            teamNames: ['Ember', 'Tide'],
            planningMs: 45_000,
            participants: [
                { profileId: 'fast', name: 'alice', team: 'Ember' },
                { profileId: 'smart', name: 'amy', team: 'Ember' },
                { profileId: 'fast', name: 'bob', team: 'Tide' },
                { profileId: 'smart', name: 'ben', team: 'Tide' },
            ],
        });

        const types = calls.map(([type]) => type);
        const announcePlanningIndex = types.indexOf('announce-planning');
        const planningSleepIndex = calls.findIndex(
            ([type, ms]) => type === 'sleep' && ms === 45_000
        );
        const announceStartIndex = types.indexOf('announce-start');
        assert.ok(announcePlanningIndex >= 0, 'the narrator opens the planning phase');
        assert.equal(calls[announcePlanningIndex][2], 45_000);
        assert.ok(
            planningSleepIndex > announcePlanningIndex,
            'the planning window is held open after the callout'
        );
        assert.ok(
            planningSleepIndex < announceStartIndex,
            'planning finishes before the start countdown'
        );

        const directives = calls.filter(([type]) => type === 'directive');
        const planningDirectives = directives.filter(([, , prompt]) => /PLANNING PHASE/.test(prompt));
        assert.equal(planningDirectives.length, 4);
        assert.ok(
            planningDirectives.every(call => calls.indexOf(call) < planningSleepIndex),
            'bots get their planning brief before the planning window elapses'
        );

        const alicePlanning = planningDirectives.find(([, name]) => name === 'alice')[2];
        assert.match(alicePlanning, /about 45 seconds/);
        assert.match(alicePlanning, /YOUR TEAM: Ember/);
        assert.match(alicePlanning, /alice is the team captain/);
        assert.match(alicePlanning, /You are the captain/);
        assert.match(alicePlanning, /one exact x z coordinate/);
        assert.match(alicePlanning, /do NOT place or break blocks/);
        const amyPlanning = planningDirectives.find(([, name]) => name === 'amy')[2];
        assert.match(amyPlanning, /alice is the team captain/);
        assert.match(amyPlanning, /confirm the agreed spot without saying its numbers/);
        const bobPlanning = planningDirectives.find(([, name]) => name === 'bob')[2];
        assert.match(bobPlanning, /bob is the team captain/);

        const startDirectives = directives.filter(([, , prompt]) => !/PLANNING PHASE/.test(prompt));
        assert.equal(startDirectives.length, 4);
        assert.ok(
            startDirectives.every(([, , , options]) => options?.endConversations === true),
            'planning chatter is cut off so the match goal takes effect immediately'
        );
        const aliceStart = startDirectives.find(([, name]) => name === 'alice')[2];
        assert.match(aliceStart, /single tower base your team agreed on during planning/);
        assert.match(aliceStart, /never start a second one/);
        assert.match(aliceStart, /alice is your captain/);

        assert.equal(
            coordinator.snapshot().contests['game-1'].metadata.gameSession.planningMs,
            45_000
        );
        assert.deepEqual(
            coordinator.snapshot().contests['game-1'].metadata.gameSession.captainByTeam,
            { Ember: 'alice', Tide: 'bob' }
        );
        assert.deepEqual(
            coordinator.snapshot().contests['game-1'].metadata.gameSession.attackerByTeam,
            { Ember: 'amy', Tide: 'ben' }
        );

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        getPreset: () => teamPreset,
    });
});

test('Base Siege runs planning, then build, then combat directives', async () => {
    const siegePreset = {
        ...preset,
        id: 'team_base_siege',
        title: 'Base Siege',
        prompt: 'Last team standing wins. Arena shrinks if both hide.',
        rules: {
            type: 'team_base_siege',
            minimumPlayersPerTeam: 2,
            planningMs: 30_000,
            buildPhaseMs: 30_000,
            maxPressureRounds: 3,
        },
    };
    assert.equal(resolveBuildPhaseMs(undefined, siegePreset), 30_000);
    assert.equal(resolveBuildPhaseMs(15_000, siegePreset), 15_000);
    assert.throws(() => resolveBuildPhaseMs(-1, siegePreset), /cannot be negative/);

    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'team_base_siege',
            teamNames: ['Ember', 'Tide'],
            planningMs: 20_000,
            buildPhaseMs: 25_000,
            participants: [
                { profileId: 'fast', name: 'alice', team: 'Ember' },
                { profileId: 'smart', name: 'amy', team: 'Ember' },
                { profileId: 'fast', name: 'bob', team: 'Tide' },
                { profileId: 'smart', name: 'ben', team: 'Tide' },
            ],
        });

        const types = calls.map(([type]) => type);
        const planningIndex = types.indexOf('announce-planning');
        const buildIndex = types.indexOf('announce-build');
        const startIndex = types.indexOf('announce-start');
        assert.ok(planningIndex >= 0);
        assert.ok(buildIndex > planningIndex);
        assert.ok(startIndex > buildIndex);
        assert.equal(calls[planningIndex][2], 20_000);
        assert.equal(calls[buildIndex][2], 25_000);

        const sleeps = calls.filter(([type]) => type === 'sleep').map(([, ms]) => ms);
        assert.deepEqual(sleeps.filter(ms => ms === 20_000 || ms === 25_000), [20_000, 25_000]);

        const directives = calls.filter(([type]) => type === 'directive').map(([, name, prompt]) => ({ name, prompt }));
        assert.ok(directives.some(({ prompt }) => /PLANNING PHASE/.test(prompt) && /arena shrinks/i.test(prompt)));
        assert.ok(directives.some(({ prompt }) => /BUILD PHASE/.test(prompt) && /Do NOT attack enemies yet/i.test(prompt)));
        assert.ok(directives.some(({ prompt }) => /COMBAT IS ON/.test(prompt) && /Death eliminates you permanently/i.test(prompt)));
        assert.equal(
            coordinator.snapshot().contests['game-1'].metadata.gameSession.buildPhaseMs,
            25_000
        );
        assert.equal(
            coordinator.snapshot().contests['game-1'].metadata.gameSession.attackerByTeam,
            null
        );

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        getPreset: () => siegePreset,
    });
});

test('planning time falls back to the preset and can be turned off', async () => {
    const teamPreset = {
        ...preset,
        id: 'team_tower_battle',
        rules: { type: 'team_tower_battle', minimumPlayersPerTeam: 2, planningMs: 60_000 },
    };
    assert.equal(resolvePlanningMs(undefined, teamPreset), 60_000);
    assert.equal(resolvePlanningMs(0, teamPreset), 0);
    assert.equal(resolvePlanningMs(30_000, teamPreset), 30_000);
    assert.equal(resolvePlanningMs(undefined, preset), 0);
    assert.throws(() => resolvePlanningMs(-1, teamPreset), /cannot be negative/);
    assert.throws(() => resolvePlanningMs(11 * 60_000, teamPreset), /10 minutes or less/);

    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'team_tower_battle',
            teamNames: ['Ember', 'Tide'],
            planningMs: 0,
            participants: [
                { profileId: 'fast', name: 'alice', team: 'Ember' },
                { profileId: 'smart', name: 'amy', team: 'Ember' },
                { profileId: 'fast', name: 'bob', team: 'Tide' },
                { profileId: 'smart', name: 'ben', team: 'Tide' },
            ],
        });

        assert.equal(calls.filter(([type]) => type === 'announce-planning').length, 0);
        assert.equal(
            calls.filter(([type, , prompt]) => type === 'directive' && /PLANNING PHASE/.test(prompt)).length,
            0
        );

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        getPreset: () => teamPreset,
    });
});

test('a planning brief tells a non-captain who to follow and who to stay quiet around', () => {
    const directive = buildTeamPlanningDirective({
        title: 'Team Tower Battle',
        planningMs: 45_000,
        participantName: 'amy',
        teamId: 'Ember',
        teammateIds: ['alice'],
        enemyIds: ['bob', 'ben'],
        captainId: 'alice',
        attackerId: 'amy',
    });
    assert.match(directive, /The match has NOT started/);
    assert.match(directive, /only your team's single tallest tower counts/);
    assert.match(directive, /!startConversation with alice/);
    assert.match(directive, /The opposing team is bob, ben/);
    assert.match(directive, /!endConversation/);
    assert.match(directive, /refer to that base vaguely in your own words/);
    assert.doesNotMatch(directive, /say exactly/i);
    assert.doesNotMatch(directive, /Say the numbers out loud/);
    assert.doesNotMatch(directive, /You are the captain/);
    assert.match(directive, /YOU ARE THE ATTACKER/);
    assert.match(directive, /immediately cross the arena/);
});

test('team attacker selection assigns the first non-captain', () => {
    assert.equal(pickTeamAttacker(['alice', 'amy', 'alex'], 'alice'), 'amy');
    assert.equal(pickTeamAttacker(['alice'], 'alice'), null);
});

test('team directives give attackers and builders non-overlapping core jobs', () => {
    const team = {
        teamId: 'Ember',
        teammateIds: ['alice'],
        enemyIds: ['bob', 'ben'],
        captainId: 'alice',
        attackerId: 'amy',
    };
    const attacker = buildParticipantGameDirective(
        'Team Tower Battle.',
        ['alice', 'amy', 'bob', 'ben'],
        'amy',
        team
    );
    const builder = buildParticipantGameDirective(
        'Team Tower Battle.',
        ['alice', 'amy', 'bob', 'ben'],
        'alice',
        team
    );

    assert.match(attacker, /YOU ARE THE ATTACKER/);
    assert.match(attacker, /Use !attackPlayer on an enemy builder/);
    assert.match(attacker, /use !clearArea with the coordinates/);
    assert.match(attacker, /do not return to routine building/);
    assert.match(builder, /YOU ARE A BUILDER/);
    assert.match(builder, /every later block must touch that shared tower/);
    assert.match(builder, /never place a new foundation on bare ground/);
});

test('first cake team directives emphasize shared ingredient routes', () => {
    const directive = buildParticipantGameDirective(
        'First Cake.',
        ['Billy', 'Kimmy', 'Marcus', 'Dario', 'ChipChipperson', 'bridget'],
        'Billy',
        {
            contestType: 'cake_race',
            teamId: 'Ember',
            teammateIds: ['Kimmy', 'Marcus'],
            enemyIds: ['Dario', 'ChipChipperson', 'bridget'],
        }
    );
    assert.match(directive, /YOUR TEAM: Ember/);
    assert.match(directive, /Kimmy, Marcus/);
    assert.match(directive, /Split the cake ingredients/);
    assert.match(directive, /Any teammate crafting the cake wins/);
    assert.doesNotMatch(directive, /YOU ARE THE ATTACKER/);
    assert.doesNotMatch(directive, /tower/);
});

test('first cake planning brief splits ingredients and names a crafter, not a tower', () => {
    const directive = buildTeamPlanningDirective({
        title: 'First Cake',
        presetPrompt: 'CONTEST: First Cake.',
        planningMs: 60_000,
        participantName: 'Kimmy',
        teamId: 'Ember',
        teammateIds: ['Billy', 'Marcus'],
        enemyIds: ['Dario', 'ChipChipperson', 'bridget'],
        captainId: 'Billy',
        contestType: 'cake_race',
    });
    assert.match(directive, /The match has NOT started/);
    assert.match(directive, /first team to craft a cake wins/i);
    assert.match(directive, /THE INGREDIENT SPLIT/);
    assert.match(directive, /THE CRAFTER/);
    assert.match(directive, /!startConversation with Billy and Marcus/);
    assert.match(directive, /The opposing team is Dario, ChipChipperson, bridget/);
    assert.match(directive, /!endConversation/);
    assert.doesNotMatch(directive, /tower/i);
    assert.doesNotMatch(directive, /ATTACKER/i);
});

test('a refused second game leaves the running bots alone', async () => {
    const reclaimed = [];
    await withManager(async ({ manager, coordinator }) => {
        await manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        });
        reclaimed.length = 0;

        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [{ profileId: 'fast', name: 'speedy' }],
            }),
            error => {
                assert.match(error.message, /already active/);
                // The refusal is not the running game's failure, and callers use
                // this flag to keep it out of that game's diagnostics.
                assert.equal(error.launchRefused, true);
                return true;
            }
        );
        assert.deepEqual(reclaimed, []);

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        reclaimNames: names => reclaimed.push(names),
    });
});

// Pressing Start twice — a reopened roster after a connection blip, a second
// dashboard — used to answer with a failure report describing the launch that
// was still running, filing its current step as the thing that broke.
test('a second start mid-launch is refused by name and step, not blamed on the launch', async () => {
    let releaseArena = null;
    const arenaReached = new Promise(resolve => {
        releaseArena = resolve;
    });
    await withManager(async ({ manager, coordinator }) => {
        const launch = manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        });
        await arenaReached;

        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [{ profileId: 'smart', name: 'thinker' }],
            }),
            error => {
                assert.match(error.message, /Tower is already active \(still on "Build the arena"\)/);
                assert.equal(error.launchRefused, true);
                return true;
            }
        );

        await launch;
        assert.equal(manager.view().status, 'running');
        assert.equal(manager.lastFailure, null, 'the running launch has no failure to report');

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
    }, {
        prepareArena: async () => {
            releaseArena();
            // Hold the step open long enough for the refused start to run.
            await new Promise(resolve => setImmediate(resolve));
            return { center: { x: 1, y: 2, z: 3 } };
        },
    });
});

test('only the goal that starts the clock tells a bot it can be knocked out', async () => {
    await withManager(async ({ manager, coordinator, calls }) => {
        await manager.start({
            gameId: 'tower',
            participants: [{ profileId: 'fast', name: 'speedy' }],
        });
        const goals = calls.filter(([type, , , options]) =>
            type === 'directive' && options?.gameStarted === true
        );
        assert.deepEqual(goals.map(([, name]) => name), ['speedy']);

        await coordinator.cancelContest('game-1', 'test complete');
        await manager.syncWithContestView(coordinator.view());
        // Podium and cleanup directives leave the flag off: nothing after the
        // match can knock a bot out of it.
        assert.equal(
            calls.filter(([type, , , options]) =>
                type === 'directive' && options?.gameStarted === true
            ).length,
            1
        );
    });
});

test('participant validation rejects catalog, name, and collision errors', () => {
    assert.throws(
        () => validateGameParticipants([{ profileId: 'missing', name: 'valid_name' }], profiles),
        /Unknown model profile/
    );
    assert.throws(
        () => validateGameParticipants([{ profileId: 'fast', name: 'x' }], profiles),
        /3-16/
    );
    assert.throws(
        () => validateGameParticipants([{ profileId: 'fast', name: 'colony_bot' }], profiles, ['colony_bot']),
        /already online/
    );
    assert.throws(
        () => validateGameParticipants([
            { profileId: 'fast', name: 'twin' },
            { profileId: 'smart', name: 'twin' },
        ], profiles),
        /must be unique/
    );
    assert.doesNotThrow(
        () => validateGameParticipants([{ profileId: 'fast', name: 'retired_bot' }], profiles, []),
        'a name from a finished session can be used again'
    );
    assert.throws(
        () => validateGameParticipants([
            { profileId: 'fast', name: 'valid_name', voice: 'v'.repeat(129) },
        ], profiles),
        /voice must be 128/
    );
    assert.throws(
        () => validateGameParticipants([
            { profileId: 'fast', name: 'valid_name', systemPrompt: 'p'.repeat(4001) },
        ], profiles),
        /system prompt must be 4000/
    );
});

test('team setup requires two distinct teams with two assigned players each', () => {
    const participants = [
        { name: 'alice', team: 'Ember' },
        { name: 'amy', team: 'Ember' },
        { name: 'bob', team: 'Tide' },
        { name: 'ben', team: 'Tide' },
    ];
    assert.deepEqual(
        validateTeamSetup(participants, ['Ember', 'Tide']),
        {
            teamNames: ['Ember', 'Tide'],
            teamByParticipant: {
                alice: 'Ember',
                amy: 'Ember',
                bob: 'Tide',
                ben: 'Tide',
            },
            teams: {
                Ember: ['alice', 'amy'],
                Tide: ['bob', 'ben'],
            },
        }
    );
    assert.throws(
        () => validateTeamSetup(participants, ['Ember', 'ember']),
        /must be different/
    );
    assert.throws(
        () => validateTeamSetup(participants.slice(0, 3), ['Ember', 'Tide']),
        /needs at least 2/
    );
});

test('system addendum remains separate and optional', () => {
    assert.equal(appendSystemPromptAddendum('Base prompt', ''), 'Base prompt');
    assert.equal(
        appendSystemPromptAddendum('Base prompt', '  Be dramatic.  '),
        'Base prompt\n\nGAME SESSION SYSTEM ADDENDUM\nBe dramatic.'
    );
});

test('speech style prompt requires concise coordinate-free dialogue', () => {
    const prompt = appendSpeechStylePrompt('Base prompt');
    assert.match(prompt, /one short sentence/);
    assert.match(prompt, /no more than 10 words/);
    assert.match(prompt, /Never say numeric coordinates aloud/);
    assert.match(prompt, /use different wording every time/);
    assert.doesNotMatch(prompt, /say exactly/i);
});

test('game content prompt prioritizes unique strategy talk over repetitive roasting', () => {
    const prompt = buildGameSystemPrompt('Use pirate slang.');
    assert.match(prompt, /signature strategy/);
    assert.match(prompt, /Do not repeat/);
    assert.match(prompt, /If nothing has changed, keep playing/);
    assert.match(prompt, /Most of your speech should reveal useful thinking/);
    assert.match(prompt, /!startConversation/);
    assert.match(prompt, /bluff, misdirect/);
    assert.match(prompt, /occasional seasoning/);
    assert.match(prompt, /Prefer clever mind games/);
    assert.match(prompt, /Do not copy another competitor/);
    assert.match(prompt, /no slurs/);
    assert.match(prompt, /SESSION-SPECIFIC ADDENDUM\nUse pirate slang\./);
});

test('participant directives require distinct strategies and purposeful mind games', () => {
    const directive = buildParticipantGameDirective(
        'Find a diamond.',
        ['speedy', 'thinker', 'miner'],
        'thinker'
    );
    assert.match(directive, /COMPETITORS: speedy, thinker, miner/);
    assert.match(directive, /Your rivals are speedy, miner/);
    assert.match(directive, /signature strategy that fits your personality/);
    assert.match(directive, /never recycle earlier lines/);
    assert.match(directive, /!startConversation/);
    assert.match(directive, /brief mind game/);
    assert.match(directive, /do not turn every conversation into a roast/);
    assert.doesNotMatch(directive, /Your rivals are .*thinker/);
});

test('Spleef directives start dedicated competitive play without conversation detours', () => {
    const directive = buildParticipantGameDirective(
        'Play Spleef.',
        ['speedy', 'thinker', 'miner'],
        'thinker',
        { contestType: 'spleef' }
    );
    assert.match(directive, /ACTIVE RIVALS: speedy, miner/);
    assert.match(directive, /starts !playSpleef\(100\) for you automatically/);
    assert.doesNotMatch(directive, /!startConversation/);
});

test('Hot Button directives start the automatic press action', () => {
    const directive = buildParticipantGameDirective(
        'Press a button.',
        ['speedy', 'thinker', 'miner'],
        'thinker',
        { contestType: 'hot_button' }
    );
    assert.match(directive, /ACTIVE RIVALS: speedy, miner/);
    assert.match(directive, /starts !playHotButton for you automatically/);
    assert.match(directive, /Refusing to press loses/);
    assert.doesNotMatch(directive, /!startConversation/);
});

test('Self-destruct directives push immediate environmental death without spawning', () => {
    const directive = buildParticipantGameDirective(
        'Die first. Do not spawn.',
        ['speedy', 'thinker', 'miner'],
        'thinker',
        { contestType: 'death_race' }
    );
    assert.match(directive, /Speed wins/);
    assert.match(directive, /outer rim|searchForBlock/i);
    assert.match(directive, /Do not place or spawn/);
    assert.doesNotMatch(directive, /water|drown/i);
    assert.doesNotMatch(directive, /!startConversation/);
});

test('recording manifests filter by session without unrelated clips', () => {
    const text = [
        JSON.stringify({ file: '/a.mp4', sessionId: 'contest-game-1', contestId: 'game-1', startedAt: 10, endedAt: 20 }),
        JSON.stringify({ file: '/b.mp4', sessionId: null, contestId: null, startedAt: 15, endedAt: 25 }),
        '{broken',
    ].join('\n');

    const entries = filterRecordingManifest(text, { session: 'game-1' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, '/a.mp4');
    assert.match(serializeRecordingManifest(entries), /contest-game-1/);
});

const spleefPreset = {
    id: 'spleef',
    title: 'Spleef',
    prompt: 'Dig rivals into the pit.',
    durationMs: 60_000,
    rules: { type: 'spleef', scoring: 'last-standing', floorY: 100 },
    metadata: { arena: 'spleef-v1' },
};

test('Spleef best-of-3 continues to the next match instead of the podium', async () => {
    let nextId = 0;
    await withManager(
        async ({ manager, coordinator, calls }) => {
            const result = await manager.start({
                gameId: 'spleef',
                bestOf: 3,
                participants: [
                    { profileId: 'fast', name: 'Billy' },
                    { profileId: 'smart', name: 'Kimmy' },
                ],
                durationMs: 60_000,
            });

            assert.equal(result.contest.status, 'running');
            assert.equal(manager.view().series.bestOf, 3);
            assert.equal(manager.view().series.winsNeeded, 2);
            assert.equal(manager.view().series.matchIndex, 1);
            assert.equal(result.contest.metadata.series.bestOf, 3);

            await coordinator.eliminate(result.contest.id, 'Kimmy', { reason: 'fell' });
            assert.equal(coordinator.snapshot().contests[result.contest.id].status, 'completed');

            await manager.syncWithContestView(coordinator.view());

            const session = manager.view();
            assert.equal(session.status, 'running');
            assert.notEqual(session.contestId, result.contest.id);
            assert.equal(session.series.scores.Billy, 1);
            assert.equal(session.series.scores.Kimmy, 0);
            assert.equal(session.series.matchIndex, 2);
            assert.equal(session.series.seriesWinnerIds, null);
            assert.ok(
                calls.some(([type]) => type === 'announce-series-intermission'),
                'narrator calls the series score between matches'
            );
            assert.ok(
                !calls.some(([type]) => type === 'present-results'),
                'podium ceremony waits until the series is decided'
            );
            assert.equal(
                calls.filter(([type]) => type === 'arena').length,
                2,
                'arena rebuilds for the rematch'
            );
            const rematchPause = calls.find(
                ([type, , prompt, options]) => type === 'directive'
                    && options?.pause === true
                    && options?.gameStarted === false
                    && /arena resets/i.test(prompt)
            );
            assert.ok(rematchPause, 'bots pause with gameStarted false between matches');
            const rematchGoals = calls.filter(
                ([type, , , options]) => type === 'directive'
                    && options?.gameStarted === true
                    && options?.automaticAction === 'play-spleef'
            );
            assert.ok(rematchGoals.length >= 4, 'play-spleef goals fire for both matches');
        },
        {
            getPreset: () => spleefPreset,
        },
        {
            idFactory: () => `spleef-${++nextId}`,
        }
    );
});

test('Spleef best-of-3 crowns the series after two wins and runs the ceremony', async () => {
    let nextId = 0;
    await withManager(
        async ({ manager, coordinator, calls }) => {
            const first = await manager.start({
                gameId: 'spleef',
                bestOf: 3,
                participants: [
                    { profileId: 'fast', name: 'Billy' },
                    { profileId: 'smart', name: 'Kimmy' },
                ],
            });
            await coordinator.eliminate(first.contest.id, 'Kimmy', { reason: 'fell' });
            await manager.syncWithContestView(coordinator.view());

            const matchTwoId = manager.view().contestId;
            await coordinator.eliminate(matchTwoId, 'Kimmy', { reason: 'fell' });
            await manager.syncWithContestView(coordinator.view());

            const session = manager.view();
            assert.equal(session.status, 'awaiting-next-game');
            assert.deepEqual(session.series.seriesWinnerIds, ['Billy']);
            assert.equal(session.series.scores.Billy, 2);
            assert.ok(calls.some(([type]) => type === 'announce-series-result'));
            assert.ok(calls.some(([type]) => type === 'present-results'));
            assert.ok(calls.some(([type]) => type === 'present-winner'));
        },
        {
            getPreset: () => spleefPreset,
            winnerRevealMs: 0,
            podiumHoldMs: 60_000,
        },
        {
            idFactory: () => `spleef-${++nextId}`,
        }
    );
});
