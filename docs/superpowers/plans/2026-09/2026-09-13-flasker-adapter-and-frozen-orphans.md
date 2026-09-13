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

- [x] **Step 1: Add tests for banner stripping before tokenization**
  - `ПРЕДРЕЛІЗ: Safe Circle Blond Ale 5% 0.33` -> `{ brewery: 'Safe Circle', name: 'Blond Ale', abv: 5 }`
  - `ПРОБНИК: MGM Tapped Ed. 6% 0.33` -> `{ brewery: 'MGM', name: 'Tapped Ed.', abv: 6 }`

- [x] **Step 2: Add tests for multi-word brewery and fused token handling**
  - `EvilTwinImperial Doughnut Break 11.5% 0.33l` -> `{ brewery: 'Evil Twin Brewing', name: 'Imperial Doughnut Break', abv: 11.5 }`
  - `Ten Men Rubis Strong ALE 8% 0.33` -> `{ brewery: 'Ten Men Brewery', name: 'Rubis Strong ALE', abv: 8 }`
  - `Holy Brew Cherry Poppy Pie Stout 7% 0.33` -> `{ brewery: 'Holy Brewery', name: 'Cherry Poppy Pie Stout', abv: 7 }`

- [x] **Step 3: Add tests for colon producer headers**
  - `Berryland: Cidre Cuvee 6% 0.75l` -> `{ brewery: 'BERRYLAND', name: 'Cidre Cuvee', abv: 6 }`
  - `DE ZWARTE REGEL: Tweede Kring 8% 330ml` -> `{ brewery: 'DE ZWARTE REGEL', name: 'Tweede Kring', abv: 8 }`

- [x] **Step 4: Run tests and verify RED for failing cases**
  `npm --prefix extension test -- src/sites/flasker.test.ts`

---

### Task 2: Implement Flasker adapter extraction repairs

**Files:**
- Modify: `extension/src/sites/flasker.ts`
- Modify: `extension/src/sites/flasker-breweries.generated.ts`

- [x] **Step 1: Enhance `stripMerchandisingPrefix`**
  - Ensure all promo banner prefixes (`ПРЕДРЕЛІЗ`, `ПРЕДРЕДІЗ`, `ПРОБНИК:`, `AOTEAROA:`) are stripped from `head` before any splitting occurs.

- [x] **Step 2: Add colon-header producer handling**
  - When title head contains `<Producer>: <Beer>`, extract `<Producer>` and clean `<Beer>`.

- [x] **Step 3: Expand multi-word brewery registry & rules**
  - Add `Evil Twin`, `Ten Men`, `Holy Brew`, `The Lost Philosopher`, `De Zwarte Regel`, `Berryland` to `TWO_WORD_BREWERIES`, `BREWERY_RULES`, and `FLASKER_BREWERIES`.

- [x] **Step 4: Flasker brewery rule verified (#559)**
  - Retained `Flasker` rule: verified against live Untappd evidence (contract brewer with 97 registered beers; style tail zeroes queries, not brewery).

- [x] **Step 5: Run tests and verify GREEN**
  `npm --prefix extension test -- src/sites/flasker.test.ts` (94/94 passing)

---

### Task 3: Extension Changelog & Documentation

**Files:**
- Modify: `extension/CHANGELOG.md`

- [x] **Step 1: Add user-facing changelog entry under `## [Unreleased]`**
  Write from the user's perspective (mentioning missing badges on Flasker with pre-release banners or multi-word breweries).

- [x] **Step 2: Run extension full gate**
  `npm --prefix extension test && npm --prefix extension run typecheck` (666 tests passing, tsc clean)

---

### Task 4: Database row remapping & adjudication plan

**Files:**
- Create: `tmp/flasker-remap.sql`

- [x] **Step 1: Extract all confirmed beer IDs across the 7 Flasker issues**
  Generated explicit `UPDATE enrich_failures SET issue_number = 558 WHERE beer_id IN (...)` statements for rows in #579, #566, #565, #555, #481.

- [x] **Step 2: Run live adjudication probes**
  Executed `DOTENV_CONFIG_PATH=.env DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run adjudicate -- --issue <N>` across #481, #579, #566, #565, #555: 14 rows probed, 14 unrescued verdicts recorded with pre- and post-canary verification.
