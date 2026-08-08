import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    attachAgentLog,
    buildCursorReport,
    captureFailureReport,
    clearLaunchTelemetry,
    getLastFailureMeta,
    getLastFailureReport,
    getLaunchEvents,
    listSavedFailureReports,
    record,
    recordError,
} from '../src/mindcraft/diagnostics/launch_telemetry.js';

async function withReportDir(run) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mindcraft-launch-failures-'));
    const previous = process.env.MINDCRAFT_LAUNCH_FAILURE_DIR;
    process.env.MINDCRAFT_LAUNCH_FAILURE_DIR = dir;
    try {
        await run(dir);
    } finally {
        if (previous === undefined) delete process.env.MINDCRAFT_LAUNCH_FAILURE_DIR;
        else process.env.MINDCRAFT_LAUNCH_FAILURE_DIR = previous;
        await rm(dir, { recursive: true, force: true });
    }
}

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

});

test('capturing a failure keeps the report on disk and names its own file', async () => {
    await withReportDir(async dir => {
        clearLaunchTelemetry();
        const captured = captureFailureReport({
            error: new Error('fail'),
            gameSession: { status: 'failed', error: 'fail', gameId: 'tower_battle' },
        });
        assert.equal(getLastFailureReport(), captured);

        const saved = listSavedFailureReports();
        assert.equal(saved.length, 1);
        assert.match(saved[0], /-tower-battle\.md$/);
        // Colons are illegal in filenames on some platforms, so the ISO stamp is
        // flattened, but reports still sort oldest-first by name.
        assert.doesNotMatch(saved[0], /:/);

        const savedPath = path.join(dir, saved[0]);
        assert.equal(getLastFailureMeta().path, savedPath);
        const onDisk = await readFile(savedPath, 'utf8');
        assert.equal(onDisk, captured);
        assert.ok(onDisk.endsWith('\n'));
        // A pasted report points at its own copy on disk.
        assert.ok(captured.includes(`- **Saved to:** ${savedPath}`));
    });
});

test('a survivor failure is saved even when no game session exists yet', async () => {
    await withReportDir(() => {
        clearLaunchTelemetry();
        captureFailureReport({
            error: new Error('A contest game is already active: Spleef (awaiting-next-game)'),
            gameSession: { gameId: 'survivor', title: 'Survivor Bot Season' },
        });
        const saved = listSavedFailureReports();
        assert.equal(saved.length, 1);
        assert.match(saved[0], /-survivor\.md$/);
    });
});

test('saving a report prunes the oldest ones past the keep limit', async () => {
    await withReportDir(async dir => {
        clearLaunchTelemetry();
        for (let i = 0; i < 55; i++) {
            const stamp = String(i).padStart(2, '0');
            await writeFile(path.join(dir, `2020-01-01T00-00-${stamp}-000Z-old.md`), 'old\n');
        }

        captureFailureReport({
            error: new Error('fail'),
            gameSession: { gameId: 'spleef' },
        });

        const saved = listSavedFailureReports();
        assert.equal(saved.length, 50);
        assert.ok(saved.at(-1).endsWith('-spleef.md'), 'the newest report survives');
        // The six oldest made room; everything newer is untouched.
        assert.equal(saved[0], '2020-01-01T00-00-06-000Z-old.md');
    });
});

test('unwritable report directories warn instead of masking the launch failure', () => {
    const previous = process.env.MINDCRAFT_LAUNCH_FAILURE_DIR;
    const warnings = [];
    const warn = console.warn;
    console.warn = message => warnings.push(String(message));
    // A path under an existing file can never be created.
    process.env.MINDCRAFT_LAUNCH_FAILURE_DIR = path.join(
        import.meta.filename,
        'reports'
    );
    try {
        const report = captureFailureReport({ error: new Error('fail') });
        assert.match(report, /Paste this into Cursor/);
        assert.equal(getLastFailureMeta().path, null);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /Could not save launch failure report/);
    } finally {
        console.warn = warn;
        if (previous === undefined) delete process.env.MINDCRAFT_LAUNCH_FAILURE_DIR;
        else process.env.MINDCRAFT_LAUNCH_FAILURE_DIR = previous;
    }
});
