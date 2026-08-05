import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
    HighlightReelBuilder,
    resolveWithinBotsRoot,
    safeHighlightSessionId,
    selectHighlightSegments,
} from '../src/mindcraft/contest/highlight_reel.js';

function manifest(root) {
    return [
        {
            bot: 'wide-camera',
            sourceBot: 'alice',
            file: path.join(root, 'alice', 'wide.mp4'),
            recordingRole: 'arena-overview',
            startedAt: 900,
            endedAt: 101000,
            events: [],
        },
        {
            bot: 'alice',
            sourceBot: 'alice',
            file: path.join(root, 'alice', 'pov.mp4'),
            recordingRole: 'participant-pov',
            startedAt: 900,
            endedAt: 101000,
            events: [
                { type: 'speech', atMs: 20000 },
                { type: 'speech', atMs: 21000 },
                { type: 'action.place-block', atMs: 50000 },
            ],
        },
        {
            bot: 'bob',
            sourceBot: 'bob',
            file: path.join(root, 'bob', 'pov.mp4'),
            recordingRole: 'participant-pov',
            startedAt: 900,
            endedAt: 101000,
            events: [],
        },
    ];
}

const contest = {
    startedAt: 1000,
    deadlineAt: 95000,
    completedAt: 100000,
    winnerIds: ['bob'],
};

test('selects bounded intro, deduplicated events, and winner ending', () => {
    const selected = selectHighlightSegments(manifest('/bots'), contest);
    assert.equal(selected[0].reason, 'overview-intro');
    assert.equal(selected.at(-1).reason, 'winner-pov-ending');
    assert.equal(selected.at(-1).sourceBot, 'bob');
    assert.equal(
        selected.filter(item => item.reason === 'event:speech').length,
        1,
        'nearby speech events are deduplicated'
    );
    assert.ok(selected.every(item =>
        item.startMs >= contest.startedAt && item.endMs <= contest.deadlineAt
    ));
    assert.ok(
        selected.reduce((total, item) => total + item.durationSeconds, 0) <= 90
    );
});

test('uses evenly spaced fallback when no markers exist', () => {
    const entries = manifest('/bots').map(entry => ({ ...entry, events: [] }));
    const selected = selectHighlightSegments(entries, contest, {
        maxDurationSeconds: 30,
    });
    assert.ok(selected.some(item => item.reason === 'evenly-spaced-fallback'));
    assert.equal(selected.at(-1).reason, 'winner-pov-ending');
    assert.ok(selected.reduce((sum, item) => sum + item.durationSeconds, 0) <= 30);
});

test('safe ids and path resolution reject traversal', () => {
    assert.equal(safeHighlightSessionId(' contest/round 1 '), 'contest_round_1');
    assert.equal(
        resolveWithinBotsRoot('/tmp/bots', '/tmp/bots/alice/video.mp4'),
        '/tmp/bots/alice/video.mp4'
    );
    assert.throws(
        () => resolveWithinBotsRoot('/tmp/bots', '/tmp/bots-evil/video.mp4'),
        /escapes bots root/
    );
    assert.throws(
        () => resolveWithinBotsRoot('/tmp/bots', '/tmp/video.mp4'),
        /escapes bots root/
    );
});

test('builder writes complete status and normalized output with a fake runner', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'highlight-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'alice'), { recursive: true });
    await mkdir(path.join(root, 'bob'), { recursive: true });
    for (const file of manifest(root).map(entry => entry.file)) {
        await writeFile(file, 'raw recording');
    }

    const calls = [];
    const processRunner = async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (command === 'ffprobe') {
            return {
                code: 0,
                stdout: JSON.stringify({
                    format: { duration: '100' },
                    streams: args.at(-1).includes('wide')
                        ? [{ codec_type: 'video' }]
                        : [{ codec_type: 'video' }, { codec_type: 'audio' }],
                }),
                stderr: '',
            };
        }
        const output = path.resolve(options.cwd || process.cwd(), args.at(-1));
        await writeFile(output, 'encoded');
        return { code: 0, stdout: '', stderr: '' };
    };
    const builder = new HighlightReelBuilder({
        botsRoot: root,
        processRunner,
        clock: (() => {
            let now = 1000;
            return () => now++;
        })(),
    });

    const status = await builder.build({
        sessionId: 'contest/round 1',
        manifestEntries: manifest(root),
        contest,
        maxDurationSeconds: 30,
    });
    assert.equal(status.state, 'complete');

    const outputDirectory = path.join(root, 'highlights', 'contest_round_1');
    assert.equal(await readFile(path.join(outputDirectory, 'highlight.mp4'), 'utf8'), 'encoded');
    const onDisk = JSON.parse(await readFile(
        path.join(outputDirectory, 'status.json'),
        'utf8'
    ));
    assert.equal(onDisk.state, 'complete');
    assert.ok(calls.some(call =>
        call.command === 'ffmpeg' && call.args.includes('anullsrc=channel_layout=stereo:sample_rate=48000')
    ), 'silent sources receive an audio track');
    assert.ok(calls.some(call =>
        call.command === 'ffmpeg' && call.args.includes('scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,fps=20,setsar=1')
    ), 'segments are normalized');
});

test('builder records useful failure and preserves source recordings', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'highlight-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'alice', 'pov.mp4');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, 'raw recording');
    const entries = [{
        bot: 'alice',
        sourceBot: 'alice',
        file: source,
        recordingRole: 'participant-pov',
        startedAt: 900,
        endedAt: 101000,
        events: [{ type: 'action.mine', atMs: 50000 }],
    }];
    const processRunner = command => {
        if (command === 'ffprobe') {
            return {
                code: 0,
                stdout: JSON.stringify({
                    format: { duration: '100' },
                    streams: [{ codec_type: 'video' }],
                }),
                stderr: '',
            };
        }
        return { code: 1, stdout: '', stderr: 'encoder exploded' };
    };
    const builder = new HighlightReelBuilder({ botsRoot: root, processRunner });

    await assert.rejects(
        builder.build({
            sessionId: 'failure',
            manifestEntries: entries,
            contest: { ...contest, winnerIds: ['alice'] },
        }),
        /encoder exploded/
    );
    assert.equal(await readFile(source, 'utf8'), 'raw recording');
    const status = JSON.parse(await readFile(
        path.join(root, 'highlights', 'failure', 'status.json'),
        'utf8'
    ));
    assert.equal(status.state, 'failed');
    assert.match(status.error, /encoder exploded/);
});
