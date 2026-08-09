import { Data, Effect, Schema } from "effect";

// Shared, validated contracts for the Socket.IO boundary between the hub
// (mindserver.js) and the agent process (mindserver_proxy.js). Today these
// payloads are untyped and drift between emitter and listener. Decoding through
// these schemas turns a malformed payload into a typed failure at the edge.

/**
 * A discriminated RPC result. The redesigned callback shape uses a `success`
 * literal so a response can never be both ok and an error at once (the current
 * code mixes `{ success: false }` resolves with rejects).
 */
export const rpcResult = <A, I, R>(data: Schema.Schema<A, I, R>) =>
  Schema.Union(
    Schema.Struct({ success: Schema.Literal(true), data }),
    Schema.Struct({ success: Schema.Literal(false), error: Schema.String }),
  );

/** Colony directive pushed to an idle agent (mindserver.js:1909-1921). */
export const ColonyDirective = Schema.Struct({
  prompt: Schema.String,
  paused: Schema.optional(Schema.Boolean),
});
export type ColonyDirective = Schema.Schema.Type<typeof ColonyDirective>;

/** Game directive pushed during contests/survivor (mindserver.js:861-880). */
export const GameDirective = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  pause: Schema.optional(Schema.Boolean),
  react: Schema.optional(Schema.Boolean),
  gameStarted: Schema.optional(Schema.Boolean),
  endConversations: Schema.optional(Schema.Boolean),
  automaticAction: Schema.optional(Schema.String),
  worldKnowledge: Schema.optional(Schema.Unknown),
});
export type GameDirective = Schema.Schema.Type<typeof GameDirective>;

/** Directive acknowledgement returned by the agent. */
export const DirectiveAck = rpcResult(
  Schema.Struct({
    status: Schema.String,
    detail: Schema.optional(Schema.Unknown),
  }),
);
export type DirectiveAck = Schema.Schema.Type<typeof DirectiveAck>;

export class IpcDecodeError extends Data.TaggedError("IpcDecodeError")<{
  readonly event: string;
  readonly cause: unknown;
}> {}

/** Decode an inbound payload for a named event into a typed value. */
export const decodeIpc =
  <A, I>(event: string, schema: Schema.Schema<A, I>) =>
  (payload: unknown): Effect.Effect<A, IpcDecodeError> =>
    Schema.decodeUnknown(schema)(payload).pipe(
      Effect.mapError((cause) => new IpcDecodeError({ event, cause })),
    );

export const decodeColonyDirective = decodeIpc("colony-directive", ColonyDirective);
export const decodeGameDirective = decodeIpc("game-directive", GameDirective);
