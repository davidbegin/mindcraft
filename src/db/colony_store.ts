import type { SqlError } from "@effect/sql/SqlError";
import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { PgClient } from "@effect/sql-pg";
import { eq } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer, Ref } from "effect";
import {
  type ColonyState,
  decodeColonyState,
  encodeColonyState,
} from "./colony_state.ts";
import { colonyState as colonyStateTable } from "./schema.ts";

// Tagged errors so callers use Effect.catchTag and the compiler forces every
// new failure mode to be handled at every call site.
export class ColonyStateNotFound extends Data.TaggedError("ColonyStateNotFound")<{
  readonly colonyId: string;
}> {}

export class ColonyStateCorrupt extends Data.TaggedError("ColonyStateCorrupt")<{
  readonly colonyId: string;
  readonly cause: unknown;
}> {}

export interface ColonyStoreService {
  readonly load: (
    colonyId: string,
  ) => Effect.Effect<ColonyState, ColonyStateNotFound | ColonyStateCorrupt | SqlError>;
  readonly save: (
    colonyId: string,
    state: ColonyState,
  ) => Effect.Effect<void, ColonyStateCorrupt | SqlError>;
}

export class ColonyStore extends Context.Tag("ColonyStore")<
  ColonyStore,
  ColonyStoreService
>() {}

const toCorrupt = (colonyId: string) => (cause: unknown) =>
  new ColonyStateCorrupt({ colonyId, cause });

// --- Live layer: Postgres via @effect/sql-pg, queried through Drizzle -------

const makeLive = Effect.gen(function* () {
  const db = yield* PgDrizzle.PgDrizzle;

  const service: ColonyStoreService = {
    load: (colonyId) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(colonyStateTable)
          .where(eq(colonyStateTable.id, colonyId));
        const row = rows[0];
        if (row === undefined) {
          return yield* new ColonyStateNotFound({ colonyId });
        }
        return yield* decodeColonyState(row.state).pipe(
          Effect.mapError(toCorrupt(colonyId)),
        );
      }),

    save: (colonyId, state) =>
      Effect.gen(function* () {
        const encoded = yield* encodeColonyState(state).pipe(
          Effect.mapError(toCorrupt(colonyId)),
        );
        const values = {
          id: colonyId,
          version: state.version,
          phase: state.phase,
          epoch: state.epoch,
          paused: state.paused,
          state: encoded,
          updatedAt: new Date(),
        };
        yield* db
          .insert(colonyStateTable)
          .values(values)
          .onConflictDoUpdate({
            target: colonyStateTable.id,
            set: {
              version: values.version,
              phase: values.phase,
              epoch: values.epoch,
              paused: values.paused,
              state: values.state,
              updatedAt: values.updatedAt,
            },
          });
      }),
  };

  return service;
});

/** Requires a PgDrizzle instance. Compose with a Postgres client layer. */
export const layer: Layer.Layer<ColonyStore, never, PgDrizzle.PgDrizzle> =
  Layer.effect(ColonyStore, makeLive);

/** Reads DATABASE_URL via Effect Config and builds the store end to end. */
export const ColonyStoreLive = layer.pipe(
  Layer.provide(PgDrizzle.layer),
  Layer.provide(PgClient.layerConfig({ url: Config.redacted("DATABASE_URL") })),
);

// --- Memory layer: same contract, no database, for tests -------------------

/**
 * In-memory store keyed by colony id. Values are held in their encoded (jsonb)
 * form and decoded on load, so the same validation boundary that guards the
 * Postgres layer is exercised in tests. Seed `initial` with raw values to drive
 * the corruption path.
 */
export const layerMemory = (
  initial: Record<string, unknown> = {},
): Layer.Layer<ColonyStore> =>
  Layer.effect(
    ColonyStore,
    Effect.gen(function* () {
      const store = yield* Ref.make(new Map<string, unknown>(Object.entries(initial)));

      const service: ColonyStoreService = {
        load: (colonyId) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(store);
            if (!map.has(colonyId)) {
              return yield* new ColonyStateNotFound({ colonyId });
            }
            return yield* decodeColonyState(map.get(colonyId)).pipe(
              Effect.mapError(toCorrupt(colonyId)),
            );
          }),

        save: (colonyId, state) =>
          Effect.gen(function* () {
            const encoded = yield* encodeColonyState(state).pipe(
              Effect.mapError(toCorrupt(colonyId)),
            );
            yield* Ref.update(store, (map) => new Map(map).set(colonyId, encoded));
          }),
      };

      return service;
    }),
  );
