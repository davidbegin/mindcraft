# Type-safety overhaul

Converting Mindcraft from untyped JavaScript to strictly typed TypeScript + Effect, with
Postgres/Drizzle replacing file persistence and Bun as the runtime.

Tracking issue: [BEG-257](https://linear.app/terminaldotshop/issue/BEG-257).
Foundation merged in [PR #3](https://github.com/davidbegin/mindcraft/pull/3).

**Read this file first when picking the work back up.** It records what exists, what was
decided and why, how to run everything, and what is deliberately not done yet.

## Why this exists

An audit of the codebase found:

- ~46k lines of JavaScript across 143 modules, zero TypeScript, no `tsconfig`
- 76 `JSON.parse` calls with no schema validation
- ~110 Socket.IO handlers with no shared contract between hub, agents, and browser
- A globally mutable `settings` singleton (`src/agent/settings.js`) any module can rewrite
- Model failures converted to human-readable strings, then re-detected downstream with regex
- Only 2 JSDoc typedefs in the whole tree
- Strong behavioral tests (~500 assertions), which cannot substitute for static typing at this scale

## Decisions

Settled during planning. Change them deliberately, not by drift.

| # | Decision | Choice |
|---|---|---|
| 1 | Migration scope | Convert the whole repo |
| 2 | Effect scope | Server and browser |
| 3 | First pilot | Config and persisted schemas |
| 4 | Socket contracts | Effect Schemas, runtime validated |
| 5 | Error policy | Tagged errors internally, strings only at the UI edge |
| 6 | Strictness | Per directory |
| 7 | Test suite | Replace (see open question) |
| 8 | Wire compatibility | Redesign every event, versioned |
| 9 | First PR size | Tooling plus one boundary |
| 10 | Runtime | Bun for runtime, package manager, tests |
| 11 | Test framework | `bun:test` |
| 12 | Database binding | Drizzle through `@effect/sql-pg` |
| 13 | Migrations | `generate` + `migrate`, SQL committed; `push` local only |
| 14 | First data to Postgres | Coordinator state, then audit/telemetry, then history |
| 15 | Type source of truth | Drizzle schema canonical |

## What is merged

Seven slices, all on `main`. 37 tests pass; typecheck and typed lint are clean; the
Postgres layer was verified against a real Postgres 16.

| Area | Files |
|---|---|
| Toolchain | `tsconfig.json`, `eslint.config.js` (scoped TS block), `.github/workflows/ci.yml` |
| Colony persistence | `src/db/schema.ts`, `src/db/colony_state.ts`, `src/db/colony_store.ts`, `drizzle/0000_colony_state.sql` |
| Configuration | `src/config/settings.ts`, `src/config/profile.ts` |
| Model errors | `src/models/model_error.ts` |
| IPC contracts | `src/ipc/contracts.ts` |
| Journals | `src/db/journal.ts` |
| Tests | `test/*.test.ts` (7 files) |

### Nothing is wired up yet

Every shipped module is an additive typed boundary with its own tests. The running app
does not import any of them. Cutover is blocked on the Bun runtime migration, because
`node main.js` and `node --test` cannot import `.ts` directly. That is [BEG-258](https://linear.app/terminaldotshop/issue/BEG-258).

## Running it

### Toolchain

```bash
bun install                 # or: npm install
bun run typecheck           # tsc --noEmit
bun run lint:types          # type-aware ESLint over src/**/*.ts
bun run test:bun            # the TypeScript test files
npm test                    # existing node:test suite (unchanged)
```

### Database

The colony store needs `DATABASE_URL`. Copy `.env.example` and adjust.

```bash
export DATABASE_URL="postgres://mindcraft@127.0.0.1:5432/mindcraft"
bun run db:generate         # generate a migration from src/db/schema.ts
bun run db:migrate          # apply committed migrations (use this in CI/prod)
bun run db:push             # local prototyping only, never in production
```

Bringing up a throwaway Postgres without Docker (what was used to verify the live layer):

```bash
sudo apt-get install -y postgresql
export PATH="/usr/lib/postgresql/16/bin:$PATH"
initdb -D /tmp/pgdata -U mindcraft --auth=trust
pg_ctl -D /tmp/pgdata -o "-p 5432 -k /tmp" -l /tmp/pg.log start
createdb -h /tmp -p 5432 -U mindcraft mindcraft
```

The Postgres integration tests in `test/colony_store.integration.test.ts` skip themselves
when `DATABASE_URL` is unset, so the suite stays runnable without a database. CI provides a
Postgres service container and runs `db:migrate` before the tests.

## Conventions established

- **Tagged errors.** Domain failures are `Data.TaggedError` classes so `Effect.catchTag`
  forces exhaustive handling. Strings are rendered only at the chat/UI edge.
- **Two layers per service.** A live layer (Postgres) and an in-memory layer for tests, so
  tests swap implementations instead of mocking.
- **Validate, do not strip.** Schemas are precise on integrity-critical scalars and keep an
  open index signature over nested collections. Stripping unknown keys would silently drop
  persisted data on the first save round-trip. Tightening is tracked in [BEG-270](https://linear.app/terminaldotshop/issue/BEG-270).
- **Scoped strictness.** Type-aware lint applies only to `.ts` files. The JavaScript rule
  block is restricted to `**/*.js` so the two do not fight.
- **Migrations are reviewed.** `generate` then read the SQL then `migrate`. Never `push`
  against real data.

## Open questions

1. **Decision 7 (replace the test suite).** Recommendation is to port the existing ~500
   Node assertions to `bun:test` mechanically first, get them green against converted code,
   and only then rewrite. Replacing the suite while rewriting the implementation removes the
   only regression check during the riskiest window. Tracked in [BEG-259](https://linear.app/terminaldotshop/issue/BEG-259).
2. **Decisions 1 and 6 are in tension.** Converting everything at once while enforcing
   strictness per directory only works if each directory has a date for reaching full
   strict. Tracked in [BEG-270](https://linear.app/terminaldotshop/issue/BEG-270).
3. **Effect in the browser (decision 2).** The dashboards in `src/mindcraft/public/` are
   plain scripts with no build step. Effect there means adding a bundler. Bun's bundler
   keeps the toolchain to one thing, but this is new infrastructure, not a conversion.

## Backlog

| Issue | Title | Depends on |
|---|---|---|
| [BEG-258](https://linear.app/terminaldotshop/issue/BEG-258) | Bun runtime cutover and native dependency spike | — |
| [BEG-259](https://linear.app/terminaldotshop/issue/BEG-259) | Port the Node test suite to `bun:test` | BEG-258 |
| [BEG-260](https://linear.app/terminaldotshop/issue/BEG-260) | Cut ColonyCoordinator over to ColonyStore | BEG-258 |
| [BEG-261](https://linear.app/terminaldotshop/issue/BEG-261) | quota_guard delegates to typed ModelError | BEG-258 |
| [BEG-262](https://linear.app/terminaldotshop/issue/BEG-262) | Wire boot config to typed loaders | BEG-258 |
| [BEG-263](https://linear.app/terminaldotshop/issue/BEG-263) | Wire Socket.IO handlers to IPC contracts | BEG-258 |
| [BEG-264](https://linear.app/terminaldotshop/issue/BEG-264) | Contest and survivor state to Postgres | BEG-260 |
| [BEG-265](https://linear.app/terminaldotshop/issue/BEG-265) | LLM audit and launch telemetry to Postgres | BEG-260 |
| [BEG-266](https://linear.app/terminaldotshop/issue/BEG-266) | Agent history and memory to Postgres | BEG-260 |
| [BEG-267](https://linear.app/terminaldotshop/issue/BEG-267) | Fix latent type-unsound bugs | — |
| [BEG-268](https://linear.app/terminaldotshop/issue/BEG-268) | Centralize duplicated domain constants | — |
| [BEG-269](https://linear.app/terminaldotshop/issue/BEG-269) | Reproducible installs and pinned runtime | BEG-258 |
| [BEG-270](https://linear.app/terminaldotshop/issue/BEG-270) | Per-directory strict rollout, tighten schemas | — |

BEG-267 and BEG-268 need no runtime work and can be picked up immediately.

## Audit and type-design track

These issues answer "what should the best type be?" before implementation. They produce
inventories, risk scores, state models, and questionnaires for the programmer and product
owner. They are not blocked on the Bun cutover.

| Issue | Audit / decision output |
|---|---|
| [BEG-271](https://linear.app/terminaldotshop/issue/BEG-271) | Whole-system type-safety scorecard and unsoundness budget |
| [BEG-272](https://linear.app/terminaldotshop/issue/BEG-272) | Interactive subsystem type-design questionnaires and decision records |
| [BEG-273](https://linear.app/terminaldotshop/issue/BEG-273) | External boundary matrix, schema coverage, property/fuzz tests |
| [BEG-274](https://linear.app/terminaldotshop/issue/BEG-274) | Domain model review: impossible states, branded IDs, exhaustive transitions |
| [BEG-275](https://linear.app/terminaldotshop/issue/BEG-275) | Effect review: typed errors, Layers, Scope, interruption |
| [BEG-276](https://linear.app/terminaldotshop/issue/BEG-276) | Third-party SDK and Mineflayer type trust boundaries |
| [BEG-277](https://linear.app/terminaldotshop/issue/BEG-277) | Postgres/Drizzle integrity, migrations, and transaction boundaries |
| [BEG-278](https://linear.app/terminaldotshop/issue/BEG-278) | Browser state/events and Effect/bundling scope |
| [BEG-279](https://linear.app/terminaldotshop/issue/BEG-279) | LLM-to-command/generated-code path as an untrusted typed protocol |
| [BEG-280](https://linear.app/terminaldotshop/issue/BEG-280) | Orchestration workflows: typed steps, idempotency, cleanup |

Start with BEG-271 and BEG-272. The scorecard says where the risk is; the questionnaires
prevent the implementer from guessing domain invariants while converting loose objects.

## Reference

- [Effect Schema](https://effect.website/docs/schema/getting-started/)
- [Effect layers](https://effect.website/docs/requirements-management/layers/)
- [Effect error management](https://effect.website/docs/error-management/two-error-types/)
- [Drizzle with Effect Postgres](https://orm.drizzle.team/docs/connect-effect-postgres)
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting)
