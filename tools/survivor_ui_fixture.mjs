// Drives a real Survivor season through a completed vote and into the next
// Tribal Council, then writes the exact state the dashboard receives, so the
// operator UI can be exercised against true data instead of hand-written fakes.
//
//   node tools/survivor_ui_fixture.mjs /tmp/survivor-council.json
//   node tools/survivor_ui_fixture.mjs /tmp/survivor-finale.json --finale
//   node tools/survivor_ui_fixture.mjs /tmp/survivor-parked.json --suspended
//
// --finale keeps playing to a crowned winner, which is what exercises a tied
// vote, a revote, and the jury ballots. --suspended parks the season instead,
// which is what puts the waiting-to-resume banner on screen.
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

async function castBallots(manager, ballots) {
    for (const [voterId, targetId, reason] of ballots) {
        await manager.handleAgentCommand(voterId, 'cast-vote', { targetId, reason });
    }
    await manager.control('advance');
}

// One immunity challenge, one council, and — when the round supplies ballots —
// the vote that closes it. Ballots carry the private reason the voter sealed
// with them, which is what the results panel reads. A round with no ballots
// leaves the season sitting in an open council.
async function playRound(manager, contests, round) {
    if (!manager.view().challengeContestId) await manager.control('challenge');
    contests.complete(manager.view().challengeContestId, round.immune);
    await manager.syncContestView(contests.view());
    await manager.control('open-council');
    for (const [prompt, playerId, answer] of round.questions || []) {
        await manager.askCouncilQuestion(prompt, [playerId]);
        await manager.handleAgentCommand(playerId, 'council-answer', { answer });
    }
    if (!round.ballots) return;
    await manager.control('end-council');
    await castBallots(manager, round.ballots);
    if (round.revote) await castBallots(manager, round.revote);
}

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

    // A real vote, with the private reasoning each bot seals with its ballot.
    // Finn deliberately never votes, so the reveal also shows a forfeited ballot.
    await manager.control('end-council');
    await castBallots(manager, [
        ['Bram', 'Dax', 'He came at me in front of everyone. If he stays he takes the shot he just telegraphed.'],
        ['Cleo', 'Dax', 'Bram and I agreed on Dax before council and nothing tonight changed that. Staying loyal buys me the next vote.'],
        ['Esme', 'Dax', 'He put my name in the air on the mat. I am not sitting next to someone who does that twice.'],
        ['Aria', 'Dax', 'I have immunity so this is free. Dax is the better player and I would rather cut him now than face him later.'],
        ['Dax', 'Esme', 'She refused to even be seen with me tonight. If I go home it is because of her, so she goes first.'],
    ]);

    if (!finale) {
        // Into the next round's council, so the results panel and the council
        // console are both on screen at once.
        await playRound(manager, contestCoordinator, {
            immune: 'Cleo',
            questions: [[
                'Somebody is going home tonight. Why should it not be you?',
                'Finn',
                'Because I am the only one here who has not written a name down yet, and you all know it.',
            ]],
        });
        if (suspended) await manager.control('suspend');
        return manager.view();
    }

    // A 2-2-1 tie that has to be settled on a revote.
    await playRound(manager, contestCoordinator, {
        immune: 'Cleo',
        ballots: [
            ['Aria', 'Finn', 'He skipped the last vote entirely. I am not handing the jury someone who does nothing.'],
            ['Cleo', 'Finn', 'Finn is the only one I cannot read, and I do not want to be sitting next to him at the end.'],
            ['Finn', 'Aria', 'Aria has won every challenge she needed to. She is the actual threat and everyone is too polite to say it.'],
            ['Esme', 'Aria', 'Aria cut Dax for free when she was already safe. That is who she is going to do it to next.'],
            ['Bram', 'Esme', 'I promised Aria and I promised Esme, so I am voting the one who will not find out.'],
        ],
        revote: [
            ['Cleo', 'Finn', 'Nothing changed for me on the revote. Finn still goes.'],
            ['Bram', 'Finn', 'I am not drawing rocks over this. Finn is the name that ends it tonight.'],
        ],
    });

    // Down to the final three.
    await playRound(manager, contestCoordinator, {
        immune: 'Aria',
        ballots: [
            ['Aria', 'Esme', 'Esme has a case to make to that jury and I would rather beat Bram.'],
            ['Cleo', 'Esme', 'Aria has immunity, so this is the only vote that helps me.'],
            ['Bram', 'Esme', 'She has been running the middle all game. The jury respects her and that scares me.'],
            ['Esme', 'Cleo', 'Cleo has been Aria\'s shield since the merge and nobody has said it out loud.'],
        ],
    });

    // The jury decides, and says why.
    await manager.askCouncilQuestion(
        'Why do you deserve this over the people sitting next to you?',
        ['Aria', 'Bram', 'Cleo']
    );
    await manager.handleAgentCommand('Aria', 'council-answer', {
        answer: 'I won when I had to win and I cut the biggest threat in this game while I was already safe.',
    });
    await manager.handleAgentCommand('Cleo', 'council-answer', {
        answer: 'I was in every single majority from the first vote to the last. That is not luck.',
    });
    // The same control the host's "close council" button uses.
    await manager.control('end-council');
    await castBallots(manager, [
        ['Dax', 'Aria', 'She voted me out when she did not have to, and she told me why to my face. That is the game.'],
        ['Finn', 'Cleo', 'Cleo wrote my name down twice and never once lied to me about it.'],
        ['Esme', 'Aria', 'Aria beat me. Cleo just stood next to her the whole way.'],
    ]);

    return manager.view();
}

const target = process.argv[2] || '/tmp/survivor-council.json';
const finale = process.argv.includes('--finale');
const suspended = process.argv.includes('--suspended');

build().then(async view => {
    await writeFile(target, JSON.stringify(view, null, 2));
    console.log(`wrote ${target}`);
}, error => {
    console.error(error);
    process.exit(1);
});
