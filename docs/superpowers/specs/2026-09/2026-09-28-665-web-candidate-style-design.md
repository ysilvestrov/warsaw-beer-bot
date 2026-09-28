# #665 — web candidate style before accepting a conflicting grade

Status: approved by user choice1 after PR725 review. This supplements the existing #665 design; it does not authorize production recovery or merge.

## Measured defect

PR725's reviewer identified the exact-name early return in runWebFallback. An actual in-memory fallback probe accepts style-less Konrad10° as resolved Konrad12°/bid158057, with zero hydration calls; known input Czech Lager rejects it. Brave provides names/bid but no style. The earlier design intentionally forwarded only already-known orphan style. The approved refinement adds evidence acquisition at that boundary.

## Contract

Only an otherwise eligible accept/needs-abv web candidate whose raw name and input name carry different unique explicit integer grades7–20 needs the new lookup. Equal, missing, fractional, out-of-range or ambiguous grades do not trigger it. Existing ale markers in either raw name or known style bypass the new lookup. Already rejected brewery/name/digit candidates do not cause extra calls.

Use existing Algolia hydrateByBid([candidate.bid]) when available; adapters with search only may search the resolved name, but only the exact matching bid supplies evidence. A map entry must also carry that same bid. Never take the first unrelated search result. A missing/empty style, missing record, wrong bid, or thrown hydration is unverified: skip the candidate, log reject:style, continue to remaining candidates.

With verified style, repeat the existing grade/name/brewery gate using the original resolved candidate text and that style. Positive Czech style can reject a different grade; confirmed ale or other non-Czech style keeps the existing soft-grade behavior. No new lager vocabulary or grade parsing rule is added.

Use the exact record's ABV when available; if that field is null, preserve the same resolved candidate's already-known ABV. If both are unknown, token overlap remains uncorroborated; do not make a second ABV request for the same conflict candidate. Propagate verified style and ABV in an accepted SearchResult. Quota/cooldown and per-spent-call logging retain their existing meanings: an unverified style is not evidence of a different beer or a missing Untappd record.

## Claims and evidence

| Recorded fact | Evidence |
|---|---|
| Candidate style belongs to its bid | Exact map key AND record bid, or exact search-result bid; non-empty style |
| ABV corroboration | Exact record ABV when present, otherwise the same resolved candidate’s already-known ABV; neither missing field invents a value |
| Conflicting grades identify different Czech lagers | Existing contextual digitIdentity with verified style and original raw names |
| Candidate accepted after metadata | Repeated existing brewery/name/digit gates; existing ABV corroboration where required |
| Candidate unverified | Missing/empty style, absent/wrong-id record, or caught error; no claim that beer does not exist |
| Quota and web_tried_at | Existing spent resolver call; style lookup does not spend another Brave quota unit |

## Scope and verification

Production changes are limited to extracting the shared explicit-grade-conflict predicate from digit-identity.ts and web-fallback.ts metadata/gate handling. ResolvedBeer remains the Brave payload; optional style is a domain gate type, not an invented Brave field. No new dependencies, API schema changes, production writes or normalizer changes.

Regressions cover exact-name and token-overlap routes; verified Czech/ale/non-Czech style; unknown/empty/missing/wrong-id/throwing hydration; direct bid and search-only adapters; remaining candidate after rejection; no additional calls on unrelated controls; ABV reuse; logs/quota/cooldown. Run focused and full gates, then push the current PR head and wait for CI/AI review.
