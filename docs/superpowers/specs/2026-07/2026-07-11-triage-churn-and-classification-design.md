# Triage churn + classification accuracy — design

**Date:** 2026-07-11
**Status:** approved (brainstorm) → pending implementation plan
**Related:** #236 (closed, split into #269/#270/#271, routed to #254), prior triage specs
`2026-07-05-orphan-triage-agent-design.md`, `2026-07-07-orphan-triage-prompt-tuning-design.md`

## Problem

The daily orphan-triage agent appends the *same* beers to the same issue day after day, and its
diagnoses are often already-implemented or mis-attributed. Investigating #236 exposed two
independent root causes:

1. **Selection churn.** `recordEnrichFailure`'s `ON CONFLICT` clause resets
   `review_class = NULL` on **every** re-failure (`src/storage/enrich_failures.ts:34`).
   `listUntriagedFailures` selects `WHERE review_class IS NULL`. So any on-tap beer that keeps
   re-failing enrichment has its classification wiped and re-enters triage the next day
   unchanged — and the LLM re-files it as a fresh example. This, not a flood of new beers, is
   what bloated #236.

2. **Classification inaccuracy.** `buildTriagePrompt` asks the model to diagnose from the raw
   `name` string. It therefore proposes fixes the query builder already performs (e.g. "strip
   `(puszka)`", already dropped by `stripSearchNoise` since #239) and does not use
   `candidates_count` to tell a *search* miss (`0` candidates → query/alias problem) apart from a
   *match* miss (`>0` candidates → fuzzy/alias/name-divergence problem). Verified against prod:
   `search_url`'s `q=` param **already holds the cleaned query** (e.g. beer 30294 `name =
   "Jubilance (Pure Bedlam Collab)"` → `q=StarKraft Jubilance`, `candidates_count = 1`), so the
   signal to avoid these mistakes is already in the payload but unused.

## Goals

- An unchanged re-failure of an already-classified beer does **not** re-enter triage (kills the
  churn), while a beer whose search result materially changes **does** get re-triaged.
- The triage model stops proposing already-implemented query-noise fixes and correctly routes
  `candidates_count > 0` misses to the match side.

## Non-goals

- The actual matcher/query fixes (#269 `normalizeName ⊇ stripSearchNoise`, #270 `COLLAB_SEP`
  over-split, #271 bare adjunct tails, #254 name-divergence/alias). This spec only changes the
  triage *pipeline*, not the matcher.
- Retroactive re-arming of existing stale rows (that is the separate `rearm-aliased-orphans` op).

## Design

### Lever A — Selection: sticky classification with a boundary re-trigger

Change the `ON CONFLICT(beer_id) DO UPDATE` clause in `recordEnrichFailure`
(`src/storage/enrich_failures.ts`) so a re-fail preserves the existing classification **unless the
`candidates_count` crosses the `0 ↔ >0` boundary**. On a crossing, reset the triage fields to
re-open the row; otherwise keep them and just bump `fail_count` / `last_at` / refresh diagnostics.

```sql
ON CONFLICT(beer_id) DO UPDATE SET
  brewery            = excluded.brewery,
  name               = excluded.name,
  search_url         = excluded.search_url,
  source_url         = excluded.source_url,
  outcome            = excluded.outcome,
  candidates_count   = excluded.candidates_count,
  candidates_summary = excluded.candidates_summary,
  fail_count         = enrich_failures.fail_count + 1,
  last_at            = excluded.last_at,
  review_class = CASE
    WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
    THEN NULL                              -- signal changed → re-open for triage
    ELSE enrich_failures.review_class      -- unchanged → stay classified & silent
  END,
  review_note  = CASE
    WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
    THEN NULL ELSE enrich_failures.review_note END,
  reviewed_at  = CASE
    WHEN (enrich_failures.candidates_count = 0) <> (excluded.candidates_count = 0)
    THEN NULL ELSE enrich_failures.reviewed_at END
```

Semantics of the boundary predicate `(old.candidates_count = 0) <> (new.candidates_count = 0)`:

| old cand | new cand | crossed? | review_class |
|----------|----------|----------|--------------|
| 0        | 0        | no       | preserved (incl. already-NULL) |
| >0       | >0       | no       | preserved |
| 0        | >0       | **yes**  | reset to NULL (a query/alias fix now surfaces candidates — worth re-examining) |
| >0       | 0        | **yes**  | reset to NULL |

This applies uniformly to all classes, including `not_on_untappd` / `wontfix`: a `wontfix` beer
that stays `cand=0` stays silent; if it newly gains candidates it re-opens, which is the correct
behaviour. `isWontfix()` semantics are unaffected between crossings.

**Transitional note:** rows currently sitting at `NULL` (already re-nulled by the old code) will
get one more classification pass on their next triage run, then settle sticky. Expect one final
churn batch, not indefinite churn.

### Lever B — Classification: exploit `search_url` and `candidates_count` in the prompt

`search_url` (the cleaned query) and `candidates_count` are already in each orphan payload; the
prompt just never leverages them. Three additions to `buildTriagePrompt`
(`src/domain/triage-analysis.ts`):

1. **Decode the query into an explicit field.** In `boundOrphan`, add a derived `search_query`
   field = the URL-decoded `q=` param of `search_url` (fallback to `''` if unparseable). This
   spares the model from decoding URL-encoding to see the real post-normalisation query. No
   storage change — purely derived at prompt-build time, capped like the other text fields.
   *Verify during implementation* that `search_url`'s `q=` equals the actual Algolia query
   (`cleanSearchQuery(brewery, name)`) — confirmed for sampled prod rows (30278/30294/30888). If
   `buildSearchUrl` and `cleanSearchQuery` can diverge, derive `search_query` from
   `cleanSearchQuery(brewery, name)` directly instead of parsing the URL.

2. **Pivot on `candidates_count`.** Add to the classification instructions:
   - `candidates_count > 0` → the search **works** and returned candidates; the miss is on the
     **match** side (fuzzy threshold, brewery alias, name divergence). Do **not** diagnose
     "strip query noise" — route to the match-side issue.
   - `candidates_count = 0` → the search found nothing; a **query-noise or brewery-alias**
     problem.

3. **Already-handled guard.** State that `search_query` **is** the query after normalisation: if
   a noise token visible in `name` (brackets, parentheticals, `%`/`°`/`alc`/`abv`/`ibu`) is
   already **absent** from `search_query`, it is already stripped — do not propose stripping it
   again.

No change to the tool schema (`ANALYSIS_TOOL_SCHEMA`) or `VerdictSchema`; this is prompt text plus
one derived input field.

## Data flow

Unchanged end-to-end shape. `applyLookupOutcome` → `recordEnrichFailure` (now conditional reset)
→ nightly `listUntriagedFailures` (unchanged query) → `buildTriagePrompt` (now includes
`search_query` + sharper instructions) → LLM `submit_triage` → issue routing (unchanged).

## Testing

- **Storage** (`enrich_failures.test.ts` or sibling): re-fail with same-side `candidates_count`
  keeps `review_class`/`review_note`/`reviewed_at`; a `0→N` and an `N→0` re-fail null them; both
  cases bump `fail_count` and update `last_at`/diagnostics.
- **Prompt** (`triage-analysis` test): `buildTriagePrompt` output contains the `candidates_count`
  pivot wording and the already-handled guard; `boundOrphan` emits a decoded `search_query`
  (assert on a `%`-encoded `q=`). Matches the existing string-assertion style.
- **LLM behaviour**: not unit-testable; rely on the existing daily canary / manual review of the
  first post-deploy run.

## Spec.md impact (required in the implementation PR)

`spec.md` §3.13 lines 361–362 currently state the unconditional reset
(«повторний провал … скидає `review_class` … до `NULL`»). The implementation PR **must** update
that paragraph to describe the conditional (boundary-crossing) reset, per the CLAUDE.md spec rule.

## Rollout

Standard: implement on a worktree branch with tests, PR + AI review loop, then `deploy.sh` on this
host. No migration (the `ON CONFLICT` change is code-only; column set is unchanged). Watch the
first nightly triage run to confirm the churn drops and no legitimately-changed beer is starved of
re-triage.
