# Triage verdict integrity — decomposition of #377 / #381 / #408 / #412

Date: 2026-08-14
Status: agreed (backlog re-cut; each resulting issue gets its own spec + plan)

## Problem

Four open issues describe what looked like four defects in the orphan-triage agent. Read together
they are three measured violations of one invariant:

> Every triage verdict carries a consequence. No consequence may be applied without evidence from
> the row itself, and no consequence may be irreversible.

`planTriageActions` splits verdicts in two (`src/domain/triage-plan.ts:78-80`):

- **actionable** (`parser_bug`, `matcher_bug`) — routed to a GitHub issue and labelled;
- **quiet** (`not_on_untappd`, `wontfix`) — written straight to `enrich_failures.review_class`
  with no gate at all.

The verification gate shipped in #358 stands in front of the *cause* attached to an actionable
verdict. Nothing stands in front of either the *routing* of an actionable verdict or the *class*
of a quiet one — and a quiet verdict is terminal: `wontfix` and `retired_at` are hard exclusions in
`orphanWithoutMatchLinkPredicate` and `listLookupCandidates` alike, so the row leaves both candidate
pools permanently and cannot even self-match when it returns to a tap.

Measured instances:

| issue | side | measurement |
|---|---|---|
| #408 | routing | #347 took 36 rows / 7 mechanisms / 0 fixes in 19 days; 6 rows with `candidates_count = 0` filed against a brewery-**gate** issue, where the gate cannot run |
| #377 | terminal class | 7 of 14 audited `not_on_untappd` verdicts were wrong; the "no probe ran" cohort was wrong 3 of 3 |
| #412 | terminal class | 157 orphans bulk-marked `wontfix` in June 2026 as a *staleness annotation*; all 157 still orphans, and a 30-row live replay of the reachable slice rescued 27% |
| #381 | routing | 3 of 13 flasker `matcher_bug` rows are adapter defects; 72 `parser_bug` rows have a shop URL vs 38 ontap rows, one label for two codebases |

#381 also records the same failure shape from the other direction: a 2026-06-14 bulk backfill wrote
blanket `matcher_bug` over 24 non-beer rows. Bulk class writes with no per-row evidence are the
common ancestor of #412 and that side finding.

## The cut

Not by consequence (terminal vs routing) but by **who enforces the rule**, because that is what
makes each piece a single PR with a "delete the line, show the test fail" shape. Our own evidence
says broad issues do not ship: #347 ran 19 days with zero fixes.

### A — deterministic verdict guards (`planTriageActions`, pure function, no LLM)

1. **`Scope:` becomes an executable predicate.** A proposed new issue must declare a predicate over
   `enrich_failures` / `beers` columns containing **at least one term over a column other than
   `review_class`** — that is the operational meaning of "narrower than the class", and a bare
   whole-class filter is therefore rejected by construction. Replaces the prompt's current example
   (`triage-analysis.ts:217`), which offers the whole-class form as the model to copy.
2. **Attachment is checked against that predicate.** A verdict may attach to an open issue only if
   the row satisfies the issue's scope predicate. This is what makes #408's "route on evidence, not
   on title similarity" checkable at all: without a machine-readable scope there is nothing to check
   a row against.
3. **Class gate** (from #377): `not_on_untappd` is accepted only when a probe actually ran for that
   row and returned nothing. Otherwise the verdict degrades to `matcher_bug` with
   `issue_number: null` and the row stays in the pool instead of being closed.
4. **Saturation guard**: an open triage issue past N rows with no linked PR stops accepting
   comments. #408 proposes N = 15; the constant is deliberately left to A's own spec, which should
   pick it from the observed row-per-issue distribution rather than from the anecdote of #347.

**Hard constraint on 1–2.** The predicate is authored by the LLM, so it must never be executed as
SQL. Closed grammar only — `column op value` terms joined by `AND`, columns from an allowlist —
evaluated in TypeScript against the row fields already loaded for the prompt. This keeps the guard a
pure function and keeps model output off the query path.

Absorbs #408 in full and #377 proposals 1 and 3.

### B — terminal classes must be reversible

1. **Vocabulary**: `wontfix` means exactly one thing — never matchable (non-beer, merch, bundle
   SKUs). "This record is stale / superseded by a shipped fix" is `retired_at`, which already has a
   tool: `retire-resolved-orphans --ids/--reason`.
2. **Periodic re-arm sweep** for terminal classes older than N days (#377 proposal 4). N is left to
   B's own spec; the natural anchor is "older than the last matcher deploy", not a fixed age.
3. **Audit**: a `wontfix` older than the last matcher deploy, with `candidates_count > 0`, that has
   never been replayed is a liability, not a decision.

Absorbs #412 in full and #377 proposal 4. Both bulk precedents are already measured and cleaned:
157 rows un-sealed 2026-08-14 (#412), 24 rows retired 2026-08-09 (#381 side finding).

### C — #381 narrowed

Reduced to deriving a routing field (`fix_site` / `fix_area`) from `source_url` plus the split-shape
hints, and explicitly folded into #357, where the deterministic-hints work already lives.

## Disposition

| issue | action |
|---|---|
| **#408** | becomes **A** — title and body rewritten; absorbs #377 proposals 1 and 3 |
| **#377** | becomes **B** — rewritten; absorbs #412 in full |
| **#412** | closed as absorbed into #377, measurements carried over |
| **#381** | narrowed to the routing field, folded into #357 |

#377 keeps its number deliberately: it carries the richest evidence (the 7-of-14 audit table), which
should not end up inside a closed issue.

## Label mechanic

`listOpenIssues('orphan-triage')` (`src/jobs/orphan-triage.ts:184`) pulls **every** open issue
carrying that label into the prompt, capped at 30 issues × 2000 body chars. Process issues therefore
(a) consume prompt budget with text no row can be classified against, and (b) remain legal
attachment targets — our own backlog degrades the triage it describes.

Process issues (#357, #377, #381, #408) lose `orphan-triage` and gain `triage-quality`. Issues that
represent a concrete matcher/parser defect keep `orphan-triage`.

## Out of scope

- Any change to the matcher itself. Every fix here is triage-side.
- Re-classifying existing rows in bulk. Project policy is to replay before believing a triage note;
  the 157-row un-seal was applied only after a live replay measured the rescue rate.
- Retiring the `wontfix` class. It stays, with one meaning.

## Testing shape

A is a pure function over `(analysis, openIssues, batchBeerIds)` — every guard is unit-testable with
no network, and each guard must be demonstrated by deleting it and showing a red test
(project policy, see the #384 review). B is a storage/ops change: the vocabulary rule is enforced at
the write site, the sweep is a job with a `job_state` idempotency key like every other cron here.
