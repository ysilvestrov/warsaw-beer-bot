# Rating Fallback to Catalog `rating_global` — Design Spec

**Date:** 2026-04-30
**Status:** Approved (design); pending plan + implementation

## Problem

`/newbeers` and `/route` render `⭐ —` whenever ontap.pl's tap snapshot lacks a Untappd rating (`tap.u_rating` is NULL). This is the case for any beer ontap.pl couldn't link to Untappd at scrape time — common for new releases or beers under non-canonical names.

The bot's catalog often has a non-NULL `rating_global` for the same beer (sourced from a previous scrape of a different pub, or from the user's Untappd refresh job). Today this catalog rating is unused at render time.

**Scope check (prod DB, 2026-04-30):** 232 of 11,979 catalog rows have `rating_global` populated (1.9%). User-visible impact is small but strict improvement; no risk of showing wrong data because both sources are global Untappd ratings.

## Goal

When a tap surfaces in `/newbeers` or `/route`:
- If `tap.u_rating` is non-NULL → use it (current behavior).
- Else if the tap is matched to a catalog row whose `rating_global` is non-NULL → use `rating_global`.
- Else → render `⭐ —` (current fallback).

Render layer is unchanged. Fallback is **transparent** — no asterisk, no dim star (per user decision; both values are equivalent global Untappd ratings).

## Non-goals

- Backfilling `taps.u_rating` at write time. Snapshots stay raw — they record what ontap.pl showed at scrape time, even if that was NULL. Fallback lives at read time only.
- Visual distinction between rating sources.
- Fallback for filters' `min_rating` threshold? **In scope** as a side-effect — `filterInteresting` operates on the same `u_rating` field, so it now sees fallback values. This is desirable: a beer the user filtered out for "low rating" shouldn't be excluded just because ontap.pl didn't return a rating.

## Architecture

Single-query JOIN: replace the per-tap `getMatch(...)` lookup in `/newbeers` and `/route` with a new storage helper that does match + rating coalesce in one SQL.

### New helper

`src/storage/snapshots.ts`:

```ts
export interface TapWithBeer extends TapRow {
  beer_id: number | null;
  // u_rating field on the parent TapRow is now the COALESCEd value:
  // tap.u_rating ?? beers.rating_global ?? null
}

export function tapsForSnapshotWithBeer(db: DB, snapshotId: number): TapWithBeer[] {
  return db.prepare(`
    SELECT
      t.id, t.snapshot_id, t.tap_number, t.beer_ref, t.brewery_ref,
      t.abv, t.ibu, t.style,
      COALESCE(t.u_rating, b.rating_global) AS u_rating,
      ml.untappd_beer_id AS beer_id
    FROM taps t
    LEFT JOIN match_links ml ON t.beer_ref = ml.ontap_ref
    LEFT JOIN beers b ON ml.untappd_beer_id = b.id
    WHERE t.snapshot_id = ?
    ORDER BY t.tap_number
  `).all(snapshotId) as TapWithBeer[];
}
```

The `LEFT JOIN`s preserve unmatched taps (`beer_id` becomes NULL, `u_rating` stays as raw `tap.u_rating`).

### Caller refactor

`src/bot/commands/newbeers.ts:36-43` and the matching block in `src/bot/commands/route.ts`:

**Before:**
```ts
const taps = tapsForSnapshot(db, snap.id).map((t) => ({
  beer_id: getMatch(db, t.beer_ref)?.untappd_beer_id ?? null,
  style: t.style,
  abv: t.abv,
  u_rating: t.u_rating,
  beer_ref: t.beer_ref,
  brewery_ref: t.brewery_ref,
}));
```

**After:**
```ts
const taps = tapsForSnapshotWithBeer(db, snap.id);
```

`taps` is now directly compatible with `filterInteresting` and the candidate-construction loop because `TapWithBeer` already exposes `beer_id`, `u_rating`, `beer_ref`, `brewery_ref`, `style`, `abv`.

## Files

**Modified:**
- `src/storage/snapshots.ts` — add `tapsForSnapshotWithBeer` + type. Keep `tapsForSnapshot` (still used internally for raw-tap reads, e.g., when ingesting).
- `src/storage/snapshots.test.ts` — fallback tests (see below).
- `src/bot/commands/newbeers.ts` — replace per-tap `getMatch` with new helper.
- `src/bot/commands/route.ts` — same.
- (Optional) `src/bot/commands/newbeers.ts` — drop unused `getMatch` import if no remaining call sites.

**Not modified:** rendering code (`newbeers-format.ts`, `route-format.ts`), filter code (`filters.ts`). They consume `u_rating` blindly.

## Tests

New tests in `src/storage/snapshots.test.ts`:

1. **Tap with non-NULL `u_rating` and no matched beer** → returns `u_rating` from tap, `beer_id: null`.
2. **Tap with NULL `u_rating`, matched to a beer with `rating_global`** → returns `rating_global` as `u_rating`, `beer_id` set.
3. **Tap with non-NULL `u_rating`, matched to a beer with different `rating_global`** → returns tap's `u_rating` (not catalog) — fallback only kicks in on NULL. (Verifies COALESCE order.)
4. **Tap with NULL `u_rating`, matched to a beer with NULL `rating_global`** → returns NULL, `beer_id` set.
5. **Tap unmatched** → returns NULL u_rating, NULL beer_id.

Existing `/newbeers` and `/route` integration tests should keep passing without changes (the field semantics are preserved; new fallback only activates when `tap.u_rating` was previously NULL).

## Risks

- **Stale catalog rating.** If a beer's Untappd rating drifted since it was scraped from another pub, the fallback shows yesterday's number. Acceptable: the alternative is `⭐ —`, which is strictly less informative. Catalog ratings refresh whenever ontap re-scrapes a pub that does carry the rating.
- **Filter side-effects.** `min_rating` filter now applies to fallback ratings. This is desirable (closes a current loophole where unmatched taps bypassed the filter). Worth a release-note line.
- **Query cost.** Two extra LEFT JOINs per snapshot read. With <100 taps per snapshot and indexed `match_links.ontap_ref` + `beers.id` (PK), negligible.

## Migration

None. Pure read-time change.

## Lesson to log in §14

```markdown
- **Rating fallback (catalog → tap)**: `tap.u_rating` is the rating ontap.pl
  showed at scrape time; often NULL when ontap.pl hasn't matched the beer
  to Untappd. `tapsForSnapshotWithBeer` (`src/storage/snapshots.ts`) now
  COALESCEs into `beers.rating_global` from the matched catalog row,
  giving render and `min_rating` filter a usable rating in the ~2 % of
  rows where the catalog has one but the tap doesn't.
```
