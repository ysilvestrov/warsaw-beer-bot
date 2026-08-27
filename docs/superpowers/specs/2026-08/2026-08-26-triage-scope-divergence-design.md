# #509 — the prompt and the guard must judge by the same scope, and a refuted route must not cost the verdict

Date: 2026-08-26
Status: agreed
Issues: #509
Related: #510 (what the seven unroutable issues should *become* — split out of this, deliberately
not decided here), #508 (the 250 pre-existing ownerless rows, which this design reports on but
does not touch), #408 (guard 2's origin: the routing guard exists because #347 became a dumping
ground), #431 (the same move this design makes — a gate demoted to a reported state), #358 (the
verification gate, whose interaction with guard 2 is the sharpest finding below), #421 (the keyed
lock, which is why `issue_number` cannot be used as a mere label), #377 (why a verdict that names
no issue must never be locked)
Measured from: production `bot.db` and the 28 archived triage runs in `TRIAGE_LOG_DIR`
(`/var/lib/warsaw-beer-bot/triage-logs`) on 2026-08-26, against `main` = `74f8577`

## The model

> The triage job asks a model to make two separate claims about a row — *what kind of defect this
> is*, and *which open issue owns it*. A scope violation refutes the second claim. It says nothing
> about the first, and it must not be allowed to spend it.
>
> And a guard may only enforce a rule the party it judges was able to read.

Both halves are broken today, and they share one structural cause.

## The structural cause: the scope is parsed after the model has already answered

```ts
// src/jobs/orphan-triage.ts
const ex1 = await llm.analyze({ orphans, openIssues, probes });          // line 293
...
scopedIssues = openIssues.map((i) => ({ ..., scope: parseScopeBlock(i.body) }));  // line 352
plan = planTriageActions(analysis, scopedIssues, orphans, probes, strippedVerdicts);
```

The model receives `body.slice(0, ISSUE_BODY_CAP = 2000)` and must infer the constraint from
prose. The guard applies `parseScopeBlock` to the **full** body. They are not reading the same
thing, and nothing in the code makes them.

`renderScopeBlock` appends the block at the *end* of the body, so the cap removes precisely the
machine-readable condition that will later be enforced. This is not a cap that is too small; the
cap is the visible symptom of asking before parsing.

Measured over the 24 open `orphan-triage` issues:

```
scope visible to the model:  14
truncated away by the cap:    7   ← #405, #406, #334, #476, #376, #307, #302
no scope block at all:        3   ← #483, #484, #485
```

Ten of twenty-four issues show the model nothing — and among them sit the four largest row owners
in the system.

## Change 1 — parse once, above the call

`scopedIssues` moves above `llm.analyze`, and becomes the single input both consumers read:

```
listOpenIssues → scopedIssues (parseScopeBlock, once)
                      ├→ llm.analyze          — renders the scope from the parsed structure
                      └→ planTriageActions    — enforces the same parsed structure
```

The prompt renders an explicit scope line generated from `scope`, placed **before** the truncated
body, and strips any scope fence out of the body itself with the existing `stripScopeBlocks`, so
exactly one statement of the scope reaches the model. `ISSUE_BODY_CAP` stays as it is: once the
scope is rendered separately, the cap no longer cuts anything load-bearing.

`renderScopeBlock` at `createIssue` is unchanged — it writes the block we now read back.

## Change 2 — a target the guard will always refuse is not offered as a target

A scope that is `null`, or a cohort with no `where`, rejects every row outside the enumerated
cohort by construction. Such an issue is filtered out of the list the **prompt** receives.

This is prevention, not lifecycle: it removes two thirds of the mis-routings without deciding
anything about the issues themselves (#510).

Two boundaries, both load-bearing:

- **Only the prompt input is filtered.** `planTriageActions` and `reconcileSaturatedLabels` keep
  the whole open set. The guard must remain able to refuse a number the model invented, and a
  saturation label must still come off an issue the prompt no longer shows.
- The filter predicate is computed from the same parsed `scope`, in `triage-scope.ts`, next to
  `rowSatisfiesScope`. One definition of "this target can accept something", not two.

**[Superseded by the final review]** "A cohort with no `where` ... can never accept a new row"
is wrong: `rowSatisfiesScope` accepts a row by cohort membership (`scope.beer_ids.includes
(row.beer_id)`) *before* it ever looks at `where`, so a cohort-only issue can accept exactly the
rows its cohort enumerates — it is not "can accept nothing", only "can accept nothing outside
the cohort". The original filter (`where.length > 0` alone) ignored `beer_ids` entirely and hid
such an issue from the model regardless of whether the current batch fell inside its cohort,
which is *stricter than the guard*: a routing the guard would have accepted was never offered.
Measured over 26 archived production runs: on 4 of them (#322 with row 34642, twice; #320 with
31816; #320 with 30667) a cohort-only issue's `beer_ids` overlapped that day's batch. Fixed by
making `isRoutableTarget` a function of the current batch: a target is offered when `where` is
non-empty OR the scope's cohort intersects the batch's beer_ids. Found by the final whole-branch
review; six per-task reviews passed it.

## Change 3 — a refuted route keeps the class

Both scope-violation sites in `triage-plan.ts` (existing target ~247, proposed target ~261)
currently do:

```ts
guardHits.scope_violation += 1;
skipped++;
continue;                       // the classification dies with the routing
```

They become a push into `quiet` with the target removed and the reason recorded:

```ts
guardHits.scope_violation += 1;
quiet.push({
  ...verdict,
  issue_number: null,
  new_issue_key: null,
  review_note: `off-scope ${target}: ${explainScopeRejection(row, verdict.review_class, scope)}`,
});
continue;
```

`target` is `#405` at the existing-issue site and the model's `new_issue_key` at the proposed-issue
site, where no number exists yet. Both sites refuse for the same reason and must leave the same
kind of trace; a note that can only name a number would silently degrade at one of them.

The shape is copied deliberately from the `unprobed_absence` branch twenty lines above, which
already performs exactly this manoeuvre. This design adds no mechanism; it extends an existing one
to the second case that needs it.

Consequences, each checked against the code:

- **The row is not locked.** `lockedRowPredicate` requires `issue_number IS NOT NULL`. With `null`
  the row stays in the enrichment pool under backoff. A verdict naming no issue could never be
  unlocked, so locking it would be a permanent seal — the exact thing #377 spent a design removing.
- **The write is accepted.** `setEnrichFailureReview` refuses only on `outcome != 'not_found'` and
  on `not_on_untappd` without proved absence. An actionable class with a null issue writes.
- **`skipped` regains its meaning.** Today `skipped == scope_violation` exactly, every day since
  08-21 — "skipped" is almost entirely our own guard. Afterwards only real anomalies remain:
  duplicate verdict, contradictory routing, invented issue number.
  **[Superseded during implementation]** `skipped` also carries scope-refused `not_a_beer`
  verdicts — see the carve-out below.
- **The digest keeps `N поза scope`** (the guard counter still fires) but it now means *recorded
  without an owner* rather than *lost*. A separate counter is added so the checkpoint can measure
  it apart from `causeStripped`, which is a different reason for the same ownerless state.
  **[Superseded during implementation]** The `N поза scope` part was REMOVED from the digest: it
  and `N без власника (поза scope)` name the same rows, and publishing both is the #432
  double-count shape. `guardHits.scope_violation` stays in the logged outcome payload, which is
  where the checkpoint reads it.

### Superseded by the final review: `not_a_beer` is carved out of the refusal path

The rule above — "a scope violation refutes the target, not the class" — holds for every class
whose verdict is recoverable. `not_a_beer` is not one of them: `orphanNotOnTapPredicate` excludes
it from **both** enrichment pools unconditionally, so applying it removes the row from the
pipeline permanently, and `listOwnerlessRows` does not cover it, so the inbox would not show it
either. Recording it on the strength of a routing claim the guard just rejected would create
exactly the unsafe half of what `CLASS_LABELS` already warns about: *an irreversible verdict that
leaves no scoped issue trail*.

So `refuseRoute` raises `guardHits.scope_violation`, raises `skipped`, and leaves a refused
`not_a_beer` untriaged for tomorrow — the pre-change behaviour, for that one class.

Measured before deciding, by replaying all 28 archived runs: **0 of 62 `not_a_beer` verdicts ever
named an issue at all** (matcher_bug: 302 of 369 do; parser_bug: 15 of 98). The carve-out has
therefore never yet fired in production, and costs at most one extra LLM verdict on the day it
first does. Found by the final whole-branch review; six per-task reviews passed it.

`explainScopeRejection(row, cls, scope)` is new and small: the first term that failed
(`candidates_count = 0`), or `outside the cohort` for a cohort-only scope. It lives beside
`rowSatisfiesScope` because it is the same logic with an explanation attached. The note is capped
at 500 characters like every other note.

The row is **not** re-routed to a different issue. Choosing another target by title similarity is
the operation that produced #347, and guard 2's own comment forbids it.

## Change 4 — the ownerless rows get a place to be ground, not an owner

The rows this design stops discarding have a class and no issue. That population needs somewhere
to be seen, and the obvious idea — link them to a catch-all pseudo-issue — is a trap in this
codebase for two independent reasons:

- `enrich_failures.issue_number` is not a label, it is the **key of the #421 lock**. Linking rows
  to an issue that never closes seals them out of both pools permanently, which is strictly worse
  than today, where they at least retry. June's `wontfix` incident sealed 157 rows exactly this way.
- A catch-all target is a magnet, which is what #347 was and what guard 2 exists to prevent.

So the place is a **report, not an owner**. One standing issue labelled `triage-inbox`, whose body
the job regenerates from the database at the end of each run. The link is one-directional, DB →
report; `issue_number` stays `null` and the lock is untouched.

The report groups by the **refused target**, which is free and is the whole point: the model
already named the mechanism when it chose #485 for the ciders. The scope refused the routing, but
the meaning survives, and a group is a ready-made item to grind — either grow that issue's scope,
or file a narrower issue and remap the rows per CLAUDE.md.

Scope of the report, decided by measurement: only rows carrying a machine-readable reason (the new
`off-scope #N:` and the existing `no absence evidence:`). There are already **250** rows with an
actionable class and no issue, of which **218 carry free model prose** and cannot be grouped at
all. Listing them flat would rebuild #347 in report form. Their total appears in the header as one
number; the population itself is #508's.

Mechanics:

- The label is `triage-inbox` and **must not** be `orphan-triage`. Otherwise the inbox enters
  `listOpenIssues(TRIAGE_LABEL)` and becomes a routing target for the model. This is an invariant
  with a test, not a comment.
- Found with `listOpenIssues('triage-inbox')`: an open one is rewritten, otherwise one is created.
  No `job_state` entry. More than one open inbox ⇒ use the newest and warn; a duplicate means a
  human made one.
- Body is **rewritten**, never appended to as comments.
- Requires one new client method, `setIssueBody(number, body)` (PATCH). `GithubIssuesClient`
  currently has create / comment / add-label / remove-label only.
- Best-effort, after every DB write, like `reconcileSaturatedLabels`: a GitHub failure must not
  cost a verdict that was already earned. The next run regenerates.
- Closing the inbox is how a human says "ground": the next run opens a fresh one containing
  whatever is left. No extra mechanism.
- Bounded at 10 groups and 15 rows per group, remainder as counts. The GitHub body limit is 65536
  characters and this must not approach it.

## Evidence

The archives (`TRIAGE_LOG_DIR`) carry the raw prompt and the model's verdicts per run, so
`planTriageActions` was replayed offline against 28 days. No LLM call was needed.

**The loop is stationary, not unlucky** — the model's own archived verdicts:

| row | routed to | consecutive days |
|---|---|---|
| 29667 Sofia Electric Brewing Fruit | #405 | 9 |
| 32476 Lvivska Pivovarnya / Lwowskie 1715 | #320 | 9 |
| 29512 RIOAZUL/GROSS JESULI | #401 | 8 |
| 288 / 192 / 64 (ciders) | #485 | every day since 08-24 |

**85 mis-routings since 08-17**, by reason: `COHORT_ONLY` 38, `WHERE_CONTRADICTED` 31,
`NO_SCOPE_BLOCK` 16. Two thirds went to targets that could never have accepted anything.

**Production counters agree with the replay's premise**: since 08-21, `skipped == scope_violation`
exactly, every day (6, 4, 3, 6, 10, 5). Every lost row is our own guard; ~6/day, 34 since 08-21.

**The perverse selection.** Cross-checking the replay against what production wrote on 08-26: 11
mis-routings, 5 rows dropped. The other 6 had been caught by the #358 verification gate first,
which strips `issue_number` *before* planning — so they fell into the "actionable with no target"
branch and kept their class:

```
32730 → #485   prod: class=matcher_bug iss=None    ← saved by an unverified cause
34959 → #485   prod: NO CLASS (dropped)            ← lost by a verified one
31925 → #485   prod: class=matcher_bug iss=None
31073 → #485   prod: NO CLASS (dropped)
```

A row survives by carrying the *weaker* proof. Change 3 removes the asymmetry rather than adding a
third branch.

## Decisions taken in the brainstorm

- **The refuted verdict keeps its class (option A) rather than being re-asked of the model
  (option B).** B treats the symptom at the most expensive layer: the mis-routings exist mostly
  because the model cannot see the scope, and Change 1 removes that. A also *saves* budget — 29667
  spent nine LLM evaluations to produce the same refused verdict nine times.
- **The inbox is a report, not an owner.** See Change 4 for the two reasons a pseudo-issue owner is
  worse than the status quo.
- **The inbox covers only machine-groupable rows.** The 250 legacy rows go to #508.
- **The target filter belongs here, not in #510.** "Show the model the scope that is enforced" and
  "do not offer a target that can accept nothing" are the same thesis — the prompt and the guard
  agreeing. Neither decides what an unroutable issue should become; that is #510.

## Rejected

- **Raising `ISSUE_BODY_CAP`.** Treats the symptom. The block would still sit at the end of a body
  that can grow past any constant, and prompt and guard would still read different text.
- **Filtering dead targets out of the guard too.** The guard must stay able to refuse an invented
  number, and `reconcileSaturatedLabels` needs the full open set to take a stale label off.
- **Re-routing a refused row to another issue.** Title-similarity routing is what built #347.
- **A pseudo-issue as the value of `issue_number`.** Seals the rows via `lockedRowPredicate`.

## Testing

Every test mutation-proved: delete the implementing line, watch it go red. A test that stays green
is not a test.

| invariant | what a weak test would miss |
|---|---|
| unscoped and cohort-only issues are **absent** from the prompt | the filter is written but both consumers share one list object |
| the same issues are **present** for the guard | both consumers were filtered — the guard can no longer refuse an invented number |
| the scope the model sees parses back into the structure the guard enforces | the renderer drifted from `parseScopeBlock` and the divergence was rebuilt elsewhere |
| an issue with a 5000-character body still shows its scope | someone "fixed" it by raising the cap; the test must bind the behaviour, not the constant |
| a scope-refused verdict writes its class with `issue_number = null` | `skipped++` replaced by a bare `continue` — the row vanishes again |
| the inbox issue does **not** carry `orphan-triage` | the inbox joins `listOpenIssues(TRIAGE_LABEL)` and becomes a routing target |

## Predictions, recorded before deploy

- `skipped` falls to ~0. If it does not, a fourth loss path exists that this investigation missed.
- `scope_violation` falls substantially, but **not** necessarily by the 54/85 the filter removes:
  a row denied its dead target does not disappear, it gets routed somewhere else, and that target
  may contradict it too. The honest floor is the next line, which holds no matter where the model
  routes.
- **No row leaves a triage run without a class.** This is the number that matters.
- The chronic captives take a class in one run: 29667, 32476, 29512, 288, 192, 64.

**What would surprise me:** `scope_violation` *not* falling. That would mean the model routes into
live issues and contradicts their `where` — the scopes themselves being poor proxies for their
mechanisms, which is #510's problem, not this one's.

A dated checkpoint issue is filed at deploy time, in the style of #480 and #488.

## Deliberately not in scope

- What the seven unroutable issues should become (#510).
- The 250 pre-existing ownerless rows (#508).
- `TRIAGE_BATCH_LIMIT = 50` starvation. On 2026-08-26 the untriaged pool was 67 and the queue is
  `last_at DESC`, so 17 rows were never offered. It is real but independent: on 08-22..08-25 the
  pool was 11/26/26/32 — under the limit — and the same rows were still lost, to the guard. Worth
  its own measurement once this change stops the losses that dominate it today.
