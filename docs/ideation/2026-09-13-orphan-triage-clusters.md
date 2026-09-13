# Orphan-Triage Issue Clusters & Architectural Analysis

**Date:** 2026-09-13  
**Open orphan-triage issues:** 37  
**Tool:** `npm run cluster-triage`  
**Skill:** `.agents/skills/orphan-triage-clusterer/SKILL.md`  

---

## 1. Executive Summary & Cluster Ranking

The 37 open `orphan-triage` issues were cataloged, parsed, and cross-referenced with the codebase. They fall into **11 distinct architectural clusters**:

| Rank | Cluster | Locus | Issues | Unique Beers | Leverage | Blast Radius | Impact Score |
|:---:|---|---|:---:|:---:|:---:|:---:|:---:|
| **1** | **Flasker Shop Adapter & Scraper Extraction** | `adapter_bug` | 7 | 26 | 5/5 | 1/5 | **650** |
| **2** | **Unresolved Sinkholes (Overbroad Scopes)** | `sinkhole_debris` | 3 | 76 | 2/5 | 1/5 | **380** |
| **3** | **Query-Zeroing Descriptors & Packaging Tokens** | `query_normalizer_bug` | 5 | 19 | 4/5 | 2/5 | **190** |
| **4** | **Parent/Portfolio & Conglomerate Brand Resolution** | `entity_alias_bug` | 6 | 23 | 3/5 | 2/5 | **173** |
| **5** | **Collab & Multi-Brewery Splitting** | `query_normalizer_bug` | 3 | 15 | 4/5 | 2/5 | **150** |
| **6** | **Bounded Typo & Fused Token Rescue** | `matcher_gate_bug` | 4 | 41 | 3/5 | 3/5 | **137** |
| **7** | **WineTime Shop Adapter** | `adapter_bug` | 1 | 3 | 5/5 | 1/5 | **75** |
| **8** | **Cyrillic Transliteration & Translation Maps** | `entity_alias_bug` | 2 | 7 | 3/5 | 2/5 | **53** |
| **9** | **BeerShop.eu Series & Title Banner Splitting** | `adapter_bug` | 1 | 1 | 5/5 | 1/5 | **50** |
| **10** | **Internal-cron Scraper Tap Placeholders** | `adapter_bug` | 1 | 2 | 5/5 | 1/5 | **50** |
| **11** | **Miscellaneous** | `other` | 4 | 7 | 2/5 | 2/5 | **40** |

---

## 2. Deep Dive: The #1 Impact Cluster (Flasker Shop Adapter)

### Contributing Issues (7 issues, 26+ beers)
- **#579**: `[matcher-bug] flasker rows: brewery token concatenated with style/qualifier (EvilTwinImperial)`
- **#566**: `[matcher-bug] flasker Cyrillic section-header (ПРЕДРЕЛІЗ) / duplicated token in brewery field blocks exact candidate`
- **#565**: `[matcher-bug] flasker brand-page rows lose brewery (Mad Brew); single exact candidate rejected by gate`
- **#559**: `[matcher-bug] flasker 'Flasker' rows: the brewery token is right — the shop's style tail zeroes the query`
- **#558**: `flasker orphans after #376: 41 ownerless parser_bug rows, and an adapter fix cannot repair any of them`
- **#555**: `[matcher-bug] Flasker Teréna rows: duplicated brewery token; beer actually registered under a different Ukrainian brewer`
- **#481**: `[matcher-bug] flasker Berryland: colon-header brewery + category tail zeroes query; probe_brewery returns exact Cuvee at ABV`

### Root Cause Analysis
The daily cron triage agent does not have access to `extension/src/sites/flasker.ts`. Seeing query strings like `EvilTwinImperial Doughnut Break` returning 0 candidates, it hypothesized a backend `matcher-bug` and suggested camelCase splitting in `matcher.ts`.
In reality:
1. `extension/src/sites/flasker.ts` extracts raw text from the DOM. When the shop omits a separate brewery tag or renders it inside the title, the fallback `splitBreweryName` naively splits words.
2. `extension/src/sites/flasker-breweries.generated.ts` is missing newer breweries registered on Flasker.
3. Colon headers like `Berryland: Cidre Cuvee` and category banners like `ПРЕДРЕЛІЗ:` leak into the brewery or beer name.

### Architectural Solution
1. **Regenerate Brand Dictionary**: Run `npm --prefix extension run gen-flasker-breweries` to refresh `flasker-breweries.generated.ts`.
2. **Adapter Title & Header Sanitation**:
   - In `extension/src/sites/flasker.ts`, add banner stripping for colon-separated producer prefixes (`<Producer>: <Beer>`).
   - Strip leading promo banners (`ПРЕДРЕЛІЗ`, `ПЕРЕДЗАМОВЛЕННЯ`) before tokenization.
   - Prevent concatenated style strings from being treated as brewery names when a registered brewery prefix matches.
3. **Database Remap & Adjudication**:
   - Consolidate the 7 issues into #558 (or a designated Flasker umbrella issue).
   - Remap rows in `bot.db`:
     ```sql
     UPDATE enrich_failures SET issue_number = 558 WHERE beer_id IN (...);
     ```
   - Run adjudication before closing redundant issues:
     ```bash
     npm run adjudicate -- --issue 579
     npm run adjudicate -- --issue 566
     npm run adjudicate -- --issue 565
     ```

---

## 3. Deep Dive: Cluster #2 (Unresolved Sinkholes)

### Issues: #334, #405, #406 (76 beers)
- **#334** (`[saturated]`): Has accumulated 20+ unrelated errors because its scope accepts any `candidates_count > 0` failure.
- **#405**: Title bundles 4 disparate root causes ("blank, brand-as-brewery, style-word name, or swapped fields").
- **#406**: Accepts any zero-candidate failure (`candidates_count = 0`).

### Recommended Action
1. Freeze #334, #405, #406 by narrowing their `triage-scope` where clauses to explicit beer ID cohorts.
2. Decompose existing rows by architectural locus and remap to their respective focused issues (e.g. move collab rows to #589/#401, move parent-brand rows to #554/#417).
