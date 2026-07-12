# Re-arm alias-covered orphans — design

**Date:** 2026-06-29
**Status:** approved
**Related:** #202/#212 (curated brewery-alias layer), `src/domain/lookup-backoff.ts`, `docs/debug-orphan-matching.md`

## Problem

The Untappd orphan-lookup backoff (`lookup-backoff.ts`) is terminal: an orphan is
re-attempted at `[0, 72h, 168h, 728h]` and then, once `untappd_lookup_count >= 4`,
goes **dormant forever** until something resets its count.

When a matcher improvement ships — most commonly a new curated brewery-alias pair
(#212) — orphans that the fix now resolves do **not** retroactively benefit:

- A running process loads `ALIAS_PAIRS` at startup, so a merged/deployed alias does
  nothing until the service is **restarted**. Attempts made in the gap burn backoff
  against the old binary.
- Orphans that already reached `count >= 4` are dormant and the cron will never
  re-attempt them, even though they would now match.

Observed 2026-06-29: `Nepomucen → Nepo Brewing` and `Starkaft → Starkraft` match
live via `lookupBeer` (verified against Algolia), but ~10 Nepomucen beers sit at
`untappd_lookup_count = 4` (dormant) or high backoff and never get re-tried.

There is no re-arm mechanism today.

## Goal

A maintenance script that resets the lookup state of orphans the **curated alias
layer now covers**, so the enrich cron re-attempts them. Tie targeting to the alias
list automatically so future `ALIAS_PAIRS` additions are covered with zero friction.

## Non-goals (YAGNI)

- No per-brewery argument / ad-hoc filter (targeting is fully derived from the alias list).
- No auto-run on deploy (manual, operator-invoked).
- The script makes **no** Untappd calls — it only resets DB state; the cron does the lookups.
- No general re-arm of all orphans (that would re-query ~669 beers against a rate-limited Untappd).

## Components

### 1. `src/domain/brewery-aliases.ts` — `aliasKeys()`

Export `aliasKeys(): ReadonlySet<string>` — every normalized form that appears in
`ALIAS_PAIRS` (i.e. the keys of the existing `NEIGHBORS` map). Built once at module load.

### 2. `src/domain/matcher.ts` — `hasCuratedAlias()`

```ts
export function hasCuratedAlias(brewery: string): boolean
```

`true` iff `breweryAliases(brewery)` intersects `aliasKeys()`. This reuses the
existing normalization/expansion in `breweryAliases` (full form + collab parts +
paren parts + one curated hop), so it correctly:

- **includes** breweries whose normalized form is an alias key (`Nepomucen Brewery`
  → `[nepomucen, nepo]`, both keys);
- **excludes** plain collaborations that merely split into multiple tokens
  (`Stu Mostów / Ophiussa` → `[…, stu mostow, ophiussa]`, none are alias keys).

`breweryAliases(brewery).length > 1` is explicitly the WRONG predicate (collabs
trip it) — this is why a dedicated helper exists.

### 3. `scripts/rearm-aliased-orphans.ts` — CLI

Follows the `scripts/brewery-alias-key.ts` pattern (`tsx`, `require.main === module`
guard, pure core + thin CLI).

- **`selectRearmTargets(db): RearmTarget[]`** (pure, exported for tests) — selects
  beers where:
  - `untappd_id IS NULL` (orphan), AND
  - `untappd_lookup_count > 0` (already attempted — untried `count=0` orphans are
    already eligible and will be picked up by the cron, so skip them), AND
  - `hasCuratedAlias(brewery)`.

  Returns `{ id, brewery, name, untappd_lookup_count }[]`.

  Implementation: query the orphan + `count > 0` rows in SQL, filter by
  `hasCuratedAlias` in JS (normalization is JS-side).

- **`applyRearm(db, targets)`** (pure, exported) — within a single transaction,
  `UPDATE beers SET untappd_lookup_count = 0, untappd_lookup_at = NULL WHERE id = ?`
  for each target. Returns the count updated.

- **CLI `main(argv)`**:
  - opens `openDb(loadEnv().DATABASE_PATH)`;
  - `selectRearmTargets`;
  - **dry-run (default)**: print each `brewery / name (count=N)` and a summary
    `N orphan(s) would be re-armed (dry-run; pass --apply to write)`. No mutation.
  - **`--apply`**: `applyRearm`, print `Re-armed N orphan(s).`

### 4. `package.json`

Add `"rearm-aliased-orphans": "tsx scripts/rearm-aliased-orphans.ts"`.

### 5. `scripts/rearm-aliased-orphans.test.ts` (Vitest)

In-memory `better-sqlite3` with the `beers` schema. Seed:

- an alias-covered orphan with `count = 4` → **selected**;
- an alias-covered orphan with `count = 0` → **not selected** (untried);
- a plain collab orphan (`Stu Mostów / Ophiussa`, `count = 2`) → **not selected**;
- an already-matched alias-brewery beer (`untappd_id` set, `count = 4`) → **not selected**;

Assert: `selectRearmTargets` returns exactly the first row; `applyRearm` resets its
`untappd_lookup_count` to 0 and `untappd_lookup_at` to NULL; a second
`selectRearmTargets` after apply returns `[]` (**idempotent** — the `count > 0`
filter excludes already-re-armed rows).

Also a `hasCuratedAlias` unit test (matcher.test.ts): true for `Nepomucen Brewery`
/ `Starkaft Brewery`, false for `Stu Mostów / Ophiussa` and an unrelated brewery.

## Data flow

```
loadEnv().DATABASE_PATH → openDb → selectRearmTargets(db)
  ├─ (default)  print targets + "would be re-armed (dry-run)"
  └─ (--apply)  applyRearm(db, targets) in a txn → "Re-armed N"
```

No Untappd traffic. The next enrich-cron tick performs the real lookups against the
now-reset rows.

## Operational note (runbook)

`docs/debug-orphan-matching.md` gains:

1. **Re-arm workflow** — after adding a curated alias (or any matcher fix) and
   **redeploying + restarting** the service, run `npm run rearm-aliased-orphans`
   (dry-run to preview, then `--apply`). Explains the terminal-backoff / restart-gap
   reason this is necessary.
2. **`enrich_failures` triage columns** — `source_url` (shop host, `''` = cron) and
   `review_class` (`parser_bug` / `matcher_bug` / `not_on_untappd` / `wontfix`) as the
   entry point for orphan analysis.

## Idempotency & safety

- Dry-run is the default; mutation requires `--apply`.
- `--apply` is idempotent: re-armed rows drop to `count = 0` and are excluded from the
  next selection by the `count > 0` filter.
- The UPDATE runs in one transaction.
