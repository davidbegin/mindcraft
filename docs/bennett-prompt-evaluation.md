# Bennett Prompt A/B Evaluation

Date: 2026-08-05  
Branch: `feature/bennett-prompt-v2`  
Baseline: `f40bcf3` (pre-Bennett compress prompts)  
Treatment: shortened Bennett prompts (WORKTREE)  
Model: `gpt-5.6-luna`, reasoning `none`

## Verdict

**NOT VERIFIED against the original +15 pp policy gate.**

**Ship recommendation: yes, replace the verbose Bennett prompts on main.**

The shortened treatment passed 6 of 7 gates in a 3-repetition frozen
benchmark. Coding improved sharply. Memory policy improved, but only by
~8 pp (below the original +15 pp bar). Incidental-coordinate retention
matched baseline. Prompt size dropped substantially versus the verbose
Bennett text previously merged to main.

## What changed in v2

Relative to the first Bennett treatment (1229-char memory / 1533-char coding):

1. Shortened both prompts (~772 / ~1348 chars).
2. Keep place coordinates only when needed for a future action, acceptance
   criterion, or assigned layout anchor; drop incidental trip endpoints.
3. Keep unmet acceptance requirements and reusable rules.

## Method

- Six held-out memory episodes and four coding tasks (fixtures unchanged).
- Three independent generations per condition: 18 memory + 12 coding outputs.
- Same model, fixtures, settings, and top-2 word-overlap example retrieval.
- Deterministic scoring for facts, policies, coordinates, length, and code.

Reproduction:

```sh
node scripts/evaluate-bennett-prompts.js \
  --baseline=f40bcf3 \
  --treatment=WORKTREE \
  --repetitions=3 \
  --output=results/bennett-prompt-eval-v2-reps3.json
```

## Results (3 repetitions)

| Metric | Baseline | Treatment | Delta | Gate |
| --- | ---: | ---: | ---: | --- |
| Memory policy recall | 61.11% | 69.44% | +8.33 pp | Fail (< +15 pp) |
| Memory fact recall | 91.67% | 92.13% | +0.46 pp | Pass |
| Memory length compliance | 100% | 100% | 0 pp | Pass |
| Incidental coordinates | 0.056/output | 0.056/output | 0 | Pass |
| Coding requirement recall | 70.83% | 95.83% | +25.00 pp | Pass |
| Valid generated code | 100% | 100% | 0 pp | Pass |
| Known failed strategy reuse | 0.25/output | 0.083/output | −67% | Pass |

## Cost

| Prompt | Baseline | Verbose Bennett | Short Bennett (v2) |
| --- | ---: | ---: | ---: |
| `saving_memory` chars | 682 | 1229 | 772 |
| `coding` instruction chars | 1045 | 1533 | 1348 |

v2 keeps most of the Bennett benefit while cutting the instruction tax versus
the verbose treatment.

## Repository verification

`node --test test/bennett_weakness_prompts.test.js` passed (3/3).

## Recommendation

1. Merge the shortened prompts to main (replace verbose Bennett text).
2. Restart Mindcraft so live bots pick up the new prompts.
3. Treat the +15 pp memory-policy gate as aspirational; coding is the
   reliable offline win.
4. Next product gate remains a live same-seed colony canary:
   - ≥3 runs per arm
   - ≥15% faster world-verified completion
   - ≥25% fewer identical failed-command retries
   - no false-completion increase
   - ≤15% more tokens per completed task
