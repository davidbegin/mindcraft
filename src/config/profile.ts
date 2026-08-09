import { Data, Effect, Schema } from "effect";

// Typed model for agent profiles (profiles/*.json merged over profiles/defaults).
// The prompt strings stay loose; the parts that cause real bugs when malformed
// (model handles, modes, examples) are validated. An open index signature keeps
// any field this slice does not model.

/** A model handle is either a bare model string or a provider config object. */
export const ModelHandle = Schema.Union(
  Schema.String,
  Schema.Struct(
    {
      api: Schema.optional(Schema.String),
      model: Schema.optional(Schema.NullOr(Schema.String)),
      url: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    },
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
);
export type ModelHandle = Schema.Schema.Type<typeof ModelHandle>;

const ChatTurn = Schema.Struct({
  role: Schema.String,
  content: Schema.String,
});
const ExampleSet = Schema.Array(Schema.Array(ChatTurn));

const profileFields = {
  name: Schema.optional(Schema.String),
  model: Schema.optional(ModelHandle),
  code_model: Schema.optional(ModelHandle),
  vision_model: Schema.optional(ModelHandle),
  memory_model: Schema.optional(ModelHandle),
  embedding: Schema.optional(ModelHandle),
  speak_model: Schema.optional(Schema.String),
  cooldown: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Number),
  modes: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Boolean })),
  conversing: Schema.optional(Schema.String),
  coding: Schema.optional(Schema.String),
  saving_memory: Schema.optional(Schema.String),
  bot_responder: Schema.optional(Schema.String),
  image_analysis: Schema.optional(Schema.String),
  conversation_examples: Schema.optional(ExampleSet),
  coding_examples: Schema.optional(ExampleSet),
} as const;

const openTail = Schema.Record({ key: Schema.String, value: Schema.Unknown });

/** A profile fragment (a default or base layer); name is optional. */
export const AgentProfileSchema = Schema.Struct(profileFields, openTail);
export type AgentProfile = Schema.Schema.Type<typeof AgentProfileSchema>;

/** A fully resolved profile after merging; name is required. */
export const ResolvedProfileSchema = Schema.Struct(
  { ...profileFields, name: Schema.String },
  openTail,
);
export type ResolvedProfile = Schema.Schema.Type<typeof ResolvedProfileSchema>;

export class ProfileInvalid extends Data.TaggedError("ProfileInvalid")<{
  readonly cause: unknown;
}> {}

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj =>
  typeof value === "object" && value !== null ? { ...(value as Obj) } : {};

const fillMissing = (target: Obj, source: Obj): Obj => {
  const out: Obj = { ...target };
  for (const key of Object.keys(source)) {
    if (out[key] === undefined) out[key] = source[key];
  }
  return out;
};

/**
 * Merge the three profile layers with the exact precedence in prompter.js:
 * defaults fill the base layer, then the base layer fills the individual.
 * Individual wins, then base, then default.
 */
export const mergeProfileLayers = (
  individual: unknown,
  base: unknown,
  defaults: unknown,
): Obj => {
  const baseWithDefaults = fillMissing(asObj(base), asObj(defaults));
  return fillMissing(asObj(individual), baseWithDefaults);
};

/** Merge the layers and decode into a validated, name-required profile. */
export const resolveProfile = (
  individual: unknown,
  base: unknown,
  defaults: unknown,
): Effect.Effect<ResolvedProfile, ProfileInvalid> =>
  Schema.decodeUnknown(ResolvedProfileSchema)(
    mergeProfileLayers(individual, base, defaults),
  ).pipe(Effect.mapError((cause) => new ProfileInvalid({ cause })));
