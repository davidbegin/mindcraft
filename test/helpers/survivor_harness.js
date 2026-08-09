// A whole Survivor season with no Minecraft, no contest engine, and no clock.
//
// Everything the session manager reaches for is a plain function here, so a test
// can drive a season the way the operator would and then read back exactly what
// the cast was told, what was said out loud, and which bots were spawned.

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getContestGamePreset } from '../../src/mindcraft/contest/game_presets.js';
import { ConversationRequestRegistry } from '../../src/mindcraft/survivor/conversation_requests.js';
import { PrivateRoomRegistry } from '../../src/mindcraft/survivor/private_rooms.js';
import { SurvivorCoordinator } from '../../src/mindcraft/survivor/survivor_coordinator.js';
import { SurvivorSessionManager } from '../../src/mindcraft/survivor/survivor_session_manager.js';

export class FakeContestCoordinator {
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
        const contest = this.contests[id];
        contest.status = 'completed';
        contest.winnerIds = [winnerId];
        // A real coordinator scores every participant, which is what tribe
        // scoring reads to find each tribe's best result.
        contest.results = contest.participantIds.map(participantId => ({
            participantId,
            score: participantId === winnerId ? 1 : 0,
            details: {},
        }));
    }

    completeWithResults(id, winnerIds, results) {
        this.activeContestId = null;
        this.contests[id].status = 'completed';
        this.contests[id].winnerIds = [...winnerIds];
        this.contests[id].results = results;
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

export function participants(count = 11) {
    return Array.from({ length: count }, (_, index) => ({
        name: `Bot${index + 1}`,
        profileId: 'test',
        voice: '',
        systemPrompt: `Personality ${index + 1}`,
    }));
}

// Bots reach a private room by asking and being told yes, so tests that only
// care about the room still have to walk through the negotiation.
export async function openPrivateRoom(manager, requesterId, inviteeIds, options = {}) {
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

export async function createManager() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'survivor-session-'));
    const coordinator = await SurvivorCoordinator.create({ root, random: () => 0 });
    const contestCoordinator = new FakeContestCoordinator();
    let now = 0;
    const directives = [];
    const notifications = [];
    const spoken = [];
    const agentSettings = [];
    let requestSequence = 0;
    let roomSequence = 0;
    const options = {
        coordinator,
        contestCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => `room-${++roomSequence}` }),
        conversations: new ConversationRequestRegistry({
            idFactory: () => `talk-${++requestSequence}`,
        }),
        notifyAgent: (id, event, payload) => {
            notifications.push({ id, event, payload });
            return Promise.resolve({ success: true });
        },
        announce: text => {
            spoken.push({ speaker: 'narrator', text });
            return Promise.resolve();
        },
        speakAs: (playerId, text) => {
            spoken.push({ speaker: playerId, text });
            return Promise.resolve();
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
        buildAgentSettings: (profile, gameSession) => ({ profile, gameSession }),
        createAgent: settings => {
            agentSettings.push(settings);
            return {
                success: true,
                agentId: `agent-${settings.profile.name}`,
            };
        },
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
        spoken,
        agentSettings,
        advance: milliseconds => {
            now += milliseconds;
        },
    };
}
