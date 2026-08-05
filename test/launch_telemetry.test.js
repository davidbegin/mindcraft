import assert from 'node:assert/strict';
import test from 'node:test';

import {
    attachAgentLog,
    buildCursorReport,
    captureFailureReport,
    clearLaunchTelemetry,
    getLastFailureReport,
    getLaunchEvents,
    record,
    recordError,
} from '../src/mindcraft/diagnostics/launch_telemetry.js';

test('launch telemetry ring buffer records stages and agent logs', () => {
    clearLaunchTelemetry();
    record({ stage: 'validate', message: 'ok' });
    attachAgentLog('Bob', 'spawn failed\n', 'stderr');
    recordError(new Error('boom'), { stage: 'wait_ready', agent: 'Bob' });

    const events = getLaunchEvents();
    assert.equal(events.length, 3);
    assert.equal(events[1].agent, 'Bob');
    assert.match(events[1].message, /spawn failed/);
    assert.equal(events[2].level, 'error');
});

test('buildCursorReport produces pasteable markdown and redacts secrets', () => {
    clearLaunchTelemetry();
    record({ stage: 'create_agent', agent: 'Alice', message: 'creating' });
    const report = buildCursorReport({
        error: new Error('Timed out waiting for game agents: Alice'),
        gameSession: {
            contestId: 'c1',
            sessionId: 'contest-c1',
            gameId: 'tower',
            title: 'Tower',
            status: 'failed',
            error: 'Timed out waiting for game agents: Alice',
            participantIds: ['Alice'],
            createdAgents: [{ name: 'Alice', id: 'Alice#1' }],
            progress: { stage: 'wait_ready', message: 'Waiting…', ready: 0, total: 1 },
        },
        agents: [{ name: 'Alice', registered: true, socketConnected: true, inGame: false }],
        env: {
            node: 'v22.0.0',
            platform: 'darwin',
            minecraftAddress: '127.0.0.1:55916',
            mindserverPort: 8080,
            api_key: 'should-not-appear',
        },
    });

    assert.match(report, /Paste this into Cursor/);
    assert.match(report, /Timed out waiting for game agents: Alice/);
    assert.match(report, /wait_ready/);
    assert.match(report, /\*\*Alice\*\*/);
    assert.doesNotMatch(report, /should-not-appear/);

    const captured = captureFailureReport({
        error: new Error('fail'),
        gameSession: { status: 'failed', error: 'fail', gameId: 'tower' },
    });
    assert.equal(getLastFailureReport(), captured);
});
