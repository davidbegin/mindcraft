import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  AgentProfileSchema,
  mergeProfileLayers,
  ModelHandle,
  ProfileInvalid,
  resolveProfile,
} from "../src/config/profile.ts";

describe("profile merge and validation", () => {
  test("individual overrides base overrides default", () => {
    const merged = mergeProfileLayers(
      { name: "andy", cooldown: 1000 },
      { cooldown: 2000, speak_model: "elevenlabs" },
      { cooldown: 3000, conversing: "default prompt" },
    );
    expect(merged["name"]).toBe("andy");
    expect(merged["cooldown"]).toBe(1000);
    expect(merged["speak_model"]).toBe("elevenlabs");
    expect(merged["conversing"]).toBe("default prompt");
  });

  test("accepts a model handle as either a string or a config object", async () => {
    const decode = Schema.decodeUnknown(ModelHandle);
    expect(await Effect.runPromise(decode("gpt-5"))).toBe("gpt-5");
    const obj = await Effect.runPromise(
      decode({ api: "cursor", model: "gpt-5.6-luna", params: { reasoning: "none" } }),
    );
    expect(typeof obj).toBe("object");
  });

  test("resolves a valid merged profile", async () => {
    const profile = await Effect.runPromise(
      resolveProfile(
        { name: "andy", model: "gpt-5" },
        { modes: { unstuck: true } },
        { cooldown: 3000, memory_model: { api: "cursor", model: "m" } },
      ),
    );
    expect(profile.name).toBe("andy");
    expect(profile.cooldown).toBe(3000);
    expect(profile.modes?.["unstuck"]).toBe(true);
  });

  test("fails when the merged profile has no name", async () => {
    const error = await Effect.runPromise(
      resolveProfile({ model: "gpt-5" }, {}, { cooldown: 3000 }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ProfileInvalid);
  });

  test("rejects a non-boolean value in modes", async () => {
    const error = await Effect.runPromise(
      Schema.decodeUnknown(AgentProfileSchema)({ modes: { unstuck: "yes" } }).pipe(
        Effect.flip,
      ),
    );
    expect(error._tag).toBe("ParseError");
  });
});
