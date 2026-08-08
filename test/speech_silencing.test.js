import assert from 'node:assert/strict';
import test from 'node:test';

import { allowBot, clearSpeechQueue, isBotSilenced, playSpeech, silenceBot } from '../src/agent/speak.js';
import { getVoiceHealth, resetVoiceHealth } from '../src/agent/tts_health.js';

// Audio is supplied directly so these tests never reach a TTS provider. A line
// that reaches playback records a failure against the bot that owns it, which is
// how we can tell which queued lines the queue actually got to.
function queueLine(botName, audioPromise) {
    playSpeech({ text: `${botName} says something.`, model: 'elevenlabs', botName, audioPromise });
}

function settle() {
    return new Promise(resolve => setTimeout(resolve, 50));
}

test.afterEach(() => {
    clearSpeechQueue();
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
