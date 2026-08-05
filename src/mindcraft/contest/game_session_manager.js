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
        if (!AGENT_NAME_PATTERN.test(name)) {
            throw new Error(`Participant ${index + 1} name must be 3-16 letters, numbers, or underscores`);
        }
        if (unavailableNames.has(name) || selectedNames.has(name)) {
            throw new Error(`Agent name is already in use: ${name}`);
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
        selectedNames.add(name);
        return {
            name,
            profileId,
            voice: voice || null,
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
            'buildAgentSettings',
            'createAgent',
            'destroyAgent',
            'isAgentReady',
            'prepareArena',
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
        this.readyTimeoutMs = options.readyTimeoutMs ?? 90000;
        this.readyPollMs = options.readyPollMs ?? 500;
        this.onUpdate = options.onUpdate || (() => {});
        this.active = null;
    }

    view() {
        return this.active ? clone(this.active) : null;
    }

    async start(request = {}) {
        if (this.active) {
            throw new Error(`Game session ${this.active.contestId} is already active`);
        }
        if (this.coordinator.snapshot().activeContestId) {
            throw new Error('A game is already running. Cancel it first.');
        }

        const preset = this.getPreset(request.gameId);
        const participants = validateGameParticipants(
            request.participants,
            this.getProfiles(),
            this.getExistingAgentNames()
        );
        const systemPrompt = String(request.systemPrompt || '').trim();
        if (systemPrompt.length > 4000) {
            throw new Error('Game system prompt must be 4000 characters or fewer');
        }
        const durationMs = Number.isFinite(request.durationMs) && request.durationMs > 0
            ? request.durationMs
            : preset.durationMs;
        const participantIds = participants.map(participant => participant.name);
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
                    participants: participants.map(({ name, profileId, voice, model, provider }) => ({
                        name,
                        profileId,
                        voice,
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
            participants: participants.map(({ name, profileId, voice, model, provider }) => ({
                name,
                profileId,
                voice,
                model,
                provider,
            })),
            createdAgentNames: [],
            recording: null,
            error: null,
        };
        this._emit();

        try {
            for (const participant of participants) {
                const profile = clone(participant.profile);
                profile.name = participant.name;
                profile.speak_model = participant.voice
                    ? { api: 'elevenlabs', voice: participant.voice }
                    : 'elevenlabs';
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
                    winItem: preset.rules?.winItem ?? null,
                });
                const result = await this.createAgent(settings);
                if (!result?.success) {
                    throw new Error(result?.error || `Could not create ${participant.name}`);
                }
                this.active.createdAgentNames.push(participant.name);
                this._emit();
            }

            await this._waitUntilReady(participantIds, contest.id);
            if (!this.active || this.active.contestId !== contest.id) {
                throw new Error('Game session was cancelled during startup');
            }
            this.active.status = 'preparing';
            this._emit();
            const arenaReset = await this.prepareArena(preset, participantIds);

            this.active.status = 'recording';
            this._emit();
            const recording = await this.startRecording({
                contestId: contest.id,
                participants: participantIds,
                arena: arenaReset,
            });
            this.active.recording = { enabled: true, ...recording };

            const started = await this.coordinator.startContest(contest.id);
            await Promise.all(participantIds.map(name =>
                this.sendDirective(
                    name,
                    buildParticipantGameDirective(preset.prompt, participantIds, name)
                )
            ));
            this.active.status = 'running';
            this.active.arenaReset = arenaReset;
            this._emit();
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
                this._emit();
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

    async finish(contestId = null) {
        if (!this.active) return null;
        if (contestId && this.active.contestId !== contestId) return null;
        const session = this.view();
        this.active.status = 'cleaning-up';
        this._emit();
        await this.stopRecording(session.contestId).catch(() => {});
        await Promise.allSettled(
            session.createdAgentNames.map(name => this.destroyAgent(name))
        );
        this.active = null;
        this._emit();
        return session;
    }

    async syncWithContestView(view) {
        if (!this.active) return null;
        const contest = (view?.contests || []).find(item => item.id === this.active.contestId);
        if (contest && ['completed', 'cancelled'].includes(contest.status)) {
            return this.finish(contest.id);
        }
        return null;
    }

    async _waitUntilReady(names, contestId) {
        const deadline = Date.now() + this.readyTimeoutMs;
        while (Date.now() < deadline) {
            if (!this.active || this.active.contestId !== contestId) {
                throw new Error('Game session was cancelled during startup');
            }
            if (names.every(name => this.isAgentReady(name))) return;
            await this.sleep(this.readyPollMs);
        }
        const missing = names.filter(name => !this.isAgentReady(name));
        throw new Error(`Timed out waiting for game agents: ${missing.join(', ')}`);
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
}
