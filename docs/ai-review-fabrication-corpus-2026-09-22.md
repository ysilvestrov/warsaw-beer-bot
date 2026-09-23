# Fabrication corpus — 16 claims a good judge rejected

A ready-made test set for the **verify** stage, harvested 2026-09-22 from three
`deepseek/deepseek-v4-pro-0813` runs of the recall probe (PR #418 at `584aa661`).
DeepSeek was rejected as a `find` model precisely because it produced these; that makes
them useful, because a verify candidate has to reject them too.

Protocol and the runs that produced this: `docs/ai-review-model-evaluation.md`.

## What this is for

The recall probe measures whether a model **finds** defects. It cannot measure whether a
model **rejects a claim the code contradicts** — for that you need claims that are wrong,
and the corpus of labelled PRs contains almost none, because the shipped pipeline stopped
publishing them in 2026-07.

So: feed these claims to a candidate verify model against the same tree, and count how
many it returns as `refuted`. A candidate that confirms them is a judge that would have
published DeepSeek's output.

**What the labels are worth.** Each claim below was returned `refuted` by `gpt-5.5` — the
incumbent judge — not adjudicated by a human against the tree. That makes this a
*consistency* test against the shipped judge, not ground truth. Before treating a
disagreement as a candidate's failure, check the claim against
`git show 584aa661:<path>` yourself: a candidate that confirms a claim `gpt-5.5` refuted
may be right, and that would be a finding about the incumbent.

**Twelve of the sixteen are usable.** The last four in run 3 are degenerate: DeepSeek
reasoned out loud inside the claim field and concluded "Fine." / "No bug." in the claim
itself. Any judge rejects those without reading code, so they measure nothing. They are
kept for completeness and marked.

## Scale — why 16 is a lot

| source | findings reaching verify | `refuted` | `out_of_scope` |
|---|---|---|---|
| production, PRs #359–#363 (`gpt-5.5` find) | 29 | **0** | 7 (+1 error) |
| DeepSeek, 3 runs of PR #418 | 37 | **16** | 19 |

`refuted` is the fabrication signal and `out_of_scope` is not: the first says the code
contradicts the claim, the second says the claim is about something the diff did not
change. Production has never produced a `refuted`.

## The claims

Tree: PR #418 at `584aa661`. Run counts: r1 raised 8 → gated 6 → verified 0;
r2 raised 10 → gated 9 → verified 1; r3 raised 31 → gated 22 → verified 1.

### Run 1

1. `src/infra/github-issues.ts` — The GitHub API may return `null` for `created_at` for issues created via the UI without a created timestamp?
2. `src/jobs/orphan-triage.ts` — The `review` callback writes `issue_number` as `issueNumber` for all verdicts including `null` values.
3. `src/domain/triage-scope.ts` — Replacing literal backticks in JSON string with `\\u0060` is incorrect because the replacement string for `String.replace` treats ``` as the Unicode escape for a backtick, producing a literal backtick in the output.

### Run 2

4. `src/domain/triage-scope.ts` — The human-readable `Scope:` prose line is not escaped against backticks when joined from `where` terms.
5. `src/jobs/orphan-triage.ts` — `setEnrichFailureReview` now writes `issue_number`, but the `review` callback for `quiet` verdicts passes `null`, and `setEnrichFailureReview` does not clear `issue_number` for those rows.
6. `src/storage/schema.ts` — The backfill SQL does not exclude rows where the trailing note has a negative or fractional number cast.
7. `src/domain/triage-scope.ts` — Escaping backticks in JSON payload to `\\u0060` is not backward compatible with the parser's BLOCK_RE.
8. `src/infra/github-issues.ts` — Raw issue body may be null; listOpenIssues maps it to empty string but does not parse rendered scope from body.
9. `src/domain/triage-scope.ts` — Numeric term comparison does not handle null/undefined `candidates_count` or `fail_count`.
10. `src/domain/triage-scope.ts` — The rendered scope block does not escape backslashes in the JSON line for markdown coercion.

### Run 3

11. `src/domain/triage-scope.ts` — The backtick escape replacement writes a string that, when JSON-parsed, produces a literal backslash-u sequence instead of a backtick because the replacement string uses double backslash.
12. `src/storage/enrich_failures.ts` — recordEnrichFailure's ON CONFLICT upsert does not reset issue_number when candidates_count crosses the 0↔>0 boundary and review fields are cleared, so a re-failed row retains its old issue_number.

Degenerate — the claim answers itself, so no judge has to read code:

13. `src/domain/triage-scope.ts` — ScopeTermSchema's union as written permits a numeric term with value undefined? Actually strict object with value required. Fine.
14. `src/domain/triage-scope.ts` — If a contains value contains a literal backslash or unicode escape that after replacement produces a backtick? […] JSON.parse correctly decodes. No bug.
15. `src/domain/triage-scope.ts` — For text cols, comparing v.toLowerCase().includes(term.value.toLowerCase()) treats empty string as containing any? Contains only schema requires min(1). fine.
16. `src/domain/triage-scope.ts` — TEXT_COLS include source_url which can be NULL? In UntriagedFailure source_url is string; schema review_row has string not null. fine.

## The pattern, for whoever reads a future candidate's output

Ten of the twelve usable claims cluster on two files (`triage-scope.ts`, `orphan-triage.ts`)
and on one mechanism: the backtick-escaping change in the scope block. Four separate claims
assert the escape is broken, in four incompatible ways — including two that contradict each
other about which direction the escape fails. That is the shape of a model reasoning about
string escaping without evaluating it, and it is worth recognising, because a `find` model
that does this floods verify with variations of one wrong idea rather than with independent
mistakes.
