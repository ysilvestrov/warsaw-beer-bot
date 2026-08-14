# #347 — batch of curated brewery aliases (2026-08-14)

## Context

#347 was opened 2026-07-26 for one pattern: the Untappd search returns a candidate whose name matches at the
shop's own ABV, and the brewery hard-gate rejects it because the shop's brewer label differs from the
registered brewer. Over 19 days it accumulated 36 rows across 18 auto-triage batches and shipped nothing —
`src/domain/brewery-aliases.ts` was last modified 2026-07-22, four days *before* the issue existed.

On 2026-08-14 all 36 rows were replayed live through the real `lookupBeer()` against Algolia. Every row was
still live; only 12 belonged to the class the title names. Twenty-three were re-routed — 15 to #405 (the
shop's `brewery` field is not a brewery), 6 to #406 (the query zeroes, so the gate never runs), 2 to #407
(shop typos needing an edit-distance rescue) — and one (33646) had already been reclassified
`not_on_untappd` by the 2026-07-28 audit. #408 covers why the pile formed. This design covers what is left
in #347.

## Goal

Close the twelve remaining rows by growing the curated alias table — and prove, before merging, that each new
pair does what it claims for *every* orphan it touches, not only for the row that motivated it.

## Decisions

### Ten pairs

| pair | shop label → registered brewer | proved by | target |
|---|---|---|---|
| `['ksiazece', 'tyskie ksiazece']` | parent-company prefix | 33544 | bid 323265, abv 4.9 = 4.9 |
| `['petrus', 'de brabandere']` | brand of Brouwerij De Brabandere | 33571 | bid 6682946, abv 4.0 = 4.0 |
| `['kacov', 'hubertus']` | beer brand filed as brewery | 33664 | bid 2204361, abv 4.4 = 4.4 |
| `['mazurskie', 'mazurski']` | morphology (`Mazurskie Brewery` / `Mazurski Browar`) | 34252 | bid 4586540, abv 5.1 = 5.1 |
| `['lobkowicz', 'jihlava']` | portfolio owner → group brewery | 11995 | bid 71011, abv 4.9 = 4.9 |
| `['lobkowicz', 'rychtar']` | portfolio owner → group brewery | 34336 | bid 301434, abv 5.0 = 5.0 |
| `['cieszyn', 'arcyksiazecy zamkowy cieszyn']` | town label → full brewery name | 34371 | bid 1036654, abv 5.4 = 5.4 |
| `['cidre royal', 'royal fruit garden']` | brand → Ukrainian producer | 34518 (pinned) / 31808 | see below |
| `['tomatol', 'mad brew']` | Mad Brew series filed as brewery | 34351, 34352 | bids 6648348 / 6819716 |
| `['nachod', 'primator']` | town/company label → brewery brand | 34642 | bid 30947 (not sufficient alone) |

All keys produced with `npm run alias-key`. An earlier simulation (pairs added in a scratch checkout,
`lookupBeer()` re-run live, patch reverted) matched 11 of 12 rows; 34642 stayed unmatched.

### Two pins instead of pairs

- **34607 `Freigeist / Acid Trip:Tangier` → bid 6733435.** Freigeist ↔ Kreuzbräu is contract brewing, not
  ownership: Freigeist brews at more than one site and most of its catalogue is registered under `Freigeist
  Bierkultur`, which already passes the gate. A pair would permanently open "any Freigeist ↔ any Kreuzbräu"
  for neighbouring names to buy exactly one row. A pin buys the same row and states the real relationship.
- **34518 `Cidre Royal / Apple Cider` → bid 402651.** Three candidates sit at 5.0%: `Royal Fruit Garden —
  Demi-Sec` (402651), `Royal Fruit Bel — Demi-Sec` (5709103), `Royal Fruit Bel — Demi-Sweet` (5714662).
  The row carries `style = "Apple Cider (Ukraina)"`; `Royal Fruit Garden` is the Ukrainian producer and Bel
  the Belarusian licensee (bid 402651 predates the 57xxxxx records). Leaving the choice to the matcher is the
  #334 failure mode, so the target is pinned and the pair points at Garden.

Both rows are pub taps and therefore pinnable. Note the #343 hard limit: pins bind pub taps only — shop and
relay beers regenerate through `ensureBeerRow`, which is why 34351/34352 (flasker rows) get a pair and not a
pin.

### Why a pair for Tomatøl even though the client-side fix shipped

#385 (`c8d4f62`) resolves flasker's `Tomatøl` series to Mad Brew from the product slug and #384 (`d1ad069`)
uses the published Untappd bid as identity; both are in extension 0.14.0, which is now live in the store. The
pair is still worth adding: it is server-side, so it also serves 0.13.0 clients (the same reasoning that kept
the wide query in #391), and the existing `['smoothiemaker', 'mad brew']` entry is precisely this shape —
a Mad Brew series name in the brewery field. 34351's shop ABV (3.8) contradicts the linked record (4.2), so
any ABV-equality veto would reject the correct beer.

## Verification protocol (before opening the PR)

The pairs touch 20 orphans, not the 12 in the issue. Replay **all 20** with the patch applied
(`tmp/replay-347.ts`, read-only prod DB, live Algolia). Acceptance:

1. No row matches a beer whose ABV contradicts the shop's beyond `ABV_TOLERANCE`.
2. No row matches a brewer other than the target documented above.
3. Rows that stay unmatched are listed in the PR with their real class.

Known passengers, already probed and deliberately out of scope:

- **25802** `Lobkowicz / PSZENICA` → `Pivovary Lobkowicz — Lobkowicz Pšenice` 4.5%. The gate already passes;
  the name stage fails on PL `PSZENICA` ↔ CZ `Pšenice` → #322.
- **30273** `Książęce / Butelkowe` → zero candidates (packaging descriptor) → #388 / #406.
- **30059** `Lobkowicz / PLATAN` → `Pivovar Protivín — Platan Desítka / Jedenáctka / Granát`. Would need a
  further `lobkowicz ↔ protivin` pair *and* an unambiguous target; the shop name is bare `PLATAN` → #334.
- **34703** `Kacov / Hubertus Medium 11°` → `Hubertus — Světlý ležák Medium 11°` 4.4%. May close for free via
  the #321 Czech-grade stage; the replay decides.

## Testing

Two levels, failing first.

- `src/domain/brewery-aliases.test.ts` — symmetry for each new pair, and non-transitivity for the two new
  hubs: `lobkowicz` gains `jihlava` and `rychtar`, which must not become equivalent to each other, and
  `arcyksiazecy zamkowy cieszyn` gains `cieszyn` alongside the existing `bracki zamkowy w cieszynie`.
- `src/domain/untappd-lookup.test.ts` — regression through the existing `fakeSearch` harness, using the real
  candidate lists captured in today's replay, asserting each row matches the documented bid.

The second level is the point. A table-only test proves the entries exist, not that the matcher behaves: 57
`Dzik / Cydr Dzik` has had `['dzik','cydrownia']` curated since #318, returns the exact-ABV candidate, and
still fails on the name stage — which is why it is in #405 and not here.

## Rollout

1. Merge, deploy (`deploy.sh` on this host).
2. Apply both pins via `npm run pin-match` (compiled `dist`, run as the bot user).
3. `npm run rearm-aliased-orphans` — selects orphans by `hasCuratedAlias()`, so it re-arms all 20.
4. Read the result off the next enrich cron; post the outcome to #347.
5. Move the residue to its real issues and close #347 if nothing is left.

Unrelated but now unblocked: the 29789/30845 re-arm from #391/#382 was waiting on the 0.14.0 store rollout,
which has happened.

## Rollback

Revert the commit — the table is data, and the enrich path re-derives everything. The two pins live as
`match_links` rows with `reviewed_by_user = 1` and are deleted individually if a target turns out wrong.

## Risks accepted

- `['mazurskie', 'mazurski']` is a morphological variant, not a brand relation. It sits in a table whose
  header forbids fuzzy matching; the precedent is `['ziemia obiacana', 'ziemia obiecana']`. If #407 ships an
  edit-distance rescue on the gate, this pair becomes redundant — noted in the code comment.
- `['cidre royal', 'royal fruit garden']` leaves the Belarusian Bel records unreachable for `Cidre Royal`
  rows. Deliberate: no row observed so far belongs to Bel.
- `['nachod', 'primator']` will not close 34642 by itself (`WEIZENBIER` vs `Weizen`, abv 4.7 vs 4.8). It is
  curated because it is factually right and it moves the row to the name stage, where #322 / #334 own it.
