# Collab & Multi-Brewery Splitting Core Implementation Plan (#401, #589, #501)

> **For agentic workers:** REQUIRED SUB-SKILL: Follow `AGENTS.md` and the Superpowers workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate search zeroing and brewery-gate rejections on collaboration beers by expanding `COLLAB_SEP` to handle non-spaced `&` and spaced `+`, and enhancing `inputIdentityAliases` with leading noise trimming and collab side support to match Untappd `alias_alt` collaboration variants.

**Architecture:**
- `src/domain/normalize.ts`: Expand `COLLAB_SEP` to `/\s*[/&]\s*|\s+[Xx+]\s+/`.
- `src/domain/untappd-lookup.ts`: Add `normalizeIdentityAlias` and include collab name sides in `inputIdentityAliases`.

**Tech Stack:** TypeScript, Vitest.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/domain/normalize.ts` | Modify | Update `COLLAB_SEP` regex |
| `src/domain/normalize.test.ts` | Modify | Unit tests for `COLLAB_SEP` with `&` and `+` |
| `src/domain/matcher.test.ts` | Modify | Unit tests for `breweryAliases` on collab inputs |
| `src/domain/untappd-lookup.ts` | Modify | Normalize identity aliases and support collab sides in `inputIdentityAliases` |
| `src/domain/untappd-lookup.test.ts` | Modify | Unit tests for `alias_alt` collab matching |

---

## Task 1: Broaden `COLLAB_SEP` and Add Tests

**Files:**
- Modify: `src/domain/normalize.ts`
- Modify: `src/domain/normalize.test.ts`
- Modify: `src/domain/matcher.test.ts`

- [ ] **Step 1: Write failing tests in `src/domain/normalize.test.ts` and `src/domain/matcher.test.ts`**:
  - `COLLAB_SEP` splits `Stone&Garage Beer Co.` into `['Stone', 'Garage Beer Co.']`
  - `COLLAB_SEP` splits `Nieczajna + Bistro Narożnik Brewery` into `['Nieczajna', 'Bistro Narożnik Brewery']`
  - `breweryAliases('Stone&Garage Beer Co. Brewery')` yields `['stone garage beer', 'stone', 'garage beer']`
  - `breweryAliases('Nieczajna + Bistro Narożnik Brewery')` yields `['nieczajna bistro naroznik', 'nieczajna', 'bistro naroznik']`
- [ ] **Step 2: Update `COLLAB_SEP` in `src/domain/normalize.ts`**:
  - Change `COLLAB_SEP` to `/\s*[/&]\s*|\s+[Xx+]\s+/`
- [ ] **Step 3: Run unit tests**: `npx vitest run src/domain/normalize.test.ts src/domain/matcher.test.ts`
- [ ] **Step 4: Run full gate**: `npm test && npm run typecheck`
- [ ] **Step 5: Commit**: `git commit -m "fix(normalize): expand COLLAB_SEP for non-spaced ampersand and plus (#401, #589)"`

---

## Task 2: Identity Alias Trimming & Collab Sides in `lookupBeer`

**Files:**
- Modify: `src/domain/untappd-lookup.ts`
- Modify: `src/domain/untappd-lookup.test.ts`

- [ ] **Step 1: Write failing tests in `src/domain/untappd-lookup.test.ts`**:
  - Test matching a candidate whose `alias_alt` contains leading brewery noise (e.g. `Browar Stu Mostów Hommage Aux Cent Ponts` when input is `Stu Mostów Brewery / Hommage aux Cent Ponts`).
  - Test matching an empty-brewery input whose collab-joined title matches a candidate `alias_alt` side (e.g. `Dutch Bargain/Brouwerij LOST House of New Orleans`).
- [ ] **Step 2: Implement `normalizeIdentityAlias` and collab side inclusion in `src/domain/untappd-lookup.ts`**:
  - Define `normalizeIdentityAlias(s: string): string` stripping leading brewery descriptors.
  - In `inputIdentityAliases`:
    - Add normalized brewery-prefixed names through `normalizeIdentityAlias`.
    - When `inputBreweryAliases.length === 0` or when `name` contains collab separators, add `normalizeIdentityAlias(side)` for all sides of `name.split(COLLAB_SEP)` having token count >= 2.
  - In `identityHits`:
    - Match `(result.alias_alt ?? []).some((alias) => inputIdentityAliases.has(normalizeIdentityAlias(alias)))`.
- [ ] **Step 3: Run unit tests**: `npx vitest run src/domain/untappd-lookup.test.ts`
- [ ] **Step 4: Run full gate**: `npm test && npm run typecheck`
- [ ] **Step 5: Commit**: `git commit -m "fix(lookup): match collab variants in alias_alt and admit collab sides (#401, #501)"`

---

## Task 3: Live Replay Probe across 15 Cohort Rows

**Files:**
- Run spike script testing `lookupBeer` with real search against live Algolia.

- [ ] **Step 1: Replay all 15 cohort rows**:
  - Verify #589 (all 4 beers: 35234, 35235, 35236, 35258) return `matched` with exact Garage Beer Co. targets.
  - Verify #401 beers (30956, 35032, 26063, 29665, 29668) return `matched`.
  - Verify #501 (beer 12250) returns `matched` with Fauve target.
- [ ] **Step 2: Record replay results in summary table**.

---

## Task 4: Whole-Branch Review of Core Phase

- [ ] **Step 1: Run full gate**: `npm test && npm run typecheck`
- [ ] **Step 2: Review git diff against `origin/main`**.
- [ ] **Step 3: Present Core results to user before proceeding to Periphery plan**.
