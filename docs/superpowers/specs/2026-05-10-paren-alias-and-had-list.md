# Paren-alias dedup + scrape-based had-list

**Date:** 2026-05-10
**Branch sequence:** `feat/paren-alias-dedup` (PR-A) → `feat/scrape-had-list` (PR-B)

## Background

Bug report: `/newbeers` showed *Kemker Kultuur Brewery — Stadt Land Bier* even
though the user had drunk it according to Untappd.

Investigation revealed two independent gaps that compound:

1. **Catalog dedup gap.** The `beers` table held two rows for the same beer:
   - `id=12061`, `untappd_id=NULL`, `brewery="Kemker Kultuur Brewery"`,
     `normalized_brewery="kemker kultuur"` (ontap-side row).
   - `id=12093`, `untappd_id=2133795`, `brewery="Kemker Kultuur (Brauerei J. Kemker)"`,
     `normalized_brewery="kemker kultuur brauerei j kemker"` (untappd-side row).

   `brewerySlashAliases` collapses `X / Y` collaboration/bilingual breweries
   into either-side aliases, but does NOT handle the parenthesized form
   `X (Y)` Untappd uses for German breweries. So `matchBeer` in the ontap
   pipeline did not find the existing Untappd row and inserted a duplicate.
   `dedupeBreweryAliases` (the startup cleanup) only inspects `LIKE '% / %'`
   rows, so it never fired for paren-form pairs either.

2. **Drunk-set coverage gap.** `drunkBeerIds(db, tg_id)` returns only beers
   present in `checkins`, which is populated exclusively by manual
   `/import`. The `refreshAllUntappd` job scrapes the user's
   `/user/<X>/beers` page (the trailing-25 had-list, hard cap because the
   page does not paginate unauthenticated) but only writes `rating_global` —
   it does not record per-user "had" state. A user who hasn't re-imported
   since their last check-in still sees that beer in `/newbeers`.

The user's stated workflow: `/import` is a one-off backfill plus a
post-festival catch-up. Day-to-day filtering must work without it.

## Goals

- After PR-A: existing paren-form duplicates merge into the Untappd-side
  canonical row at next startup, and future ontap scrapes match the
  canonical row directly.
- After PR-B: a beer is filtered out of `/newbeers` and `/route` if either
  the user has a checkin for it OR the daily scrape has seen it on their
  Untappd had-list. `/import` is no longer required for daily use; it
  remains the bulk-backfill / post-festival path.

## Non-goals

- Increasing the 25-item scrape cap. Untappd does not paginate the
  `/user/<X>/beers` page anonymously; logged-in scraping is out of scope.
- Migrating existing checkins out of the `checkins` table. The two stores
  coexist and are unioned at read time.
- A general-purpose alias system for arbitrary brewery name variations
  beyond `/` and `(...)`.

## PR-A — Paren-alias dedup

### Matcher change

Rename `brewerySlashAliases` to `breweryAliases` and extend it to return
the union of:

1. The full normalized brewery (always present).
2. For each `/`-separated half: that half's normalized form.
3. For each `(...)`-enclosed segment: the inner text's normalized form,
   AND the outer text (everything outside parentheses) as its normalized
   form.

Example: `Kemker Kultuur (Brauerei J. Kemker)` →
`["kemker kultuur brauerei j kemker", "kemker kultuur", "brauerei j kemker"]`.

Mixed forms (`X / Y (Z)`) split on `/` first, then each half splits on
`(...)`. We have not seen this in production data but the algorithm
handles it for free.

`matchBeer` continues to call `breweryAliases` for both input and each
catalog row and computes overlap. No further changes there — the existing
`brewerySetsOverlap` + fuzzy fallback logic carries through.

### Dedup job change

`dedupeBreweryAliases` currently filters candidates with
`a.brewery LIKE '% / %'`. Extend to also match paren form:

```sql
WHERE (a.brewery LIKE '% / %' OR (a.brewery LIKE '%(%' AND a.brewery LIKE '%)%'))
```

The in-JS overlap check (`brewerySlashAliases(canonical)` → set, check
`orphan.normalized_brewery` membership) keeps the same shape but uses the
new `breweryAliases` function. The merge transaction (transfer
`match_links`, transfer `checkins`, delete orphan) is unchanged.

### One-time cleanup

The dedup job already runs at startup. The first boot after PR-A merges
will pick up paren-form duplicates and merge them. The
`Stadt Land Bier` pair (12061 → 12093) and the ~5 other identified pairs
collapse on that boot. Idempotent — second boot finds zero candidates.

### Tests

- Unit: `breweryAliases` for three forms (plain, `X / Y`, `X (Y)`) and
  the mixed `X / Y (Z)` form.
- Unit/integration: `dedupeBreweryAliases` with an in-memory DB seeded
  with a paren-form duplicate pair, asserting merge + match_link
  transfer + orphan deletion.

## PR-B — Scrape-based had-list

### New table

```sql
CREATE TABLE untappd_had (
  telegram_id INTEGER NOT NULL,
  beer_id INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (telegram_id, beer_id)
);
CREATE INDEX idx_untappd_had_telegram ON untappd_had(telegram_id);
```

Append-only with respect to user intent — once a beer is marked had, it
stays had even if it falls out of the trailing-25 window on Untappd.
`last_seen_at` is informational; not used for filtering.

### Storage helpers

`src/storage/untappd_had.ts`:

```ts
export function markHad(db: DB, telegramId: number, beerId: number, at: string): void;
export function hadBeerIds(db: DB, telegramId: number): Set<number>;
```

`markHad` uses `INSERT ... ON CONFLICT(telegram_id, beer_id) DO UPDATE
SET last_seen_at = excluded.last_seen_at`.

### Scrape job change

In `refreshAllUntappd`, after the `upsertBeer` / `findBeerByNormalized`
branch resolves to a `beer_id`, call `markHad(db, p.telegram_id,
beer_id, new Date().toISOString())`. The existing job runs each
beer-row write inline (no transaction), and a partial scrape is
already tolerated — `had` marks share that semantics. Wrap the
per-profile inner loop in `db.transaction(...)` only if the row count
warrants it during implementation; the spec does not require it.

### Read-side filter change

Introduce `triedBeerIds(db, telegramId): Set<number>` =
`drunkBeerIds ∪ hadBeerIds`. `drunkBeerIds` keeps its current signature
(internal, used by checkin-specific code paths). `/newbeers` and `/route`
switch their filter input to `triedBeerIds`.

`filterInteresting`'s parameter is currently named `drunk` — rename to
`tried` for clarity; the type stays `Set<number>`.

### Tests

- Unit: `markHad` (insert + upsert) and `hadBeerIds` returning the right
  set for the right user.
- Unit: `triedBeerIds` returning the union, with cases where only
  checkins / only had / both / neither match.
- Integration: stub the scraper, run `refreshAllUntappd` against an
  in-memory DB with a profile, assert `untappd_had` rows for that
  user-beer pair after the run.
- Integration: `/newbeers` excludes a beer that's only in `untappd_had`
  (no checkin), confirming the union flows end-to-end.

## Architecture spec updates (master spec §10)

Two new bullets under "Грабельки що ми вже наступили":

- **Paren-form brewery aliases.** Untappd renders breweries as `X (Y)`
  for German aliases ("Kemker Kultuur (Brauerei J. Kemker)"), parallel
  to the `X / Y` collaboration/bilingual form. Alias-overlap matching
  must treat both forms as "either side is a valid brewery for this
  beer", or ontap-side rows fail to find their Untappd canonical and
  duplicate. Caught 2026-05-10 via duplicate `beers#12061/12093`.

- **Two-source drunk model.** A beer is filtered from `/newbeers` and
  `/route` if it appears in EITHER `checkins` (manual `/import` bulk and
  post-festival catch-up) OR `untappd_had` (per-user trailing-25
  incremental scrape, populated by `refreshAllUntappd`). Relying on
  checkins alone forces users into a constant re-import loop for
  day-to-day use. Caught 2026-05-10 — same bug report as above.

## USER-GUIDE updates

Insert near the existing `/import` description:

> Для повсякденного відстеження достатньо вказати свій Untappd username
> через `/setuser <ім'я>`. Бот раз на добу підхоплює останні 25 пив зі
> сторінки `/user/<ім'я>/beers` і виключає їх з `/newbeers` та `/route`.
>
> `/import` потрібен для одноразового завантаження повної історії та
> після фестивалів, коли check-ins за день набагато перевищують 25.

## Rollout

1. Ship PR-A. Smoke after merge: confirm duplicate pairs (Kemker, Smykan
   etc.) merged in startup logs. Verify `/newbeers` no longer references
   a duplicated row in production data.
2. Ship PR-B. Wait for one full `refreshAllUntappd` cycle (≤24h) to
   populate `untappd_had` for the active user. Smoke `/newbeers` —
   beers from the user's recent had-list should disappear.
3. Capture any new gaps in §14 lessons.

## Risks

- **Paren-alias false positives.** A brewery legitimately named
  `Browar X (od 1923 r.)` would have its parenthetical interpreted as
  an alias. Mitigation: alias overlap is checked against actual catalog
  rows — a non-brewery parenthetical won't match any other row's
  brewery, so false aliasing is harmless in practice. We accept the
  imperfection; an allowlist of "known brewery aliases" is overkill.
- **Backfill cost on first boot.** PR-A's startup cleanup runs over the
  whole catalog (~12k rows). Already true today for the slash form;
  paren scan is the same shape and SQL plan. No new cost concern.
- **Untappd HTML drift.** `MAX_ITEMS = 25` is enforced in the parser; if
  Untappd changes the page structure, both the rating refresh and the
  had-list mark fail at once. Already a known fragility — same code
  path. Existing `userBeersScrape` tests cover the parser.
