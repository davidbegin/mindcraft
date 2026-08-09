import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
    buildCouncilQuestionAnnouncement,
    buildSurvivorPhaseAnnouncement,
} from '../contest/contest_announcer.js';
import { validateGameParticipants } from '../contest/game_session_manager.js';
import { ConversationRequestRegistry } from './conversation_requests.js';
import { buildChallengeDeck, resolveTeamChallenge } from './survivor_challenges.js';
import { COUNCIL_PHASES, HOST_HELD_VOTE_PHASES, MIN_SURVIVOR_PLAYERS } from './survivor_game.js';
import { buildPlayerBriefing } from './survivor_memory.js';
import { buildSurvivorDirective } from './survivor_prompts.js';
import { buildSurvivorRelationships } from './survivor_relationships.js';
import { buildSurvivorStandings } from './survivor_standings.js';
import { applyRefusalEvent, applyRoomEvent } from './survivor_threads.js';

function clone(value) {
    return value === null || value === undefined
        ? value
        : JSON.parse(JSON.stringify(value));
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
        // Council is a spoken show: the host reads questions and phase calls in
        // the narrator voice, and each answer is played back in that player's
        // own voice. Both default to silence so a season still runs without TTS.
        this.announce = options.announce || (() => {});
        this.speakAs = options.speakAs || (() => {});
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
        // The secret feed is capped because it is a scrolling log, but the
        // transcripts behind it are the point of the conversation browser: they
        // keep the full text of every thread for as long as the season runs.
        this.roomHistoryLimit = options.roomHistoryLimit ?? 200;
        this.threadMessageLimit = options.threadMessageLimit ?? 500;
        this.secretEventLimit = options.secretEventLimit ?? 300;
        this.refusalLimit = options.refusalLimit ?? 200;
        this.roomHistory = [];
        this.secretEventLog = [];
        this.refusals = [];
        // Everything that went wrong, kept in the view so the control room can
        // show it instead of burying it in the server console.
        this.problemLimit = options.problemLimit ?? 60;
        this.problems = [];
        this.sessionPath = path.join(this.coordinator.root, 'session.json');
        this._persistOperation = Promise.resolve();
    }

    // Called for every private-room event so a reloaded dashboard can replay the
    // secret feed, so the relationship graph outlives the rooms themselves, and
    // so the conversation browser can show a full transcript per thread.
    // Returns the event stamped with when and where it happened, which is what
    // the operator sockets should carry.
    recordRoomEvent(event) {
        if (!event?.type) return null;
        const stamped = this._stamp(event);
        this._pushSecretEvent(stamped);
        if (stamped.roomId) this._recordThreadEvent(stamped);
        // Rooms and relationships live in view(), and nothing else in this path
        // changes session state, so push the refresh without re-persisting.
        this.onUpdate(this.view());
        return stamped;
    }

    // Conversation requests are secret in the same way rooms are: operators see
    // everything, bots only see their own.
    recordConversationEvent(event) {
        if (!event?.type) return null;
        const stamped = this._stamp(event);
        this._pushSecretEvent(stamped);
        this._recordRefusals(stamped);
        this.onUpdate(this.view());
        return stamped;
    }

    secretEvents() {
        return clone(this.secretEventLog);
    }

    // Everything the operator conversation browser needs in one payload: each
    // private thread with its full text, plus a per-castaway index so clicking a
    // name does not mean scanning every thread in the browser.
    conversationTranscripts() {
        const game = this.coordinator.view();
        const openRoomIds = new Set(this.rooms.view().map(room => room.id));
        const threads = this.roomHistory.map(thread => ({
            ...clone(thread),
            open: openRoomIds.has(thread.roomId),
        }));
        return {
            seasonId: this.active?.id ?? null,
            status: this.active?.status ?? null,
            round: game?.round ?? null,
            phase: game?.phase ?? null,
            players: (game?.participantIds ?? this.active?.participantIds ?? [])
                .map(id => this._transcriptPlayer(id, game, threads)),
            threads,
            refusals: clone(this.refusals),
        };
    }

    _transcriptPlayer(id, game, threads) {
        const player = game?.players?.[id] ?? {};
        const own = threads.filter(thread => thread.memberIds.includes(id));
        const partnerIds = [...new Set(
            own.flatMap(thread => thread.memberIds).filter(other => other !== id)
        )].sort();
        return {
            id,
            tribe: player.tribe ?? null,
            active: Boolean(player.active),
            jury: Boolean(player.jury),
            placement: player.placement ?? null,
            partnerIds,
            threadCount: own.length,
            // A thread they walked out of is still theirs to read, but they are
            // not in the room any more, so it does not count as talking.
            openThreadCount: own.filter(thread =>
                thread.open && (thread.currentMemberIds || []).includes(id)
            ).length,
            // Split so an operator can tell a talker from someone being talked at.
            spokenCount: own.reduce(
                (total, thread) => total + (thread.messageCountBySender[id] || 0),
                0
            ),
            messageCount: own.reduce((total, thread) => total + thread.messageCount, 0),
            lastMessageAt: own.reduce(
                (latest, thread) => Math.max(latest, thread.lastMessageAt ?? 0),
                0
            ) || null,
        };
    }

    _stamp(event) {
        const state = this.coordinator.view();
        return {
            ...clone(event),
            at: event.at ?? this.clock(),
            round: state?.round ?? null,
            phase: state?.phase ?? null,
        };
    }

    _pushSecretEvent(event) {
        this.secretEventLog.push(event);
        if (this.secretEventLog.length > this.secretEventLimit) {
            this.secretEventLog.splice(0, this.secretEventLog.length - this.secretEventLimit);
        }
    }

    _recordThreadEvent(event) {
        applyRoomEvent(this.roomHistory, event, {
            messageLimit: this.threadMessageLimit,
            threadLimit: this.roomHistoryLimit,
        });
    }

    _recordRefusals(event) {
        applyRefusalEvent(this.refusals, event, { limit: this.refusalLimit });
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

    // A dead microphone must never stall the season, so both speech paths
    // swallow their failures into the operator's problem feed.
    async _narrate(text, options = {}) {
        const line = String(text ?? '').trim();
        if (!line) return;
        try {
            await this.announce(line, options);
        } catch (error) {
            this._problem('narration', error, { text: line });
        }
    }

    async _speakPlayerLine(playerId, text) {
        const line = String(text ?? '').trim();
        if (!line) return;
        try {
            await this.speakAs(playerId, line);
        } catch (error) {
            this._problem('council-voice', error, { playerId });
        }
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

    // Whether the season is holding the world right now, which is the only thing
    // that should stop another game from starting. A suspended season owns no
    // bots and no arena, and a finished one is just standings left on screen, so
    // neither is in the way. Also true for a season stranded on disk with no
    // session record, because its bots and arena claim are unaccounted for.
    occupiesWorld() {
        if (!this.active) return this.coordinator.view()?.status === 'running';
        return ['provisioning', 'running'].includes(this.active.status);
    }

    view() {
        if (!this.active) return null;
        const game = this.coordinator.view();
        if (game) {
            game.ballotCount = Object.keys(game.ballots || {}).length;
            game.missingVoterIds = HOST_HELD_VOTE_PHASES.includes(game.phase)
                ? game.eligibleVoterIds.filter(id => !game.ballots?.[id])
                : [];
            game.ballots = {};
            game.ballotReasons = {};
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

    // A restart never puts bots back in the world on its own. The season is read
    // back off disk and parked as 'suspended', and the control room shows it
    // waiting; the operator decides whether to bring it back or start something
    // else. Auto-resuming here used to race game starts, because the guards that
    // block a new game read this.active and recovery had not set it yet.
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
        this.active.status = 'suspended';
        this.active.suspendedReason = 'server-restart';
        this.active.paused = true;
        this.active.phaseDeadlineAt = null;
        // The cast is gone with the old process, so nothing is owed a resume.
        this.active.createdAgents = [];
        // A challenge cannot survive a restart: the contest that was driving it
        // died with the process. Drop the link so resuming re-runs the round's
        // challenge rather than waiting forever on a contest nobody is running.
        this.active.challengeContestId = null;
        this.rooms.closeAll('server-restarted');
        this.conversations.cancelAll('server-restarted');
        // Private alliance memory lives only in memory during a season, so a
        // restart would otherwise wipe every bot's private history and the
        // operator's relationship graph. Rebuild both from the journal now, since
        // briefingFor() reads secretEventLog when the season is resumed.
        await this._replayPrivateJournal(game);
        this._emit();
        this._log(
            'info',
            `season ${game.id} restored in phase '${game.phase}' and suspended, waiting for the operator to resume`
        );
        return this.view();
    }

    // Park the season without ending it: the cast leaves the world and the arena
    // is free for another game, but the game state on disk is untouched so it can
    // be picked up again later.
    async suspend(reason = 'Suspended by operator') {
        this._requireActive();
        if (this.active.status === 'suspended') return this.view();
        if (this.active.challengeContestId) {
            throw new Error('Let the immunity challenge finish before suspending the season');
        }
        const cast = this.active.createdAgents;
        this.rooms.closeAll('season-suspended');
        this.conversations.cancelAll('season-suspended');
        await Promise.allSettled(cast.map(agent => this.destroyAgent(agent.id)));
        this.active.status = 'suspended';
        this.active.suspendedReason = 'operator';
        this.active.paused = true;
        this.active.phaseDeadlineAt = null;
        this.active.createdAgents = [];
        this.active.readiness = null;
        this._emit();
        this._log('info', `season ${this.active.id} suspended: ${reason}`);
        return this.view();
    }

    // Bring a parked season back: respawn whoever is still in the game, re-send
    // the phase directive so every bot knows where the season stands, and put the
    // phase clock back on.
    async resumeSeason() {
        this._requireActive();
        if (this.active.status !== 'suspended') return this.view();
        const game = this.coordinator.view();
        if (game?.status !== 'running') {
            throw new Error('The suspended season is no longer running and cannot be resumed');
        }
        try {
            await this._restoreCast(game);
            this.active.status = 'running';
            this.active.suspendedReason = null;
            this.active.paused = false;
            await this._broadcastPhase();
            // A season parked during 'challenge' comes back needing its challenge
            // run, because suspending tore down the contest that would have run it.
            if (game.phase === 'challenge' && !this.active.challengeContestId) {
                await this.startNextChallenge();
            } else {
                const duration = this._durationForPhase(game.phase);
                this.active.phaseDeadlineAt = duration == null ? null : this.clock() + duration;
            }
            this._emit();
            this._log('info', `season ${game.id} resumed in phase '${game.phase}'`);
            return this.view();
        } catch (error) {
            this._recordFailure(error, 'resume');
            this._log('error', `resume failed: ${error.message}`, {
                agents: this._describeAllAgents(),
            });
            // Stay parked rather than half-running, so the operator can retry or
            // cancel instead of being stuck in a season with no cast.
            this.active.status = 'suspended';
            this.active.paused = true;
            this._emit();
            throw error;
        }
    }

    // Put every castaway who is still in the game back in the world. One bot that
    // will not spawn is reported, not fatal: the rest of the cast still plays.
    async _restoreCast(game) {
        const wanted = this.active.participantIds.filter(id =>
            game.players[id]?.active || game.players[id]?.jury
        );
        // Anyone already in the world still belongs to this season. Claiming them
        // here is what lets a later cancel or suspend take the whole cast down;
        // a bot left out of createdAgents would be stranded in the world forever.
        for (const name of wanted) {
            if (this.active.createdAgents.some(item => item.name === name)) continue;
            if (this.isAgentReady(name)) this.active.createdAgents.push({ name, id: name });
        }
        const missing = wanted.filter(id => !this.isAgentReady(id));
        if (missing.length === 0) return [];
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
                    recordBotView: this.active.recordingEnabled === true,
                    autoRecordingEnabled: this.active.recordingEnabled !== true
                        && this.active.autoRecordingEnabled === true,
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
        await this._waitUntilReady(missing, 'resume');
        return missing;
    }

    // Rebuild the in-memory private record (secret feed, per-bot private history,
    // and the relationship graph's room transcripts) by replaying the journal
    // through the same accumulators the live path uses. Round and phase are read
    // back from the stamped journal entry so a replayed line lands in the round
    // it happened in, not the round we recovered in. A journal that cannot be
    // read is a degraded recovery, not a failed one: the season still continues,
    // it just starts with empty private memory.
    async _replayPrivateJournal(game) {
        if (typeof this.coordinator.readPrivateEvents !== 'function') return;
        let events;
        try {
            events = await this.coordinator.readPrivateEvents(game.id);
        } catch (error) {
            this._problem('recovery-journal', error);
            return;
        }
        this.roomHistory = [];
        this.secretEventLog = [];
        this.refusals = [];
        for (const event of events) {
            if (!event?.type) continue;
            const stamped = {
                ...clone(event),
                at: event.at ?? this.clock(),
                round: event.round ?? null,
                phase: event.phase ?? null,
            };
            this._pushSecretEvent(stamped);
            if (stamped.roomId) this._recordThreadEvent(stamped);
            this._recordRefusals(stamped);
        }
        this._log('info', `replayed ${events.length} private event(s) from the journal`);
    }

    // A finished season keeps its final standings on screen until something else
    // needs the arena. That archive is not a lock, so the games dashboard can
    // clear it the same way a new season does.
    async archiveFinishedSeason(reason = 'Archived before starting a new game') {
        if (this.active?.status !== 'completed') return null;
        return await this.cancel(reason);
    }

    async start(request = {}) {
        if (this.active?.status === 'completed') {
            await this.archiveFinishedSeason('Archived before starting a new season');
        } else if (this.active?.status === 'suspended') {
            throw new Error(
                'A suspended Survivor season is waiting. Resume it or cancel it before starting a new one.'
            );
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
        const recordingEnabled = request.recordingEnabled === true;
        const autoRecordingEnabled = !recordingEnabled && request.autoRecordingEnabled === true;
        this.roomHistory = [];
        this.secretEventLog = [];
        this.refusals = [];
        this.problems = [];
        this.conversations.cancelAll('new-season');
        const season = await this.coordinator.start({
            participantIds,
            mergeAt,
            finalistCount: request.finalistCount,
            juryEligibility: request.juryEligibility,
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
            recordingEnabled,
            autoRecordingEnabled,
            createdAgents: [],
            challengeDeck: buildChallengeDeck(challengeGameIds, {
                rounds: participantIds.length,
                random: this.random,
            }),
            challengeIndex: 0,
            challengeContestId: null,
            phaseDeadlineAt: null,
            paused: false,
            suspendedReason: null,
            phaseDurationsMs,
            // Off by default: the host runs council by hand. Turn it on for
            // unattended runs so a season can play itself through.
            councilAutoAdvance: Boolean(request.councilAutoAdvance),
            readiness: null,
            // Harness / memory-flip proof: before targets (reeval) vs ballots.
            voteProof: { beforeTargets: {}, afterTargets: {}, councilCiting: {} },
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
                    recordBotView: recordingEnabled,
                    autoRecordingEnabled,
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
        // Private talk closes for the duration of the challenge. The rooms are how
        // a bot gets pulled into scheming, and a bot scheming through a race it
        // could have won is the exact failure this is here to prevent. The threads
        // themselves survive in the journal, so nobody forgets an alliance.
        this.rooms.closeAll('immunity-challenge');
        this.conversations.cancelAll('immunity-challenge');
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
                // Wire Minecraft team coloring for pre-merge challenges.
                teamNames: state.merged ? null : [...state.tribeNames],
                teamByParticipant: state.merged
                    ? null
                    : Object.fromEntries(
                        participantIds.map(id => [id, state.players[id].tribe])
                    ),
            },
        });
        await this.prepareArena(preset, participantIds, {
            teamNames: state.merged ? undefined : state.tribeNames,
            teamByParticipant: state.merged
                ? undefined
                : Object.fromEntries(
                    participantIds.map(id => [id, state.players[id].tribe])
                ),
        });
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
            } else if (
                contest.rules.type === 'depth_race'
                || contest.rules.type === 'tower_battle'
                // Spleef tribes are told they are scored on their longest
                // survivor. Taking the individual winner's tribe instead decides
                // immunity by result order whenever the clock expires with
                // survivors on both tribes, since they all score the same.
                || contest.rules.type === 'spleef'
            ) {
                const tribeByParticipant = Object.fromEntries(
                    state.participantIds.map(id => [id, state.players[id].tribe])
                );
                const results = contest.results.map(result => ({
                    participantId: result.participantId,
                    score: result.score,
                    y: result.details?.y,
                    depthY: result.details?.y,
                    height: result.details?.height ?? result.score,
                    survivedMs: result.details?.survivedMs,
                    surviving: result.details?.surviving === true,
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
        // A parked season owns no bots and no arena, so nothing about it may move
        // on its own while another game is using the world.
        if (this.active.status === 'suspended') return null;
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
                // Pending invites expire with the strategy window, not a 30s TTL.
                await this._settleOpenTalkRequests('strategy-ended');
                return this._applyAndTransition('openCouncil', { openedAt: this.clock() });
            case 'tribal_council':
                return this._applyAndTransition('beginReevaluation');
            case 'reevaluation':
                return this._applyAndTransition('beginVoting');
            case 'voting':
            case 'revote':
            case 'jury_voting':
            case 'finalist_tiebreak':
                // Host-held voting: Advance never autofills or reveals. The host
                // must press Reveal once every ballot is in.
                throw new Error(
                    'Voting is host-held. Wait for every ballot, then use Reveal votes.'
                );
            case 'deadlock':
                await this.coordinator.apply('fillMissingDeadlockDecisions');
                return this._applyAndTransition('resolveDeadlock');
            case 'jury_questioning':
                return this._applyAndTransition('beginJuryVote');
            case 'fire_making':
                throw new Error(
                    'Fire-making needs operator confirmation. Use Resolve fire with confirm=true'
                    + ' (or pass winnerId).'
                );
            default:
                return null;
        }
    }

    async _settleOpenTalkRequests(reason) {
        for (const request of this.conversations.pending()) {
            try {
                await this._resolveConversationRequest(request.id);
            } catch (error) {
                this._problem('talk-settle', error, { requestId: request.id, reason });
            }
        }
        this.conversations.pruneResolved(this.clock());
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
        // Spoken before the bots are prompted, so the host is heard asking the
        // question before any answer lands in the speech queue behind it.
        await this._narrate(buildCouncilQuestionAnnouncement(question));
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
        await this._speakPlayerLine(playerId, entry.answer);
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
        switch (type) {
            case 'status':
                return { success: true, data: this._privateStatus(agentId) };
            case 'talk-request': {
                this._requireSocialPhase(state);
                const request = this.conversations.open(
                    agentId,
                    payload.inviteeIds,
                    this._privateTalkPlayerIds(agentId),
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
                this._requireSocialPhase(state);
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
                const data = await this.coordinator.apply(
                    'castVote',
                    agentId,
                    payload.targetId,
                    payload.reason
                );
                if (this.active?.voteProof) {
                    this.active.voteProof.afterTargets[agentId] = payload.targetId;
                    const reason = String(payload.reason || '');
                    this.active.voteProof.councilCiting[agentId] = /council|mat|jeff|tribal|said|answer/i
                        .test(reason);
                }
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
            const eligible = this._privateTalkPlayerIds(pending.requesterId);
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
        this.conversations.pruneResolved(this.clock());
    }

    async control(action, payload = {}) {
        switch (action) {
            case 'pause':
                this._requireRunningSession();
                if (this.active.challengeContestId) {
                    throw new Error('Active immunity challenges cannot be paused');
                }
                this.active.paused = true;
                // Pausing also handles voices: soft-mute so catch-up works on resume.
                this.active.pausedMuteMode = this.onPauseMute?.() ?? 'soft';
                this._emit();
                return this.view();
            case 'resume':
                // Only lifts a pause. A parked season needs its cast back, which
                // is 'resume-season'.
                this._requireRunningSession();
                this.active.paused = false;
                this.onResumeMute?.(this.active.pausedMuteMode);
                this.active.pausedMuteMode = null;
                this._emit();
                return this.view();
            case 'suspend':
                return this.suspend(payload.reason);
            case 'resume-season':
                return this.resumeSeason();
            case 'advance':
                this._requireActive();
                await this.advancePhase();
                return this.view();
            case 'reveal-votes': {
                this._requireActive();
                const { phase } = this._requireRunning();
                if (!HOST_HELD_VOTE_PHASES.includes(phase)) {
                    throw new Error(`Votes cannot be revealed during ${phase}`);
                }
                // No autofill: missing ballots block reveal and surface by name.
                return this._applyAndTransition('revealVotes');
            }
            case 'open-council':
                await this._settleOpenTalkRequests('strategy-ended');
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
            case 'end-council': {
                // The finale is a council too, so the same button has to open the
                // jury vote rather than a Tribal Council vote that cannot start.
                // Ordinary councils enter re-evaluation before ballots open.
                const { phase } = this._requireRunning();
                if (phase !== 'jury_questioning' && this.active) {
                    this.active.voteProof = {
                        beforeTargets: {},
                        afterTargets: {},
                        councilCiting: {},
                    };
                }
                return this._applyAndTransition(
                    phase === 'jury_questioning' ? 'beginJuryVote' : 'beginReevaluation'
                );
            }
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
                if (before.phase !== 'challenge') {
                    throw new Error(`Cannot resolve challenge during ${before.phase}`);
                }
                await this._abortActiveChallengeContest('challenge-result');
                const result = before.merged
                    ? { winnerId: payload.winnerId }
                    : { winningTribe: payload.winningTribe };
                await this.coordinator.apply('completeChallenge', result);
                await this._afterStateChange(before, this.coordinator.view());
                return this.view();
            }
            case 'set-immunity': {
                this._requireActive();
                const before = this.coordinator.view();
                await this.coordinator.apply('setImmunity', payload.immunityIds || []);
                const after = this.coordinator.view();
                // Strategy prompts include the vulnerable list, so refresh them.
                if (after.phase === 'strategy' || before.phase === 'strategy') {
                    await this._broadcastPhase();
                }
                this._emit();
                return this.view();
            }
            case 'skip-challenge': {
                this._requireActive();
                const before = this.coordinator.view();
                if (before.phase !== 'challenge') {
                    throw new Error(`Cannot skip challenge during ${before.phase}`);
                }
                await this._abortActiveChallengeContest('skipped by operator');
                await this.coordinator.apply('skipChallenge', {
                    winnerId: payload.winnerId,
                    winningTribe: payload.winningTribe,
                    immunityIds: payload.immunityIds,
                    challengeId: payload.challengeId || 'harness-skip',
                });
                await this._afterStateChange(before, this.coordinator.view());
                return this.view();
            }
            case 'jump-to-council': {
                this._requireActive();
                let before = this.coordinator.view();
                if (before.phase === 'challenge') {
                    await this.control('skip-challenge', payload);
                    before = this.coordinator.view();
                }
                if (before.phase === 'strategy' && Array.isArray(payload.immunityIds)) {
                    await this.coordinator.apply('setImmunity', payload.immunityIds);
                }
                if (this.coordinator.view().phase !== 'strategy') {
                    throw new Error(
                        `Cannot jump to council from ${this.coordinator.view().phase}`
                    );
                }
                await this._settleOpenTalkRequests('strategy-ended');
                return this._applyAndTransition('openCouncil', { openedAt: this.clock() });
            }
            case 'fire-result': {
                const confirm = payload.confirm === true || Boolean(payload.winnerId);
                if (!confirm) {
                    throw new Error(
                        'Confirm fire-making resolution (confirm=true) or pass winnerId'
                    );
                }
                return this._applyAndTransition('resolveFireMaking', payload.winnerId);
            }
            case 'cancel':
                return this.cancel(payload.reason);
            default:
                throw new Error(`Unknown Survivor control: ${action}`);
        }
    }

    async cancel(reason = 'Cancelled by operator') {
        const state = this.coordinator.view();
        // A season can outlive its session overlay — session.json is lost, or a
        // startup died between coordinator.start() and this.active being set.
        // Cancelling still has to clear the game on disk, or it blocks every
        // later game and silently comes back on the next restart.
        if (!this.active) {
            if (state?.status !== 'running') return null;
            await this.coordinator.apply('cancel', reason);
            this._log('info', `cleared orphaned season ${state.id} with no session record`);
            this._emit();
            return null;
        }
        const session = clone(this.active);
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

    // Cancel any live contest overlay and clear challenge configs on bots so a
    // harness skip / host override cannot leave the season waiting on a race.
    async _abortActiveChallengeContest(reason = 'challenge aborted') {
        const contestId = this.active?.challengeContestId
            || this.contestCoordinator.snapshot()?.activeContestId
            || null;
        if (contestId && typeof this.contestCoordinator.cancelContest === 'function') {
            try {
                await this.contestCoordinator.cancelContest(contestId, reason);
            } catch (error) {
                this._problem('challenge-abort', error, { contestId, reason });
            }
        }
        if (this.active) this.active.challengeContestId = null;
        const participants = this.coordinator.view()?.participantIds || [];
        await Promise.allSettled(participants.map(id => this.sendChallengeConfig(id, {
            challengeId: null,
            contestType: 'survivor',
            winItem: null,
            floorY: null,
        })));
    }

    async _afterStateChange(before, after) {
        // A phase change deliberately leaves private rooms alone. An alliance
        // formed in strategy is still an alliance at the mat and in the voting
        // booth, and the conversation browser is meant to be live all season.
        // The one exception is a challenge, which startNextChallenge() closes the
        // rooms for. It does get narrated, so the audience hears the show move.
        const phaseChanged = after.phase !== before.phase;
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
        if (phaseChanged) await this._narrate(buildSurvivorPhaseAnnouncement(after));
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
        // A challenge directive carries the contest's own rules and nothing about
        // the season; a social directive carries the bot's memory of the season and
        // nothing about a contest. Only one of the two is ever built.
        const challenge = state.phase === 'challenge' ? this._currentChallengePreset(state) : null;
        const results = await Promise.allSettled(recipients.map(id =>
            this.sendDirective(id, buildSurvivorDirective(state, id, {
                preset: challenge,
                briefing: state.phase === 'challenge' ? '' : this.briefingFor(id, state),
            }), {
                pause: !state.players[id].active && !state.players[id].jury,
                // A bot still in a conversation only gets its next goal queued
                // behind that chat, so a challenge would start with the cast
                // arguing and no idea what the contest is. Cut the talk instead.
                endConversations: state.phase === 'challenge',
                // Only a challenge is a game a bot can be knocked out of.
                gameStarted: state.phase === 'challenge',
            })
        ));
        const undelivered = recipients.filter((_, index) => results[index].status === 'rejected');
        if (undelivered.length > 0) {
            this._problem('phase-directive', new Error(
                `${undelivered.join(', ')} did not receive the ${state.phase} directive`
            ));
        }
    }

    // The contest the round is actually playing, or null in the gap between
    // entering the challenge phase and the contest being set up. A preset that no
    // longer resolves must not take the whole broadcast down with it.
    _currentChallengePreset(state = this.coordinator.view()) {
        const challengeId = state?.challenge?.id;
        if (!challengeId) return null;
        try {
            return this.getContestPreset(challengeId);
        } catch (error) {
            this._problem('challenge-preset', error, { challengeId });
            return null;
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

    // The refusal a bot reads when it tries to socialise mid-challenge. It is
    // phrased as a redirection, because the useful outcome is the bot going back
    // to the contest rather than retrying the command.
    _requireSocialPhase(state) {
        if (state.phase !== 'challenge') return;
        throw new Error(
            'Private talk is closed during an immunity challenge. Win the challenge first;'
            + ' camp talk reopens as soon as it is over.'
        );
    }

    // Who this player may pull aside in any social phase. Before the merge the
    // tribes are camped apart, so the set is the player's own tribe rather than
    // whoever happens to be going to council; afterwards it is everyone left.
    _privateTalkPlayerIds(playerId) {
        const state = this.coordinator.view();
        if (!state || state.status !== 'running') return [];
        if (!state.players[playerId]?.active) return [];
        const active = state.participantIds.filter(id => state.players[id].active);
        return state.merged
            ? active
            : active.filter(id => state.players[id].tribe === state.players[playerId].tribe);
    }

    _duration(key, fallback) {
        return this.active?.phaseDurationsMs?.[key]
            ?? this.phaseDurationsMs[key]
            ?? fallback;
    }

    // null means "no clock": the host decides when this phase ends. Councils
    // default to that, because Jeff asking questions is the show and a timer
    // would cut him off mid-question. Vote phases are also host-held so the
    // operator waits for real ballots instead of autofilling on a clock.
    // Re-evaluation is host-held too: bots must reconsider before ballots open.
    _durationForPhase(phase) {
        if (COUNCIL_PHASES.includes(phase) && !this.active?.councilAutoAdvance) return null;
        if (phase === 'reevaluation') return null;
        if (HOST_HELD_VOTE_PHASES.includes(phase)) return null;
        const defaults = {
            strategy: 600_000,
            tribal_council: 300_000,
            reevaluation: null,
            voting: null,
            revote: null,
            deadlock: 60_000,
            fire_making: 60_000,
            jury_questioning: 180_000,
            jury_voting: null,
            finalist_tiebreak: null,
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

    // A parked season is not playable: it has no cast in the world and no claim
    // on the arena, so every gameplay path has to refuse until it is resumed.
    _requireRunningSession() {
        this._requireActive();
        if (this.active.status === 'suspended') {
            throw new Error('The Survivor season is suspended. Resume it first.');
        }
        return this.coordinator.view();
    }

    _requireRunning() {
        const state = this._requireRunningSession();
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
