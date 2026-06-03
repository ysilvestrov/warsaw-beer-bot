# Investigation: ABV/IBU swapped for "GARDEES II - 2025"

**Date:** 2026-06-03
**Symptom:** Beer line rendered as
`24 • Brasserie La Malpolon Brewery GARDEES II - 2025 • 40% • 3.9 • 🟢`
ABV shows **40%**, impossible for a Bière de Garde.

## Phase 1 — Root cause investigation

### Evidence chain

1. **`beers` table** (matched beer, `untappd_id=6400148`):
   - `abv` = **NULL**, `rating_global` = 3.85 (→ "3.9" on screen ✓).
   - So the displayed `40%` does **not** come from `beers.abv`. It falls back to the
     tap snapshot's ABV.

2. **`taps` table** (latest snapshots, White Crow pub, tap 24):
   - `abv = 40.0`  ❌
   - `ibu = 8.4`   ❌ (8.4 is the *real* ABV)
   - `style` = "Assemblage 2025 de bières de garde élevées en barriques …" — the
     French **description**, not a style.

3. **Source HTML** (`https://white-crow.ontap.pl/`, the panel for this beer):
   ```html
   <h4 class="cml_shadow"><span>
     <b class="brewery">Brasserie La Malpolon Brewery</b><br/>
     GARDEES II - 2025 <img .../><br/>
     40,0%&nbsp;                         <!-- ABV field on source = 40,0% -->
   </span></h4>
   <span class="cml_shadow"><b>Assemblage 2025 de bières de garde …</b></span>
   ...
   <kbd>8.4 IBU</kbd>                     <!-- IBU field on source = 8.4 -->
   ```

### Conclusion

**The data is wrong at the source.** The pub (White Crow) entered the values
swapped in the ontap system: ABV field = `40,0%`, IBU field = `8.4`. In reality
GARDEES II ≈ **8.4% ABV** and ~**40 IBU**.

Our parser (`src/sources/ontap/pub.ts`) is behaving correctly — it faithfully
extracts:
- `abv` from the first `\d+%` in the `<h4>` → 40,0 → 40.0
- `ibu` from `<kbd>… IBU</kbd>` → 8.4

So this is **not a parser field-crossing bug**; it's garbage-in.

### Scope (prod DB, read-only)

- Beers with `abv > 30` ever recorded: exactly **one** — GARDEES II (40.0),
  across 21 snapshot rows.
- Beers with `abv` 15–20: 83 rows — all legitimate strong beers (Ice bock 16%,
  Vanilla Gorilla 16% …). **Must not be touched.**
- Isolated single-pub bad-data case.

### UPDATE — Untappd HAS the correct ABV

Untappd search for this beer (`/b/brasserie-la-malpolon-gardees-ii-2025/6400148`)
returns **`8.4% ABV`**, style `Farmhouse Ale - Bière de Garde`. So the authoritative
ABV is available — we just never store or prefer it.

Two gaps found:

1. **Ingestion gap — `beers.abv` is NULL though Untappd has it.**
   - `parseUserBeersPage` (the "had"-list scraper, `src/sources/untappd/scraper.ts`)
     does **not parse abv at all**.
   - `refresh-untappd.ts:48` hardcodes `abv: null` when inserting a newly-seen beer,
     and for existing matched beers only refreshes `rating_global` (never abv).
   - (The orphan-lookup path `recordLookupSuccess` *does* write abv via
     `abv = COALESCE(?, abv)`, but this beer arrived via the had-list scrape, so abv
     stayed null.)

2. **Display gap — ABV never falls back to Untappd.**
   `tapsForSnapshotWithBeer` (`src/storage/snapshots.ts:67`) already does
   `COALESCE(t.u_rating, b.rating_global) AS u_rating` for the rating (why "3.9"
   showed despite an empty tap rating), but ABV is selected as bare `t.abv` — no
   fallback to `b.abv`. So the display always trusts the (garbage) tap ABV.

## Phase 2/3/4 — Fix (pending decision)

Preferred, principled fix (mirrors the existing rating pattern; Untappd is
authoritative for matched beers):

- **Display:** in `tapsForSnapshotWithBeer`, use `COALESCE(b.abv, t.abv) AS abv`
  (beer/Untappd first, tap fallback). For matched beers, Untappd's 8.4% wins over
  the tap's bogus 40%. Also covers `/newbeers` if it shares the join.
- **Ingestion:** parse abv in `parseUserBeersPage` and stop hardcoding `abv: null`
  in `refresh-untappd.ts`, so `beers.abv` actually gets populated from Untappd.

Optional belt-and-suspenders for **orphans** (no Untappd data to fall back on):
drop implausible tap ABV (`abv > 30 → null`) in `parsePubPage`. Zero false
positives (legit max on Warsaw taps ≈ 16%).

All to be implemented test-first (TDD). Behaviour change → spec.md review per
CLAUDE.md.

## RESOLUTION (implemented, branch `fix/abv-prefer-untappd`)

Chosen scope: **display + ingestion** (no orphan guard).

1. **Display** — `tapsForSnapshotWithBeer` now selects `COALESCE(b.abv, t.abv) AS abv`
   (`src/storage/snapshots.ts`). Fixes both `/beers` and `/newbeers`.
2. **Ingestion (parse)** — `parseUserBeersPage` parses `.abv` (`8.4% ABV` → 8.4)
   from the had-list row (`.abv` sits outside `.beer-details`, so scoped to row).
3. **Ingestion (store)** — `refreshAllUntappd` inserts `abv: it.abv` for new beers
   and backfills existing matched beers via `abv = COALESCE(?, abv)` (never wipes a
   known abv with a missing one).

Tests: 430/430 pass, `tsc --noEmit` clean. spec.md updated.

**Prod resolution of the reported beer:** GARDEES (beers.id 12373) is in
`untappd_had` for user 207079110, so the next `refreshAllUntappd` cron run
backfills `beers.abv = 8.4`, after which the display shows `COALESCE(8.4, 40) = 8.4`.

**Known limitation:** 102 matched beers still have NULL abv; they backfill
opportunistically as they reappear in a had-list's top-25 (`MAX_ITEMS`). A one-time
backfill of those was out of the chosen scope.
