import assert from 'node:assert/strict';
import test from 'node:test';

import {
    allowBot,
    clearBotVolumes,
    clearSpeechQueue,
    getBotVolume,
    getMuteMode,
    getSpeechQueueDepth,
    isBotSilenced,
    playSpeech,
    setBotVolume,
    setMuteMode,
    setSpeechLagLimits,
    silenceBot,
} from '../src/agent/speak.js';
import { getVoiceHealth, resetVoiceHealth } from '../src/agent/tts_health.js';

// Audio is supplied directly so these tests never reach a TTS provider. A line
// that reaches playback records a failure against the bot that owns it, which is
// how we can tell which queued lines the queue actually got to.
function queueLine(botName, audioPromise) {
    playSpeech({ text: `${botName} says something.`, model: 'elevenlabs', botName, audioPromise });
}

function settle(ms = 50) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test.afterEach(() => {
    clearSpeechQueue();
    setMuteMode('off');
    clearBotVolumes();
    setSpeechLagLimits({ maxAgeMs: 20_000, maxQueue: 8 });
    for (const name of ['chip', 'kimmy', 'billy']) allowBot(name);
    resetVoiceHealth();
});

test('a bot that left the game is not voiced at all', async () => {
    resetVoiceHealth();
    silenceBot('billy');
    assert.equal(isBotSilenced('billy'), true);

    queueLine('billy', Promise.reject(new Error('billy audio failed')));
    await settle();

    assert.equal(
        getVoiceHealth().failureCount,
        0,
        'a silenced line must be dropped before playback, not merely muted'
    );

    allowBot('billy');
    assert.equal(isBotSilenced('billy'), false);
});

test('flushing one bot does not stall the lines queued behind it', async () => {
    resetVoiceHealth();
    let releaseChip;
    queueLine('chip', new Promise(resolve => { releaseChip = resolve; }));
    queueLine('kimmy', Promise.reject(new Error('kimmy audio failed')));

    // Chip is out while his line is still generating: the queue has to move on
    // to Kimmy instead of waiting on audio nobody will ever hear.
    silenceBot('chip');
    releaseChip('AUDIO');
    await settle();

    assert.equal(getVoiceHealth().lastFailure?.botName, 'kimmy');
});

test('flushing one bot leaves the rest of the cast speakable', () => {
    silenceBot('chip');

    assert.equal(isBotSilenced('chip'), true);
    assert.equal(isBotSilenced('kimmy'), false);
});

test('a line that was already generating is dropped once its bot is silenced', async () => {
    resetVoiceHealth();
    let releaseChip;
    queueLine('chip', new Promise(resolve => { releaseChip = resolve; }));

    // Chip spoke before the match ended; TTS was still in flight when the
    // ceremony cleared the cast. The finished audio must not play afterward.
    silenceBot('chip');
    releaseChip('AUDIO');
    await settle();

    assert.equal(getVoiceHealth().failureCount, 0);
    assert.equal(isBotSilenced('chip'), true);
});

test('hard mute drops enqueue and soft mute keeps generating without playing', async () => {
    resetVoiceHealth();
    setMuteMode('hard');
    assert.equal(getMuteMode(), 'hard');
    queueLine('chip', Promise.reject(new Error('should never play')));
    await settle();
    assert.equal(getSpeechQueueDepth(), 0);
    assert.equal(getVoiceHealth().failureCount, 0);

    setMuteMode('soft');
    assert.equal(getMuteMode(), 'soft');
    let release;
    queueLine('kimmy', new Promise(resolve => { release = resolve; }));
    assert.equal(getSpeechQueueDepth(), 1);
    release('AUDIO');
    await settle(80);
    // Soft mute must not start playback, so the failed-playback probe stays quiet
    // and the line remains queued for catch-up.
    assert.equal(getVoiceHealth().failureCount, 0);
    assert.equal(getSpeechQueueDepth(), 1);

    setMuteMode('off');
});

test('queue depth cap drops the oldest backlog', () => {
    setMuteMode('soft'); // hold lines without playing
    setSpeechLagLimits({ maxQueue: 2 });
    queueLine('chip', Promise.resolve('A'));
    queueLine('kimmy', Promise.resolve('B'));
    queueLine('billy', Promise.resolve('C'));
    assert.equal(getSpeechQueueDepth(), 2);
});

test('aged-out lines are dropped instead of playing late', async () => {
    resetVoiceHealth();
    setMuteMode('soft');
    setSpeechLagLimits({ maxAgeMs: 5 });
    let release;
    queueLine('chip', new Promise(resolve => { release = resolve; }));
    assert.equal(getSpeechQueueDepth(), 1);
    await settle(20);
    release('AUDIO');
    setMuteMode('off');
    await settle(80);
    assert.equal(getSpeechQueueDepth(), 0);
    assert.equal(
        getVoiceHealth().failureCount,
        0,
        'aged-out audio must be discarded, not played'
    );
});

test('per-bot volume 0 quietens one cast member and clears their backlog', async () => {
    resetVoiceHealth();
    setMuteMode('soft');
    queueLine('chip', Promise.resolve('AUDIO'));
    queueLine('kimmy', Promise.resolve('AUDIO'));
    assert.equal(getSpeechQueueDepth(), 2);

    assert.equal(setBotVolume('chip', 0), 0);
    assert.equal(getBotVolume('chip'), 0);
    assert.equal(getBotVolume('kimmy'), 100);
    // Chip's backlog is flushed; Kimmy stays queued.
    assert.equal(getSpeechQueueDepth(), 1);

    setMuteMode('off');
    await settle(80);
    // Kimmy still reaches the failure probe (ffplay missing / bad audio), chip does not.
    assert.notEqual(getVoiceHealth().lastFailure?.botName, 'chip');
});
