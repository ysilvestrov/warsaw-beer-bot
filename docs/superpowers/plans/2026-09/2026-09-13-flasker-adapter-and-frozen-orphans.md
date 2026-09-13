# Flasker Adapter Extraction & Frozen Orphan Reconciliation Implementation Plan

**Goal:** Overhaul the Flasker shop adapter in `extension/src/sites/flasker.ts` to prevent title banner leakage, multi-word brewery truncation, and shop-name fallback, then prepare safe database remapping and adjudication for the 7 cluster issues (#558, #579, #566, #565, #559, #555, #481).

**Architecture:** 
1. Client-side: sanitize title heads before tokenization, recognize known multi-word craft breweries, support colon-separated producer prefixes, and reject the shop name `Flasker` as a valid brewer.
2. Server-side / Ops: consolidate duplicate issues onto #558, generate exact `beer_id` remapping SQL, and run adjudication probes before closing redundant issues.

**Tech Stack:** TypeScript, Vitest, Chrome extension site adapters, SQLite orphan-triage database.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-flasker-adapter-and-frozen-orphans-design.md` and `spec.md` §6.

---

## Global Constraints

- Preserve existing adapter resolution precedence: curated slug rules, product tags, generated registry, fallback splitting.
- Adhere strictly to `AGENTS.md` and `CLAUDE.md`:
  - Never do a blanket `WHERE issue_number = <parent>` update in the database; remap by explicit `beer_id` list.
  - Update `extension/CHANGELOG.md` with user-facing language (describing visible symptoms, avoiding internal code vocabulary).
  - Run the full test gate (`npm test && npm run typecheck` and extension tests) at every step.

---

### Task 1: Write comprehensive regression tests for Flasker extraction defects

**Files:**
- Modify: `extension/src/sites/flasker.test.ts`

- [ ] **Step 1: Add tests for banner stripping before tokenization**
  - `ПРЕДРЕЛІЗ: Safe Circle Blond Ale 5% 0.33` -> `{ brewery: 'Safe Circle', name: 'Blond Ale', abv: 5 }`
  - `ПРОБНИК: MGM Tapped Ed. 6% 0.33` -> `{ brewery: 'MGM', name: 'Tapped Ed.', abv: 6 }`

- [ ] **Step 2: Add tests for multi-word brewery and fused token handling**
  - `EvilTwin Imperial Doughnut Break 11.5% 0.33l` -> `{ brewery: 'Evil Twin', name: 'Imperial Doughnut Break', abv: 11.5 }`
  - `Ten Men Rubis Strong ALE 8% 0.33` -> `{ brewery: 'Ten Men', name: 'Rubis Strong ALE', abv: 8 }`
  - `Holy Brew Cherry Poppy Pie Stout 7% 0.33` -> `{ brewery: 'Holy Brew', name: 'Cherry Poppy Pie Stout', abv: 7 }`

- [ ] **Step 3: Add tests for colon producer headers and shop name rejection**
  - `Berryland: Cidre Cuvee 6% 0.75l` -> `{ brewery: 'Berryland', name: 'Cidre Cuvee', abv: 6 }`
  - Ensure title starting with `Flasker ` does not yield `Flasker` as the brewery.

- [ ] **Step 4: Run tests and verify RED for failing cases**
  `npm --prefix extension test -- src/sites/flasker.test.ts`

---

### Task 2: Implement Flasker adapter extraction repairs

**Files:**
- Modify: `extension/src/sites/flasker.ts`

- [ ] **Step 1: Enhance `stripMerchandisingPrefix`**
  - Ensure all promo banner prefixes (`ПРЕДРЕЛІЗ`, `ПРЕДРЕДІЗ`, `ПРОБНИК:`, `AOTEAROA:`) are stripped from `head` before any splitting occurs.

- [ ] **Step 2: Add colon-header producer handling**
  - When title head contains `<Producer>: <Beer>`, extract `<Producer>` and clean `<Beer>`.

- [ ] **Step 3: Expand multi-word brewery registry & rules**
  - Add `Evil Twin`, `Ten Men`, `Holy Brew`, `The Lost Philosopher`, `De Zwarte Regel`, `Berryland` to `TWO_WORD_BREWERIES` and/or `BREWERY_RULES`.

- [ ] **Step 4: Reject shop name `Flasker` in brewery fallback**
  - When fallback derives `Flasker` as brewery, reject it and rely on brand tile or product detail hydration.

- [ ] **Step 5: Run tests and verify GREEN**
  `npm --prefix extension test -- src/sites/flasker.test.ts`

---

### Task 3: Extension Changelog & Documentation

**Files:**
- Modify: `extension/CHANGELOG.md`

- [ ] **Step 1: Add user-facing changelog entry under `## [Unreleased]`**
  Write from the user's perspective (mentioning missing badges on Flasker with pre-release banners or multi-word breweries).

- [ ] **Step 2: Run extension full gate**
  `npm --prefix extension test && npm --prefix extension run typecheck`

---

### Task 4: Database row remapping & adjudication plan

**Files:**
- Create: `tmp/flasker-remap.sql`

- [ ] **Step 1: Extract all confirmed beer IDs across the 7 Flasker issues**
  Generate explicit `UPDATE enrich_failures SET issue_number = 558 WHERE beer_id IN (...)` statements.

- [ ] **Step 2: Document adjudication commands**
  `npm run adjudicate -- --issue <N>` for all 6 issues before closing.
