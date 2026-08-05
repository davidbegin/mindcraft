# Cursor SDK Cost Reduction Plan

*Written 2026-08-04. Analysis of this repo's Cursor SDK usage, how Cursor bills it, and a phased plan to cut spend.*

## Implementation status (2026-08-04, same day)

All three phases were implemented and deployed; the colony was restarted under the new code.

| Change | Where | Status |
|---|---|---|
| Fleet 16 → 5 bots (builder, miner, explorer, logistics, farmer2); sol/terra bots retired | live `stop-agent` via mindserver, persisted in `colony/state.json` | done |
| `max_commands` -1 → 3, `max_messages` 15 → 30, `idle_directive_ms` 15 s → 60 s | `settings.js` | done |
| Self-prompt cooldown 2 s → 20 s | `src/agent/self_prompter.js` | done |
| Summarization chunk 5 → 15 | `src/agent/history.js` | done |
| `MAX_SENDS_PER_AGENT` 25 → 4 (bounds thread replay) | `src/models/cursor.js` | done |
| Cache-friendly prompt order (stable persona/docs/examples first, volatile stats last) | `profiles/defaults/_default.json` | done |
| Examples pinned per session (byte-stable prefix) | `src/models/prompter.js` | done |
| `memory_model`: summaries on `gpt-5.6-luna` (~$0.20/M input) | `profiles/defaults/_default.json`, `prompter.js` | done |
| Bot-to-bot "respond/ignore" LLM call replaced with heuristic | `src/agent/conversation.js` | done |
| Colony directive dedupe (no history spam when unchanged) | `src/agent/mindserver_proxy.js` | done |
| `promptConvo` retries 3 → 2 + strip hallucinated lines; coder attempts 5 → 3 | `prompter.js`, `coder.js` | done |
| Per-run token logging (input/output/cacheRead/cacheWrite) | `src/models/cursor.js` → `bots/cursor-usage.jsonl` | done |
| Dashboard spend limit | cursor.com dashboard | **manual step — not done, requires account access** |

First measurements after restart (4.8 min window, includes restart burst): ~25 calls/min across 5 bots, **77% of input tokens billed as cache reads**, thread growth capped (send 1 ≈ 22k input tokens → send 4 ≈ 37k, then the agent is recreated). All 56 tests pass. Note: the colony must run under Node 20 (`/opt/homebrew/opt/node@20/bin/node main.js`); Node 24 crashes the agent processes.

## TL;DR

Over the last ~40 hours this colony made roughly **45,000+ Cursor SDK calls** (~19/minute sustained): ~30,560 chat turns plus ~15,000 memory-summarization calls, driven by **16 always-on bots** each running a self-prompt loop with a 2-second cooldown and unbounded command chaining. On top of raw call count, two token-level problems multiply cost per call: a **cache-hostile prompt layout** (volatile stats placed before large static command docs, so prompt caching almost never hits) and **quadratic thread growth** (each SDK agent is reused for 25 sends, the backend re-sends the whole thread every turn, and every one of our prompts already embeds the full conversation).

The three biggest levers, in order:

1. **Shrink the fleet and slow the loops** (config only, ~70–80% call reduction).
2. **Fix the thread-growth and cache-layout issues in the adapter/prompts** (code, cuts per-call token cost by an estimated 50–90%).
3. **Route routine calls to cheap models** — `composer-2.5` draws from Cursor's separate "generous included usage" pool; memory summarization and bot-responder checks can use a ~$0.20/M-input model.

---

## 1. How Cursor bills SDK usage (research findings)

Facts below are from Cursor's official docs and staff forum replies unless marked *inference*.

- **Token-based at model API rates, same pool as IDE usage.** SDK runs "follow the same pricing, request pools, and Privacy Mode rules as runs from the IDE," tagged `SDK` in the usage dashboard ([SDK docs](https://cursor.com/docs/sdk/typescript)). There is no per-request fee — cost = tokens × model rate.
- **Two pools:** "Cursor Models" (Composer 2.5, Cursor Grok 4.5 — *generous included usage*) vs "Other Models" (third-party, billed at public API prices against plan credit: Pro $20 included, Pro+ $70, Ultra $400) ([models & pricing](https://cursor.com/docs/models-and-pricing)).
- **Prompt caching is automatic and passed through.** Cursor inserts cache markers server-side; cache reads bill at ~10% of input price (e.g. GPT-5.6 family: cache read = 0.1× input, cache write = 1.25× input). Caching works within and across sessions inside the provider TTL (~5 min for Anthropic, refreshed on hit). We cannot place markers, but we control **prefix stability** — identical leading content across sends is what hits the cache.
- **Thread history re-bills every turn.** Staff: "Every turn in agent mode resends the whole conversation." A reused agent grows linearly in context, so per-send cost grows with thread length — cheap while the cache is warm, expensive when it is not.
- **Selected model prices (per M tokens, input / cache-read / output):**

| Model | Input | Cache read | Output | Notes |
|---|---|---|---|---|
| Composer 2.5 | $0.50 | $0.20 | $2.50 | Cursor pool, generous included usage |
| GPT-5.6 Luna | $0.20 | $0.02 | $1.20 | cheapest third-party listed |
| GPT-5.4 Nano | $0.20 | $0.02 | $1.25 | |
| Claude Haiku 4.5 | $1 | $0.10 | $5 | |
| GPT-5.6 Terra | $2 | $0.20 | $12 | **used by terra_* bots** |
| GPT-5.6 Sol | $5 | $0.50 | $30 | **used by sol_* bots — 25× Luna output** |

- **Cost visibility:** `run.usage` (inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens) is available on every SDK run; per-agent billed cost via `GET /v1/agents/{id}/usage` (cloud only). Dashboard spend limits cap on-demand usage.
- **No batch API discount, no max-output-token knob** in the SDK — output length is controlled by prompting only (*inference: nothing documented*).
- Rate limits: `/v1/models` and agent creation are "standard per-team, per-minute" (unpublished numbers); the adapter's existing local-catalog seeding and create gate already handle this well.

## 2. Where our calls come from (measured + traced)

Empirical, from `bots/*/histories` (40.6 h window, 684 session files):

| Source | Est. calls / 40 h | Mechanism |
|---|---|---|
| `promptConvo` (self-prompt loop, chat, bot↔bot) | ~30,600 | one per assistant turn archived |
| `promptMemSaving` | ~15,000 | 91,400 archived turns ÷ ~6-turn chunks |
| `promptCoding`, retries, `promptShouldRespondToBot`, health probes | unmeasured, additive | see below |

Call-site inventory (traced through the code):

| Trigger | Where | Rate / multiplier |
|---|---|---|
| Self-prompt loop | `src/agent/self_prompter.js` (cooldown **2 s**) → `agent.handleMessage` → `promptConvo` | continuous per bot; `max_commands: -1` lets one cycle chain unbounded `promptConvo` calls |
| Colony idle directive | `mindserver.js` every `idle_directive_ms` (**15 s**) → injects system message + (re)starts self-prompt | 16 bots; also inflates history → accelerates summarization |
| Memory summarization | `src/agent/history.js` — at `max_messages: 15`, summarize a ~5-turn chunk | 1 LLM call per ~5–6 turns added; **~⅓ of all calls, pure overhead** |
| `!newAction` coding | `src/agent/coder.js` — `MAX_ATTEMPTS = 5` | up to 5 `promptCoding` per action |
| Hallucination retry | `prompter.js promptConvo` | up to 3× per turn |
| Bot↔bot conversation | `src/agent/conversation.js` | each exchange = 2× `promptConvo`; `promptShouldRespondToBot` adds 1 extra LLM call when busy |
| Health probe | `checkModelHealth` (“ping”) | only during outages, 60 s–15 min backoff — fine |
| Embeddings | `cursor.js embed()` throws → word-overlap fallback | **$0 — already free** |
| Vision | `allow_vision: false` | off |

Fleet: `colony/state.json` shows **16 desired bots, all busy** (23 on roster). Models: mostly `gpt-5.4-mini` (`andy.json`), plus `gpt-5.6-sol` / `gpt-5.6-terra` variants via `model_profiles.js`.

## 3. Token-level problems (cost per call)

### 3a. Quadratic thread growth in the adapter

`src/models/cursor.js` reuses one SDK `Agent` for `MAX_SENDS_PER_AGENT = 25` sends. Every send appends a full self-contained prompt (directive + system prompt with command docs + entire embedded conversation) to the SDK thread, and the backend re-sends the **whole thread** on every turn. So send *N* carries *N−1* previous full prompts as dead weight: by send 25 the model receives ~25 copies of near-identical ~10k-token prompts. Averaged over an agent's lifetime that is roughly **12× more input tokens than necessary** — partially mitigated by cache reads (0.1–0.2×) when sends are <5 min apart, unmitigated after any gap.

### 3b. Cache-hostile prompt layout

The conversing template (`profiles/defaults/_default.json`) orders placeholders:

```
$NAME → $SELF_PROMPT → $MEMORY → $STATS → $INVENTORY → $COMMAND_DOCS → $EXAMPLES
```

`$SELF_PROMPT`, `$MEMORY`, `$STATS` (position, health, nearby entities/blocks), and `$INVENTORY` change **every turn** and sit *before* the large, perfectly stable `$COMMAND_DOCS` block. Prompt caching matches longest-common-prefix, so the cache dies within the first ~2 lines and the big static blocks are re-billed as fresh input on every send, in every bot.

## 4. The plan

### Phase 1 — Config only, deploy today (est. **70–80 % fewer calls**)

| Change | File | From → To | Why |
|---|---|---|---|
| Shrink fleet | `colony/state.json` desired flags / colony commands | 16 → **4–6** bots | linear multiplier on everything |
| Retire expensive-model bots | colony roster | drop/re-role `sol_*` (\$5/\$30) and `terra_*` (\$2/\$12) bots, or move them to `composer-2.5` | 6–25× price difference for the same turns |
| Cap command chaining | `settings.js` | `max_commands: -1` → **3** | bounds `promptConvo` calls per cycle |
| Slow the self-prompt loop | `src/agent/self_prompter.js` | `cooldown: 2000` → **15000–30000** | bots act in the world for seconds–minutes per decision anyway; thinking every 2 s is wasted |
| Slow idle directives | `settings.js` | `idle_directive_ms: 15000` → **60000** | fewer nudges, less history spam |
| Raise summarization threshold | `settings.js` / `history.js` | `max_messages: 15` → **30**, `summary_chunk_size: 5` → **15** | ~3× fewer `promptMemSaving` calls |
| Set a dashboard spend limit | cursor.com dashboard | — | hard backstop before anything else ships |

### Phase 2 — Small code changes (est. **50–90 % fewer tokens per call**)

1. **Fix thread growth** (`src/models/cursor.js`): lower `MAX_SENDS_PER_AGENT` from 25 to **3–5** (bounds dead-weight replay while amortizing `Agent.create` spacing). Longer term, invert the design: stop embedding the full conversation each send and let the SDK thread carry history — send only the new turns plus a compact volatile-state block.
2. **Cache-friendly prompt layout** (`profiles/defaults/_default.json` + `prompter.js`): reorder to *stable-first* — persona + `$COMMAND_DOCS` + `$EXAMPLES` up front; `$MEMORY`, `$SELF_PROMPT`, `$STATS`, `$INVENTORY`, conversation at the end. Pin example selection per session (select once, reuse) so `$EXAMPLES` stays byte-stable.
3. **Cheap-model tiering** (`andy.json` / profiles): keep the chat model as-is (or move to `composer-2.5` to use the generous Cursor-pool allowance); add a profile-level model for `saving_memory` and `bot_responder` pointing at `gpt-5.6-luna` or `gpt-5.4-nano` (~$0.20/M input). Requires a small `prompter.js` change to honor a `memory_model` field (it already supports `code_model`/`vision_model`).
4. **Replace `promptShouldRespondToBot` with a heuristic** (`conversation.js`): a "respond / don't respond" binary spending a full LLM call is not worth it — use simple rules (was I addressed by name? am I mid-action?).
5. **Deduplicate colony directives** (`mindserver_proxy.js`): skip the `history.add('system', ...)` when the directive prompt is unchanged from the last one delivered — directive spam is what drags history to the summarization threshold.
6. **Tighten retries:** coder `MAX_ATTEMPTS` 5 → **3**; `promptConvo` hallucination retries 3 → **2**, and strip `(FROM OTHER BOT)` lines instead of retrying when that's the only defect.

### Phase 3 — Instrumentation and verification

1. **Log `run.usage` per send** in `cursor.js` (input / output / cacheRead / cacheWrite tokens, model, bot name) to a JSONL file. This turns every later optimization into a measurable experiment and shows the cache-hit rate directly.
2. **Verify cache behavior:** after Phase 2's reordering, cacheReadTokens should dominate inputTokens. If not, iterate on prefix stability.
3. **Re-measure weekly:** calls/hour and tokens/call from the usage log; compare against the 45k/40h baseline. Watch the SDK-tagged line in the Cursor usage dashboard.

### Not worth doing / already free

- **Embeddings** — `cursor.js` throws on `embed()` and the code falls back to word-overlap scoring; zero Cursor spend today. Do not "fix" this.
- **Response caching of identical prompts** — prompts embed per-turn world state, so exact-match cache hits would be ~0. Prefix caching (Phase 2.2) is the right tool.
- **Batching** — Cursor has no batch API or discount tier.
- **Output caps** — no max-output-tokens knob exists; keep the "be very brief" prompt instructions.

## 5. Expected impact (rough)

| Lever | Est. reduction |
|---|---|
| Fleet 16 → 5 bots | ~70 % of calls |
| Loop cooldown 2 s → 20 s + `max_commands` 3 | ~30–50 % of remaining calls |
| Summarization threshold + directive dedupe | ~2/3 of `promptMemSaving` calls |
| Thread-growth fix (`MAX_SENDS_PER_AGENT` 25 → 4) | ~60–90 % of input tokens per send |
| Cache-friendly prompt order | remaining static input billed at 0.1–0.2× |
| Cheap model for memory/responder | those calls at ~1/10 the price |

Compounded, a realistic end state is **~5–10 % of current spend** at similar colony usefulness, with Phase 1 alone capturing the majority.

## 6. Sources

- [Cursor SDK (TypeScript) docs — pricing/pools/usage API](https://cursor.com/docs/sdk/typescript)
- [Cursor models & pricing (pool structure, per-model token rates, cache rates, Auto modes)](https://cursor.com/docs/models-and-pricing)
- [Cursor API rate limits](https://cursor.com/docs/api) · [Cloud Agent endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)
- [Teams token rate](https://cursor.com/help/models-and-usage/token-rate) · [Teams pricing](https://cursor.com/docs/account/teams/pricing)
- Staff forum replies: [automatic Anthropic prompt caching](https://forum.cursor.com/t/anthropic-prompt-caching/160861) · [full-conversation resend per turn](https://forum.cursor.com/t/ridiculously-high-token-usage/167079) · [cache-read billing](https://forum.cursor.com/t/cache-read-token/153794)
- Anthropic prompt caching TTL: [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
