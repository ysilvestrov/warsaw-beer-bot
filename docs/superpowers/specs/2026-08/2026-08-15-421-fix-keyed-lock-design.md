# #421 — the retry schedule keyed to what actually changes the answer

Date: 2026-08-15
Status: agreed
Parent: `2026-08-14-triage-verdict-integrity-design.md` (decomposition of #377/#381/#408/#412)
Siblings: `2026-08-14-408-triage-verdict-guards-design.md` (part A, shipped `2170717`),
`2026-08-15-377-triage-vocabulary-design.md` (part B, shipped `00033ab`)

## The model

> The backoff schedule is a bet that **time** changes the answer.

`BACKOFF_HOURS = [0, 72, 168, 728]` (`src/domain/lookup-backoff.ts:5`) re-asks Untappd about an
orphan on a clock, then stops forever at `count >= 4`. That schedule is correct for exactly one
reason: the beer may not exist on Untappd *yet*, and waiting is what changes that. Its comment says
so — "a beer that fails 4 honest searches is treated as not findable".

Triage now tells us, per row, whether that bet is true. It is true for `not_on_untappd` and false for
every actionable class: while a matcher bug is unfixed, the answer tomorrow is the answer today, by
construction. Re-asking on a timer spends Untappd quota on a question whose answer cannot have moved,
and — worse — burns the row's four attempts *before* its fix ships, so the row is permanently dormant
by the time the fix that would rescue it lands.

So the schedule splits by what moves the answer:

| verdict | what changes the answer | mechanism |
|---|---|---|
| `not_on_untappd` | time (Untappd grows; probability decays but never reaches 0) | timer — with a **recurring** final step, not a terminal one |
| `matcher_bug` / `parser_bug`, `issue_number` → open issue | a shipped fix | **locked**: no lookups at all |
| `matcher_bug` / `parser_bug`, `issue_number` → issue no longer open | — | **unlock**: one free re-arm |
| `matcher_bug` / `parser_bug`, no `issue_number` (legacy, pre-v23) | unknown | timer, unchanged |
| `unidentifiable` | nothing we own (no fix owner by definition) | timer, unchanged |
| `not_a_beer` | nothing | excluded from both pools (#377) |
| no verdict yet | — | timer, unchanged |

This is the anchor #421's body declared missing. It looked for "older than the last matcher deploy" —
a global clock — and found no such marker in the system. The anchor is not global and not a clock: it
is **per row**, and it is the fix its own verdict already names.

## Why now — measured 2026-08-15 on prod

Part B removed the *class* lock (only `not_a_beer` excludes from a pool) and named the remaining one
in its Out of scope: "backoff exhaustion is a second, class-independent lock … it barely bites today
(10 dormant rows), but over time it will consume exactly what this design reopens."

Re-measured today, that framing is right but incomplete — the lock's real cost is not the rows it has
already killed, it is the retries it spends and the fixes it never tests.

**Dormancy today is small.** 10 orphans at `count >= 4`; **7 are `not_a_beer`** and sleep correctly.
Three real: 30215 (`parser_bug`), 30394 (`not_on_untappd`), 34221 (parked under #393). But 80 orphans
sit at `count = 3` — one failed lookup from permanent dormancy — and **24 of them are
`not_on_untappd`**, the one class whose reversibility part B justified with "Untappd grows". For
those 24, Untappd may grow all it likes; after the next miss nobody will ever ask again.

**The untested-fix population is large, and it is measurable today.** `issue_number` (v23) links 225
actionable orphan rows to a specific issue. Crossing those links with issue state and with
`beers.untappd_lookup_at`:

| | rows |
|---|---|
| verdict points at a **closed** issue | **157** |
| of those, **never re-queried since that issue closed** | **96** |
| re-queried after the fix and still orphan | 61 |

96 rows are fixes we wrote, merged and deployed, and then never re-ran against the very beers that
motivated them. The cleanest instance is #347: closed this morning, 16 rows, **16 of 16 never
retested**. The 61 that *were* retested and still fail are a different signal — there the verdict has
outlived its fix, and the row deserves re-triage, not just a retry. Both fall out of the same
mechanism below.

## Design

### 1. The unlock event is "the issue is no longer open"

GitHub cannot tell us "the fix shipped", and this was checked rather than assumed:
`closedByPullRequestsReferences` is empty on every referenced issue (PRs here do not write
`Closes #N`; merges are manual), and `stateReason` is noise — #319 is `NOT_PLANNED` although its fix
is shipped and deployed, #254 is `NOT_PLANNED` because it was decomposed, #255 is `COMPLETED` and was
*also* only decomposed. State reason records how the close button was clicked, not whether code
changed. Using it would repeat exactly the `wontfix`-means-two-things defect part B just removed.

So the trigger is the coarse fact — **the issue left the open set** — and the ambiguity is paid for
in quota rather than in cleverness. The worst case, a close that was really a decomposition, costs
**one** lookup per row. Today's behaviour costs up to four on a schedule that cannot succeed. The
coarse signal is strictly cheaper than what it replaces.

Two things make that cheapness real rather than assumed:

- **A project rule**, landed with this design in **both** `CLAUDE.md` and `AGENTS.md` — Codex fixes
  bugs here too, and a rule only one agent reads is a rule the other one breaks: *decomposing an
  `orphan-triage` issue obliges you to remap its rows onto the sub-issues*
  (`enrich_failures.issue_number`), per row and never as a blanket sweep. Then a parent's close means
  what the mechanism reads it to mean, and the wasted lookup happens only when a fix genuinely failed
  to cover the row.
- **Legacy stays out of the rule.** 114 of the 157 rows hang off #254/#255, both closed by
  decomposition before the rule existed. Remapping them now would be 114 per-row judgements with no
  per-row evidence — the exact ancestor defect of #377/#381. They take their one lookup instead: the
  lookup *is* the evidence, and it sorts them better than we would.

### 2. Two-beat unlock, driven by evidence

The unlock is a bet that the fix worked. The bet is settled by a lookup, and only the settlement
touches the verdict.

**Beat 1 — unlock.** The row is re-armed (`untappd_lookup_count = 0`, `untappd_lookup_at = NULL`, via
the existing `rearmLookup`, `src/storage/beers.ts:139`) and `unlocked_at` is stamped. The verdict is
**kept**: we still believe `matcher_bug → #347`; we are testing it.

**Beat 2 — settlement.** If the retry succeeds, `clearEnrichFailure` deletes the row and nothing else
is needed. If it fails, `recordEnrichFailure` fires with `unlocked_at` set — and *that* is the
evidence that the verdict outlived its fix. The class, note and `reviewed_at` are cleared, and the
row rejoins the untriaged pool with a fresh failure record to be triaged from.

This is why the triage queue does not take +96 at once. It takes only the rows a shipped fix demonstrably
failed to cover, each arriving with new evidence instead of a guess. The mechanism is also the one
already in `recordEnrichFailure` (`src/storage/enrich_failures.ts:37-45`), which clears a verdict when
`candidates_count` crosses the 0↔>0 boundary — one more `CASE` arm on the same upsert, not a new path.

`unlocked_at` carries exactly one meaning — *this row is spending its post-fix free retry* — and is
cleared at settlement. One meaning per token is the standing lesson from part B.

### 3. Where the lock is enforced — and where it deliberately is not

The lock is a pool-eligibility rule, so it lives beside the `not_a_beer` exclusion it parallels: the
`NOT EXISTS` clause in `listLookupCandidates` (`src/storage/beers.ts:268-274`) and the shared
`orphanWithoutMatchLinkPredicate` (`:314`) that the relay pool uses. A row is locked when it has an
actionable class, a non-null `issue_number`, and `unlocked_at IS NULL`.

Note the shape: the lock cannot be a `review_class` value and cannot be evaluated per row in
isolation — it depends on the *external* state of an issue. So the pool query cannot ask GitHub; the
job (§4) is what translates external state into a local fact. The pools only ever read local columns.

**It is not enforced on the extension path.** `/enrich/candidates`
(`src/api/routes/enrich.ts:172-174`) applies `isNotABeer` and `isEligible`, but that search runs in
the *user's* Untappd session (#89), not against our quota. The lock's entire justification is quota
we would otherwise waste; a free search costs nothing and may find a beer our matcher cannot. Locked
rows therefore stay eligible there. This asymmetry is deliberate and must be stated in the code, or
someone will "fix" it later for symmetry's sake.

### 4. The unlock job

New `src/jobs/unlock-fixed-orphans.ts`, daily, with a `job_state` idempotency key like every other
cron here (`src/index.ts`). It is a job and not a script because `scripts/*.ts` never reach production
— `tsc` emits `src/` only — a constraint #421's body already recorded.

1. Collect distinct `issue_number` over locked rows — on the first run 225 rows across 27 issues;
   from the second run on, the steady state is 68 rows across the 13 issues still open.
2. `listOpenIssues(TRIAGE_LABEL)` — the call `orphan-triage` already makes. All 27 referenced issues
   carry the `orphan-triage` label (checked, 27/27), so the open set is comparable against them.
3. **Pagination guard.** `listOpenIssues` fetches `per_page=100` with no pagination
   (`src/infra/github-issues.ts:47`). If it ever returns 100 items the open set may be truncated, and
   a truncated open set unlocks rows *falsely, in bulk*. If the returned length is ≥ 100 the job logs
   and does nothing this run. 15 open today; the guard exists because the failure is silent and
   corpus-wide.
4. Every referenced issue absent from the open set → beat 1 for each of its rows.
5. Report the count into the daily digest.

Separate from `orphan-triage` rather than folded into it, despite the shared GitHub call: triage's
failure path is the most intricate in the codebase (transient-retry, day-burning, #316), and a job
that writes to `beers` should not be able to take triage down or be taken down by it. One extra
GitHub request per day is not a cost worth coupling for.

### 5. `not_on_untappd`: a recurring tail instead of a terminal one

For this class alone, time is the mechanism, so exhausting the schedule contradicts the verdict's own
justification. `isEligible` gains a `recurring` flag: when set, `count >= BACKOFF_HOURS.length` reuses
the last delay (728h ≈ 30 days) instead of returning `false`. The caller sets it from the row's class.

Cost ceiling: 146 `not_on_untappd` rows asked at most monthly ≈ 5 lookups/month. The 24 rows at
`count = 3` are the immediate beneficiaries — under today's rules their next miss is their last.

The tail is *not* extended to `unidentifiable` or to legacy rows with no `issue_number`: neither has a
fix owner nor a growing external catalogue to wait for, so a recurring retry would be the very
timer-without-a-bet this design exists to remove. They keep today's terminal schedule. Recorded
explicitly so the asymmetry reads as a decision.

### 6. Audit signal

The part-B digest line (`src/jobs/daily-status.ts`) gains the lock's own counters, each falsifying a
premise of this design:

1. **Locked rows** — the quota the lock is saving. A number that only grows means fixes are not
   shipping, which is a backlog signal, not a mechanism failure.
2. **Unlocked in the last 7 days** — beat 1 firing. **Zero over a week in which issues closed means
   the mechanism is dead**, the same shape as part B's signal (2).
3. **Verdicts outlived by their fix** — beat 2 firing. Near-zero means our fixes cover the rows that
   motivated them; near-100% means they never do, and the lock is buying reversibility that has no
   value.

## Migration v25

One column: `ALTER TABLE enrich_failures ADD COLUMN unlocked_at TEXT`. No table rebuild — v24 rebuilt
the table for its `CHECK` changes, and this adds no constraint. Backfilled `NULL`, which is the
correct initial state for every row: nothing has spent a free retry yet.

The first run then unlocks the 157 rows on closed issues, of which 96 have never been retested.

## Testing

Falsifiability rule (superpowers 6.3.0): every test names the production change that turns it red.

- **Lock excludes, unlock restores** — a locked row is absent from both pools; the same row with
  `unlocked_at` set is present. Red if the pool clause is reverted.
- **Mutation test on the lock clause** — delete it from `orphanWithoutMatchLinkPredicate` and assert
  the relay-pool test goes red. Both pools share the predicate; only one of them proves it.
- **Two beats, separately** — beat 1 keeps `review_class`; beat 2 (a `recordEnrichFailure` on a row
  with `unlocked_at` set) clears class, note, `reviewed_at` and `unlocked_at`. Red if either arm of
  the `CASE` is dropped.
- **Beat 2 does not fire on a locked-but-not-unlocked row**, so an ordinary failure never wipes a
  verdict. This is the regression that would silently empty triage.
- **Pagination guard** — a stub returning 100 open issues unlocks nothing.
- **Job idempotency** — two runs in one day unlock once (`job_state`).
- **Recurring tail** — a `not_on_untappd` row at `count = 6` is eligible 728h after its last lookup;
  an `unidentifiable` row at `count = 6` is not. Red if `recurring` is passed unconditionally.
- **Extension path ignores the lock** — `/enrich/candidates` reports `eligible: true` for a locked
  row. Red if the lock is added there for symmetry.

## Validation before merge

Project policy (replay before implementing): a seeded random sample of the 96 never-retested rows run
live through `lookupBeer`, measuring the hit rate the first unlock will actually buy. The prior is
**27%** from the 157-row replay of 2026-08-14. This number is also the honest baseline for audit
signal (3): the complement is what beat 2 will hand to triage.

## Out of scope

- **Remapping the 114 legacy rows on #254/#255** onto sub-issues — §1; they take the one lookup.
- **Recurring tail for `unidentifiable` and no-issue legacy rows** — §5.
- **Backfilling `issue_number` from the `→ #NNN` suffix in `review_note`** (55 rows). The suffix was
  advisory before v23 made the column authoritative; promoting a note to a link is guessing, and a
  wrong link would unlock rows against an unrelated issue's close.
- **`retired_at` semantics** — counted by part B's signal (4), unchanged here.
- **#381 `fix_site`** — which codebase owns a fix is a different axis from whether the fix landed.
