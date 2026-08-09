import { Schema } from "effect";

// Mirrors COLONY_PHASES in src/mindcraft/colony/colony_coordinator.js. Once that
// module is converted to TypeScript this literal set should be imported from the
// shared domain module rather than restated here.
export const COLONY_PHASES = [
  "epic-megabase",
  "bootstrap",
  "shelter",
  "food-security",
  "iron-age",
  "enchantment",
  "nether",
  "stronghold",
  "endgame",
  "postgame-civilization",
] as const;

export const ColonyPhase = Schema.Literal(...COLONY_PHASES);

// An open record preserves nested fields this slice does not yet model (agents,
// tasks, spawn requests, progress). Tightening those into precise structs is a
// deliberate follow-up; dropping unknown keys here would silently lose persisted
// data on the first save round-trip, which is worse than leaving them untyped.
const OpenRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });

// The integrity-critical shape. Scalars are validated precisely so a corrupt or
// version-mismatched blob fails at this boundary instead of somewhere downstream.
export const ColonyStateSchema = Schema.Struct(
  {
    version: Schema.Literal(1),
    paused: Schema.Boolean,
    pauseReason: Schema.NullOr(Schema.String),
    phase: ColonyPhase,
    epoch: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
    agents: OpenRecord,
    tasks: OpenRecord,
    spawn: Schema.Struct({
      lastRequestedAt: Schema.NullOr(Schema.Number),
      requests: Schema.Array(Schema.Unknown),
    }),
    progress: Schema.Array(Schema.Unknown),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
  },
  // Preserve any additional top-level keys added by future slices.
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

export type ColonyState = Schema.Schema.Type<typeof ColonyStateSchema>;
export type ColonyStateEncoded = Schema.Schema.Encoded<typeof ColonyStateSchema>;

export const decodeColonyState = Schema.decodeUnknown(ColonyStateSchema);
export const encodeColonyState = Schema.encode(ColonyStateSchema);
