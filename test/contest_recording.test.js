import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestRecordingManager,
    overviewCameras,
    participantWideCamera,
} from '../src/mindcraft/contest/contest_recording.js';

const arena = {
    center: { x: 100000, y: 100, z: 100000 },
};

test('starts close and wide participant cameras plus two overviews on one observer', async () => {
    const calls = [];
    const manager = new ContestRecordingManager({
        clock: () => 123456,
        requestAgent: async (agentName, event, options) => {
            calls.push({ agentName, event, options });
            return { success: true };
        },
    });

    const session = await manager.start({
        contestId: 'contest-1',
        participants: ['alice', 'bob', 'charlie'],
        arena,
    });

    assert.equal(session.sessionId, 'contest-contest-1');
    assert.equal(session.syncEpochMs, 123456);
    assert.equal(session.cameraCount, 8);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.externalCameras.length, 3);
    assert.equal(calls[1].options.externalCameras.length, 1);
    assert.equal(calls[2].options.externalCameras.length, 1);
    assert.deepEqual(
        calls.map(call => call.options.externalCameras[0].recordingRole),
        ['participant-wide', 'participant-wide', 'participant-wide']
    );
    assert.equal(
        new Set(calls.map(call => call.options.externalCameras[0].id)).size,
        3,
        'wide recording folders are unique per participant'
    );
    assert.ok(calls.every(call => call.options.syncEpochMs === 123456));
});

test('keeps the session alive when a participant cannot record', async () => {
    const calls = [];
    const manager = new ContestRecordingManager({
        requestAgent: async (agentName, event) => {
            calls.push({ agentName, event });
            if (event === 'start-contest-recording' && agentName === 'bob') {
                return { success: false, error: 'ffmpeg missing' };
            }
            return { success: true };
        },
    });

    const session = await manager.start({
        contestId: 'contest-1',
        participants: ['alice', 'bob'],
        arena,
    });

    assert.deepEqual(session.failures, [{ agentName: 'bob', error: 'ffmpeg missing' }]);
    assert.deepEqual(session.participants, ['alice']);
    assert.deepEqual(session.requestedParticipants, ['alice', 'bob']);
    assert.equal(session.observer, 'alice');
    // alice keeps her POV, her wide follow, and both arena overviews.
    assert.equal(session.cameraCount, 4);
    assert.ok(manager.active, 'the match records with the angles that came up');
});

test('releases a half-started recorder without making the launch wait', async () => {
    const calls = [];
    let releaseStop;
    const stopped = new Promise(resolve => { releaseStop = resolve; });
    const manager = new ContestRecordingManager({
        requestAgent: async (agentName, event) => {
            calls.push({ agentName, event });
            if (event === 'start-contest-recording' && agentName === 'bob') {
                throw new Error('start-contest-recording timed out for bob');
            }
            if (event === 'stop-contest-recording') {
                releaseStop();
                // A stop that never settles must not hold up the match.
                return new Promise(() => {});
            }
            return { success: true };
        },
    });

    const session = await manager.start({
        contestId: 'contest-1',
        participants: ['alice', 'bob'],
        arena,
    });

    assert.match(session.failures[0].error, /timed out for bob/);
    await stopped;
    assert.deepEqual(
        calls.filter(call => call.event === 'stop-contest-recording'),
        [{ agentName: 'bob', event: 'stop-contest-recording' }]
    );
});

test('drops the observer role when the observer loses its cameras', async () => {
    const manager = new ContestRecordingManager({
        requestAgent: async (agentName) => (agentName === 'alice'
            ? { success: false, error: 'renderer failed' }
            : { success: true }),
    });

    const session = await manager.start({
        contestId: 'contest-1',
        participants: ['alice', 'bob'],
        arena,
    });

    assert.equal(session.observer, null);
    assert.deepEqual(session.participants, ['bob']);
    assert.equal(session.cameraCount, 2);
});

test('overview cameras frame the same arena from opposite corners', () => {
    const cameras = overviewCameras(arena);
    assert.equal(cameras.length, 2);
    assert.deepEqual(cameras[0].target, cameras[1].target);
    assert.ok(cameras[0].position.x > arena.center.x);
    assert.ok(cameras[1].position.x < arena.center.x);
    assert.ok(cameras[0].position.z > arena.center.z);
    assert.ok(cameras[1].position.z < arena.center.z);
});

test('wide participant camera uses the requested contextual follow geometry', () => {
    const camera = participantWideCamera('alice');
    assert.equal(camera.id, 'alice-wide-follow');
    assert.equal(camera.camera, 'follow');
    assert.equal(camera.recordingRole, 'participant-wide');
    assert.equal(camera.followDistance, 12);
    assert.equal(camera.followHeight, 4);
    assert.equal(camera.fps, 20);
    assert.equal(camera.width, 854);
    assert.equal(camera.height, 480);
});
