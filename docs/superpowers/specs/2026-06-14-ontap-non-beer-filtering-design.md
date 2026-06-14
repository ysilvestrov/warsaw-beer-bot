# Ontap non-beer tap filtering — design

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-14. **Issue:** #154.
> **Звіряти з:** `spec.md` §3.3-3.6, §5.2, фоновий джоб `refreshOntap`.

## 1. Problem

`refreshOntap` ingest currently persists every tap row parsed from ontap.pl. When pubs put
wine, prosecco, spritz, or cocktails on tap, those rows become `taps`, get upserted into
`beers` as orphans, and then repeatedly fail Untappd enrichment. They are not beer data and
should not enter snapshots, catalog, matcher, or enrichment.

Production snapshot analysis on 2026-06-14:

- current ontap rows: 646;
- orphan tap rows: 218;
- distinct orphan `beer_ref`: 122;
- style/brewery-only non-beer candidate gate: 46 rows;
- all 46 candidates are orphaned, and 0 are currently matched.

## 2. Goals / Non-goals

**Goals.**

- Drop obvious non-beer ontap tap rows before persistence and matching.
- Base the gate only on `style` and `brewery_ref`, not `beer_ref`.
- Prevent broad Untappd search/enrich pollution from queries such as `wino` or `merlot`.
- Document explicit false-positive guards for eligible non-beer-adjacent categories.
- Update `spec.md` with the new server-side ontap invariant.

**Non-goals.**

- Do not filter by tap `beer_ref`/name.
- Do not filter cider, kvass, or mead. They remain eligible and matchable.
- Do not clean existing polluted DB rows in this change.
- Do not change browser extension adapters; issue #148/#adapter filtering is separate.
- Do not fix cider/kvass/mead matching quality here.

## 3. Decision

Add an ontap-specific non-beer gate in the refresh path after parsing a pub page and before
creating snapshots, inserting taps, matching, creating orphan beer rows, or calling enrichment.

The gate uses only:

- `style` families and exact style phrases;
- `brewery_ref` family tokens and exact brewery sentinels.

It deliberately does not inspect `beer_ref`. This keeps short or ambiguous beverage names out
of the decision surface and avoids creating policy from noisy Untappd searches.

## 4. Candidate Vocabulary

### 4.1 Style signals

Style family tokens:

- `vino`, `wino`, `wina`
- `prosecco`
- `frizzante`
- `spritz`
- `aperitivo`
- `koktajl`
- `musujące`
- `wytrawne`
- `półwytrawne`
- `słodkie`

Exact or anchored style phrases:

- `APERITIVO`
- `Aperitivo Spritz`
- `Aperol Spritz`
- `Białe Wino Musujące`
- `Białe Wino Musujące Wytrawne`
- `Drink, czarny bez, mięta i limonka`
- `Frizzante [wino musujące]`
- `Mojito drink`
- `Orange bitter`
- `Primitivo`
- `Własny koktajl z kija`

Do not use a generic `drink` substring. Current production data has a matched Schwarzbier
whose long style description contains `drinkability`, so broad `drink` matching is unsafe.

### 4.2 Brewery signals

Brewery family tokens:

- `WINO`, `wine`, `Winiarska`
- `Maccari`
- `Frizzanti`
- `Cantine`
- `San Martino`, `SAN MARTINO`
- `Conegliano`
- `Puglia`
- `Vini`, `Dolium Vini`
- `Stacja Winiarska`

Exact brewery sentinels:

- `Aperitivo Spritz`
- `HUGO`
- `MOJITO`

The exact sentinels cover cocktail rows with empty or weak style while avoiding broad
name-based matching.

## 5. False-positive Guards

These categories are explicitly eligible and must not be filtered by this issue:

- cider (`Cydr`, `Cider`, etc.);
- kvass / `Kwas chlebowy`;
- mead / melomel.

They may still fail matching or enrichment, but that is a matching/enrichment quality problem,
not an ontap non-beer filtering problem.

## 6. Expected Data Flow

For each pub refresh:

1. parse ontap pub page;
2. drop tap rows whose `style` or `brewery_ref` matches the non-beer gate;
3. create snapshot and insert only retained taps;
4. run matcher and fresh-orphan enrichment only for retained taps.

Filtered rows do not appear in `/beers`, `/newbeers`, route candidates, orphan catalog rows,
or `enrich_failures`.

## 7. Testing

- Unit-test the pure ontap gate with current wine/prosecco/spritz/cocktail examples.
- Include false-positive tests proving cider, kvass, and mead stay eligible.
- Test `refreshOntap` behavior on a mixed pub page: filtered taps are not inserted, not
  matched, and not enriched; valid beer taps still flow normally.
- Keep tests focused on server-side ontap ingest; extension adapter tests are unaffected.

## 8. Rollout

1. Implement the gate and tests in an isolated worktree.
2. Update `spec.md` with the invariant.
3. Merge through the normal PR flow.
4. Let the next scheduled/forced ontap refresh stop creating new polluted rows.
5. Consider a separate cleanup issue/PR for existing polluted catalog rows after this behavior
   is live.
