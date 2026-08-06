import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateGameParticipants } from '../contest/game_session_manager.js';
import { buildChallengeDeck, resolveTeamChallenge } from './survivor_challenges.js';

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
}

function phasePrompt(state, playerId) {
    const player = state.players[playerId];
    const legalTargets = state.eligibleTargetIds.filter(id => id !== playerId);
    const common = [
        `SURVIVOR SEASON — ROUND ${state.round}.`,
        `You are ${playerId}. Tribe: ${player.tribe}.`,
        `Phase: ${state.phase}.`,
        `Active players: ${state.participantIds.filter(id => state.players[id].active).join(', ')}.`,
        `Jury: ${state.juryIds.join(', ') || 'none yet'}.`,
    ];
    switch (state.phase) {
        case 'challenge':
            common.push(
                state.merged
                    ? 'Compete for individual immunity. Winning makes you ineligible to be voted out this round.'
                    : 'Compete for your tribe. The losing tribe alone will attend Tribal Council.'
            );
            break;
        case 'strategy':
            if (!state.merged && player.tribe !== state.councilTribe) {
                common.push(
                    `Your tribe is safe. ${state.councilTribe} will attend Tribal Council.`,
                    'Give one concise public confessional about what the result means, then wait for the next challenge.'
                );
            } else {
                common.push(
                    `Immunity: ${state.immunityIds.join(', ') || 'none'}.`,
                    'Talk publicly in concise confessionals so the audience understands your real reasoning.',
                    'Use !invitePrivateGroup, !joinPrivateGroup, and !sendPrivateMessage for secret alliances of any size.',
                    'Private claims may be truthful or deceptive. Do not reveal private messages publicly unless strategically useful.'
                );
            }
            break;
        case 'voting':
        case 'revote':
        case 'jury_voting':
        case 'finalist_tiebreak':
            common.push(
                `Legal secret ballot targets: ${legalTargets.join(', ')}.`,
                'Cast exactly one ballot with !castSurvivorVote("Name"). Do not announce the target before the reveal.'
            );
            break;
        case 'deadlock':
            common.push(
                `The tied players are ${state.tiedIds.join(', ')}.`,
                'Discuss this openly, then use !submitDeadlockDecision("Name"). The decision must be unanimous or the game goes to rocks.'
            );
            break;
        case 'jury_questioning':
            common.push(
                player.jury
                    ? `Question the final three (${state.finalistIds.join(', ')}) and decide who played the best game.`
                    : 'You are in the final three. Explain your strategic game honestly and persuade the jury.'
            );
            break;
        case 'fire_making':
            common.push(
                state.tiedIds.includes(playerId)
                    ? 'You are in the fire-making tiebreak. Prepare to compete.'
                    : `Watch the fire-making tiebreak between ${state.tiedIds.join(' and ')}.`
            );
            break;
        case 'completed':
            common.push(`The winner is ${state.winnerIds.join(', ')}.`);
            break;
        case 'cancelled':
            common.push('The season was cancelled.');
            break;
        default:
            break;
    }
    return common.join('\n');
}

export class SurvivorSessionManager {
    constructor(options = {}) {
        const required = [
            'coordinator',
            'contestCoordinator',
            'rooms',
            'getProfiles',
            'getExistingAgentNames',
            'resolveParticipantVoice',
            'reclaimNames',
            'buildAgentSettings',
            'createAgent',
            'destroyAgent',
            'isAgentReady',
            'getContestPreset',
            'prepareArena',
            'sendDirective',
            'sendChallengeConfig',
        ];
        for (const name of required) {
            if (!options[name]) throw new TypeError(`${name} is required`);
        }
        Object.assign(this, options);
        this.clock = options.clock || (() => Date.now());
        this.random = options.random || Math.random;
        this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        this.onUpdate = options.onUpdate || (() => {});
        this.onEliminated = options.onEliminated || (() => {});
        this.onCompleted = options.onCompleted || (() => {});
        this.readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
        this.phaseDurationsMs = options.phaseDurationsMs || {};
        this.getAgentLaunchStatus = options.getAgentLaunchStatus || null;
        this.telemetry = options.telemetry || null;
        this.active = null;
        this.lastFailure = null;
        this.sessionPath = path.join(this.coordinator.root, 'session.json');
        this._persistOperation = Promise.resolve();
    }

    _log(level, message, detail = null) {
        const line = `[survivor] ${message}`;
        const args = detail == null ? [line] : [line, JSON.stringify(detail)];
        if (level === 'error') console.error(...args);
        else if (level === 'warn') console.warn(...args);
        else console.log(...args);
        this.telemetry?.record?.({
            level,
            stage: 'survivor',
            message,
            detail: detail ?? undefined,
        });
    }

    _recordFailure(error, stage) {
        this.lastFailure = {
            at: new Date().toISOString(),
            stage,
            error: error?.message || String(error),
            agents: this._describeAllAgents(),
            session: this.active ? clone(this.active) : null,
        };
        this.telemetry?.recordError?.(error, { stage: `survivor_${stage}` });
        return this.lastFailure;
    }

    _describeAgentStatus(name) {
        if (typeof this.getAgentLaunchStatus === 'function') {
            const status = this.getAgentLaunchStatus(name) || {};
            if (!status.registered) return `${name} (never registered — process did not start)`;
            if (!status.socketConnected) return `${name} (registered, process not connected)`;
            if (!status.inGame) return `${name} (connected, never joined Minecraft)`;
            return `${name} (in-game)`;
        }
        return this.isAgentReady(name) ? `${name} (ready)` : `${name} (not ready)`;
    }

    _describeAllAgents() {
        return (this.active?.participantIds || []).map(name => {
            const status = this.getAgentLaunchStatus?.(name) || {};
            return {
                name,
                registered: Boolean(status.registered),
                socketConnected: Boolean(status.socketConnected),
                inGame: Boolean(status.inGame),
                ready: this.isAgentReady(name),
            };
        });
    }

    view() {
        if (!this.active) return null;
        const game = this.coordinator.view();
        if (game) {
            game.ballotCount = Object.keys(game.ballots || {}).length;
            game.ballots = {};
            game.deadlockDecisionCount = Object.keys(game.deadlockDecisions || {}).length;
            game.deadlockDecisions = {};
        }
        return {
            ...clone(this.active),
            game,
            rooms: this.rooms.view().map(room => ({
                id: room.id,
                ownerId: room.ownerId,
                memberIds: room.memberIds,
                invitedIds: room.invitedIds,
                messageCount: room.messages.length,
            })),
        };
    }

    async recover() {
        let saved;
        try {
            saved = JSON.parse(await readFile(this.sessionPath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
        const game = this.coordinator.view();
        if (!saved || game?.status !== 'running' || saved.id !== game.id) {
            this._log('info', `no season to recover (saved status ${saved?.status ?? 'none'}, game status ${game?.status ?? 'none'})`);
            return null;
        }
        this.active = saved;
        this.active.status = 'running';
        this.rooms.closeAll('server-restarted');
        this._log('info', `recovering season ${game.id} in phase '${game.phase}' with ${this.active.participantIds.length} bots`);
        const missing = this.active.participantIds.filter(id =>
            (game.players[id]?.active || game.players[id]?.jury) && !this.isAgentReady(id)
        );
        try {
            if (missing.length > 0) {
                this._log('info', `respawning ${missing.length} bot(s): ${missing.join(', ')}`);
                await this.reclaimNames(missing);
                const profiles = new Map(this.getProfiles().map(profile => [profile.id, profile]));
                const failures = [];
                for (const participant of this.active.participants.filter(
                    item => missing.includes(item.name)
                )) {
                    try {
                        const catalogProfile = profiles.get(participant.profileId);
                        if (!catalogProfile) {
                            throw new Error(`missing profile '${participant.profileId}'`);
                        }
                        const profile = clone(catalogProfile.profile);
                        profile.name = participant.name;
                        profile.speak_model = participant.voice
                            ? { api: 'elevenlabs', voice: participant.voice }
                            : 'elevenlabs';
                        const settings = this.buildAgentSettings(profile, {
                            survivorSeasonId: game.id,
                            sessionId: `survivor-${game.id}`,
                            participantIds: this.active.participantIds,
                            rivalIds: this.active.participantIds.filter(id => id !== participant.name),
                            profileId: participant.profileId,
                            voice: participant.voice,
                            model: participant.model,
                            provider: participant.provider,
                            systemPrompt: this.active.systemPrompt || '',
                            personalityPrompt: participant.systemPrompt,
                            contestType: 'survivor',
                        });
                        const result = await this.createAgent(settings);
                        if (!result?.success) {
                            throw new Error(result?.error || 'createAgent returned no agent');
                        }
                        this.active.createdAgents = this.active.createdAgents.filter(
                            item => item.name !== participant.name
                        );
                        this.active.createdAgents.push({
                            name: participant.name,
                            id: result.agentId ?? participant.name,
                        });
                        this._log('info', `respawned ${participant.name}`);
                    } catch (error) {
                        // One dead bot must not abandon the rest of the cast.
                        failures.push(`${participant.name}: ${error.message}`);
                        this._log('warn', `could not respawn ${participant.name}: ${error.message}`);
                    }
                }
                if (failures.length > 0) {
                    this._log('warn', `${failures.length} bot(s) failed to respawn`, { failures });
                }
                await this._waitUntilReady(missing, 'recovery');
            }
            if (game.challenge) {
                const preset = this.getContestPreset(game.challenge.id);
                const configs = await Promise.allSettled(this.active.participantIds.map(id =>
                    this.sendChallengeConfig(id, {
                        challengeId: preset.id,
                        contestType: preset.rules?.type ?? null,
                        winItem: preset.rules?.winItem ?? null,
                    })
                ));
                const rejected = configs.filter(entry => entry.status === 'rejected').length;
                if (rejected > 0) {
                    this._log('warn', `challenge config failed for ${rejected} bot(s)`);
                }
            }
            await this._broadcastPhase();
            this._emit();
            this._log('info', `season ${game.id} recovered in phase '${game.phase}'`);
            return this.view();
        } catch (error) {
            this._recordFailure(error, 'recovery');
            this._log('error', `recovery failed: ${error.message}`, {
                agents: this._describeAllAgents(),
            });
            this._emit();
            throw error;
        }
    }

    async start(request = {}) {
        if (this.active?.status === 'completed') {
            await this.cancel('Archived before starting a new season');
        } else if (this.active) {
            throw new Error('A Survivor session is already active');
        }
        if (this.contestCoordinator.snapshot().activeContestId) {
            throw new Error('A contest is already active');
        }
        const mergeAt = request.mergeAt ?? 10;
        await this.reclaimNames(
            (request.participants || []).map(participant => participant?.name).filter(Boolean)
        );
        const participants = validateGameParticipants(
            request.participants,
            this.getProfiles(),
            this.getExistingAgentNames()
        ).map(participant => ({
            ...participant,
            voice: this.resolveParticipantVoice(participant.name, participant.voice),
        }));
        if (participants.length <= mergeAt) {
            throw new Error(`Choose at least ${mergeAt + 1} players for a merge at ${mergeAt}`);
        }
        const phaseDurationsMs = {};
        for (const [key, value] of Object.entries(request.phaseDurationsMs || {})) {
            if (!Number.isFinite(value) || value < 5_000 || value > 10 * 60_000) {
                throw new Error(`Invalid Survivor phase duration: ${key}`);
            }
            phaseDurationsMs[key] = value;
        }
        const participantIds = participants.map(participant => participant.name);
        const season = await this.coordinator.start({
            participantIds,
            mergeAt,
            tribeNames: request.tribeNames,
        });
        const challengeGameIds = request.challengeGameIds;
        this.active = {
            id: season.id,
            status: 'provisioning',
            participantIds,
            participants: participants.map(participant => ({
                name: participant.name,
                profileId: participant.profileId,
                voice: participant.voice,
                systemPrompt: participant.systemPrompt,
                model: participant.model,
                provider: participant.provider,
            })),
            systemPrompt: request.systemPrompt || '',
            createdAgents: [],
            challengeDeck: buildChallengeDeck(challengeGameIds, {
                rounds: participantIds.length,
                random: this.random,
            }),
            challengeIndex: 0,
            challengeContestId: null,
            phaseDeadlineAt: null,
            paused: false,
            phaseDurationsMs,
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
                    survivorSeasonId: season.id,
                    sessionId: `survivor-${season.id}`,
                    participantIds,
                    rivalIds: participantIds.filter(id => id !== participant.name),
                    profileId: participant.profileId,
                    voice: participant.voice,
                    model: participant.model,
                    provider: participant.provider,
                    systemPrompt: request.systemPrompt || '',
                    personalityPrompt: participant.systemPrompt,
                    contestType: 'survivor',
                });
                const result = await this.createAgent(settings);
                if (!result?.success) {
                    throw new Error(result?.error || `Could not create ${participant.name}`);
                }
                this.active.createdAgents.push({
                    name: participant.name,
                    id: result.agentId ?? participant.name,
                });
                this._emit();
            }
            await this._waitUntilReady(participantIds, 'startup');
            this.active.status = 'running';
            await this._broadcastPhase();
            await this.startNextChallenge();
            this._log('info', `season ${season.id} is running with ${participantIds.length} bots`);
            return this.view();
        } catch (error) {
            this._recordFailure(error, 'startup');
            this._log('error', `season startup failed: ${error.message}`, {
                agents: this._describeAllAgents(),
            });
            await this.cancel(`Startup failed: ${error.message}`).catch(() => {});
            throw error;
        }
    }

    async startNextChallenge(gameId = null) {
        const state = this._requireRunning();
        if (state.phase !== 'challenge') throw new Error('The season is not ready for a challenge');
        if (this.contestCoordinator.snapshot().activeContestId) {
            throw new Error('A challenge contest is already active');
        }
        const selectedId = gameId
            || this.active.challengeDeck[this.active.challengeIndex % this.active.challengeDeck.length];
        this.active.challengeIndex += 1;
        const preset = this.getContestPreset(selectedId);
        const participantIds = state.participantIds.filter(id => state.players[id].active);
        const contest = await this.contestCoordinator.createContest({
            title: `${preset.title} — Survivor Round ${state.round}`,
            prompt: preset.prompt,
            durationMs: preset.durationMs,
            participantIds,
            rules: { ...preset.rules },
            metadata: {
                ...preset.metadata,
                gameId: preset.id,
                survivorSeasonId: state.id,
                survivorRound: state.round,
                survivorMode: state.merged ? 'individual' : 'tribe',
                tribes: clone(state.tribes),
            },
        });
        await this.prepareArena(preset, participantIds);
        await this.coordinator.apply('startChallenge', {
            id: preset.id,
            startedAt: this.clock(),
        });
        const started = await this.contestCoordinator.startContest(contest.id);
        this.active.challengeContestId = contest.id;
        this.active.phaseDeadlineAt = started.deadlineAt;
        await Promise.allSettled(participantIds.map(id => this.sendChallengeConfig(id, {
            challengeId: preset.id,
            contestType: preset.rules?.type ?? null,
            winItem: preset.rules?.winItem ?? null,
        })));
        await this._broadcastPhase();
        this._emit();
        return contest;
    }

    async syncContestView(view) {
        if (!this.active?.challengeContestId) return null;
        const contestId = this.active.challengeContestId;
        if (this._syncingContestId === contestId) return null;
        const contest = view?.contests?.find(item => item.id === contestId);
        if (!contest || contest.status !== 'completed') return null;
        this._syncingContestId = contestId;
        try {
            const state = this.coordinator.view();
            const preset = this.getContestPreset(contest.metadata.gameId);
            let challengeResult;
            if (state.merged) {
                challengeResult = { winnerId: contest.winnerIds[0] };
            } else if (contest.rules.type === 'depth_race' || contest.rules.type === 'tower_battle') {
                const tribeByParticipant = Object.fromEntries(
                    state.participantIds.map(id => [id, state.players[id].tribe])
                );
                const results = contest.results.map(result => ({
                    participantId: result.participantId,
                    score: result.score,
                    y: result.details?.y,
                    depthY: result.details?.y,
                    height: result.details?.height ?? result.score,
                }));
                challengeResult = resolveTeamChallenge(preset, results, tribeByParticipant);
                if (challengeResult.tied) {
                    const index = Math.min(
                        challengeResult.standings.length - 1,
                        Math.floor(this.random() * challengeResult.standings.length)
                    );
                    challengeResult.winningTribe = challengeResult.standings[index].tribe;
                    challengeResult.tiebreak = 'seeded-draw';
                }
            } else {
                const winnerId = contest.winnerIds[0];
                if (!state.players[winnerId]) throw new Error('Challenge completed without a winner');
                challengeResult = {
                    winningTribe: state.players[winnerId].tribe,
                    winnerId,
                };
            }
            const before = state;
            await this.coordinator.apply('completeChallenge', challengeResult);
            this.active.challengeContestId = null;
            await Promise.allSettled(state.participantIds.map(id => this.sendChallengeConfig(id, {
                challengeId: null,
                contestType: 'survivor',
                winItem: null,
            })));
            await this._afterStateChange(before, this.coordinator.view());
            return this.view();
        } finally {
            this._syncingContestId = null;
        }
    }

    async tick() {
        if (!this.active || this.active.paused || !this.active.phaseDeadlineAt) return null;
        if (this.clock() < this.active.phaseDeadlineAt) return null;
        const state = this.coordinator.view();
        switch (state.phase) {
            case 'strategy':
                return this._applyAndTransition('beginVoting');
            case 'voting':
            case 'revote':
            case 'jury_voting':
            case 'finalist_tiebreak':
                await this.coordinator.apply('fillMissingBallots');
                return this._applyAndTransition('revealVotes');
            case 'deadlock':
                await this.coordinator.apply('fillMissingDeadlockDecisions');
                return this._applyAndTransition('resolveDeadlock');
            case 'jury_questioning':
                return this._applyAndTransition('beginJuryVote');
            case 'fire_making':
                return this._applyAndTransition('resolveFireMaking');
            default:
                return null;
        }
    }

    async handleAgentCommand(agentId, type, payload = {}) {
        const state = this._requireRunning();
        if (!state.participantIds.includes(agentId)) throw new Error('Agent is not in this season');
        const player = state.players[agentId];
        switch (type) {
            case 'status':
                return { success: true, data: this._privateStatus(agentId) };
            case 'room-create': {
                if (state.phase !== 'strategy') throw new Error('Private rooms open during strategy');
                const room = this.rooms.create(
                    agentId,
                    payload.inviteeIds,
                    this._strategyPlayerIds(),
                    payload.pitch
                );
                return { success: true, data: room, message: `Created private room ${room.id}` };
            }
            case 'room-join': {
                if (state.phase !== 'strategy') throw new Error('Private rooms open during strategy');
                const room = this.rooms.join(payload.roomId, agentId, this._strategyPlayerIds());
                return { success: true, data: room, message: `Joined private room ${room.id}` };
            }
            case 'room-leave':
                this.rooms.leave(agentId);
                return { success: true, message: 'Left the private room' };
            case 'room-send': {
                if (state.phase !== 'strategy') throw new Error('Private rooms open during strategy');
                const entry = this.rooms.send(agentId, payload.message);
                return { success: true, data: { id: entry.id }, message: 'Private message sent' };
            }
            case 'cast-vote': {
                const data = await this.coordinator.apply('castVote', agentId, payload.targetId);
                this._emit();
                return { success: true, data, message: 'Secret ballot accepted' };
            }
            case 'deadlock-decision': {
                await this.coordinator.apply('submitDeadlockDecision', agentId, payload.targetId);
                this._emit();
                return { success: true, message: 'Deadlock decision accepted' };
            }
            default:
                throw new Error(`Unknown Survivor command: ${type}`);
        }
    }

    async control(action, payload = {}) {
        switch (action) {
            case 'pause':
                this._requireActive();
                if (this.active.challengeContestId) {
                    throw new Error('Active immunity challenges cannot be paused');
                }
                this.active.paused = true;
                this._emit();
                return this.view();
            case 'resume':
                this._requireActive();
                this.active.paused = false;
                this._emit();
                return this.view();
            case 'advance':
                this._requireActive();
                this.active.phaseDeadlineAt = this.clock();
                await this.tick();
                return this.view();
            case 'challenge':
                return this.startNextChallenge(payload.gameId);
            case 'set-next-challenge':
                this._requireActive();
                this.getContestPreset(payload.gameId);
                this.active.challengeDeck[
                    this.active.challengeIndex % this.active.challengeDeck.length
                ] = payload.gameId;
                this._emit();
                return this.view();
            case 'challenge-result': {
                const before = this.coordinator.view();
                const result = before.merged
                    ? { winnerId: payload.winnerId }
                    : { winningTribe: payload.winningTribe };
                await this.coordinator.apply('completeChallenge', result);
                this.active.challengeContestId = null;
                await this._afterStateChange(before, this.coordinator.view());
                return this.view();
            }
            case 'fire-result':
                return this._applyAndTransition('resolveFireMaking', payload.winnerId);
            case 'cancel':
                return this.cancel(payload.reason);
            default:
                throw new Error(`Unknown Survivor control: ${action}`);
        }
    }

    async cancel(reason = 'Cancelled by operator') {
        if (!this.active) return null;
        const session = clone(this.active);
        const state = this.coordinator.view();
        if (state?.status === 'running') await this.coordinator.apply('cancel', reason);
        const activeContestId = this.contestCoordinator.snapshot().activeContestId;
        if (activeContestId) {
            await this.contestCoordinator.cancelContest(activeContestId, reason).catch(() => {});
        }
        this.rooms.closeAll('season-cancelled');
        await Promise.allSettled(
            session.createdAgents.map(agent => this.destroyAgent(agent.id))
        );
        this.active = null;
        this._emit();
        return session;
    }

    async _applyAndTransition(method, ...args) {
        const before = this.coordinator.view();
        await this.coordinator.apply(method, ...args);
        const after = this.coordinator.view();
        await this._afterStateChange(before, after);
        return this.view();
    }

    async _afterStateChange(before, after) {
        this.rooms.closeAll(`phase-${after.phase}`);
        const newlyEliminated = after.bootOrder.filter(id => !before.bootOrder.includes(id));
        for (const playerId of newlyEliminated) {
            this.rooms.removePlayer(playerId);
            await this.onEliminated(playerId, after);
        }
        if (after.status === 'completed') {
            this.active.status = 'completed';
            this.active.phaseDeadlineAt = null;
            await this._broadcastPhase();
            await this.onCompleted(after);
            this._emit();
            return;
        }
        if (after.phase === 'challenge') {
            this.active.phaseDeadlineAt = null;
            await this.startNextChallenge();
            return;
        }
        this.active.phaseDeadlineAt = this.clock() + this._durationForPhase(after.phase);
        await this._broadcastPhase();
        this._emit();
    }

    async _broadcastPhase() {
        const state = this.coordinator.view();
        if (!state) return;
        const recipients = state.participantIds.filter(id =>
            state.players[id].active || state.players[id].jury
        );
        await Promise.allSettled(recipients.map(id =>
            this.sendDirective(id, phasePrompt(state, id), {
                pause: !state.players[id].active && !state.players[id].jury,
            })
        ));
    }

    _privateStatus(agentId) {
        const state = this.coordinator.view();
        return {
            seasonId: state.id,
            phase: state.phase,
            round: state.round,
            merged: state.merged,
            player: state.players[agentId],
            immunityIds: state.immunityIds,
            tiedIds: state.tiedIds,
            eligibleToVote: state.eligibleVoterIds.includes(agentId),
            legalTargetIds: state.eligibleTargetIds.filter(id => id !== agentId),
            ballotReceived: Boolean(state.ballots[agentId]),
            room: this.rooms.roomFor(agentId),
        };
    }

    _strategyPlayerIds() {
        const state = this.coordinator.view();
        if (state.phase !== 'strategy') return [];
        return state.merged
            ? state.participantIds.filter(id => state.players[id].active)
            : state.participantIds.filter(
                id => state.players[id].active && state.players[id].tribe === state.councilTribe
            );
    }

    _duration(key, fallback) {
        return this.active?.phaseDurationsMs?.[key]
            ?? this.phaseDurationsMs[key]
            ?? fallback;
    }

    _durationForPhase(phase) {
        const defaults = {
            strategy: 120_000,
            voting: 60_000,
            revote: 45_000,
            deadlock: 60_000,
            fire_making: 60_000,
            jury_questioning: 180_000,
            jury_voting: 60_000,
            finalist_tiebreak: 45_000,
        };
        return this._duration(phase, defaults[phase] ?? 60_000);
    }

    async _waitUntilReady(participantIds, stage = 'startup') {
        const deadline = this.clock() + this.readyTimeoutMs;
        let lastReady = -1;
        while (this.clock() < deadline) {
            const ready = participantIds.filter(id => this.isAgentReady(id));
            if (ready.length === participantIds.length) {
                this._log('info', `all ${ready.length} bot(s) are in-game`);
                return;
            }
            if (ready.length !== lastReady) {
                lastReady = ready.length;
                this._log('info', `waiting for bots (${ready.length}/${participantIds.length} in-game)`);
            }
            await this.sleep(500);
        }
        const missing = participantIds.filter(id => !this.isAgentReady(id));
        const detail = missing.map(id => this._describeAgentStatus(id)).join(', ');
        throw new Error(
            `Survivor bots did not join within ${Math.round(this.readyTimeoutMs / 1000)}s during ${stage}: ${detail}. `
            + 'Check that the Minecraft server is reachable and that no stale bots hold these names.'
        );
    }

    _requireActive() {
        if (!this.active) throw new Error('No Survivor session is active');
        return this.coordinator.view();
    }

    _requireRunning() {
        const state = this._requireActive();
        if (state?.status !== 'running') throw new Error('Survivor season is not running');
        return state;
    }

    _emit() {
        const snapshot = clone(this.active);
        this._persistOperation = this._persistOperation
            .then(() => this._persistSession(snapshot))
            .catch(error => console.warn('Could not persist Survivor session:', error.message));
        this.onUpdate(this.view());
    }

    async _persistSession(session) {
        const temporaryPath = `${this.sessionPath}.${process.pid}.tmp`;
        try {
            await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`);
            await rename(temporaryPath, this.sessionPath);
        } catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => {});
            throw error;
        }
    }
}
