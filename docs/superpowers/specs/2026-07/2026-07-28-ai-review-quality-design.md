# AI PR review — finding quality (greedy find + strict verify) — design

**Date:** 2026-07-28
**Issues:** #175 (ci: AI PR review produces low-confidence / hallucinated findings)
**Status:** approved

## Problem

The AI PR reviewer (`scripts/ai-pr-review.ts`, rewritten in #143/#174) is infrastructurally sound —
one top-level marker review, fail-loud, scope globs single-sourced. What it emits is not.

Measured on the five most recent merged PRs (#344, #348, #352, #356, #358 — 18 findings total):

| observation | value |
|---|---|
| PRs reviewed | 5 |
| PRs that produced findings | 5 (100%) |
| PRs that produced "no high-confidence findings" | **0** |
| findings per PR | 2–4, never zero |
| findings labelled P1 | the large majority; no P0 observed, P2 rare |

`.github/ai-review/AGENTS.md` already says *"Prefer no comment over a low-confidence comment"* and
bans "missing tests unless the diff creates a clear untested failure mode". The model honours
neither. Every review is 2–4 findings shaped as *"Potential Data Loss in X"*, *"Missing Error
Handling in Y"*, *"Test Coverage for New Behavior"* — the exact classes the instructions forbid.

Two findings were re-checked against git and are demonstrably false:

- **#348, finding 1** — claims migration v20 will lose data and recommends `CREATE TABLE AS SELECT`.
  The migration is `ALTER TABLE beers RENAME COLUMN google_tried_at TO web_tried_at`, which preserves
  data by construction; the columns were empty in prod besides.
- **#352, findings 2 and 3** — demand that `applyLookupOutcome` return `'merged'` and that
  `enrichRoute` handle a `merged` kind. That PR *is* the change that adds
  `EnrichOutcomeKind = … | 'merged'` and `return 'merged'`. The findings describe the pre-PR state.

This reproduces the #174 evidence (a hallucinated P0 whose "fix" was verbatim the existing code) and
generalises it: the failure is not occasional, it is the operating mode.

### Root cause

Three compounding causes, in order of contribution:

1. **The model cannot see the code.** `main()` sends `git diff` only (`scripts/ai-pr-review.ts:268`).
   Every claim about surrounding behaviour — *"if there are existing records…"*, *"the promise chain
   may not release the gate…"* — is necessarily a guess about bytes the model was never shown. This
   is the same defect the orphan-triage job had before #358: the model is asked to explain code it
   is not given, and surface pattern-matching is its only available strategy.
2. **The output is unfilterable.** Free-form markdown with no line anchor, no verbatim quote, and no
   confidence field. Nothing can be dropped programmatically before posting, so instruction-following
   is the *only* line of defence — and it is not holding.
3. **The model is three generations stale.** `gpt-4o-mini` is hardcoded at
   `scripts/ai-pr-review.ts:142`.

### Why "fewer false positives" is the wrong goal

The reviewer's value is **orthogonality**. Every PR in this repo is already reviewed by Claude under
the project's own policies before it opens, so a reviewer that agrees with that pass adds nothing —
it is an echo chamber. What justifies the job existing is a *different* model noticing something the
first pass did not. Tightening suppression until the noise stops would also silence exactly that.

The goal is therefore not fewer findings. It is that **every published finding is mechanically
checkable**, so that greedy, low-confidence search becomes affordable rather than corrosive.

Precedent: #352's commit log records the author engaging with one AI-review suggestion and declining
it with reasons — so the reviewer is not worthless today, merely drowned in its own noise.

## Live API probe (per project policy: validate external APIs before designing on them)

Probed with the trial key on 2026-07-28. `GET /v1/models` → HTTP 200, 125 models. Facts that
directly constrain the design:

| fact | consequence |
|---|---|
| `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.5` / `gpt-5.x-codex` / `o3` / `o4-mini` are all available | the hardcoded `gpt-4o-mini` is a large, free capability gain away from the current state |
| `max_tokens` → **HTTP 400** on every `gpt-5.x` ("Use `max_completion_tokens` instead") | the current request body (`scripts/ai-pr-review.ts:145`) would fail outright on any model swap |
| `temperature: 0` → **HTTP 400** on `gpt-5.5` ("Only the default (1)"); accepted on `gpt-5.4-mini` | determinism via sampling is no longer a portable lever; stability must come from schema + verification |
| `response_format: {type: "json_schema", strict: true}` → HTTP 200, parseable, on all candidates | the structured-output design below is viable as specified |
| `gpt-5.5` reports `reasoning_tokens` > 0 even on a trivial prompt | reasoning spend is real and must be budgeted in `max_completion_tokens` |

Had the model been swapped without this probe, the first CI run would have 400'd.

## Goals

- Every published finding cites code that provably exists, in a region the PR actually touched.
- A genuinely clean PR yields an explicit "no verified findings" — still green.
- Greedy search is preserved (and deliberately encouraged) so the reviewer can surface what the
  Claude pass missed.
- Suppression is observable in prod, not only on a replay set.

## Non-goals

- Changing the reviewer's provider. OpenAI is retained **deliberately**, for orthogonality.
- Inline / per-line review comments. One top-level marker review stays (#143/#174).
- Reviewing anything outside the PR's changed lines.
- Auto-fixing, or blocking merge on findings.

## Design

### 1. Review context — diff plus full file content

`buildContext()` assembles, for the reviewable file set (existing `filterReviewableFiles`):

- the unified diff (as today), and
- the **full HEAD content of each changed file**, labelled with the file path.

Budgeting: `DIFF_BUDGET` is replaced by a total context budget. The diff is always included in full;
file bodies are added largest-change-first until the budget is exhausted. Files that did not fit are
listed explicitly in the prompt under a `diff-only` heading, with the instruction that no claim may
be made about the unshown parts of those files. Deleted files contribute diff only.

This is the single highest-value change: it removes the ground on which findings 1 of #348 and 3 of
#358 were grown.

### 2. Pass 1 — greedy find, structured output

One call. `response_format: json_schema`, `strict: true`:

```jsonc
{
  "findings": [{
    "file":        "src/domain/lookup-outcome.ts",  // repo-relative
    "start_line":  42,                              // in HEAD content
    "end_line":    44,
    "quote":       "return 'not_found';",           // verbatim from HEAD
    "claim":       "…one sentence: what is wrong",
    "why_it_breaks": "…concrete failure path: input → wrong outcome",
    "severity":    "P0" | "P1" | "P2",
    "confidence":  "high" | "medium" | "low"
  }]
}
```

`.github/ai-review/AGENTS.md` is rewritten to invert its current stance: report everything including
low-confidence and low-severity items, do not filter for importance, a separate step will do that,
coverage is the objective here. The verbatim-quote requirement is stated as a hard constraint —
a finding that cannot quote real code cannot be expressed in the schema.

Severity/confidence are retained for **ranking**, not gating. Self-reported confidence is not trusted
as a filter (that is what #175 already tried, in prose).

### 3. Mechanical gate — no model involved

Pure function, no network, therefore the most cheaply and thoroughly testable part of the pipeline.
A finding is dropped when any of:

| check | drops |
|---|---|
| `file` is not in the reviewed set | findings about files the model invented or that are out of scope |
| `quote` does not appear verbatim in HEAD content of `file` (whitespace-normalised) | pure hallucination — the #174 P0 class, whose "fix" equalled existing code |
| the matched region does not intersect the PR's changed line ranges | true-but-pre-existing observations; a PR review must be about the PR |
| duplicate `(file, normalised quote)` | the same observation restated |

Match is on normalised whitespace to tolerate re-indentation; `start_line`/`end_line` are corrected
to the real match position rather than trusted, since line numbers are the field models most reliably
get wrong.

### 4. Pass 2 — adversarial verification

One call **per surviving finding**, each carrying the full file content plus the finding, asking for
`confirmed` / `refuted` / `out_of_scope` and one sentence of evidence citing the code. Only
`confirmed` is published.

This is the step that kills the #352 class: given the finished file, a model can see that `'merged'`
is already returned and must answer `refuted`. It mirrors the pattern shipped in #358 — a causal
claim reaches GitHub only after an automatic check re-derives it.

A verification call that errors leaves its finding **unpublished** (fail closed) and logs the reason;
it does not fail the job.

### 5. Published output

Review body contains confirmed findings only, ordered P0 → P2, each with file, line, quote, claim and
the smallest safe fix. When nothing survives:

> **No verified findings.** 6 raised → 3 passed the evidence gate → 0 confirmed on review.

The counter footer (`raised N → gated M → verified K`) is present on every review, which makes the
suppression rate a **production** metric rather than a replay-only one. Dropped findings and their
drop reasons go to `::notice::` in the workflow log — auditable for recall, invisible in the PR.

### 6. Model selection

`AI_REVIEW_MODEL` (find) and `AI_REVIEW_VERIFY_MODEL` (verify) come from env, with defaults chosen by
the measurement below rather than asserted here. Candidates: `gpt-5.4-mini` (cheap, tolerant of
`temperature: 0`) and `gpt-5.5` (reasoning). Asymmetric configuration — cheap greedy pass, stronger
verifier — is permitted by the split and will be evaluated.

Request-shape rules established by the probe: `max_completion_tokens` (never `max_tokens`); omit
`temperature` entirely rather than sending `0`.

### 7. Module layout

`scripts/ai-pr-review.ts` at 299 lines would roughly double with two stages. Split into
`scripts/ai-review/`:

| module | responsibility | network |
|---|---|---|
| `context.ts` | changed files, diff, file bodies, budget degradation | no |
| `find.ts` | pass-1 request/response + schema | yes |
| `gate.ts` | mechanical gate (pure) | no |
| `verify.ts` | pass-2 per finding | yes |
| `render.ts` | review body + counters | no |
| `openai.ts` | client, retries, error classes (lifted from today's `callOpenAI`) | yes |
| `replay.ts` | run the pipeline against a PR **without posting** | yes |

`scripts/ai-pr-review.ts` remains a thin orchestrator owning config, exit codes and `upsertReview`.
Scope globs stay single-sourced in the script (the #143 invariant); `scripts/**/*.ts` already covers
the new directory, so the reviewer keeps reviewing itself.

### 8. Failure semantics (unchanged contract)

The script owns its exit code and fails loud (#143/#174). Pass-1 failure, config error or GitHub
failure → `::error::` + exit 1. Individual pass-2 failures degrade to unpublished findings and never
fail the job — a flaky verifier must not turn a green PR red.

## Measurement

Success is not asserted; it is measured with `replay.ts` before the default model is fixed.

**Precision** — the 18 findings from #344/#348/#352/#356/#358 are hand-labelled real / false /
unfalsifiable (preliminary reading says the large majority are false or unfalsifiable; two are
confirmed false above). Full labelling is the first task of the implementation, not an assumption of
this design. The pipeline is replayed on the same five PRs. Target: **no published finding that
hand-labelling calls false**.

Note on the #352 precedent: the finding the author engaged with was *declined* with reasons ("so
`merged` never crosses the API boundary"), not accepted. It is evidence that a well-formed finding
gets read, not evidence of a caught bug — so its survival is explicitly **not** a success criterion.

**Recall** — the history contains defects that *escaped* review and were fixed later; these are
ground truth, because both the AI pass and the Claude pass missed them:

| escaped defect | fixed in | introducing PR to replay (verified by `git log --diff-filter=A`) |
|---|---|---|
| triage: empty verdict → silent no-op | `98c05da` (#296) | **#233** (`c6b49a4`, added `src/jobs/orphan-triage.ts`) |
| triage prompt lacks a translation guard | `7a9e262` (#354, issue #340) | **#237** (`1d60f96`, last prompt tuning before the fix) |
| `rearm-matcher-bug-orphans` lacks exact-id mode | `243b75f` (#336) | **#274** (`f0f91cb`, added the script) |
| release-notes scope wrong for 0.12.0 | `7b2d10b` (#313) | **#312** |

Replaying the pipeline against the *introducing* PR answers the question the whole change exists to
answer: does a second, differently-shaped model catch what the first pass missed? Recall on this set
is the metric that must not be traded away for precision.

**Cost** — recorded per replay (calls, tokens, USD) so the model choice is made on evidence.

## Testing

- `gate.test.ts` — quote present/absent, whitespace-normalised match, line-range intersection,
  out-of-scope file, duplicates, line-number correction. Pure, no fakes needed.
- `context.test.ts` — budget degradation ordering, `diff-only` labelling, deleted files.
- `render.test.ts` — empty-verified body, counter footer, severity ordering.
- `find.test.ts` / `verify.test.ts` — fake `fetch` (existing pattern in `ai-pr-review.test.ts`),
  including schema-invalid response and per-finding verify failure → unpublished.

## Rollout

1. Merge with defaults set from the measurement; secret and workflow are unchanged (`OPENAI_API_KEY`
   already exists in repo secrets since 2026-06-05).
2. First live PR is the reviewer's own — it reviews itself, as in #174, which is the cheapest
   possible smoke test.
3. Watch the `raised → gated → verified` footer for the following ~5 PRs. A verified rate stuck at 0
   means the gate is too tight; a rate near 100% means verification is rubber-stamping.

## Spec impact

`spec.md` §5.10 documents the reviewer and is already stale relative to #143/#174 (noted in project
memory). It is updated in the same PR to describe the two-stage pipeline, the evidence gate and the
env-configured models — as CLAUDE.md requires.

## Open questions / follow-ups

- Whether `gpt-5.x-codex` variants outperform `gpt-5.5` on this task — worth a replay round, but not
  a blocker; the env split makes it a config change afterwards.
- The trial key used for probing is temporary and is deleted by the user after today; CI continues to
  use the repo secret. Any further local replay needs a key supplied again.
- If verification proves reliably strict, a future change could drop the confidence field from the
  pass-1 schema entirely.
