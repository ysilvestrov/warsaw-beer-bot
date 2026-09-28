# #665 — web candidate style implementation

Approved design: docs/superpowers/specs/2026-09/2026-09-28-665-web-candidate-style-design.md.
Worktree: .worktrees/issue-665; branch fix/issue-665; PR725. User choice1 approves the review refinement. The recorded human decision was answered through pr-snapshot before implementation.

## W1 — grade conflict predicate and tests

- Extract/export explicitGradesContradict(NameDigits,NameDigits) using the existing singleIntegerGrade implementation. czechGradesContradict delegates only that grade portion; style/ale rules stay unchanged.
- Red tests pin unique different integer7–20, equal decimals/duplicates, ambiguity/fractional/out-of-range/missing/soft-only controls.
- Add actual runWebFallback red regressions for candidate-only Czech style, direct/search exact-bid verification, unknown/failed metadata and both acceptance routes. Use literal expected ids/null, metadata and query counts. Fixture callbacks may route external responses; no conditional assertions or mirror algorithms.

## W2 — metadata boundary

- Domain candidate type extends ResolvedBeer with optional style. evaluateCandidate supplies candidate.style; accepted SearchResult preserves verified style.
- Only accept/needs-abv plus explicit grade conflict and no existing ale marker triggers hydration. Use hydrateByBid when supplied, otherwise search the candidate name and find its exact bid. Reject missing/nonmatching records or empty style.
- Re-evaluate with verified style; unverified metadata logs reject:style. Continue through remaining candidates; retain existing rejection and quota/cooldown behavior.
- Reuse hydrated ABV on needs-abv without another call; other candidates retain existing best-effort ABV handling.
- Focused green; full npm test && npm run typecheck; main-thread correctness/API/reliability/test review and commit.

## W3 — publish and finish review

- Update spec.md and the PR description with the approved evidence/call boundary and final validation.
- Normal push to the existing PR head (no rebase/force push under the review envelope).
- Reply with the concrete fix/test evidence, classify the old review body, then snapshot with the existing invocation identity.
- Resume the owned watcher; address valid feedback and wait for current-head CI/AI review. No merge or production recovery.

Small staged refinement, three tasks; no independent implementation agents per AGENTS.md tool mapping.

## W1/W2 receipt

Seventeen named assertions failed against the old fallback before implementation; the token-overlap stage control itself passed. Focused tests199 passed; full gate3774 passed,1 skipped; both typechecks passed. The live exact-bid Algolia probe returned158057/Konrad12°/Pilsner - Czech / Bohemian/5.2, with Guinness canaries passing before and after. Repeating the original actual fallback probe now rejects the twelve with one name query on its search-only adapter; known input Czech style still rejects without hydration. No production data was changed.

Main-thread review verified exact map key AND record bid, search-only exact-bid filtering, non-empty style, reevaluation before both acceptance branches, ale/unique-grade call boundaries, null-ABV reuse without a second query, remaining-candidate continuation and unchanged quota/cooldown. Global digit identity behavior stays covered by the existing boundary matrix; the extracted predicate uses the same singleIntegerGrade implementation. No public request schema or Brave payload changes.

Logs: /tmp/issue-665-web-style-{red,green,gate}.log; probes /tmp/issue-665-web-review-probe.ts and /tmp/issue-665-live-web-style.{ts,log}. Fresh PR-head AI review remains the W3 publishing check.
