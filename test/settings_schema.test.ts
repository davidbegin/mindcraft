import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { loadSettings, SettingsInvalid } from "../src/config/settings.ts";

// A representative subset mirroring settings.js.
const base = {
  host: "127.0.0.1",
  port: 55916,
  auth: "offline",
  base_profile: "survival",
  max_messages: 30,
  profiles: ["./agent.json"],
};

describe("loadSettings", () => {
  test("decodes a valid config and fills defaults", async () => {
    const settings = await Effect.runPromise(loadSettings(base));
    expect(settings.port).toBe(55916);
    expect(settings.auth).toBe("offline");
    // Default applied for an omitted field.
    expect(settings.language).toBe("en");
    // Nested default object is materialized.
    expect(settings.colony.state_dir).toBe("./colony");
  });

  test("coerces numeric env overrides to numbers, not strings", async () => {
    const settings = await Effect.runPromise(
      loadSettings(base, { MAX_MESSAGES: "50", MINECRAFT_PORT: "25565" }),
    );
    expect(settings.max_messages).toBe(50);
    expect(settings.port).toBe(25565);
    // The bug this guards against: a string surviving into a numeric field.
    expect(typeof settings.max_messages).toBe("number");
  });

  test("rejects an invalid auth value at the boundary", async () => {
    const error = await Effect.runPromise(
      loadSettings({ ...base, auth: "ldap" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SettingsInvalid);
    expect(error.reason).toBe("schema");
  });

  test("fails loudly on a non-numeric numeric env override", async () => {
    const error = await Effect.runPromise(
      loadSettings(base, { MAX_MESSAGES: "lots" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SettingsInvalid);
    expect(error.reason).toBe("env");
  });

  test("reports malformed SETTINGS_JSON as an env failure", async () => {
    const error = await Effect.runPromise(
      loadSettings(base, { SETTINGS_JSON: "{not json" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SettingsInvalid);
    expect(error.reason).toBe("env");
  });
});
