# AI PR review — context starvation and the cost of `find`

**Date:** 2026-09-22
**Issue:** [#687](https://github.com/ysilvestrov/warsaw-beer-bot/issues/687) (opened from a spend review, not a bug report)
**Related:** [#175 two-stage reviewer](2026-07-28-ai-review-quality-design.md),
[#364 cost reduction](2026-07-30-ai-review-cost-reduction-design.md),
[baseline labels](2026-07-28-ai-review-baseline-labels.md),
[replay measurement](2026-07-28-ai-review-measurement.md)

## Problem

The reviewer's self-reported footers add up to **$26.94 over 80 runs since 2026-09-08**,
≈$17 in the last seven days. The reviewer is worth keeping — it is not the bill that is
wrong, it is what the bill is spent on.

Where the money goes, summed over the last published footer of 28 PRs:

| stage | tokens | USD | share |
|---|---|---|---|
| find input | 730k | $3.65 | 51% |
| find output | 71k | $2.13 | 30% |
| verify input | 145k | $0.72 | 10% |
| verify output | 20k | $0.59 | 8% |

`find` is **81%** of the bill. Cached input is ≈0.

Three measurements reframed the problem.

**1. Incremental mode does not shrink what it was built to shrink.** PR #671, six runs:
find input 66.5k (full) → 62.7k → 51.5k → 55.6k → 46.9k → 35.3k. The mode narrows the
*diff*; the **full HEAD bodies of the changed files are re-sent every run**, and they
dominate. That PR cost $3.22.

**2. 41% of the assembled context is the bodies of test files** — 687k of 1686k characters
over nine PRs. On #669 the context held 168k characters of test bodies and **2k of source**.

**3. The test bodies were pushing source out of the review.** `buildReviewContext` orders
file bodies by churn, and a test file changed alongside its source has more churn than the
source. When the 240 000-character budget binds, the source is what gets demoted to
diff-only. Measured, with test bodies dropped and their diffs kept:

| PR | source files sent diff-only — now → without test bodies |
|---|---|
| #670 | 31 → 8 |
| #644 | 18 → 5 |
| #662 | 13 → 4 |
| #669 | 8 → 0 |

Where the budget does not bind, the same change simply makes the prompt 38–52% smaller
(#657 −52%, #674 −48%, #673 −45%, #671 −44%).

## What was measured before designing

Every premise below was proven by a live replay **before** this document was written, per
the project's spec rule. The refuted ones are kept, because a refuted premise is the part
of a measurement that saves the next person the money.

| claim the design makes | what proves it |
|---|---|
| `find` is where the money is | footer sums above: 81% of $7.09 over 28 runs |
| the prompt cache is not a lever | prefix overlap between consecutive runs on #671 is **0%**, and 0% again with bodies reordered before the diff — churn ordering puts the just-edited file first. Do not re-litigate |
| test bodies are not needed to find defects | **1 of 38** published findings in live reviews (2026-09-08…21) targeted a test file, and its quoted line was an **added** line, present in the diff without the body. The gate drops everything `outside_changed_lines`, so any publishable finding anchors to a changed line, which is in the diff by construction |
| dropping test bodies does not cost recall | live probe on #418 at its pre-fix head: `gpt-5.6-luna` went from **2/5** known defects (bodies present) to **4/5** (bodies dropped) |
| a cheap model can hold the quality bar | see the model section; measured against the labelled corpus and a recall probe, not assumed |
| ~~repeated cheap sampling recovers recall~~ | **REFUTED.** Four independent luna runs on #418 raised `triage-plan.ts:192` and `triage-analysis.ts:118` exactly **zero** times. The gap was a blind spot, not variance — and it was caused by context starvation, not by the model |
| ~~a cheaper `find` fails because the model is weak~~ | **REFUTED** — this is the 2026-07 conclusion (config A, `gpt-5.4-mini`: 2 real / 5 false) and it did not survive re-measurement on an unstarved context |

## Design

Two changes, staged, each with its own measurement. The order is load-bearing: measuring a
model against the starved context is what produced the wrong answer in the first pass of
this very investigation.

### Stage 1 (core) — stop sending test-file bodies

`buildReviewContext` receives a reader that returns `null` for body-excluded paths, so the
file is listed as diff-only instead of embedded. Test files stay **reviewable**: their
diffs are sent, findings in them are legal, and the gate anchors them as before.

The exclusion applies to **context assembly only**. `applyGate` and `verifyAll` must keep
reading the real file — the gate locates the verbatim quote and corrects the line number,
and verify reads the body to adjudicate. Passing the filtered reader to either one turns
every test-file finding into `quote_not_found` and silently deletes a whole class of
finding. This is the one way this change can go wrong, so it gets an explicit test.

New constant beside `INCLUDE_PATTERNS`/`IGNORE_PATTERNS`:

```
BODY_EXCLUDE_PATTERNS = ['**/*.test.ts', 'tests/**/*.ts']
```

Named for what it does — excludes the *body*, not the file — because the distinction from
`IGNORE_PATTERNS` (which removes the file from review entirely) is the whole point.

The diff-only notice already in the context tells the model it is seeing only a diff for
those paths, so nothing new has to be explained to it.

### Stage 2 (periphery) — move `find` to `gpt-5.6-luna`

Prices, read off the vendor's own page on 2026-09-22:

| model | input | cached input | output |
|---|---|---|---|
| gpt-5.5 (current) | $5.00 | $0.50 | $30.00 |
| gpt-5.6-sol | $4.00 | $0.40 | $20.00 |
| gpt-5.6-terra | $2.00 | $0.20 | $12.00 |
| **gpt-5.6-luna** | **$0.20** | $0.02 | **$1.20** |
| gpt-5.4-mini *(the 2026-07 loser)* | $0.75 | $0.075 | $4.50 |

`verify` **stays on gpt-5.5**. It is the adversarial adjudicator, it is 18% of the bill,
and its prompts are small — there is no money in moving it and there is precision to lose.

Non-OpenAI candidates were compared and rejected on arithmetic, not on taste: luna is
cheaper than DeepSeek Pro ($0.60/$1.80) and GLM 5.3 FlashX ($0.37/$1.25). The only cheaper
option, DeepSeek Flash ($0.12/$0.48), buys ≈7% of the total bill in exchange for a second
vendor account, a per-model request-shape seam (`max_tokens` vs `max_completion_tokens`,
which gpt-5.x rejects), provider pinning against silent re-quantization, and
`require_parameters: true` to keep strict `json_schema` routing. Not worth it.

Projection on the 28-run sample, with `verify` unchanged:

| find | bill | change |
|---|---|---|
| gpt-5.5 | $7.09 | — |
| gpt-5.6-terra | $3.62 | −49% |
| **gpt-5.6-luna** | **$1.54** | **−78%** |

≈$17/week → ≈$3.5/week.

### What is deliberately not done

- **`reasoning_effort` is not touched.** Output is 30% of the bill and mostly reasoning
  tokens, so it looks like a lever — but it trades directly against the thing we are
  protecting, and after stage 2 the whole output line is worth ~$0.09 per 28 runs.
- **Run count is not reduced.** 2.7 runs per PR, worst case 9. The #364 decision stands:
  fixes must be reviewed too. After stage 1 the marginal run is cheap.
- **Prompt caching is not pursued.** Measured at 0%; see the table above.
- **The context budget is not raised.** Stage 1 frees roughly a third of it; spending that
  on more files is a separate question with its own measurement.

## Measurement results, 2026-09-22

Configs: `B` = gpt-5.5/gpt-5.5, `T` = gpt-5.6-terra/gpt-5.5, `L` = gpt-5.6-luna/gpt-5.5.
Corpus = the labelled PRs #344, #348, #352, #356, #358. Published findings, one run each:

| config | #344 | #348 | #352 | #356 | #358 | total |
|---|---|---|---|---|---|---|
| B | 4 | 4 | 2 | 1 | 4 | 15 |
| T | 3 | 3 | 1 | 0 | 3 | 10 |
| L | 3 | 4 | 1 | 0 | 3 | 11 |

**The baseline did not reproduce.** The same config B on the same heads gave 26 raised /
22 published in 2026-07 and **17 / 15** today. There is no determinism knob (`temperature:
0` is rejected on gpt-5.5), so a single replay is a noisy sample. Run-to-run spread,
three repeats on #358: B verified 4 / 3 / 2, L verified 3 / 3 / 2. **Always re-measure the
baseline in the same session as the candidate** — comparing against a stored number
attributes the baseline's own drift to the candidate.

Recall probe — PR #418 replayed at `584aa661`, the head the live review actually saw,
against the five findings that review produced (all five were real; the next commit is
literally `fix(#408): close all five findings from the AI review`):

| config | context | of 5 known defects |
|---|---|---|
| B | bodies present | 4/5 |
| T | bodies present | 3/5 |
| L | bodies present | 2/5 |
| **L** | **bodies dropped** (union of 3 runs) | **4/5** |
| B | bodies dropped (union of 2 runs) | 3/5 |

On the starved context `triage-analysis.ts` — the file holding one of the five — was
demoted to diff-only. Freeing the budget is what recovered it.

**Fabrications: none in luna.** Every one of its published claims was checked against the
tree it was shown and was literally true of the code. `verify` rejected one luna claim as
`refuted`, so the second stage does work against it. Terra produced one nit (`utc-day.ts`
comment arithmetic: a daily cap bounds a rolling 31-day window by 32 buckets, not 31 —
correct, but a comment, not a wrong-result path).

Spike cost: ≈$7.2.

## Keeping this repeatable

This evaluation will be repeated when the next model generation lands, and most of its cost
this time was re-deriving the method rather than running it. Three things are therefore
kept, in ascending order of how much they cost to rebuild.

**1. `replay.ts --head <sha>`.** The stock replay always uses `headRefOid`, so it can only
replay the *merged* head — where the defects a review found have already been fixed. That
measures nothing about recall, and it has now cost two investigations: the 2026-07
measurement noted it for #344, and this one repeated the mistake on #418 before catching
it. A `--head` option makes the recall probe a one-liner instead of a rediscovery.

**2. The protocol, written down** — corpus, recall probe, variance probe, labels — in
`docs/ai-review-model-evaluation.md`, with this run's numbers as the reference point. A
future evaluation should be a re-run, not a redesign. The labelling rules stay the ones the
2026-07 baseline set (`real` / `false` / `unfalsifiable`), because changing the rules
between evaluations is the same failure as not re-measuring the baseline.

**3. The price table.** `PRICES` in `usage.ts` carries only gpt-5.5 and was last checked
2026-07-30. It gains the gpt-5.6 tiers and a fresh `PRICES_CHECKED_ON`. An unpriced model
prints tokens and no dollars, which is the right failure — but it also makes the footer
useless for exactly the comparison this document depends on.

The throwaway scripts under `./tmp/` (context composition, cache-overlap, arbitrary-head
replay) are **not** kept: everything they proved is in the tables above, and the one piece
worth having again is item 1, which belongs in the real tool.

## Testing

- `BODY_EXCLUDE_PATTERNS` matching: a test path excluded, a source path not, and a source
  file whose name merely contains `test` not excluded.
- Context assembly: a test file present in `reviewable` appears in `diffOnly` and its body
  is absent from the assembled text, while its diff is still there.
- **The separation test**: the gate and verify are given the unfiltered reader, so a
  finding quoting a line inside a test file still anchors and still publishes. This is the
  regression that would otherwise be invisible — it deletes findings rather than breaking a
  run.
- Budget behaviour: when the budget binds, dropping test bodies moves source files out of
  `diffOnly`, not into it.
- Price table: gpt-5.6 tiers priced; an unknown model still returns `null` rather than $0.

## Rollout

Stage 1 ships and is watched for one week against the footer sums — expected: find input
down ~24% on average, and the `Context budget: N file(s) sent as diff only` notice naming
test files rather than source. Stage 2 is planned only after stage 1's end-to-end review,
and its own measurement is re-run against the *shipped* stage-1 context, not against
today's numbers.
