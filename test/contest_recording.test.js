import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ContestRecordingManager,
    overviewCameras,
} from '../src/mindcraft/contest/contest_recording.js';

const arena = {
    center: { x: 100000, y: 100, z: 100000 },
};

test('starts every participant POV plus two overview cameras on one observer', async () => {
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
    assert.equal(session.cameraCount, 5);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].options.externalCameras.length, 2);
    assert.equal(calls[1].options.externalCameras.length, 0);
    assert.equal(calls[2].options.externalCameras.length, 0);
    assert.ok(calls.every(call => call.options.syncEpochMs === 123456));
});

test('stops all recordings when any participant cannot record', async () => {
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

    await assert.rejects(
        manager.start({
            contestId: 'contest-1',
            participants: ['alice', 'bob'],
            arena,
        }),
        /bob: ffmpeg missing/
    );
    assert.equal(
        calls.filter(call => call.event === 'stop-contest-recording').length,
        2
    );
    assert.equal(manager.active, null);
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
