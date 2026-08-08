import {
    buildBaseSiegeBuildDirective,
    buildParticipantGameDirective,
    buildTeamPlanningDirective,
    pickTeamAttacker,
    pickTeamCaptain,
} from './game_content.js';
import {
    buildPressureRoundCommands,
    buildSimultaneousTeleportCommands,
    getArenaJoinInfo,
    partitionTeleportCommands,
} from './arena_manager.js';
import {
    canDeferSiegeDeadline,
    nextSiegeHalfSize,
    remainingTeamSiegeSurvivors,
} from './team_base_siege.js';
import { isTeamContestType, isTeamTowerContest } from './team_games.js';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const TEAM_NAME_PATTERN = /^[A-Za-z0-9_ ]{1,16}$/;
const MAX_PLANNING_MS = 10 * 60 * 1000;
const MAX_BUILD_PHASE_MS = 5 * 60 * 1000;
const DEFAULT_PODIUM_HOLD_MS = 5 * 60 * 1000;
const DEFAULT_WINNER_REVEAL_MS = 6_000;
const PODIUM_WAIT_DIRECTIVE = [
    'The game is over and the medal ceremony has begun.',
    'Stay on your podium, do not move or start another task,',
    'and wait for the humans to start the next game.',
].join(' ');

// Launching a game is slow — bot processes, a world rebuild, camera startup and
// a spoken countdown — and for a long time the only thing the dashboard could
// say was a single frozen line. These steps are published up front so the UI can
// show the whole road, which step is underway, and how long each one took.
const LAUNCH_STEP_LABELS = {
    reclaim_names: 'Free the bot names',
    create_agent: 'Start the bot processes',
    wait_ready: 'Wait for bots to join the world',
    prepare_arena: 'Build the arena',
    start_recording: 'Start the cameras',
    team_planning: 'Team planning',
    team_build: 'Build phase',
    announce: 'Announce the match',
    send_goals: 'Send the goals to the bots',
};

export function buildLaunchSteps({
    recording = false,
    teamPlanning = false,
    teamBuild = false,
} = {}) {
    const ids = [
        'reclaim_names',
        'create_agent',
        'wait_ready',
        'prepare_arena',
        ...(recording ? ['start_recording'] : []),
        ...(teamPlanning ? ['team_planning'] : []),
        ...(teamBuild ? ['team_build'] : []),
        'announce',
        'send_goals',
    ];
    return ids.map(id => ({
        id,
        label: LAUNCH_STEP_LABELS[id],
        status: 'pending',
        startedAt: null,
        endedAt: null,
        detail: null,
    }));
}

export function buildWinnerReactionDirective(contest, participantId) {
    const winners = Array.isArray(contest?.winnerIds) ? contest.winnerIds.filter(Boolean) : [];
    const teamResult = (contest?.results || []).find(result => result.participantId === participantId);
    const winningTeam = (contest?.results || []).find(result => result.rank === 1)
        ?.details?.teamName;
    if (isTeamContestType(contest?.rules?.type) && winningTeam) {
        const participantTeam = teamResult?.details?.teamName;
        return [
            'The game is over.',
            participantTeam === winningTeam
                ? `Your team won. ${winningTeam} is the winning team.`
                : `${winningTeam} is the winning team.`,
            `React now in one excited, natural sentence and clearly say ${winningTeam} by name.`,
            'Do not use a command or begin another task. After speaking, remain still for the medal ceremony.',
        ].join(' ');
    }
    const winnerNames = winners.join(' and ') || 'nobody';
    const winnerLabel = winners.length === 1 ? 'winner is' : 'winners are';
    const outcome = winners.includes(participantId)
        ? `You won. The ${winnerLabel} ${winnerNames}.`
        : `The ${winnerLabel} ${winnerNames}.`;
    return [
        'The game is over.',
        outcome,
        `React now in one excited, natural sentence and clearly say ${winnerNames} by name.`,
        'Do not use a command or begin another task. After speaking, remain still for the medal ceremony.',
    ].join(' ');
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Pressing Start while a launch is still on its way is a refused request, not a
// failure of the launch already running. Callers key off this flag to leave the
// healthy launch's diagnostics alone instead of filing a failure report that
// describes whatever step it happened to be on.
export function launchRefusedError(message) {
    const error = new Error(message);
    error.launchRefused = true;
    return error;
}

export function validateGameParticipants(participants, profiles, existingNames = []) {
    if (!Array.isArray(participants) || participants.length === 0) {
        throw new Error('Choose at least one game participant');
    }
    const profileMap = new Map(profiles.map(profile => [profile.id, profile]));
    const unavailableNames = new Set(existingNames);
    const selectedNames = new Set();

    return participants.map((participant, index) => {
        const name = String(participant?.name || '').trim();
        const profileId = String(participant?.profileId || '').trim();
        const voice = String(participant?.voice || '').trim();
        const systemPrompt = String(participant?.systemPrompt || '').trim();
        if (!AGENT_NAME_PATTERN.test(name)) {
            throw new Error(`Participant ${index + 1} name must be 3-16 letters, numbers, or underscores`);
        }
        if (selectedNames.has(name)) {
            throw new Error(`Participant names must be unique: ${name}`);
        }
        // Reusing the name of a past bot is fine; only a bot that is online
        // right now blocks it, because Minecraft refuses two players of the
        // same name.
        if (unavailableNames.has(name)) {
            throw new Error(`A bot named ${name} is already online. Stop it first.`);
        }
        const catalogProfile = profileMap.get(profileId);
        if (!catalogProfile) {
            throw new Error(`Unknown model profile: ${profileId}`);
        }
        if (catalogProfile.configured === false) {
            throw new Error(`Model profile is not configured: ${profileId}`);
        }
        if (voice.length > 128) {
            throw new Error(`Participant ${index + 1} voice must be 128 characters or fewer`);
        }
        if (systemPrompt.length > 4000) {
            throw new Error(`Participant ${index + 1} system prompt must be 4000 characters or fewer`);
        }
        selectedNames.add(name);
        return {
            name,
            profileId,
            voice: voice || null,
            systemPrompt,
            model: catalogProfile.model,
            provider: catalogProfile.provider,
            profile: clone(catalogProfile.profile),
        };
    });
}

export function validateTeamSetup(participants, teamNames, minimumPlayersPerTeam = 2) {
    if (!Array.isArray(teamNames) || teamNames.length !== 2) {
        throw new Error('Team games require exactly two teams');
    }
    const names = teamNames.map(name => String(name || '').trim());
    if (names.some(name => !TEAM_NAME_PATTERN.test(name))) {
        throw new Error('Team names must be 1-16 letters, numbers, spaces, or underscores');
    }
    if (names[0].toLowerCase() === names[1].toLowerCase()) {
        throw new Error('Team names must be different');
    }
    const teams = Object.fromEntries(names.map(name => [name, []]));
    const teamByParticipant = {};
    for (const participant of participants) {
        const team = String(participant?.team || '').trim();
        if (!names.includes(team)) {
            throw new Error(`Every participant must be assigned to ${names.join(' or ')}`);
        }
        teams[team].push(participant.name);
        teamByParticipant[participant.name] = team;
    }
    for (const name of names) {
        if (teams[name].length < minimumPlayersPerTeam) {
            throw new Error(`Team ${name} needs at least ${minimumPlayersPerTeam} players`);
        }
    }
    return { teamNames: names, teamByParticipant, teams };
}

export function resolvePlanningMs(requested, preset) {
    const fallback = Number.isFinite(preset?.rules?.planningMs) ? preset.rules.planningMs : 0;
    const value = Number.isFinite(requested) ? requested : fallback;
    if (value < 0) {
        throw new Error('Planning time cannot be negative');
    }
    if (value > MAX_PLANNING_MS) {
        throw new Error(`Planning time must be ${MAX_PLANNING_MS / 60_000} minutes or less`);
    }
    return Math.round(value);
}

export function resolveBuildPhaseMs(requested, preset) {
    const fallback = Number.isFinite(preset?.rules?.buildPhaseMs) ? preset.rules.buildPhaseMs : 0;
    const value = Number.isFinite(requested) ? requested : fallback;
    if (value < 0) {
        throw new Error('Build phase time cannot be negative');
    }
    if (value > MAX_BUILD_PHASE_MS) {
        throw new Error(`Build phase must be ${MAX_BUILD_PHASE_MS / 60_000} minutes or less`);
    }
    return Math.round(value);
}

export class GameSessionManager {
    constructor(options = {}) {
        const requiredFunctions = [
            'getPreset',
            'getProfiles',
            'getExistingAgentNames',
            'resolveParticipantVoice',
            'buildAgentSettings',
            'createAgent',
            'destroyAgent',
            'isAgentReady',
            'prepareArena',
            'presentResults',
            'startRecording',
            'stopRecording',
            'sendDirective',
        ];
        for (const name of requiredFunctions) {
            if (typeof options[name] !== 'function') {
                throw new TypeError(`${name} must be a function`);
            }
        }
        if (!options.coordinator) {
            throw new TypeError('coordinator is required');
        }

        Object.assign(this, options);
        this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.clock = options.clock || (() => Date.now());
        this.podiumHoldMs = options.podiumHoldMs ?? DEFAULT_PODIUM_HOLD_MS;
        this.winnerRevealMs = options.winnerRevealMs ?? DEFAULT_WINNER_REVEAL_MS;
        // Frees the requested names from bots left over by earlier matches, so
        // the same roster can be started again and again.
        this.reclaimNames = options.reclaimNames || (() => Promise.resolve());
        this.readyTimeoutMs = options.readyTimeoutMs ?? 90000;
        this.readyPollMs = options.readyPollMs ?? 500;
        this.onUpdate = options.onUpdate || (() => {});
        this.announceStart = options.announceStart || (() => {});
        this.announcePlanning = options.announcePlanning || (() => {});
        this.announceBuildPhase = options.announceBuildPhase || (() => {});
        this.announcePressureRound = options.announcePressureRound || (() => {});
        this.announceResult = options.announceResult || (() => {});
        this.announceVisualResult = options.announceVisualResult || (() => {});
        this.presentWinner = options.presentWinner || (() => {});
        this.clearQueuedVoice = options.clearQueuedVoice || (() => {});
        this.runArenaCommands = options.runArenaCommands || null;
        this.onAnnouncementError = options.onAnnouncementError
            || (error => console.warn(`Contest announcement failed: ${error.message}`));
        this.onPresentationError = options.onPresentationError
            || (error => console.warn(`Contest podium ceremony failed: ${error.message}`));
        this.queueHighlight = options.queueHighlight || (() => null);
        this.onHighlightError = options.onHighlightError
            || (error => console.warn(`Contest highlight reel failed: ${error.message}`));
        this.onRecordingIncomplete = options.onRecordingIncomplete
            || (failures => console.warn(
                `Contest is running without every camera angle: ${failures
                    .map(failure => `${failure.agentName}: ${failure.error}`)
                    .join('; ')}`
            ));
        this.getAgentLaunchStatus = options.getAgentLaunchStatus || null;
        this.telemetry = options.telemetry || null;
        this.active = null;
        this.launch = null;
        this.lastFailure = null;
    }

    view() {
        return this.active ? clone(this.active) : null;
    }

    _record(event) {
        this.telemetry?.record?.(event);
    }

    // Every launch milestone goes to the terminal as well as the telemetry
    // timeline, so a launch can be followed without a browser open.
    _log(message, { level = 'info', stage = null, agent = null, detail = null } = {}) {
        const line = `[contest] ${message}`;
        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);
        this._record({ level, stage: stage || 'launch', agent, message, detail });
    }

    // Walks the published step list to wherever the launch has reached: earlier
    // steps become done, this one becomes active. Stages that are not launch
    // steps (cleanup, the medal ceremony) leave the list alone.
    _advanceLaunch(stage) {
        const steps = this.launch?.steps;
        if (!steps) return;
        const index = steps.findIndex(step => step.id === stage);
        const finishThrough = stage === 'running' ? steps.length : index;
        if (index < 0 && stage !== 'running') return;
        for (const step of steps.slice(0, finishThrough)) {
            if (step.status === 'done') continue;
            step.status = 'done';
            step.startedAt = step.startedAt ?? this.clock();
            step.endedAt = this.clock();
        }
        const current = index >= 0 ? steps[index] : null;
        // A failed step stays failed: the error path re-reports its own stage on
        // the way out, and that must not look like the step started over.
        if (current && current.status !== 'active' && current.status !== 'failed') {
            current.status = 'active';
            current.startedAt = this.clock();
            current.endedAt = null;
        }
        this.launch.stage = stage;
        if (stage === 'running') this.launch.endedAt = this.clock();
    }

    _failLaunch() {
        for (const step of this.launch?.steps || []) {
            if (step.status === 'active') {
                step.status = 'failed';
                step.endedAt = this.clock();
            }
        }
    }

    _setProgress(stage, message, extra = {}) {
        if (!this.active) return;
        const total = this.active.participantIds?.length || 0;
        const ready = typeof extra.ready === 'number'
            ? extra.ready
            : (this.active.participantIds || []).filter(name => this.isAgentReady(name)).length;
        this._advanceLaunch(stage);
        this.active.progress = {
            stage,
            message,
            ready,
            total,
            createdCount: this.active.createdAgents?.length || 0,
            startedAt: this.launch?.steps?.find(step => step.id === stage)?.startedAt ?? null,
            launchStartedAt: this.launch?.startedAt ?? null,
            ...extra,
        };
    }

    _setStatus(status, stage, message, extra = {}) {
        if (!this.active) return;
        this.active.status = status;
        this._setProgress(stage || status, message, extra);
        this._log(message, { stage: stage || status, detail: extra });
        this._emit();
    }

    /**
     * Reports what a long step is doing right now without changing the step
     * itself, so "Build the arena" can say which of its hundreds of commands it
     * is on. Repeated identical details are dropped: the callers report often.
     */
    _setStageDetail(stage, detail, extra = {}) {
        if (!this.active || this.active.progress?.stage !== stage) return;
        if (this.active.progress.detail === detail) return;
        this.active.progress = { ...this.active.progress, detail, ...extra };
        const step = this.launch?.steps?.find(item => item.id === stage);
        if (step) step.detail = detail;
        this._log(detail, { stage });
        this._emit();
    }

    // The podium hold is a courtesy ceremony, not a lock, and nothing ends it on
    // a timer: the medalists stand on their podiums until an operator starts
    // something else. Anything that needs the arena — the next contest game, a
    // Survivor season — releases the hold instead of treating a finished game as
    // still running.
    async releasePodiumHold() {
        if (this.active?.status !== 'awaiting-next-game') return null;
        return await this.finish(this.active.contestId);
    }

    async start(request = {}) {
        if (this.active) {
            if (this.active.status !== 'awaiting-next-game') {
                const step = this.launch?.steps
                    ?.find(item => item.id === this.active.progress?.stage);
                const where = step ? ` (still on "${step.label}")` : '';
                throw launchRefusedError(
                    `${this.active.title} is already active${where}. Let it finish, `
                    + 'or cancel it before starting another game.'
                );
            }
            await this.releasePodiumHold();
        }
        if (this.coordinator.snapshot().activeContestId) {
            throw launchRefusedError('A game is already running. Cancel it first.');
        }

        this.lastFailure = null;
        this.launch = null;
        this.telemetry?.clear?.();
        const launchStartedAt = this.clock();
        this._log(`Starting game ${request.gameId || 'unknown'}`, { stage: 'validate' });

        const preset = this.getPreset(request.gameId);
        const requestedNames = (request.participants || [])
            .map(participant => String(participant?.name || '').trim())
            .filter(Boolean);
        this._log(
            `Freeing the requested bot names: ${requestedNames.join(', ') || 'none'}`,
            { stage: 'reclaim_names' }
        );
        await this.reclaimNames(requestedNames);
        let participants = validateGameParticipants(
            request.participants,
            this.getProfiles(),
            this.getExistingAgentNames()
        ).map((participant, index) => ({
            ...participant,
            team: String(request.participants?.[index]?.team || '').trim() || null,
            voice: this.resolveParticipantVoice(participant.name, participant.voice),
        }));
        const teamSetup = isTeamContestType(preset.rules?.type)
            ? validateTeamSetup(
                participants,
                request.teamNames,
                preset.rules.minimumPlayersPerTeam
            )
            : null;
        const systemPrompt = String(request.systemPrompt || '').trim();
        if (systemPrompt.length > 4000) {
            throw new Error('Game system prompt must be 4000 characters or fewer');
        }
        const durationMs = Number.isFinite(request.durationMs) && request.durationMs > 0
            ? request.durationMs
            : preset.durationMs;
        const planningMs = teamSetup ? resolvePlanningMs(request.planningMs, preset) : 0;
        const buildPhaseMs = teamSetup && preset.rules?.type === 'team_base_siege'
            ? resolveBuildPhaseMs(request.buildPhaseMs, preset)
            : 0;
        const recordingEnabled = request.recordingEnabled === true;
        const autoRecordingEnabled = !recordingEnabled && request.autoRecordingEnabled === true;
        const captainByTeam = teamSetup
            ? Object.fromEntries(
                teamSetup.teamNames.map(name => [name, pickTeamCaptain(teamSetup.teams[name])])
            )
            : null;
        const attackerByTeam = teamSetup && isTeamTowerContest(preset.rules?.type)
            ? Object.fromEntries(
                teamSetup.teamNames.map(name => [
                    name,
                    pickTeamAttacker(teamSetup.teams[name], captainByTeam[name]),
                ])
            )
            : null;
        const participantIds = participants.map(participant => participant.name);

        this.launch = {
            startedAt: launchStartedAt,
            gameId: preset.id,
            title: preset.title,
            stage: 'create_agent',
            endedAt: null,
            steps: buildLaunchSteps({
                recording: recordingEnabled,
                teamPlanning: Boolean(teamSetup) && planningMs > 0,
                teamBuild: Boolean(teamSetup) && buildPhaseMs > 0,
            }),
        };
        const reclaimStep = this.launch.steps[0];
        reclaimStep.status = 'done';
        reclaimStep.startedAt = launchStartedAt;
        reclaimStep.endedAt = this.clock();

        this._log(
            `Creating contest for ${preset.title} with ${participantIds.length} bots`,
            { stage: 'create_contest' }
        );
        const contest = await this.coordinator.createContest({
            title: preset.title,
            prompt: preset.prompt,
            durationMs,
            participantIds,
            rules: { ...preset.rules },
            metadata: {
                ...preset.metadata,
                gameId: preset.id,
                startedFrom: 'game-session-ui',
                gameSession: {
                    temporary: true,
                    systemPrompt,
                    planningMs,
                    buildPhaseMs,
                    pressureRound: 0,
                    recordingEnabled,
                    autoRecordingEnabled,
                    arenaHalfSize: getArenaJoinInfo().arena.halfSize ?? 32,
                    teamNames: teamSetup?.teamNames ?? null,
                    teamByParticipant: teamSetup?.teamByParticipant ?? null,
                    teams: teamSetup?.teams ?? null,
                    captainByTeam,
                    attackerByTeam,
                    participants: participants.map(({ name, profileId, voice, systemPrompt, model, provider, team }) => ({
                        name,
                        profileId,
                        voice,
                        systemPrompt,
                        model,
                        provider,
                        team,
                    })),
                },
            },
        });

        this.active = {
            contestId: contest.id,
            sessionId: `contest-${contest.id}`,
            gameId: preset.id,
            title: preset.title,
            status: 'provisioning',
            participantIds,
            planningMs,
            buildPhaseMs,
            recordingEnabled,
            autoRecordingEnabled,
            arenaHalfSize: getArenaJoinInfo().arena.halfSize ?? 32,
            teamNames: teamSetup?.teamNames ?? null,
            teamByParticipant: teamSetup?.teamByParticipant ?? null,
            teams: teamSetup?.teams ?? null,
            captainByTeam,
            attackerByTeam,
            participants: participants.map(({ name, profileId, voice, systemPrompt, model, provider, team }) => ({
                name,
                profileId,
                voice,
                systemPrompt,
                model,
                provider,
                team,
            })),
            // Bots are cleaned up by the instance id they were created under, so
            // a later bot reusing a name is never destroyed by an old session.
            createdAgents: [],
            recording: null,
            error: null,
            launch: this.launch,
            progress: {
                stage: 'create_agent',
                message: `Creating temporary contest bots (0/${participants.length})…`,
                ready: 0,
                total: participants.length,
                createdCount: 0,
                launchStartedAt,
            },
        };
        this._advanceLaunch('create_agent');
        this._emit();

        try {
            for (let index = 0; index < participants.length; index++) {
                const participant = participants[index];
                this._setStatus(
                    'provisioning',
                    'create_agent',
                    `Creating bot ${index + 1}/${participants.length}: ${participant.name}…`,
                    { agent: participant.name, createdCount: this.active.createdAgents.length }
                );
                const profile = clone(participant.profile);
                profile.name = participant.name;
                profile.speak_model = participant.voice
                    ? { api: 'elevenlabs', voice: participant.voice }
                    : 'elevenlabs';
                if (preset.rules?.type === 'death_race') {
                    profile.modes = {
                        ...(profile.modes || {}),
                        self_preservation: false,
                        cowardice: false,
                        self_defense: false,
                    };
                }
                const settings = this.buildAgentSettings(profile, {
                    contestId: contest.id,
                    sessionId: this.active.sessionId,
                    gameId: preset.id,
                    participantIds,
                    rivalIds: participantIds.filter(name =>
                        name !== participant.name
                        && (!teamSetup
                            || teamSetup.teamByParticipant[name] !== participant.team)
                    ),
                    teamId: participant.team,
                    teammateIds: teamSetup
                        ? teamSetup.teams[participant.team].filter(name => name !== participant.name)
                        : [],
                    enemyIds: teamSetup
                        ? participantIds.filter(name =>
                            teamSetup.teamByParticipant[name] !== participant.team
                        )
                        : [],
                    profileId: participant.profileId,
                    voice: participant.voice,
                    model: participant.model,
                    provider: participant.provider,
                    systemPrompt,
                    personalityPrompt: participant.systemPrompt,
                    recordBotView: false,
                    autoRecordingEnabled,
                    winItem: preset.rules?.winItem ?? null,
                    contestType: preset.rules?.type ?? null,
                    floorY: Number.isFinite(preset.rules?.floorY)
                        ? preset.rules.floorY
                        : null,
                });
                const result = await this.createAgent(settings);
                if (!result?.success) {
                    throw new Error(result?.error || `Could not create ${participant.name}`);
                }
                this.active.createdAgents.push({
                    name: participant.name,
                    id: result.agentId ?? participant.name,
                });
                this._log(
                    `Created agent process ${result.agentId ?? participant.name}`,
                    { stage: 'create_agent', agent: participant.name }
                );
                this._emit();
            }

            this._setStatus(
                'provisioning',
                'wait_ready',
                `Waiting for agents to join the world (0/${participantIds.length})…`,
                { ready: 0 }
            );
            await this._waitUntilReady(participantIds, contest.id);
            if (!this.active || this.active.contestId !== contest.id) {
                throw new Error('Game session was cancelled during startup');
            }
            this._setStatus('preparing', 'prepare_arena', 'Preparing arena…');
            const arenaReset = await this.prepareArena(preset, participantIds, {
                onProgress: detail => this._setStageDetail('prepare_arena', detail),
                teamNames: teamSetup?.teamNames,
                teamByParticipant: teamSetup?.teamByParticipant,
                teams: teamSetup?.teams,
                // The profile's model object is what nametags outside contests
                // are labelled with, so team nametags read the same way.
                modelByParticipant: Object.fromEntries(
                    participants.map(participant => [
                        participant.name,
                        participant.profile?.model ?? participant.model,
                    ])
                ),
            });

            // File a permanent record that everyone started with the identical
            // kit. This feeds the archive's integrity view and is the proof that
            // no one carried inventory into a fresh game.
            for (const audit of arenaReset?.inventoryAudits || []) {
                await this.coordinator.recordGameEvent?.('inventory.audit', {
                    contestId: contest.id,
                    ...audit,
                }).catch?.(error =>
                    this._log(`Could not journal inventory audit: ${error.message}`, { level: 'warn' })
                );
            }

            let recording = null;
            if (recordingEnabled) {
                this._setStatus('recording', 'start_recording', 'Starting synchronized recording…');
                this.active.recording = { enabled: true };
                recording = await this.startRecording({
                    contestId: contest.id,
                    participants: participantIds,
                    arena: arenaReset,
                    onProgress: detail => this._setStageDetail('start_recording', detail),
                });
                this.active.recording = { enabled: true, ...recording };
                if (recording?.failures?.length) {
                    const detail = recording.failures
                        .map(failure => `${failure.agentName}: ${failure.error}`)
                        .join('; ');
                    this._record({
                        stage: 'start_recording',
                        message: `Recording ${recording.cameraCount} of the planned angles (${detail})`,
                    });
                    this.onRecordingIncomplete(recording.failures);
                }
            }

            if (teamSetup && planningMs > 0) {
                await this._runPlanningPhase({
                    contest,
                    preset,
                    teamSetup,
                    captainByTeam,
                    attackerByTeam,
                    participantIds,
                    planningMs,
                });
            }

            if (teamSetup && buildPhaseMs > 0) {
                await this._runBuildPhase({
                    contest,
                    preset,
                    teamSetup,
                    captainByTeam,
                    participantIds,
                    buildPhaseMs,
                });
            }

            this._setStatus('announcing-start', 'announce', 'Announcing match start…');
            await this._announce(
                current => this.announceStart(current, {
                    onProgress: detail => this._setStageDetail('announce', detail),
                }),
                contest
            );
            this._log(`Starting contest ${contest.id}`, { stage: 'start_contest' });
            const started = await this.coordinator.startContest(contest.id);
            // The clock is running now, so this last fan-out is the most
            // confusing place to go quiet: bots stand still until their goal
            // lands, and each one can take seconds.
            this._setStatus(
                'announcing-start',
                'send_goals',
                `Sending the goals to the bots (0/${participantIds.length})…`
            );
            let goalsSent = 0;
            await Promise.all(participantIds.map(name =>
                this.sendDirective(
                    name,
                    buildParticipantGameDirective(preset.prompt, participantIds, name, {
                        contestType: preset.rules?.type ?? null,
                        teamId: teamSetup?.teamByParticipant[name] ?? null,
                        teammateIds: teamSetup
                            ? teamSetup.teams[teamSetup.teamByParticipant[name]]
                                .filter(id => id !== name)
                            : [],
                        enemyIds: teamSetup
                            ? participantIds.filter(id =>
                                teamSetup.teamByParticipant[id] !== teamSetup.teamByParticipant[name]
                            )
                            : [],
                        captainId: captainByTeam?.[teamSetup?.teamByParticipant[name]] ?? null,
                        attackerId: attackerByTeam?.[teamSetup?.teamByParticipant[name]] ?? null,
                    }),
                    // Planning chatter must not swallow the goal that starts the
                    // clock; a queued directive would idle the bot for the whole
                    // conversation timeout.
                    {
                        endConversations: true,
                        gameStarted: true,
                        automaticAction: preset.rules?.type === 'spleef'
                            ? 'play-spleef'
                            : null,
                        floorY: preset.rules?.floorY,
                    }
                ).then(result => {
                    goalsSent += 1;
                    this._setStageDetail(
                        'send_goals',
                        `${name} has its goal (${goalsSent}/${participantIds.length})`
                    );
                    return result;
                })
            ));
            this.active.arenaReset = arenaReset;
            this._setStatus('running', 'running', 'Contest running');
            this._log(`Game ${preset.id} is running`, { stage: 'running' });
            return {
                contest: started,
                participants: participantIds,
                gameSession: this.view(),
                arenaReset,
                recordingSession: recording,
            };
        } catch (error) {
            this._failLaunch();
            if (this.active) {
                this.active.status = 'failed';
                this.active.error = error.message;
                this._setProgress(
                    this.active.progress?.stage || 'failed',
                    error.message
                );
                this.telemetry?.recordError?.(error, {
                    stage: this.active.progress?.stage || 'failed',
                });
                this.lastFailure = {
                    at: new Date().toISOString(),
                    error: error.message,
                    session: this.view(),
                };
                this._emit();
            } else {
                this.telemetry?.recordError?.(error, { stage: 'failed' });
                this.lastFailure = {
                    at: new Date().toISOString(),
                    error: error.message,
                    session: null,
                };
            }
            await this._cancelContestIfNeeded(contest.id, `Game session startup failed: ${error.message}`);
            await this.finish(contest.id, null, { discardMedia: true });
            throw error;
        }
    }

    // Teams score a single tower, so the match is decided by whether everyone
    // agreed on one base before the clock started. This phase runs while the
    // contest is still a draft: bots talk, nothing counts, nothing is timed.
    async _runPlanningPhase({
        contest,
        preset,
        teamSetup,
        captainByTeam,
        attackerByTeam,
        participantIds,
        planningMs,
    }) {
        const seconds = Math.round(planningMs / 1000);
        const planningEndsAt = this.clock() + planningMs;
        const planningLabel = preset.rules?.type === 'team_base_siege'
            ? `Team planning: ${seconds}s to agree on a base and hunt plan…`
            : `Team planning: ${seconds}s to agree on one tower…`;
        this._setStatus(
            'planning',
            'team_planning',
            planningLabel,
            { planningMs, planningEndsAt }
        );
        await this._announce(
            current => this.announcePlanning(current, { planningMs }),
            contest
        );
        await Promise.all(participantIds.map(name => {
            const teamId = teamSetup.teamByParticipant[name];
            return this.sendDirective(
                name,
                buildTeamPlanningDirective({
                    title: preset.title,
                    presetPrompt: preset.prompt,
                    planningMs,
                    participantName: name,
                    teamId,
                    teammateIds: teamSetup.teams[teamId].filter(id => id !== name),
                    enemyIds: participantIds.filter(id =>
                        teamSetup.teamByParticipant[id] !== teamId
                    ),
                    captainId: captainByTeam?.[teamId] ?? null,
                    attackerId: attackerByTeam?.[teamId] ?? null,
                    contestType: preset.rules?.type ?? 'team_tower_battle',
                })
            );
        }));
        await this.sleep(planningMs);
        if (!this.active || this.active.contestId !== contest.id) {
            throw new Error('Game session was cancelled during startup');
        }
    }

    // Build phase still runs before startContest(), so fights cannot begin early.
    async _runBuildPhase({
        contest,
        preset,
        teamSetup,
        captainByTeam,
        participantIds,
        buildPhaseMs,
    }) {
        const seconds = Math.round(buildPhaseMs / 1000);
        const buildEndsAt = this.clock() + buildPhaseMs;
        this._setStatus(
            'building',
            'team_build',
            `Build phase: ${seconds}s to raise a quick base…`,
            { buildPhaseMs, buildEndsAt }
        );
        await this._announce(
            current => this.announceBuildPhase(current, { buildPhaseMs }),
            contest
        );
        await Promise.all(participantIds.map(name => {
            const teamId = teamSetup.teamByParticipant[name];
            return this.sendDirective(
                name,
                buildBaseSiegeBuildDirective({
                    title: preset.title,
                    buildPhaseMs,
                    participantName: name,
                    teamId,
                    teammateIds: teamSetup.teams[teamId].filter(id => id !== name),
                    enemyIds: participantIds.filter(id =>
                        teamSetup.teamByParticipant[id] !== teamId
                    ),
                    captainId: captainByTeam?.[teamId] ?? null,
                }),
                { endConversations: true }
            );
        }));
        await this.sleep(buildPhaseMs);
        if (!this.active || this.active.contestId !== contest.id) {
            throw new Error('Game session was cancelled during startup');
        }
    }

    async cancel(contestId, reason = 'Cancelled') {
        if (!this.active || this.active.contestId !== contestId) {
            throw new Error(`Game session is not active: ${contestId}`);
        }
        await this._cancelContestIfNeeded(contestId, reason);
        return this.finish(contestId);
    }

    async finish(contestId = null, contest = null, { discardMedia = false } = {}) {
        if (!this.active) return null;
        if (contestId && this.active.contestId !== contestId) return null;
        const session = this.view();
        this.active.status = 'cleaning-up';
        this._setProgress('cleanup', 'Cleaning up temporary contest bots…');
        this._log(`Cleaning up session ${session.contestId}`, { stage: 'cleanup' });
        this._emit();
        await this._finalizeMedia(contest, { discardMedia });
        await Promise.allSettled(
            session.createdAgents.map(agent => this.destroyAgent(agent.id))
        );
        this.active = null;
        this.launch = null;
        this._emit();
        return session;
    }

    /**
     * Called inside ContestCoordinator.tick while the contest is still running.
     * Mutates contest metadata/deadline in place when both teams are still alive.
     */
    async applyPressureRound(contest) {
        if (contest?.rules?.type !== 'team_base_siege') return null;
        if (!canDeferSiegeDeadline(contest)) return null;
        if (typeof this.runArenaCommands !== 'function') return null;

        const gameSession = contest.metadata.gameSession || (contest.metadata.gameSession = {});
        const currentHalf = Number.isFinite(gameSession.arenaHalfSize)
            ? gameSession.arenaHalfSize
            : (getArenaJoinInfo().arena.halfSize ?? 32);
        const nextHalf = nextSiegeHalfSize(
            currentHalf,
            contest.rules?.shrinkStep,
            contest.rules?.minHalfSize
        );
        const pressureRound = (Number(gameSession.pressureRound) || 0) + 1;
        const survivors = remainingTeamSiegeSurvivors(contest);
        const commands = buildPressureRoundCommands({
            survivors,
            teamNames: gameSession.teamNames || [],
            teamByParticipant: gameSession.teamByParticipant || {},
            halfSize: nextHalf,
        });
        // Shrink the walls and re-kit each survivor in order, then fire all of
        // their teleports on a single tick so the tribe is repositioned together.
        const { setup, teleports } = partitionTeleportCommands(commands);
        for (const command of setup) {
            await this.runArenaCommands(command);
        }
        for (const command of buildSimultaneousTeleportCommands(teleports)) {
            await this.runArenaCommands(command);
        }

        gameSession.pressureRound = pressureRound;
        gameSession.arenaHalfSize = nextHalf;
        if (this.active) this.active.arenaHalfSize = nextHalf;
        contest.deadlineAt = this.clock() + contest.durationMs;

        await this._announce(
            () => this.announcePressureRound({
                halfSize: nextHalf,
                pressureRound,
            }),
            contest
        );
        await Promise.all(survivors.map(name =>
            this.sendDirective(
                name,
                [
                    `PRESSURE ROUND ${pressureRound}. The arena just shrank.`,
                    'Both teams were still alive, so hiding failed. Hunt and eliminate the other team now.',
                    'Death still eliminates you permanently. Friendly fire is still off.',
                ].join(' '),
                { endConversations: true }
            )
        ));
        if (this.active?.contestId === contest.id) {
            this._setStatus(
                'running',
                'pressure_round',
                `Pressure round ${pressureRound}: arena half-size ${nextHalf}`,
                { pressureRound, arenaHalfSize: nextHalf }
            );
        }
        return { reason: 'pressure-round', halfSize: nextHalf, pressureRound };
    }

    async syncWithContestView(view) {
        if (!this.active) return null;
        const contest = (view?.contests || []).find(item => item.id === this.active.contestId);
        if (contest && ['completed', 'cancelled'].includes(contest.status)) {
            if ([
                'revealing-winner',
                'presenting-results',
                'announcing-result',
                'awaiting-next-game',
                'cleaning-up',
            ].includes(this.active.status)) return null;
            if (contest.status === 'completed') {
                this.active.status = 'revealing-winner';
                this._setProgress('reveal_winner', 'Gathering everyone at the winning location…');
                this._emit();
                await this._clearQueuedVoice(contest);
                await Promise.allSettled(this.active.participantIds.map(name =>
                    this.sendDirective(name, PODIUM_WAIT_DIRECTIVE, { pause: true })
                ));
                await this._presentWinner(contest);
                this.active.status = 'announcing-result';
                this._emit();
                await this._announce(this.announceVisualResult, contest);
                await this._clearQueuedVoice(contest);
                await this._announce(this.announceResult, contest);
                await Promise.allSettled(this.active.participantIds.map(name =>
                    this.sendDirective(
                        name,
                        buildWinnerReactionDirective(contest, name),
                        { pause: true, react: true }
                    )
                ));
                await this.sleep(this.winnerRevealMs);
                this.active.status = 'presenting-results';
                this._setProgress('present_results', 'Moving competitors to the podiums…');
                this._emit();
                await this._presentResults(contest);
                await this._finalizeMedia(contest);
                const podiumHoldUntil = this.clock() + this.podiumHoldMs;
                this.active.status = 'awaiting-next-game';
                this.active.podiumHoldUntil = podiumHoldUntil;
                this._setProgress(
                    'await_next_game',
                    'Medal ceremony in progress. Waiting for the next game.',
                    { podiumHoldUntil }
                );
                this._emit();
                return this.view();
            }
            return this.finish(contest.id, contest);
        }
        return null;
    }

    _describeAgentStatus(name) {
        if (typeof this.getAgentLaunchStatus === 'function') {
            const status = this.getAgentLaunchStatus(name) || {};
            if (!status.registered) return `${name} (not registered)`;
            if (!status.socketConnected) return `${name} (process not connected)`;
            if (!status.inGame) return `${name} (connected, not in-game yet)`;
            return `${name} (in-game)`;
        }
        return this.isAgentReady(name) ? `${name} (ready)` : `${name} (not ready)`;
    }

    async _waitUntilReady(names, contestId) {
        const deadline = Date.now() + this.readyTimeoutMs;
        let lastReady = -1;
        while (Date.now() < deadline) {
            if (!this.active || this.active.contestId !== contestId) {
                throw new Error('Game session was cancelled during startup');
            }
            const pending = names.filter(name => !this.isAgentReady(name));
            const ready = names.length - pending.length;
            if (ready !== lastReady && this.active) {
                lastReady = ready;
                this._setProgress(
                    'wait_ready',
                    `Waiting for agents to join the world (${ready}/${names.length})…`,
                    { ready, pending, waitingUntil: deadline }
                );
                // Naming the bots still missing turns a 90 second stare into
                // something an operator can act on.
                if (pending.length) {
                    this._log(
                        `Waiting on ${pending.map(name => this._describeAgentStatus(name)).join(', ')}`,
                        { stage: 'wait_ready' }
                    );
                }
                this._emit();
            }
            if (ready === names.length) return;
            await this.sleep(this.readyPollMs);
        }
        const missing = names.filter(name => !this.isAgentReady(name));
        const detail = missing.map(name => this._describeAgentStatus(name)).join(', ');
        throw new Error(`Timed out waiting for game agents: ${detail}`);
    }

    async _cancelContestIfNeeded(contestId, reason) {
        const contest = this.coordinator.snapshot().contests[contestId];
        if (contest && !['completed', 'cancelled'].includes(contest.status)) {
            await this.coordinator.cancelContest(contestId, reason);
        }
    }

    _emit() {
        this.onUpdate(this.view());
    }

    async _announce(announce, contest) {
        try {
            await announce(contest);
        } catch (error) {
            this.onAnnouncementError(error);
        }
    }

    async _clearQueuedVoice(contest) {
        try {
            await this.clearQueuedVoice(contest);
        } catch (error) {
            this.onAnnouncementError(error);
        }
    }

    async _presentResults(contest) {
        try {
            await this.presentResults(contest);
        } catch (error) {
            this.onPresentationError(error);
        }
    }

    async _presentWinner(contest) {
        try {
            await this.presentWinner(contest);
        } catch (error) {
            this.onPresentationError(error);
        }
    }

    async _finalizeMedia(contest, { discardMedia = false } = {}) {
        if (!this.active || this.active.mediaFinalized) return;
        if (!this.active.recordingEnabled) {
            this.active.mediaFinalized = true;
            return;
        }
        const session = this.view();
        // A launch that never reached the starting gun has no footage worth
        // waiting for, and every stop is another per-bot round trip. Leaving the
        // operator staring at idle bots is the worse outcome, so let the stops
        // land on their own and get the arena cleared.
        if (discardMedia) {
            this.stopRecording(session.contestId).catch(() => {});
        } else {
            await this.stopRecording(session.contestId).catch(() => {});
        }
        this.active.mediaFinalized = true;
        if (this.active.recording) {
            this.active.recording.enabled = false;
        }
        if (discardMedia || contest?.status !== 'completed') return;
        try {
            const queued = this.queueHighlight({ session, contest });
            queued?.catch?.(this.onHighlightError);
            this._record({
                stage: 'highlight_queued',
                message: `Queued highlight reel for ${session.contestId}`,
            });
        } catch (error) {
            this.onHighlightError(error);
        }
    }
}
