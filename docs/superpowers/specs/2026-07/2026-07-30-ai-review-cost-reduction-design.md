# AI PR review — cost reduction (incremental re-review + batched verify + self-billing) — design

**Date:** 2026-07-30
**Issues:** follow-up to #175 (two-stage reviewer shipped 2026-07-29, PR #359)
**Status:** approved

## Problem

The two-stage reviewer produces good findings and costs real money. The account reconciles as:

| period | spend | what it bought |
|---|---|---|
| replay measurement, 2026-07-28 | **$5.16** | ~49 calls, one-off (config A + config B over 5 PRs) |
| CI reviews, PRs #359–#363 | **$2.52** | 11 workflow runs = 11 find calls + 29 verify calls |
| total (dashboard) | $7.76 | ≈ 5.16 + 2.52 (Δ $0.08) |

Steady state is therefore **~$0.23 per workflow run, ~$0.63 per PR**. Two thirds of the historical
bill was the one-off measurement, not the running reviewer — but the running reviewer is what
recurs, and it recurs at a multiplier.

### Where the money goes

Measured from the 11 production runs (funnel counters from the job logs; prompt sizes recomputed
offline from each PR's head commit, no API calls):

| PR | workflow runs | find calls | verify calls | find input per call |
|---|---|---|---|---|
| #359 | 3 | 3 | 12 | ~38k tok |
| #360 | 2 | 2 | 6 | ~26k tok |
| #362 | 3 | 3 | 6 | ~49k tok |
| #363 | 3 | 3 | 5 | ~7k tok |
| **total** | **11** | **11** | **29** | ~330k input tokens |

Three facts drive the design:

1. **We pay for every PR two to three times.** The workflow triggers on `synchronize`, so every push
   re-reviews the entire diff from scratch. Only 4 of 11 runs were a PR's first review. Checked
   against the PR timelines: **no force-pushes** on any of #359–#363 — every push was ordinary
   commits, so a previously reviewed head stays an ancestor of the new one.

2. **Verify is not a rubber stamp in production, but it only does one job.** It rejected 8 of 29
   gated findings (28%): 7 × `out_of_scope`, 1 × `error` (empty completion), and **zero
   `refuted`**. The replay's "0 of 22" was right about the thing verify was built for — catching
   false claims — and wrong about verify being useless. All 7 `out_of_scope` rejections are the same
   class: an accurate observation that attacks behaviour an adjacent comment declares deliberate
   ("the comment above `deduped` says same trailing numbers are collapsed intentionally";
   "`createIssue`'s catch says *Deliberately not retried*"). Verify is a design-noise filter.
   Removing it republishes those 7.

3. **Output dominates the bill, not input.** ~390k input tokens across the 11 runs cannot account
   for $2.52 at any plausible input price; the remainder is completion plus gpt-5.5's hidden
   reasoning tokens. This inverts the obvious optimisation: trimming context (e.g. dropping test
   file bodies — `matcher.test.ts` alone is 45k chars on #362) saves less than it looks, while call
   count and per-call reasoning depth are the real levers.

The trap: the only way to validate a quality-affecting change is a replay, and a replay costs $5 —
two months of reviewing at the current rate. So this design takes only the savings that do not bet
on quality, and makes the next bet cheap by instrumenting the pipeline first.

## Non-goals

Deliberately **not** in this change, because each is a quality bet that cannot be evaluated without
a paid replay, and after instrumentation we will know whether it is even worth the money:

- dropping `*.test.ts` bodies (or any file class) from the find context;
- `reasoning_effort` on either pass;
- moving the "if a comment declares the behaviour deliberate, refute the comment or drop the
  finding" rule from the verify pass into the find prompt;
- changing models.

Prefix caching is also out: the system instructions are ~570 tokens, below OpenAI's 1024-token cache
minimum, and incremental runs make the find prompt small anyway.

## Design

### 1. Review state lives inside the review

The reviewer already upserts exactly one marker review per PR. The state rides in the same body as a
hidden HTML comment:

```
<!-- ai-pr-review-state {"v":1,"head":"<sha>","findings":[…],"spend":{"usd":0.21,"runs":3}} -->
```

No new infrastructure, and the state cannot desynchronise from the text it describes because both
are written by the same PUT. Each stored finding keeps `file`, `quote` (truncated to 400 chars),
`matchedLine`, `claim`, `why_it_breaks`, `severity`, `evidence`. Caps: at most 20 open findings
carried; if the assembled body would exceed 60 000 chars, closed entries are dropped oldest-first,
then the oldest open ones, and the body says so.

A body that does not parse (hand-edited, older format, review deleted) is treated as no state — the
run falls back to a full review. Safe by construction.

### 2. Review mode

`scripts/ai-review/incremental.ts` (pure) decides, given the parsed state and three git predicates:

| condition | mode |
|---|---|
| no review / no parseable state | **full** (today's behaviour) |
| stored head object missing locally | **full** + `::notice` with the reason |
| stored head is not an ancestor of HEAD (rebase, force-push) | **full** + `::notice` |
| stored head **equals** HEAD (workflow re-run, no new commits) | **republish**: re-render the existing body, zero API calls |
| otherwise | **incremental**, base = stored head |

An incremental run diffs `stored_head..HEAD` and sends full bodies of only the files that diff
touches. The CI checkout already uses `fetch-depth: 0` on the PR head, so every ancestor is present
— **no workflow change is needed**. If the incremental diff contains no reviewable files (a
docs-only push), the find call is skipped entirely and the run goes straight to reconciliation.

The gate's `changedLineRanges` is computed from the incremental diff, so a new finding must land in
what this push changed. Findings about untouched code are not re-derived — they are carried.

### 3. Old findings: carry, close, or re-adjudicate

Every finding from the state is re-anchored against the **current** file content with the gate's
existing `locateQuoteAll` (whitespace-normalised, already handles re-indentation):

| situation | action | cost |
|---|---|---|
| quote still located | carry forward, refresh line numbers | **0 calls** |
| file unreadable or deleted | close as obsolete | 0 calls |
| quote gone (the code was edited) | **re-adjudicate**: old claim + *new* file body | 1 call per *file*, batched (§4) |

The re-adjudication verdicts read: `refuted` or `out_of_scope` → **closed, fixed**; `confirmed` →
stays open, flagged "the fix did not close this". This is where the verify pass is finally
adversarial in the way it was designed to be — it judges different code, not its own reasoning.

**Fail semantics reverse here, deliberately.** For a fresh finding, an errored verification withholds
it (never publish an unchecked claim). For a re-check, an error **keeps the finding open** with an
"unverified this run" note: it was already published on evidence, and silently dropping it on a
transient API error would lose information the maintainer is acting on.

New findings are de-duplicated against carried ones on (file, normalised quote, normalised claim) —
the gate's existing `duplicate` rule, seeded with the carried set — so a still-open finding
re-derived by the incremental find pass is not published twice.

### 4. Verify batches per file

Today: one call per finding, each re-sending the whole file body. Findings cluster in one or two
files per run (all five on #362/#363 were `identity.ts`), so the same body is paid for repeatedly.

New shape: **one call per file**, carrying the body once plus every finding against it, answering
with an array of `{index, verdict, evidence}`. Same model, same instructions, same evidence in
context; only the packaging changes. Verdicts are mapped back by index; a missing or out-of-range
index is an `error` for that finding under the fail-closed rule above. The same entry point serves
re-adjudication (§3), which is why re-checks cost one call per *file*, not per finding, when several
findings in one file were touched at once. Fresh findings and re-checks against the same file share
one call: the question is identical ("does this claim hold against this file?") and only the fail
semantics of the answer differ (§3).

Estimated effect on the measured batch: 29 verify calls → ~12, and verify input drops by roughly 70%
because bodies stop repeating.

### 5. The reviewer prints its own bill

`openai.ts` currently throws away `usage`. It will return it alongside the content, and a new pure
`scripts/ai-review/usage.ts` accumulates `prompt_tokens`, `prompt_tokens_details.cached_tokens`,
`completion_tokens`, `completion_tokens_details.reasoning_tokens` per stage, converting to dollars
through a single price table keyed by model, carrying the date it was last checked. An unknown model
prints tokens without dollars rather than a wrong number.

Output goes two places: `::notice` lines in the workflow log (per stage), and one `<sub>` line in the
review footer:

```
find 12.3k→3.1k (1.9k reasoning) · verify 2 calls · this run $0.07 · PR total $0.21
```

The PR total accumulates in the state block. This is the point of the whole exercise: the next time
we ask "what does this cost", the answer is in the review, not in an hour of dashboard archaeology.

**Price table honesty:** the gpt-5.5 numbers are filled in at implementation time from the current
pricing page and then validated against the dashboard delta of the first real run. If they disagree,
the table is wrong and gets corrected — the run's token counts are ground truth, the dollars are
derived.

### 6. Cumulative review body

`render.ts` grows two sections and keeps its counters:

- **Open findings** — carried + newly confirmed, sorted by severity, each with its quote, failure
  path and evidence (unchanged format).
- **Closed by this push** — one line each: claim + why it is closed (fixed / obsolete).
- Footer: `N raised → M gated → K confirmed · C carried · F closed`, plus the cost line, plus the
  hidden state block. "No verified findings" stays the explicit text when nothing is open.

Without the cumulative body an incremental run would erase the previous run's still-open findings,
which is precisely the failure the user flagged when choosing incremental mode.

## Modules

| File | Responsibility | Network |
|---|---|---|
| `scripts/ai-review/state.ts` | **new**, pure: parse/render the hidden state block, caps and truncation | no |
| `scripts/ai-review/incremental.ts` | **new**, pure: mode decision, re-anchoring, carry/close/re-check classification | no |
| `scripts/ai-review/usage.ts` | **new**, pure: usage accumulation, price table, formatting | no |
| `scripts/ai-review/openai.ts` | changed: return `usage` with the content | yes |
| `scripts/ai-review/verify.ts` | changed: per-file batched schema and call | yes |
| `scripts/ai-review/render.ts` | changed: open/closed sections, cost line, state block | no |
| `scripts/ai-pr-review.ts` | changed: read the existing review body before reviewing (one list call, reused by the upsert), git predicates, orchestration | yes |
| `scripts/ai-review/replay.ts` | changed: accept an explicit base so an incremental run can be replayed offline | yes |

`find.ts`, `gate.ts`, `context.ts` are unchanged. `.github/ai-review/AGENTS.md` is unchanged;
`VERIFY.md` gains only the array-answer instruction, no change to the adjudication rules.

## Testing

Every new module is pure and gets Vitest coverage before merge:

- **state**: round-trip; unparseable body → no state; quote truncation; body-size cap dropping closed
  before open; a body with no state block.
- **incremental**: the full mode-decision matrix from §2, including `stored head == HEAD` →
  republish; ancestor predicate injected, not shelled out.
- **reconciliation**: quote found → carried with refreshed lines; quote gone → queued for re-check;
  file deleted → closed; re-check verdict mapping including the error-keeps-open reversal;
  de-duplication of a re-derived finding against a carried one.
- **verify**: batched request shape; verdict mapping by index; missing index → error for that
  finding only; a file with a single finding still works.
- **usage**: accumulation across stages, unknown model → tokens only, cost arithmetic.
- **render**: open + closed sections, counters, cost line, state block placement; empty-open case.

Integration is unchanged in kind — the existing `ai-pr-review.test.ts` orchestration tests extend to
the incremental path with injected git predicates and a fake fetch.

## Expected effect

Against the measured 11-run batch:

| metric | now | after |
|---|---|---|
| find input tokens | ~330k | ~155k (−53%) |
| verify calls | 29 | ~12 (−60%) |
| verify input | full body × 29 | body × ~12, deduplicated per file |
| cost per PR | ~$0.63 | ~$0.30 |

None of it changes what the model sees when it judges freshly changed code.

## Risks

- **A reformatting-only edit moves a quote** → the finding looks "gone" and buys one re-check call.
  Bounded (one call per file per run) and the re-check answers correctly either way.
- **State bloat on long-lived PRs** → capped at 20 open findings and 60k body chars, oldest closed
  dropped first, with the body saying it happened.
- **A hand-edited review body** → state fails to parse → full review. Degrades to today's cost, never
  to a wrong review.
- **Batched verify could make verdicts less independent** than one call per finding. Accepted: the
  evidence in context is identical and the adjudication prompt is unchanged. The instrumentation from
  §5 makes it cheap to compare confirm rates before and after on live PRs — 28% rejection today is
  the baseline to watch.

## Rollout and verification

1. Merge. The first PR after merge produces a full review (no state) with a cost footer.
2. Its second push produces an incremental review; check the footer, the carried/closed counts and
   the `::notice` mode line.
3. Compare the summed footer costs against the dashboard delta for the same window. A mismatch means
   the price table is wrong, not the pipeline — fix the table.
4. Watch the verify confirm rate over the next ~5 PRs against today's 21-of-29 baseline.

`spec.md` §5.10 is updated in the same PR: review modes, the state block, per-file verify batching,
the cost footer, and the reversed fail semantics for re-checks.
