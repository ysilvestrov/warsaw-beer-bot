# Retire resolved orphans (#286)

**Status:** design
**Issue:** #286 — Ops: retire stale enrich failures after parser fixes
**Date:** 2026-07-19

## Problem

Parser/filter fixes prevent *new* polluted rows, but the `enrich_failures` rows
they were meant to resolve stay classified in production indefinitely. A row is
only ever removed on a successful match (`clearEnrichFailure`); nothing else
clears it. So resolved clusters (wine/spirit now filtered, Funkyshop #259,
Menabrea/brewery=name #238) keep appearing "active" in ops views and inflate the
orphan count.

Prod reality (2026-07-19) that shapes the design:

- Classified rows are mostly **on-tap and still live** — e.g. `parser_bug` is 90
  on-tap / 7 off-tap. They are re-queried every enrich cycle and keep their class
  because `recordEnrichFailure` preserves `review_class` across re-fails.
- Sampling on-tap `parser_bug` rows, **most are still genuinely broken**
  (`VINO KARPATIA / Biały bez`, `Forest IPA Brewery / Forest IPA`,
  `Konrad Brewery 12° 12°`, …), not resolved fossils.

**Consequence:** retirement cannot be driven by age or by `review_class` alone —
that would nuke live, still-failing orphans. Each retirement needs a per-row
*"is this actually resolved now"* signal.

## Scope

- **In:** a manual ops script that moves *provably-resolved* classified
  `enrich_failures` rows to a terminal `retired` state, and stops those rows from
  polluting the enrich pool, triage, ops views, and the daily digest count.
- **Out:** `beers`/catalog cleanup, off-tap garbage collection, re-ingestion,
  anything touching untriaged (`review_class IS NULL`) rows.
- **Out:** rows whose underlying parser bug is **still live** — e.g. the Konrad /
  Krakonoš trailing-°Plato cluster (beer `12289`, tracked in #306). These are
  not resolved; they must be *fixed*, not retired. Such a row becomes
  retire-eligible (escape hatch) only after its fix ships and re-ingestion has
  had a chance to produce a matched replacement.

Non-goal: automatically *detecting* resolution for fix categories that cannot be
re-derived from stored data (see §Selection). Those go through an explicit
operator-supplied escape hatch, and only for clusters whose fix is already
deployed.

## Selection — two verified paths

The tool never selects by age or by `review_class` alone. Both paths print the
affected rows for a dry-run eyeball before any write.

### Auto path (default)

Select orphan (`untappd_id IS NULL`) `enrich_failures` rows whose stored beer,
mapped to `{ style, brewery_ref: brewery, beer_ref: name }`, makes the **current**
`isOntapNonBeerTap` (`src/sources/ontap/non-beer.ts`) return `true`.

That is the proof of resolution: the live pipeline would now reject this beer; it
only survives because its `beers`/`match_links` rows predate the filter (the
filter blocks new creation but does not retroactively remove existing rows). This
is the only reusable verification predicate in the codebase, and it demonstrably
catches real live rows (e.g. `VINO KARPATIA` → brewery contains `vino`).

Output prints the tripping signal (token / sentinel) per row so the retirement is
self-justifying.

Auto path records a fixed note: `retired: current non-beer filter rejects`.

### Escape hatch (`--ids`)

`--ids 30289,32227,…` retires exactly those `beer_id`s. This covers parse-split
fossils (brewery=name, degree/ABV noise) that have **no** reusable predicate — the
`beers` row *is* the mis-parsed output, so there is nothing to re-derive; the
operator supplies the judgment (gathered from the triage issue / a query).

- Requires a mandatory `--reason "<text>"`, recorded in the note as
  `retired: <reason>`.
- Dry-run prints each row's `beer_id / brewery / name / review_class` for eyeball.
- Skips ids that don't exist in `enrich_failures`, are already matched, or are
  already retired (warns, does not touch).

Auto and `--ids` are **mutually exclusive** modes; `--reason` is rejected in auto
mode.

## Terminal state — `retired_at` column

Add `retired_at TEXT` (nullable ISO timestamp) to `enrich_failures` via a simple
`ALTER TABLE ... ADD COLUMN` (schema migration 18 — no table rebuild, no CHECK
change; contrast a new `review_class` enum value, which the migration-12 CHECK
constraint would force a full table rebuild for).

Retirement = set `retired_at = now` and append the reason to `review_note`. The
row **keeps its original `review_class`**, so the audit trail reads *"this was a
`parser_bug`, retired on DATE because X"* rather than overwriting history.

`retired_at` is sticky — not auto-cleared on re-fail. Because retired rows are
excluded from the enrich pool (below), `recordEnrichFailure` will not fire for
them anyway; a genuine later match still deletes the whole row via
`clearEnrichFailure`.

### Behavior across consumers

- **Untriaged triage** (`listUntriagedFailures`): already filters
  `review_class IS NULL`; retired rows keep a class → already excluded. No change.
- **Enrich re-attempts** (`listLookupCandidates`, `src/storage/beers.ts`): extend
  the existing `wontfix` exclusion so orphans with `retired_at IS NOT NULL` are
  also skipped — stop wasting Untappd calls on fossils, exactly like `wontfix`.
- **Daily stats** (`src/storage/stats.ts`, `orphansPending`): exclude beers whose
  failure is retired:
  `... AND NOT EXISTS (SELECT 1 FROM enrich_failures ef WHERE ef.beer_id = beers.id AND ef.retired_at IS NOT NULL)`,
  so the digest's "orphan'ів у черзі" number stops counting resolved fossils.
- **Ops/reporting views** of active clusters filter `retired_at IS NULL`.

## Tool UX

Script `scripts/retire-resolved-orphans.ts`, npm alias
`retire-resolved-orphans`, following the existing rearm-tool mold
(`loadOperatorEnv`, dry-run default, `--apply`, run as the bot user against the
prod `dist` build, sibling `.test.ts`).

```
npm run retire-resolved-orphans
    → auto path, dry-run: lists orphan rows the current isOntapNonBeerTap now
      rejects, each with tripping signal + beer_id / brewery / name / class.
      Footer: "N would be retired (dry-run; pass --apply)."

npm run retire-resolved-orphans -- --apply
    → writes retired_at=now, appends note, prints "Retired N orphan(s)."

npm run retire-resolved-orphans -- --ids 30289,32227 --reason "brewery=name, fixed by #238"
    → escape hatch, dry-run: prints those rows for eyeball.
      Add --apply to write.
```

Module exports (mirroring the rearm tools) for unit testing:
`selectAutoRetireTargets(db)`, `selectIdTargets(db, ids)`, `applyRetire(db, targets, note)`.

## Testing (Vitest)

- `selectAutoRetireTargets`: wine/`vino` row selected; normal IPA not selected;
  matched beer (`untappd_id` set) excluded; already-`retired_at` row excluded.
- `applyRetire`: sets `retired_at` + appends note; idempotent; only touches
  targets.
- `--ids` path (`selectIdTargets`): retires listed ids; skips unknown / matched /
  already-retired.
- `listLookupCandidates`: a retired orphan drops out of the candidate pool.
- `stats.orphansPending`: a retired orphan is not counted.
- Schema migration 18: `retired_at` column present, defaults NULL, existing rows
  unaffected.

## Docs / spec

- Update `spec.md` — the `enrich_failures` / orphan-triage section gains the
  `retired_at` terminal state and its pool/stats/view semantics, in the same PR.
- No `extension/**` change → no `docs/extension-install-uk.md` update needed.

## Rollout

Server-side only; ships via `deploy.sh` (migration 18 runs on startup). First real
use: after this deploys, run the auto path dry-run to see the wine/non-beer
cluster, then `--apply`; use `--ids` only for clusters whose parser fix has
already shipped (e.g. brewery=name #238) — not for still-live bugs like the
Konrad/Krakonoš trailing-°Plato cluster (#306).
