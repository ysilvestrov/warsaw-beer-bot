# Flasker Adapter Extraction & Frozen Orphan Reconciliation

**Date:** 2026-09-13  
**Status:** draft  
**Issues:** #558, #579, #566, #565, #559, #555, #481 (Cluster 1)  

---

## 1. Problem

The daily triage job (`src/jobs/orphan-triage.ts`) operates without codebase access and evaluates attribution failures purely from stored `enrich_failures` rows. On the Ukrainian craft-beer shop Flasker (`flasker.com.ua`), this has generated a constellation of 7 fragmented issues (#579, #566, #565, #559, #558, #555, #481) and 40+ orphaned database rows.

The root cause spans two interacting layers:

### A. Client-Side Adapter Extraction Deficiencies (`extension/src/sites/flasker.ts`)
1. **Banner leakage into the brewery field (#566, #481)**:
   Listings with promotional banners (`ПРЕДРЕЛІЗ`, `ПРЕДРЕДІЗ`, `ПРОБНИК:`) or colon-headers (`Berryland: ...`) leak the banner into the extracted `brewery` field whenever `splitBreweryName` falls back to token splitting.
2. **Shop name extracted as brewery (#559, #558)**:
   Products where the shop does not specify a separate brand tile fall back to `Flasker` as the brewery (e.g. `Flasker / Банановий Стаут`), which zeroes the Algolia search query or fails the brewery gate.
3. **Multi-word brewery truncation & concatenation (#579, #558)**:
   `splitBreweryName` takes only the first word as the brewery unless explicitly listed in `TWO_WORD_BREWERIES`. As a result, multi-word breweries are truncated (`The` from `The Lost Philosopher`, `Holy` from `Holy Brew`, `Ten` from `Ten Men`, `DE` from `DE ZWARTE REGEL`), or words get concatenated (`EvilTwinImperial`).
4. **Registry gaps (`flasker-breweries.generated.ts`)**:
   Breweries like `Evil Twin`, `Teréna`, `Berryland` are missing from the static match dictionary.

### B. Server-Side Frozen Orphan Trap & Keyed-Lock Risk (§3.13)
1. **Frozen input strings**:
   Once client-relay submits a bad split, `b.brewery` and `b.name` are frozen in the `beers` and `enrich_failures` tables. The server-side enrich cron re-queries only from the stored strings.
2. **Misclassification as `matcher-bug`**:
   Because the daily triage agent only sees the frozen database rows, it repeatedly misattributes these client adapter defects as backend `matcher-bug` issues, inventing unnatural query-splitting hypotheses (e.g. camelCase splitting in `matcher.ts`).
3. **The Keyed-Lock consequence**:
   If an adapter fix is shipped in the extension and the GitHub issues are closed, `unlock-fixed-orphans` automatically re-arms all associated rows. But because the stored strings in `beers` remain corrupt, the free retry fails immediately, burning Untappd quota and polluting triage once again.

---

## 2. Decision & Architecture

### Component 1: Extension Adapter Overhaul (`extension/src/sites/flasker.ts`)

1. **Title & Header Sanitization**:
   - Run `stripMerchandisingPrefix` strictly before any splitting, expanding it to catch all known Cyrillic/Latin pre-release and sample prefixes (`ПРЕДРЕЛІЗ:`, `ПРЕДРЕДІЗ:`, `ПРОБНИК:`, `AOTEAROA:`).
   - Support colon-separated title heads: when a title matches `<Producer>: <Beer>`, resolve `<Producer>` against registry rules or brand context.
2. **Two-Word & Missing Brewery Registry**:
   - Expand `TWO_WORD_BREWERIES` and `BREWERY_RULES` for known Ukrainian and international craft producers appearing on Flasker (`Ten Men`, `Holy Brew`, `The Lost Philosopher`, `De Zwarte Regel`, `Evil Twin`, `Berryland`).
   - Re-run `npm --prefix extension run gen-flasker-breweries` to incorporate recent brands into `flasker-breweries.generated.ts`.
3. **Rejection of Shop Name (`Flasker`) as Brewery**:
   - If `brewery` resolves to `Flasker`, reject it as a brewery. Require fallback to product detail hydration (`brand.name` from JSON-LD) or title extraction.

### Component 2: Extension Changelog Compliance
Following `AGENTS.md`, write a single user-facing entry in `extension/CHANGELOG.md` under `## [Unreleased]`:
- Focus on the symptom: *"Fixed beer badges not appearing on Flasker listings with pre-release banners, multi-word breweries, or missing brand tags."*

### Component 3: Database Reconciliation & Row Adjudication

Following `docs/orphan-triage-issues-runbook.md` and `AGENTS.md`:
1. **Consolidation under Issue #558**:
   - Map confirmed rows from duplicate issues (#579, #566, #565, #559, #555, #481) onto #558:
     ```sql
     UPDATE enrich_failures SET issue_number = 558 WHERE beer_id IN (<ids>);
     ```
2. **Row Adjudication before Closure**:
   - For rows whose frozen split cannot succeed on server retry, run `npm run adjudicate -- --issue <N>` to generate the verdict file.
   - Apply markers (`npm run adjudicate -- --apply <verdict-file>`) to stamp `unrescued_at` so closing the issue does not burn wasteful retries.
   - Close the 6 duplicate issues with reference to #558.

---

## 3. Claims and Their Evidence

| Recorded fact | Claim | Evidence required before recording |
|---|---|---|
| `extension/src/sites/flasker.ts` parses `ПРЕДРЕЛІЗ: Morava Winter Flow IS 10% 0.33` as `{ brewery: 'VibrantPour', name: 'Morava Winter Flow IS', abv: 10 }` | Merchandising prefix and family slug correctly resolve brewery without losing series name | Vitest unit test in `flasker.test.ts` passing; slug matches `morava-` family rule |
| `parseTitle('EvilTwin Imperial Doughnut Break 11.5% 0.33l')` resolves to `brewery: 'Evil Twin', name: 'Imperial Doughnut Break'` | Multi-word brewery `Evil Twin` is recognized and separated from style descriptor | Vitest unit test passing; matches registry or rule |
| `parseTitle` rejects `Flasker` as a brewery name | Product does not carry shop name as brewer | Vitest unit test asserting `brewery !== 'Flasker'` |
| `enrich_failures.issue_number` remapped to `558` | Row belongs to the consolidated Flasker adapter defect cohort | `source_url` contains `flasker.com.ua` AND row exhibits one of the documented title/banner extraction patterns |
| `unrescued_at` marked on unrecoverable frozen rows via `adjudicate` | Free re-arm will not rescue a row with frozen corrupt stored input | Pre- and post-canary passed; live probe confirmed `unrescued` verdict |

---

## 4. Test Plan

### Unit Tests (`extension/src/sites/flasker.test.ts`)
1. **Pre-release banner stripping**:
   - `ПРЕДРЕЛІЗ: Safe Circle Blond Ale 5% 0.33` -> `Safe Circle / Blond Ale`.
   - `ПРОБНИК: MGM Tapped Ed. 6% 0.33` -> `MGM / Tapped Ed.`.
2. **Multi-word brewery resolution**:
   - `Evil Twin Imperial Doughnut Break 11.5% 0.33l` -> `Evil Twin / Imperial Doughnut Break`.
   - `Ten Men Rubis Strong ALE 8% 0.33` -> `Ten Men / Rubis Strong ALE`.
   - `Holy Brew Cherry Poppy Pie Stout 7% 0.33` -> `Holy Brew / Cherry Poppy Pie Stout`.
3. **Colon header resolution**:
   - `Berryland: Cidre Cuvee 6% 0.75l` -> `Berryland / Cidre Cuvee`.
4. **Shop name fallback rejection**:
   - `Flasker Банановий Стаут 6% 0.33` does not output `Flasker` as brewery.

### Gate Verification
- Root tests & typecheck: `npm test && npm run typecheck`
- Extension tests & typecheck: `npm --prefix extension test && npm --prefix extension run typecheck`

---

## 5. Scope & File List

- `extension/src/sites/flasker.ts`
- `extension/src/sites/flasker.test.ts`
- `extension/CHANGELOG.md`
- `extension/src/sites/flasker-breweries.generated.ts` (if regenerated)
- `spec.md` (§6 Flasker adapter rules)
