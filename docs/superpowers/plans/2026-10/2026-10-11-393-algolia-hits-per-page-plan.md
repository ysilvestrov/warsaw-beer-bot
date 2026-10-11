# #393 Raise Algolia hitsPerPage to 15 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise `ALGOLIA_HITS_PER_PAGE` from 5 to 15 to prevent truncation of sibling candidate pools in Untappd Algolia search, resolving #393 and eliminating false positives and missing matches on variants.

**Architecture:** Update `ALGOLIA_HITS_PER_PAGE = 15` in `src/sources/untappd/algolia.ts`. The `/enrich/candidates` endpoint passes this value to clients, so extension clients dynamically request 15 items without code changes. Update server contract tests, add sibling-pool integration tests in `src/domain/untappd-lookup.test.ts`, update `spec.md`, and unpark row 34221 (`CITADEL / Томатка`).

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-11-393-algolia-hits-per-page-design.md`

## Global Constraints

- Do not alter Algolia search endpoint or index name (`beer`).
- Do not alter `ABV_TOLERANCE` (0.3%) or matcher identity gates.
- Preserve single-roundtrip search without introducing client-side pagination protocol.
- Do not require extension re-release; extension dynamically consumes server-provided `hitsPerPage`.

## Review Focus

- Server contract test: `/enrich/candidates` must return `hitsPerPage: 15`.
- Sibling pool resolution: a candidate ranked 6th (index 5) with exact name and ABV must be chosen by `lookupBeer` over a rank 2 candidate with an adjunct suffix.
- False positive resistance: an ambiguous generic name (`Nieczajna Session IPA`) with 12 candidates must return `not_found`, not an arbitrary single-hop variant.

---

### Task 1: Update Server Constant and Contract Tests

**Files:**
- Modify: `src/sources/untappd/algolia.ts:32`
- Test: `src/sources/untappd/algolia.test.ts`
- Test: `src/api/routes/enrich.test.ts`

- [ ] **Step 1: Update `ALGOLIA_HITS_PER_PAGE = 15` in `src/sources/untappd/algolia.ts`**
  Change line 32: `export const ALGOLIA_HITS_PER_PAGE = 15;`
- [ ] **Step 2: Update contract assertions in `src/sources/untappd/algolia.test.ts`**
  Update line 70: assert `hitsPerPage: 15`.
- [ ] **Step 3: Update contract assertions in `src/api/routes/enrich.test.ts`**
  Update assertions on `/enrich/candidates` response expecting `hitsPerPage: 15`.
- [ ] **Step 4: Run Vitest on modified test files to verify they pass**
  Run: `npm test -- src/sources/untappd/algolia.test.ts src/api/routes/enrich.test.ts`
- [ ] **Step 5: Commit changes**
  Commit message: `fix(algolia): raise ALGOLIA_HITS_PER_PAGE to 15 (#393)`

---

### Task 2: Sibling Pool Integration Tests and Spec Update

**Files:**
- Modify: `src/domain/untappd-lookup.test.ts`
- Modify: `spec.md:2007`

- [ ] **Step 1: Add sibling-pool integration tests in `src/domain/untappd-lookup.test.ts`**
  Add test under `#393`:
  1. A sibling pool where rank 1-5 are variant suffixes (`Томатка: Аджика` @ 4.4%) and rank 6 is exact name (`Томатка` @ 5.0%). Verify `lookupBeer` matches rank 6 (exact match), proving 15-hit pool avoids the suffix false positive.
  2. A generic style name with 12 variants (`Nieczajna Session IPA 12°`) safely returns `not_found` rather than misattributing to a lower-ranked single-hop candidate.
- [ ] **Step 2: Update `spec.md` line 2007**
  Update `Body: {"query": "<query>", "hitsPerPage": 15}` and document rationale.
- [ ] **Step 3: Run full gate**
  Run: `npm test && npm run typecheck`
- [ ] **Step 4: Commit changes**
  Commit message: `test(lookup): verify deep sibling pool resolution (#393)`

---

### Task 3: Unpark Row 34221 & Verification

**Files:**
- Operational DB action on operator host: `/var/lib/warsaw-beer-bot/bot.db`

- [ ] **Step 1: Check status of row 34221 in `bot.db`**
  Verify `SELECT id, name, brewery, abv, untappd_lookup_count FROM beers WHERE id = 34221;`
- [ ] **Step 2: Unpark and re-arm row 34221**
  Reset `untappd_lookup_count = 0` so the enrich cron can resolve it.
- [ ] **Step 3: Run cross-review per AGENTS.md**
  Run: `npm run cross-review -- --reviewer claude`
- [ ] **Step 4: Push branch and open PR**
