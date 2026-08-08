// A failed TTS request used to leave nothing behind but a console line, so an
// exhausted ElevenLabs quota looked exactly like bots that had nothing to say.
// This module classifies voice failures, keeps the most recent one for the UI,
// and reports outages through a handler so the control room can show them.
//
// Voice health is global rather than per-bot: every bot shares one provider key,
// so one exhausted account silences the whole cast.

const REPORT_COOLDOWN_MS = 30000;

// Provider status codes that will keep failing until billing or a key changes.
const QUOTA_CODES = new Set([
    'quota_exceeded',
    'insufficient_quota',
    'credit_balance_exhausted',
    'billing_hard_limit_reached',
]);

const AUTH_CODES = new Set([
    'unauthorized',
    'missing_permissions',
    'invalid_api_key',
    'detected_unusual_activity',
]);

const QUOTA_MESSAGE_PATTERNS = [
    /quota[_ ]exceeded/i,
    /exceeds your quota/i,
    /credits remaining/i,
    /insufficient (?:quota|credit|balance|funds)/i,
    /out of credits/i,
];

const NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'EPIPE',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
]);

const KIND_HINTS = {
    quota: 'out of TTS credits — top up or upgrade the plan',
    auth: 'check the TTS API key and its permissions',
    config: 'no TTS API key configured',
    rate_limit: 'too many voice requests; backing off',
    voice: 'the configured voice ID is not available on this account',
    network: 'cannot reach the TTS provider',
    server: 'provider-side failure; retry later',
    playback: 'audio generated but the host could not play it (is ffplay installed?)',
    unknown: 'see server logs for details',
};

// Failures nothing will fix on its own; these become a sticky outage banner.
const FATAL_KINDS = new Set(['quota', 'auth', 'config', 'voice']);

let outage = null;
let lastFailure = null;
let lastReportAt = 0;
let failureCount = 0;
let handler = null;

function errorCode(err) {
    const code = err?.code ?? err?.error?.code ?? null;
    return code != null ? String(code) : null;
}

function errorStatus(err) {
    const status = err?.status ?? err?.statusCode ?? err?.response?.status ?? null;
    return typeof status === 'number' ? status : null;
}

function truncate(text, max = 300) {
    const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= max) return cleaned;
    return `${cleaned.slice(0, max - 1)}…`;
}

/**
 * Classify a TTS failure into a kind the operator can act on.
 *
 * The provider's own status code is checked before the HTTP status because
 * ElevenLabs answers an exhausted quota with 401, which would otherwise be
 * indistinguishable from a bad key.
 */
export function describeVoiceError(err) {
    const code = errorCode(err);
    const status = errorStatus(err);
    const message = err?.message || String(err ?? '');

    let kind = 'unknown';
    if (code && QUOTA_CODES.has(code)) {
        kind = 'quota';
    } else if (/API key ".*" not found/i.test(message) || /is not configured/i.test(message)) {
        kind = 'config';
    } else if (QUOTA_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) {
        kind = 'quota';
    } else if (code && AUTH_CODES.has(code)) {
        kind = 'auth';
    } else if (status === 401 || status === 403) {
        kind = 'auth';
    } else if (status === 429) {
        kind = 'rate_limit';
    } else if (status === 404 && /voice/i.test(message)) {
        kind = 'voice';
    } else if (NETWORK_CODES.has(code) || /fetch failed/i.test(message)) {
        kind = 'network';
    } else if (typeof status === 'number' && status >= 500) {
        kind = 'server';
    } else if (/ffplay|ENOENT/i.test(message)) {
        kind = 'playback';
    }

    return {
        kind,
        fatal: FATAL_KINDS.has(kind),
        status,
        code,
        message: truncate(message),
        hint: KIND_HINTS[kind] || KIND_HINTS.unknown,
    };
}

/** Operator-facing one-liner naming the failure class instead of just going quiet. */
export function formatVoiceProblem(report) {
    if (!report) return '';
    const provider = report.provider ? ` (${report.provider})` : '';
    switch (report.kind) {
        case 'quota':
            return `Bot voices are silent${provider}: out of TTS credits.`;
        case 'auth':
            return `Bot voices are silent${provider}: the TTS API key was rejected.`;
        case 'config':
            return `Bot voices are silent${provider}: no TTS API key is configured.`;
        case 'voice':
            return `Bot voices are silent${provider}: the configured voice is unavailable.`;
        case 'rate_limit':
            return `Bot voices are dropping lines${provider}: TTS rate limit hit.`;
        case 'network':
            return `Bot voices are silent${provider}: cannot reach the TTS provider.`;
        case 'server':
            return `Bot voices are failing${provider}: the TTS provider returned an error.`;
        case 'playback':
            return 'Voice audio was generated but could not be played on the host.';
        default:
            return `Bot voice failed${provider}: ${report.message || 'unknown error'}`;
    }
}

export function setVoiceHealthHandler(fn) {
    handler = fn;
}

/** The sticky failure the operator still needs to fix, or null when healthy. */
export function getVoiceOutage() {
    return outage ? { ...outage } : null;
}

/** Most recent failure of any kind, including transient ones, for the UI. */
export function getLastVoiceFailure() {
    return lastFailure ? { ...lastFailure } : null;
}

export function isVoiceHealthy() {
    return outage === null;
}

/** Everything the dashboard needs to render voice status in one payload. */
export function getVoiceHealth() {
    return {
        ok: outage === null,
        outage: getVoiceOutage(),
        lastFailure: getLastVoiceFailure(),
        failureCount,
        summary: outage ? formatVoiceProblem(outage) : null,
    };
}

export function resetVoiceHealth() {
    outage = null;
    lastFailure = null;
    lastReportAt = 0;
    failureCount = 0;
}

/**
 * A line that actually reached the speakers clears the outage, so the banner
 * disappears on its own once credits are topped up or the network recovers.
 */
export function noteVoiceSuccess() {
    const recovered = outage !== null;
    outage = null;
    lastFailure = null;
    lastReportAt = 0;
    failureCount = 0;
    if (recovered && handler) invokeHandler(getVoiceHealth());
    return recovered;
}

function invokeHandler(payload) {
    try {
        const result = handler(payload);
        if (result && typeof result.catch === 'function') {
            result.catch(error => console.error('Voice health handler failed:', error));
        }
    } catch (error) {
        console.error('Voice health handler failed:', error);
    }
}

// One rejection travels through several layers (generation, then the playback
// queue), and each layer reports it. Tagging the error keeps a single failure
// from being counted once per layer.
const RECORDED = Symbol('ttsFailureRecorded');

/**
 * Records a TTS failure and returns the classified report.
 * Fatal failures also fire the handler, rate limited so a chatty cast reports
 * once per cooldown instead of once per dropped line.
 */
export function noteVoiceFailure(err, { provider = 'elevenlabs', botName = null } = {}) {
    if (err && typeof err === 'object') {
        if (err[RECORDED]) return getLastVoiceFailure();
        try {
            err[RECORDED] = true;
        } catch {
            // Frozen errors simply lose deduplication.
        }
    }
    const info = describeVoiceError(err);
    return noteVoiceFailureReport({
        ...info,
        provider,
        botName,
        at: Date.now(),
    });
}

/**
 * Ingests an already-classified report, including one relayed from an agent
 * process, so the server's view covers voices it did not generate itself.
 */
export function noteVoiceFailureReport(report) {
    if (!report) return null;
    failureCount++;
    lastFailure = {
        kind: report.kind || 'unknown',
        fatal: !!report.fatal,
        status: report.status ?? null,
        code: report.code ?? null,
        message: report.message || 'TTS request failed',
        hint: report.hint || KIND_HINTS[report.kind] || KIND_HINTS.unknown,
        provider: report.provider || null,
        botName: report.botName || null,
        at: typeof report.at === 'number' ? report.at : Date.now(),
    };

    console.error(
        `[tts-failure] ${lastFailure.kind}`
        + `${lastFailure.status != null ? ` status=${lastFailure.status}` : ''}`
        + `${lastFailure.code ? ` code=${lastFailure.code}` : ''}`
        + `${lastFailure.botName ? ` bot=${lastFailure.botName}` : ''}`
        + `: ${lastFailure.message} — ${lastFailure.hint}`
    );

    if (!lastFailure.fatal) return { ...lastFailure };

    outage = { ...lastFailure };
    const now = Date.now();
    if (handler && now - lastReportAt >= REPORT_COOLDOWN_MS) {
        lastReportAt = now;
        invokeHandler(getVoiceHealth());
    }
    return { ...lastFailure };
}
