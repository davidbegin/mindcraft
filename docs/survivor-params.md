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
