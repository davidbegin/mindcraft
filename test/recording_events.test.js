import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

import { ActionManager } from '../src/agent/action_manager.js';

const recorderDependencyMocks = new Map([
    ['three', 'export class Vector3 {}; export class WebGLRenderer {}; export default { Vector3, WebGLRenderer };'],
    ['vec3', 'export class Vec3 {}'],
    ['prismarine-viewer/viewer/lib/viewer.js', 'export class Viewer {}'],
    ['prismarine-viewer/viewer/lib/worldView.js', 'export class WorldView {}'],
    ['prismarine-viewer/viewer/lib/simpleUtils.js', 'export async function getBufferFromStream() {}'],
    ['node-canvas-webgl/lib/index.js', 'export function createCanvas() {}'],
]);

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (recorderDependencyMocks.has(specifier)) {
            return {
                url: `recording-test:${encodeURIComponent(specifier)}`,
                shortCircuit: true,
            };
        }
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url.startsWith('recording-test:')) {
            const specifier = decodeURIComponent(url.slice('recording-test:'.length));
            return {
                format: 'module',
                source: recorderDependencyMocks.get(specifier),
                shortCircuit: true,
            };
        }
        return nextLoad(url, context);
    },
});

const { PovRecorder } = await import('../src/agent/vision/pov_recorder.js');

function makeRecorder({ recording = false, startedAt = 1000, syncEpochMs = null } = {}) {
    const recorder = Object.create(PovRecorder.prototype);
    recorder.recording = recording;
    recorder.startedAt = startedAt;
    recorder.syncEpochMs = syncEpochMs;
    recorder.events = [];
    recorder._audio = [];
    return recorder;
}

function makeAgent(recorder, contestRecorders = []) {
    return {
        pov_recorder: recorder,
        contest_recorders: contestRecorders,
        clearBotLogs() {},
        requestInterrupt() {},
        bot: {
            output: '',
            interrupt_code: false,
            emit() {},
            clearControlStates() {},
        },
    };
}

test('markers no-op when the recorder is inactive', () => {
    const recorder = makeRecorder();
    assert.equal(recorder.addMarker('action-start', { label: '!move' }, 1200), undefined);
    assert.deepEqual(recorder.events, []);
});

test('markers carry absolute and session-relative timestamps', () => {
    const recorder = makeRecorder({
        recording: true,
        startedAt: 1200,
        syncEpochMs: 1000,
    });

    recorder.addMarker('action-start', { label: '!move' }, 1450);
    recorder.addAudio('base64-audio', 1600);

    assert.deepEqual(recorder.events, [
        {
            type: 'action-start',
            atMs: 1450,
            offsetMs: 450,
            data: { label: '!move' },
        },
        {
            type: 'speech',
            atMs: 1600,
            offsetMs: 600,
        },
    ]);
});

test('event state resets between recordings', () => {
    const recorder = makeRecorder({ recording: true });
    recorder.addMarker('speech', null, 1100);
    assert.equal(recorder.events.length, 1);

    recorder._resetEvents();
    assert.deepEqual(recorder.events, []);
});

test('manifest entries include the collected recording events', () => {
    const recorder = makeRecorder({ recording: true, startedAt: 1000 });
    recorder.name = 'testbot';
    recorder.sourceBot = 'testbot';
    recorder.file = null;
    recorder.labels = new Set();
    recorder.sessionId = null;
    recorder.contestId = null;
    recorder.recordingRole = null;
    recorder.cameraMode = 'follow';
    recorder.frames = 2;
    recorder._voiceLines = 0;
    recorder.addMarker('speech', null, 1250);

    let manifestLine;
    const originalAppendFileSync = fs.appendFileSync;
    fs.appendFileSync = (_path, line) => { manifestLine = line; };
    try {
        recorder._finalizeClip();
    } finally {
        fs.appendFileSync = originalAppendFileSync;
    }

    const entry = JSON.parse(manifestLine);
    assert.deepEqual(entry.events, [
        { type: 'speech', atMs: 1250, offsetMs: 250 },
    ]);
});

test('actions add start and end markers to every synchronized recorder', async () => {
    const recorder = makeRecorder({ recording: true });
    const wideRecorder = makeRecorder({ recording: true });
    const manager = new ActionManager(makeAgent(recorder, [wideRecorder]));

    const result = await manager.runAction('!goToCoordinates', async () => {});

    assert.equal(result.success, true);
    assert.deepEqual(
        recorder.events.map(({ type, data }) => ({ type, data })),
        [
            {
                type: 'action-start',
                data: { label: '!goToCoordinates' },
            },
            {
                type: 'action-end',
                data: { label: '!goToCoordinates', outcome: 'success' },
            },
        ]
    );
    assert.deepEqual(wideRecorder.events, recorder.events);
});

test('failed actions add an error marker', async () => {
    const recorder = makeRecorder({ recording: true });
    const manager = new ActionManager(makeAgent(recorder));
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const result = await manager.runAction('!fail', async () => {
            throw new Error('expected failure');
        });
        assert.equal(result.success, false);
    } finally {
        console.error = originalConsoleError;
    }

    assert.deepEqual(
        recorder.events.map(({ type, data }) => ({ type, data })),
        [
            { type: 'action-start', data: { label: '!fail' } },
            {
                type: 'action-error',
                data: { label: '!fail', message: 'expected failure' },
            },
        ]
    );
});
