import { describe, expect, test } from "bun:test";
import {
  classifyFatalKind,
  classifyModelError,
  MODEL_ERROR_KINDS,
} from "../src/models/model_error.ts";

describe("classifyModelError", () => {
  test("invalid_api_key is fatal auth and not retryable", () => {
    const error = classifyModelError({ code: "invalid_api_key" });
    expect(error.kind).toBe("auth");
    expect(error.fatalKind).toBe("auth");
    expect(error.retryable).toBe(false);
  });

  test("exhausted credits on a 429 is fatal quota", () => {
    const error = classifyModelError({
      status: 429,
      message: "You have insufficient quota remaining",
    });
    expect(error.kind).toBe("quota");
    expect(error.fatalKind).toBe("quota");
    expect(error.retryable).toBe(false);
  });

  test("a plain 429 is a transient rate limit, not fatal", () => {
    const error = classifyModelError({ status: 429, message: "Rate limit reached" });
    expect(error.kind).toBe("rate_limit");
    expect(error.fatalKind).toBeNull();
    expect(error.retryable).toBe(true);
  });

  test("reads a nested error.code and error.message", () => {
    const error = classifyModelError({ error: { code: "context_length_exceeded", message: "maximum context" } });
    expect(error.kind).toBe("context_length");
  });

  test("network codes classify as network", () => {
    expect(classifyModelError({ code: "ECONNRESET" }).kind).toBe("network");
  });

  test("5xx status classifies as server", () => {
    expect(classifyModelError({ status: 503 }).kind).toBe("server");
  });

  test("an unrecognized failure is unknown and retryable", () => {
    const error = classifyModelError({ message: "something odd" });
    expect(error.kind).toBe("unknown");
    expect(error.retryable).toBe(true);
  });

  test("tolerates non-object inputs", () => {
    expect(classifyModelError(null).kind).toBe("unknown");
    expect(classifyModelError("boom").kind).toBe("unknown");
  });

  test("classifyFatalKind mirrors the fatal channel", () => {
    expect(classifyFatalKind({ status: 401 })).toBe("auth");
    expect(classifyFatalKind({ status: 500 })).toBeNull();
  });

  test("every kind produces a non-empty chat message", () => {
    for (const kind of MODEL_ERROR_KINDS) {
      const error = classifyModelError({ message: `forced ${kind}` });
      // chatMessage is exhaustive over kinds; just assert it always renders.
      expect(typeof error.chatMessage).toBe("string");
      expect(error.chatMessage.length).toBeGreaterThan(0);
    }
  });
});
