import { Either, Schema } from "effect";

// Tolerant JSONL journal parsing. Today each subsystem re-implements a loop that
// JSON.parses a line and keeps it if `entry.type` is a string, silently dropping
// everything else. This centralizes that into a schema-validated parser that
// reports how many lines it skipped instead of losing them without a trace.

/** Minimum shape every journal entry shares. Open tail preserves payload keys. */
export const JournalEntry = Schema.Struct(
  {
    type: Schema.String,
    at: Schema.optional(Schema.Number),
  },
  Schema.Record({ key: Schema.String, value: Schema.Unknown }),
);
export type JournalEntry = Schema.Schema.Type<typeof JournalEntry>;

export interface JournalParseResult<A> {
  readonly entries: ReadonlyArray<A>;
  readonly skipped: number;
}

/**
 * Parse JSONL content against a schema, keeping only lines that decode and
 * counting the rest. Blank lines are ignored and never counted as skipped.
 * Defaults to the base {@link JournalEntry} schema.
 */
export const parseJournalWith = <A, I>(
  schema: Schema.Schema<A, I>,
  contents: string,
): JournalParseResult<A> => {
  const decode = Schema.decodeUnknownEither(schema);
  const entries: A[] = [];
  let skipped = 0;

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }

    const result = decode(parsed);
    if (Either.isRight(result)) {
      entries.push(result.right);
    } else {
      skipped += 1;
    }
  }

  return { entries, skipped };
};

export const parseJournal = (contents: string): JournalParseResult<JournalEntry> =>
  parseJournalWith(JournalEntry, contents);
