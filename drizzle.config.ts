import { defineConfig } from "drizzle-kit";

// Migrations use the generate + migrate workflow with committed SQL. `push` is
// for local development only; production applies the versioned files in ./drizzle.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "",
  },
});
