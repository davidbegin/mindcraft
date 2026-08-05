import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendSystemPromptAddendum } from '../src/models/prompter.js';
import { ContestCoordinator } from '../src/mindcraft/contest/contest_coordinator.js';
import {
    GameSessionManager,
    validateGameParticipants,
} from '../src/mindcraft/contest/game_session_manager.js';
import {
    filterRecordingManifest,
    serializeRecordingManifest,
} from '../src/mindcraft/contest/recording_exports.js';
import {
    buildGameSystemPrompt,
    buildParticipantGameDirective,
} from '../src/mindcraft/contest/game_content.js';

const profiles = [
    {
        id: 'fast',
        name: 'fast',
        model: 'model-fast',
        provider: 'cursor',
        configured: true,
        profile: { name: 'fast', model: 'model-fast' },
    },
    {
        id: 'smart',
        name: 'smart',
        model: 'model-smart',
        provider: 'cursor',
        configured: true,
        profile: { name: 'smart', model: 'model-smart' },
    },
];

const preset = {
    id: 'tower',
    title: 'Tower',
    prompt: 'Build the tallest tower.',
    durationMs: 60_000,
    rules: { metrics: [], winItem: 'diamond' },
    metadata: {},
};

async function withManager(run, overrides = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-game-session-'));
    const calls = [];
    try {
        const coordinator = await ContestCoordinator.create({
            root,
            idFactory: () => 'game-1',
        });
        const manager = new GameSessionManager({
            coordinator,
            getPreset: () => preset,
            getProfiles: () => profiles,
            getExistingAgentNames: () => ['colony_bot'],
            buildAgentSettings: (profile, gameSession) => ({ profile, game_session: gameSession }),
            createAgent: async settings => {
                calls.push(['create', settings]);
                return { success: true };
            },
            destroyAgent: async name => calls.push(['destroy', name]),
            isAgentReady: () => true,
            prepareArena: async (_game, participants) => {
                calls.push(['arena', participants]);
                return { center: { x: 1, y: 2, z: 3 } };
            },
            startRecording: async options => {
                calls.push(['record-start', options]);
                return { sessionId: `contest-${options.contestId}`, cameraCount: 4 };
            },
            stopRecording: async contestId => calls.push(['record-stop', contestId]),
            sendDirective: async (name, prompt) => calls.push(['directive', name, prompt]),
            ...overrides,
        });
        await run({ manager, coordinator, calls });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('provisions isolated agents, records, directs, and cleans up after completion', async () => {
    await withManager(async ({ manager, coordinator, calls }) => {
        const result = await manager.start({
            gameId: 'tower',
            participants: [
                { profileId: 'fast', name: 'speedy', voice: 'Trickster' },
                { profileId: 'smart', name: 'thinker' },
            ],
            systemPrompt: 'Be entertaining.',
        });

        assert.equal(result.contest.status, 'running');
        assert.equal(manager.view().recording.enabled, true);
        assert.deepEqual(
            calls.filter(([type]) => type === 'directive').map(([, name]) => name),
            ['speedy', 'thinker']
        );
        const createdSettings = calls.find(([type]) => type === 'create')[1];
        assert.equal(createdSettings.game_session.systemPrompt, 'Be entertaining.');
        assert.deepEqual(createdSettings.game_session.participantIds, ['speedy', 'thinker']);
        assert.deepEqual(createdSettings.game_session.rivalIds, ['thinker']);
        assert.equal(createdSettings.game_session.winItem, 'diamond');
        assert.equal(createdSettings.game_session.voice, 'Trickster');
        assert.equal(createdSettings.profile.name, 'speedy');
        assert.deepEqual(createdSettings.profile.speak_model, {
            api: 'elevenlabs',
            voice: 'Trickster',
        });
        assert.equal(manager.view().participants[0].voice, 'Trickster');
        const speedyDirective = calls.find(
            ([type, name]) => type === 'directive' && name === 'speedy'
        )[2];
        assert.match(speedyDirective, /COMPETITORS: speedy, thinker/);
        assert.match(speedyDirective, /Your rivals are thinker/);

        await coordinator.submit('game-1', 'speedy', {});
        await coordinator.submit('game-1', 'thinker', {});
        await manager.syncWithContestView(coordinator.view());

        assert.equal(manager.view(), null);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy').map(([, name]) => name),
            ['speedy', 'thinker']
        );
        const stopIndex = calls.findIndex(([type]) => type === 'record-stop');
        const destroyIndex = calls.findIndex(([type]) => type === 'destroy');
        assert.ok(stopIndex < destroyIndex, 'recording stops before temporary agents are destroyed');
    });
});

test('rolls back agents and cancels the draft after partial startup failure', async () => {
    let attempts = 0;
    await withManager(async ({ manager, coordinator, calls }) => {
        await assert.rejects(
            manager.start({
                gameId: 'tower',
                participants: [
                    { profileId: 'fast', name: 'speedy' },
                    { profileId: 'smart', name: 'thinker' },
                ],
            }),
            /provider unavailable/
        );

        assert.equal(coordinator.snapshot().contests['game-1'].status, 'cancelled');
        assert.equal(manager.view(), null);
        assert.deepEqual(
            calls.filter(([type]) => type === 'destroy').map(([, name]) => name),
            ['speedy']
        );
    }, {
        createAgent: async settings => {
            attempts += 1;
            if (attempts === 2) return { success: false, error: 'provider unavailable' };
            return { success: true, settings };
        },
    });
});

test('participant validation rejects catalog, name, and collision errors', () => {
    assert.throws(
        () => validateGameParticipants([{ profileId: 'missing', name: 'valid_name' }], profiles),
        /Unknown model profile/
    );
    assert.throws(
        () => validateGameParticipants([{ profileId: 'fast', name: 'x' }], profiles),
        /3-16/
    );
    assert.throws(
        () => validateGameParticipants([{ profileId: 'fast', name: 'colony_bot' }], profiles, ['colony_bot']),
        /already in use/
    );
    assert.throws(
        () => validateGameParticipants([
            { profileId: 'fast', name: 'valid_name', voice: 'v'.repeat(129) },
        ], profiles),
        /voice must be 128/
    );
});

test('system addendum remains separate and optional', () => {
    assert.equal(appendSystemPromptAddendum('Base prompt', ''), 'Base prompt');
    assert.equal(
        appendSystemPromptAddendum('Base prompt', '  Be dramatic.  '),
        'Base prompt\n\nGAME SESSION SYSTEM ADDENDUM\nBe dramatic.'
    );
});

test('game content prompt requires audible, playful competitive banter', () => {
    const prompt = buildGameSystemPrompt('Use pirate slang.');
    assert.match(prompt, /Keep speaking/);
    assert.match(prompt, /current strategy/);
    assert.match(prompt, /trash/);
    assert.match(prompt, /!startConversation/);
    assert.match(prompt, /every rival/);
    assert.match(prompt, /no slurs/);
    assert.match(prompt, /SESSION-SPECIFIC ADDENDUM\nUse pirate slang\./);
});

test('participant game directives identify every rival and require strategy talk', () => {
    const directive = buildParticipantGameDirective(
        'Find a diamond.',
        ['speedy', 'thinker', 'miner'],
        'thinker'
    );
    assert.match(directive, /COMPETITORS: speedy, thinker, miner/);
    assert.match(directive, /Your rivals are speedy, miner/);
    assert.match(directive, /narrating your strategy/);
    assert.match(directive, /!startConversation/);
    assert.doesNotMatch(directive, /Your rivals are .*thinker/);
});

test('recording manifests filter by session without unrelated clips', () => {
    const text = [
        JSON.stringify({ file: '/a.mp4', sessionId: 'contest-game-1', contestId: 'game-1', startedAt: 10, endedAt: 20 }),
        JSON.stringify({ file: '/b.mp4', sessionId: null, contestId: null, startedAt: 15, endedAt: 25 }),
        '{broken',
    ].join('\n');

    const entries = filterRecordingManifest(text, { session: 'game-1' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].file, '/a.mp4');
    assert.match(serializeRecordingManifest(entries), /contest-game-1/);
});
