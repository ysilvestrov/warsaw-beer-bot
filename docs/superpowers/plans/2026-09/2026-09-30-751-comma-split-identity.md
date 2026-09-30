# #751 Comma-Split Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover complete per-beer collaboration identity from comma-split Algolia `alias_alt` and remove the Kojetín/SomPivo brewery-wide equivalence.

**Architecture:** Add a narrow evidence pool in `lookupBeer` after its existing complete-identity path. Preserve the original `alias_alt` array, join it only for a comma-bearing candidate title, and validate full normalized title, brewery plus title, distinct bid, and ABV. Remove the pair from the curated alias table.

**Tech Stack:** TypeScript, Vitest, SQLite read-only live replay.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-30-751-comma-split-identity-design.md`; `spec.md` § Upstream identity evidence.

## Global Constraints

- No new dependency or public API change.
- `alias_alt` fragments are per-beer identity evidence, never a brewery alias.
- No production database write.
- `npm test && npm run typecheck` is the required local gate.

---

### Task 1: Pin the lookup boundary

**Files:** `src/domain/untappd-lookup.test.ts`, `src/domain/brewery-aliases.test.ts`

- [ ] Add a test with bid 6690910, `SomPivo`, `Som Pohár, Čau`, ABV 6.0 and `alias_alt: ['Měšťanský pivovar Kojetín Som Pohár', 'Čau']`; input `Kojetin Brewery / Som pohár čau 14°`, ABV 6.0. Assert `matched` and exact bid.
- [ ] Add negative tests: same-title SomPivo candidate without collaboration alias; contradictory ABV; mismatched registered title; comma-free title; two qualifying bids without deciding ABV. Assert `not_found` in each.
- [ ] Replace the pair-specific neighbor assertion in `brewery-aliases.test.ts` with a negative assertion that `Kojetin Brewery` and `SomPivo` do not share a curated brewery alias.
- [ ] Run `npx vitest run src/domain/untappd-lookup.test.ts src/domain/brewery-aliases.test.ts` and confirm the positive/negative boundary fails for the expected reason before editing production code.

### Task 2: Implement the per-beer fallback

**Files:** `src/domain/untappd-lookup.ts`, `src/domain/brewery-aliases.ts`

- [ ] Delete `['kojetin', 'sompivo']` from `ALIAS_PAIRS`.
- [ ] In `matchAgainst`, build a split-identity pool only when the candidate title includes `,`, the input title has at least two normalized tokens and equals the candidate title, and `alias_alt.length > 1`. Join the aliases with commas, base-normalize the result, require the complete base-normalized candidate title as its suffix, then compare the remaining prefix with the input via `normalizeBrewery`.
- [ ] Include this pool in the early no-evidence check. Resolve it after the original `identityHits` stage only when there is exactly one distinct `bid`; use `pickUniqueByAbv(pool, abv, true)` so known ABV contradictions decline the match. ABV cannot select between bids in this fallback. On veto, continue to independent evidence stages and other brewery search parts.
- [ ] Re-run the focused suites and then `npm test && npm run typecheck`.
- [ ] Replay issue #751 read-only against live Algolia and verify bid 6690910; ensure a same-name SomPivo negative case still yields `not_found`.

### Task 3: Review and delivery

**Files:** `spec.md`, `docs/superpowers/specs/2026-09/2026-09-30-751-comma-split-identity-design.md`, this plan, and Task 1-2 files.

- [ ] Inspect the full diff for scope and consistency with the spec, then commit only these files.
- [ ] Fetch `origin/main`, rebase if needed, and re-run `npm test && npm run typecheck` after a rebase.
- [ ] Run the required Claude cross-review, assess every finding, push the branch, open a PR, and wait for checks and review.
