# Survivor Realignment — Deep Quiz → Goals → Build

## Why this plan exists

The current setup is not fully aligned with the project's goals. Before building more features, we need a **deep quiz** pass: understand how everything works today, restate the real goals, name what we like / don't like, then put work into Linear so the next builds serve a watchable mini-season — not colony, not random polish.

**North star:** A full mini-season we can watch, where bots communicate (including privately), survive Tribal Council, vote people off into a jury, and play so that jury still likes them enough to crown a winner.

---

## Goal scorecard (from raw notes)

| Goal | Status (operator gut) | Notes |
|------|----------------------|--------|
| Document & understand the system; get all work/todos into Linear | Missing / thin | Need quiz + inventory first |
| Enough working mini-games for a "full" season | Enough to ship; variety later | Don't block the season on count; wire team setup; skip/immunity harness; park new non-race types |
| Working Tribal Council system | Not as good | Host Q&A exists; timing/vote-after-council/memory lens weak |
| Private bot conspiring / side chats | Yes, but not used enough | Rooms + requests exist; strategy phase underuses them |
| Full mini-season we can watch | **No, not yet** | This is the acceptance bar |

Everything below should either unblock that watchable season or be parked.

---

## What "playing Survivor" means (product lens)

This is the lens that should inform **all** communication prompts, memory, and UI:

1. **Vote people off** until few remain.
2. Eliminated players become **jury**.
3. Jury votes for the winner.
4. How you talk matters twice: (a) who gets voted out tonight, (b) whether people you voted out still vote *for you* at the end.
5. **Private side chats** (1:1 or small groups), with invite + **reject**, under a time limit — plan, lie, or refuse.
6. Boots only happen at **Tribal Council**.
7. Tribal is the showpiece: host (**Jeff / Begin**) asks individuals or groups; answers are **public** and enter memory.
8. **No votes until council ends.** Process what was said, re-evaluate, then vote.
9. UI must support **scenario testing**: conspiracy → council → vote → boot → jury path. **Everything leads to Tribal.**

---

## Deep quiz agenda (do this before coding)

Structured walkthroughs — not vague chat. For each area: *what exists*, *what we like*, *what we don't*, *gap vs north star*, *Linear issue(s)*.

### Quiz 1 — Season loop & phases

- Walk `PHASES` in `survivor_game.js`: challenge → strategy → tribal_council → voting → … → jury.
- Confirm: immunity → strategy/private talk → host council → **then** vote.
- Gaps: auto-advance vs host-held phases; "vote after council" enforcement; restart/suspend UX.

**Files:** `src/mindcraft/survivor/survivor_game.js`, `survivor_session_manager.js`, `public/survivor.js` / `survivor.html`

### Quiz 2 — Tribal Council (deep)

- Host asks one vs many; public answers; memory write path.
- Can bots change minds after council? Do prompts force "re-evaluate before casting"?
- What makes council feel dull today vs "funnest part"?

**Files:** `survivor_session_manager.js` (council push / phase directives), `survivor_prompts.js`, `survivor_memory.js`, UI council controls

### Quiz 3 — Voting & jury

- Ballot flow, revote, deadlock, fire-making, jury questioning, jury vote.
- Scenario harness: force alliances, force blindsides, force jury resentment.
- UI: can we run "test seasons" that jump to council/vote without a full challenge?

**Files:** `survivor_game.js`, `survivor_standings.js`, `public/survivor.js`

### Quiz 4 — Private conversations

- Request registry, accept/reject, 1:1 vs multi, time limits, leave room.
- Why underused: prompt incentives? phase duration? no "I want to talk" agency loop? UI visibility?
- Desired: bots proactively propose chats within strategy window; peers can refuse.

**Files:** `conversation_requests.js`, `private_rooms.js`, `survivor_threads.js`, agent `commands/survivor.js`, tests under `test/survivor_conversation*`

### Quiz 5 — Memory & relationships × game prompts

- What sticks after public council vs private room?
- "Game Prompt × Memory Challenge" — do prompts actually use relationship/jury lens?
- Deep Survivor vs game-testing modes: when is memory aggressive vs conservative?

**Files:** `survivor_memory.js`, `survivor_relationships.js`, `survivor_prompts.js`

### Quiz 6 — Mini-games / challenges

- Inventory of working challenges; what a "full season" needs (count + variety).
- Team games status (explicit TODO).

**Files:** `survivor_challenges.js`, contest plumbing if shared

### Quiz 7 — Audio / ElevenLabs / recording

- Mute/unmute voices while season keeps running (voices continue queued?).
- Flush / "next up" voice control.
- Lower volume; less dumb voices; catch audio up to actions.
- Recording tech for watchable seasons.

**Files:** wherever TTS / voice queue lives (locate in quiz — likely mindserver public + agent speech paths)

### Quiz 8 — Params & model experiments

- Fast vs Extra High; USA vs China models; Soul vs Soul (experimental vs conservative).
- Survivor-specific knobs in settings / season start UI.

Capture outcomes as Linear labels or a small "Survivor params" doc — not endless A/B without a season to watch.

---

## Quiz 1 results — season loop & phases (answered)

How the loop actually runs today: `challenge → strategy → tribal_council → voting → boot → next challenge`, with tie paths (`revote → deadlock → rocks/fire_making`) and an endgame of `jury_questioning → jury_voting`. Votes are rejected outside vote phases, so "no voting until council closes" is already enforced in both game logic and prompts.

| # | Question | Decision |
|---|----------|----------|
| 1 | Keep loop order | **Keep** `challenge → strategy → Tribal → vote` |
| 2 | Strategy window (2 min today) | **Longer timer: 10 minutes** |
| 3 | Tribal host-held | **Keep host-held always** |
| 4 | Voting clock + autofill | **Host-held** — operator closes voting |
| 5 | Empty "Vulnerable tonight" during strategy | **Fix now** |
| 6 | Pre-merge same-tribe-only talk | **Keep the camp separation** |
| 7 | Pause vs suspend | **Rework** |
| 8 | Tribal scenario harness | **Yes, high priority** |

### Pause / suspend rework — what's wrong

- Two concepts where the operator wants **one clear button**.
- **State is unreadable**: can't tell what the season is actually doing.
- **Losing the cast on suspend** is the painful part (teardown + respawn).
- Pausing should also **handle audio/voices**.

### Scenario harness — everything wanted

- Jump a season straight to Tribal Council with N bots.
- Skip challenges entirely; assign immunity manually.
- Preload alliances/relationships to test blindsides.
- Jump to final Tribal with a preset jury.
- Replay a past council with different prompts.

### Resulting work items (Quiz 1)

1. Strategy default duration 2 min → **10 min** (`_durationForPhase`, season-start UI default).
2. **Voting becomes host-held** by default: no auto-advance clock, operator closes voting; decide autofill fate as part of it.
3. **Fix vulnerable-target gap**: compute/expose at-risk players during `strategy` instead of only at `openCouncil`, so the strategy directive stops printing an empty list.
4. **Pause/suspend rework**: single control, legible state, keep cast alive where possible, and tie voice/audio muting into it (overlaps the audio workstream).
5. **Tribal scenario harness** (high priority): jump-to-council, manual immunity, preset alliances, preset jury/final Tribal, council replay with alternate prompts.

## Quiz 2 results — Tribal Council (answered)

The host interaction model is right, but Tribal does **not** yet feel like the show's centerpiece. The immediate product gap is not a different council flow; it is a fast way to exercise that flow, stronger strategic answers, and an explicit post-council rethink before ballots open.

| # | Question | Decision |
|---|----------|----------|
| 1 | Tribal feels like the showpiece today | **No** — it currently feels dull or broken |
| 2 | Host flow: ask → targets answer publicly → close council | **Keep this flow** |
| 3 | Public council memory changes votes | **Unknown** — prove it with a test scenario |
| 4 | Vote-after-council behavior | **Force a re-evaluation step** before bots vote |
| 5 | Biggest council pain | Answers are **bland / not strategic enough** |
| 6 | Jeff question presets | **Expand** with situational packs: blindside, idol talk, jury |
| 7 | Season loop order | **Keep** `challenge → strategy → Tribal → vote` |
| 8 | Next Tribal priority | **Scenario harness first**, so councils run without a full season |

### Resulting work items (Quiz 2)

1. Build the **Tribal scenario harness first**; use it as the proving ground for council, voting, boot, and jury behavior.
2. Add a **mandatory post-council re-evaluation step** between closing council and accepting ballots. Bots must reconsider targets using what was said publicly before voting.
3. Create a repeatable **public-memory test scenario** that can demonstrate whether council answers survive into the re-evaluation and alter a ballot.
4. Strengthen council-answer prompts for **specific, strategic, vote-relevant answers**, rather than generic performance.
5. Expand host presets into situational packs for **blindside pressure, idol talk, and jury management** while preserving the current host flow.

## Quiz 3 results — Voting & Jury (answered)

Ballot, boot, and jury **rules** mostly exist; the gap is operator control around reveal, missing votes, fire, and a live harness that can prove the path without a full season. Voting stays host-held (consistent with Quiz 1), and the first drill is the straight path — not the edge cases — even though those presets ship in the same harness release.

| # | Question | Decision |
|---|----------|----------|
| 1 | How the ballot window ends | **Host reveals when ready** — no default countdown |
| 2 | Missing ballots at reveal | **Block reveal** until every ballot is in; surface missing voters |
| 3 | First harness drill | **Straight council → vote → boot → jury** |
| 4 | Proof that council changed votes | **Both** target delta and council-citing ballot reason |
| 5 | Jury eligibility (short 4–6 seasons) | **Every eliminated bot** |
| 6 | Fire-making in live UI | **Random is okay, but require confirmation** |
| 7 | Edge-case presets in first harness | **All four:** ordinary tie/revote; deadlock/rocks; final-four fire; jury/finalist tiebreak |
| 8 | Where scenario setup must live | **Live Survivor dashboard** — no scripts for normal operator testing |

### Resulting work items (Quiz 3)

1. Make voting **host-held with explicit reveal**: no auto-advance clock; operator waits for ballots then reveals.
2. **Block reveal** when any ballot is missing; show who has not voted and allow host intervention before reveal.
3. Ship harness drill #1: **straight council → vote → boot → jury** with manual immunity and no tie.
4. Instrument proof for the memory-flip follow-on: record **before/after targets** per bot and require ballot reasons that **cite council**.
5. Default short-season jury eligibility to **every eliminated bot** (overrideable later if needed).
6. Fire-making: keep chance resolution, but **require operator confirmation** before Advance resolves it.
7. Include tie/deadlock/fire/jury-tie **presets** in the first harness release alongside the basic path.
8. Put scenario setup on the **live Survivor dashboard** (not script-first).

## Quiz 4 results — Private conversations (answered)

The invite / accept / refuse / room mechanics exist, but proactive use is thin and the operator can't yet stage or audit conspiracies well. The operator did not pin a single root cause — underuse is likely a mix of weak prompt pressure, the (now-fixed) short window, a missing agency loop, and a too-short invite TTL — so a harness scenario is needed to actually diagnose it. Notably, prompt pressure stays **soft** (keep the toolbox listing) while the surrounding mechanics get loosened: invites shouldn't expire mid-strategy, refusals should matter more, and multi-person sidebars are encouraged.

| # | Question | Decision |
|---|----------|----------|
| 1 | Why private talk is underused | **Multiple / unknown:** prompts too weak; 2-min window too short; no "I want to talk" agency loop; 30s invite TTL too short; **need a harness scenario to diagnose** |
| 2 | Prompt pressure to start chats | **Keep soft toolbox listing** — bots choose; don't force an ask |
| 3 | Invite TTL (30s today) | **No expiry until strategy ends** — pending invites stay open the whole window |
| 4 | Refuse culture | **Make refusals more salient in memory / relationships** — being frozen out should change play |
| 5 | Room lifetime | **Until members leave (current)** — keep as-is |
| 6 | Group size (max 4 invitees) | **Encourage multi-person sidebars** — alliance meetings default, not exception |
| 7 | Harness private-talk scenarios | **Preload an alliance and force a private meet**; **blindside whisper → council** |
| 8 | Operator must-have | **Better conversation browser / transcript UX** |

### Resulting work items (Quiz 4)

1. **Diagnose underuse with the harness** before over-tuning prompts: run a private-talk scenario and measure asks / accepts / refuses rather than guessing the root cause.
2. **Keep prompt pressure soft** — strategy keeps listing the private-talk toolbox; do not force or gate phase advance on an ask.
3. **Invite TTL: no expiry until strategy ends** — pending invites stay open for the whole strategy window instead of the 30s TTL; reconsider the silence-as-refusal behavior in that light.
4. **Make refusals matter**: write refusals / freeze-outs into memory and relationships so being shut out changes how bots play.
5. **Keep room lifetime as-is** (open until members leave or a challenge starts) — no hard time-box for now.
6. **Encourage multi-person sidebars**: prompt bots toward small alliance meetings (up to 4), not just 1:1.
7. Add private-talk harness presets: **preload-alliance + forced private meet** and **blindside whisper → council** (vote-flip check), alongside the council → vote → boot drill.
8. **Better conversation browser / transcript UX** is the next operator must-have for auditing conspiracies.

## Quiz 5 results — Memory & relationships × game prompts (answered)

The through-line is **instrument before you tune**. Bots already get a social-mode briefing (recent councils, votes for/against, private history including accept/refuse lines) plus an always-on jury lens, but whether any of it actually *changes play* is unproven — so most memory questions defer to the harness rather than to new prompt rules or graph-to-bot feeds. The only firm forward moves are cheap, low-risk shaping: push the jury lens harder by naming jurors, and give short seasons a bit more council history to recall. Everything structural (refusal salience design, feeding the relationship graph to bots, Deep-vs-Testing memory modes) waits on scenario proof.

| # | Question | Decision |
|---|----------|----------|
| 1 | Does the existing memory briefing change play today | **Unknown** — prove it with a harness scenario (target delta + council-citing reasons) |
| 2 | Which memory gap hurts most | **Unknown** — need instrumentation first before naming the gap |
| 3 | Where refusal salience should land | **Prove with a refuse→grudge harness first** — don't redesign briefing / graph / prompts until a scenario shows the gap |
| 4 | Should bots see the relationship graph | **Defer until after harness proof** — keep it operator-only for now |
| 5 | How hard the jury lens pushes | **Strengthen it** — cite jurors by name more often (after each boot and at Tribal) |
| 6 | Deep vs game-testing memory mode | **Decide after harness memory drills** — modes are premature until we see what bots ignore |
| 7 | Briefing volume (~3 councils / ~30 private lines) | **More council history** — short seasons make every public answer matter |
| 8 | Memory / relationship harness scenarios | **All four:** council memory flip; refuse → grudge; private deal then public flip; jury resentment path |
| 9 | Highest-leverage prompt × memory fix after re-eval | **Instrument first** — don't add more prompt rules yet; measure whether briefings are even read |

### Resulting work items (Quiz 5)

1. **Instrument memory before tuning it**: before deciding whether the briefing lands (Q1) or naming the biggest gap (Q2), add measurement — do bots' reasons reference what the briefing told them? This is the gate for all other memory work.
2. **Do not add new prompt × memory rules yet** (Q9): the only prompt change already locked is the Quiz 3 cite-council-in-ballot rule for proof. Hold cite-private / cite-refusals / cite-jury until instrumentation shows current briefings are actually read.
3. **Refusal salience is harness-gated** (Q3): keep refusals in private briefing lines as-is for now; prove the gap with a **refuse → grudge** scenario before touching the relationship graph, briefing layout, or prompts. (This paces — does not drop — the Quiz 4 "make refusals matter" ruling.)
4. **Keep the relationship graph operator-only** (Q4): do not feed bond/friction/grudge scores to bots until memory-flip and refuse scenarios pass.
5. **Strengthen the jury lens** (Q5): keep it always-on, but cite jurors by name more often — especially right after each boot and during Tribal — instead of the generic "HOW YOU WIN" framing.
6. **Increase council history in briefings** (Q7): raise the recent-council window above ~3 for short seasons; leave private-history volume (~30 lines) alone for now.
7. **Do not build a Deep-vs-Testing memory toggle yet** (Q6): revisit only after the harness memory drills show what bots actually ignore.
8. **Add all four memory drills to the harness** (Q8), sequenced after the basic boot path: **council memory flip** (preload target → public reveal → re-eval → ballot cites council), **refuse → grudge**, **private deal then public flip**, **jury resentment path**. These extend the Quiz 2/3/4 harness rather than forming a separate track.

### Build status (Quiz 5) — instrumentation + drills shipped and green

The instrument-first gate (work items 1 and 8) is now implemented and passing, which retires the "in progress" status for the [BEG-250](https://linear.app/terminaldotshop/issue/BEG-250/instrument-survivor-memory-and-relationship-effects) drill core:

- **Memory probe** — `src/mindcraft/survivor/survivor_memory_probe.js` (`collectBriefingFacts` / `attributeReason`) attributes each stated reason to the briefing source it echoes (council / private / votes / jury) and separates *cued* (used the word) from *echoed* (reproduced the fact), so vocabulary alone does not count as reading the briefing.
- **No-Minecraft harness** — `test/helpers/survivor_harness.js` drives a full season with plain functions (fake contest coordinator, in-memory rooms/conversations), letting a drill read back exactly what the cast was told and said.
- **All four drills green** — `test/survivor_memory_drills.test.js`: council memory flip (declared-leaning → ballot flip cites council), refuse → grudge (private-source evidence, bystander sees nothing), private deal → public flip (ballot traces to the room), jury resentment (juror named aloud + can cite the ballot that cut him). Plus guards that a leaning is not a ballot, the graph never reaches a bot, and cue-only vocabulary is not scored as echo.
- Full suite: **532/532 passing**.

Still open on BEG-250 / paced by later quizzes: live-cast baseline run against these drills, the stronger name-the-jurors lens (Q5), and more council history for short seasons (Q7). Refusal-salience redesign (Q3), graph-to-bots (Q4), and Deep-vs-Testing modes (Q6) remain harness-gated as decided.

## Quiz 6 results — Mini-games & Challenges (answered)

The challenge library is **deep enough to run a short season**, but it **feels samey** (five first-finish races). That variety gap is real and we should eventually build toward puzzle / endurance / PVP — and it must **not** block the watchable season. Near-term challenge work is operator control + pre-merge team wiring, not a bigger game catalog. Rewards stay parked.

| # | Question | Decision |
|---|----------|----------|
| 1 | Is the library enough for a short season | **Not enough variety of types** — races dominate; still ship with what we have |
| 2 | Race skew (cake/death/dog/diamond/netherite) | **Build toward puzzle / endurance / PVP variety** (later — does not gate the season) |
| 3 | Tribe / team challenges | **Wire real in-world team coordination pre-merge** (`teamNames` / `teamByParticipant`) |
| 4 | Reward challenges | **Later — after the baseline season runs** |
| 5 | Trust live contest resolution | **Need a clean host override in the UI** (today = raw socket `challenge-result`) |
| 6 | Skip / manual-immunity priority | **High — add jump-past-challenge + set-immunity now** |
| 7 | Distinct-types target before "enough" | **Don't block the season on challenge count** |
| 8 | Challenge harness scenarios | **After basic boot path:** skip challenge → assign immunity manually; **no** force-tribe-loss / force-winner / forfeit presets yet |
| 9 | Challenge workstream job right now | **Just enough to not block the season** — curate + skip/immunity (+ host override); not a games polish epic |

### Resulting work items (Quiz 6)

1. **Ship skip-challenge + set-immunity in the live dashboard** as part of the shared scenario harness (high priority; same control surface as jump-to-Tribal).
2. **Host override UI** for declaring a challenge winner / immunity — replace the undocumented socket-only `challenge-result` path.
3. **Wire in-world Minecraft team setup pre-merge** so tribe challenges actually color/coordinate teams (`teamNames` / `teamByParticipant`). This is the one "team games" investment that lands before the baseline season.
4. **Do not block** the watchable season on new challenge count or non-race variety; curate the existing deck for the first run.
5. **Park** reward challenges and new puzzle/endurance/PVP builds until after a baseline season runs (variety remains a known desire, not a gate).
6. **Harness challenge presets beyond skip/immunity wait** until drill #1 (council → vote → boot → jury) works — no force-tribe-loss / force-individual-winner / tribe-forfeit drills in the first harness cut.

## Quiz 7 results — Audio / ElevenLabs / Recording (answered)

Mute and pause are the high-leverage audio slice and can ship **in parallel** with the Tribal harness — not blocked behind it. Semantics need **both** a credit-saving hard mute and a soft mute that keeps generating; the Survivor dashboard + main mindserver UI both get Big Mute, and pause ties into mute (Quiz 1). Queue work is flush-all + automatic stale-line dropping; volume is per-bot; keep the goofy voice pool. "Watchable" is multi-layer: live host speakers + Minecraft is enough for live ops, but the archive bar is **reliable POV/contest MP4s + text journal, ideally together** — and today TTS isn't in the MP4, full-season capture is missing, export/highlights are frictiony, and Survivor recording UI is thin.

| # | Question | Decision |
|---|----------|----------|
| 1 | Global mute semantics | **Need both modes** — Soft mute (silent queue / keep generating) vs Hard mute (drop + save credits) |
| 2 | Where mute lives | **All three:** Big Mute / Unmute on Survivor dashboard; also on main mindserver UI; **tie mute into the pause control** |
| 3 | Queue / skip controls | **Flush entire voice queue** |
| 4 | Voice lag vs actions | **Cap / drop stale queued lines** |
| 5 | Volume control | **Per-bot volume (or mute)** |
| 6 | Voice quality / cast pool | **Keep the goofy pool** |
| 7 | What is "enough" to watch a season | **All of:** live host speakers + Minecraft window; reliable POV / contest camera MP4s; text journal / seasons archive; **A/V + journal together** |
| 8 | Biggest recording gaps | **All four:** TTS not baked into MP4; export / highlight friction; no continuous full-season capture; Survivor UI recording controls thin / unclear |
| 9 | Priority vs Tribal harness | **Parallel** — mute (+ pause tie-in) can ship beside the harness |

### Resulting work items (Quiz 7)

1. **Ship dual mute modes**: Hard mute (current: drop queue + stop ElevenLabs / save credits) and Soft mute (keep generating, silent play / buffer for catch-up on unmute).
2. **Expose Big Mute / Unmute** on the Survivor dashboard **and** the main mindserver UI; show mute state clearly while hosting.
3. **Tie mute into the pause control** (Quiz 1 pause/suspend rework) so pausing a season also handles voices.
4. **Flush entire voice queue** as an operator control (catch-up to "now").
5. **Cap / drop stale queued lines** so TTS cannot race several beats ahead of on-screen actions.
6. **Per-bot volume (or mute)** for host playback — quiet one loud cast member without silencing everyone.
7. **Keep the goofy ElevenLabs pool** — no re-cast / serious-drama pool for the baseline season.
8. **Recording bar is multi-layer**: live watch (speakers + Minecraft) for ops; for archive, need **reliable POV/contest MP4s + journal**, ideally as one A/V+journal package.
9. **Recording gap work** (after / beside mute): bake or sync TTS into exports; reduce export/highlight friction; continuous full-season capture beyond contest cams; clearer Survivor dashboard recording controls.
10. **Mute (+ pause tie-in) is parallel to the harness** — small, high-leverage; does not wait on Tribal drills. Heavier recording/sync can trail the first boot-path proof.

## Quiz 8 results — Params / Models / Soul (answered)

Start a **small, bounded params matrix now**, but keep it subordinate to the baseline path: cheap homogeneous bots are the default for harness drills, while heavier reasoning is reserved for Tribal / voting. The first watchable baseline also uses an all-same cheap Luna-Instant-style lineup so loop watchability is not confused with model-family variance. USA-vs-China remains post-baseline curiosity, and "soul" means the persona `systemPrompt` layer already in the cast — no new soul packs until after the baseline. Record every run's effective params in the archive and maintain one tiny intent document rather than building an endless A/B system.

| # | Question | Decision |
|---|----------|----------|
| 1 | When params exploration starts | **Start a small matrix now** |
| 2 | First baseline lineup | **All-same cheap (Luna Instant style)** |
| 3 | Effort ladder | **Heavier effort only at Tribal / voting** |
| 4 | USA vs China | **Curiosity only — after baseline** |
| 5 | Meaning of "soul" | **Persona `systemPrompt`s (already there)** |
| 6 | Soul work before baseline | **Design soul packs only after baseline** |
| 7 | Survivor season-start knobs | **Memory aggression / briefing volume; cast size / scenario presets (4, 6, 11…); strategy duration (defaulting toward 10 min)** |
| 8 | Cheap-test role | **Default for harness / scenario drills** |
| 9 | Params capture | **Both: archive stamp + tiny params doc** |

### Resulting work items (Quiz 8)

1. Define a **small fixed matrix now**, not an open-ended experiment system: cheap/instant baseline and harness runs, plus phase-specific heavier effort at Tribal / voting.
2. Make **all-same cheap / Luna Instant style** the first baseline lineup and the default harness profile; label conclusions accordingly so cheap-model strategy quality is not overgeneralized.
3. Add **phase-specific effort selection** so strategy/challenges stay cheap while Tribal answers, post-council re-evaluation, and ballots can use heavier reasoning.
4. Keep **USA-vs-China comparisons after baseline** as a documented curiosity run; do not build dedicated infrastructure or let it block the season.
5. Treat existing persona **`systemPrompt`s as souls**. Keep the current cast prompts for baseline and defer experimental/conservative soul packs until after watching it.
6. Expose only the chosen season knobs: **strategy duration, cast/scenario preset, and memory aggression / briefing volume**. Do not add USA/China or soul mode switches now.
7. Stamp each archive/journal with the effective **lineup, model/profile, effort by phase, persona prompt identity, memory/briefing settings, cast size/scenario, and strategy duration**.
8. Maintain a tiny **Survivor params** document explaining defaults and the bounded matrix; archive stamps hold run-level facts.

## Current-system map (code-backed)

This is the implemented system as of the quiz pass, not the desired design.

### Season loop and operator control

- `SurvivorGame` owns the rules and phase graph in `src/mindcraft/survivor/survivor_game.js`: `challenge → strategy → tribal_council → voting`, with revote/deadlock/rocks/fire paths and `jury_questioning → jury_voting → finalist_tiebreak → completed`.
- `SurvivorSessionManager` in `src/mindcraft/survivor/survivor_session_manager.js` owns clocks, directives, agent/session orchestration, challenge integration, and `control(action)`.
- Council is host-held by default, but strategy is still **120 seconds** and voting/revote/endgame phases still use **45–60 second clocks**. Advancing voting currently fills missing ballots before reveal.
- Vote-after-council is structurally enforced: `castVote()` rejects ballots outside vote phases and `beginVoting()` only follows council.
- Pause keeps agents alive and stops `tick()`; suspend destroys the cast and private rooms, then resume respawns via `_restoreCast()`.
- `eligibleTargetIds` is populated by `openCouncil()`, while the strategy prompt reads it earlier, confirming the empty **“Vulnerable tonight”** bug.
- Missing versus plan: 10-minute strategy default, host-held voting with no autofill, vulnerable targets during strategy, one cast-preserving pause control, and the live scenario harness.

### Tribal, voting, boot, and jury

- Host Q&A flows through `askCouncilQuestion()`, `answerCouncilQuestion()`, and `_recordCouncilAnswer()` in the session manager; questions and answers are narrated, broadcast publicly, and appended to the event log.
- Council answers enter bot history immediately through `src/agent/mindserver_proxy.js` and are rebuilt into later briefings by `buildCouncilTranscript()` in `survivor_memory.js`.
- `beginVoting()` currently transitions directly from council to voting. “Reconsider what came out on the mat” is prompt text, not a distinct mandatory re-evaluation beat.
- `SurvivorGame` already implements sealed ballots/reasons, reveal, revote, deadlock, rocks, fire-making, boot order, jury voting, and finalist tiebreaks.
- `_requireAllBallots()` can block reveal and report missing voters, but timer/Advance paths call `fillMissingBallots()` first; the dashboard shows only received/expected counts.
- `juryEligibility: 'all_eliminated'` already exists and is used by the six-player preset; classic defaults to post-merge jury.
- Missing versus plan: harness presets, explicit re-evaluation, target-delta/reason instrumentation, missing-voter UI, operator-confirmed random fire, and situational Jeff packs.

### Private conspiracy

- `ConversationRequestRegistry` (`conversation_requests.js`) implements invite/respond/resolve with **no mid-window TTL** (pending invites stay open until strategy ends), max four invitees, one pending request per requester, and a decline cooldown.
- `PrivateRoomRegistry` (`private_rooms.js`) implements join/leave/send/close; rooms stay open until fewer than two members remain and are cleared when a challenge begins.
- `SurvivorSessionManager.handleAgentCommand()` wires talk requests, responses, room messages, and leaving. `_privateTalkPlayerIds()` preserves same-tribe-only talk before merge.
- Operator views exist in the Survivor secret feed and `/conversations`; refusals are folded into private transcripts/briefings.
- Missing versus plan: measurable live-cast ask/accept/refuse baseline runs, and proven refusal salience redesign (still harness-gated / paced by memory instrumentation).

### Memory and relationships

- `buildPlayerBriefing()` in `survivor_memory.js` injects the always-on jury lens, last **3 council rounds**, last **30 private lines**, public vote history, and current juror names into every non-challenge social directive.
- `buildSurvivorRelationships()` in `survivor_relationships.js` derives operator-visible bond/friction from rooms and votes; bots do not receive the graph.
- Refusals already appear as private briefing lines, but there is no measurement that bots use briefings or that refusals alter play.
- Missing versus plan: briefing-use instrumentation, longer council history for short seasons, stronger named-juror framing, and the four memory drills. Deep-vs-Testing mode remains intentionally absent.

### Challenges

- `survivor_challenges.js` provides five first-finish races plus tower battle, depth race, and spleef; `game_presets.js` selects scenario decks.
- `startNextChallenge()` and `syncContestView()` run and resolve contests; pre-merge winner logic uses Survivor tribe state.
- A `challenge-result` host override exists in session control but is not exposed in the Survivor dashboard.
- Standalone contests support `teamNames` / `teamByParticipant`; Survivor challenge setup does not pass equivalent Minecraft team wiring.
- Missing versus plan: dashboard skip/manual immunity/host override and real in-world pre-merge tribe setup. New challenge types and rewards remain non-blocking.

### Audio, recording, and archive

- `src/agent/speak.js` has a FIFO queue, soft/hard mute, full/per-bot queue clearing, per-bot host volume (0–100), per-line volume, generation-token + age/depth stale drops (`setSpeechLagLimits`). `/api/voice/mute`, `/api/voice/flush`, and `/api/voice/bots/.../volume` expose them; Survivor HUD + main Voices modal both have Big Mute / Flush / per-bot Mute.
- Pause soft-mutes for catch-up on resume (`onPauseMute` / `pausedMuteMode`).
- Survivor council narration and answers use the same TTS path; TTS failures appear in the operator problems feed.
- `SurvivorCoordinator` writes public/private events to `journal.jsonl`; `SurvivorSeasonArchive` rebuilds rounds, councils, votes, private threads, and refusals for `seasons.html`.
- Recording flags can enable POV and contest-camera MP4s from generic game setup.
- Missing versus plan: TTS-synced/full-season video, clearer recording controls, and params stamps. (Mute/flush/per-bot volume/stale-cap from Quiz 7 are in.)

### Models, personas, and season params

- `bot_model_lineups.js` defines model packs and persona `systemPrompt` + voice combinations; those persona prompts are the existing “souls.”
- `game_presets.js` defines classic 11-, four-, and six-player scenarios. Cheap 4/6 shortcuts force an all-`gpt-5-6-luna-instant` cast.
- Model/profile/provider/voice/system prompt are stored per participant, but one profile applies for the whole season.
- Scenario and duration controls exist; classic Variety remains the normal default and there is no memory/briefing-volume knob.
- Missing versus plan: phase-specific effort, cheap baseline default, briefing-volume control, params archive stamp, and tiny params doc. USA/China and soul switches are correctly absent.

### End-to-end assessment

The pure rules path is substantially present and tested; an operator can run a season by babysitting live challenges and clocks. What prevents “watchable by default” is the control/proof layer: no scenario harness, clock-driven vote autofill, no mandatory re-evaluation or memory causality instrumentation, cast-destroying suspend, and incomplete audio/archive controls.

## Workstreams after quiz (draft backlog → Linear)

Order is intentional: **understand → season path → polish**.

1. **System map + Linear import** — one epic; issues from quiz gaps; park non-Survivor (colony already deprioritized / start_paused).
2. **Definition of Done: watchable mini-season** — N players, M challenges, strategy with real private talks, host-run Tribal, vote-after-council, boot → jury → winner; record or archive replay.
3. **Tribal Council upgrade** — host UX, public memory, re-eval-before-vote, "everything leads to Tribal" test scenarios in UI.
4. **Private conspiracy loop** (Quiz 4) — invites open until strategy ends (drop 30s TTL); keep prompt pressure soft + toolbox-listed; make refusals count in memory/relationships; encourage multi-person sidebars; keep room lifetime as-is; build a better conversation browser/transcript UX; diagnose underuse via a private-talk harness scenario.
5. **Memory instrumentation & drills** (Quiz 5) — instrument whether briefings are read *before* adding prompt rules; keep the relationship graph operator-only and refusal-salience redesign harness-gated; the only firm shaping is a stronger name-the-jurors lens and more council history for short seasons; add all four memory drills (council flip, refuse→grudge, private-deal→public-flip, jury resentment) to the scenario harness after the basic boot path. Deep-vs-Testing memory modes deferred.
6. **Challenges — unblock only** (Quiz 6) — dashboard skip + manual immunity + host winner override; wire pre-merge in-world team setup; curate the existing deck. Park rewards and new non-race games until after a baseline season.
7. **Audio under control** (Quiz 7) — dual Soft/Hard mute; Big Mute on Survivor + main UI; pause↔mute tie-in; flush-all queue; stale-line cap/drop; per-bot volume; keep goofy voices. **Ships in parallel with the harness.**
8. **Recording tech** (Quiz 7) — reliable POV/contest MP4s + journal (ideally together); close gaps: TTS-in-video, export/highlight friction, full-season capture, Survivor recording UI. Live speakers + Minecraft remain enough for live ops.
9. **Bounded params matrix** (Quiz 8) — start small now: all-same cheap baseline + harness default; heavier effort only at Tribal/voting; expose strategy duration, cast/scenario, and memory/briefing knobs; stamp params into archives and maintain a tiny params doc. USA-vs-China and new soul packs wait until after baseline.

## Linear import

Target: **Terminal → Begin Terminal → [Minecraft in Survivor](https://linear.app/terminaldotshop/project/minecraft-in-survivor-4ea79c9262ec)**.

The existing minimal-season issue is now the high-priority parent, and the quiz decisions are imported as acceptance-criteria-driven child issues:

1. [BEG-248 — Watchable Survivor Mini-Season](https://linear.app/terminaldotshop/issue/BEG-248/watchable-survivor-mini-season) — parent / definition of done.
2. [BEG-251 — Build live Tribal scenario harness and host-held vote path](https://linear.app/terminaldotshop/issue/BEG-251/build-live-tribal-scenario-harness-and-host-held-vote-path) — urgent first build slice.
3. [BEG-254 — Make private conspiracy usable and auditable](https://linear.app/terminaldotshop/issue/BEG-254/make-private-conspiracy-usable-and-auditable).
4. [BEG-250 — Instrument Survivor memory and relationship effects](https://linear.app/terminaldotshop/issue/BEG-250/instrument-survivor-memory-and-relationship-effects).
5. [BEG-253 — Add challenge skip, immunity override, and real tribe setup](https://linear.app/terminaldotshop/issue/BEG-253/add-challenge-skip-immunity-override-and-real-tribe-setup).
6. [BEG-249 — Replace pause/suspend with one legible cast-preserving control](https://linear.app/terminaldotshop/issue/BEG-249/replace-pausesuspend-with-one-legible-cast-preserving-control).
7. [BEG-252 — Add Survivor soft/hard mute and voice queue controls](https://linear.app/terminaldotshop/issue/BEG-252/add-survivor-softhard-mute-and-voice-queue-controls).
8. [BEG-255 — Produce a reliable Survivor season A/V + journal archive](https://linear.app/terminaldotshop/issue/BEG-255/produce-a-reliable-survivor-season-av-journal-archive).
9. [BEG-256 — Define and stamp the bounded Survivor params matrix](https://linear.app/terminaldotshop/issue/BEG-256/define-and-stamp-the-bounded-survivor-params-matrix).

Existing challenge catalog issues (`BEG-240`–`BEG-247`) remain in the project, but new challenge types are not baseline blockers.

---

## Concrete near-term steps (this engagement)

1. **Complete:** run deep quizzes (above) with operator; annotate likes/dislikes live. Quizzes 1–8 recorded.
2. **Complete:** write a code-backed **current-system map** (phases, private rooms, council, vote, memory, audio/recording, params).
3. **Complete:** translate scorecard gaps into **Linear issues** under [BEG-248](https://linear.app/terminaldotshop/issue/BEG-248/watchable-survivor-mini-season), with acceptance criteria tied to the north star.
4. **Shipped / Done in Linear:** harness + host-held vote ([BEG-251](https://linear.app/terminaldotshop/issue/BEG-251/build-live-tribal-scenario-harness-and-host-held-vote-path)), pause control ([BEG-249](https://linear.app/terminaldotshop/issue/BEG-249/replace-pausesuspend-with-one-legible-cast-preserving-control)), challenge skip/immunity/teams ([BEG-253](https://linear.app/terminaldotshop/issue/BEG-253/add-challenge-skip-immunity-override-and-real-tribe-setup)).
5. **Done:** private conspiracy usability ([BEG-254](https://linear.app/terminaldotshop/issue/BEG-254/make-private-conspiracy-usable-and-auditable)) — invite TTL until strategy ends, talk stats, force-private-meet + blindside-whisper harness, conversation browser asks/refusals/transcripts. Refusal-salience redesign remains paced by live-cast baseline under [BEG-250](https://linear.app/terminaldotshop/issue/BEG-250/instrument-survivor-memory-and-relationship-effects).
6. **Done (Quiz 7 audio):** soft/hard mute, flush, pause tie-in, stale-line age/depth cap, per-bot mute/volume — [BEG-252](https://linear.app/terminaldotshop/issue/BEG-252/add-survivor-softhard-mute-and-voice-queue-controls).
7. **Backlog next:** recording archive ([BEG-255](https://linear.app/terminaldotshop/issue/BEG-255/produce-a-reliable-survivor-season-av-journal-archive)), params matrix stamp ([BEG-256](https://linear.app/terminaldotshop/issue/BEG-256/define-and-stamp-the-bounded-survivor-params-matrix)).

---

## Open questions / unsure

- (Resolved) Linear target is **Terminal / Begin Terminal / Minecraft in Survivor**; imported under `BEG-248`.
- Should colony stay fully paused / out of the operator UI during Survivor focus?
- (Resolved in Quiz 3) Short-season jury = every eliminated bot; first harness drill = straight boot path; missing ballots block reveal.
- (Resolved in Quiz 6) Don't block the season on challenge count/variety; wire pre-merge team setup; skip + set-immunity + host override are the near-term challenge controls; rewards and new non-race types wait for a baseline season.
- (Resolved in Quiz 7) Dual Soft/Hard mute; mute on Survivor + main UI + pause tie-in; flush-all + stale-line drop; per-bot volume; keep goofy voices; mute parallel to harness; watchable = live ops + POV MP4s + journal (ideally A/V+journal); recording gaps are TTS-in-MP4, export friction, no full-season capture, thin Survivor recording UI.
- (Resolved in Quiz 8) Start a bounded matrix now; all-same cheap is baseline + harness default; heavier effort only at Tribal/voting; USA-vs-China and new soul packs wait until after baseline; souls are persona `systemPrompt`s; season knobs are memory/briefing, cast/scenario, and strategy duration; capture archive stamp + tiny params doc.

---

## Out of scope until season is watchable

- Colony epic-megabase expansion (already start_paused by default).
- Broad mindcraft refactors unrelated to Survivor loop / audio / recording.
- Endless model/soul experiments beyond the bounded pre-baseline matrix.

---

## Success check

We are aligned again when:

1. Goals and likes/dislikes are written down and match Linear.
2. Operator can run a scenario that ends in Tribal → informed vote → boot → path to jury/final.
3. Private chats actually happen in strategy without babysitting every invite.
4. Audio can be muted/unmuted without killing the season.
5. We can point at a **full mini-season** (even short) and watch it.
