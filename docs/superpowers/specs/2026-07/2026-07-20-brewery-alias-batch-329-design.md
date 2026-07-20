# Design: brewery alias / gate-miss batch #329

**Date:** 2026-07-20
**Issue:** #329 — *Matcher: brewery alias / gate-miss batch #2 (exact beer present, brewery label diverges)*
**Precedent:** #318 (2026-07-19 alias batch), `docs/superpowers/specs/2026-07/2026-07-19-brewery-alias-gate-miss-batch-design.md`

## Problem

The 2026-07-20 orphan review surfaced a cluster of `matcher_bug` orphans where
the *exact* beer is already on Untappd but the shop-side **brewery label
diverges** from Untappd's, so the brewery hard-gate rejects a correct candidate.

Not every such row is fixable with a curated alias, though. A brewery alias only
helps when, once the brewery gate passes, the **name stage also accepts**. Probing
the nine candidate rows against the real normalizers (`normalizeName`,
`nameKeys`, `stripBreweryFromName`) showed only **four** rows match at the name
stage post-alias; the rest diverge on the *name* (subset / reorder /
brewery-echo) and cannot be rescued by an alias at all. Two proposed pairs
(`dzik→cydrownia`, `panipani→trzech kumpli`) are in fact **already aliased since
#318** and still fail — direct confirmation that name divergence, not the
brewery gate, is what blocks them.

## Scope (this cycle)

Exactly the **four verified alias-fixable rows**. Everything else is routed
elsewhere (see Out of Scope).

### The four alias pairs

Normalized forms below are the exact output of `normalizeBrewery()` (verified via
the probe; re-confirm with `npm run alias-key "<shop>" "<untappd>"` during
implementation):

| beer_id(s) | shop `brewery / name` | Untappd brewery | name match post-alias | pair to add |
|---|---|---|---|---|
| 32647 (+30934/31948/32312 if present) | `ZIEMIA OBIACANA / BRYŁA` | Ziemia Obiecana | `bryla` = `bryla` (exact) | `['ziemia obiacana', 'ziemia obiecana']` |
| 11991 | `BERGQELL / Erdbeer` | Bergquell Brauerei Löbau | `erdbeer` = `erdbeer` (Porter is a STYLE_WORD, stripped) | `['bergqell', 'bergquell lobau']` |
| 30141 | `Bracki Browar Zamkowy w Cieszynie / CIESZYN PILSNER` | Arcyksiążęcy Browar Zamkowy Cieszyn | `cieszyn` = `cieszyn` (Pilsner stripped) | `['bracki zamkowy w cieszynie', 'arcyksiazecy zamkowy cieszyn']` |
| 32683 | `Tank Busters / Paranormal Activity` | TankBusters.Co | key `activity paranormal` intersects | `['tank busters', 'tankbusters']` |

**Ziemia Obiecana bonus rows.** The `ziemia obiacana ↔ ziemia obiecana` alias
also covers the other three Ziemia Obiecana orphans — 30934 `BEACH HUT`, 31948
`PADEL BOYS`, 32312 `Prole Juice` — *for free* **iff** those beers exist on
Untappd under Ziemia Obiecana. Implementation verifies each via its
`enrich_failures.candidates_summary`: any that resolve are rescued by the same
alias; any that do not are left as-is (not this batch's concern).

### Non-transitivity safety

All four pairs are **fresh leaf↔leaf** pairs: none of the eight normalized forms
already appears in `ALIAS_PAIRS`, so no alias hub is created and `breweryAliases`
one-hop expansion stays sound. A test locks this (mirrors the #318
"batch forms no alias hub" test): for each new form, `aliasNeighbors(form)` has
length 1 and its partner is also a leaf.

## Architecture

Single-file data change plus a test, exactly like #318:

- **`src/domain/brewery-aliases.ts`** — append the four pairs to `ALIAS_PAIRS`
  under a `// #329 batch (2026-07-20)` comment. The existing `NEIGHBORS` /
  `aliasKeys` machinery picks them up at module load; no logic change.
- **`src/domain/brewery-aliases.test.ts`** — (a) assert each new pair resolves
  (`aliasNeighbors` symmetric), (b) assert the batch forms no hub
  (non-transitivity guard).
- **`src/domain/matcher.test.ts`** — one `matchPrepared` test per pair: an input
  beer `{ brewery: shopBrewery, name: shopName }` matches a prepared catalog row
  `{ brewery: untappdBrewery, name: untappdName }`. `matchPrepared` runs the same
  `breweryAliases` + name-stage gate the enrichment lookup uses, so this is the
  faithful regression that the alias closes the real gate, not just the map.

No change to `normalize.ts`, the gate, or the search-query builder.

## Data flow / rollout

1. Ship via `deploy.sh` (server-side only; no `extension/**`, no schema change).
2. `ALIAS_PAIRS` is read at module load, so the deploy's service restart activates it.
3. Re-arm the backed-off orphans so they re-attempt against the new aliases:
   `sudo -n -u warsaw-beer-bot bash -lc 'cd /opt/warsaw-beer-bot && npm run rearm-matcher-bug-orphans -- --apply'`
   (dry-run first without `-- --apply`).
4. Verify: the four (up to seven) beer_ids gain `beers.untappd_id` and drop out
   of `enrich_failures` on the next enrich cron.

## Testing

- `brewery-aliases.test.ts`: symmetry + no-hub (unit).
- `matcher.test.ts`: one match assertion per pair, using the real shop→Untappd
  strings from the table above (regression that the gate now passes).
- Full `npm test` green; `npm run typecheck` clean.
- Pre-deploy probe (throwaway): re-run the name-stage check to confirm the four
  rows resolve and no unrelated catalog brewery collides with a new alias form.

## Out of scope (explicitly)

- **Name-stage divergence rows → #319** (subset / reorder / brewery-echo-in-name):
  Chyliczki, Cydr Smykan, Jabłecznik Trzebnicki, Przetwórnia Chmielu, Cider Royal,
  plus the already-aliased Dzik & PanIPAni. These need `nameKeys` /
  `stripBreweryFromName` work, not an alias.
- **`Carlsberg / okocim jasne` → #319 + source note.** `carlsberg ↔ okocim` is an
  unsafe alias — Carlsberg is the multinational parent (Harnaś/Kasztelan/Książęce
  are siblings); aliasing it to one brand is a false-positive hub. The real issue
  is a **source mis-attribution** (parent company in the brewery field) compounded
  by name subset (`okocim jasne` vs `Okocim Jasne Okocimskie`).
- **`Cider` ↔ `Cidre` folding → #203 / with #319.** The probe shows it does not
  complete any match on its own, so it is not a standalone `normalize.ts` change
  now (YAGNI); it rides with the #319 name work.

## `spec.md` impact

None. `ALIAS_PAIRS` growth is data within the already-specified curated-alias
layer (spec § on brewery gate / #202); no behavior or schema change to document.
