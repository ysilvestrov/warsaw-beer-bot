# #432 — a triage run must be able to explain its own outcome

Date: 2026-08-16
Status: agreed
Related: `2026-08-14-408-triage-verdict-guards-design.md` (the guards being reported on),
`2026-08-15-377-triage-vocabulary-design.md` (the classes being counted)
Spawned issues: #431 (saturation as state), #430 (`not_a_beer` files nothing), #357 (probe design)

## The model

> Every number a run reports must name **one** mechanism, and routine work and anomalous work must
> not travel the same path — in either direction.

A triage run refuses work in four different ways and downgrades it in two more. Today it reports
those six dispositions as three overlapping numbers, one of which is printed only under a condition
unrelated to whether it happened. The consequence is not cosmetic: the #419 checkpoint asks "which
guards actually fire", and the answer had to be reconstructed with SQL over `review_note` prefixes
because the instrument built to answer it does not print.

Two rules follow, and they are the whole design:

1. **Attribution.** A disposition is counted where it is decided, once. No aggregate is published
   alongside its own parts.
2. **Path separation.** Routine refusals go to the run's log payload and never to the human report.
   Anomalous refusals raise a warning and appear in the human report — and do so on their own
   trigger, not as a passenger on some other condition.

The second rule is bidirectional by intent. The current code violates it both ways at once: routine
guard activity is (nominally) on the warning path, and anomalous guard activity reaches nobody.

## Measured 2026-08-16 — the run that exposed it

Batch of 50, from the first week of the #408 guards.

```
{"total":50,"commented":[{"issueNumber":401,"count":1},{"issueNumber":376,"count":4}],
 "created":[{"issueNumber":427,"count":3}],"notOnUntappd":10,"unidentifiable":3,
 "notABeer":12,"recordedNoIssue":15,"skipped":2,"unverified":5,"msg":"orphan-triage finished"}
```

- **Guard 3 fired 9 times. Nothing was logged.** `covered` was 50 of 50, so the `verdict shortfall`
  warn — the only line carrying `guardHits` — did not print.
- **`skipped: 2` is unattributable.** Eight call sites increment it across seven distinct reasons —
  foreign row, duplicate beer id, contradictory routing, unknown target issue, an unknown or
  over-cap `new_issue_key`, guard 4, and guard 2 (which increments from two sites, one for an
  existing issue and one for a proposed one) — and the run does not say which.
- **`recordedNoIssue: 15` overlaps `unverified: 5`.** Reconstructed from note prefixes, the true
  split is 9 guard-3 downgrades + 5 #358 strips + 1 genuine model declination. The digest line
  `15 без issue, 5 неперевірених` reads as 20 rows and is 15.

Nothing in this run was anomalous — `illegal_scope`, `scope_violation` and `saturated` were 0, and
the guard that did fire is routine by construction (#357). A correct report would have raised **no
warning at all** and still been able to answer every question above.

## Where each disposition is decided

This table is the design; the code changes fall out of it.

| disposition | decided in | today | after |
|---|---|---|---|
| guard 1 `illegal_scope` | `planTriageActions` | `guardHits` (rarely printed) | outcome + **warn** + digest |
| guard 2 `scope_violation` | `planTriageActions` | `guardHits` + `skipped` | outcome + **warn** + digest |
| guard 4 `saturated` | `planTriageActions` | `guardHits` + `skipped` | outcome only (state → #431) |
| guard 3 `unprobed_absence` | `planTriageActions` | `guardHits` + `recordedNoIssue` | outcome only |
| #358 cause strip | `orphanTriage` (before planning) | `unverified` + `recordedNoIssue` | outcome, once |
| model named no target | `planTriageActions` | `recordedNoIssue` | outcome, own counter |

Three of the six are already counted exactly today, in the right place. The defect is that their sum
is published as a fourth number and that the first two are gated behind a broken condition.

## Design

### 1. `guardHits` moves into `TriageOutcome`

`guardHits` becomes a field of `TriageOutcome` and is logged by the existing `finish(outcome)` call
in `orphan-triage finished` — the line that prints on **every** run and the line the #419 checklist
greps. The `if (covered < orphans.length)` gate is removed from its path entirely.

`GuardReason` already enumerates the four guards and `planTriageActions` already returns the tally,
so this is a plumbing change, not new accounting.

### 2. The `verdict shortfall` warn keeps its meaning, loses its passenger

`covered < orphans.length` remains a warning on its own merit: the model failed to return a verdict
for a row, so that row recirculates tomorrow with no reason recorded. That is genuinely anomalous.
It simply stops carrying `guardHits`, which was never related to it.

### 3. A new, narrow warn

Trigger: `illegal_scope > 0 || scope_violation > 0`. Independent of any shortfall.

The line between routine and anomalous is drawn by **what the refusal means**, not by how often it
happens — a threshold would be a second guessed constant, and the #419 checkpoint is already trying
to retire the first one (`MAX_ROWS_PER_ISSUE`).

- `illegal_scope` — the model broke a prompt rule. A disagreement between components.
- `scope_violation` — a row contradicts the scope of the issue it was routed to. Either the model
  routes by title similarity or a backfilled scope is too tight; both need a human to look.
- `unprobed_absence` — a known structural limit of the probe design (#357). Routine.
- `saturated` — no disagreement, and its real form is a *state*, not an event (#431). Routine here.

### 4. `recordedNoIssue` is replaced by three disjoint counters

The three mechanisms that put an actionable class into `quiet`:

| counter | meaning |
|---|---|
| `guardHits.unprobed_absence` | guard 3 downgraded an unprovable absence to `matcher_bug` |
| `quietCauseStripped` | the #358 gate stripped an unverifiable cause and the row went quiet |
| `quietNoTarget` | the model itself named neither an issue nor a new-issue key |

**All three are counted inside `planTriageActions`, where the disposition is decided.** The obvious
shortcut — reuse the job's existing `unverified` for the middle row — is wrong: `unverified` counts
every cause the gate stripped, including one whose verdict is later dropped as a foreign row or a
duplicate. It answers "how much did the gate strip", which is a different question from "how did
this row end up". Publishing it as a quiet disposition would reintroduce the same overlap in a new
place. `unverified` keeps its meaning and stays in the evidence-summary line.

Deriving `quietNoTarget` by subtraction is likewise rejected: `recordedNoIssue − unprobed_absence −
unverified` can go negative for exactly the reason above, and a report that can print a negative
number is not a report.

Counting directly requires `planTriageActions` to distinguish a stripped verdict from a declined
one. Today it cannot: the strip happens in `orphanTriage` before planning (`orphan-triage.ts:242`)
and leaves only a `unverified: ` note prefix. **The call site will pass the set of stripped verdicts
as an argument** — it already knows them, since it does the stripping. The set is keyed by verdict
OBJECT IDENTITY, not by beer id: an id-keyed set misattributes the survivor when the model emits a
duplicate verdict for the same beer, because the strip decision is per-verdict while
`planTriageActions` keeps only the first verdict per beer id (`seenBeerIds`) — a stripped *second*
verdict for a beer would then wrongly taint an untouched *first* verdict for the same beer that
`planTriageActions` actually kept.

The rejected alternative was a `cause_stripped` field on the verdict itself. It reads better, but
`Verdict` is `z.infer<typeof VerdictSchema>` — the model's own parsed output. A marker living there
is one schema edit away from being model-settable, which would let a model launder a stripped cause
into a voluntary declination. A separate argument keeps `Verdict` exactly what the model returned,
so the constraint is enforced by the shape of the data rather than by a rule someone must remember.

The note prefix stays — it is what a human sees reading `review_note` in an ad-hoc query, and it is
what made this investigation possible at all. It is simply never read by control flow.

### 5. What the human report shows

`buildTriageLine` already renders each part only when non-zero, so an entry that appears solely
during an anomaly is itself an exceptional signal inside the ordinary channel. That is the mechanism
used here — triage has no `notifyAdmin` path, and a warning that reaches only `journalctl` reaches
nobody, which is precisely how this defect survived.

Two kinds of number must not be confused here, because one of them appears in both roles:

- a **row disposition** — what happened to a row we were asked to triage. The digest's subject is
  the day's rows, so all dispositions belong there.
- a **guard tally** — how often a piece of machinery refused. Diagnostics, and subject to the
  routine/anomalous split.

`unprobed_absence` is both: it tallies guard 3 *and* it is the disposition of nine rows. It appears
in the digest in the second role only — as one of the three disjoint quiet counters — and never as
part of a guard block. Reporting a row's fate is not the same as reporting that a guard is noisy.

| in the digest | not in the digest |
|---|---|
| the three disjoint quiet counters, each only when non-zero | `guardHits` as a block |
| `illegal_scope`, `scope_violation`, only when non-zero | `saturated` |

`recordedNoIssue` disappears from both the type and the line. The digest therefore still accounts
for every row that got a class without an issue — it just names which of the three mechanisms did
it, instead of printing a sum next to one of its own parts.

## Interfaces

- `TriagePlan` — gains `quietCauseStripped: number` and `quietNoTarget: number`, both counted at the
  `!hasIssue && !hasKey` branch (`triage-plan.ts:173`).
- `planTriageActions` — gains a fifth parameter, `strippedVerdicts: ReadonlySet<Verdict>`, keyed by
  verdict OBJECT IDENTITY rather than beer id — the function iterates the very verdict objects the
  job produced, so identity is exact. Callers that do no cause verification pass an empty set.
- `TriageOutcome` — gains `guardHits: Record<GuardReason, number>`, `causeStripped: number` and
  `noTarget: number`; loses `recordedNoIssue`. `unverified` stays, with its existing meaning.
- `Verdict` — **unchanged**. The strip marker deliberately does not live on it.

## Constraints

- **No new thresholds.** The routine/anomalous split is by meaning, not by count.
- **The model must not be able to set the strip marker.** It is written by our code after the model
  responds; adding it to the tool schema would let a model launder a stripped cause into a declined
  one.
- **No behaviour change to what gets written to `enrich_failures` or to GitHub.** This is a reporting
  change. The same rows get the same classes and the same issues.

## Testing

The regression under test is a **silence**, so the tests must assert presence under conditions where
today's code prints nothing.

1. `guardHits` appears in the outcome when **all four guards are zero** and `covered == batch`. This
   is exactly the 2026-08-16 shape and today's code omits it.
2. `guardHits` appears when guards fired and `covered == batch` — the measured defect.
3. The narrow warn fires for `illegal_scope > 0` with no shortfall, and for `scope_violation > 0`
   with no shortfall.
4. The narrow warn does **not** fire for `unprobed_absence > 0` or `saturated > 0` alone. Mutation
   proof: widen the trigger to include them and exactly these tests go red.
5. `verdict shortfall` still fires on a genuine shortfall and no longer carries `guardHits`.
6. The three quiet counters are disjoint on a batch containing one of each mechanism, and they sum
   to the number of actionable-class rows written with no issue.
7. `quietNoTarget` counts a declined verdict and `quietCauseStripped` counts a stripped one, on a
   batch holding both. The stripped verdict's `review_note` must carry the `unverified: ` prefix
   while the declined one does not, so a test that passes by sniffing the prefix instead of reading
   `strippedVerdicts` would still be wrong. Mutation proof: have the job pass an empty
   `strippedVerdicts` and this test goes red while every note is unchanged.
8. The digest line shows neither `unprobed_absence` nor `saturated`, and shows `scope_violation` when
   non-zero.

## Out of scope

- **Saturation as a state** — label on the issue plus a standing count (#431). `saturated` stays an
  informational counter here. Measured 2026-08-16: nothing is saturated, top two issues at 8 of 12.
- **Making absence provable** (#357). This design reports guard 3 honestly; it does not change what
  guard 3 decides. The nine rows it downgraded stay downgraded.
- **`not_a_beer` filing no issue** (#430). A routing defect, not a reporting one.
- **Attributing `skipped` fully.** Guards 2 and 4 become attributable through `guardHits`; the five
  non-guard reasons (foreign row, duplicate id, contradictory routing, unknown target issue, unknown
  or over-cap `new_issue_key`) stay pooled in one number. Each is a malformed model proposal rather
  than a judgement about a row, and splitting them is separable work.
