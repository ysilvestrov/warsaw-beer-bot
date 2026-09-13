# #613 — collab-token boundary rescue

**Date:** 2026-09-13  
**Status:** approved  
**Issue:** #613

## Problem

The internal enrich cron stores beer 36588 as:

```text
Funky Fluid X MultiQlti Brewery / Birthday Cookie MultiQlti 2026 36° @ 13%
```

The live Algolia query on 2026-09-13 returned three strict-brewery candidates:

| bid | name | ABV |
|---:|---|---:|
| 5989079 | Birthday Cookie: Multi Qlti 2024 | 13% |
| 6852067 | Birthday Cookie: Multi Qlti 2026 | 13% |
| 5526331 | Birthday Cookie: Multi Qlti (2023) | 12% |

`brewerySearchParts` already searches the leading brewery, `Funky Fluid`, so the brewery gate is
not the defect. The name stage normalizes the input to `birthday cookie multiqlti` and each
candidate to `birthday cookie multi qlti`. The direct token-coverage branch misses: its floor is
0.75, while `multiqlti` scores 0.56 against `multi` and 0.44 against `qlti`. The collab-aware
swapped-brand fallback still admits all three candidates to the near-name cohort with score 1.
The score/popularity resolver cannot choose among them, so the stage returns terminal `not_found`.
A one-candidate fixture masks that cohort ambiguity because the resolver accepts its sole scored
candidate.

The input year is also unavailable to `lookupBeer` candidate selection. Query cleanup and
`normalizeName` correctly remove a standalone year, while only the local-catalog matcher currently
reads the raw year through `extractYear`. ABV cannot select the 2026 record because the 2024 record
also has 13% ABV.

## Decision

Add a strict collab-token boundary rescue to `lookupBeer` at the strict-only near-name stage's
existing terminal refusal. It runs only after that stage has found an approximate top cohort but the current
score/popularity resolver cannot choose one `bid` and would otherwise return `not_found`.
Existing matches therefore keep their current result and provenance; the rescue never preempts a
result selected by an existing stage.

The rescue accepts a candidate only when every condition below holds:

1. The candidate passed the existing strict brewery gate.
2. The input brewery is a collaboration with at least two normalized parts.
3. One complete normalized collab-part token occurs in the normalized input beer name.
4. Replacing that one input token with two or more adjacent candidate tokens whose concatenation is
   exactly equal makes the two normalized names token-for-token equal. No fuzzy comparison is used.
5. The input and candidate carry the same explicit four-digit year.
6. Both ABVs are known and differ by no more than `ABV_TOLERANCE`.
7. Exactly one distinct `bid` satisfies all conditions.

Condition 4 permits `MultiQlti` to reconcile with `Multi Qlti`, but does not make arbitrary token
boundaries equivalent. The merged token must be an independently supplied collab participant, all
other name tokens must already agree, and year plus ABV must corroborate the candidate.

If no candidate or more than one distinct candidate survives, `lookupBeer` remains `not_found`.
Inputs without a four-digit year or known ABV do not use this rescue.

## Placement

Keep the helper and rescue inside `src/domain/untappd-lookup.ts`. This rule belongs only to Untappd
enrichment: it needs the raw search-result cohort, the collab brewery parts, year, and ABV together.
It must not change `normalizeName`, `nameKeys`, the local `/match` catalog path, fuzzy thresholds, or
the order-independent popularity resolver.

The live #613 cohort reaches the strict-only near-name stage, where the collab-aware swapped-brand
comparison scores all three candidates at 1. The current resolver then refuses the tied cohort
because no candidate meets the popularity-dominance rule. Place the rescue after that resolver
returns no winner and immediately before the same terminal `not_found`. Putting it at Stage 2b or
after the flagship block would be dead code for this cohort because near-name returns early;
putting it before the resolver could replace an existing successful result.

The rescue returns the ordinary `{ kind: 'matched', result }` outcome. Existing callers continue
through `applyLookupOutcome`, so server cron and client relay receive the same behavior without a
new API or storage path.

## Rejected alternatives

- A `MultiQlti` spelling table would fix one brand but leave the underlying parser-preserved token
  boundary defect in place.
- Globally ignoring token boundaries would also equate unrelated segmentations and weaken every
  name match.
- Filtering the strict candidate pool by year before current fuzzy matching would let a year turn a
  weak shared-token fallback into identity. The rescue instead requires exact boundary repair,
  matching year, matching ABV, and a unique bid.
- Using ABV alone cannot distinguish this cohort because both the 2024 and 2026 records are 13%.

## Claims and evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `beers.untappd_id = 6852067` through the existing `recordLookupSuccess` path | orphan 36588 is the 2026 Untappd beer | strict `Funky Fluid` brewery; `MultiQlti` is an input collab part and exactly equals candidate tokens `Multi Qlti` when joined; all other normalized name tokens agree; both raw names say 2026; both ABVs are 13%; no second bid satisfies the same evidence |
| Existing `enrich_failures` row removed by the existing matched-outcome path | the last enrich failure no longer describes the beer | the same successful `lookupBeer` outcome above; no new deletion path is introduced |

The design adds no cursor, cache, coverage range, or verdict. The matcher computes its evidence from
one search response and records through the existing success transaction.

## Tests

Add public-seam tests beside the existing `lookupBeer` tests:

- the recorded three-candidate #613 cohort resolves to bid 6852067;
- reversing the candidate order keeps bid 6852067;
- a matching boundary and ABV with only wrong-year candidates stays `not_found`;
- a matching year and boundary with missing or contradictory ABV stays `not_found`;
- the same boundary difference outside a collab-part token stays `not_found`;
- any other token difference, including a one-letter token, stays `not_found`;
- two same-year, same-ABV bids satisfying the repair stay `not_found`;
- the existing one-candidate fallback and scored-candidate suites remain unchanged.

The first test is the red/green regression instrument. After implementation, repeat the live
Algolia probe and run the full gate: `npm test && npm run typecheck`.

Before closing #613, run `npm run adjudicate -- --issue 613` against the production row. A
`rescued` verdict confirms that the shipped matcher settles beer 36588; apply the produced verdict
file as required by the orphan adjudication runbook.

## Scope

Expected implementation files:

- `src/domain/untappd-lookup.ts`
- `src/domain/untappd-lookup.test.ts`

This change does not modify the database schema, query construction, extension code, public API,
backoff policy, or orphan ownership.
