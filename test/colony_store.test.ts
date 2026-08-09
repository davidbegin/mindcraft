import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import type { ColonyState } from "../src/db/colony_state.ts";
import {
  ColonyStateCorrupt,
  ColonyStateNotFound,
  ColonyStore,
  layerMemory,
} from "../src/db/colony_store.ts";

const sample = (): ColonyState => ({
  version: 1,
  paused: false,
  pauseReason: null,
  phase: "bootstrap",
  epoch: 1,
  agents: {},
  tasks: {},
  spawn: { lastRequestedAt: null, requests: [] },
  progress: [],
  createdAt: 1,
  updatedAt: 1,
});

const runWith = <A, E>(
  layer: Layer.Layer<ColonyStore>,
  effect: Effect.Effect<A, E, ColonyStore>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, layer));

describe("ColonyStore (memory layer)", () => {
  test("round-trips a valid state through save and load", async () => {
    const state = sample();
    const loaded = await runWith(
      layerMemory(),
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        yield* store.save("colony-1", state);
        return yield* store.load("colony-1");
      }),
    );
    expect(loaded).toEqual(state);
  });

  test("fails with ColonyStateNotFound for an unknown colony", async () => {
    const error = await runWith(
      layerMemory(),
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        return yield* store.load("missing");
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ColonyStateNotFound);
  });

  test("fails with ColonyStateCorrupt when the stored blob is invalid", async () => {
    // A version-2 blob must not be trusted by version-1 code.
    const error = await runWith(
      layerMemory({ broken: { version: 2, phase: "bootstrap" } }),
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        return yield* store.load("broken");
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ColonyStateCorrupt);
  });

  test("rejects an unknown phase at the decode boundary", async () => {
    const error = await runWith(
      layerMemory({ weird: { ...sample(), phase: "not-a-real-phase" } }),
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        return yield* store.load("weird");
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ColonyStateCorrupt);
  });
});
