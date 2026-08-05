import assert from 'node:assert/strict';
import test from 'node:test';
import { Vec3 } from 'vec3';
import { ActionRecorder } from '../src/agent/vision/action_recorder.js';

function makeFakeRecorder() {
    let clipCounter = 0;
    return {
        recording: false,
        file: null,
        error: null,
        labels: [],
        startCalls: 0,
        stopCalls: 0,
        async start({ label } = {}) {
            this.startCalls++;
            if (this.error) return { recording: false, error: this.error };
            this.recording = true;
            this.file = `/tmp/clip-${++clipCounter}.mp4`;
            this.labels = label ? [label] : [];
            return { recording: true, file: this.file };
        },
        addLabel(label) {
            if (!this.labels.includes(label)) this.labels.push(label);
        },
        async stop() {
            this.stopCalls++;
            this.recording = false;
            return { recording: false, file: this.file };
        },
    };
}

function makeFakeAgent() {
    return {
        name: 'testbot',
        actions: { executing: false, currentActionLabel: '' },
        bot: {
            entity: { position: new Vec3(0, 64, 0) },
            targetDigBlock: null,
            output: '',
            getControlState() { return false; },
        },
    };
}

function setup() {
    const agent = makeFakeAgent();
    const recorder = makeFakeRecorder();
    const auto = new ActionRecorder(agent, recorder);
    return { agent, recorder, auto };
}

test('does not record a stationary bot even while an action executes', async () => {
    const { agent, recorder, auto } = setup();
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!stay';
    for (let i = 0; i < 5; i++) await auto._tick();
    assert.equal(recorder.startCalls, 0);
});

test('does not record a moving bot with no action executing', async () => {
    const { agent, recorder, auto } = setup();
    await auto._tick();
    agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
    await auto._tick();
    assert.equal(recorder.startCalls, 0);
});

test('starts a labeled clip when the bot moves during an action', async () => {
    const { agent, recorder, auto } = setup();
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!goToCoordinates';
    await auto._tick(); // establishes baseline position
    agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
    await auto._tick();
    assert.equal(recorder.startCalls, 1);
    assert.ok(recorder.recording);
    assert.deepEqual(recorder.labels, ['!goToCoordinates']);
});

test('stationary digging counts as activity', async () => {
    const { agent, recorder, auto } = setup();
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!collectBlocks';
    agent.bot.targetDigBlock = { name: 'stone' };
    await auto._tick();
    assert.equal(recorder.startCalls, 1);
});

test('collects every action label performed during one clip', async () => {
    const { agent, recorder, auto } = setup();
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!goToCoordinates';
    await auto._tick();
    agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
    await auto._tick();
    agent.actions.currentActionLabel = '!collectBlocks';
    agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
    await auto._tick();
    assert.deepEqual(recorder.labels, ['!goToCoordinates', '!collectBlocks']);
});

test('stops and saves once the bot has been still past the grace period', async () => {
    const { agent, recorder, auto } = setup();
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!goToCoordinates';
    await auto._tick();
    agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
    await auto._tick();
    assert.ok(recorder.recording);

    // Bot goes still; not stopped yet inside the grace window.
    await auto._tick();
    assert.equal(recorder.stopCalls, 0);

    // Backdate the last activity beyond the grace period.
    auto._lastActiveAt = Date.now() - 60000;
    await auto._tick();
    assert.equal(recorder.stopCalls, 1);
    assert.ok(!recorder.recording);
});

test('never stops a recording it did not start (manual UI recording)', async () => {
    const { recorder, auto } = setup();
    recorder.recording = true;
    recorder.file = '/tmp/manual.mp4';
    auto._lastActiveAt = Date.now() - 60000;
    await auto._tick();
    assert.equal(recorder.stopCalls, 0);
    assert.ok(recorder.recording);
});

test('disarm finishes its own in-flight clip but rearm forgives failures', async () => {
    const { agent, recorder, auto } = setup();
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!goToCoordinates';
    await auto._tick();
    agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
    await auto._tick();
    assert.ok(recorder.recording);

    await auto.disarm();
    assert.equal(recorder.stopCalls, 1, 'disarm must save the clip it started');
    assert.ok(!auto.armed);

    auto._failures = 3;
    auto._disarmed = true;
    auto.arm();
    assert.ok(auto.armed, 'explicit rearm must clear the disarmed state');
    assert.equal(auto._failures, 0);
    auto.stop();
});

test('disarms after repeated failed clips instead of retrying forever', async () => {
    const { agent, recorder, auto } = setup();
    recorder.error = 'ffmpeg is not installed or not on PATH';
    agent.actions.executing = true;
    agent.actions.currentActionLabel = '!goToCoordinates';
    auto.start();
    try {
        for (let i = 0; i < 6; i++) {
            agent.bot.entity.position = agent.bot.entity.position.offset(3, 0, 0);
            await auto._tick();
        }
        assert.equal(recorder.startCalls, 3);
        assert.equal(auto._interval, null, 'recorder should disarm itself');
    } finally {
        auto.stop();
    }
});
