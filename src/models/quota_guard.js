// Model adapters swallow request errors and return a fallback string, which makes an
// exhausted API key indistinguishable from a slow model: agents keep self-prompting and
// hammer the provider forever. This module classifies non-retryable provider failures so
// callers can trip a circuit breaker instead of hot-looping.

const REPORT_COOLDOWN_MS = 30000;

// Codes that mean "retrying will not help until a human or billing event intervenes".
const FATAL_CODES = new Set([
    'credit_balance_exhausted',
    'insufficient_quota',
    'billing_hard_limit_reached',
    'account_deactivated',
    'invalid_api_key',
]);

const FATAL_TYPES = new Set([
    'insufficient_quota',
]);

// Providers that do not set structured codes still describe the condition in the message.
const FATAL_MESSAGE_PATTERNS = [
    /no credits remaining/i,
    /insufficient (?:quota|credit|balance|funds)/i,
    /exceeded your current quota/i,
    /billing (?:hard limit|details|is not active)/i,
    /add credits to continue/i,
    /quota exceeded/i,
];

let outage = null;
let lastReportAt = 0;
let handler = null;

function errorCode(err) {
    return err?.code ?? err?.error?.code ?? null;
}

function errorType(err) {
    return err?.type ?? err?.error?.type ?? null;
}

function errorMessage(err) {
    return err?.error?.message ?? err?.message ?? '';
}

/**
 * Returns 'quota' or 'auth' for failures that will keep failing until billing or
 * credentials change, and null for transient failures such as ordinary rate limiting,
 * timeouts, and context-length problems.
 */
export function classifyModelError(err) {
    if (!err) return null;

    const code = errorCode(err);
    const type = errorType(err);
    const message = errorMessage(err);

    if (code === 'invalid_api_key' || err.status === 401) {
        return 'auth';
    }

    // A bare 429 is normal backpressure and must not trip the breaker; only a 429 that
    // reports a billing or quota condition is fatal.
    if (FATAL_CODES.has(code) || FATAL_TYPES.has(type)) {
        return 'quota';
    }
    if (err.status === 429 && FATAL_MESSAGE_PATTERNS.some(pattern => pattern.test(message))) {
        return 'quota';
    }
    if (err.status === 402) {
        return 'quota';
    }
    return null;
}

export function setOutageHandler(fn) {
    handler = fn;
}

export function getOutage() {
    return outage ? { ...outage } : null;
}

export function isModelHealthy() {
    return outage === null;
}

/** Clears a recorded outage so the next failure is reported again. */
export function resetOutage() {
    outage = null;
    lastReportAt = 0;
}

export function noteModelSuccess() {
    if (outage !== null) {
        outage = null;
        lastReportAt = 0;
    }
}

/**
 * Records a provider failure. Fatal failures invoke the outage handler, rate limited so a
 * burst of concurrent requests reports once rather than once per request.
 */
export function noteModelFailure(err) {
    const kind = classifyModelError(err);
    if (!kind) return null;

    outage = {
        kind,
        code: errorCode(err) ?? String(err?.status ?? 'unknown'),
        message: errorMessage(err) || 'Model provider rejected the request',
        at: Date.now(),
    };

    const now = Date.now();
    if (handler && now - lastReportAt >= REPORT_COOLDOWN_MS) {
        lastReportAt = now;
        try {
            const result = handler({ ...outage });
            if (result && typeof result.catch === 'function') {
                result.catch(error => console.error('Model outage handler failed:', error));
            }
        } catch (error) {
            console.error('Model outage handler failed:', error);
        }
    }
    return { ...outage };
}
