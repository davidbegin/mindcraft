import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
    access,
    mkdir,
    mkdtemp,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_DURATION_SECONDS = 90;
const INTRO_SECONDS = 6;
const EVENT_SECONDS = 8;
const ENDING_SECONDS = 8;
const FALLBACK_SECONDS = 7;
const DEDUPE_WINDOW_MS = 5000;

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function contestBounds(contest) {
    const startMs = finiteNumber(contest?.startedAt);
    const completedMs = finiteNumber(contest?.completedAt);
    const deadlineMs = finiteNumber(contest?.deadlineAt);
    const endCandidates = [completedMs, deadlineMs].filter(value => value !== null);
    const endMs = endCandidates.length ? Math.min(...endCandidates) : null;
    if (startMs === null || endMs === null || endMs <= startMs) {
        throw new Error('Contest metadata requires valid startedAt and completedAt/deadlineAt bounds');
    }
    return { startMs, endMs };
}

function entryBounds(entry, bounds) {
    const startedAt = finiteNumber(entry?.startedAt);
    const endedAt = finiteNumber(entry?.endedAt);
    if (startedAt === null || endedAt === null || endedAt <= startedAt) return null;
    const startMs = Math.max(startedAt, bounds.startMs);
    const endMs = Math.min(endedAt, bounds.endMs);
    return endMs > startMs ? { startMs, endMs } : null;
}

function segment(entry, startMs, endMs, reason, score) {
    return {
        sourceFile: String(entry.file),
        sourceBot: entry.sourceBot || entry.bot || null,
        recordingRole: entry.recordingRole || null,
        startMs,
        endMs,
        durationSeconds: (endMs - startMs) / 1000,
        sourceOffsetSeconds: (startMs - Number(entry.startedAt)) / 1000,
        reason,
        score,
    };
}

function windowFor(entry, centerMs, durationSeconds, bounds, reason, score) {
    const available = entryBounds(entry, bounds);
    if (!available) return null;
    const desiredMs = Math.min(
        durationSeconds * 1000,
        available.endMs - available.startMs
    );
    let startMs = Math.max(available.startMs, centerMs - desiredMs * 0.4);
    let endMs = Math.min(available.endMs, startMs + desiredMs);
    startMs = Math.max(available.startMs, endMs - desiredMs);
    return endMs > startMs
        ? segment(entry, startMs, endMs, reason, score)
        : null;
}

function eventScore(event, entry) {
    const type = String(event?.type || event?.kind || '').toLowerCase();
    const speech = type === 'speech';
    const action = type.includes('action')
        || type.includes('combat')
        || type.includes('death')
        || type.includes('winner');
    const labelBonus = Array.isArray(entry.labels) && entry.labels.length ? 10 : 0;
    return (speech ? 80 : action ? 100 : 50) + labelBonus;
}

function eventTime(event, entry) {
    const atMs = finiteNumber(event?.atMs ?? event?.timestamp);
    if (atMs !== null) return atMs;
    const offsetMs = finiteNumber(event?.offsetMs);
    const syncEpochMs = finiteNumber(entry?.syncEpochMs);
    if (offsetMs !== null && syncEpochMs !== null) return syncEpochMs + offsetMs;
    return offsetMs !== null && finiteNumber(entry?.startedAt) !== null
        ? Number(entry.startedAt) + offsetMs
        : null;
}

function contestEventTime(event, bounds) {
    const atMs = finiteNumber(event?.atMs ?? event?.timestamp);
    if (atMs !== null) return atMs;
    const offsetMs = finiteNumber(event?.offsetMs);
    return offsetMs === null ? null : bounds.startMs + offsetMs;
}

function bestEntryAt(entries, atMs, preferredBot = null, preferredRole = null) {
    return entries
        .filter(entry => entry.startedAt <= atMs && entry.endedAt >= atMs)
        .sort((left, right) => {
            const leftScore = (left.sourceBot === preferredBot || left.bot === preferredBot ? 4 : 0)
                + (left.recordingRole === preferredRole ? 2 : 0)
                + (left.recordingRole === 'participant-pov' ? 1 : 0);
            const rightScore = (right.sourceBot === preferredBot || right.bot === preferredBot ? 4 : 0)
                + (right.recordingRole === preferredRole ? 2 : 0)
                + (right.recordingRole === 'participant-pov' ? 1 : 0);
            return rightScore - leftScore;
        })[0] || null;
}

function overlapsSelected(candidate, selected, toleranceMs = 1000) {
    return selected.some(existing =>
        candidate.startMs < existing.endMs - toleranceMs
        && candidate.endMs > existing.startMs + toleranceMs
    );
}

function trimToBudget(segments, maxDurationSeconds) {
    let remainingMs = maxDurationSeconds * 1000;
    const result = [];
    for (const item of segments) {
        if (remainingMs <= 0) break;
        const durationMs = Math.min(item.endMs - item.startMs, remainingMs);
        if (durationMs < 500) continue;
        result.push({
            ...item,
            endMs: item.startMs + durationMs,
            durationSeconds: durationMs / 1000,
        });
        remainingMs -= durationMs;
    }
    return result;
}

/**
 * Select synchronized wall-clock windows without touching the filesystem.
 */
export function selectHighlightSegments(manifestEntries, contest, options = {}) {
    if (!Array.isArray(manifestEntries)) {
        throw new TypeError('manifestEntries must be an array');
    }
    const bounds = contestBounds(contest);
    const maxDurationSeconds = finiteNumber(options.maxDurationSeconds)
        ?? DEFAULT_MAX_DURATION_SECONDS;
    if (maxDurationSeconds <= 0 || maxDurationSeconds > DEFAULT_MAX_DURATION_SECONDS) {
        throw new RangeError('maxDurationSeconds must be between 0 and 90');
    }

    const entries = manifestEntries
        .filter(entry => entry?.file && entryBounds(entry, bounds))
        .map(entry => ({ ...entry }))
        .sort((left, right) => Number(left.startedAt) - Number(right.startedAt));
    if (!entries.length) return [];

    const selected = [];
    const overview = entries.find(entry =>
        entry.recordingRole === 'arena-overview'
        && entry.startedAt <= bounds.startMs
        && entry.endedAt > bounds.startMs
    ) || entries.find(entry => entry.recordingRole === 'arena-overview');
    if (overview) {
        const intro = windowFor(
            overview,
            Math.max(bounds.startMs, Number(overview.startedAt)),
            INTRO_SECONDS,
            bounds,
            'overview-intro',
            1000
        );
        if (intro) selected.push(intro);
    }

    const manifestEventCandidates = entries.flatMap(entry =>
        (Array.isArray(entry.events) ? entry.events : []).flatMap(event => {
            const atMs = eventTime(event, entry);
            if (atMs === null || atMs < bounds.startMs || atMs > bounds.endMs) return [];
            return [{ event, atMs, entry, score: eventScore(event, entry) }];
        })
    );
    const contestEvents = [
        ...(Array.isArray(contest?.events) ? contest.events : []),
        ...(Array.isArray(contest?.metadata?.events) ? contest.metadata.events : []),
    ];
    const contestEventCandidates = contestEvents.flatMap(event => {
        const atMs = contestEventTime(event, bounds);
        if (atMs === null || atMs < bounds.startMs || atMs > bounds.endMs) return [];
        const preferredBot = event.sourceBot || event.bot || event.agent
            || event.participantId || null;
        const entry = bestEntryAt(entries, atMs, preferredBot, 'participant-pov');
        return entry ? [{ event, atMs, entry, score: eventScore(event, entry) }] : [];
    });
    const eventCandidates = [
        ...manifestEventCandidates,
        ...contestEventCandidates,
    ].sort((left, right) => right.score - left.score || left.atMs - right.atMs);

    const acceptedEventTimes = [];
    for (const candidate of eventCandidates) {
        if (acceptedEventTimes.some(atMs =>
            Math.abs(atMs - candidate.atMs) < DEDUPE_WINDOW_MS
        )) continue;
        const source = bestEntryAt(
            entries,
            candidate.atMs,
            candidate.entry.sourceBot || candidate.entry.bot,
            'participant-pov'
        ) || candidate.entry;
        const item = windowFor(
            source,
            candidate.atMs,
            EVENT_SECONDS,
            bounds,
            `event:${candidate.event.type || candidate.event.kind || 'activity'}`,
            candidate.score
        );
        if (!item || overlapsSelected(item, selected)) continue;
        selected.push(item);
        acceptedEventTimes.push(candidate.atMs);
    }

    const winner = Array.isArray(contest?.winnerIds) ? contest.winnerIds[0] : null;
    const winnerEntries = winner
        ? entries.filter(entry => entry.sourceBot === winner || entry.bot === winner)
        : [];
    const winnerEndingEntry = bestEntryAt(
        winnerEntries,
        bounds.endMs - 1,
        winner,
        'participant-pov'
    );
    const endingEntry = winnerEndingEntry || bestEntryAt(
        entries,
        bounds.endMs - 1,
        null,
        'arena-overview'
    );
    const ending = endingEntry
        ? windowFor(
            endingEntry,
            bounds.endMs,
            ENDING_SECONDS,
            bounds,
            winnerEndingEntry ? 'winner-pov-ending' : 'contest-ending',
            900
        )
        : null;

    if (eventCandidates.length === 0) {
        const fallbackSource = entries.find(entry => entry.recordingRole === 'arena-overview')
            || entries[0];
        const available = entryBounds(fallbackSource, bounds);
        const slots = Math.max(1, Math.min(8, Math.floor(maxDurationSeconds / FALLBACK_SECONDS)));
        for (let index = 1; available && index <= slots; index += 1) {
            const atMs = available.startMs
                + ((available.endMs - available.startMs) * index) / (slots + 1);
            const item = windowFor(
                fallbackSource,
                atMs,
                FALLBACK_SECONDS,
                bounds,
                'evenly-spaced-fallback',
                20
            );
            if (item && !overlapsSelected(item, selected)) selected.push(item);
        }
    }

    let result;
    if (ending) {
        for (let index = selected.length - 1; index >= 0; index -= 1) {
            if (overlapsSelected(ending, [selected[index]])) selected.splice(index, 1);
        }
        const endingSeconds = ending.durationSeconds;
        result = trimToBudget(
            selected.sort((left, right) =>
                right.score - left.score || left.startMs - right.startMs
            ),
            Math.max(0, maxDurationSeconds - endingSeconds)
        );
        result.push(ending);
    } else {
        result = trimToBudget(
            selected.sort((left, right) =>
                right.score - left.score || left.startMs - right.startMs
            ),
            maxDurationSeconds
        );
    }

    result.sort((left, right) => left.startMs - right.startMs || right.score - left.score);
    return result;
}

export function safeHighlightSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new TypeError('sessionId must be a non-empty string');
    }
    const safe = sessionId.trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    if (!safe) throw new Error('sessionId does not contain any safe characters');
    return safe;
}

export function resolveWithinBotsRoot(botsRoot, candidatePath) {
    if (typeof botsRoot !== 'string' || !botsRoot.trim()) {
        throw new TypeError('botsRoot must be a non-empty string');
    }
    if (typeof candidatePath !== 'string' || !candidatePath.trim()) {
        throw new TypeError('candidatePath must be a non-empty string');
    }
    const root = path.resolve(botsRoot);
    const candidate = path.resolve(candidatePath);
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path escapes bots root: ${candidatePath}`);
    }
    return candidate;
}

export function runProcess(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

async function checkedRun(runner, command, args, options = {}) {
    const result = await runner(command, args, options);
    if (!result || result.code !== 0) {
        const detail = String(result?.stderr || result?.stdout || '').trim().slice(-800);
        throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
    }
    return result;
}

async function probeMedia(file, runner) {
    const result = await checkedRun(runner, 'ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=codec_type',
        '-of', 'json',
        file,
    ]);
    let data;
    try {
        data = JSON.parse(result.stdout);
    } catch (_) {
        throw new Error(`ffprobe returned invalid JSON for ${file}`);
    }
    const durationSeconds = finiteNumber(data?.format?.duration);
    if (durationSeconds === null || durationSeconds <= 0) {
        throw new Error(`ffprobe found no usable duration for ${file}`);
    }
    return {
        durationSeconds,
        hasAudio: Array.isArray(data.streams)
            && data.streams.some(stream => stream.codec_type === 'audio'),
    };
}

function normalizationArgs(source, output, offsetSeconds, durationSeconds, hasAudio) {
    const videoFilter = [
        'scale=854:480:force_original_aspect_ratio=decrease',
        'pad=854:480:(ow-iw)/2:(oh-ih)/2',
        'fps=20',
        'setsar=1',
    ].join(',');
    const args = ['-y', '-ss', String(offsetSeconds), '-t', String(durationSeconds), '-i', source];
    if (!hasAudio) {
        args.push(
            '-f', 'lavfi', '-t', String(durationSeconds),
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'
        );
    }
    args.push(
        '-map', '0:v:0',
        '-map', hasAudio ? '0:a:0' : '1:a:0',
        '-vf', videoFilter,
        '-af', 'aresample=48000,apad',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p',
        '-r', '20',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-ar', '48000',
        '-shortest',
        '-movflags', '+faststart',
        output
    );
    return args;
}

async function atomicWriteJson(file, value) {
    const temporary = `${file}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
}

export class HighlightReelBuilder {
    constructor(options = {}) {
        if (typeof options.botsRoot !== 'string' || !options.botsRoot.trim()) {
            throw new TypeError('botsRoot must be a non-empty string');
        }
        if (options.processRunner && typeof options.processRunner !== 'function') {
            throw new TypeError('processRunner must be a function');
        }
        this.botsRoot = path.resolve(options.botsRoot);
        this.processRunner = options.processRunner || runProcess;
        this.clock = options.clock || (() => Date.now());
    }

    async build({
        sessionId,
        manifestEntries,
        entries,
        contest,
        contestMetadata,
        maxDurationSeconds,
    } = {}) {
        const recordings = manifestEntries ?? entries;
        const metadata = contest ?? contestMetadata;
        const safeSessionId = safeHighlightSessionId(sessionId);
        const rootRealPath = await realpath(this.botsRoot);
        const highlightsRoot = resolveWithinBotsRoot(
            this.botsRoot,
            path.join(this.botsRoot, 'highlights')
        );
        await mkdir(highlightsRoot, { recursive: true });
        resolveWithinBotsRoot(rootRealPath, await realpath(highlightsRoot));
        const requestedOutputDirectory = resolveWithinBotsRoot(
            this.botsRoot,
            path.join(highlightsRoot, safeSessionId)
        );
        await mkdir(requestedOutputDirectory, { recursive: true });
        const outputDirectory = resolveWithinBotsRoot(
            rootRealPath,
            await realpath(requestedOutputDirectory)
        );
        const statusPath = path.join(outputDirectory, 'status.json');
        const outputPath = path.join(outputDirectory, 'highlight.mp4');

        const startedAt = this.clock();
        const baseStatus = {
            sessionId,
            safeSessionId,
            startedAt,
            output: outputPath,
        };
        await atomicWriteJson(statusPath, {
            ...baseStatus,
            state: 'building',
            status: 'building',
        });

        let temporaryDirectory = null;
        try {
            const selected = selectHighlightSegments(recordings, metadata, {
                maxDurationSeconds,
            });
            if (!selected.length) throw new Error('No recording segments overlap the contest');

            const sourceCache = new Map();
            for (const item of selected) {
                const lexicalPath = resolveWithinBotsRoot(this.botsRoot, item.sourceFile);
                await access(lexicalPath);
                const sourceRealPath = await realpath(lexicalPath);
                resolveWithinBotsRoot(rootRealPath, sourceRealPath);
                item.sourceFile = sourceRealPath;
                if (!sourceCache.has(sourceRealPath)) {
                    const sourceEntry = recordings.find(candidate =>
                        path.resolve(String(candidate?.file || '')) === lexicalPath
                    );
                    const sourceWallDurationSeconds = (
                        Number(sourceEntry?.endedAt) - Number(sourceEntry?.startedAt)
                    ) / 1000;
                    if (!Number.isFinite(sourceWallDurationSeconds)
                        || sourceWallDurationSeconds <= 0) {
                        throw new Error(`Recording has invalid timing: ${lexicalPath}`);
                    }
                    sourceCache.set(sourceRealPath, {
                        ...await probeMedia(sourceRealPath, this.processRunner),
                        sourceWallDurationSeconds,
                    });
                }
            }

            temporaryDirectory = await mkdtemp(path.join(outputDirectory, '.build-'));
            const normalizedFiles = [];
            for (let index = 0; index < selected.length; index += 1) {
                const item = selected[index];
                const media = sourceCache.get(item.sourceFile);
                const scale = media.durationSeconds / media.sourceWallDurationSeconds;
                const offsetSeconds = Math.max(0, item.sourceOffsetSeconds * scale);
                const durationSeconds = Math.min(
                    item.durationSeconds * scale,
                    item.durationSeconds,
                    media.durationSeconds - offsetSeconds
                );
                if (durationSeconds <= 0) {
                    throw new Error(`Selected segment is outside media duration: ${item.sourceFile}`);
                }
                const normalizedPath = path.join(
                    temporaryDirectory,
                    `segment-${String(index).padStart(3, '0')}.mp4`
                );
                await checkedRun(
                    this.processRunner,
                    'ffmpeg',
                    normalizationArgs(
                        item.sourceFile,
                        normalizedPath,
                        offsetSeconds,
                        durationSeconds,
                        media.hasAudio
                    )
                );
                normalizedFiles.push(normalizedPath);
            }

            const concatFile = path.join(temporaryDirectory, 'concat.txt');
            await writeFile(
                concatFile,
                normalizedFiles.map(file => `file '${path.basename(file)}'`).join('\n') + '\n',
                'utf8'
            );
            const temporaryOutput = path.join(temporaryDirectory, 'highlight.mp4');
            await checkedRun(this.processRunner, 'ffmpeg', [
                '-y',
                '-f', 'concat',
                '-safe', '1',
                '-i', path.basename(concatFile),
                '-c', 'copy',
                '-movflags', '+faststart',
                temporaryOutput,
            ], { cwd: temporaryDirectory });
            await rename(temporaryOutput, outputPath);

            const status = {
                ...baseStatus,
                state: 'complete',
                status: 'complete',
                completedAt: this.clock(),
                durationSeconds: selected.reduce(
                    (total, item) => total + item.durationSeconds,
                    0
                ),
                segments: selected,
            };
            await atomicWriteJson(statusPath, status);
            return status;
        } catch (error) {
            const failure = {
                ...baseStatus,
                state: 'failed',
                status: 'failed',
                failedAt: this.clock(),
                error: error instanceof Error ? error.message : String(error),
            };
            await atomicWriteJson(statusPath, failure);
            throw new Error(`Highlight reel failed: ${failure.error}`, { cause: error });
        } finally {
            if (temporaryDirectory) {
                await rm(temporaryDirectory, { recursive: true, force: true });
            }
        }
    }
}
