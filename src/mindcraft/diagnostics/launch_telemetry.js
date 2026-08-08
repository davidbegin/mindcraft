import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MAX_EVENTS = 200;
const MAX_LOG_LINES_IN_REPORT = 80;
const SENSITIVE_KEY = /(?:api[_-]?key|secret|token|password|authorization|credential)/i;

const DEFAULT_FAILURE_REPORT_DIR = './contests/launch-failures';
// Old reports are worth keeping — a launch that fails the same way twice a week
// apart is the interesting case — but not forever.
const MAX_SAVED_REPORTS = 50;

const events = [];
// Live subscribers, so the launch timeline can be followed as it happens instead
// of only being read out of a failure report afterwards.
const listeners = new Set();
let lastFailureReport = null;
let lastFailureMeta = null;

function nowIso() {
    return new Date().toISOString();
}

function sanitizeDetail(detail) {
    if (detail == null) return undefined;
    if (typeof detail === 'string') {
        if (SENSITIVE_KEY.test(detail) && detail.length > 40) {
            return '[redacted]';
        }
        return detail.slice(0, 2000);
    }
    if (typeof detail !== 'object') return detail;
    try {
        const cloned = JSON.parse(JSON.stringify(detail));
        const scrub = (value) => {
            if (!value || typeof value !== 'object') return value;
            if (Array.isArray(value)) return value.map(scrub);
            const out = {};
            for (const [key, child] of Object.entries(value)) {
                out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(child);
            }
            return out;
        };
        return scrub(cloned);
    } catch {
        return String(detail).slice(0, 500);
    }
}

export function clearLaunchTelemetry() {
    events.length = 0;
}

/** Returns an unsubscribe function. A listener must never break recording. */
export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function record(event = {}) {
    const entry = {
        ts: event.ts || nowIso(),
        level: event.level || 'info',
        stage: event.stage || 'unknown',
        agent: event.agent || null,
        message: String(event.message || ''),
        detail: sanitizeDetail(event.detail),
    };
    events.push(entry);
    if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
    }
    for (const listener of listeners) {
        try {
            listener(entry);
        } catch (error) {
            console.warn(`Launch telemetry listener failed: ${error.message}`);
        }
    }
    return entry;
}

export function recordError(error, context = {}) {
    const message = error?.message || String(error || 'Unknown error');
    const scrubbed = sanitizeDetail(context.detail);
    const detail = scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed)
        ? { ...scrubbed }
        : (scrubbed != null ? { value: scrubbed } : {});
    if (error?.stack) {
        detail.stack = String(error.stack).split('\n').slice(0, 12).join('\n');
    }
    return record({
        level: 'error',
        stage: context.stage || 'failed',
        agent: context.agent || null,
        message,
        detail,
    });
}

export function attachAgentLog(agentName, line, stream = 'stderr') {
    const text = String(line || '').replace(/\s+$/, '');
    if (!text) return null;
    return record({
        level: stream === 'stderr' ? 'warn' : 'info',
        stage: 'agent_log',
        agent: agentName || null,
        message: text.slice(0, 1000),
        detail: { stream },
    });
}

export function getLaunchEvents() {
    return events.slice();
}

export function setLastFailureReport(report, meta = null) {
    lastFailureReport = report;
    lastFailureMeta = meta;
}

export function getLastFailureReport() {
    return lastFailureReport;
}

export function getLastFailureMeta() {
    return lastFailureMeta;
}

/** Where saved reports live. Overridable so tests never touch the real folder. */
export function failureReportDir() {
    return path.resolve(process.env.MINDCRAFT_LAUNCH_FAILURE_DIR || DEFAULT_FAILURE_REPORT_DIR);
}

function reportFileName(at, gameId) {
    const stamp = at.replaceAll(':', '-').replaceAll('.', '-');
    const slug = String(gameId || 'unknown')
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'unknown';
    return `${stamp}-${slug}.md`;
}

/** Saved reports, oldest first. Names start with an ISO stamp, so they sort by age. */
export function listSavedFailureReports() {
    try {
        return readdirSync(failureReportDir())
            .filter(name => name.endsWith('.md'))
            .sort();
    } catch {
        return [];
    }
}

function pruneSavedReports() {
    const saved = listSavedFailureReports();
    const dir = failureReportDir();
    for (const name of saved.slice(0, Math.max(0, saved.length - MAX_SAVED_REPORTS))) {
        rmSync(path.join(dir, name), { force: true });
    }
}

/**
 * Writes a report to disk so a failed launch can still be diagnosed after the
 * browser tab is gone. Written synchronously: this runs on the failure path, and
 * a crash right after the failure is exactly when the report matters most.
 * Diagnostics must never mask the original error, so problems here only warn.
 */
export function saveFailureReport(report, filePath) {
    try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, report.endsWith('\n') ? report : `${report}\n`);
        pruneSavedReports();
        return filePath;
    } catch (error) {
        console.warn(`Could not save launch failure report: ${error.message}`);
        return null;
    }
}

function formatAgentLine(agent) {
    if (!agent || typeof agent !== 'object') return '- (unknown)';
    const name = agent.name || agent.id || 'unknown';
    const parts = [`- **${name}**`];
    if (agent.registered === false) parts.push('not registered');
    else {
        parts.push(agent.socketConnected ? 'socket connected' : 'no socket');
        parts.push(agent.inGame ? 'in-game' : 'not in-game');
    }
    if (agent.error) parts.push(`error: ${agent.error}`);
    if (agent.exitCode != null) parts.push(`exit=${agent.exitCode}`);
    if (agent.signal) parts.push(`signal=${agent.signal}`);
    return parts.join(' · ');
}

function formatTimeline(entries) {
    return entries.map((entry) => {
        const agent = entry.agent ? ` [${entry.agent}]` : '';
        return `- ${entry.ts} · ${entry.level}/${entry.stage}${agent}: ${entry.message}`;
    }).join('\n');
}

/**
 * Build a markdown blob meant to be pasted into Cursor after a Start Game failure.
 */
export function buildCursorReport({
    error = null,
    gameSession = null,
    contestView = null,
    agents = [],
    env = {},
    events: eventOverride = null,
    at = null,
    reportPath = null,
} = {}) {
    const timeline = (eventOverride || events).slice(-MAX_LOG_LINES_IN_REPORT);
    const session = gameSession || {};
    const progress = session.progress || {};
    const activeContest = contestView?.activeContest
        || (contestView?.contests || []).find(c => c.id === session.contestId)
        || null;
    const summaryError = error?.message || error || session.error || 'Unknown launch failure';
    const stage = progress.stage || session.status || 'unknown';

    const lines = [
        '# Mindcraft launch failure report',
        '',
        'Paste this into Cursor and ask it to diagnose and fix this Mindcraft **Start Game** failure.',
        '',
        '## Summary',
        `- **Stage:** ${stage}`,
        `- **Error:** ${summaryError}`,
        `- **Time:** ${at || nowIso()}`,
        `- **Game:** ${session.title || session.gameId || 'unknown'}`,
        `- **Contest ID:** ${session.contestId || activeContest?.id || 'none'}`,
        `- **Session ID:** ${session.sessionId || 'none'}`,
        ...(reportPath ? [`- **Saved to:** ${reportPath}`] : []),
        '',
        '## Progress',
        `- Status: ${session.status || 'n/a'}`,
        `- Message: ${progress.message || 'n/a'}`,
        `- Agents ready: ${progress.ready ?? 'n/a'} / ${progress.total ?? session.participantIds?.length ?? 'n/a'}`,
        `- Created agents: ${(session.createdAgents || []).map(a => a.name || a.id).join(', ') || 'none'}`,
        '',
        '## Agents',
        (agents.length ? agents.map(formatAgentLine).join('\n') : '- (no agent snapshots)'),
        '',
        '## Environment (sanitized)',
        `- Node: ${env.node || process.version}`,
        `- Platform: ${env.platform || process.platform}`,
        `- Minecraft: ${env.minecraftAddress || 'unknown'}`,
        `- MindServer port: ${env.mindserverPort ?? 'unknown'}`,
        `- Participant count: ${session.participantIds?.length ?? agents.length ?? 0}`,
        `- Game ID: ${session.gameId || 'unknown'}`,
        '',
        '## Launch timeline (recent)',
        formatTimeline(timeline) || '- (empty)',
        '',
        '## Recent agent / server log lines',
        formatTimeline(timeline.filter(e => e.stage === 'agent_log' || e.level === 'error' || e.level === 'warn'))
            || '- (none)',
        '',
    ];

    return lines.join('\n');
}

export function captureFailureReport(options = {}) {
    const at = nowIso();
    // The destination is chosen before the report is built so the report can name
    // the file it lives in: a pasted report says where its copy on disk is.
    const filePath = path.join(
        failureReportDir(),
        reportFileName(at, options.gameSession?.gameId)
    );
    const report = buildCursorReport({ ...options, at, reportPath: filePath });
    setLastFailureReport(report, {
        at,
        error: options.error?.message || options.error || options.gameSession?.error || null,
        stage: options.gameSession?.progress?.stage || options.gameSession?.status || null,
        contestId: options.gameSession?.contestId || null,
        path: saveFailureReport(report, filePath),
    });
    return report;
}
