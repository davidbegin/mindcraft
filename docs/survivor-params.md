# Survivor params (bounded matrix)

Intent document for the watchable mini-season baseline. Archive stamps hold run-level facts; this page holds defaults.

## Defaults (Quiz 8)

| Knob | Baseline / harness default |
|------|----------------------------|
| Model lineup | All-same cheap (`gpt-5-6-luna-instant` / Luna Instant style) |
| Effort | Cheap on strategy/challenges; heavier only at Tribal / re-eval / voting (phase effort selection TBD in UI) |
| Strategy duration | **10 minutes** |
| Cast / scenarios | 4, 6, 11 presets; cheap 4/6 for harness drills |
| Memory / briefing | More council history (~6 recent councils); private history ~30 lines |
| Souls | Existing persona `systemPrompt`s — no experimental/conservative packs yet |
| USA vs China | Curiosity only **after** baseline; no dedicated infra |

## Challenge deck (baseline)

Default scenario decks use only proven race / tower / spleef games:

`cake_race`, `death_race`, `dog_race`, `diamond_race`, `netherite_race`, `tower_battle`, `deepest_2_5`, `deepest_5`, `spleef`.

`hot_button`, `team_base_siege`, and other experimental contests can still be added from the deck UI (labeled experimental) but are not season defaults. Host can skip a live challenge, declare a winner, set immunity, or jump to Tribal from the Scenario harness.

## Memory drills (does the briefing land?)

Every non-challenge briefing is built from four sources: the **jury roster**, the
**public council record**, the **vote history**, and the player's **own private
talk**. Before adding more prompt rules we measure which of the four a bot
actually reads.

At the post-council re-evaluation beat a bot states where it stands with
`!declareVoteLeaning("Name", "why")`. That is the *before* picture; the sealed
ballot is the *after*. A name that changes between the two is a flip, and the
dashboard's "Is the briefing landing?" card shows whether the new reason cites
anything that was actually said at council.

Each stated reason is checked against the concrete facts that player's briefing
carried:

- **echoed** — the reason reproduced something specific from that source: a name
  the source defines (a juror, someone who wrote your name down), or two or more
  distinctive words from a single council answer or private line. This is the
  only signal counted as evidence the briefing was read.
- **cued** — the reason used the source's vocabulary ("council", "jury") without
  reproducing anything from it. The phase prompt alone can produce this, so it is
  reported separately and never counted as reading.
- **available** — the source had something to offer, so a source that was ignored
  can be told apart from one that was empty.

The four drills live in `test/survivor_memory_drills.test.js` and are repeatable
without a Minecraft server: council memory flip, refuse → grudge, private deal →
public flip, and the jury resentment path. They pin the wiring (a planted fact
reaches the right bot and only that bot, and the probe sees it when used), which
is the baseline a live-cast run gets compared against.

The relationship graph stays operator-only: bots are never handed trust scores,
and a test enforces it. Refusal-salience redesign waits on what these drills show.

## Capture

Stamp each season archive/journal with:

- lineup / model profile per seat
- effort by phase (when implemented)
- persona prompt identity
- memory / briefing settings
- cast size / scenario id
- strategy duration

## Out of scope until baseline runs

- Endless A/B spreadsheets
- New soul packs
- USA-vs-China season modes
- Deep vs Testing memory toggle
