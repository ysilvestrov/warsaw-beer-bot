# Capture `global_weighted_rating_score` From Untappd Imports — Design Spec

**Date:** 2026-04-30
**Status:** Approved (design); pending plan + implementation
**Phase:** 0 of 4 in the post-PR-#30 follow-up sequence (Designs 3, 4, 1, 2).

## Problem

`beers.rating_global` is populated in only 232 of 11,979 catalog rows (≈ 1.9 %). Investigation found two upstream bugs:

1. **`src/bot/commands/import.ts:64`** — the JSON / CSV import flow hard-codes `rating_global: null`. The Untappd export contains `global_weighted_rating_score` (and `global_rating_score`) for every row; both are silently dropped at ingestion. This explains the bulk of the gap: ~6 000 rows from `/import` runs all have NULL.
2. **`src/jobs/refresh-untappd.ts:42`** — `rating_global: it.rating_score` is misuse of the user's *personal* rating (`data-rating` from profile-feed scrape) as if it were a global community rating. Wrong semantics. Out of scope here; the entire job is being rewritten in Design 4.

This spec addresses bug 1: read `global_weighted_rating_score` from JSON / CSV imports and store it in `beers.rating_global`.

## Goal

After deploy, when the user re-runs `/import` on their existing Untappd export, every row that has `global_weighted_rating_score` in the export populates `beers.rating_global`. `upsertBeer`'s existing UPDATE branch (`src/storage/beers.ts:24`) already updates `rating_global` on existing rows, so the backfill is a one-shot user action: re-import → 6 000+ rows gain a real global rating in seconds.

## Non-goals

- Backfilling without a user `/import` action. The existing import flow already does the right thing once we stop dropping the field.
- Capturing both `global_weighted_rating_score` and `global_rating_score`. We pick **weighted** — the value Untappd publicly displays on every beer page. Adding a second column would require migration and provide marginal value.
- Reading `total_toasts`, `total_comments`, `flavor_profiles`, etc. Out of scope.
- Fixing `refresh-untappd.ts` here. Rewritten in Design 4.

## Choice: weighted vs. raw global

Untappd's JSON export carries two fields:

- `global_rating_score` — arithmetic mean of every check-in.
- `global_weighted_rating_score` — Bayesian-weighted average; Untappd's public "rating" displayed on beer pages and in apps. Reduces low-volume distortion.

We store **`global_weighted_rating_score`** as `beers.rating_global`. Rationale:

- Matches what Untappd shows users elsewhere (consistency with mental model).
- More robust to brand-new beers with three 5-star check-ins (raw mean overstates).
- The fallback render path (Design 2) is meant to surface a representative rating; weighted is the right choice for that.

If the field is absent (e.g. very old export format, or a free-tier export), we fall back to NULL.

## Architecture

Two file changes, both small.

### `src/sources/untappd/export.ts`

Add `global_rating: number | null` to the `Checkin` interface. Both `mapCsv` and `mapJson` read `global_weighted_rating_score` (column / key) and surface it on this field. Defensive: `numOrNull` already coerces missing/invalid values to `null`.

```ts
export interface Checkin {
  // existing fields...
  rating_score: number | null;        // user's personal rating (unchanged)
  global_rating: number | null;        // NEW — Untappd weighted global
}

function mapCsv(r: Record<string, string>): Checkin {
  return {
    // ...
    rating_score: numOrNull(r['rating_score']),
    global_rating: numOrNull(r['global_weighted_rating_score']),
    // ...
  };
}

function mapJson(r: Record<string, unknown>): Checkin {
  return {
    // ...
    rating_score: numOrNull(r['rating_score']),
    global_rating: numOrNull(r['global_weighted_rating_score']),
    // ...
  };
}
```

### `src/bot/commands/import.ts:64`

Replace `rating_global: null` with `rating_global: r.global_rating`.

```ts
const beerId = upsertBeer(db, {
  // ...
  rating_global: r.global_rating,
  // ...
});
```

That's the entire functional change.

## Files

**Modified:**
- `src/sources/untappd/export.ts` — interface field + read in two mappers.
- `src/sources/untappd/export.test.ts` — assertions for the new field (CSV + JSON).
- `src/bot/commands/import.ts` — pass-through.

**Not modified:** schema, storage helpers, other commands.

## Tests

Append to `src/sources/untappd/export.test.ts`:

1. **CSV row with `global_weighted_rating_score=3.66`** → `Checkin.global_rating === 3.66`.
2. **JSON row with `global_weighted_rating_score=3.66`** → same.
3. **CSV row missing column** → `Checkin.global_rating === null`.
4. **JSON row missing key** → `Checkin.global_rating === null`.
5. **CSV row with empty string `""`** → `Checkin.global_rating === null` (`numOrNull` already handles this; just verify).

Existing tests should pass unchanged — `rating_score` semantics are untouched.

No need for an `import.ts` integration test; the change is a single field assignment, covered by the unit test on `mapJson` / `mapCsv` plus the existing import smoke (which still asserts row counts and basic shape).

## Operational rollout

After merge + deploy:
- Tell the user (in PR description) to run `/import` once with their existing JSON / CSV export. `upsertBeer` UPDATEs `rating_global` on existing rows; ≈ 6 000 rows get a non-NULL global rating. `/newbeers` and `/route` start using the new fallback (Design 2) once that lands.
- New imports automatically populate the field going forward.

## Lesson to log in §14 of the canonical spec

Append after the brewery-alias dedup entry (commit during implementation, not in this spec doc):

```markdown
- **Untappd `global_weighted_rating_score`**: the public "rating" Untappd
  shows on each beer page. Untappd JSON / CSV exports include it on every
  row. Read into `beers.rating_global` at `/import` time
  (`src/sources/untappd/export.ts` + `src/bot/commands/import.ts`).
  Re-importing the same export backfills `rating_global` for existing rows
  via `upsertBeer`'s UPDATE branch — no migration needed.
```

## Risks

- **Old export format without `global_weighted_rating_score`.** Defensive: `null` fallback. Backfill skipped for those rows; same outcome as today.
- **Untappd renames the field in future exports.** Single line to update; no schema impact.
- **Weighted vs. raw mismatch.** If we ever switch to raw, it's a one-line change in two mappers. Not enough churn risk to add a column.
