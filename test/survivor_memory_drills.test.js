// Four repeatable drills that answer one question: does the briefing change play?
//
// Each drill plants a specific fact in exactly one briefing source, then reads
// back whether the bot's own stated reason reproduced it. The bots here are
// scripted rather than live, which is the point: the drill measures the wiring
// (does the fact reach the bot, and does the probe see it when the bot uses it),
// so a live-cast run has a known-good baseline to be compared against.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    attributeReason,
    collectBriefingFacts,
} from '../src/mindcraft/survivor/survivor_memory_probe.js';
import { createManager, openPrivateRoom, participants } from './helpers/survivor_harness.js';

// Every drill needs a merged four-player tribe sitting in strategy with one
// immunity winner, which is the smallest board that still has a real vote.
async function seasonAtStrategy() {
    const harness = await createManager();
    const { manager, contestCoordinator } = harness;
    await manager.start({
        participants: participants(4),
        mergeAt: 4,
        finalistCount: 2,
        challengeGameIds: ['cake_race'],
    });
    contestCoordinator.completeCurrent(manager, 'Bot1');
    await manager.syncContestView(contestCoordinator.view());
    assert.equal(harness.coordinator.view().phase, 'strategy');
    return harness;
}

async function answerCouncil(manager, prompt, answers) {
    await manager.control('council-question', {
        prompt,
        targetIds: Object.keys(answers),
    });
    for (const [playerId, answer] of Object.entries(answers)) {
        await manager.handleAgentCommand(playerId, 'council-answer', { answer });
    }
}

test('drill: a council answer flips a declared target and the flip is attributable', async () => {
    const { manager, coordinator } = await seasonAtStrategy();
    await manager.control('open-council');

    // The plant: Bot3 confesses something on the mat that only exists in the
    // public council record. Nothing about it is in any private room.
    await answerCouncil(manager, 'Who is running this game?', {
        Bot3: 'I have been steering the numbers with a hidden pact since the marooning.',
        Bot2: 'I am just playing my own game.',
    });
    await manager.control('end-council');
    assert.equal(coordinator.view().phase, 'reevaluation');

    // Before: Bot2 is leaning at Bot4 for reasons that have nothing to do with council.
    await manager.handleAgentCommand('Bot2', 'declare-leaning', {
        targetId: 'Bot4',
        reason: 'Bot4 is the weakest in challenges and nobody will miss him.',
    });
    // After: Bot2 writes down Bot3 instead, quoting the mat.
    await manager.control('advance');
    await manager.handleAgentCommand('Bot2', 'cast-vote', {
        targetId: 'Bot3',
        reason: 'Bot3 admitted steering the numbers with a hidden pact. That changes tonight.',
    });

    const proof = manager.view().memoryProof;
    assert.equal(proof.declaredLeanings, 1);
    assert.equal(proof.ballotsCast, 1);
    assert.deepEqual(proof.flips, [{
        playerId: 'Bot2',
        from: 'Bot4',
        to: 'Bot3',
        citedCouncil: true,
    }]);
    // The leaning came before council mattered, so it should not read as council-driven.
    assert.equal(proof.leaningUse.bySource.council.echoed, 0);
    assert.equal(proof.ballotUse.bySource.council.echoed, 1);
});

test('drill: a refusal is remembered and shows up as private-source evidence', async () => {
    const { manager } = await seasonAtStrategy();

    await openPrivateRoom(manager, 'Bot2', ['Bot3'], {
        pitch: 'lets work together',
        declineIds: ['Bot3'],
        reason: 'I do not trust you after the challenge.',
    });

    // The refusal is private history for Bot2 and for nobody else.
    const facts = manager._attributeReason(
        'Bot2',
        'Bot3 refused to even talk to me and said he does not trust me, so he goes.'
    );
    assert.equal(facts.sources.private.available, true);
    assert.equal(facts.sources.private.echoed, true);
    assert.ok(facts.echoedSources.includes('private'));

    // A bot who was never in that exchange has no such fact to echo.
    const bystander = manager._attributeReason(
        'Bot4',
        'Bot3 refused to even talk to me and said he does not trust me, so he goes.'
    );
    assert.equal(bystander.sources.private.available, false);
    assert.equal(bystander.sources.private.echoed, false);
});

test('drill: a private deal is honoured publicly and the ballot cites the room', async () => {
    const { manager, coordinator } = await seasonAtStrategy();

    await openPrivateRoom(manager, 'Bot2', ['Bot4'], { pitch: 'final two' });
    await manager.handleAgentCommand('Bot2', 'room-send', {
        message: 'We take out Bot3 tonight and you and I ride to the final two together.',
    });

    await manager.control('open-council');
    await manager.control('end-council');
    assert.equal(coordinator.view().phase, 'reevaluation');
    await manager.control('advance');

    await manager.handleAgentCommand('Bot4', 'cast-vote', {
        targetId: 'Bot3',
        reason: 'I promised Bot2 we would take out Bot3 tonight and ride to the final two.',
    });

    const proof = manager.view().memoryProof;
    const report = proof.bySource.Bot4;
    assert.equal(report.sources.private.echoed, true, 'the deal is traceable to the room');
    // Bot3 was never in that room, so the same words are not private evidence for him.
    assert.equal(
        manager._attributeReason('Bot3', 'I promised Bot2 we would take out Bot3 tonight.')
            .sources.private.available,
        false
    );
});

test('drill: a juror is named the whole way to the jury vote and can cite being cut', async () => {
    const { manager, coordinator, spoken } = await seasonAtStrategy();

    await manager.control('open-council');
    await manager.control('end-council');
    await manager.control('advance');
    for (const voter of ['Bot1', 'Bot2', 'Bot4']) {
        await manager.handleAgentCommand(voter, 'cast-vote', {
            targetId: 'Bot3',
            reason: 'Numbers.',
        });
    }
    await manager.handleAgentCommand('Bot3', 'cast-vote', {
        targetId: 'Bot2',
        reason: 'Numbers.',
    });
    await manager.control('reveal-votes');

    const game = coordinator.view();
    assert.ok(game.juryIds.includes('Bot3'), 'the booted player joins the jury');
    // The bench is named out loud the moment it exists, not only at the finale.
    assert.ok(
        spoken.some(line =>
            line.speaker === 'narrator' && /jury/i.test(line.text) && line.text.includes('Bot3')
        ),
        'the host names the jury after the boot'
    );

    // Bot3 now sits on the jury and can point at the ballot that cut him, which
    // is vote-history evidence rather than vague resentment.
    const facts = collectBriefingFacts(coordinator.view(), 'Bot3', {
        privateLog: manager.secretEventLog,
    });
    const report = attributeReason(
        'Bot1, Bot2 and Bot4 all wrote my name down, so they owe me an answer for it.',
        facts
    );
    assert.equal(report.sources.votes.available, true);
    assert.equal(report.sources.votes.echoed, true);
    assert.ok(report.sources.jury.available, 'the jury roster is in his briefing');
});

test('vocabulary alone is not counted as reading the briefing', async () => {
    const { manager, coordinator } = await seasonAtStrategy();
    await manager.control('open-council');
    await answerCouncil(manager, 'Who is running this game?', {
        Bot3: 'I have been steering the numbers with a hidden pact since the marooning.',
    });
    await manager.control('end-council');
    await manager.control('advance');

    // Says "council" and "jury" without reproducing a single thing from either.
    await manager.handleAgentCommand('Bot2', 'cast-vote', {
        targetId: 'Bot3',
        reason: 'Council was interesting and the jury will understand my move.',
    });

    const report = manager.view().memoryProof.bySource.Bot2;
    assert.equal(report.sources.council.cued, true);
    assert.equal(report.sources.council.echoed, false, 'saying the word is not reading the record');
    assert.ok(report.ignoredSources.includes('council'));
    assert.equal(coordinator.view().phase, 'voting');
});

test('the relationship graph stays with the operator and never reaches a bot', async () => {
    const { manager, directives } = await seasonAtStrategy();
    await openPrivateRoom(manager, 'Bot2', ['Bot4'], { pitch: 'final two' });
    await manager.handleAgentCommand('Bot2', 'room-send', { message: 'we go to the end' });

    // The operator sees scored relationships.
    const relationships = manager.view().relationships;
    assert.ok(relationships, 'the dashboard has a relationship graph');

    // No bot is handed those scores. Until a drill shows bots need them, the
    // graph is a read on play, not an input to it.
    const briefing = manager.briefingFor('Bot2');
    assert.ok(briefing.includes('YOUR PRIVATE HISTORY'), 'it still has its own memory');
    assert.doesNotMatch(briefing, /trust|score|relationship graph/i);
    for (const directive of directives) {
        assert.doesNotMatch(directive.prompt, /relationship (score|graph)/i);
    }
});

test('a leaning is not a ballot and stays inside the legal target list', async () => {
    const { manager, coordinator } = await seasonAtStrategy();
    await manager.control('open-council');
    await manager.control('end-council');

    await assert.rejects(
        manager.handleAgentCommand('Bot2', 'declare-leaning', { targetId: 'Bot1' }),
        /not a legal target/,
        'the immunity winner cannot be leaned on'
    );
    await manager.handleAgentCommand('Bot2', 'declare-leaning', {
        targetId: 'Bot3',
        reason: 'gut call',
    });
    // A leaning must not put a ballot in the box or move the phase along.
    assert.equal(coordinator.view().phase, 'reevaluation');
    assert.equal(manager.view().memoryProof.ballotsCast, 0);

    await manager.control('advance');
    await assert.rejects(
        manager.handleAgentCommand('Bot2', 'declare-leaning', { targetId: 'Bot3' }),
        /only declared during reevaluation/
    );
});
