# Brewery alias / gate-miss batch (#318)

**Status:** design
**Issue:** #318 (tier-1) — Matcher: brewery alias expansion (rebrands / contract / local short-name → Untappd canonical)
**Date:** 2026-07-19

Rescue the live (on-tap) + shop-sourced `matcher_bug` orphans whose miss is a **brewery-gate** failure — the scraped brewery is a short/local/brand/contract form and Untappd files the beer under a different canonical brewery. Two low-risk `src/domain/` changes, then a rearm. This is the largest live gate-miss bucket from the 2026-07-19 matcher-bug review.

## Out of scope (routed elsewhere)

- Name-stage divergence where the brewery already normalises equal (e.g. `Browar Sady`≈`Sady`, `Malle`≈`Malle`, `Nepo Brewing`≈`Nepo Brewing`, `Primator`≈`Primátor`, `Herrnbrau`≈`Herrnbräu`, `Browar Gościszewo`≈`Gościszewo`) → **#319**.
- Shop typos (`Ziemia Obiacana`→`Obiecana`, `De Struise Brouwers`→`Brouwer`) → **#201**.
- `Series:` labels / diacritics already handled (`Põhjala … (Cellar Series)`) → shipped #303 / existing NFD fold.

## Part 1 — `BREWERY_NOISE` descriptor additions (`src/domain/normalize.ts`)

Generic brewery-type words not yet stripped that provably block a live match. Same mechanism/risk profile as the just-shipped `family` (#309): a descriptor, never the load-bearing brand token.

- **`minipivovar`** (Czech "micro-brewery") — rescues beer 12107 `Skřečoňský žabák` vs Untappd `Minipivovar Skřečoňský žabák` (both → `skrecconsky zabak` once stripped).
- **Evidence-gated candidates:** `minibrowar` (PL, symmetry with the existing `nanobrowar` entries) and `měšťanský` (CZ "municipal", as in `Měšťanský pivovar…`). Add each **only** if a rescue test passes for a real orphan; drop otherwise. No speculative additions.

Each added word gets a `normalize.test.ts` assertion (`normalizeBrewery('Minipivovar Skřečoňský žabák')` === `normalizeBrewery('Skřečoňský žabák')`).

## Part 2 — curated `ALIAS_PAIRS` (`src/domain/brewery-aliases.ts`)

Append verified `[shopForm, untappdForm]` pairs (normalized). Each pair:
1. is confirmed against the orphan's `enrich_failures.candidates_summary` (the authoritative Untappd brewery already returned by search);
2. is normalised via `npm run alias-key "<shop label>" "<untappd label>"` to produce the exact `['a', 'b'],` literal;
3. is added only if a test shows it makes `aliasNeighbors(shopForm)` include `untappdForm` (i.e. flips the brewery gate).

Confirmed mappings (raw labels; `alias-key` yields the normalized forms):

**On-tap (ontap/cron source):**
- `Aecht Schlenkerla` → `Schlenkerla`
- `Lausitzer` → `Privatbrauerei Eibau`
- `Grybów Pilsvar` → `Pilsvar`
- `Cydr Dobroński` → `JNT Group`
- `Pivovar Přerov` → `Pivovar Zubr`
- `Bakalar` → `Tradiční pivovar v Rakovníku`
- `Dzik` → `Cydrownia`
- `PanIPAni` → `Trzech Kumpli`

**Shops (extension source):**
- `Vibrant Pour` → `VibrantPour` (flasker; recurring, 5+ rows)
- `SmoothieMaker` → `Mad Brew`
- `Drofa` → `Дрофа` (cross-script alias, consistent with the existing `umanpivo → уманьпиво` pair)

**Brand-as-brewery caveat:** `PanIPAni`→`Trzech Kumpli` and `SmoothieMaker`→`Mad Brew` are cases where the shop put a beer/series/brand name in the brewery field. The mapping is correct (confirmed) but higher-risk than a pure rename; each is added only if it is a genuine 1:1 brewery equivalence (the brand is not shared across breweries). If verification during implementation shows a brand is ambiguous, drop that pair and leave a note in the PR.

## Hub / non-transitivity note

`aliasNeighbors` returns **direct** one-hop pairs; consumers expand one hop. Adding distinct `shop → canonical` pairs is safe. The only thing to check: if two shop forms map to the same canonical (a hub), confirm that is a true equivalence class and does not create an unintended transitive merge of two different breweries. None of the confirmed pairs above share a canonical, so no hub is formed in this batch.

## Testing (Vitest)

- `src/domain/brewery-aliases.test.ts`: for each new pair, `aliasNeighbors(shopForm)` contains `untappdForm` (and the reverse, since pairs are symmetric in the neighbour map). One table-style test covering the batch.
- `src/domain/normalize.test.ts`: the `minipivovar` (and any included descriptor) strip assertions from Part 1.
- Full suite + `npm run typecheck` stay green.

## Rollout

Server-side only; ships via `deploy.sh`. After deploy, run **`npm run rearm-matcher-bug-orphans`** so the backed-off `matcher_bug` orphans (candidates>0) re-attempt against the new aliases and match. Recency in `enrich_failures.last_at` is not proof of breakage — the rearm is what activates the fix for existing orphans. No `spec.md` schema change; no `extension/**` change → no extension-docs update.
