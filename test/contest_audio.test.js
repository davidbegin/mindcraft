import assert from 'node:assert/strict';
import test from 'node:test';

import { addContestAudioToRecorders } from '../src/agent/contest_audio.js';

function recorder(sessionId, recording = true) {
    return {
        sessionId,
        recording,
        audio: [],
        addAudio(data, atMs) {
            this.audio.push({ data, atMs });
        },
    };
}

test('adds each contest voice line to the POV and every overview camera', () => {
    const recorders = [
        recorder('contest-1'),
        recorder('contest-1'),
        recorder('contest-1'),
    ];

    const added = addContestAudioToRecorders(recorders, 'contest-1', {
        sessionId: 'contest-1',
        speaker: 'alice',
        audio: 'base64-audio',
        atMs: 123456,
    });

    assert.equal(added, 3);
    for (const target of recorders) {
        assert.deepEqual(target.audio, [{ data: 'base64-audio', atMs: 123456 }]);
    }
});

test('does not leak audio into another session or an inactive recorder', () => {
    const current = recorder('contest-1');
    const oldSession = recorder('contest-old');
    const stopped = recorder('contest-1', false);

    assert.equal(addContestAudioToRecorders(
        [current, oldSession, stopped],
        'contest-1',
        { sessionId: 'contest-2', audio: 'wrong-session', atMs: 100 }
    ), 0);
    assert.equal(addContestAudioToRecorders(
        [current, oldSession, stopped],
        'contest-1',
        { sessionId: 'contest-1', audio: 'right-session', atMs: 200 }
    ), 1);

    assert.deepEqual(current.audio, [{ data: 'right-session', atMs: 200 }]);
    assert.deepEqual(oldSession.audio, []);
    assert.deepEqual(stopped.audio, []);
});
