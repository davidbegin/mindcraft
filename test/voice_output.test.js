import assert from 'node:assert/strict';
import test from 'node:test';

import { VoiceOutput } from '../src/mindcraft/voice_output.js';

function fakeSocket() {
    return {
        connected: true,
        emitted: [],
        emit(event, payload) {
            this.emitted.push([event, payload]);
        },
    };
}

function recordingOutput(overrides = {}) {
    const played = [];
    const output = new VoiceOutput({
        playOnHost: line => played.push(line),
        ...overrides,
    });
    return { output, played };
}

test('plays every line on the host speakers with no browser attached', () => {
    const { output, played } = recordingOutput();

    output.dispatch({ agentName: 'narrator', text: 'Go!', audio: 'AUDIO' });

    assert.deepEqual(played, [{ agentName: 'narrator', text: 'Go!', audio: 'AUDIO' }]);
});

test('keeps host speakers playing even while browsers are monitoring', () => {
    const { output, played } = recordingOutput();
    const tab = fakeSocket();
    output.addMonitor(tab);

    output.dispatch({ agentName: 'billy', text: 'Digging down.', audio: 'AUDIO' });

    assert.equal(played.length, 1, 'host speakers must never be skipped');
    assert.deepEqual(tab.emitted, [
        ['bot-voice', { agentName: 'billy', text: 'Digging down.', audio: 'AUDIO' }],
    ]);
});

test('mirrors to every monitoring tab rather than only the first to ask', () => {
    const { output } = recordingOutput();
    const first = fakeSocket();
    const second = fakeSocket();
    output.addMonitor(first);
    output.addMonitor(second);

    output.dispatch({ agentName: 'narrator', text: 'billy was the winner!', audio: 'AUDIO' });

    assert.equal(first.emitted.length, 1);
    assert.equal(second.emitted.length, 1);
});

test('a tab that never opts in receives nothing but does not mute the host', () => {
    const { output, played } = recordingOutput();
    const lurker = fakeSocket();

    output.dispatch({ agentName: 'billy', text: 'Straight down.', audio: 'AUDIO' });

    assert.deepEqual(lurker.emitted, []);
    assert.equal(played.length, 1);
});

test('drops disconnected monitors without losing host playback', () => {
    const { output, played } = recordingOutput();
    const tab = fakeSocket();
    output.addMonitor(tab);
    tab.connected = false;

    output.dispatch({ agentName: 'billy', text: 'Still talking.', audio: 'AUDIO' });

    assert.equal(output.monitorCount(), 0);
    assert.deepEqual(tab.emitted, []);
    assert.equal(played.length, 1);
});

test('a throwing monitor cannot stop other outputs', () => {
    const errors = [];
    const { output, played } = recordingOutput({ onError: error => errors.push(error.message) });
    const broken = fakeSocket();
    broken.emit = () => { throw new Error('socket gone'); };
    const healthy = fakeSocket();
    output.addMonitor(broken);
    output.addMonitor(healthy);

    output.dispatch({ agentName: 'narrator', text: 'Go!', audio: 'AUDIO' });

    assert.equal(played.length, 1);
    assert.equal(healthy.emitted.length, 1);
    assert.deepEqual(errors, ['socket gone']);
});

test('a failing host device still lets monitors hear the line', () => {
    const errors = [];
    const output = new VoiceOutput({
        playOnHost: () => { throw new Error('no audio device'); },
        onError: error => errors.push(error.message),
    });
    const tab = fakeSocket();
    output.addMonitor(tab);

    output.dispatch({ agentName: 'narrator', text: 'Go!', audio: 'AUDIO' });

    assert.equal(tab.emitted.length, 1);
    assert.deepEqual(errors, ['no audio device']);
});

test('removeMonitor stops mirroring to that tab', () => {
    const { output } = recordingOutput();
    const tab = fakeSocket();
    output.addMonitor(tab);
    output.removeMonitor(tab);

    output.dispatch({ agentName: 'billy', text: 'Quiet tab.', audio: 'AUDIO' });

    assert.deepEqual(tab.emitted, []);
});

test('ignores lines that have no audio', () => {
    const { output, played } = recordingOutput();

    output.dispatch({ agentName: 'billy', text: 'No audio', audio: null });

    assert.deepEqual(played, []);
});

test('requires a host playback function', () => {
    assert.throws(() => new VoiceOutput({}), TypeError);
});
