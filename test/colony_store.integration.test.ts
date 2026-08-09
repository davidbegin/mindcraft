import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ColonyState } from "../src/db/colony_state.ts";
import { ColonyStateNotFound, ColonyStore, ColonyStoreLive } from "../src/db/colony_store.ts";

// Runs only when a real Postgres is reachable (CI provides a service container
// and DATABASE_URL). Skipped locally so the suite stays runnable without a DB.
// CI applies migrations with `bun run db:migrate` before this file runs.
const hasDatabase = Boolean(process.env["DATABASE_URL"]);

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

describe.skipIf(!hasDatabase)("ColonyStore (Postgres live layer)", () => {
  test("round-trips a colony through Postgres", async () => {
    const colonyId = `it-${randomUUID()}`;
    const state = sample();

    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        yield* store.save(colonyId, state);
        return yield* store.load(colonyId);
      }).pipe(Effect.provide(ColonyStoreLive)),
    );

    expect(loaded).toEqual(state);
  });

  test("upserts on repeated save", async () => {
    const colonyId = `it-${randomUUID()}`;

    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        yield* store.save(colonyId, sample());
        yield* store.save(colonyId, { ...sample(), phase: "iron-age", epoch: 4 });
        return yield* store.load(colonyId);
      }).pipe(Effect.provide(ColonyStoreLive)),
    );

    expect(loaded.phase).toBe("iron-age");
    expect(loaded.epoch).toBe(4);
  });

  test("reports a missing colony as ColonyStateNotFound", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* ColonyStore;
        return yield* store.load(`missing-${randomUUID()}`);
      }).pipe(Effect.provide(ColonyStoreLive), Effect.flip),
    );

    expect(error).toBeInstanceOf(ColonyStateNotFound);
  });
});
