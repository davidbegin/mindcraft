import { Data, Effect, Schema } from "effect";

// A faithful schema for settings.js / settings_spec.json. Scalars are validated
// precisely (enums, numbers) so a bad value fails at load instead of surfacing
// as undefined behavior deep in the agent. Every field has a default so a
// partial object (env overrides, SETTINGS_JSON) still decodes to a full config.
// An open index signature preserves any keys not yet modeled.

const AuthMethod = Schema.Literal("offline", "microsoft");
const BaseProfile = Schema.Literal("survival", "assistant", "creative", "god_mode");
const CommandSyntax = Schema.Literal("full", "shortened", "none");

const ColonySettings = Schema.Struct(
  {
    enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    start_paused: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    world_id: Schema.optionalWith(Schema.String, {
      default: () => "mindcraft-colony-epic-megabase-v1",
    }),
    state_dir: Schema.optionalWith(Schema.String, { default: () => "./colony" }),
    min_agents: Schema.optionalWith(Schema.Int, { default: () => 3 }),
    heartbeat_interval_ms: Schema.optionalWith(Schema.Int, { default: () => 10000 }),
    idle_directive_ms: Schema.optionalWith(Schema.Int, { default: () => 60000 }),
    conversation_timeout_ms: Schema.optionalWith(Schema.Int, { default: () => 90000 }),
    task_lease_ms: Schema.optionalWith(Schema.Int, { default: () => 300000 }),
    spawn_cooldown_ms: Schema.optionalWith(Schema.Int, { default: () => 30000 }),
    model_probe_base_ms: Schema.optionalWith(Schema.Int, { default: () => 60000 }),
    model_probe_max_ms: Schema.optionalWith(Schema.Int, { default: () => 900000 }),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

const ContestSettings = Schema.Struct(
  {
    enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    state_dir: Schema.optionalWith(Schema.String, { default: () => "./contests" }),
    tick_interval_ms: Schema.optionalWith(Schema.Int, { default: () => 1000 }),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

export const SettingsSchema = Schema.Struct(
  {
    minecraft_version: Schema.optionalWith(Schema.String, { default: () => "auto" }),
    host: Schema.optionalWith(Schema.String, { default: () => "127.0.0.1" }),
    port: Schema.optionalWith(Schema.Int, { default: () => 55916 }),
    auth: Schema.optionalWith(AuthMethod, { default: () => "offline" as const }),
    mindserver_port: Schema.optionalWith(Schema.Int, { default: () => 8080 }),
    auto_open_ui: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    base_profile: Schema.optionalWith(BaseProfile, {
      default: () => "survival" as const,
    }),
    profiles: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
    load_memory: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    init_message: Schema.optionalWith(Schema.String, { default: () => "" }),
    only_chat_with: Schema.optionalWith(Schema.Array(Schema.String), {
      default: () => [],
    }),
    speak: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    speak_proximity: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    speak_proximity_range: Schema.optionalWith(Schema.Int, { default: () => 32 }),
    chat_ingame: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    language: Schema.optionalWith(Schema.String, { default: () => "en" }),
    render_bot_view: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    record_bot_view: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    record_actions: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    allow_insecure_coding: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    allow_vision: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    blocked_actions: Schema.optionalWith(Schema.Array(Schema.String), {
      default: () => [],
    }),
    code_timeout_mins: Schema.optionalWith(Schema.Number, { default: () => -1 }),
    relevant_docs_count: Schema.optionalWith(Schema.Number, { default: () => 5 }),
    max_messages: Schema.optionalWith(Schema.Int, { default: () => 15 }),
    num_examples: Schema.optionalWith(Schema.Int, { default: () => 2 }),
    max_commands: Schema.optionalWith(Schema.Number, { default: () => -1 }),
    show_command_syntax: Schema.optionalWith(CommandSyntax, {
      default: () => "full" as const,
    }),
    narrate_behavior: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    chat_bot_messages: Schema.optionalWith(Schema.Boolean, { default: () => true }),
    spawn_timeout: Schema.optionalWith(Schema.Int, { default: () => 30 }),
    block_place_delay: Schema.optionalWith(Schema.Int, { default: () => 0 }),
    log_all_prompts: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    task: Schema.optionalWith(Schema.NullOr(Schema.Unknown), { default: () => null }),
    colony: Schema.optionalWith(ColonySettings, { default: () => ColonySettings.make({}) }),
    contest: Schema.optionalWith(ContestSettings, {
      default: () => ContestSettings.make({}),
    }),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);

export type Settings = Schema.Schema.Type<typeof SettingsSchema>;

export const decodeSettings = Schema.decodeUnknown(SettingsSchema);

export class SettingsInvalid extends Data.TaggedError("SettingsInvalid")<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

export type RawEnv = Readonly<Record<string, string | undefined>>;

// Mirrors the env overrides in main.js, but coerces to the correct types.
// Today `settings.max_messages = process.env.MAX_MESSAGES` stores a string,
// which then flows into numeric comparisons; here numeric envs become numbers
// and JSON envs are parsed inside the Effect so a malformed value fails loudly.
export const loadSettings = (
  base: unknown,
  env: RawEnv = {},
): Effect.Effect<Settings, SettingsInvalid> =>
  Effect.gen(function* () {
    const merged = yield* Effect.try({
      try: () => {
        const next: Record<string, unknown> = {
          ...(typeof base === "object" && base !== null
            ? (base as Record<string, unknown>)
            : {}),
        };
        const numeric = (raw: string): number => {
          const value = Number(raw);
          if (!Number.isFinite(value)) {
            throw new Error(`Expected a number, got ${JSON.stringify(raw)}`);
          }
          return value;
        };
        if (env["MINECRAFT_PORT"]) next["port"] = numeric(env["MINECRAFT_PORT"]);
        if (env["MINDSERVER_PORT"]) next["mindserver_port"] = numeric(env["MINDSERVER_PORT"]);
        if (env["MAX_MESSAGES"]) next["max_messages"] = numeric(env["MAX_MESSAGES"]);
        if (env["NUM_EXAMPLES"]) next["num_examples"] = numeric(env["NUM_EXAMPLES"]);
        if (env["LOG_ALL"]) next["log_all_prompts"] = env["LOG_ALL"] === "true" || env["LOG_ALL"] === "1";
        if (env["INSECURE_CODING"]) next["allow_insecure_coding"] = true;
        if (env["PROFILES"]) next["profiles"] = JSON.parse(env["PROFILES"]);
        if (env["BLOCKED_ACTIONS"]) next["blocked_actions"] = JSON.parse(env["BLOCKED_ACTIONS"]);
        if (env["SETTINGS_JSON"]) Object.assign(next, JSON.parse(env["SETTINGS_JSON"]));
        return next;
      },
      catch: (cause) => new SettingsInvalid({ reason: "env", cause }),
    });

    return yield* decodeSettings(merged).pipe(
      Effect.mapError((cause) => new SettingsInvalid({ reason: "schema", cause })),
    );
  });
