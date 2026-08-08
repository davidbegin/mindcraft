// Drives a real Survivor season to a mid-Tribal-Council moment and writes the
// exact state the dashboard receives, so the operator UI can be exercised
// against true data instead of hand-written fakes.
//
//   node tools/survivor_ui_fixture.mjs /tmp/survivor-council.json
//
// The season logs to stdout, so the state goes to a file rather than a pipe.
// Serve it to the browser with tools/fixture_server.mjs.

import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getContestGamePreset } from '../src/mindcraft/contest/game_presets.js';
import { ConversationRequestRegistry } from '../src/mindcraft/survivor/conversation_requests.js';
import { PrivateRoomRegistry } from '../src/mindcraft/survivor/private_rooms.js';
import { SurvivorCoordinator } from '../src/mindcraft/survivor/survivor_coordinator.js';
import { SurvivorSessionManager } from '../src/mindcraft/survivor/survivor_session_manager.js';

class FakeContestCoordinator {
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
        return { ...this.snapshot(), contests: Object.values(this.contests) };
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
        this.contests[id].deadlineAt = 10_000;
        return { ...this.contests[id] };
    }

    complete(id, winnerId) {
        this.activeContestId = null;
        this.contests[id].status = 'completed';
        this.contests[id].winnerIds = [winnerId];
        this.contests[id].results = [{ participantId: winnerId, score: 1, details: {} }];
    }

    cancelContest(id) {
        this.activeContestId = null;
        this.contests[id].status = 'cancelled';
    }
}

const CAST = ['Aria', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn'];

async function build() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'survivor-fixture-'));
    const coordinator = await SurvivorCoordinator.create({ root, random: () => 0 });
    const contestCoordinator = new FakeContestCoordinator();
    let now = 0;
    let requestSequence = 0;
    let roomSequence = 0;

    const manager = new SurvivorSessionManager({
        coordinator,
        contestCoordinator,
        rooms: new PrivateRoomRegistry({ idFactory: () => `room-${++roomSequence}` }),
        conversations: new ConversationRequestRegistry({ idFactory: () => `talk-${++requestSequence}` }),
        notifyAgent: () => Promise.resolve({ success: true }),
        getProfiles: () => [{ id: 'test', configured: true, model: 'test-model', provider: 'test', profile: {} }],
        getExistingAgentNames: () => [],
        resolveParticipantVoice: (_name, voice) => voice,
        reclaimNames: () => Promise.resolve(),
        buildAgentSettings: profile => ({ profile }),
        createAgent: settings => ({ success: true, agentId: `agent-${settings.profile.name}` }),
        destroyAgent: () => Promise.resolve(),
        isAgentReady: () => true,
        getContestPreset: getContestGamePreset,
        prepareArena: () => ({}),
        sendDirective: () => {},
        sendChallengeConfig: () => Promise.resolve(),
        phaseDurationsMs: { strategy: 60_000, voting: 60_000, tribal_council: null },
        clock: () => now,
        sleep: () => Promise.resolve(),
    });
    manager.rooms.onEvent = event => manager.recordRoomEvent(event);
    manager.conversations.onEvent = event => manager.recordConversationEvent(event);

    await manager.start({
        participants: CAST.map((name, index) => ({
            name,
            profileId: 'test',
            voice: '',
            systemPrompt: `Personality ${index + 1}`,
        })),
        mergeAt: 6,
        challengeGameIds: ['cake_race'],
    });

    contestCoordinator.complete(manager.view().challengeContestId, 'Aria');
    await manager.syncContestView(contestCoordinator.view());

    // A pair that talked, and a pair that refused to.
    const accepted = await manager.handleAgentCommand('Bram', 'talk-request', {
        inviteeIds: ['Cleo'],
        pitch: 'Dax has to go. Are you with me?',
    });
    await manager.handleAgentCommand('Cleo', 'talk-respond', {
        requestId: accepted.data.requestId,
        accepted: true,
    });
    await manager.handleAgentCommand('Bram', 'room-send', {
        message: 'Dax, then Esme. Nobody else hears this.',
    });

    const refused = await manager.handleAgentCommand('Dax', 'talk-request', {
        inviteeIds: ['Esme'],
        pitch: 'We need to flip on Aria.',
    });
    await manager.handleAgentCommand('Esme', 'talk-respond', {
        requestId: refused.data.requestId,
        accepted: false,
        reason: 'I am not being seen with you tonight.',
    });

    // One request left hanging so the dashboard shows a pending ask.
    await manager.handleAgentCommand('Finn', 'talk-request', {
        inviteeIds: ['Aria', 'Cleo'],
        pitch: 'Three of us can run this.',
    });

    await manager.control('open-council');
    await manager.askCouncilQuestion('Dax, who here has already lied to you?', ['Dax']);
    await manager.handleAgentCommand('Dax', 'council-answer', {
        answer: 'Esme told me she was voting Aria, then would not even talk to me tonight.',
    });
    await manager.askCouncilQuestion('Esme, is that true?', ['Esme', 'Cleo']);
    await manager.handleAgentCommand('Esme', 'council-answer', {
        answer: 'I never promised Dax anything. He is telling this jury what it wants to hear.',
    });

    return manager.view();
}

const target = process.argv[2] || '/tmp/survivor-council.json';

build().then(async view => {
    await writeFile(target, JSON.stringify(view, null, 2));
    console.log(`wrote ${target}`);
}, error => {
    console.error(error);
    process.exit(1);
});
