import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  decodeColonyDirective,
  decodeGameDirective,
  IpcDecodeError,
  rpcResult,
} from "../src/ipc/contracts.ts";

describe("IPC contracts", () => {
  test("decodes a valid colony directive", async () => {
    const directive = await Effect.runPromise(
      decodeColonyDirective({ prompt: "build the wall", paused: false }),
    );
    expect(directive.prompt).toBe("build the wall");
    expect(directive.paused).toBe(false);
  });

  test("rejects a colony directive missing its prompt", async () => {
    const error = await Effect.runPromise(
      decodeColonyDirective({ paused: true }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(IpcDecodeError);
    expect(error.event).toBe("colony-directive");
  });

  test("decodes a partial game directive (all fields optional)", async () => {
    const directive = await Effect.runPromise(
      decodeGameDirective({ react: true }),
    );
    expect(directive.react).toBe(true);
    expect(directive.prompt).toBeUndefined();
  });

  test("rejects a game directive with a wrongly typed field", async () => {
    const error = await Effect.runPromise(
      decodeGameDirective({ pause: "yes" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(IpcDecodeError);
    expect(error.event).toBe("game-directive");
  });

  test("rpcResult accepts a success payload and rejects a mixed shape", async () => {
    const schema = rpcResult(Schema.Struct({ status: Schema.String }));
    const decode = Schema.decodeUnknown(schema);

    const ok = await Effect.runPromise(decode({ success: true, data: { status: "ready" } }));
    expect(ok.success).toBe(true);

    const err = await Effect.runPromise(decode({ success: false, error: "nope" }));
    expect(err.success).toBe(false);

    // A payload claiming success but carrying an error field cannot decode as
    // the error variant, and lacks `data` for the success variant.
    const bad = await Effect.runPromise(
      decode({ success: true, error: "contradiction" }).pipe(Effect.flip),
    );
    expect(bad._tag).toBe("ParseError");
  });
});
