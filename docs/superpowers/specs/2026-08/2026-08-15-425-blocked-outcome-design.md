# #425 — a blocked lookup must not overwrite what we already learned

Date: 2026-08-15
Status: agreed
Issue: #425
Context: found during the #421 pre-flight scan; the defect was shipped by #377 (v24) the same day.

## The model

> `enrich_failures.outcome` records how the last attempt **that learned something** ended.

`blocked` is not a fact about the beer. It is a fact about us — our IP is throttled, the circuit is
open, Untappd would not answer. Writing it over a row that already carries a real `not_found`
observation replaces evidence with the absence of evidence, and #377's `CHECK` then correctly refuses
the result. The `CHECK` is not the bug; it is the alarm that revealed one.

## The defect

Three correct things compose into a crash:

1. `applyLookupOutcome` records a failure row for `outcome: 'blocked'`
   (`src/domain/lookup-outcome.ts:68-80`).
2. Migration 24 (#377) added `CHECK (review_class IS NULL OR outcome = 'not_found')` — no verdict may
   sit on a row we could not ask about.
3. `recordEnrichFailure` clears `review_class` only when `candidates_count` crosses the 0↔>0 boundary
   (`src/storage/enrich_failures.ts:37-45`).

A `blocked` upsert writes `candidates_count = 0`. When the existing row is already at 0, the boundary
is not crossed, the verdict survives the `ON CONFLICT`, `outcome` flips to `'blocked'`, and the row
violates the `CHECK`:

```
SqliteError: CHECK constraint failed: review_class IS NULL OR outcome = 'not_found'
```

Reproduced against a migrated in-memory DB, with a negative control: the same sequence with
`candidates_count = 3` on the existing row **succeeds**, because the 0↔>0 clause nulls the class
first. That is exactly why #377's suite missed it — every blocked-path test it wrote happens to cross
the boundary.

`enrichOrphans` calls `enrichOneOrphan` in a bare loop with no `try`/`catch`
(`src/jobs/enrich-orphans.ts:102-123`), so the throw leaves the job entirely and the cron's `.catch()`
logs it. **One row ends the whole run.** The trigger is an Untappd block window — the exact condition
the rotation-aware breaker exists to degrade through gracefully.

**Prod exposure, 2026-08-15:** 306 reachable orphans carry a verdict with `candidates_count = 0` —
`not_on_untappd` 136, `matcher_bug` 97, `parser_bug` 73. `not_on_untappd` dominates by construction: a
probe that returned nothing is what earns the class.

No data cleanup is needed. The exception fires on write, so no row was ever persisted in the illegal
state — the `CHECK` did its job.

## Design

### 1. `blocked` creates rows; it never downgrades one

`recordEnrichFailure` branches once, before the upsert: if the incoming outcome is `blocked` **and** a
row already exists with `outcome = 'not_found'`, the only fields written are `fail_count` and
`last_at`. Diagnostics (`candidates_count`, `candidates_summary`, `search_url`), `outcome`, and the
whole triage block (`review_class`, `review_note`, `reviewed_at`, `issue_number`) are left exactly as
they were.

A beer with no row yet still gets one, `outcome = 'blocked'`, no class — unchanged, and still visible
to #377's rule that such a row takes no verdict. A row already at `outcome = 'blocked'` that is
blocked again is the same counter bump.

Why this rather than "clear the verdict when the outcome becomes unaskable" (the alternative that also
satisfies the `CHECK`): that would erase real triage work — up to 306 rows in a single block window —
and re-flood a queue that drains 50/day against a backlog of 106. It is also the very failure #377
complained about, where six rows were sealed on the strength of a transient outage. A blocked attempt
must cost nothing, in either direction.

**Second defect closed by the same rule.** Today a block window flips an *untriaged* `not_found` row
to `blocked`, and `listUntriagedFailures` excludes `blocked` (`src/storage/enrich_failures.ts:199`) —
so the row silently leaves the triage queue because of an outage that has nothing to do with it. One
rule, both cases.

Implementation shape: a `SELECT` plus a narrow `UPDATE` in the function body, not eight `CASE`
expressions bolted onto the existing `ON CONFLICT`. The upsert already carries two conditional arms;
a third concern expressed the same way would make the statement unreadable. better-sqlite3 is
synchronous and the bot is a single process, so the read-then-write pair needs no transaction for
correctness — but it gets one anyway, because "needs no transaction *today*" is a property of the
process model, not of the code.

### 2. One beer may not end a run

`enrichOrphans` wraps the `enrichOneOrphan` call in `try`/`catch`: log the error with the beer id,
count it, continue to the next candidate.

The caught error must **not** reach the circuit breaker. `breaker.onResult(true, …)` means "Untappd
blocked us", and a storage exception is not evidence about Untappd — feeding it in would let a DB bug
open the circuit and stop all enrichment for the backoff window. The row is skipped, the loop
proceeds, the breaker's view of Untappd is untouched.

This is containment, not a fix: on its own it converts a crash into a silent skip. It ships with §1
and never instead of it. It is included because the same shape of accident will happen again with a
different cause, and a bare loop over 20 network-and-DB operations should never have been able to end
on the first surprise.

`EnrichOrphansResult` gains `errors: number`. The result is only ever logged
(`log.info(result, 'enrich-orphans done')`) — no digest line, no metric plumbing.

## Testing

Falsifiability rule (superpowers 6.3.0): every test names the production change that turns it red.

- **The reported crash, exactly**: existing `not_found` row with `candidates_count = 0` and a verdict,
  then a `blocked` record. Asserts no throw, `outcome` still `'not_found'`, `review_class` still
  `'matcher_bug'`, `fail_count` incremented. Red if the guard in §1 is removed.
- **The negative control stays green**: the same sequence with `candidates_count = 3` on the existing
  row also preserves the verdict now. This one is the regression that would otherwise hide the bug —
  before the fix it passes for the wrong reason (the 0↔>0 clause), after it passes for the right one.
- **Diagnostics are preserved**: `candidates_summary` and `search_url` unchanged by a blocked record.
  Red if the narrow `UPDATE` widens.
- **A new beer still gets its blocked row**: no prior row, blocked outcome, row created with
  `outcome = 'blocked'` and `review_class` null. Red if the guard swallows creates as well as updates.
- **Untriaged rows stay in the triage queue across a block window**: an untriaged `not_found` row hit
  by a blocked record is still returned by `listUntriagedFailures`. Red if `outcome` is allowed to
  move.
- **A throwing beer does not end the run**: stub `enrichOneOrphan`'s dependencies so beer #2 of three
  throws; assert beers #1 and #3 are both processed and `errors === 1`. Red if the `try`/`catch` is
  removed.
- **A thrown error does not touch the breaker**: same setup with a recording breaker stub; assert
  `onResult` was never called with `true` for the throwing beer. Red if the `catch` feeds the breaker.

## Out of scope

- **The `CHECK` itself** — it is correct and it is what surfaced this. It stays.
- **`retired_at`, the 0↔>0 auto-unseal, and every other arm of the upsert** — untouched.
- **#421's fix-keyed lock** — a separate branch, resumed after this ships. Its recurring
  `not_on_untappd` tail keeps 136 of the 306 exposed rows in the pool longer, so this fix lands first.
- **Surfacing `errors` in the daily digest** — the enrich result has never been in the digest, and one
  more counter is not the reason to start.
