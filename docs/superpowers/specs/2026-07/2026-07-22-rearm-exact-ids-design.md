# Rearm by exact beer IDs

**Issue:** follow-up from #326 deploy (2026-07-22). The rescued orphan (32760) was *excluded*
by the rearm tool's own filter, forcing a manual SQL reset.
**Date:** 2026-07-22
**Scope:** `scripts/rearm-matcher-bug-orphans.ts` + shared helper in `scripts/rearm-aliased-orphans.ts`.
CLI only; the backoff-reset write (`applyRearm`) is unchanged.

## Problem

`npm run rearm-matcher-bug-orphans` selects orphans via
`review_class='matcher_bug' AND candidates_count > 0`. The `candidates_count > 0` clause exists so
the default run targets gate/fuzzy rejects (a real candidate was returned). But the whole point of a
**query-noise** fix like #326 is the *zero-candidate* class: 32760 (`Plum Plum Plum 12,5°·4`) had
`candidates_count = 0`, so the tool skipped exactly the beer the fix rescued. We re-armed it by hand
with `UPDATE beers SET untappd_lookup_count=0, untappd_lookup_at=NULL WHERE id=32760`.

An operator who knows which beer(s) a fix targets should be able to re-arm them directly, without the
default query's filters getting in the way.

## Design

### CLI — follow the existing `--ids` convention

`scripts/retire-resolved-orphans.ts` already establishes the project convention for an
operator-supplied ID list: a space-separated flag with a comma-separated value, plus the
dry-run-by-default `--apply` write flag. npm itself imposes no format (`npm run x -- <args>` forwards
everything after `--` verbatim), so we match the in-repo precedent rather than invent syntax.

```
npm run rearm-matcher-bug-orphans -- --ids 32760,32812        # dry-run
npm run rearm-matcher-bug-orphans -- --ids 32760,32812 --apply # write
npm run rearm-matcher-bug-orphans -- --apply                   # unchanged: matcher-bug query mode
```

`--ids` present → **exact-id mode**, which *replaces* the default `matcher_bug`/`candidates_count`
selection (bypasses both filters). `--ids` absent → existing behavior, unchanged. Parsing mirrors
`retire-resolved-orphans`: `argv.indexOf('--ids')`, split on comma, `parseInt` + `Number.isInteger`.

### Selection — orphan-only gate

New exported helper in `scripts/rearm-aliased-orphans.ts` (beside `applyRearm`, so it is reused and
unit-tested):

```sql
SELECT id, brewery, name, untappd_lookup_count
  FROM beers
 WHERE id IN (…) AND untappd_id IS NULL
 ORDER BY id
```

The only gate is "still an orphan" (`untappd_id IS NULL`). `review_class` and `candidates_count` are
ignored entirely, so a `parser_bug` / zero-candidate orphan **is** returned when its ID is requested.

### Safety / output

After selecting, compare the returned IDs against the requested set. For every requested ID that is
not re-armable, print a warning and skip it (never reset a matched beer):

```
⚠ 12345: skipped (missing or already matched)
```

Then the usual flow: dry-run prints the target list; `--apply` calls the unchanged `applyRearm`
(`untappd_lookup_count=0, untappd_lookup_at=NULL`, single transaction).

## Documentation

Update the rearm runbook in `spec.md` (§ operator runbook, currently the
`npm run rearm-matcher-bug-orphans` paragraph) to document the `--ids <csv>` exact-id escape-hatch,
and add one line recording the shared ops-tooling argument convention (`--ids <csv>` for an explicit
`beer_id` list, `--apply` to write / dry-run by default — same as `retire-resolved-orphans`).

## Testing

`selectRearmTargetsByIds(db, ids)` (Vitest, in-memory DB via the existing `insertFailure` harness):

- returns orphan rows for the requested IDs, in id order;
- excludes already-matched IDs (`untappd_id` set) and nonexistent IDs;
- **includes** a `parser_bug` / `candidates_count=0` orphan when its ID is requested — proving the
  class/candidate filters are bypassed in exact-id mode.

## Out of scope

- Exact-id support in `rearm-aliased-orphans.ts`'s own `main` (helper is shared, but only the
  matcher-bug tool wires up the CLI — YAGNI until needed).
- Any change to `applyRearm` or the backoff-reset semantics.
