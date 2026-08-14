# #408 (part A) — deterministic verdict guards

Date: 2026-08-14
Status: agreed
Parent: `2026-08-14-triage-verdict-integrity-design.md` (decomposition of #377/#381/#408/#412)

## Goal

Stop the triage agent from applying a consequence the row's own evidence contradicts. Everything
here is a pure function over the model's proposal plus already-loaded data — no network, no model
call, every guard unit-testable.

Enforces one half of the parent invariant:

> No consequence may be applied without evidence from the row itself.

## Why now

The defect is live, not historical. Of the open `orphan-triage` issues sampled on 2026-08-14,
**four** (#404, #401, #388, #370) carry verbatim:

```
Scope: all orphans in this class — enrich_failures WHERE review_class='matcher_bug'.
```

Every future `matcher_bug` row is trivially "already covered" by each of them. #347 reached 36 rows
across 18 comment batches and shipped nothing in 19 days under exactly this shape. Meanwhile
#405/#406/#407 already demonstrate the narrow form (an enumerated `beer_ids` cohort), so the target
shape exists in the wild.

## Design

### 1. Scope is a necessary condition, not a definition

Most real mechanisms cannot be expressed as a column predicate — "the shop's own typos" (#407),
"packaging tokens over-constrain the query" (#388), "the brewery field is not a brewery" (#405) are
hypotheses, not filters. Pretending otherwise would produce scopes that are either useless or lies.

So the scope only ever answers: **does this row provably contradict the issue?** It rejects
attachment; it never asserts belonging. That is enough to kill the misroute #408 measured — six rows
with `candidates_count = 0` attached to a brewery-**gate** issue, where the gate cannot run.

Two forms, both structured:

- `beer_ids: number[]` — the evidence cohort the issue was born with.
- `where` — terms over allowlisted columns, joined by `AND`.

A row satisfies the scope if it is in `beer_ids` **or** satisfies `where`. An issue may carry both.

**Legality**: `where` must contain at least one term over a column other than `review_class`. That
is the operational meaning of "narrower than the class". An issue carrying neither form is
*unscoped* and cannot receive new attachments.

**Column allowlist** — the fields actually present on `UntriagedFailure`
(`src/storage/enrich_failures.ts:139`), so the guard needs no extra query:

| column | operators |
|---|---|
| `candidates_count`, `fail_count` | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| `source_url`, `brewery`, `name` | `empty`, `non_empty`, `contains` |
| `abv`, `style` | `is_null`, `is_not_null` |
| `review_class` | `=` (never the only term) |

### 2. The model authors structure; we render and parse our own output

The scope arrives as a **structured field on each `new_issues` entry in the tool schema**, validated
by the existing zod/JSON-schema pair. There is no grammar for the model to get wrong and no
model-authored text on any evaluation path.

The issue body then carries a fenced block we render ourselves:

````
```triage-scope
{"beer_ids":[34005,11952],"where":[{"col":"candidates_count","op":"=","value":0}]}
```
````

with the human-readable `Scope:` line rendered next to it. On the following run `listOpenIssues`
returns the body and we parse **our own rendered JSON** back. Parsing exists, but its input is
produced by us, never by the model.

A body with no `triage-scope` block parses to *unscoped*. This is what makes the manual backfill
(section 5) load-bearing rather than cosmetic.

### 3. The four guards

| # | guard | on violation |
|---|---|---|
| 1 | proposed new issue has an illegal or missing scope | issue dropped; its verdicts → `skipped` |
| 2 | attachment to an open issue whose scope the row violates | verdict → `skipped`; **never re-routed** |
| 3 | `not_on_untappd` without a probe that ran and returned empty | degrade to `matcher_bug`, `issue_number: null` (see note below) |
| 4 | issue is saturated (see section 4) | comments refused; verdict → `skipped` |

Guard 2 deliberately does not guess a better destination. Choosing a different issue is exactly the
title-similarity judgement that produced the pile.

**What guard 3's degrade actually does.** A `matcher_bug` verdict with neither an issue nor a key
falls into the existing `quiet` branch (`triage-plan.ts:89`), so `review_class='matcher_bug'` is
written and the row leaves the *untriaged* pool instead of regenerating the same hypothesis daily.
It stays in the *enrichment candidate* pool, because `orphanWithoutMatchLinkPredicate` excludes only
`wontfix` and `retired_at` — so the cron keeps retrying it under `BACKOFF_HOURS` until the schedule
is exhausted. That is the whole point: the wrong-but-recoverable class replaces the
wrong-and-terminal one.

**Probe semantics for guard 3** (`triage-probes.ts`, `renderProbe`): `probe.name === ''` means the
probe ran and found nothing — strong absence evidence. `undefined` means it never ran — no evidence.
The two must stay distinct; collapsing them re-opens the guessing this guard exists to stop.

**Known consequence, accepted.** `collectTriageProbes` skips rows with `candidates_count > 0`
outright (`triage-probes.ts:47`), so guard 3 will degrade *every* candidate-bearing
`not_on_untappd` to `matcher_bug`. That is the intended direction — #377 measured the "no probe ran"
cohort as wrong 3 of 3 — but it has a cost: a beer that genuinely is absent *and* has unrelated
candidates can no longer be classified correctly and will be retried indefinitely. Relief is #377's
original proposal 2 (probe candidate-bearing rows too), which was dropped when #377 was rewritten
into part B; it belongs with the payload/evidence work in #357 and is a **follow-up, not a blocker**
— the pool retry is wasteful, whereas a wrong terminal verdict is unrecoverable.

**Loop risk, stated because three guards end in the same place.** `skipped` means the row keeps
`review_class = NULL` and returns in tomorrow's batch. A model that keeps proposing the same illegal
scope produces a row that recirculates forever while the daily batch silently fills with repeat
offenders. Mitigation: the existing `verdict shortfall` log (`orphan-triage.ts:279`) must carry a
per-guard reason count, so a loop is visible in one journal line rather than inferred from a
stalled backlog.

### 4. Saturation counts post-creation rows only

#405 was born with **15 enumerated rows** — precisely the N proposed in #408. A correctly split
issue starts life at the threshold, so counting lifetime rows would reject the very shape we want.
The guard therefore counts rows attached **after** the issue was created.

That count needs a per-issue link, which does not exist today: the only record is a free-text
suffix appended by `orphan-triage.ts:285` (`… → #123`) on 198 rows, and the convention is already
broken by re-routing notes written on 2026-08-14 (`→ #405 (re-routed 2026-08-14 from #347)`).

**Migration v23: `enrich_failures.issue_number INTEGER NULL`**, written where the suffix is written
today, backfilled for the 198 existing rows by regex over `review_note`. Beyond saturation this
makes "which rows went to this issue" queryable for the first time — without it neither #408 nor
#381 can be audited after the fact.

N itself is left to the implementation plan and must come from the observed post-creation
row-per-issue distribution, not from the #347 anecdote.

### 5. One-time backfill of open issues

15 open `orphan-triage` issues. Four (#404, #401, #388, #370) get a `where` scope; the rest get
`beer_ids`; #405/#406/#407 already enumerate their cohort in prose and only need it moved into the
block. Until an issue has a block it is unscoped and accepts no new rows — which is the correct
default, but it means the backfill ships **with** the guard, not after it.

## Interface changes

`planTriageActions(analysis, openIssueNumbers, batchBeerIds)` cannot express any of this: it sees
neither the issues' scopes, nor the rows, nor the probes. New shape:

```ts
planTriageActions(analysis, openIssues: ScopedIssue[], batch: UntriagedFailure[], probes: Map<number, TriageProbe>)
```

`ScopedIssue` = `{ number, scope: Scope | null, postCreationRows: number }`. Parsing the block and
counting rows happen at the call site in `src/jobs/orphan-triage.ts`; the guard stays pure.

Deriving the batch id set from `batch` rather than receiving it separately removes the chance of the
two disagreeing.

## Testing

Each guard must be demonstrated by deleting it and showing a red test — project policy after the
#384 review, where two-stage review plus mutation testing found five plan-level defects.

Specific cases that must exist, drawn from measured misroutes rather than invented:

- a `candidates_count = 0` row rejected from an issue scoped `candidates_count > 0` (the six-row
  misroute)
- a proposed issue scoped only `review_class='matcher_bug'` rejected (the four live issues)
- a proposed issue scoped `review_class='matcher_bug' AND candidates_count = 0` accepted
- `not_on_untappd` with `probe.name === ''` accepted; with `undefined` degraded (the 3-of-3 cohort)
- an issue at N post-creation rows refusing the next, while an issue born with N enumerated
  `beer_ids` still accepts its first (the #405 case)
- an unscoped issue accepting nothing while its existing rows are untouched

## Out of scope

- Re-routing a rejected verdict to a better issue.
- Extending probes to candidate-bearing rows (#357 follow-up, see guard 3).
- Anything in part B (#377): vocabulary of terminal classes, re-arm sweep.
- The `fix_site` routing field (part C, #381 → #357).
