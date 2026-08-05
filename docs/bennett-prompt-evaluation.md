# Bennett Prompt A/B Evaluation

Date: 2026-08-05  
Branch: `feature/bennett-weakness-prompts`  
Baseline: `f40bcf3`  
Treatment: current worktree after the first evaluation refinement  
Model: `gpt-5.6-luna`, reasoning `none`

## Verdict

**NOT VERIFIED — do not merge this prompt treatment yet.**

The treatment passed 6 of 7 pre-registered gates. It improved generalized
policy extraction and code generation, preserved the 500-character memory
limit, and passed the full test suite. It missed the strict coordinate-noise
non-regression gate: the baseline retained one incidental coordinate across
12 memory outputs, while the treatment retained two.

The treatment is promising, especially for coding, but this test does not
establish that it will make live colony tasks finish faster.

## Falsifiable claim

On identical held-out episodes, the treatment should:

1. increase reusable-policy recall by at least 15 percentage points;
2. lose no more than 5 percentage points of task-critical fact recall;
3. keep at least 95% of memories within 500 characters;
4. retain no more incidental coordinates than baseline;
5. increase coding-requirement recall by at least 10 percentage points;
6. preserve code validity and not increase known failed strategies.

## Method

- Six memory episodes and four coding tasks.
- Two independent generations per condition: 12 memory and 8 coding outputs.
- Same model, fixtures, model settings, and retrieval behavior for both arms.
- Coding examples were selected with the production word-overlap algorithm,
  top two only.
- Held-out memory episodes showed failure followed by a successful strategy,
  but did not state the generalized rule. This tests induction rather than
  copying.
- Scoring was deterministic: task facts, generalized policy concepts,
  coordinate retention, output length, code validity, required strategy
  elements, and reuse of a known failed strategy.

Reproduction:

```sh
node scripts/evaluate-bennett-prompts.js \
  --baseline=f40bcf3 \
  --treatment=WORKTREE \
  --repetitions=2 \
  --output=results/bennett-prompt-eval-heldout.json
```

## Results

| Metric | Baseline | Treatment | Delta | Gate |
| --- | ---: | ---: | ---: | --- |
| Memory policy recall | 29.17% | 45.83% | +16.67 pp | Pass |
| Memory fact recall | 95.83% | 91.39% | -4.44 pp | Pass (≤5 pp loss) |
| Memory length compliance | 100% | 100% | 0 pp | Pass |
| Average coordinate count | 1.92 | 1.83 | -4.35% | Informational |
| Incidental coordinates | 0.083/output | 0.167/output | +100% (1 → 2 total) | **Fail** |
| Coding requirement recall | 79.17% | 93.75% | +14.58 pp | Pass |
| Valid generated code | 100% | 100% | 0 pp | Pass |
| Known failed strategy reuse | 0.25/output | 0.125/output | -50% | Pass |

## Cost and latency risk

The treatment is more verbose:

- memory instruction: 682 → 1,229 characters (+80%);
- coding instruction: 1,045 → 1,533 characters (+47%);
- generated memory: 186 → 202 average characters (+9%);
- generated code: 334 → 341 average characters (+2%).

The added instruction cost is paid on every relevant model call. Before
merging, the treatment should be shortened while preserving the measured
policy and coding gains.

## Repository verification

`npm test` passed:

- 127 tests;
- 127 passed;
- 0 failed.

The Bennett-specific tests also verify:

- MDL-style “compress/minimize words” instructions are absent;
- weak-rule and parameterization instructions are present;
- task-profile overrides use the same memory policy;
- final stored memory never exceeds 500 characters.

## Recommendation

Do not merge the current treatment as-is.

Next candidate should:

1. shorten both prompts substantially;
2. tell memory summarization to retain coordinates only when needed for a
   future action or acceptance criterion, not merely because an endpoint
   appeared in a successful episode;
3. preserve all unmet acceptance requirements and explicitly assigned room
   anchors;
4. rerun this frozen benchmark without changing its fixtures or thresholds;
5. if it passes, run a live same-seed colony canary.

Live merge gate:

- at least three same-seed runs per arm;
- ≥15% lower median wall-clock time to world-verified completion;
- ≥25% fewer identical failed-command retries;
- no increase in false task completion;
- ≤15% increase in model tokens per completed task.

The offline benchmark measures the intended intermediate behavior. Only the
live canary can verify the product claim that bots complete tasks faster.
