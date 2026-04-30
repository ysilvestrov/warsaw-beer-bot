# Cleanup ABV-Polluted Ontap Rows — Design Spec

**Date:** 2026-04-30
**Status:** Approved (design); pending plan + implementation
**Related:** Continuation of `2026-04-29-brewery-alias-dedup.md` (out-of-scope cleanup task referenced in §14 lesson "ABV-polluted ontap rows").

## Problem

Before Task 25 (refresh-ontap parser cleanup), the bot stored full `<h4>` text from ontap.pl as the canonical beer name — including brewery prefix, ABV/strength markers, and style suffix. Example legacy row:

```
id=306, brewery="Wagabunda Brewery",
  name="Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale",
  normalized_name="wagabunda brewery oxymel 14 4 5 ale"
```

Current parser produces clean rows for the same beer:

```
id=11877, brewery="Wagabunda Brewery", name="Oxymel",
  normalized_name="oxymel"
```

Both rows coexist with `untappd_id=NULL`. The polluted row never matches any future tap (its normalized_name is junk) and pollutes `/newbeers`/`/route` rendering for any user whose drunk-set links to the polluted id.

**Scope check (prod DB, 2026-04-30):** 495 of 663 ontap-side rows (≈75%) match the pollution pattern (name contains `\d+\s*[°%]` or ` — `). They linger from pre-Task 25 scrapes.

## Goal

A single idempotent startup job that:
1. Detects polluted ontap-side rows.
2. Re-derives the clean beer name with the existing parser's `extractBeerName(name, brewery)`.
3. Either **merges** the polluted row into a canonical row (when `matchBeer` finds one with confidence ≥ 0.9), repointing `match_links` + `checkins`, or **rewrites in place** (`name`, `normalized_name`).

Convergence: after first boot post-deploy the catalog is clean; subsequent boots find 0 polluted rows.

## Non-goals

- Re-scraping ontap.pl. The cleanup operates on existing DB state only.
- Rewriting `brewery` field — `normalized_brewery` is already correct on these rows (the polluted suffix lives in `name`, not `brewery`).
- Touching Untappd-side rows (`untappd_id IS NOT NULL`).

## Architecture

New file `src/jobs/cleanup-polluted-ontap.ts` exporting:

```ts
export interface CleanupResult {
  rewritten: number;  // in-place name updates
  merged: number;     // polluted rows folded into canonical and deleted
}

export function cleanupPollutedOntap(db: DB, log: pino.Logger): CleanupResult
```

Called in `src/index.ts` immediately after `dedupeBreweryAliases(db, log)`.

### Detection

SQLite has no JS regex; pull all `untappd_id IS NULL` rows once, filter in JS:

```ts
const POLLUTION_RE = /\d+(?:[.,]\d+)?\s*[°%]| — /;
```

The ` — ` (em-dash with spaces) catches style-suffix patterns even when ABV is absent. Either marker is sufficient.

### Per-row algorithm

```
polluted = rows where untappd_id IS NULL AND name matches POLLUTION_RE
clean_pool = rows in beers where id NOT IN polluted   // candidates for merge

for each polluted row P:
  cleaned = extractBeerName(P.name, P.brewery)
  if cleaned is empty or normalizeName(cleaned) === normalizeName(P.name):
    skip   // either nothing to clean, or cleanup didn't help
  match = matchBeer({brewery: P.brewery, name: cleaned, abv: P.abv}, clean_pool)
  if match and match.confidence >= 0.9:
    // merge — repoint match_links + checkins, delete P
    UPDATE match_links SET untappd_beer_id = match.id WHERE untappd_beer_id = P.id
    UPDATE checkins    SET beer_id         = match.id WHERE beer_id        = P.id
    DELETE FROM beers WHERE id = P.id
    merged++
  else:
    // in-place rewrite
    UPDATE beers
       SET name = cleaned,
           normalized_name = normalizeName(cleaned)
     WHERE id = P.id
    rewritten++
```

Whole pass wrapped in a single `db.transaction(...)` for atomicity. After commit, re-running the job finds 0 polluted rows (the rewrite makes them clean; merges remove them).

### Match confidence threshold

Threshold is **0.9** — covers exact (1.0) and near-exact fuzzy hits (≥0.9 means the searcher is highly confident the beer name is the same modulo whitespace/punctuation noise). Below 0.9 we fall back to in-place rewrite rather than risk merging unrelated beers.

### Why import `extractBeerName` from `src/sources/ontap/pub.ts`

It is already exported and unit-tested — same logic the live parser uses. Avoids reimplementing the brewery-prefix-strip + ABV-truncate heuristic, and guarantees consistency: any string the parser would produce, the cleanup converges on.

## Files

**New:**
- `src/jobs/cleanup-polluted-ontap.ts`
- `src/jobs/cleanup-polluted-ontap.test.ts`

**Modified:**
- `src/index.ts` — import + call after `dedupeBreweryAliases`.
- `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` — append §14 lesson entry.

## Tests

In-memory DB seeded via `migrate(db)` + `upsertBeer`:

1. **Empty DB → no-op:** `{rewritten: 0, merged: 0}`.
2. **Single polluted row, no canonical:** rewrites in place. `name` and `normalized_name` updated. Other fields untouched.
3. **Polluted + canonical (Wagabunda Oxymel pair):** merges polluted into canonical. `match_links`, `checkins` repointed. Polluted row gone. Canonical intact.
4. **Polluted with both ontap and untappd canonicals (matcher prefers untappd-side):** merges into untappd-side row (matcher returns lowest-id exact match; untappd-side typically lower id since imports run first). Verifies the cross-source merge path.
5. **Two polluted rows resolving to the same clean name:** both merge into the same canonical (or, if no canonical exists, both rewrite in place — and become a duplicate pair the next dedup-aliases pass would handle).
6. **Idempotent:** second invocation returns `{rewritten: 0, merged: 0}`.
7. **Negative — clean row preserved:** rows without pollution markers are untouched.
8. **Below-threshold fuzzy match (e.g., very different cleaned name) → in-place rewrite, not merge.**

Add ≥1 unit test confirming the SQL-level transaction is atomic (kill mid-loop, no partial state) — optional, depends on test ergonomics.

## Edge cases

- **Cleaned name equals empty string** (h4 text was just brewery + ABV with no real beer name) — skip the row. Such rows are stuck in DB but harmless once the parser stops producing them.
- **Brewery prefix in `name` doesn't match `brewery` field** (rare data drift) — `extractBeerName` falls through and returns name truncated only at ABV. Still typically an improvement; merge or rewrite as usual.
- **Match returns the polluted row itself or another polluted row** — prevented by passing only the `clean_pool` (catalog minus all polluted ids) to `matchBeer`. Merge targets are guaranteed clean.
- **Two polluted rows resolving to the same clean name with no clean canonical** — both rewrite in place and become a same-brewery duplicate pair. Out of scope for this job; the existing `dedupeBreweryAliases` and any future broader dedup pass will pick them up.

## Risks

- **Over-aggressive merge.** A polluted row whose cleaned name accidentally fuzzy-matches an unrelated clean beer (e.g., "Oxymel" vs "Oxytocin" — fast-fuzzy is forgiving). Mitigation: 0.9 threshold + `normalizeBrewery` must overlap (already enforced by `matchBeer`'s exact-then-fuzzy flow with brewery-aliased filter).
- **In-place rewrite collides with existing clean row** of the same brewery + cleaned name. The `UPDATE` doesn't itself fail (no unique constraint on `normalized_name + normalized_brewery`), but creates a duplicate pair. Acceptable: the existing dedup-brewery-aliases job — or a future broader dedup — picks them up. Alternatively, after the rewrite step, run a second pass that merges any new same-brewery-and-cleaned-name pairs. Defer for now.

## Lesson to log in §14

```markdown
- **Polluted ontap-row cleanup**: pre-Task 25 scrapes left ~500 rows where
  `name` was the full `<h4>` text (brewery + name + ABV + style suffix).
  Cleaned at startup by `src/jobs/cleanup-polluted-ontap.ts`: re-runs the
  parser's `extractBeerName` on each ontap-side (`untappd_id IS NULL`) row
  whose name still matches the pollution regex (`\d+[°%]` or ` — `), then
  either merges into a canonical match (confidence ≥ 0.9, exact or
  high-fuzzy) or rewrites in place. Idempotent — second boot finds 0 rows.
```
