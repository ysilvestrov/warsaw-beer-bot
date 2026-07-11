# Shared structural-noise normalization — design

**Date:** 2026-07-11
**Status:** approved
**Related:** #269, #236/#239, #240/#256

## Problem

The orphan-enrichment pipeline applies `stripSearchNoise()` while building the
Algolia query, but `normalizeName()` still consumes the unstripped raw name.
Consequently, search can return the correct candidate and the downstream exact,
name-key, and fuzzy paths can reject it because structural packaging or
collaboration annotations remain in the input normalization.

Confirmed production examples include:

- `Nonalco Matcha IPA (puszka)` versus `Nonalco Matcha IPA`;
- `Free Pan Da (puszka)` versus `Free Pan Da`;
- `Ole! (puszka)` versus `Ole!`;
- `Jubilance (Pure Bedlam Collab)` versus `Jubilance`.

`NoLo – Hemperor <0,5% alc <0,5%` (beer 12082) is not a separate current-code
matcher defect. A local reproduction confirms that `Piwne Podziemie Brewery`
passes the existing alias gate to `Piwne Podziemie / Beer Underground`, both
names normalize to `nolo hemperor`, and `lookupBeer()` returns `matched`. Its
recorded production failure is therefore stale or depended on candidate data
not represented by the reported brewery/name pair. It remains a regression
case for this change.

## Goals

1. Make match-name normalization use the same structural-noise policy as search.
2. Apply the policy symmetrically to input and catalog names through the shared
   `normalizeName()` entry point.
3. Re-arm already-attempted, reviewed matcher failures for which search returned
   candidates, so terminal or long backoff does not prevent the fix taking effect.
4. Preserve the existing matcher architecture, thresholds, brewery gates, and
   false-positive guards.

## Non-goals

- No fuzzy-threshold or brewery-alias changes.
- No broad matcher refactor or new normalization abstraction.
- No claim about the total number of affected production rows.
- No automatic database mutation during startup or deployment.
- No browser-extension behavior or changelog change.

## Considered approaches

### 1. Route `normalizeName()` through `stripSearchNoise()` — selected

This fixes the divergence at its source. Exact matching, fuzzy matching,
`nameKeys()`, persisted normalization at write time, and other existing callers
inherit one symmetric rule without call-site duplication.

### 2. Strip noise only in matcher and lookup call sites

This appears narrower, but repeats policy across several paths and leaves other
`normalizeName()` consumers inconsistent. Future paths could recreate the same
bug.

### 3. Replace search and match normalization with a new abstraction

A unified normalization pipeline could be cleaner in isolation, but it would be
an unnecessary architectural change for a small, well-bounded defect.

## Design

### Shared name normalization

`normalizeName(raw)` will pass `raw` through `stripSearchNoise()` before the
existing decimal-identifier preservation, base normalization, style/spec token
filtering, and numeric-noise filtering.

The ordering is important:

1. structural groups and strength/spec fragments are removed from the raw text;
2. legitimate decimal identifiers in the surviving name are protected;
3. punctuation, case, and diacritics are normalized as today;
4. existing style, spec-label, and numeric token rules remain unchanged.

Because catalog candidates and inputs both call `normalizeName()`, clean names
remain equal and noisy/clean variants converge. `nameKeys()` also inherits the
same behavior because it normalizes each side through `normalizeName()`.

`stripSearchNoise()` remains the single structural-noise helper. Its tests will
cover balanced and stray brackets, specification strings, wrapping quote marks,
and trailing punctuation while preserving internal punctuation that is part of
an ordinary name, such as the colon in `Dynaboost: Mosaic`.

### Lookup and matcher behavior

No matching stages, scores, or gates change. Tests exercise the public behavior:

- reported packaging/collaboration suffixes match their clean candidates;
- exact/name-key/fuzzy paths continue to use symmetric normalization;
- 12082 passes through the existing bilingual brewery alias and exact name path;
- the full matcher suite guards against unintended false positives.

### Targeted re-arm

A dedicated operator script will select rows by joining `beers` and
`enrich_failures` and requiring all of:

```sql
b.untappd_id IS NULL
AND b.untappd_lookup_count > 0
AND ef.review_class = 'matcher_bug'
AND ef.candidates_count > 0
```

This is the issue's documented class: search produced candidates, but matching
failed. It deliberately avoids zero-candidate search failures, other review
classes, already-matched rows, and never-attempted rows that are already eligible.

The script will reuse the existing transactional `applyRearm()` helper from
`scripts/rearm-aliased-orphans.ts`. It is dry-run by default, prints selected
brewery/name/count rows, and requires `--apply` to set
`untappd_lookup_count = 0` and `untappd_lookup_at = NULL`. A second selection is
empty because reset rows no longer satisfy `lookup_count > 0`, making application
idempotent. The script performs no Untappd requests; the normal enrichment job
does the retried lookups.

## Testing

Tests will be added before production changes and observed failing for the
expected reason.

- `normalize.test.ts`: structural suffixes, brackets, specifications, wrapping
  quotes, trailing punctuation, clean-name symmetry, and preservation guards.
- `untappd-lookup.test.ts`: the issue examples resolve when the correct candidate
  is present; 12082 proves the brewery gate is not the blocker.
- Re-arm script tests: exact selection criteria, exclusions, transactional reset,
  dry-run-safe core behavior, and idempotency.
- Existing matcher, normalization, lookup, script, typecheck, and full Vitest
  suites must remain green.

## Operational flow

1. Merge and deploy the matcher change.
2. Run the new re-arm command without `--apply` and review its target list.
3. Run it with `--apply`.
4. Allow the normal enrichment job to retry the reset rows.
5. Successful matches clear their `enrich_failures` rows through the existing
   `applyLookupOutcome()` behavior.

## Safety

- Selection follows the issue's review-class and candidate-count boundary.
- Mutation is explicit, dry-run first, transactional, and idempotent.
- No network traffic occurs in the maintenance script.
- Matcher thresholds and brewery gates are unchanged.
