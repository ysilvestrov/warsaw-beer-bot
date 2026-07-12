# Orphan-triage prompt tuning — design

**Date:** 2026-07-07
**Scope:** prompt-text only (`buildTriagePrompt` in `src/domain/triage-analysis.ts`) + its
tests + `spec.md §5.11`. No schema, trust-boundary, or surrounding-code changes.

## Motivation

Quality review of the first live run (issues #234–236, 2026-07-07) confirmed the triage is
accurate and well-selected, but surfaced three prompt weaknesses that send a fixer to the
wrong place:

1. **Fuzzy parser/matcher boundary for query noise.** `matcher_bug` already lists "noise
   tokens in the query", yet the model classified `30875` (query dropped the `BROWAR` token →
   `NOWY GDAŃSKI`) and all of #236 (bracketed adjunct lists, ABV/spec strings, dangling collab
   parens) as `parser_bug` with a "fix the adapter" hypothesis. These are query-normalisation
   problems on the matcher side, not adapter field-split bugs.

2. **Garbled upstream source data mislabelled `parser_bug`.** `30617 BRAURIE KEESMANN` and
   `31262 NAPOMUCEN` are typos in the *shop's own listing*. Our adapter read them faithfully;
   there is no adapter fix. The prompt has no rule distinguishing "our adapter corrupted a clean
   source" from "the source is already garbage".

3. **Issue bodies lack findability.** Bodies carry hand-picked examples but no machine-findable
   pointer to the full population, so a fixer only sees the examples. (The agent sees only the
   50-row batch, so it cannot and must not state a global count.)

## Changes to `buildTriagePrompt`

### Change 1 — explicit parser/matcher boundary test

Insert a decision rule before the class list:

> Key test: looking at the shop page, are the brewery+name fields essentially correct?
> - **Yes, but we still missed the match** — brewery alias gap, name divergence, OR the name
>   carries noise that only needs stripping before search (bracketed adjunct lists, ABV/spec
>   strings, collab parentheticals, dropped/extra tokens in the query) → **matcher_bug** (fix in
>   matcher / query normalisation / aliases).
> - **No — the row itself is wrong data** (merch/glassware/wine/food, brewery and name split
>   wrongly, truncated, HTML noise, brewery field is a shop/ingredient token) → **parser_bug**
>   (fix in the adapter).

Effect: `30875` and the whole #236 cluster become `matcher_bug`.

### Change 2 — garbled upstream ≠ parser_bug

Extend the `parser_bug` definition: parser_bug is **only** when our adapter corrupted an
otherwise-clean source. If the shop's own listing is garbled (typos in the shop's data itself —
e.g. `BRAURIE KEESMANN`, `NAPOMUCEN`), the adapter read it correctly → not parser_bug. Then:
if a plausible candidate exists that fuzzy/edit-distance matching could rescue → `matcher_bug`;
if the search returns nothing (candidates = 0) and there is nothing to rescue → `wontfix`.

### Change 3 — findability line, no fake counts

Extend the new-issue-body instruction:

> End the body with a **Scope** line giving a machine-findable filter, e.g.
> `Scope: all orphans in this class — enrich_failures WHERE review_class='matcher_bug'`.
> Label the examples as "from today's batch". Do **not** state a total count — you only see the
> current batch. If two patterns share the same fix, merge them into one issue.

## Tests

`src/domain/triage-analysis.test.ts` — existing assertions stay green (they check class names,
caps, data-only marker). Add assertions that the prompt contains:
- the parser/matcher boundary phrasing (e.g. `essentially correct`),
- the source-garble rule (e.g. `adapter read it correctly`),
- the Scope-line convention (`WHERE review_class=`).

## Spec

Update `spec.md §5.11` (and the `review_class` row at line ~347) so the class boundary rule and
the Scope-line convention are recorded there as source of truth.

## Out of scope

Schema, `planTriageActions` trust boundary, GitHub/DB write ordering, digest format, LLM
provider config — all unchanged.
