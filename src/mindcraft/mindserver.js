import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import process from 'node:process';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { hasKey } from '../utils/keys.js';
import {
    VOICE_POOL, VOICE_DESCRIPTIONS, DEFAULT_ELEVENLABS_MODEL,
    getVoicesConfig, saveVoicesConfig, autoVoiceName, resolveVoice, resolveVoiceName,
} from '../agent/tts_voices.js';
import { TTSConfig as elevenLabsTTSConfig } from '../models/elevenlabs.js';
import { ColonyCoordinator } from './colony/colony_coordinator.js';
import { colonyControlsAgent, isGameSessionAgent } from './agent_ownership.js';
import {
    CONTEST_NARRATOR_CHARACTER,
    ContestArenaManager,
    ContestAnnouncer,
    ContestCoordinator,
    ContestHud,
    ContestLoop,
    ContestRecordingManager,
    SpectatorDirector,
    GameSessionManager,
    HighlightReelBuilder,
    TowerHighScoreStore,
    buildGameSystemPrompt,
    buildSurvivorEliminationCommands,
    defaultJudge,
    filterRecordingManifest,
    findDogRaceWinner,
    formatSurvivorBossbar,
    getArenaJoinInfo,
    getContestGamePreset,
    getSurvivorSeasonPreset,
    listContestGamePresets,
    listSurvivorScenarios,
    safeHighlightSessionId,
    scoreDepthRace,
    scoreTowerBattle,
    serializeRecordingManifest,
} from './contest/index.js';
import { PrivateRoomRegistry } from './survivor/private_rooms.js';
import { SurvivorCoordinator } from './survivor/survivor_coordinator.js';
import { SurvivorSessionManager } from './survivor/survivor_session_manager.js';
import { runMinecraftCommand } from './minecraft_server.js';
import { getGpt56Profiles } from './model_profiles.js';
import { ensureSkin, SKINS_DIR } from './skins.js';
import { assignModelTeam } from './nametags.js';
import { clearSpeechQueue, playSpeech } from '../agent/speak.js';
import { VoiceOutput } from './voice_output.js';
import * as launchTelemetry from './diagnostics/launch_telemetry.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
// Bots are identified by a per-instance id, never by their Minecraft name. A
// name is a label a bot wears while it is alive; the next bot is free to wear
// the same one with completely different settings, stats, and history.
const agent_connections = new Map();
let agent_id_seq = 0;
const agent_listeners = [];
const operator_sockets = new Set();
// Host speakers always play bot and narrator lines; browser pages opt in as
// extra monitors. See public/bot_voice.js for the client half.
const voiceOutput = new VoiceOutput({
    playOnHost: ({ agentName, text, audio }) => playSpeech({
        text,
        model: 'elevenlabs',
        botName: agentName,
        volume: 100,
        audioPromise: Promise.resolve(audio),
    }),
    clearHost: clearSpeechQueue,
});
let colonyCoordinator = null;
let colonyReady = null;
let colonySupervisorInterval = null;
let colonySettings = null;
let contestCoordinator = null;
let contestReady = null;
let contestLoop = null;
let gameSessionManager = null;
let survivorCoordinator = null;
let survivorRecovery = null;
let survivorSessionManager = null;
let survivorRooms = null;
let towerHighScores = null;
let liveTowerAtlas = null;
const contestArenaManager = new ContestArenaManager();
const spectatorDirector = new SpectatorDirector({
    isContestActive: contestId => {
        const active = contestCoordinator?.view()?.activeContest;
        return active?.id === contestId && ['running', 'judging'].includes(active.status);
    },
    onUpdate: () => emitContestUpdate(),
});
const contestHud = new ContestHud({ getLeader: getContestLeader });
const contestRecordingManager = new ContestRecordingManager({
    requestAgent: requestContestRecordingCommand,
});
const contestAnnouncer = new ContestAnnouncer({
    speak: speakContestAnnouncement,
});
const highlightJobs = new Map();
let highlightReelBuilder = null;

// Circuit breaker for non-retryable model provider failures (exhausted credits, revoked
// keys). While it is open the colony stays paused and a single agent probes the provider on
// an exponential backoff instead of every agent retrying on every self-prompt.
const idleModelOutage = Object.freeze({
    active: false,
    reason: null,
    code: null,
    since: null,
    attempts: 0,
    nextProbeAt: 0,
});
let modelOutage = { ...idleModelOutage };

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));
const projectRoot = path.resolve(__dirname, '../..');
highlightReelBuilder = new HighlightReelBuilder({
    botsRoot: path.join(projectRoot, 'bots'),
});
const providerKeys = {
    anthropic: 'ANTHROPIC_API_KEY',
    azure: 'AZURE_OPENAI_API_KEY',
    cerebras: 'CEREBRAS_API_KEY',
    cursor: 'CURSOR_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    glhf: 'GHLF_API_KEY',
    google: 'GEMINI_API_KEY',
    groq: 'GROQCLOUD_API_KEY',
    huggingface: 'HUGGINGFACE_API_KEY',
    hyperbolic: 'HYPERBOLIC_API_KEY',
    mercury: 'MERCURY_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    novita: 'NOVITA_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    qwen: 'QWEN_API_KEY',
    replicate: 'REPLICATE_API_KEY',
    xai: 'XAI_API_KEY',
};

function getProfileProvider(profile) {
    if (typeof profile.model === 'object' && profile.model?.api) {
        return profile.model.api.toLowerCase();
    }

    const model = typeof profile.model === 'string'
        ? profile.model.toLowerCase()
        : profile.model?.model?.toLowerCase() || '';
    const explicitProvider = model.includes('/') ? model.split('/')[0] : null;
    if (explicitProvider && (providerKeys[explicitProvider] || ['ollama', 'vllm', 'lmstudio'].includes(explicitProvider))) {
        return explicitProvider;
    }
    if (model.startsWith('gpt-') || /^o[1-9]/.test(model)) return 'openai';
    if (model.startsWith('claude')) return 'anthropic';
    if (model.startsWith('gemini')) return 'google';
    if (model.startsWith('grok')) return 'xai';
    if (model.startsWith('deepseek')) return 'deepseek';
    if (model.startsWith('qwen')) return 'qwen';
    if (model.startsWith('mercury')) return 'mercury';
    if (model.startsWith('mistral')) return 'mistral';
    if (model.startsWith('composer')) return 'cursor';
    return explicitProvider || 'unknown';
}

function isProviderConfigured(provider) {
    if (['ollama', 'vllm', 'lmstudio'].includes(provider)) {
        return false;
    }
    const key = providerKeys[provider];
    return key ? Boolean(hasKey(key)) : false;
}

function getAvailableProfiles() {
    const profilePaths = [
        path.join(projectRoot, 'andy.json'),
        ...readdirSync(path.join(projectRoot, 'profiles'), { withFileTypes: true })
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(entry => path.join(projectRoot, 'profiles', entry.name)),
    ];

    const generatedProfiles = getGpt56Profiles().map(profile => ({
        ...profile,
        configured: isProviderConfigured(profile.provider),
    }));
    const fileProfiles = profilePaths.flatMap(profilePath => {
        try {
            const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
            if (!profile.name) {
                return [];
            }
            const model = typeof profile.model === 'string'
                ? profile.model
                : profile.model?.model || profile.model?.api || 'default model';
            const provider = getProfileProvider(profile);
            return [{
                id: path.basename(profilePath, '.json'),
                name: profile.name,
                model,
                provider,
                configured: isProviderConfigured(provider),
                profile,
            }];
        } catch (error) {
            console.warn(`Skipping invalid profile ${profilePath}: ${error.message}`);
            return [];
        }
    }).filter(profile => profile.configured);

    fileProfiles.sort((a, b) => {
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        if (a.provider !== b.provider) {
            if (a.provider === 'cursor') return -1;
            if (b.provider === 'cursor') return 1;
        }
        return a.name.localeCompare(b.name);
    });

    return [
        ...generatedProfiles.filter(profile => profile.configured),
        ...fileProfiles,
    ];
}

function getColonyRoot(options) {
    return path.resolve(projectRoot, options.state_dir || './colony');
}

function getContestRoot(options) {
    return path.resolve(projectRoot, options.state_dir || './contests');
}

function defaultContestOptions() {
    for (const connection of agent_connections.values()) {
        if (connection.settings?.contest) {
            return { enabled: true, ...connection.settings.contest };
        }
    }
    return {
        enabled: true,
        state_dir: './contests',
        tick_interval_ms: 1000,
    };
}

function emitContestUpdate(socket = io) {
    if (contestCoordinator && socket) {
        socket.emit('contest-update', {
            ...contestCoordinator.view(),
            gameSession: gameSessionManager?.view() ?? null,
            spectatorDirector: spectatorDirector.view(),
            towerHighScores: towerHighScores?.list() ?? [],
            towerAtlas: liveTowerAtlas,
        });
    }
}

function emitToOperators(eventName, payload) {
    for (const socket of operator_sockets) {
        if (socket.connected) socket.emit(eventName, payload);
    }
}

function emitSurvivorUpdate() {
    const view = survivorSessionManager?.view() ?? null;
    emitToOperators('survivor-update', view);
    syncSurvivorHud(view).catch(error => {
        console.warn('Could not update Survivor HUD:', error.message);
    });
}

async function syncSurvivorHud(view) {
    if (!view?.game || view.game.status !== 'running') return;
    const label = formatSurvivorBossbar(
        view.game,
        view.phaseDeadlineAt,
        Date.now()
    );
    await Promise.all([
        runMinecraftCommand('bossbar add mindcraft:survivor "Survivor"').catch(() => {}),
        runMinecraftCommand(`bossbar set mindcraft:survivor name ${JSON.stringify({ text: label })}`),
        runMinecraftCommand('bossbar set mindcraft:survivor players @a'),
        runMinecraftCommand('bossbar set mindcraft:survivor max 100'),
        runMinecraftCommand('bossbar set mindcraft:survivor value 100'),
        runMinecraftCommand('bossbar set mindcraft:survivor visible true'),
    ]);
}

function handleSurvivorRoomEvent(event) {
    if (!event) return;
    survivorCoordinator?.recordPrivateEvent(event).catch(error => {
        console.warn('Could not journal private Survivor event:', error.message);
    });
    emitToOperators('survivor-secret-event', event);
    if (event.type === 'room.created') {
        for (const inviteeId of event.invitedIds || []) {
            getConnection(inviteeId)?.socket?.emit('survivor-room-invite', event);
        }
        return;
    }
    if (event.type === 'room.message') {
        for (const memberId of event.memberIds || []) {
            if (memberId !== event.senderId) {
                getConnection(memberId)?.socket?.emit('survivor-room-message', event);
            }
        }
        return;
    }
    if (event.type === 'room.closed') {
        for (const memberId of event.memberIds || []) {
            getConnection(memberId)?.socket?.emit('survivor-room-closed', event);
        }
    }
}

async function recordTowerHighScores(view) {
    if (!towerHighScores) return [];
    try {
        return await towerHighScores.recordContests(view?.contests || []);
    } catch (error) {
        console.error('Could not persist tower high scores:', error);
        return [];
    }
}

async function ensureContest(options) {
    const resolved = options ?? defaultContestOptions();
    if (!resolved?.enabled) return null;
    if (!contestReady) {
        const root = getContestRoot(resolved);
        const coordinatorOptions = { root, judge: judgeContest };
        contestReady = (existsSync(path.join(root, 'state.json'))
            ? ContestCoordinator.load(coordinatorOptions)
            : ContestCoordinator.create(coordinatorOptions)
        ).then(async coordinator => {
            contestCoordinator = coordinator;
            towerHighScores = await TowerHighScoreStore.create({ root });
            await recordTowerHighScores(coordinator.view());
            gameSessionManager = new GameSessionManager({
                coordinator,
                getPreset: getContestGamePreset,
                getProfiles: getAvailableProfiles,
                getExistingAgentNames: reservedAgentNames,
                resolveParticipantVoice: resolveVoiceName,
                reclaimNames: reclaimAgentNames,
                buildAgentSettings: buildGameAgentSettings,
                createAgent: settings => mindcraft.createAgent(settings),
                destroyAgent: destroyGameAgent,
                isAgentReady: agentRef => {
                    const connection = getConnection(agentRef);
                    return Boolean(connection?.socket && connection.in_game);
                },
                getAgentLaunchStatus: agentRef => {
                    const connection = getConnection(agentRef);
                    if (!connection) {
                        return {
                            name: agentRef,
                            registered: false,
                            socketConnected: false,
                            inGame: false,
                        };
                    }
                    return {
                        name: connection.name || agentRef,
                        id: connection.id,
                        registered: true,
                        socketConnected: Boolean(connection.socket),
                        inGame: Boolean(connection.in_game),
                    };
                },
                prepareArena: (preset, participants) =>
                    contestArenaManager.prepare(preset, participants),
                presentWinner: contest => contestArenaManager.presentWinner(contest),
                presentResults: contest => contestArenaManager.presentResults(contest),
                startRecording: options => contestRecordingManager.start(options),
                stopRecording: contestId => contestRecordingManager.stop(contestId),
                queueHighlight: ({ session, contest }) => queueContestHighlight({ session, contest }),
                sendDirective: sendGameDirective,
                clearQueuedVoice: clearContestVoice,
                announceStart: contest => contestAnnouncer.announceStart(contest),
                announceResult: contest => contestAnnouncer.announceResult(contest),
                announceVisualResult: () => contestHud.sync(contestCoordinator.view()),
                onUpdate: () => emitContestUpdate(),
                telemetry: {
                    record: event => launchTelemetry.record(event),
                    recordError: (error, context) => launchTelemetry.recordError(error, context),
                    clear: () => launchTelemetry.clearLaunchTelemetry(),
                },
            });
            const survivorRoot = path.join(root, 'survivor');
            survivorCoordinator = existsSync(path.join(survivorRoot, 'state.json'))
                ? await SurvivorCoordinator.load({ root: survivorRoot })
                : await SurvivorCoordinator.create({ root: survivorRoot });
            survivorRooms = new PrivateRoomRegistry({
                onEvent: handleSurvivorRoomEvent,
            });
            const survivorPreset = getSurvivorSeasonPreset();
            survivorSessionManager = new SurvivorSessionManager({
                coordinator: survivorCoordinator,
                contestCoordinator: coordinator,
                rooms: survivorRooms,
                getProfiles: getAvailableProfiles,
                getExistingAgentNames: reservedAgentNames,
                resolveParticipantVoice: resolveVoiceName,
                reclaimNames: reclaimAgentNames,
                buildAgentSettings: buildGameAgentSettings,
                createAgent: settings => mindcraft.createAgent(settings),
                destroyAgent: destroyGameAgent,
                isAgentReady: agentRef => {
                    const connection = getConnection(agentRef);
                    return Boolean(connection?.socket && connection.in_game);
                },
                getAgentLaunchStatus: agentRef => {
                    const connection = getConnection(agentRef);
                    if (!connection) {
                        return {
                            name: agentRef,
                            registered: false,
                            socketConnected: false,
                            inGame: false,
                        };
                    }
                    return {
                        name: connection.name || agentRef,
                        registered: true,
                        socketConnected: Boolean(connection.socket),
                        inGame: Boolean(connection.in_game),
                    };
                },
                telemetry: {
                    record: event => launchTelemetry.record(event),
                    recordError: (error, context) => launchTelemetry.recordError(error, context),
                },
                getContestPreset: getContestGamePreset,
                prepareArena: (preset, participants) =>
                    contestArenaManager.prepare(preset, participants),
                sendDirective: sendGameDirective,
                sendChallengeConfig: (agentRef, config) => {
                    const connection = getConnection(agentRef);
                    if (!connection?.socket) {
                        return Promise.reject(new Error(`Agent '${agentRef}' is not connected`));
                    }
                    connection.socket.emit('survivor-challenge-config', config);
                    return Promise.resolve();
                },
                phaseDurationsMs: {
                    strategy: survivorPreset.phaseDurationsMs.strategy,
                    voting: survivorPreset.phaseDurationsMs.voting,
                    revote: survivorPreset.phaseDurationsMs.revote,
                    deadlock: survivorPreset.phaseDurationsMs.deadlock,
                    jury_questioning: survivorPreset.phaseDurationsMs.juryQuestioning,
                    jury_voting: survivorPreset.phaseDurationsMs.juryVoting,
                },
                onEliminated: async (playerId, state) => {
                    await Promise.allSettled(
                        buildSurvivorEliminationCommands(playerId).map(command =>
                            runMinecraftCommand(command)
                        )
                    );
                    await speakContestAnnouncement(
                        `${playerId}, the tribe has spoken. ${state.players[playerId].jury ? 'You are now on the jury.' : ''}`
                    ).catch(error => console.warn('Survivor elimination announcement failed:', error));
                },
                onCompleted: async state => {
                    await speakContestAnnouncement(
                        `${state.winnerIds[0]} is the Sole Survivor!`
                    ).catch(error => console.warn('Survivor winner announcement failed:', error));
                },
                onUpdate: emitSurvivorUpdate,
            });
            contestLoop = new ContestLoop({
                coordinator,
                intervalMs: resolved.tick_interval_ms ?? 1000,
                onTick: async view => {
                    await survivorSessionManager?.tick();
                    const completed = await detectDogRaceWinner(view);
                    if (!completed) {
                        const gameSessionOwnsResult = !view.activeContest
                            && Boolean(gameSessionManager?.view());
                        await Promise.all([
                            gameSessionOwnsResult ? Promise.resolve() : contestHud.sync(view),
                            refreshLiveTowerAtlas(view),
                        ]);
                        io?.emit('tower-atlas-update', liveTowerAtlas);
                    }
                },
                onUpdate: async view => {
                    await recordTowerHighScores(view);
                    if (!view.activeContest && spectatorDirector.view().enabled) {
                        await spectatorDirector.stop();
                    }
                    emitContestUpdate();
                    if (gameSessionManager) {
                        await gameSessionManager.syncWithContestView(view);
                    }
                    if (survivorSessionManager) {
                        await survivorSessionManager.syncContestView(view);
                    } else if (!view.activeContest) {
                        await contestRecordingManager.stop();
                    }
                },
            });
            contestLoop.start();
            return coordinator;
        }).catch(error => {
            // A half-built contest stack must not be cached, or every later call
            // replays this same rejection and the subsystem never recovers.
            if (contestReady === pending) contestReady = null;
            console.error('[contest] bootstrap failed:', error?.stack || error?.message || error);
            launchTelemetry.recordError(error, { stage: 'contest_bootstrap' });
            throw error;
        });
        const pending = contestReady;
        // Recovery re-creates bots, and registering a bot awaits ensureContest().
        // Awaiting it inside the chain above would make this promise wait on itself.
        pending.then(() => recoverSurvivorSeason(), () => {});
    }
    return contestReady;
}

function recoverSurvivorSeason() {
    if (survivorRecovery) return survivorRecovery;
    if (!survivorSessionManager) return Promise.resolve(null);
    survivorRecovery = survivorSessionManager.recover()
        .catch(error => {
            buildSurvivorFailureReport(error, 'recovery');
            console.error(
                '[survivor] season recovery failed:',
                error?.stack || error?.message || error
            );
            console.error(
                '[survivor] copy the report from the Games tab (Copy diagnostics) '
                + 'or the diagnostics-report socket event, then cancel the season to reset.'
            );
            return null;
        })
        .finally(() => {
            survivorRecovery = null;
        });
    return survivorRecovery;
}

function getMinecraftJoinInfo() {
    for (const connection of agent_connections.values()) {
        const host = connection.settings?.host;
        const port = connection.settings?.port;
        if (host && Number.isFinite(port) && port > 0) {
            return {
                host,
                port,
                address: `${host}:${port}`,
                mindserverPort: io?.httpServer?.address?.()?.port
                    ?? connection.settings?.mindserver_port
                    ?? 8080,
                ...getArenaJoinInfo(),
            };
        }
    }
    return {
        host: '127.0.0.1',
        port: 55916,
        address: '127.0.0.1:55916',
        mindserverPort: 8080,
        ...getArenaJoinInfo(),
    };
}

function defaultSettingsForProfile(profile) {
    const settings = { profile };
    for (const [key, configuration] of Object.entries(settings_spec)) {
        if (key !== 'profile' && Object.hasOwn(configuration, 'default')) {
            settings[key] = JSON.parse(JSON.stringify(configuration.default));
        }
    }
    return settings;
}

function buildGameAgentSettings(profile, gameSession) {
    const settings = defaultSettingsForProfile(profile);
    const promptAddenda = [
        gameSession.personalityPrompt
            ? `YOUR PERSONALITY\n${gameSession.personalityPrompt}`
            : '',
        gameSession.systemPrompt
            ? `MATCH-WIDE INSTRUCTIONS\n${gameSession.systemPrompt}`
            : '',
    ].filter(Boolean).join('\n\n');
    settings.profile.speak_model = gameSession.voice
        ? { api: 'elevenlabs', voice: gameSession.voice }
        : 'elevenlabs';
    settings.load_memory = false;
    settings.init_message = null;
    settings.speak = true;
    settings.speak_proximity = false;
    settings.render_bot_view = true;
    settings.record_bot_view = false;
    settings.record_actions = false;
    settings.chat_ingame = true;
    settings.chat_bot_messages = true;
    settings.colony = { ...(settings.colony || {}), enabled: false };
    settings.game_session = {
        ...gameSession,
        speakAll: true,
        serverBroadcastVoice: true,
        talkOverMining: true,
        systemPrompt: buildGameSystemPrompt(promptAddenda),
    };
    return settings;
}

async function destroyGameAgent(agentRef) {
    const connection = getConnection(agentRef);
    if (!connection) return;
    mindcraft.destroyAgent(connection.id);
    await unregisterAgent(connection.id, 'removed');
}

function sendGameDirective(agentRef, prompt, options = {}) {
    const connection = getConnection(agentRef);
    if (!connection?.socket || !connection.in_game) {
        return Promise.reject(new Error(`Agent '${agentRef}' is not ready for a game directive`));
    }
    return new Promise((resolve, reject) => {
        connection.socket.timeout(20000).emit(
            'game-directive',
            {
                prompt,
                pause: options.pause === true,
                react: options.react === true,
            },
            (error, result) => {
                if (error) {
                    reject(new Error(`Game directive timed out for ${connection.name}`));
                    return;
                }
                if (!result?.success) {
                    reject(new Error(result?.error || `Game directive failed for ${connection.name}`));
                    return;
                }
                resolve(result);
            }
        );
    });
}

function clearContestVoice(contest) {
    voiceOutput.clear();
    for (const participantId of contest?.participantIds || []) {
        const connection = getConnection(participantId);
        if (connection?.socket?.connected) {
            connection.socket.emit('contest-clear-speech');
        }
    }
}

async function speakContestAnnouncement(text, options = {}) {
    const voiceSettings = options.delivery === 'booming'
        ? {
            stability: 0.35,
            similarity_boost: 0.8,
            style: 1,
            use_speaker_boost: true,
        }
        : null;
    const audio = await elevenLabsTTSConfig.sendAudioRequest(
        text,
        getVoicesConfig().elevenlabs_model,
        resolveVoice(CONTEST_NARRATOR_CHARACTER.name, CONTEST_NARRATOR_CHARACTER.voice),
        elevenLabsTTSConfig.baseUrl,
        { voiceSettings }
    );
    const sessionId = gameSessionManager?.view()?.sessionId;
    if (sessionId) {
        broadcastContestSessionRecordingAudio(sessionId, {
            sessionId,
            speaker: CONTEST_NARRATOR_CHARACTER.name,
            audio,
            atMs: Date.now(),
        });
    }
    dispatchBotVoice({
        agentName: CONTEST_NARRATOR_CHARACTER.name,
        text,
        audio,
    });
}

function requestGameTowerReport(agentRef, options = {}) {
    const { timeoutMs = 20000, warn = true } = options;
    const connection = getConnection(agentRef);
    if (!connection?.socket || !connection.in_game) {
        return Promise.resolve(null);
    }
    return new Promise(resolve => {
        connection.socket.timeout(timeoutMs).emit('game-tower-report', (error, result) => {
            if (error || !result?.success) {
                if (warn) console.warn(
                    `Could not measure tower for ${connection.name}: `
                    + (error ? 'timed out' : result?.error || 'unknown error')
                );
                resolve(null);
                return;
            }
            resolve(result.report);
        });
    });
}

async function collectTowerReports(participantIds, options) {
    const reports = await Promise.all(
        participantIds.map(participantId => requestGameTowerReport(participantId, options))
    );
    return reports
        .map((report, index) => report && {
            ...report,
            participantId: participantIds[index],
        })
        .filter(Boolean);
}

function measureDepthRace(contest) {
    return scoreDepthRace({
        participantIds: contest.participantIds,
        runCommand: runMinecraftCommand,
        startY: contest.rules.startY,
    });
}

async function refreshLiveTowerAtlas(view) {
    const contest = view?.activeContest;
    if (
        !contest
        || contest.status !== 'running'
        || contest.rules?.type !== 'tower_battle'
    ) {
        liveTowerAtlas = null;
        return null;
    }

    const floorY = getArenaJoinInfo().arena.center.y;
    const reports = await collectTowerReports(contest.participantIds, {
        timeoutMs: 750,
        warn: false,
    });
    const reportingParticipants = new Set(reports.map(report => report.participantId));
    const scored = scoreTowerBattle({
        reports,
        floorY,
        participantIds: contest.participantIds,
    }).sort((left, right) =>
        right.score - left.score || left.participantId.localeCompare(right.participantId)
    );
    let previousScore = null;
    let previousRank = 0;
    liveTowerAtlas = {
        contestId: contest.id,
        floorY,
        updatedAt: Date.now(),
        standings: scored.map((result, index) => {
            const rank = result.score === previousScore ? previousRank : index + 1;
            previousScore = result.score;
            previousRank = rank;
            return {
                participantId: result.participantId,
                height: result.details?.towerHeight ?? result.score ?? 0,
                blocksStanding: result.details?.blocksStanding ?? 0,
                measuredFrom: result.details?.measuredFrom ?? 'no-tower',
                reporting: reportingParticipants.has(result.participantId),
                rank,
            };
        }),
    };
    return liveTowerAtlas;
}

async function getContestLeader(contest) {
    let results;
    if (contest.rules?.type === 'tower_battle') {
        const floorY = getArenaJoinInfo().arena.center.y;
        const reports = await collectTowerReports(contest.participantIds);
        results = scoreTowerBattle({
            reports,
            floorY,
            participantIds: contest.participantIds,
        }).filter(result => result.score > 0);
    } else if (contest.rules?.type === 'depth_race') {
        results = (await measureDepthRace(contest))
            .filter(result => !result.disqualified);
    } else {
        results = defaultJudge(contest).filter(result => !result.disqualified);
    }
    if (results.length === 0) return null;
    results.sort((left, right) =>
        right.score - left.score || left.participantId.localeCompare(right.participantId)
    );
    const leaders = results.filter(result => result.score === results[0].score);
    return {
        ...results[0],
        participantId: leaders.map(result => result.participantId).join(' & '),
    };
}

async function detectDogRaceWinner(view) {
    const contest = view?.activeContest;
    const participantId = await findDogRaceWinner(contest, runMinecraftCommand);
    if (!participantId) return false;

    const current = contestCoordinator?.snapshot().contests[contest.id];
    if (current?.status !== 'running' || contestCoordinator.snapshot().activeContestId !== contest.id) {
        return false;
    }
    await contestCoordinator.declareWinner(contest.id, participantId, {
        goal: 'tamed_wolf',
        advancement: contest.rules.winAdvancement,
        elapsedMs: Date.now() - current.startedAt,
    });
    const completedView = contestCoordinator.view();
    emitContestUpdate();
    if (survivorSessionManager?.view()?.challengeContestId === contest.id) {
        await survivorSessionManager.syncContestView(completedView);
    } else if (gameSessionManager?.view()?.contestId === contest.id) {
        await gameSessionManager.syncWithContestView(completedView);
    } else {
        await contestHud.sync(completedView);
        await contestRecordingManager.stop(contest.id);
    }
    return true;
}

/**
 * Timed spatial games are measured from the world when the clock runs out, so
 * bots do not need to stop playing to submit a result.
 */
async function judgeContest(contest) {
    if (contest.rules?.type === 'depth_race') {
        return measureDepthRace(contest);
    }
    if (contest.rules?.type === 'tower_battle') {
        const floorY = getArenaJoinInfo().arena.center.y;
        const reports = await collectTowerReports(contest.participantIds);
        return scoreTowerBattle({
            reports,
            floorY,
            participantIds: contest.participantIds,
        });
    }
    return defaultJudge(contest);
}

function requestContestRecordingCommand(agentRef, event, options) {
    const connection = getConnection(agentRef);
    if (!connection?.socket || !connection.in_game) {
        return Promise.reject(new Error(`Agent '${agentRef}' is not in game`));
    }
    return new Promise((resolve, reject) => {
        const args = options === undefined ? [] : [options];
        connection.socket.timeout(60000).emit(event, ...args, (error, result) => {
            if (error) {
                reject(new Error(`${event} timed out for ${connection.name}`));
                return;
            }
            resolve(result);
        });
    });
}

function highlightSessionCandidates(contestOrSessionId) {
    const id = String(contestOrSessionId || '').trim();
    if (!id) return [];
    const candidates = [id];
    if (!id.startsWith('contest-')) candidates.push(`contest-${id}`);
    return candidates;
}

function highlightStatusPath(sessionId) {
    const safe = safeHighlightSessionId(sessionId);
    return path.join(projectRoot, 'bots', 'highlights', safe, 'status.json');
}

function highlightPublicUrl(sessionId) {
    const safe = safeHighlightSessionId(sessionId);
    return `/bots/highlights/${encodeURIComponent(safe)}/highlight.mp4`;
}

function mapHighlightStatus(raw, sessionId) {
    if (!raw) {
        return { success: true, status: 'missing', sessionId };
    }
    const stateMap = {
        queued: 'queued',
        building: 'processing',
        processing: 'processing',
        complete: 'ready',
        ready: 'ready',
        failed: 'failed',
    };
    const status = stateMap[raw.state] || raw.state || 'missing';
    const durationSeconds = Number(raw.durationSeconds);
    return {
        success: true,
        status,
        sessionId: raw.sessionId || sessionId,
        error: raw.error || null,
        durationMs: Number.isFinite(durationSeconds)
            ? Math.round(durationSeconds * 1000)
            : null,
        url: status === 'ready' ? highlightPublicUrl(raw.sessionId || sessionId) : null,
        segments: Array.isArray(raw.segments) ? raw.segments.length : 0,
    };
}

function readHighlightStatus(contestOrSessionId) {
    for (const sessionId of highlightSessionCandidates(contestOrSessionId)) {
        if (highlightJobs.has(sessionId)) {
            return mapHighlightStatus(
                { state: 'building', sessionId },
                sessionId
            );
        }
        try {
            const statusPath = highlightStatusPath(sessionId);
            if (!existsSync(statusPath)) continue;
            const raw = JSON.parse(readFileSync(statusPath, 'utf8'));
            return mapHighlightStatus(raw, sessionId);
        } catch (error) {
            return {
                success: false,
                status: 'failed',
                sessionId,
                error: error.message,
                url: null,
            };
        }
    }
    return mapHighlightStatus(null, contestOrSessionId);
}

async function queueContestHighlight({ session = null, contest = null, contestId = null } = {}) {
    await ensureContest();
    const resolvedContest = contest
        || contestCoordinator?.snapshot()?.contests?.[contestId]
        || contestCoordinator?.snapshot()?.contests?.[session?.contestId]
        || null;
    if (!resolvedContest) {
        throw new Error('Contest not found for highlight reel');
    }
    if (resolvedContest.status !== 'completed') {
        throw new Error('Highlight reels are only built for completed contests');
    }

    const sessionId = session?.sessionId
        || `contest-${resolvedContest.id}`;
    if (highlightJobs.has(sessionId)) {
        return { success: true, status: 'processing', sessionId };
    }

    const selection = { session: sessionId };
    let entries = readManifestEntries(selection);
    if (!entries.length) {
        // Also accept the bare contest id in case older clips used that key.
        entries = readManifestEntries({ session: resolvedContest.id });
    }
    if (!entries.length) {
        throw new Error('No finished session recordings are available for a highlight reel');
    }

    const statusPath = highlightStatusPath(sessionId);
    mkdirSync(path.dirname(statusPath), { recursive: true });
    writeFileSync(statusPath, `${JSON.stringify({
        state: 'queued',
        sessionId,
        startedAt: Date.now(),
    }, null, 2)}\n`);

    const job = highlightReelBuilder.build({
        sessionId,
        manifestEntries: entries,
        contest: resolvedContest,
    }).finally(() => {
        highlightJobs.delete(sessionId);
        emitContestUpdate();
    });
    highlightJobs.set(sessionId, job);
    job.catch(error => {
        console.warn(`Highlight reel failed for ${sessionId}:`, error.message);
    });
    emitContestUpdate();
    return { success: true, status: 'queued', sessionId };
}

async function startContestGame(gameId, options = {}) {
    if (!hasKey('ELEVENLABS_API_KEY')) {
        throw new Error('ELEVENLABS_API_KEY is required for globally audible contest voices');
    }
    await ensureContest();
    if (!gameSessionManager) {
        throw new Error('Game session manager is not enabled');
    }
    if (survivorSessionManager?.view()) {
        throw new Error('A Survivor season is active. Cancel it before starting another game.');
    }
    try {
        const result = await gameSessionManager.start({
            gameId,
            participants: options.participants,
            systemPrompt: options.systemPrompt,
            durationMs: options.durationMs,
        });
        await contestHud.sync(contestCoordinator.view());
        return {
            ...result,
            game: listContestGamePresets().find(game => game.id === gameId),
            join: {
                ...getMinecraftJoinInfo(),
                arena: result.arenaReset,
            },
        };
    } catch (error) {
        const report = buildLaunchFailureReport(error);
        error.diagnosticsReport = report;
        throw error;
    }
}

function collectAgentLaunchSnapshots(session = null) {
    const names = new Set([
        ...(session?.participantIds || []),
        ...(session?.createdAgents || []).map(agent => agent.name),
    ]);
    if (names.size === 0) {
        for (const connection of agent_connections.values()) {
            if (connection?.name) names.add(connection.name);
        }
    }
    return [...names].map(name => {
        const connection = getConnection(name);
        if (!connection) {
            return {
                name,
                registered: false,
                socketConnected: false,
                inGame: false,
            };
        }
        return {
            name: connection.name || name,
            id: connection.id,
            registered: true,
            socketConnected: Boolean(connection.socket),
            inGame: Boolean(connection.in_game),
        };
    });
}

function buildLaunchFailureReport(error) {
    const failure = gameSessionManager?.lastFailure || null;
    const session = failure?.session || gameSessionManager?.view() || null;
    const join = getMinecraftJoinInfo();
    return launchTelemetry.captureFailureReport({
        error,
        gameSession: session,
        contestView: contestCoordinator?.view?.() || null,
        agents: collectAgentLaunchSnapshots(session),
        env: {
            node: process.version,
            platform: process.platform,
            minecraftAddress: join.address,
            mindserverPort: join.mindserverPort,
        },
    });
}

function buildSurvivorFailureReport(error, stage = 'survivor') {
    const session = survivorSessionManager?.lastFailure?.session
        || survivorSessionManager?.view()?.active
        || null;
    const join = getMinecraftJoinInfo();
    return launchTelemetry.captureFailureReport({
        error,
        gameSession: session
            ? {
                ...session,
                gameId: 'survivor',
                title: 'Survivor Bot Season',
                contestId: session.challengeContestId || null,
                progress: { stage, message: error?.message || 'Survivor season failure' },
            }
            : { gameId: 'survivor', title: 'Survivor Bot Season', progress: { stage } },
        contestView: contestCoordinator?.view?.() || null,
        agents: collectAgentLaunchSnapshots(session),
        env: {
            node: process.version,
            platform: process.platform,
            minecraftAddress: join.address,
            mindserverPort: join.mindserverPort,
        },
    });
}

async function ensureColony(options) {
    if (!options?.enabled) return null;
    colonySettings = { ...options };
    if (!colonyReady) {
        const root = getColonyRoot(options);
        const coordinatorOptions = {
            root,
            leaseMs: options.task_lease_ms ?? 300000,
            spawnCooldownMs: options.spawn_cooldown_ms ?? 120000,
        };
        colonyReady = (existsSync(path.join(root, 'state.json'))
            ? ColonyCoordinator.load(coordinatorOptions)
            : ColonyCoordinator.create(coordinatorOptions)
        ).then(coordinator => {
            colonyCoordinator = coordinator;
            startColonySupervisor();
            return coordinator;
        });
    }
    return colonyReady;
}

function emitColonyUpdate(socket = io) {
    if (colonyCoordinator && socket) {
        socket.emit('colony-update', colonyCoordinator.view());
    }
}

function agentRole(settings) {
    return settings.profile?.colony_role || 'generalist';
}

function currentAgentTask(agentName) {
    return colonyCoordinator.currentTaskFor(agentName);
}

function formatColonyStatus(agentName) {
    const directive = colonyCoordinator.directiveFor(agentName);
    const assigned = directive.claimedTasks[0];
    const available = directive.availableTasks.slice(0, 5)
        .map(task => `${task.id} [${task.role || 'any'}]: ${task.title}`)
        .join('\n');
    return [
        `COLONY PHASE: ${directive.phaseTitle}`,
        `OBJECTIVE: ${directive.objective}`,
        `YOUR ROLE: ${directive.agent.role}`,
        `YOUR TASK: ${assigned ? `${assigned.id}: ${assigned.title}` : 'none claimed'}`,
        `NEXT ACTION: ${directive.instruction}`,
        `AVAILABLE:\n${available || 'No open tasks; propose the next useful task.'}`,
    ].join('\n');
}

async function handleColonyCommand(agentName, command) {
    if (!colonyCoordinator) {
        throw new Error('Colony coordinator is not enabled');
    }
    const { type, payload = {} } = command || {};
    let data;
    switch (type) {
        case 'status':
            return { success: true, message: formatColonyStatus(agentName) };
        case 'task':
            data = currentAgentTask(agentName);
            return {
                success: true,
                data,
                message: data
                    ? `Current task ${data.id}: ${data.title}\n${data.description}`
                    : 'No task claimed. Use !claimColonyTask.',
            };
        case 'claim-task':
            data = await colonyCoordinator.claimNextTask(agentName);
            break;
        case 'complete-task': {
            const task = currentAgentTask(agentName);
            if (!task) throw new Error('No current task to complete');
            data = await colonyCoordinator.completeTask(task.id, agentName, payload.summary);
            break;
        }
        case 'fail-task': {
            const task = currentAgentTask(agentName);
            if (!task) throw new Error('No current task to release');
            data = await colonyCoordinator.failTask(task.id, agentName, payload.reason);
            break;
        }
        case 'propose-task': {
            const agent = colonyCoordinator.snapshot().agents[agentName];
            data = await colonyCoordinator.proposeTask({
                title: payload.title,
                description: payload.details,
                role: agent.role,
                priority: 50,
            });
            break;
        }
        case 'record-progress':
            data = await colonyCoordinator.recordProgress(agentName, payload.summary);
            break;
        case 'publish-artifact':
            data = {
                path: await colonyCoordinator.writeArtifact(payload.path, payload.content),
            };
            break;
        case 'request-agent':
            // Roster changes are manual from the Mindcraft UI. Agents may not
            // auto-replace stopped/removed bots by requesting new specialists.
            data = {
                accepted: false,
                reason: 'manual-roster',
                message: 'Agent roster is managed from the Mindcraft UI. Removing an agent does not spawn a replacement.',
            };
            break;
        case 'model-outage':
            data = await openModelOutage(agentName, payload);
            break;
        default:
            throw new Error(`Unknown colony command: ${type}`);
    }
    emitColonyUpdate();
    return {
        success: true,
        data,
        message: `Colony ${type} succeeded: ${JSON.stringify(data)}`,
    };
}

function firstAgentSettings() {
    return listConnections()[0]?.settings ?? null;
}

async function createColonyAgent(name, role, storedProfile = null) {
    const template = firstAgentSettings();
    if (!template) throw new Error('No agent settings are available as a spawn template');
    const settings = structuredClone(template);
    settings.profile = structuredClone(storedProfile || template.profile);
    settings.profile.name = name;
    settings.profile.colony_role = role;
    settings.load_memory = true;
    settings.init_message = `You are the colony ${role}. Stay well-rounded: always keep and upgrade a sword, shield, armor, food, and tools—role specialty never means skipping combat gear. Read !colonyStatus, claim suitable work, coordinate, and progress continuously.`;
    const result = await mindcraft.createAgent(settings);
    if (!result.success) throw new Error(result.error || `Failed to create ${name}`);
    return name;
}

async function restoreDesiredAgents() {
    const snapshot = colonyCoordinator.snapshot();
    if (snapshot.paused) return;
    const agents = snapshot.agents;
    for (const agent of Object.values(agents)) {
        const latest = colonyCoordinator.snapshot();
        if (latest.paused || !latest.agents[agent.id]?.desired ||
            connectionsNamed(agent.id).length || !agent.profile) continue;
        try {
            await createColonyAgent(agent.id, agent.role, agent.profile);
        } catch (error) {
            console.error(`Failed to restore colony agent ${agent.id}:`, error);
        }
    }
}

function requestFullState(connection) {
    return new Promise((resolve) => {
        if (!connection?.socket) {
            resolve(null);
            return;
        }
        const timeout = setTimeout(() => resolve(null), 5000);
        connection.socket.emit('get-full-state', state => {
            clearTimeout(timeout);
            resolve(state);
        });
    });
}

function requestWallState(connection) {
    return new Promise((resolve) => {
        if (!connection?.socket) {
            resolve(null);
            return;
        }
        const timeout = setTimeout(() => resolve(null), 5000);
        connection.socket.emit('get-wall-state', state => {
            clearTimeout(timeout);
            resolve(state);
        });
    });
}

function sendColonyDirective(connection) {
    if (!connection.socket) return;
    const directive = colonyCoordinator.directiveFor(connection.name);
    connection.last_directive_at = Date.now();
    connection.socket.emit('colony-directive', directive, result => {
        if (!result?.success) {
            console.warn(`Colony directive was rejected by ${connection.name}: ${result?.error}`);
            return;
        }
        if (result.status && result.status !== 'started') {
            console.log(`Colony directive for ${connection.name}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`);
        }
    });
}

function broadcastColonyDirectives() {
    for (const connection of agent_connections.values()) {
        if (connection.socket && colonyCoordinator.snapshot().agents[connection.name]) {
            sendColonyDirective(connection);
        }
    }
}

function modelProbeBaseMs() {
    return colonySettings?.model_probe_base_ms ?? 60000;
}

function modelProbeMaxMs() {
    return colonySettings?.model_probe_max_ms ?? 900000;
}

/** Opens the breaker: pauses the colony and tells every agent to stand down. */
async function openModelOutage(reportedBy, payload = {}) {
    const reason = payload.message || 'The model provider rejected requests';
    if (modelOutage.active) {
        return { alreadyOpen: true, reason: modelOutage.reason };
    }
    modelOutage = {
        active: true,
        reason,
        code: payload.code ?? null,
        since: Date.now(),
        attempts: 0,
        nextProbeAt: Date.now() + modelProbeBaseMs(),
    };
    const label = payload.kind === 'auth'
        ? 'Model credentials rejected'
        : 'Model provider quota exhausted';
    console.error(`${label} (reported by ${reportedBy}): ${reason}`);
    console.error(`Colony paused. Probing the provider again in ${Math.round(modelProbeBaseMs() / 1000)}s.`);
    await colonyCoordinator.pause(`${label}: ${reason}`);
    broadcastColonyDirectives();
    emitColonyUpdate();
    return { paused: true, reason };
}

function closeModelOutage() {
    modelOutage = { ...idleModelOutage };
}

function requestModelProbe(connection) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);
        connection.socket.emit('model-probe', result => {
            clearTimeout(timeout);
            resolve(Boolean(result?.ok));
        });
    });
}

/**
 * Half-open state: asks one live agent to spend a single cheap request testing the provider.
 * Success resumes the colony; failure backs off exponentially up to the configured ceiling.
 */
async function runModelOutageProbe() {
    const now = Date.now();
    if (!modelOutage.active || now < modelOutage.nextProbeAt) return;

    const connection = listConnections()
        .find(candidate => candidate.socket && candidate.in_game);
    if (!connection) {
        modelOutage.nextProbeAt = now + modelProbeBaseMs();
        return;
    }

    modelOutage.attempts += 1;
    const recovered = await requestModelProbe(connection);
    if (recovered) {
        const downFor = Math.round((Date.now() - modelOutage.since) / 1000);
        console.log(`Model provider recovered after ${downFor}s; resuming the colony.`);
        closeModelOutage();
        await colonyCoordinator.resume();
        broadcastColonyDirectives();
        return;
    }

    const backoff = Math.min(
        modelProbeBaseMs() * 2 ** (modelOutage.attempts - 1),
        modelProbeMaxMs()
    );
    modelOutage.nextProbeAt = Date.now() + backoff;
    console.warn(`Model provider still unavailable (attempt ${modelOutage.attempts}); retrying in ${Math.round(backoff / 1000)}s.`);
}

let colonySupervisorRunning = false;
async function runColonySupervisor() {
    if (!colonyCoordinator || colonySupervisorRunning) return;
    colonySupervisorRunning = true;
    try {
        await colonyCoordinator.expireLeases();
        const now = Date.now();
        let state = colonyCoordinator.snapshot();

        for (const agent of Object.values(state.agents)) {
            if (!connectionsNamed(agent.id).length && agent.status !== 'offline') {
                await colonyCoordinator.updateAgent(agent.id, { status: 'offline' });
            }
        }

        // Runs while paused so an open breaker can close itself without manual help.
        if (modelOutage.active) {
            await runModelOutageProbe();
        }

        state = colonyCoordinator.snapshot();
        if (state.paused) {
            emitColonyUpdate();
            return;
        }

        await restoreDesiredAgents();
        state = colonyCoordinator.snapshot();

        // Reject leftover auto-spawn requests instead of creating replacements.
        // New agents are added only via the Mindcraft UI create-agent flow.
        for (const request of state.spawn.requests.filter(item => item.status === 'pending')) {
            await colonyCoordinator.resolveSpawnRequest(request.id, 'rejected');
            console.log(`Rejected pending colony spawn request ${request.id} (${request.role}): manual roster`);
        }

        const wallStates = await Promise.all(listConnections().map(async (connection) => {
            const colonyAgent = colonyCoordinator.snapshot().agents[connection.name];
            if (!colonyAgent || !colonyControlsAgent(connection)
                || !connection.in_game || !connection.socket) {
                return [connection, null];
            }
            try {
                const state = await requestWallState(connection);
                return [connection, state];
            } catch (e) {
                return [connection, null];
            }
        }));

        for (const [connection, wallState] of wallStates) {
            const agentName = connection.name;
            const colonyAgent = colonyCoordinator.snapshot().agents[agentName];
            if (!colonyAgent || !colonyControlsAgent(connection)) continue;
            if (connection.in_game && connection.socket) {
                const phase = wallState?.action?.phase
                    || (wallState?.action?.isIdle ? 'idle' : 'busy');
                const status = phase === 'idle' ? 'idle' : 'busy';
                await colonyCoordinator.heartbeat(agentName, status);
                const latestState = colonyCoordinator.snapshot();
                // Only nudge when the bot is truly available. Physically idle bots that are
                // already thinking or self-prompting look "Idle" in old UI but are busy.
                const available = wallState?.action?.available === true
                    || (wallState?.action?.available == null
                        && wallState?.action?.isIdle
                        && !wallState?.selfPrompt?.active
                        && !wallState?.action?.thinking);
                if (!latestState.paused && latestState.agents[agentName]?.desired &&
                    available &&
                    now - connection.last_directive_at >=
                    (colonySettings.idle_directive_ms ?? 15000)) {
                    sendColonyDirective(connection);
                }
            } else {
                const latestState = colonyCoordinator.snapshot();
                const latestAgent = latestState.agents[agentName];
                const process = mindcraft.getAgentProcess(connection.id);
                if (!latestState.paused && latestAgent?.desired &&
                    process && !process.running &&
                    now - connection.last_restart_attempt_at >= 30000) {
                    connection.last_restart_attempt_at = now;
                    mindcraft.startAgent(connection.id);
                }
            }
        }

        // Do not auto-request replacement agents. Stopping/removing a bot in the
        // UI must leave the roster smaller until a human creates another agent.
        emitColonyUpdate();
    } catch (error) {
        console.error('Colony supervisor pass failed:', error);
    } finally {
        colonySupervisorRunning = false;
    }
}

function startColonySupervisor() {
    if (colonySupervisorInterval) return;
    const interval = colonySettings.heartbeat_interval_ms ?? 10000;
    colonySupervisorInterval = setInterval(runColonySupervisor, interval);
    setTimeout(runColonySupervisor, 1000);
}

class AgentConnection {
    constructor(id, settings, viewer_port) {
        this.id = id;
        this.name = settings.profile.name;
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        this.last_directive_at = 0;
        this.last_restart_attempt_at = 0;
        this.recording = null; // POV recording status reported by the agent process
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

function listConnections() {
    return [...agent_connections.values()];
}

function isLiveConnection(connection) {
    return Boolean(connection?.socket) || connection?.in_game === true;
}

function connectionsNamed(name) {
    return listConnections().filter(connection => connection.name === name);
}

/**
 * Resolves an agent id or a Minecraft name to a connection. Names are only a
 * convenience for callers that speak in-game (chat, contests, the dashboard);
 * they resolve to whichever instance is currently wearing the name.
 */
function getConnection(agentRef) {
    if (!agentRef) return null;
    const byId = agent_connections.get(agentRef);
    if (byId) return byId;
    const named = connectionsNamed(agentRef);
    return named.find(isLiveConnection) ?? named.at(-1) ?? null;
}

function hasLiveAgentNamed(name) {
    return connectionsNamed(name).some(isLiveConnection);
}

/**
 * A leftover registration must never keep a name hostage. Temporary game bots
 * are always replaceable; every other bot holds its name only while it is
 * actually online.
 */
function holdsName(connection) {
    return isLiveConnection(connection) && !isGameSessionAgent(connection);
}

function reservedAgentNames() {
    return listConnections().filter(holdsName).map(connection => connection.name);
}

function forgetConnection(connection) {
    mindcraft.destroyAgent(connection.id);
    agent_connections.delete(connection.id);
}

async function waitUntil(predicate, timeoutMs, pollMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return predicate();
}

/**
 * Frees a name for a bot that is about to be created. Instances that no longer
 * hold the name are dropped outright; a replaceable one that is still online is
 * stopped first, because Minecraft refuses a second login while the previous
 * player of that name is still connected.
 */
async function reclaimAgentName(name) {
    const replaceable = connectionsNamed(name).filter(connection => !holdsName(connection));
    const online = replaceable.filter(isLiveConnection);
    for (const connection of online) {
        console.log(`Reclaiming the name ${name} from agent ${connection.id}`);
        mindcraft.stopAgent(connection.id);
    }
    if (online.length) {
        const left = await waitUntil(
            () => online.every(connection => !isLiveConnection(connection)),
            15000
        );
        if (!left) {
            console.warn(`Agent(s) named ${name} did not leave in time; reusing the name anyway`);
        }
    }
    for (const connection of replaceable) {
        forgetConnection(connection);
        await releaseColonyAgent(connection.name, 'replaced');
    }
    agentsStatusUpdate();
}

async function reclaimAgentNames(names) {
    for (const name of new Set(names)) {
        await reclaimAgentName(name);
    }
}

export async function registerAgent(settings, viewer_port) {
    // Every bot gets a generated skin keyed to its name + model so it is
    // visually unique in-game. Hand-authored profile skins are left alone.
    try {
        if (!settings.profile.skin || settings.profile.skin.generated) {
            settings.profile.skin = ensureSkin(settings.profile.name, settings.profile.model);
        }
    } catch (error) {
        console.error(`Failed to generate skin for ${settings.profile.name}:`, error);
    }
    const agentId = `${settings.profile.name}#${++agent_id_seq}`;
    // Drop any earlier instance that is no longer wearing this name so ghost
    // registrations cannot pile up under it.
    for (const connection of connectionsNamed(settings.profile.name)) {
        if (!isLiveConnection(connection)) forgetConnection(connection);
    }
    const agentConnection = new AgentConnection(agentId, settings, viewer_port);
    await ensureContest(settings.contest);
    const coordinator = settings.game_session
        ? null
        : await ensureColony(settings.colony);
    let registeredColonyAgent = null;
    if (coordinator) {
        registeredColonyAgent = await coordinator.registerAgent(
            settings.profile.name,
            agentRole(settings),
            'spawning',
            { desired: true, profile: settings.profile }
        );
    }
    agent_connections.set(agentId, agentConnection);
    emitColonyUpdate();
    emitContestUpdate();
    return { agentId, colonyAgent: registeredColonyAgent };
}

async function releaseColonyAgent(name, status) {
    if (colonyCoordinator?.snapshot().agents[name]) {
        await colonyCoordinator.updateAgent(name, { desired: false, status });
        emitColonyUpdate();
    }
}

export async function unregisterAgent(agentRef, status = 'failed') {
    const connection = getConnection(agentRef);
    if (!connection) return;
    agent_connections.delete(connection.id);
    // Tearing down a contest bot must not retire the colony agent that happens
    // to share its name.
    if (colonyControlsAgent(connection)) {
        await releaseColonyAgent(connection.name, status);
    }
}

export function logoutAgent(agentId) {
    const connection = agent_connections.get(agentId);
    if (connection) {
        connection.in_game = false;
        connection.recording = null;
        agentsStatusUpdate();
    }
}

// Forward a recording start/stop request from the UI to the agent's process and relay the ack.
function forwardRecordingCommand(agentRef, event, options, callback) {
    const conn = getConnection(agentRef);
    if (!conn?.socket) {
        callback?.({ success: false, error: `Agent '${agentRef}' is not connected` });
        return;
    }
    const args = options === undefined ? [] : [options];
    conn.socket.timeout(20000).emit(event, ...args, (err, result) => {
        if (err) {
            callback?.({ success: false, error: `Recording command timed out for ${conn.name}` });
            return;
        }
        if (result && typeof result === 'object' && 'recording' in result) {
            conn.recording = result;
        }
        agentsStatusUpdate();
        callback?.(result);
    });
}

// Scan bots/*/recordings for saved MP4s so the UI can list and link them.
function listRecordings() {
    const botsDir = path.join(projectRoot, 'bots');
    try {
        const agents = [];
        if (existsSync(botsDir)) {
            for (const entry of readdirSync(botsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const recDir = path.join(botsDir, entry.name, 'recordings');
                if (!existsSync(recDir)) continue;
                const files = readdirSync(recDir)
                    .filter(f => f.endsWith('.mp4'))
                    .map(f => {
                        const stats = statSync(path.join(recDir, f));
                        return {
                            file: f,
                            url: `/bots/${encodeURIComponent(entry.name)}/recordings/${encodeURIComponent(f)}`,
                            size: stats.size,
                            mtime: stats.mtimeMs,
                        };
                    })
                    .sort((a, b) => b.mtime - a.mtime);
                if (files.length) {
                    agents.push({ agent: entry.name, folder: recDir, files });
                }
            }
        }
        return { success: true, botsFolder: botsDir, agents };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Everything the Voices modal needs: the editable config, the voice pool,
// and every known bot (connected agents + bots already pinned in voices.json).
function voicesOverview() {
    const config = getVoicesConfig();
    const botNames = new Set([
        ...listConnections().map(connection => connection.name),
        ...Object.keys(config.bots),
    ]);
    return {
        success: true,
        config,
        defaultModel: DEFAULT_ELEVENLABS_MODEL,
        pool: Object.keys(VOICE_POOL).map(name => ({
            name,
            id: VOICE_POOL[name],
            description: VOICE_DESCRIPTIONS[name] || '',
        })),
        bots: [...botNames].sort().map(name => ({
            name,
            connected: hasLiveAgentNamed(name),
            assigned: config.bots[name] || null,
            autoVoice: autoVoiceName(name),
        })),
        previewAvailable: Boolean(hasKey('ELEVENLABS_API_KEY')),
    };
}

// —— Recording export (zip download / folder copy) ——

function parseExportSelection(query) {
    const session = String(query.session || '').trim();
    if (session) return { session };
    const since = Number(query.since);
    if (!Number.isFinite(since)) return null;
    const until = query.until ? Number(query.until) : Infinity;
    return { since, until: Number.isFinite(until) ? until : Infinity };
}

/**
 * Finished clips whose file was completed inside [since, until] (mtime is
 * when ffmpeg closed the file). Clips still being recorded are excluded —
 * they are not playable until stopped.
 */
function readManifestEntries(selection) {
    const manifestPath = path.join(projectRoot, 'bots', 'recordings-manifest.jsonl');
    if (!existsSync(manifestPath)) return [];
    return filterRecordingManifest(readFileSync(manifestPath, 'utf8'), selection);
}

function collectRecordingsForExport(selection) {
    const liveFiles = new Set(listConnections()
        .filter(conn => conn.recording?.recording && conn.recording?.file)
        .map(conn => conn.recording.file));
    if (selection.session) {
        const botsRoot = path.join(projectRoot, 'bots') + path.sep;
        const files = readManifestEntries(selection).flatMap(entry => {
            const fullPath = path.resolve(String(entry.file || ''));
            if (!fullPath.startsWith(botsRoot) || !existsSync(fullPath) || liveFiles.has(fullPath)) {
                return [];
            }
            const stats = statSync(fullPath);
            return [{
                bot: entry.bot,
                name: path.basename(fullPath),
                path: fullPath,
                size: stats.size,
                mtime: stats.mtimeMs,
            }];
        });
        files.sort((a, b) => a.mtime - b.mtime);
        return { files };
    }

    const listing = listRecordings();
    if (!listing.success) return { error: listing.error, files: [] };
    const files = [];
    for (const group of listing.agents) {
        for (const f of group.files) {
            const fullPath = path.join(group.folder, f.file);
            if (liveFiles.has(fullPath)) continue;
            if (f.mtime >= selection.since && f.mtime <= selection.until) {
                files.push({ bot: group.agent, name: f.file, path: fullPath, size: f.size, mtime: f.mtime });
            }
        }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    return { files };
}

// The matching slice of the shared manifest goes into every export so the
// exact start/end timestamps and action labels travel with the clips.
function manifestSliceForExport(selection) {
    return serializeRecordingManifest(readManifestEntries(selection));
}

function exportStamp(selection) {
    if (selection.session) {
        return `session_${selection.session.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    }
    const fmt = (ms) => new Date(ms).toISOString().replace(/[:]/g, '-').slice(0, 16);
    return selection.until === Infinity
        ? `${fmt(selection.since)}_onward`
        : `${fmt(selection.since)}_to_${fmt(selection.until)}`;
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const publicDir = path.join(__dirname, 'public');
    const indexHtml = path.join(publicDir, 'index.html');
    // index: false so `/` can redirect to `/colony` instead of silently serving index.html
    app.use(express.static(publicDir, { index: false }));
    // Client-side views share index.html; each has a real URL for copy/share/reload.
    app.get(['/colony', '/games'], (_req, res) => {
        res.sendFile(indexHtml);
    });
    app.get('/', (_req, res) => {
        res.redirect(302, '/colony');
    });
    // Serve bot data (POV recordings, screenshots) so the UI can play/download them
    app.use('/bots', express.static(path.join(projectRoot, 'bots')));
    // Generated bot skins (same /skins path the MC container sees them under)
    app.use('/skins', express.static(SKINS_DIR));

    // What an export window would contain, so the UI can preview before downloading.
    app.get('/api/recordings/export-info', (req, res) => {
        const selection = parseExportSelection(req.query);
        if (!selection) return res.status(400).json({ success: false, error: 'session or since (epoch ms) is required' });
        const { files, error } = collectRecordingsForExport(selection);
        if (error) return res.status(500).json({ success: false, error });
        res.json({
            success: true,
            count: files.length,
            bytes: files.reduce((sum, f) => sum + f.size, 0),
            bots: [...new Set(files.map(f => f.bot))],
        });
    });

    // Stream every finished clip in the window as one flat zip (+ manifest slice).
    app.get('/api/recordings/export.zip', (req, res) => {
        const selection = parseExportSelection(req.query);
        if (!selection) return res.status(400).json({ success: false, error: 'session or since (epoch ms) is required' });
        const { files, error } = collectRecordingsForExport(selection);
        if (error) return res.status(500).json({ success: false, error });
        if (!files.length) return res.status(404).json({ success: false, error: 'No finished clips in that time range' });

        // zip needs the manifest slice as a real file to include it in the archive
        const tmpDir = mkdtempSync(path.join(tmpdir(), 'rec-export-'));
        const manifestTmp = path.join(tmpDir, 'manifest.jsonl');
        writeFileSync(manifestTmp, manifestSliceForExport(selection));

        const stamp = exportStamp(selection);
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="recordings_${stamp}.zip"`);

        // -j flattens paths; clip filenames are unique (bot + timestamp + labels)
        const zip = spawn('zip', ['-q', '-j', '-', manifestTmp, ...files.map(f => f.path)]);
        zip.stdout.pipe(res);
        zip.stderr.on('data', (d) => console.error('zip:', d.toString().trim()));
        zip.on('error', (err) => {
            console.error('Recording export zip failed:', err.message);
            if (!res.headersSent) res.status(500).json({ success: false, error: `zip failed: ${err.message}` });
            else res.end();
        });
        zip.on('close', () => {
            rmSync(tmpDir, { recursive: true, force: true });
        });
        res.on('close', () => {
            if (zip.exitCode === null) zip.kill('SIGKILL');
        });
    });

    // Copy every finished clip in the window (+ manifest slice) into a folder on disk.
    app.get('/api/recordings/export-folder', (req, res) => {
        const selection = parseExportSelection(req.query);
        if (!selection) return res.status(400).json({ success: false, error: 'session or since (epoch ms) is required' });
        const { files, error } = collectRecordingsForExport(selection);
        if (error) return res.status(500).json({ success: false, error });
        if (!files.length) return res.status(404).json({ success: false, error: 'No finished clips in that time range' });
        try {
            const folder = path.join(projectRoot, 'bots', 'exports', `recordings_${exportStamp(selection)}`);
            mkdirSync(folder, { recursive: true });
            for (const f of files) {
                copyFileSync(f.path, path.join(folder, f.name));
            }
            writeFileSync(path.join(folder, 'manifest.jsonl'), manifestSliceForExport(selection));
            res.json({
                success: true,
                folder,
                count: files.length,
                bytes: files.reduce((sum, f) => sum + f.size, 0),
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get('/api/highlights/:contestId', (req, res) => {
        try {
            const payload = readHighlightStatus(req.params.contestId);
            const code = payload.status === 'missing' ? 404
                : payload.success === false ? 500
                : 200;
            res.status(code).json(payload);
        } catch (error) {
            res.status(400).json({
                success: false,
                status: 'failed',
                error: error.message,
            });
        }
    });

    app.post('/api/highlights/:contestId', async (req, res) => {
        try {
            const result = await queueContestHighlight({ contestId: req.params.contestId });
            res.json(result);
        } catch (error) {
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        // The agent process this socket belongs to, if any. Tracked by instance
        // id so a later bot reusing the name cannot be mistaken for this one.
        let curAgentId = null;
        const curAgent = () => (curAgentId ? agent_connections.get(curAgentId) : null);
        operator_sockets.add(socket);
        console.log('Client connected');

        agentsStatusUpdate(socket);

        socket.on('list-profiles', (callback) => {
            callback({ success: true, profiles: getAvailableProfiles() });
        });

        socket.on('colony-status', async (callback) => {
            try {
                if (colonyReady) await colonyReady;
                callback({
                    success: Boolean(colonyCoordinator),
                    data: colonyCoordinator?.view() ?? null,
                    error: colonyCoordinator ? null : 'Colony coordinator is not enabled',
                });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-status', async (callback) => {
            try {
                await ensureContest();
                callback({
                    success: Boolean(contestCoordinator),
                    data: contestCoordinator ? {
                        ...contestCoordinator.view(),
                        gameSession: gameSessionManager?.view() ?? null,
                        spectatorDirector: spectatorDirector.view(),
                        towerAtlas: liveTowerAtlas,
                    } : null,
                    games: listContestGamePresets(),
                    join: getMinecraftJoinInfo(),
                    error: contestCoordinator
                        ? null
                        : 'Contest coordinator is not enabled',
                });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-games', (callback) => {
            try {
                callback({ success: true, games: listContestGamePresets() });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('survivor-status', async callback => {
            try {
                await ensureContest();
                callback({
                    success: Boolean(survivorSessionManager),
                    data: survivorSessionManager?.view() ?? null,
                    preset: getSurvivorSeasonPreset(),
                    scenarios: listSurvivorScenarios(),
                    games: listContestGamePresets(),
                    join: getMinecraftJoinInfo(),
                    error: survivorSessionManager ? null : 'Survivor is not enabled',
                });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('survivor-start', async (request, callback) => {
            try {
                await ensureContest();
                if (!survivorSessionManager) throw new Error('Survivor is not enabled');
                if (gameSessionManager?.view()) throw new Error('A contest game is already active');
                const preset = getSurvivorSeasonPreset(request?.scenarioId);
                const data = await survivorSessionManager.start({
                    participants: request?.participants,
                    mergeAt: request?.mergeAt ?? preset.mergeAt,
                    finalistCount: request?.finalistCount ?? preset.finalistCount,
                    tribeNames: request?.tribeNames ?? preset.tribeNames,
                    challengeGameIds: request?.challengeGameIds ?? preset.challengeGameIds,
                    systemPrompt: request?.systemPrompt,
                    phaseDurationsMs: request?.phaseDurationsMs ?? {
                        strategy: preset.phaseDurationsMs.strategy,
                        voting: preset.phaseDurationsMs.voting,
                        revote: preset.phaseDurationsMs.revote,
                        deadlock: preset.phaseDurationsMs.deadlock,
                        jury_questioning: preset.phaseDurationsMs.juryQuestioning,
                        jury_voting: preset.phaseDurationsMs.juryVoting,
                    },
                });
                emitSurvivorUpdate();
                callback({ success: true, data });
            } catch (error) {
                const report = buildSurvivorFailureReport(error, 'startup');
                callback({ success: false, error: error.message, report });
            }
        });

        socket.on('survivor-control', async (request, callback) => {
            try {
                await ensureContest();
                if (!survivorSessionManager) throw new Error('Survivor is not enabled');
                const data = await survivorSessionManager.control(
                    request?.action,
                    request || {}
                );
                emitSurvivorUpdate();
                callback({ success: true, data });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('survivor-command', async (request, callback) => {
            try {
                const connection = curAgent();
                if (!connection) throw new Error('Only a Survivor bot can use this command');
                if (!survivorSessionManager?.view()) throw new Error('No Survivor season is active');
                const result = await survivorSessionManager.handleAgentCommand(
                    connection.name,
                    request?.type,
                    request?.payload || {}
                );
                emitSurvivorUpdate();
                callback(result);
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-start-game', async (request, callback) => {
            try {
                const data = await startContestGame(request?.gameId, {
                    durationMs: request?.durationMs,
                    participants: request?.participants,
                    systemPrompt: request?.systemPrompt,
                });
                callback({ success: true, data });
            } catch (error) {
                const report = error.diagnosticsReport || buildLaunchFailureReport(error);
                callback({ success: false, error: error.message, report });
            }
        });

        socket.on('diagnostics-report', (callback) => {
            try {
                const report = launchTelemetry.getLastFailureReport();
                callback({
                    success: true,
                    report,
                    meta: launchTelemetry.getLastFailureMeta(),
                    events: launchTelemetry.getLaunchEvents().slice(-80),
                });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-create', async (specification, callback) => {
            try {
                await ensureContest();
                if (!contestCoordinator) {
                    throw new Error('Contest coordinator is not enabled');
                }
                const data = await contestCoordinator.createContest(specification);
                emitContestUpdate();
                callback({ success: true, data });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-register', async (request, callback) => {
            try {
                await ensureContest();
                if (!contestCoordinator) {
                    throw new Error('Contest coordinator is not enabled');
                }
                const data = await contestCoordinator.registerParticipant(
                    request?.contestId,
                    request?.participantId
                );
                emitContestUpdate();
                callback({ success: true, data });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-control', async (request, callback) => {
            try {
                await ensureContest();
                if (!contestCoordinator) {
                    throw new Error('Contest coordinator is not enabled');
                }
                let data;
                switch (request?.action) {
                    case 'start':
                        data = await contestCoordinator.startContest(request.contestId);
                        break;
                    case 'cancel':
                        await spectatorDirector.stop();
                        if (gameSessionManager?.view()?.contestId === request.contestId) {
                            data = await gameSessionManager.cancel(
                                request.contestId,
                                request.reason || 'Cancelled from the Mindcraft UI'
                            );
                        } else {
                            data = await contestCoordinator.cancelContest(
                                request.contestId,
                                request.reason || 'Cancelled from the Mindcraft UI'
                            );
                            await contestRecordingManager.stop(request.contestId);
                        }
                        break;
                    case 'warp-spectators': {
                        const active = contestCoordinator.view().activeContest;
                        if (!active) {
                            throw new Error('No active contest to warp into');
                        }
                        data = await contestArenaManager.warpSpectators(active.participantIds || []);
                        break;
                    }
                    case 'start-spectator-director': {
                        const active = contestCoordinator.view().activeContest;
                        if (!active || !['running', 'judging'].includes(active.status)) {
                            throw new Error('No live contest to auto-direct');
                        }
                        data = await spectatorDirector.start(active);
                        break;
                    }
                    case 'stop-spectator-director':
                        data = await spectatorDirector.stop();
                        break;
                    default:
                        throw new Error(`Unknown contest control: ${request?.action}`);
                }
                await contestHud.sync(contestCoordinator.view());
                emitContestUpdate();
                callback({ success: true, data });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('contest-win-item', async (request, callback) => {
            try {
                const connection = curAgent();
                const active = contestCoordinator?.view()?.activeContest;
                if (!connection?.settings?.game_session || !active) {
                    throw new Error('Only an active game participant can report a win item');
                }
                if (connection.settings.game_session.contestId !== active.id) {
                    throw new Error('Game participant is not in the active contest');
                }
                const expectedItem = active.rules?.winItem;
                const itemName = String(request?.itemName || '').trim();
                if (!expectedItem || itemName !== expectedItem) {
                    throw new Error(`Contest requires ${expectedItem || 'no win item'}`);
                }
                const reportedPosition = request?.position;
                const position = reportedPosition
                    && [reportedPosition.x, reportedPosition.y, reportedPosition.z]
                        .every(Number.isFinite)
                    ? {
                        x: reportedPosition.x,
                        y: reportedPosition.y,
                        z: reportedPosition.z,
                    }
                    : null;
                const data = await contestCoordinator.declareWinner(
                    active.id,
                    connection.name,
                    {
                        item: itemName,
                        elapsedMs: Date.now() - active.startedAt,
                        ...(position ? { position } : {}),
                    }
                );
                const view = contestCoordinator.view();
                emitContestUpdate();
                callback?.({ success: true, data });

                const cleanup = survivorSessionManager?.view()?.challengeContestId === active.id
                    ? survivorSessionManager.syncContestView(view)
                    : gameSessionManager?.view()?.contestId === active.id
                        ? gameSessionManager.syncWithContestView(view)
                        : contestHud.sync(view).then(() => contestRecordingManager.stop(active.id));
                cleanup.catch(error => {
                    console.error(`Could not clean up completed contest ${active.id}:`, error);
                });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        socket.on('contest-death', async (_request, callback) => {
            try {
                const connection = curAgent();
                const active = contestCoordinator?.view()?.activeContest;
                if (!connection?.settings?.game_session || !active) {
                    throw new Error('Only an active game participant can report a death');
                }
                if (connection.settings.game_session.contestId !== active.id) {
                    throw new Error('Game participant is not in the active contest');
                }
                if (active.rules?.type !== 'death_race') {
                    throw new Error('The active contest is not a first-to-die game');
                }
                const data = await contestCoordinator.declareWinner(
                    active.id,
                    connection.name,
                    {
                        event: 'death',
                        elapsedMs: Date.now() - active.startedAt,
                    }
                );
                const view = contestCoordinator.view();
                emitContestUpdate();
                callback?.({ success: true, data });

                const cleanup = survivorSessionManager?.view()?.challengeContestId === active.id
                    ? survivorSessionManager.syncContestView(view)
                    : gameSessionManager?.view()?.contestId === active.id
                        ? gameSessionManager.syncWithContestView(view)
                        : contestHud.sync(view).then(() => contestRecordingManager.stop(active.id));
                cleanup.catch(error => {
                    console.error(`Could not clean up completed contest ${active.id}:`, error);
                });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        socket.on('contest-submit', async (request, callback) => {
            try {
                const connection = curAgent();
                if (!connection) {
                    throw new Error('Only a registered agent can submit to a contest');
                }
                await ensureContest();
                if (!contestCoordinator) {
                    throw new Error('Contest coordinator is not enabled');
                }
                const data = await contestCoordinator.submit(
                    request?.contestId,
                    connection.name,
                    request?.payload
                );
                const view = contestCoordinator.view();
                const completedGameSession = !view.activeContest
                    && gameSessionManager?.view()?.contestId === request?.contestId;
                const presentation = completedGameSession
                    ? gameSessionManager.syncWithContestView(view)
                    : contestHud.sync(view).then(async () => {
                        if (!view.activeContest) {
                            await contestRecordingManager.stop(request?.contestId);
                        }
                    });
                emitContestUpdate();
                callback({ success: true, data });
                presentation.catch(error => {
                    console.error(
                        `Could not present submitted contest ${request?.contestId}:`,
                        error
                    );
                });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('colony-control', async (action, callback) => {
            try {
                if (colonyReady) await colonyReady;
                if (!colonyCoordinator) throw new Error('Colony coordinator is not enabled');
                if (action === 'pause') {
                    // A manual pause takes over from the breaker so probes stop auto-resuming.
                    closeModelOutage();
                    await colonyCoordinator.pause('Paused from the Mindcraft UI');
                } else if (action === 'resume') {
                    // Resuming by hand retires the breaker; it re-trips if the provider is still down.
                    closeModelOutage();
                    await colonyCoordinator.resume();
                    await runColonySupervisor();
                } else {
                    throw new Error(`Unknown colony control: ${action}`);
                }
                for (const connection of agent_connections.values()) {
                    if (connection.socket) sendColonyDirective(connection);
                }
                emitColonyUpdate();
                callback({ success: true, data: colonyCoordinator.view() });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('colony-command', async (command, callback) => {
            try {
                const connection = curAgent();
                if (!connection) throw new Error('Only a registered agent can issue colony commands');
                if (colonyReady) await colonyReady;
                callback(await handleColonyCommand(connection.name, command));
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                const name = settings.profile.name;
                if (hasLiveAgentNamed(name)) {
                    callback({
                        success: false,
                        error: `A bot named ${name} is already online. Stop it first.`,
                    });
                    return;
                }
                // An explicit create from the UI must override a sticky
                // desired=false left by a previous stop/destroy of the same
                // name, otherwise createAgent registers the agent but never
                // starts its process and it stays offline forever.
                if (colonyCoordinator?.snapshot().agents[name]?.desired === false) {
                    await colonyCoordinator.updateAgent(name, {
                        desired: true,
                        status: 'spawning',
                    });
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                if (!returned.success && returned.agentId) {
                    mindcraft.destroyAgent(returned.agentId);
                    agent_connections.delete(returned.agentId);
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentRef, callback) => {
            const connection = getConnection(agentRef);
            if (connection) {
                callback({ settings: connection.settings });
            } else {
                callback({ error: `Agent '${agentRef}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentRef) => {
            const connection = getConnection(agentRef);
            if (connection) {
                operator_sockets.delete(socket);
                connection.socket = socket;
                curAgentId = connection.id;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentRef) => {
            const connection = getConnection(agentRef);
            if (connection) {
                operator_sockets.delete(socket);
                const agentName = connection.name;
                connection.socket = socket;
                connection.in_game = true;
                curAgentId = connection.id;
                agentsStatusUpdate();
                // Colored nametag + model suffix, visible from any distance.
                assignModelTeam(agentName, connection.settings?.profile?.model)
                    .catch(error => console.warn(`Nametag assignment failed for ${agentName}:`, error));
                // A game bot only borrows this name. Reconciling it against a
                // retired colony record would stop the bot the contest just spawned.
                if (colonyCoordinator && colonyControlsAgent(connection)) {
                    const colonyAgent = colonyCoordinator.snapshot().agents[agentName];
                    if (colonyAgent?.desired === false) {
                        mindcraft.stopAgent(connection.id);
                        colonyCoordinator.updateAgent(agentName, { status: 'stopped' })
                            .then(() => emitColonyUpdate())
                            .catch(error => console.error(
                                `Failed to preserve stopped state for ${agentName}:`,
                                error
                            ));
                        return;
                    }
                    colonyCoordinator.updateAgent(agentName, { status: 'active' }).then(() => {
                        emitColonyUpdate();
                    }).catch(error => {
                        console.error(`Failed to activate colony agent ${agentName}:`, error);
                    });
                }
            }
            else {
                console.warn(`Unregistered agent ${agentRef} tried to login`);
            }
        });

        socket.on('colony-ready', () => {
            const state = colonyCoordinator?.snapshot();
            const connection = curAgent();
            if (connection && state && !state.paused && state.agents[connection.name]?.desired) {
                sendColonyDirective(connection);
            }
        });

        socket.on('disconnect', () => {
            operator_sockets.delete(socket);
            const connection = curAgent();
            // A restarted process can re-register this agent on a new socket
            // before the old one disconnects; that connection is live and must
            // not be torn down here.
            if (connection && (!connection.socket || connection.socket === socket)) {
                console.log(`Agent ${connection.name} disconnected`);
                connection.in_game = false;
                connection.socket = null;
                connection.recording = null;
                agentsStatusUpdate();
                if (colonyCoordinator) {
                    colonyCoordinator.updateAgent(connection.name, { status: 'offline' })
                        .then(() => emitColonyUpdate())
                        .catch(error => console.error(
                            `Failed to mark colony agent ${connection.name} offline:`,
                            error
                        ));
                }
            }
            if (agent_listeners.some(l => l.socket === socket)) {
                removeListener(socket);
            }
            voiceOutput.removeMonitor(socket);
        });

        socket.on('chat-message', (agentRef, json) => {
            const target = getConnection(agentRef);
            const sender = curAgent();
            if (!target?.socket) {
                console.warn(`Agent ${agentRef} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${sender?.name} sending message to ${target.name}: ${json.message}`);
            target.socket.emit('chat-message', sender?.name, json);
        });

        socket.on('set-agent-settings', (agentRef, settings) => {
            const agent = getConnection(agentRef);
            if (agent?.socket) {
                agent.setSettings(settings);
                agent.socket.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentRef) => {
            const agent = getConnection(agentRef);
            if (!agent?.socket) {
                console.warn(`Cannot restart ${agentRef}: not connected`);
                return;
            }
            console.log(`Restarting agent: ${agent.name}`);
            agent.socket.emit('restart-agent');
        });

        socket.on('stop-agent', async (agentRef) => {
            const agent = getConnection(agentRef);
            if (!agent) return;
            if (colonyCoordinator?.snapshot().agents[agent.name]) {
                await colonyCoordinator.updateAgent(agent.name, {
                    desired: false,
                    status: 'stopped',
                });
                emitColonyUpdate();
            }
            mindcraft.stopAgent(agent.id);
        });

        socket.on('start-agent', async (agentRef) => {
            const agent = getConnection(agentRef);
            if (!agent) return;
            if (colonyCoordinator?.snapshot().agents[agent.name]) {
                await colonyCoordinator.updateAgent(agent.name, {
                    desired: true,
                    status: 'spawning',
                });
                emitColonyUpdate();
            }
            mindcraft.startAgent(agent.id);
        });

        socket.on('destroy-agent', async (agentRef) => {
            const agent = getConnection(agentRef);
            if (!agent) return;
            forgetConnection(agent);
            if (colonyCoordinator?.snapshot().agents[agent.name]) {
                await colonyCoordinator.updateAgent(agent.name, {
                    desired: false,
                    status: 'destroyed',
                });
                emitColonyUpdate();
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', async () => {
            console.log('Killing all agents');
            if (colonyCoordinator) {
                closeModelOutage();
                await colonyCoordinator.pause('All agents stopped from the Mindcraft UI');
                for (const connection of agent_connections.values()) {
                    if (colonyCoordinator.snapshot().agents[connection.name]) {
                        await colonyCoordinator.updateAgent(connection.name, {
                            desired: false,
                            status: 'stopped',
                        });
                    }
                }
            }
            for (const connection of agent_connections.values()) {
                mindcraft.stopAgent(connection.id);
            }
            emitColonyUpdate();
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (const connection of agent_connections.values()) {
                mindcraft.stopAgent(connection.id);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                process.exit(0);
            }, 2000);
            
        });

		socket.on('send-message', (agentRef, data) => {
			const agent = getConnection(agentRef);
			if (!agent?.socket) {
				console.warn(`Agent ${agentRef} not in game, cannot send message via MindServer.`);
				return
			}
			try {
				agent.socket.emit('send-message', data)
			} catch (error) {
				console.error('Error: ', error);
			}
		});

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('start-voice-monitor', () => addVoiceMonitor(socket));
        socket.on('stop-voice-monitor', () => removeVoiceMonitor(socket));

        socket.on('contest-speech', async (options, callback) => {
            try {
                const connection = curAgent();
                if (!connection?.settings?.game_session?.serverBroadcastVoice) {
                    throw new Error('Contest voice broadcast is only available to active game agents');
                }
                if (!hasKey('ELEVENLABS_API_KEY')) {
                    throw new Error('ELEVENLABS_API_KEY is not configured');
                }
                const text = String(options?.text || '').trim().slice(0, 500);
                if (!text) {
                    throw new Error('Contest voice text is required');
                }
                const voiceId = resolveVoice(
                    connection.name,
                    connection.settings.game_session.voice
                );
                const audio = await elevenLabsTTSConfig.sendAudioRequest(
                    text,
                    getVoicesConfig().elevenlabs_model,
                    voiceId,
                    elevenLabsTTSConfig.baseUrl
                );
                broadcastContestRecordingAudio(connection, {
                    sessionId: connection.settings.game_session.sessionId,
                    speaker: connection.name,
                    audio,
                    atMs: Date.now(),
                });
                dispatchBotVoice({ agentName: connection.name, text, audio });
                callback?.({ success: true, audio });
            } catch (error) {
                callback?.({ success: false, error: error.message });
            }
        });

        socket.on('start-recording', (agentName, options, callback) => {
            forwardRecordingCommand(agentName, 'start-recording', options || {}, callback);
        });

        socket.on('stop-recording', (agentName, callback) => {
            forwardRecordingCommand(agentName, 'stop-recording', undefined, callback);
        });

        socket.on('set-auto-recording', (agentName, enabled, callback) => {
            forwardRecordingCommand(agentName, 'set-auto-recording', Boolean(enabled), callback);
        });

        socket.on('recording-update', (agentRef, status) => {
            const conn = getConnection(agentRef);
            if (conn) {
                conn.recording = status;
                agentsStatusUpdate();
            }
        });

        socket.on('list-recordings', (callback) => {
            callback(listRecordings());
        });

        socket.on('get-voices', (callback) => {
            try {
                callback(voicesOverview());
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('set-voices', (config, callback) => {
            try {
                saveVoicesConfig(config || {});
                // Broadcast so other open dashboards refresh their Voices modal data.
                io.emit('voices-update');
                callback(voicesOverview());
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        // Generates a short ElevenLabs sample and returns base64 mp3 for
        // in-browser playback. `voice` previews a specific pool name / raw ID;
        // omitting it previews what `botName` would actually sound like.
        socket.on('preview-voice', async (options, callback) => {
            const { voice = null, botName = null, text = null } = options || {};
            try {
                if (!hasKey('ELEVENLABS_API_KEY')) {
                    throw new Error('ELEVENLABS_API_KEY is not configured');
                }
                const voiceId = resolveVoice(botName || 'preview', voice);
                const sample = String(text || `Hi, I'm ${botName || 'a Mindcraft bot'}. This is how I sound in the colony.`).slice(0, 220);
                const audio = await elevenLabsTTSConfig.sendAudioRequest(
                    sample, getVoicesConfig().elevenlabs_model, voiceId, elevenLabsTTSConfig.baseUrl
                );
                callback({ success: true, audio });
            } catch (error) {
                callback({ success: false, error: error.message });
            }
        });

        socket.on('listen-to-agents', () => {
            addListener(socket, 'full');
        });

        socket.on('listen-to-wall', () => {
            addListener(socket, 'wall');
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = 'localhost';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (const conn of agent_connections.values()) {
        const agentName = conn.name;
        agents.push({
            id: conn.id,
            name: agentName,
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket,
            recording: conn.recording,
            gameSession: conn.settings?.game_session ?? null,
            // Where PovRecorder will write MP4s, so the UI can show the
            // destination before the first recording ever starts.
            recordingsFolder: path.join(projectRoot, 'bots', agentName, 'recordings')
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
let listenerTickRunning = false;

function addListener(listener_socket, mode = 'full') {
    const existing = agent_listeners.find(l => l.socket === listener_socket);
    if (existing) {
        // Upgrade wall → full if the same socket re-subscribes for dashboard.
        if (mode === 'full') existing.mode = 'full';
        return;
    }
    agent_listeners.push({ socket: listener_socket, mode });
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            if (listenerTickRunning) return;
            listenerTickRunning = true;
            try {
                const needsFull = agent_listeners.some(l => l.mode === 'full');
                const fetchState = needsFull ? requestFullState : requestWallState;
                const entries = await Promise.all(
                    listConnections().map(async (agent) => {
                        if (!agent.in_game) return [agent.name, null];
                        try {
                            const state = await fetchState(agent);
                            return [agent.name, state ?? { error: 'Agent state request timed out' }];
                        } catch (e) {
                            return [agent.name, { error: String(e) }];
                        }
                    })
                );
                const states = {};
                for (const [agentName, state] of entries) {
                    if (state) states[agentName] = state;
                }
                for (const listener of agent_listeners) {
                    listener.socket.emit('state-update', states);
                }
            } finally {
                listenerTickRunning = false;
            }
        }, 1000);
    }
}

function removeListener(listener_socket) {
    const idx = agent_listeners.findIndex(l => l.socket === listener_socket);
    if (idx === -1) return;
    agent_listeners.splice(idx, 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
        listenerTickRunning = false;
    }
}

function addVoiceMonitor(socket) {
    voiceOutput.addMonitor(socket);
    if (socket.connected) socket.emit('voice-monitor', { monitoring: true });
}

function removeVoiceMonitor(socket) {
    voiceOutput.removeMonitor(socket);
    if (socket.connected) socket.emit('voice-monitor', { monitoring: false });
}

function broadcastContestRecordingAudio(sourceConnection, payload) {
    const sessionId = sourceConnection?.settings?.game_session?.sessionId;
    if (!sessionId || payload?.sessionId !== sessionId || !payload.audio) return;
    broadcastContestSessionRecordingAudio(sessionId, payload);
}

function broadcastContestSessionRecordingAudio(sessionId, payload) {
    if (!sessionId || payload?.sessionId !== sessionId || !payload.audio) return;
    for (const connection of agent_connections.values()) {
        if (connection.settings?.game_session?.sessionId !== sessionId) continue;
        if (!connection.socket?.connected) continue;
        connection.socket.emit('contest-recording-audio', payload);
    }
}

/**
 * Play a generated line on the host speakers and mirror it to any browser
 * pages that opted in as monitors.
 */
function dispatchBotVoice({ agentName, text, audio }) {
    voiceOutput.dispatch({ agentName, text, audio });
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;