const MAX_EVENTS = 200;
const MAX_LOG_LINES_IN_REPORT = 80;
const SENSITIVE_KEY = /(?:api[_-]?key|secret|token|password|authorization|credential)/i;

const events = [];
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
        `- **Time:** ${nowIso()}`,
        `- **Game:** ${session.title || session.gameId || 'unknown'}`,
        `- **Contest ID:** ${session.contestId || activeContest?.id || 'none'}`,
        `- **Session ID:** ${session.sessionId || 'none'}`,
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
    const report = buildCursorReport(options);
    setLastFailureReport(report, {
        at: nowIso(),
        error: options.error?.message || options.error || options.gameSession?.error || null,
        stage: options.gameSession?.progress?.stage || options.gameSession?.status || null,
        contestId: options.gameSession?.contestId || null,
    });
    return report;
}
