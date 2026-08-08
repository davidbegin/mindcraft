import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateGameParticipants } from '../contest/game_session_manager.js';
import { ConversationRequestRegistry } from './conversation_requests.js';
import { buildChallengeDeck, resolveTeamChallenge } from './survivor_challenges.js';
import { COUNCIL_PHASES, MIN_SURVIVOR_PLAYERS } from './survivor_game.js';
import { JURY_LENS, buildPlayerBriefing } from './survivor_memory.js';
import { buildSurvivorRelationships } from './survivor_relationships.js';
import { buildSurvivorStandings } from './survivor_standings.js';

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
}

function phaseInstructions(state, playerId) {
    const player = state.players[playerId];
    const legalTargets = state.eligibleTargetIds.filter(id => id !== playerId);
    switch (state.phase) {
        case 'challenge':
            return [
                state.merged
                    ? 'IMMUNITY CHALLENGE. Winning makes you the one player who cannot be voted out tonight.'
                    : `IMMUNITY CHALLENGE for ${player.tribe}. The losing tribe goes to Tribal Council alone.`,
                'How you behave while losing is remembered as long as how you behave while winning.',
            ];
        case 'strategy':
            if (!state.merged && player.tribe !== state.councilTribe) {
                return [
                    `Your tribe is safe. ${state.councilTribe} goes to Tribal Council.`,
                    'Give one short public confessional about what the result means, then wait.',
                ];
            }
            return [
                `You are going to Tribal Council. Immunity: ${state.immunityIds.join(', ') || 'nobody'}.`,
                `Vulnerable tonight: ${state.eligibleTargetIds.join(', ')}.`,
                'This is your only window to work people before the vote. To pull players aside:',
                '  !requestPrivateChat("Alice,Bob", "why they should hear you out") — asks them to step away with you.',
                '  !acceptPrivateChat("request id") or !declinePrivateChat("request id", "reason") — you may refuse anyone.',
                '  !sendPrivateMessage("...") — talks to everyone currently in your private room.',
                'Refusing to talk is a real move, and so is being refused. Note who will not meet with you.',
                'Lying in private is legal. Being caught lying is what costs you the jury, so weigh it.',
                'Speak publicly in short confessionals too, so the audience follows your reasoning.',
            ];
        case 'tribal_council':
            return [
                'YOU ARE AT TRIBAL COUNCIL. Jeff Prompts is hosting and everything said here is PUBLIC.',
                'DO NOT VOTE YET. Voting does not open until Jeff closes council.',
                'When Jeff asks you something, answer with !answerCouncil("your answer").',
                'Every other player hears your answer and will remember it — the jury included.',
                'Answer so that the person you are about to vote out could still respect you afterwards.',
                'Listen hard to what everyone else says. You are expected to change your mind here if',
                'what comes out on the mat changes the picture. That is what council is for.',
                `Vulnerable tonight: ${legalTargets.join(', ') || 'nobody'}.`,
            ];
        case 'voting':
        case 'revote':
            return [
                'Council is closed. Vote now.',
                'Before you do: reconsider everything that just came out on the mat. If someone',
                'exposed a lie, panicked, or handed you a better target, change your vote accordingly.',
                `Legal targets: ${legalTargets.join(', ')}.`,
                'Cast exactly one secret ballot with !castSurvivorVote("Name"). Do not announce it.',
            ];
        case 'jury_voting':
            return [
                `Vote for the winner: ${legalTargets.join(', ')}.`,
                'Judge the game that was played, not how much you liked being voted out.',
                'Cast your ballot with !castSurvivorVote("Name").',
            ];
        case 'finalist_tiebreak':
            return [
                `The jury deadlocked. You break the tie between ${legalTargets.join(' and ')}.`,
                'Cast your ballot with !castSurvivorVote("Name").',
            ];
        case 'deadlock':
            return [
                `The vote tied between ${state.tiedIds.join(' and ')} and neither can be voted again.`,
                'Talk this out in public, then use !submitDeadlockDecision("Name").',
                'It must be unanimous or everyone without immunity draws rocks.',
            ];
        case 'jury_questioning':
            return player.jury
                ? [
                    `FINAL TRIBAL COUNCIL. The final ${state.finalistIds.length} are ${state.finalistIds.join(', ')}.`,
                    'You are a juror. Jeff will put questions to you and to them; answer with !answerCouncil("...").',
                    'Make them account for the moves they made, especially the one that took you out.',
                ]
                : [
                    `FINAL TRIBAL COUNCIL. You are in the final ${state.finalistIds.length}.`,
                    `Your jury is ${state.juryIds.join(', ')} — every one of them was voted out.`,
                    'Answer Jeff with !answerCouncil("..."). This is the whole game.',
                    'Claim your moves plainly. Jurors forgive a ruthless player who owns it and',
                    'punish one who pretends they were carried along by fate.',
                ];
        case 'fire_making': {
            const decidesSeason = state.finalistIds.length > 0
                && state.tiedIds.every(id => state.finalistIds.includes(id));
            return [
                state.tiedIds.includes(playerId)
                    ? `You are in the fire-making tiebreak. Prepare to compete.${decidesSeason ? ' The winner is the Sole Survivor.' : ''}`
                    : `Watch the fire-making tiebreak between ${state.tiedIds.join(' and ')}.`,
            ];
        }
        case 'completed':
            return [`${state.winnerIds.join(', ')} is the Sole Survivor.`];
        case 'cancelled':
            return ['The season was cancelled.'];
        default:
            return [];
    }
}

function phasePrompt(state, playerId, briefing = '') {
    const player = state.players[playerId];
    const activeIds = state.participantIds.filter(id => state.players[id].active);
    const header = [
        `SURVIVOR — ROUND ${state.round}. PHASE: ${state.phase.replaceAll('_', ' ')}.`,
        state.merged
            ? `You are ${playerId}. The tribes have merged; everyone plays for themselves.`
            : `You are ${playerId}. Tribe: ${player.tribe}.`,
        `Still in the game (${activeIds.length}): ${activeIds.join(', ')}.`,
    ];
    return [
        header.join('\n'),
        JURY_LENS,
        briefing,
        phaseInstructions(state, playerId).join('\n'),
    ].filter(Boolean).join('\n\n');
}

export function councilQuestionPrompt(question, state) {
    const others = question.targetIds.length > 1
        ? ` Jeff asked this of ${question.targetIds.join(', ')}, so the others will answer too.`
        : '';
    return [
        `TRIBAL COUNCIL — JEFF PROMPTS ASKS YOU: "${question.prompt}"`,
        `Answer now, out loud, with !answerCouncil("your answer").${others}`,
        'Everyone still in the game hears this, and so does the jury that decides the winner.',
        state.phase === 'jury_questioning'
            ? 'This is the final council; this answer is the last thing the jury hears from you.'
            : 'Answer in a way the person you vote out tonight could still respect.',
    ].join('\n');
}

export function councilAnswerBroadcast(entry) {
    return [
        `TRIBAL COUNCIL — Jeff asked ${entry.playerId}: "${entry.prompt}"`,
        `${entry.playerId} answered: "${entry.answer}"`,
        'Remember this. It is on the public record and you may use it when you vote.',
    ].join('\n');
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
        // Pushes to a single bot that are not phase directives: a request to
        // talk, a council question, another player's public answer.
        this.notifyAgent = options.notifyAgent || (() => {});
        this.conversations = options.conversations || new ConversationRequestRegistry({
            clock: this.clock,
        });
        this.conversations.clock = this.clock;
        this.onUpdate = options.onUpdate || (() => {});
        this.onEliminated = options.onEliminated || (() => {});
        this.onCompleted = options.onCompleted || (() => {});
        this.readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
        this.phaseDurationsMs = options.phaseDurationsMs || {};
        this.getAgentLaunchStatus = options.getAgentLaunchStatus || null;
        this.telemetry = options.telemetry || null;
        this.active = null;
        this.lastFailure = null;
        // Private rooms close at every phase change, so alliances only stay
        // visible if we keep our own record of who was in them.
        this.roomHistoryLimit = options.roomHistoryLimit ?? 200;
        this.secretEventLimit = options.secretEventLimit ?? 300;
        this.roomHistory = [];
        this.secretEventLog = [];
        // Everything that went wrong, kept in the view so the control room can
        // show it instead of burying it in the server console.
        this.problemLimit = options.problemLimit ?? 60;
        this.problems = [];
        this.sessionPath = path.join(this.coordinator.root, 'session.json');
        this._persistOperation = Promise.resolve();
    }

    // Called for every private-room event so a reloaded dashboard can replay the
    // secret feed and so the relationship graph outlives the rooms themselves.
    recordRoomEvent(event) {
        if (!event?.type) return;
        const state = this.coordinator.view();
        const at = event.at ?? this.clock();
        this.secretEventLog.push({ ...clone(event), at, round: state?.round ?? null });
        if (this.secretEventLog.length > this.secretEventLimit) {
            this.secretEventLog.splice(0, this.secretEventLog.length - this.secretEventLimit);
        }
        if (!event.roomId) return;

        let entry = this.roomHistory.find(item => item.roomId === event.roomId);
        if (!entry) {
            entry = {
                roomId: event.roomId,
                round: state?.round ?? null,
                phase: state?.phase ?? null,
                ownerId: event.ownerId ?? null,
                memberIds: [],
                messageCount: 0,
                messageCountBySender: {},
                openedAt: at,
                closedAt: null,
            };
            this.roomHistory.push(entry);
            if (this.roomHistory.length > this.roomHistoryLimit) {
                this.roomHistory.splice(0, this.roomHistory.length - this.roomHistoryLimit);
            }
        }
        // memberIds is the union across the room's life: someone who talked and
        // then walked out still built a relationship.
        for (const memberId of event.memberIds || []) {
            if (!entry.memberIds.includes(memberId)) entry.memberIds.push(memberId);
        }
        if (event.memberId && !entry.memberIds.includes(event.memberId)) {
            entry.memberIds.push(event.memberId);
        }
        if (event.type === 'room.message' && event.senderId) {
            entry.messageCount += 1;
            entry.messageCountBySender[event.senderId] =
                (entry.messageCountBySender[event.senderId] || 0) + 1;
        }
        if (event.type === 'room.closed') entry.closedAt = at;
        // Rooms and relationships live in view(), and nothing else in this path
        // changes session state, so push the refresh without re-persisting.
        this.onUpdate(this.view());
    }

    // Conversation requests are secret in the same way rooms are: operators see
    // everything, bots only see their own.
    recordConversationEvent(event) {
        if (!event?.type) return;
        const state = this.coordinator.view();
        this.secretEventLog.push({
            ...clone(event),
            at: event.at ?? this.clock(),
            round: state?.round ?? null,
        });
        if (this.secretEventLog.length > this.secretEventLimit) {
            this.secretEventLog.splice(0, this.secretEventLog.length - this.secretEventLimit);
        }
        this.onUpdate(this.view());
    }

    secretEvents() {
        return clone(this.secretEventLog);
    }

    // A named failure the operator can act on, without aborting the season.
    _problem(stage, error, detail = null) {
        const entry = {
            at: this.clock(),
            stage,
            message: error?.message || String(error),
            detail: detail ?? null,
        };
        this.problems.push(entry);
        if (this.problems.length > this.problemLimit) {
            this.problems.splice(0, this.problems.length - this.problemLimit);
        }
        this._log('warn', `${stage}: ${entry.message}`, detail);
        return entry;
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
            council: this.councilView(game),
            upcomingChallenges: this.upcomingChallenges(),
            standings: buildSurvivorStandings(game),
            relationships: buildSurvivorRelationships(game, this.roomHistory),
            conversationRequests: this.conversations.view(),
            problems: clone(this.problems),
            rooms: this.rooms.view().map(room => ({
                id: room.id,
                ownerId: room.ownerId,
                memberIds: room.memberIds,
                invitedIds: room.invitedIds,
                messageCount: room.messages.length,
            })),
        };
    }

    // The council in session, shaped for the host's console: which bots owe an
    // answer to which question is the thing an operator watches.
    councilView(game = this.coordinator.view()) {
        const council = game?.council;
        if (!council) return null;
        return {
            id: council.id,
            kind: council.kind,
            round: council.round,
            open: COUNCIL_PHASES.includes(game.phase),
            attendeeIds: [...council.attendeeIds],
            askableIds: council.attendeeIds.filter(id =>
                game.players[id]?.active || game.players[id]?.jury
            ),
            questions: council.questions.map(question => ({
                ...clone(question),
                pendingIds: question.targetIds.filter(id =>
                    !question.answers.some(answer => answer.playerId === id)
                ),
            })),
        };
    }

    // The deck is a flat list of preset ids; pairing the unplayed tail with the
    // round each one lands on is what makes it reorderable in the UI.
    upcomingChallenges() {
        const deck = this.active?.challengeDeck || [];
        if (deck.length === 0) return [];
        const index = this.active?.challengeIndex ?? 0;
        const round = this.coordinator.view()?.round ?? 1;
        const remaining = deck.length - index;
        // startNextChallenge picks with modulo, so a spent deck replays from the
        // top rather than running out.
        const slots = remaining > 0
            ? Array.from({ length: remaining }, (_, offset) => index + offset)
            : Array.from({ length: deck.length }, (_, offset) => (index + offset) % deck.length);
        return slots.map((deckIndex, offset) => ({
            gameId: deck[deckIndex],
            round: round + offset,
            deckIndex,
        }));
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
        this.conversations.cancelAll('server-restarted');
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
                        floorY: Number.isFinite(preset.rules?.floorY)
                            ? preset.rules.floorY
                            : null,
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
        if (participants.length < MIN_SURVIVOR_PLAYERS) {
            throw new Error(`Choose at least ${MIN_SURVIVOR_PLAYERS} Survivor players`);
        }
        const phaseDurationsMs = {};
        for (const [key, value] of Object.entries(request.phaseDurationsMs || {})) {
            if (!Number.isFinite(value) || value < 5_000 || value > 10 * 60_000) {
                throw new Error(`Invalid Survivor phase duration: ${key}`);
            }
            phaseDurationsMs[key] = value;
        }
        const participantIds = participants.map(participant => participant.name);
        this.roomHistory = [];
        this.secretEventLog = [];
        this.problems = [];
        this.conversations.cancelAll('new-season');
        const season = await this.coordinator.start({
            participantIds,
            mergeAt,
            finalistCount: request.finalistCount,
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
            // Off by default: the host runs council by hand. Turn it on for
            // unattended runs so a season can play itself through.
            councilAutoAdvance: Boolean(request.councilAutoAdvance),
            readiness: null,
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
            floorY: Number.isFinite(preset.rules?.floorY)
                ? preset.rules.floorY
                : null,
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
                floorY: null,
            })));
            await this._afterStateChange(before, this.coordinator.view());
            return this.view();
        } finally {
            this._syncingContestId = null;
        }
    }

    async tick() {
        if (!this.active || this.active.paused) return null;
        await this._sweepConversationRequests();
        // A null deadline means the host holds the phase. Zero is a real deadline.
        if (this.active.phaseDeadlineAt == null) return null;
        if (this.clock() < this.active.phaseDeadlineAt) return null;
        return this.advancePhase();
    }

    // Whatever the current phase's natural next step is. tick() reaches this on
    // the deadline; the host reaches it by pressing a button.
    async advancePhase() {
        const state = this._requireRunning();
        switch (state.phase) {
            case 'strategy':
                return this._applyAndTransition('openCouncil', { openedAt: this.clock() });
            case 'tribal_council':
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

    // Jeff puts a question to one or more players. They answer publicly, and
    // every other bot is told what was said so it lands in their memory.
    async askCouncilQuestion(prompt, targetIds = null, askedBy = 'Jeff Prompts') {
        const state = this._requireRunning();
        if (!COUNCIL_PHASES.includes(state.phase)) {
            throw new Error('Tribal Council is not in session');
        }
        const askable = this.councilView(state)?.askableIds || [];
        const targets = Array.isArray(targetIds) && targetIds.length > 0
            ? targetIds.map(id => String(id ?? '').trim()).filter(Boolean)
            : askable;
        const question = {
            id: `q-${state.council.id}-${state.council.questions.length + 1}`,
            prompt,
            targetIds: targets,
            askedBy,
            askedAt: this.clock(),
        };
        await this.coordinator.apply('askCouncilQuestion', question);
        const results = await Promise.allSettled(targets.map(id =>
            this.notifyAgent(id, 'survivor-council-question', {
                councilId: state.council.id,
                questionId: question.id,
                prompt: question.prompt,
                targetIds: targets,
                phase: state.phase,
            })
        ));
        const undelivered = targets.filter((_, index) => results[index].status === 'rejected');
        if (undelivered.length > 0) {
            this._problem('council-question', new Error(
                `Could not reach ${undelivered.join(', ')} with the question`
            ), { questionId: question.id });
        }
        this._emit();
        return { questionId: question.id, targetIds: targets, undelivered };
    }

    async _recordCouncilAnswer(playerId, answer, questionId = null) {
        const state = this._requireRunning();
        const result = await this.coordinator.apply(
            'answerCouncilQuestion',
            playerId,
            answer,
            questionId
        );
        const after = this.coordinator.view();
        const question = after.council?.questions.find(item => item.id === result.questionId);
        const entry = {
            playerId,
            answer: String(answer).trim(),
            prompt: question?.prompt || '',
            questionId: result.questionId,
        };
        // The public record only exists if the other bots actually hear it.
        const audience = after.participantIds.filter(id =>
            id !== playerId && (after.players[id].active || after.players[id].jury)
        );
        await Promise.allSettled(audience.map(id =>
            this.notifyAgent(id, 'survivor-council-answer', entry)
        ));
        this._emit();
        return { ...result, heardBy: audience.length, phase: state.phase };
    }

    async handleAgentCommand(agentId, type, payload = {}) {
        const state = this._requireRunning();
        if (!state.participantIds.includes(agentId)) throw new Error('Agent is not in this season');
        const player = state.players[agentId];
        switch (type) {
            case 'status':
                return { success: true, data: this._privateStatus(agentId) };
            case 'talk-request': {
                if (state.phase !== 'strategy') {
                    throw new Error('You can only pull players aside during strategy');
                }
                const request = this.conversations.open(
                    agentId,
                    payload.inviteeIds,
                    this._strategyPlayerIds(),
                    { pitch: payload.pitch }
                );
                await Promise.allSettled(request.inviteeIds.map(id =>
                    this.notifyAgent(id, 'survivor-talk-request', {
                        requestId: request.id,
                        requesterId: request.requesterId,
                        inviteeIds: request.inviteeIds,
                        pitch: request.pitch,
                        expiresAt: request.expiresAt,
                    })
                ));
                this._emit();
                return {
                    success: true,
                    data: { requestId: request.id, inviteeIds: request.inviteeIds },
                    message: `Asked ${request.inviteeIds.join(', ')} to talk. Waiting on an answer.`,
                };
            }
            case 'talk-respond': {
                const accepted = Boolean(payload.accepted);
                const outcome = this.conversations.respond(
                    payload.requestId,
                    agentId,
                    accepted,
                    payload.reason
                );
                if (outcome.settled) await this._resolveConversationRequest(payload.requestId);
                this._emit();
                return {
                    success: true,
                    message: accepted
                        ? `You agreed to talk with ${outcome.request.requesterId}.`
                        : `You refused to talk with ${outcome.request.requesterId}.`,
                };
            }
            case 'room-leave':
                this.rooms.leave(agentId);
                return { success: true, message: 'Left the private room' };
            case 'room-send': {
                if (state.phase !== 'strategy') throw new Error('Private rooms open during strategy');
                const entry = this.rooms.send(agentId, payload.message);
                return { success: true, data: { id: entry.id }, message: 'Private message sent' };
            }
            case 'council-answer': {
                const result = await this._recordCouncilAnswer(
                    agentId,
                    payload.answer,
                    payload.questionId
                );
                return {
                    success: true,
                    data: result,
                    message: `Your answer is on the record; ${result.heardBy} other player(s) heard it.`,
                };
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

    // Turns a settled request into a real room. Only the players who said yes go
    // in; a request nobody accepted resolves as a refusal and opens nothing.
    async _resolveConversationRequest(requestId) {
        const pending = this.conversations.get(requestId);
        if (!pending || pending.status !== 'pending') return null;
        const accepterIds = pending.inviteeIds.filter(id => pending.responses[id]?.accepted);
        let roomId = null;
        if (accepterIds.length > 0) {
            const eligible = this._strategyPlayerIds();
            try {
                const room = this.rooms.create(
                    pending.requesterId,
                    accepterIds,
                    eligible,
                    pending.pitch
                );
                roomId = room.id;
                for (const memberId of accepterIds) {
                    try {
                        this.rooms.join(room.id, memberId, eligible);
                    } catch (error) {
                        this._problem('talk-join', error, { requestId, memberId });
                    }
                }
            } catch (error) {
                this._problem('talk-open-room', error, { requestId });
            }
        }
        const { request } = this.conversations.resolve(requestId, roomId);
        const declinerIds = request.inviteeIds.filter(id => !request.responses[id]?.accepted);
        await Promise.allSettled([
            this.notifyAgent(request.requesterId, 'survivor-talk-resolved', {
                requestId,
                status: request.status,
                accepterIds,
                declinerIds,
                roomId,
                reasons: Object.fromEntries(declinerIds.map(id =>
                    [id, request.responses[id]?.reason || 'no answer']
                )),
            }),
            ...accepterIds.map(id => this.notifyAgent(id, 'survivor-talk-resolved', {
                requestId,
                status: request.status,
                accepterIds,
                declinerIds,
                roomId,
                withId: request.requesterId,
            })),
        ]);
        return request;
    }

    async _sweepConversationRequests() {
        for (const request of this.conversations.dueRequests(this.clock())) {
            try {
                await this._resolveConversationRequest(request.id);
            } catch (error) {
                this._problem('talk-expire', error, { requestId: request.id });
            }
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
                await this.advancePhase();
                return this.view();
            case 'open-council':
                return this._applyAndTransition('openCouncil', { openedAt: this.clock() });
            case 'council-question': {
                const result = await this.askCouncilQuestion(
                    payload.prompt,
                    payload.targetIds,
                    payload.askedBy
                );
                return { ...this.view(), lastQuestion: result };
            }
            case 'council-answer':
                // Lets the operator put words on the record for a bot that is
                // wedged, so a stuck cast never blocks the whole council.
                await this._recordCouncilAnswer(
                    payload.playerId,
                    payload.answer,
                    payload.questionId
                );
                return this.view();
            case 'end-council':
                this._requireRunning();
                return this._applyAndTransition('beginVoting');
            case 'set-phase-deadline': {
                this._requireActive();
                const seconds = Number(payload.seconds);
                if (payload.seconds === null) {
                    this.active.phaseDeadlineAt = null;
                } else if (!Number.isFinite(seconds) || seconds < 0) {
                    throw new Error('seconds must be a non-negative number or null');
                } else {
                    this.active.phaseDeadlineAt = this.clock() + seconds * 1000;
                }
                this._emit();
                return this.view();
            }
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
            case 'set-challenge-deck': {
                this._requireActive();
                const gameIds = payload.gameIds;
                if (!Array.isArray(gameIds) || gameIds.length === 0) {
                    throw new Error('gameIds must be a non-empty array of game ids');
                }
                for (const gameId of gameIds) this.getContestPreset(gameId);
                // Only the unplayed tail is replaceable; rewriting history would
                // desync the deck from the challenges already on the record.
                const played = this.active.challengeDeck.slice(0, this.active.challengeIndex);
                this.active.challengeDeck = [...played, ...gameIds];
                this._emit();
                return this.view();
            }
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
        this.conversations.cancelAll('season-cancelled');
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
        if (after.phase !== before.phase) {
            this.rooms.closeAll(`phase-${after.phase}`);
            this.conversations.cancelAll(`phase-${after.phase}`);
        }
        const newlyEliminated = after.bootOrder.filter(id => !before.bootOrder.includes(id));
        for (const playerId of newlyEliminated) {
            this.rooms.removePlayer(playerId);
            this.conversations.removePlayer(playerId);
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
        const duration = this._durationForPhase(after.phase);
        this.active.phaseDeadlineAt = duration == null ? null : this.clock() + duration;
        await this._broadcastPhase();
        this._emit();
    }

    async _broadcastPhase() {
        const state = this.coordinator.view();
        if (!state) return;
        const recipients = state.participantIds.filter(id =>
            state.players[id].active
            || state.players[id].jury
            || state.finalistIds.includes(id)
        );
        const results = await Promise.allSettled(recipients.map(id =>
            this.sendDirective(id, phasePrompt(state, id, this.briefingFor(id, state)), {
                pause: !state.players[id].active && !state.players[id].jury,
            })
        ));
        const undelivered = recipients.filter((_, index) => results[index].status === 'rejected');
        if (undelivered.length > 0) {
            this._problem('phase-directive', new Error(
                `${undelivered.join(', ')} did not receive the ${state.phase} directive`
            ));
        }
    }

    // Each bot's own memory: the public record plus only the private talk it was
    // actually part of.
    briefingFor(playerId, state = this.coordinator.view()) {
        return buildPlayerBriefing(state, playerId, { privateLog: this.secretEventLog });
    }

    _privateStatus(agentId) {
        const state = this.coordinator.view();
        const council = state.council;
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
            // Requests this bot is party to, so it can chase its own unanswered ask.
            conversationRequests: this.conversations.pendingFor(agentId),
            unansweredQuestions: (council?.questions || [])
                .filter(question => question.targetIds.includes(agentId)
                    && !question.answers.some(answer => answer.playerId === agentId))
                .map(question => ({ id: question.id, prompt: question.prompt })),
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

    // null means "no clock": the host decides when this phase ends. Councils
    // default to that, because Jeff asking questions is the show and a timer
    // would cut him off mid-question.
    _durationForPhase(phase) {
        if (COUNCIL_PHASES.includes(phase) && !this.active?.councilAutoAdvance) return null;
        const defaults = {
            strategy: 120_000,
            tribal_council: 300_000,
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
                this._publishReadiness(null);
                return;
            }
            if (ready.length !== lastReady) {
                lastReady = ready.length;
                this._log('info', `waiting for bots (${ready.length}/${participantIds.length} in-game)`);
                // Provisioning can block for the whole ready timeout, so the
                // operator needs to see which bot everyone is waiting on.
                this._publishReadiness({
                    stage,
                    ready: ready.length,
                    total: participantIds.length,
                    pending: participantIds.filter(id => !this.isAgentReady(id)),
                    waitingUntil: deadline,
                });
            }
            await this.sleep(500);
        }
        this._publishReadiness(null);
        const missing = participantIds.filter(id => !this.isAgentReady(id));
        const detail = missing.map(id => this._describeAgentStatus(id)).join(', ');
        throw new Error(
            `Survivor bots did not join within ${Math.round(this.readyTimeoutMs / 1000)}s during ${stage}: ${detail}. `
            + 'Check that the Minecraft server is reachable and that no stale bots hold these names.'
        );
    }

    _publishReadiness(readiness) {
        if (!this.active) return;
        if (!readiness && !this.active.readiness) return;
        this.active.readiness = readiness;
        this._emit();
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
