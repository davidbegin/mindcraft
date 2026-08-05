import { buildParticipantGameDirective } from './game_content.js';

const AGENT_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
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
        // Frees the requested names from bots left over by earlier matches, so
        // the same roster can be started again and again.
        this.reclaimNames = options.reclaimNames || (() => Promise.resolve());
        this.readyTimeoutMs = options.readyTimeoutMs ?? 90000;
        this.readyPollMs = options.readyPollMs ?? 500;
        this.onUpdate = options.onUpdate || (() => {});
        this.announceStart = options.announceStart || (() => {});
        this.announceResult = options.announceResult || (() => {});
        this.onAnnouncementError = options.onAnnouncementError
            || (error => console.warn(`Contest announcement failed: ${error.message}`));
        this.onPresentationError = options.onPresentationError
            || (error => console.warn(`Contest podium ceremony failed: ${error.message}`));
        this.queueHighlight = options.queueHighlight || (() => null);
        this.onHighlightError = options.onHighlightError
            || (error => console.warn(`Contest highlight reel failed: ${error.message}`));
        this.getAgentLaunchStatus = options.getAgentLaunchStatus || null;
        this.telemetry = options.telemetry || null;
        this.active = null;
        this.lastFailure = null;
    }

    view() {
        return this.active ? clone(this.active) : null;
    }

    _record(event) {
        this.telemetry?.record?.(event);
    }

    _setProgress(stage, message, extra = {}) {
        if (!this.active) return;
        const total = this.active.participantIds?.length || 0;
        const ready = typeof extra.ready === 'number'
            ? extra.ready
            : (this.active.participantIds || []).filter(name => this.isAgentReady(name)).length;
        this.active.progress = {
            stage,
            message,
            ready,
            total,
            createdCount: this.active.createdAgents?.length || 0,
            ...extra,
        };
    }

    _setStatus(status, stage, message, extra = {}) {
        if (!this.active) return;
        this.active.status = status;
        this._setProgress(stage || status, message, extra);
        this._record({ stage: stage || status, message, detail: extra });
        this._emit();
    }

    async start(request = {}) {
        if (this.active) {
            throw new Error(`Game session ${this.active.contestId} is already active`);
        }
        if (this.coordinator.snapshot().activeContestId) {
            throw new Error('A game is already running. Cancel it first.');
        }

        this.lastFailure = null;
        this.telemetry?.clear?.();
        this._record({ stage: 'validate', message: `Starting game ${request.gameId || 'unknown'}` });

        const preset = this.getPreset(request.gameId);
        await this.reclaimNames(
            (request.participants || [])
                .map(participant => String(participant?.name || '').trim())
                .filter(Boolean)
        );
        const participants = validateGameParticipants(
            request.participants,
            this.getProfiles(),
            this.getExistingAgentNames()
        ).map(participant => ({
            ...participant,
            voice: this.resolveParticipantVoice(participant.name, participant.voice),
        }));
        const systemPrompt = String(request.systemPrompt || '').trim();
        if (systemPrompt.length > 4000) {
            throw new Error('Game system prompt must be 4000 characters or fewer');
        }
        const durationMs = Number.isFinite(request.durationMs) && request.durationMs > 0
            ? request.durationMs
            : preset.durationMs;
        const participantIds = participants.map(participant => participant.name);

        this._record({
            stage: 'create_contest',
            message: `Creating contest for ${preset.title} with ${participantIds.length} bots`,
        });
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
                    participants: participants.map(({ name, profileId, voice, systemPrompt, model, provider }) => ({
                        name,
                        profileId,
                        voice,
                        systemPrompt,
                        model,
                        provider,
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
            participants: participants.map(({ name, profileId, voice, systemPrompt, model, provider }) => ({
                name,
                profileId,
                voice,
                systemPrompt,
                model,
                provider,
            })),
            // Bots are cleaned up by the instance id they were created under, so
            // a later bot reusing a name is never destroyed by an old session.
            createdAgents: [],
            recording: null,
            error: null,
            progress: {
                stage: 'create_agent',
                message: `Creating temporary contest bots (0/${participants.length})…`,
                ready: 0,
                total: participants.length,
                createdCount: 0,
            },
        };
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
                    participantIds,
                    rivalIds: participantIds.filter(name => name !== participant.name),
                    profileId: participant.profileId,
                    voice: participant.voice,
                    model: participant.model,
                    provider: participant.provider,
                    systemPrompt,
                    personalityPrompt: participant.systemPrompt,
                    winItem: preset.rules?.winItem ?? null,
                    contestType: preset.rules?.type ?? null,
                });
                const result = await this.createAgent(settings);
                if (!result?.success) {
                    throw new Error(result?.error || `Could not create ${participant.name}`);
                }
                this.active.createdAgents.push({
                    name: participant.name,
                    id: result.agentId ?? participant.name,
                });
                this._record({
                    stage: 'create_agent',
                    agent: participant.name,
                    message: `Created agent process ${result.agentId ?? participant.name}`,
                });
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
            const arenaReset = await this.prepareArena(preset, participantIds);

            this._setStatus('recording', 'start_recording', 'Starting synchronized recording…');
            const recording = await this.startRecording({
                contestId: contest.id,
                participants: participantIds,
                arena: arenaReset,
            });
            this.active.recording = { enabled: true, ...recording };

            this._setStatus('announcing-start', 'announce', 'Announcing match start…');
            await this._announce(this.announceStart, contest);
            this._record({ stage: 'start_contest', message: `Starting contest ${contest.id}` });
            const started = await this.coordinator.startContest(contest.id);
            await Promise.all(participantIds.map(name =>
                this.sendDirective(
                    name,
                    buildParticipantGameDirective(preset.prompt, participantIds, name)
                )
            ));
            this.active.arenaReset = arenaReset;
            this._setStatus('running', 'running', 'Contest running');
            this._record({ stage: 'running', message: `Game ${preset.id} is running` });
            return {
                contest: started,
                participants: participantIds,
                gameSession: this.view(),
                arenaReset,
                recordingSession: recording,
            };
        } catch (error) {
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
            await this.finish(contest.id);
            throw error;
        }
    }

    async cancel(contestId, reason = 'Cancelled') {
        if (!this.active || this.active.contestId !== contestId) {
            throw new Error(`Game session is not active: ${contestId}`);
        }
        await this._cancelContestIfNeeded(contestId, reason);
        return this.finish(contestId);
    }

    async finish(contestId = null, contest = null) {
        if (!this.active) return null;
        if (contestId && this.active.contestId !== contestId) return null;
        const session = this.view();
        this.active.status = 'cleaning-up';
        this._setProgress('cleanup', 'Cleaning up temporary contest bots…');
        this._record({ stage: 'cleanup', message: `Cleaning up session ${session.contestId}` });
        this._emit();
        await this.stopRecording(session.contestId).catch(() => {});
        if (contest?.status === 'completed') {
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
        await Promise.allSettled(
            session.createdAgents.map(agent => this.destroyAgent(agent.id))
        );
        this.active = null;
        this._emit();
        return session;
    }

    async syncWithContestView(view) {
        if (!this.active) return null;
        const contest = (view?.contests || []).find(item => item.id === this.active.contestId);
        if (contest && ['completed', 'cancelled'].includes(contest.status)) {
            if ([
                'presenting-results',
                'announcing-result',
                'cleaning-up',
            ].includes(this.active.status)) return null;
            if (contest.status === 'completed') {
                this.active.status = 'presenting-results';
                this._setProgress('present_results', 'Moving competitors to the podiums…');
                this._emit();
                await this._presentResults(contest);
                this.active.status = 'announcing-result';
                this._emit();
                await this._announce(this.announceResult, contest);
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
            const ready = names.filter(name => this.isAgentReady(name)).length;
            if (ready !== lastReady && this.active) {
                lastReady = ready;
                this._setProgress(
                    'wait_ready',
                    `Waiting for agents to join the world (${ready}/${names.length})…`,
                    { ready }
                );
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

    async _presentResults(contest) {
        try {
            await this.presentResults(contest);
        } catch (error) {
            this.onPresentationError(error);
        }
    }
}
