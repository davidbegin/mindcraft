import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { JournalEntry, parseJournal, parseJournalWith } from "../src/db/journal.ts";

describe("journal parsing", () => {
  test("keeps valid entries and preserves payload fields", () => {
    const contents = [
      JSON.stringify({ type: "colony.initialized", at: 1, data: { phase: "bootstrap" } }),
      JSON.stringify({ type: "artifact.written", at: 2, data: { path: "notes/x.md" } }),
    ].join("\n");

    const { entries, skipped } = parseJournal(contents);
    expect(entries).toHaveLength(2);
    expect(skipped).toBe(0);
    expect(entries[0]?.type).toBe("colony.initialized");
    // Open tail keeps the payload.
    expect((entries[0] as { data?: { phase?: string } }).data?.phase).toBe("bootstrap");
  });

  test("skips malformed JSON and entries missing a type, counting them", () => {
    const contents = [
      JSON.stringify({ type: "ok", at: 1 }),
      "{not valid json",
      JSON.stringify({ noType: true }),
      "",
      "   ",
    ].join("\n");

    const { entries, skipped } = parseJournal(contents);
    expect(entries).toHaveLength(1);
    // Two bad lines counted; the blank lines are ignored, not counted.
    expect(skipped).toBe(2);
  });

  test("supports a caller-supplied discriminated schema", () => {
    const Event = Schema.Union(
      Schema.Struct({ type: Schema.Literal("talk.requested"), from: Schema.String }),
      Schema.Struct({ type: Schema.Literal("talk.declined"), from: Schema.String }),
    );
    const contents = [
      JSON.stringify({ type: "talk.requested", from: "andy" }),
      JSON.stringify({ type: "talk.requested" }), // missing from -> skipped
      JSON.stringify({ type: "unknown.event", from: "andy" }), // not in union -> skipped
    ].join("\n");

    const { entries, skipped } = parseJournalWith(Event, contents);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(2);
    expect(entries[0]?.type).toBe("talk.requested");
  });

  test("empty content yields no entries", () => {
    expect(parseJournal("")).toEqual({ entries: [], skipped: 0 });
  });

  test("JournalEntry rejects a non-string type", () => {
    const { entries, skipped } = parseJournalWith(
      JournalEntry,
      JSON.stringify({ type: 42 }),
    );
    expect(entries).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});
