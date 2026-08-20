# #431 — saturation is a state of an issue, so it may report but must not refuse

Date: 2026-08-19
Status: agreed
Related: `2026-08-14-408-triage-verdict-guards-design.md` (the guard being removed),
`2026-08-16-432-triage-run-report-design.md` (which named this defect and deferred it),
`2026-08-15-421-fix-keyed-lock-design.md` (what closing an issue does to its rows)
Answers: #419 (the 2026-08-22 checkpoint — did the #408 guards deadlock triage?)
Closes: #431

## The model

> A guard may refuse a row only for a fact about **that row**. Saturation is a fact about the
> issue, so it may report, and it may alert, but it must not refuse.

Guards 1, 2 and 3 all satisfy this. Guard 1 judges a proposed scope, guard 2 judges whether this
row contradicts the issue it was routed to, guard 3 judges whether this row's absence was actually
probed. Each refusal is a statement about the thing refused, and each is therefore worth retrying
tomorrow: a different model call may produce a different, better answer.

Guard 4 is not like them. It refuses a row for the size of a pile the row had no part in. The
verdict was correct — right class, right issue, in scope — and it is thrown away for a reason that
will still be true tomorrow, and the day after, until a human ships a fix. Retrying it is
guaranteed waste, and the retry is not free: every recirculated row costs a probe and a share of
an LLM call.

## Measured 2026-08-19 — four consecutive runs

| date | total | saturated | scope_viol | skipped | rows published to GitHub |
|---|---|---|---|---|---|
| 08-16 | 50 | 0 | 0 | 2 | 8 (5 commented, 3 in one new issue) |
| 08-17 | 50 | 0 | 5 | 5 | 16 (commented across 5 issues) |
| 08-18 | 50 | 20 | 9 | **29** | 8 (6 commented, 2 in one new issue) |
| 08-19 | 50 | 23 | 8 | **31** | **2** (1 commented, 1 in one new issue) |

On 2026-08-19 the job spent a full batch of 50 rows, its probe budget and two LLM calls to publish
**two rows** — against sixteen two days earlier, on the same batch size. Thirty-one rows were
discarded, twenty-three of them by guard 4 alone.

The recirculation is structural, not a bad day:

- `listUntriagedFailures` selects `WHERE review_class IS NULL` with `LIMIT 50`.
- The untriaged pool on 2026-08-19 is **52 rows**. The pool *is* the batch.
- A guard-4 refusal takes the `continue` at `triage-plan.ts:215-218` without calling `review()`, so
  `review_class` stays `NULL` and the row is selected again tomorrow — with the same evidence, and
  therefore the same verdict, and therefore the same refusal.
- Rows whose `last_at` is 2026-06-14 are still untriaged, two months on.

`skipped` rising 2 → 5 → 29 → 31 while `saturated` rose 0 → 0 → 20 → 23 is the treadmill starting.
The #408 design predicted exactly this in the `GuardReason` comment — "would recirculate the same
rows forever" — and chose a visible counter as the mitigation. The counter worked. It is the reason
this document exists. Acting on it is the part that was left undone.

### This is the #419 answer, taken early

#419 asks whether the #408 verdict guards deadlocked triage. They did, but not by the predicted
mechanism. There is no deadlock in the sense of a stalled queue: rows flow, classes get written,
the backlog moves. What happened is a **beat-frequency stall** — the batch limit (50) and the
untriaged pool (52) are the same size, so the fraction of the batch that guard 4 refuses is the
fraction of the day's entire capacity that produces nothing. The checkpoint can be closed with
these four runs; no separate measurement is needed.

## Why the cap can go, rather than be replaced

The cap was a **second** defence against the failure it was named for. #347 took 36 rows in 19 days
and shipped nothing — but its defect was not volume. It was **seven distinct mechanisms in one
issue**, which is what made every row look already-covered and no row look actionable. Guards 1 and
2 kill the seven-mechanisms failure directly: an issue whose `where` is a bare `review_class` is
refused at birth, and a row that contradicts an issue's scope is never attached to it.

Once guard 2 has run, a row that reaches guard 4 has *already proven it belongs*. Thirty-six rows
of one mechanism is not a magnet; it is a well-evidenced bug. Refusing them discards true evidence
for a reason external to the evidence.

Ordering matters here and is currently wrong: guard 4 is checked **before** guard 2
(`triage-plan.ts:208` and `:225`). Any design that keeps saturation as a gate — including the
silent-attachment variant considered and rejected below — must first flip that order, or it starts
attaching rows that were never scope-checked and recreates the magnet quietly. **Deleting guard 4
performs the flip for free**: scope becomes the only check on the `hasIssue` path.

### Rejected: attach the row silently, skip only the comment

Considered first and dropped. It stops the treadmill but pays for it by deleting the audit trail —
the row's evidence would never appear anywhere a human reads. It is worst for `not_a_beer`, the one
irreversible class, whose whole reason for being actionable (#377 part B) is that *an irreversible
verdict that leaves a scoped issue trail is safer than one written silently into a column*. It also
keeps all the machinery of a gate while delivering none of a gate's benefit. Removing the gate is
strictly simpler and dissolves the `not_a_beer` exception rather than carving it out.

## What changes

### 1. The gate becomes a threshold

`planTriageActions` loses guard 4 entirely. `GuardReason` becomes
`'illegal_scope' | 'scope_violation' | 'unprobed_absence'`. `MAX_ROWS_PER_ISSUE` is renamed
`SATURATION_ALERT_ROWS`, value unchanged at 12 — but it now blocks nothing, which makes it a cheap
knob: being wrong about it costs a mislabelled issue, not a discarded row. The measured basis for
12 stands (healthy issues sit at ≤ 7, magnets ran to 36 and 90).

### 2. Saturation becomes a computed state

`TriagePlan` gains:

```ts
saturated: { issueNumber: number; rows: number }[]
```

Computed over **every** open triage issue, not only those touched by this run — that is precisely
what makes it a state rather than an event, which is the sentence #431 was filed with. `rows` is
`postCreationRows` plus rows accepted for that issue in this run. Sorted by `rows` descending, ties
broken by issue number ascending so the output is deterministic.

`planTriageActions` stays pure: `ScopedIssue[]` already carries `postCreationRows`.

An issue created by this same run never appears in the list: `postCreationRows` counts rows
attached *after* creation, and a new issue's founding rows are attached at creation. This falls out
of the existing definition rather than needing a special case, and it is the wanted behaviour — an
issue split out of a magnet legitimately starts life carrying a large enumerated cohort.

### 3. The label

`GithubIssuesClient` gains `addLabel(n, label)` and `removeLabel(n, label)`.

Deliberately **not** a `PUT`-style `setLabels`: that replaces the whole set and would erase labels a
human applied (`priority/tier-2`, `extension-bug`). Add and remove are
`POST /issues/N/labels` and `DELETE /issues/N/labels/{name}`, one request each, issued only when
the desired state differs from the actual one. No extra read is needed — `listOpenIssues` already
returns `labels`.

Reconciled every run:

| condition | action |
|---|---|
| `rows >= SATURATION_ALERT_ROWS` and label absent | add `saturated` |
| `rows < SATURATION_ALERT_ROWS` and label present | remove `saturated` |
| otherwise | no request |

Removal is not hypothetical: CLAUDE.md requires rows to be remapped when an `orphan-triage` issue
is decomposed, which can drop a count back under the threshold.

Labelling runs **after** every comment and every DB write, each issue in its own `try`. A GitHub
failure here logs and continues; it must never cost a verdict that was already earned.

### 4. The report line

New `buildSaturatedLine(o): string | null` — `null` when nothing is saturated, so the digest gains
no empty line. The `job_state` payload gains a second field `saturated`; a payload written before
this change reads as `null`.

```
Насичені: #405 (21), #427 (15), #334 (12), #376 (11), #401 (8) — усього 7
```

Top five by row count, then the total. Ordered descending, so the first entry is the answer to
"what do I fix next" — the line is a report and a work queue at once.

### 5. The runbook

New `docs/orphan-triage-issues-runbook.md`. Deliberately separate from
`docs/debug-orphan-matching.md`: that one runs from one beer's symptom to its root cause, this one
is about operating the **queue of issues**. Each links to the other.

Sections:

- **Finding the work.** Three entry points, cheapest first: the `Насичені:` digest line;
  `is:open label:orphan-triage label:saturated`; SQL over `enrich_failures.issue_number`. The SQL
  section must state that `COUNT(*)` is a lifetime count while the label reflects
  `postCreationRows`, so the two legitimately disagree for issues born carrying an enumerated
  cohort (#405 was). Plus the inverse query — issues with **no** rows left — because per
  `feedback_orphan_rows_overstate_work` the table advertises work that shipped fixes already
  killed.
- **Before fixing.** The replay policy: reproduce the issue's own examples live before writing
  code. #340, #303 and #350 were all refuted this way and one would have made matching worse.
- **Decomposition — remap the rows in the same step.** The CLAUDE.md rule, expanded: the exact SQL
  under the bot user, only rows you can name, never a bulk `WHERE issue_number = <parent>`, and
  `review_class` left untouched (the class says what kind of defect it is; the issue number says
  who fixes it — changing both at once destroys the evidence for the verdict). Read back through
  `?mode=ro`, never `immutable=1`, which cannot see the WAL.
- **Closing an issue.** What fires by itself and what to verify by hand. Beat 1:
  `unlock-fixed-orphans` sees the issue leave the open set, stamps `unlocked_at` and resets the
  backoff. Beat 2: the next failed retry clears `review_class` and returns the row to the triage
  queue, keeping `issue_number` as the record that this fix was tried and did not cover it.
  Verification: rows unlocked same-day, rows matched within a week. The runbook must state plainly
  that "unlocked" alone proves nothing — the first such run unlocked 152 rows of which 91 were in
  no reachable pool at all (`project_421_checkpoint`).
- **The label.** Machine-managed; setting it by hand is pointless because the next run reconciles
  it.

## Testing

Every test below is mutation-proven — delete the implementing line, watch it go red — per
`feedback_vacuous_test_seeds`, which recorded four empty-but-green tests in a single session.

Pure (`triage-plan.test.ts`):

1. An in-scope row routed to an issue at or over the threshold lands in `comments`, not `skipped`.
2. A scope violation still refuses the row even when the issue is far under the threshold. *This is
   the regression test for the deletion: it proves removing guard 4 did not weaken guard 2.*
3. A `not_a_beer` row, in scope, on an issue over the threshold, gets its comment. *The dissolved
   exception, pinned as behaviour.*
4. `saturated` includes an open issue that this run did not touch at all. *State, not event.*
5. An issue at 11 that accepts 3 rows this run reports `rows: 14`.
6. Ordering is deterministic under a row-count tie.

Job (`orphan-triage.test.ts`):

7. Label added when an issue crosses the threshold; removed when it drops below; **no request at
   all** when the desired state already matches.
8. A GitHub failure on labelling neither aborts the run nor loses the DB writes made before it.

Report:

9. Zero saturated issues → `buildSaturatedLine` returns `null` and the digest grows no line.
10. Three saturated issues → all three listed.
11. Seven saturated issues → five listed plus `усього 7`.

## Not in scope

- No schema migration. `postCreationRows` is already computed by `countRowsForIssue`; the
  `enrich_failures` shape is unchanged and the migration table in `spec.md` gains no row.
- No replacement ceiling at a higher number. The magnet failure is handled by guards 1 and 2.
- No `not_a_beer` exception — with no gate there is nothing to except it from.
- No re-routing of a refused row to a different issue. Choosing an issue by title similarity is the
  judgement that produced #347, and #408 rejected it for that reason; nothing here revisits it.
- **A closed issue keeps its `saturated` label.** The job lists open issues only, so it never sees
  the close. This is cosmetic residue, filtered out by `is:open` in every query the runbook gives,
  and not worth a mechanism.

## spec.md

Updated in the same PR:

- §5.11 — "Чотири детерміновані гейти" becomes three; item 4 is rewritten from a gate that refuses
  comments into a state that labels and reports. The sentence excluding `saturated` from the
  `guard anomaly` warn goes with it, since the counter no longer exists.
- Line 391 — `issue_number`'s description says it is read by the saturation *gate*; it is now read
  by the saturation *report*.
- §1276 (the `dailyStatus` digest inventory) — add the `Насичені:` line.

## Prediction, recorded so it can be checked

The first run after deploy drains the accumulated backlog: roughly 23 rows that were refused on
2026-08-19 will post as comments, and #405 should receive 10–15 rows in one batch. That is the
drain, not a fault. By the second day `skipped` should fall to single digits, and the residue
should be `scope_violation` — a genuine model error — rather than `saturated`.

If `skipped` stays high after two days, the cause is guard 2, not guard 4, and that is a different
investigation (#381 territory: the model routing rows to issues whose scope they contradict).
