import { Data } from "effect";

// Typed port of src/models/quota_guard.js describeModelError. This is the
// canonical classifier; the JavaScript module should delegate here once the
// model layer is converted, so the taxonomy lives in one place with a tagged
// error the compiler can force callers to handle exhaustively.

export const MODEL_ERROR_KINDS = [
  "auth",
  "quota",
  "rate_limit",
  "timeout",
  "context_length",
  "network",
  "server",
  "stale",
  "cancelled",
  "vision",
  "unknown",
] as const;

export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

/** Non-null only for failures that persist until billing or credentials change. */
export type FatalKind = "auth" | "quota" | null;

const KIND_HINTS: Record<ModelErrorKind, string> = {
  auth: "check API key / credentials",
  quota: "check billing / plan credits",
  rate_limit: "back off; too many requests",
  timeout: "provider took too long",
  context_length: "shorten conversation context",
  network: "check network / provider reachability",
  server: "provider-side failure; retry later",
  stale: "stale agent session; retry will recreate",
  cancelled: "request was cancelled",
  vision: "model does not support images",
  unknown: "see server logs for details",
};

const FATAL_CODES = new Set([
  "credit_balance_exhausted",
  "insufficient_quota",
  "billing_hard_limit_reached",
  "account_deactivated",
  "invalid_api_key",
]);

const FATAL_TYPES = new Set(["insufficient_quota"]);

const FATAL_MESSAGE_PATTERNS = [
  /no credits remaining/i,
  /insufficient (?:quota|credit|balance|funds)/i,
  /exceeded your current quota/i,
  /billing (?:hard limit|details|is not active)/i,
  /add credits to continue/i,
  /quota exceeded/i,
];

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

const errorCode = (err: Record<string, unknown>): string | null => {
  const direct = asString(err["code"]);
  if (direct !== null) return direct;
  const nested = asRecord(err["error"]);
  return nested ? asString(nested["code"]) : null;
};

const errorType = (err: Record<string, unknown>): string | null => {
  const direct = asString(err["type"]);
  if (direct !== null) return direct;
  const nested = asRecord(err["error"]);
  return nested ? asString(nested["type"]) : null;
};

const errorMessage = (err: Record<string, unknown>): string => {
  const nested = asRecord(err["error"]);
  const nestedMessage = nested ? asString(nested["message"]) : null;
  return nestedMessage ?? asString(err["message"]) ?? "";
};

const errorStatus = (err: Record<string, unknown>): number | null => {
  const status = asNumber(err["status"]) ?? asNumber(err["statusCode"]);
  if (status !== null) return status;
  const response = asRecord(err["response"]);
  return response ? asNumber(response["status"]) : null;
};

const isFatalQuota = (
  code: string | null,
  type: string | null,
  status: number | null,
  message: string,
): boolean => {
  if ((code !== null && FATAL_CODES.has(code)) || (type !== null && FATAL_TYPES.has(type))) {
    return true;
  }
  if (status === 402) return true;
  if (status === 429 && FATAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  if (status === null && FATAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))) {
    return true;
  }
  return false;
};

export class ModelError extends Data.TaggedError("ModelError")<{
  readonly kind: ModelErrorKind;
  readonly fatalKind: FatalKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly code: string | null;
  readonly type: string | null;
  readonly name: string | null;
  readonly message: string;
  readonly hint: string;
}> {
  /** Short chat/UI message that names the failure class. */
  get chatMessage(): string {
    switch (this.kind) {
      case "auth":
        return this.retryable
          ? "My brain hit an auth glitch; retrying with a fresh session."
          : "My brain can't authenticate — check the API key.";
      case "quota":
        return "My brain is out of credits/quota — check billing.";
      case "rate_limit":
        return "My brain hit a rate limit; backing off, then try again.";
      case "timeout":
        return "My brain timed out. Try again.";
      case "context_length":
        return "My brain ran out of context space. Try again with a shorter history.";
      case "network":
        return "My brain can't reach the model provider (network). Try again.";
      case "server":
        return `Model provider error${this.status !== null ? ` (${String(this.status)})` : ""}. Try again.`;
      case "stale":
        return "My brain session went stale; retrying next turn.";
      case "cancelled":
        return "My brain request was cancelled. Try again.";
      case "vision":
        return "Vision is only supported by certain models.";
      case "unknown":
        return this.message
          ? `My brain disconnected (unknown): ${this.message}`
          : "My brain disconnected (unknown). Check server logs.";
      default: {
        const _exhaustive: never = this.kind;
        return _exhaustive;
      }
    }
  }
}

/** Classify any thrown provider value into a typed, tagged ModelError. */
export const classifyModelError = (err: unknown): ModelError => {
  const record = asRecord(err) ?? {};
  const code = errorCode(record);
  const type = errorType(record);
  const status = errorStatus(record);
  const message = errorMessage(record);
  const name = asString(record["name"]) ?? "";
  const lower = message.toLowerCase();

  let kind: ModelErrorKind = "unknown";
  let fatalKind: FatalKind = null;
  let retryable = true;

  const softAuth =
    /authentication error/i.test(message) ||
    /try logging out and back in/i.test(message) ||
    /not (?:logged|signed) in/i.test(message) ||
    /unauthorized/i.test(message);

  if (code === "invalid_api_key" || status === 401 || status === 403) {
    kind = "auth";
    fatalKind = "auth";
    retryable = false;
  } else if (softAuth) {
    kind = "auth";
  } else if (isFatalQuota(code, type, status, message)) {
    kind = "quota";
    fatalKind = "quota";
    retryable = false;
  } else if (status === 429 || code === "rate_limit_exceeded" || /rate limit/i.test(message)) {
    kind = "rate_limit";
  } else if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    /timed?\s*out/i.test(message) ||
    /deadline exceeded/i.test(message)
  ) {
    kind = "timeout";
  } else if (
    code === "context_length_exceeded" ||
    /context length/i.test(message) ||
    /maximum context/i.test(message) ||
    /too many tokens/i.test(message)
  ) {
    kind = "context_length";
  } else if (
    (code !== null && NETWORK_CODES.has(code)) ||
    /fetch failed/i.test(message) ||
    /network/i.test(message) ||
    /socket/i.test(message) ||
    /econnrefused/i.test(message)
  ) {
    kind = "network";
  } else if (
    name === "AgentBusyError" ||
    /agent (?:is )?busy/i.test(message) ||
    /agent .* not found/i.test(message) ||
    /disposed/i.test(message)
  ) {
    kind = "stale";
  } else if (name === "AbortError" || /aborted|cancelled|canceled/i.test(message)) {
    kind = "cancelled";
  } else if (
    /does not support image/i.test(message) ||
    (/vision/i.test(message) && /not support|only supported/i.test(message))
  ) {
    kind = "vision";
    retryable = false;
  } else if (status !== null && status >= 500) {
    kind = "server";
  } else if (/server error|internal error|bad gateway|service unavailable/i.test(lower)) {
    kind = "server";
  }

  return new ModelError({
    kind,
    fatalKind,
    retryable,
    status,
    code,
    type,
    name: name === "" ? null : name,
    message,
    hint: KIND_HINTS[kind],
  });
};

/** 'quota' or 'auth' for non-recoverable failures, null for transient ones. */
export const classifyFatalKind = (err: unknown): FatalKind =>
  classifyModelError(err).fatalKind;
