import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// One row per colony. The full reducer state lives in `state` as jsonb; the
// integrity-critical scalars are denormalized into columns so operators can
// query and index them without decoding the blob. On read, `state` is decoded
// through ColonyStateSchema (see colony_state.ts) before any code trusts it.
export const colonyState = pgTable("colony_state", {
  id: text("id").primaryKey(),
  version: integer("version").notNull(),
  phase: text("phase").notNull(),
  epoch: integer("epoch").notNull(),
  paused: boolean("paused").notNull(),
  state: jsonb("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ColonyStateRow = typeof colonyState.$inferSelect;
export type ColonyStateInsert = typeof colonyState.$inferInsert;
