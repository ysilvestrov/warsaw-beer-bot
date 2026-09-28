# #665 core review — proposed selection amendment

Status: draft, awaiting user decision. Date:2026-09-28.
This supplements the approved identity design; it does not change code or authorize production writes.

## New evidence

The independent Claude review found a valid selection gap. With Konrad12° orphan37334, KonradSvetléVýčepní10 row45, and a constructed grade-less KonradDémon row99, the current core rejects37334 but chooses99 at confidence1. The real fast-fuzzy probe confirms this, with and without45. Démon is absent from the current production catalog.

The current design permits missing grades but also promises that the absence of an eligible candidate yields a miss rather than an arbitrary sibling. The grade veto alone does not establish which remaining sibling is the requested grade.

## Recommended clarification

After a contextual Czech grade veto removes a relevant exact/anchored candidate or an above-threshold fuzzy result, fuzzy selection may use only candidates carrying positive numeric evidence for the input grade. An equal explicit grade (10°/10*) or equal existing soft number (KonradSvetléVýčepní10) provides that evidence. A missing grade, ABV, year or hard batch number does not provide it. Keep the original brewery bucket, fallback budget, scores and memoized searchers.

This is a selection guard for the path newly opened by this Czech veto. It does not change context-free digitIdentity, grade parsing, unrelated fuzzy selections, authoritative bids or human pins. The approved requirement that a missing grade is not itself a digit-identity contradiction remains true; this guard controls whether that candidate is supported enough to win after another grade was explicitly rejected.

With the three-row fixture above,45 should win. With only37334 and grade-less99, the result should be null. If the genuine Untappd candidate omits its grade, this conservative path may miss it. That tradeoff favors a missing answer over a wrong beer and must be explicitly agreed before implementation.

## Conservative alternative

Stop at null whenever the contextual veto removes an otherwise matching exact/anchored candidate, without opening fuzzy selection. This prevents an arbitrary sibling from winning but also leaves the original Konrad10° case unmatched even while row45 is available. It restores the previous fail-closed selection boundary; it does not fulfill the preferred goal of selecting45.

## Claims and evidence

| Recorded fact | Required evidence |
|---|---|
| fuzzy match result after Czech veto | Same-brewery/name gates plus an equal explicit grade or existing soft grade number, not merely absence of contradiction |
| match_links or cleanup merge consuming that result | The guarded result above; unchanged confidence threshold alone is insufficient evidence of grade identity |
| unmatched input | No candidate in the existing selection pool satisfies the guard; no inference that Untappd has no such beer |

## Verification after approval

Add real-searcher fixtures with the shorter grade-less sibling, with and without45, and multiple conflicting11°/12° rows. Assert exact ids or null. Retain the original Konrad regression, context-free/ale controls, cache delivery and fallback budget tests. Re-run the full gate and core review before peripheral planning. No production recovery or spec.md propagation starts on this draft.
