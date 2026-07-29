# AI review precision baseline (pre-#175)

**Date:** 2026-07-28
**Source:** the marker reviews on PRs #344, #348, #352, #356, #358 (18 findings).
**Purpose:** ground truth for measuring the two-stage reviewer built in #175.

## Method

The five `<!-- ai-pr-review -->` review bodies were pulled with `gh api repos/:owner/:repo/pulls/<n>/reviews`; they contain 4 + 4 + 4 + 2 + 4 = 18 findings. Every claim was checked against the tree the reviewer actually saw — the PR head commit at the review's `submitted_at`, not just the merge commit — because on #344 the author pushed a fix 13 minutes after the review. Labels: `real` = a genuine defect in that diff (acting on it prevents a bug); `false` = contradicted by the code, checkably wrong; `unfalsifiable` = speculation about code not shown, or a generic "add error handling / add tests / consider logging" with no concrete input → wrong-result path. Two findings (#348-1, #352-2/3) reuse verdicts already established by the project lead.

## Findings

| PR | # | finding (short) | label | evidence |
|---|---|---|---|---|
| 344 | 1 | orphan check-ins lost when `pinMatch` deletes the merged orphan | real | reviewed head `6deab17` had `DELETE FROM beers` with no `checkins` redirect; `checkins.beer_id` has no `ON DELETE CASCADE` — fixed in `ef2ebd2`, 13 min after the review |
| 344 | 2 | `main` in `src/domain/pin-match.ts` lacks error handling around `openDb` | unfalsifiable | that file has no `main`; the CLI (`scripts/pin-match.ts`) already wraps in `try/finally`, and "log a friendly message" names no failure path |
| 344 | 3 | `unpinByRef`/`unpinByBeer` report changes even when no pin exists | false | both `UPDATE … WHERE … AND reviewed_by_user = 1` and return `.changes`, which is `0` on no match |
| 344 | 4 | no test for re-pinning an already-pinned beer | false | `pin-match.test.ts` at the reviewed head already has `idempotent: re-pinning an already-pinned beer is a no-op that keeps the flag` |
| 348 | 1 | renaming `google_tried_at` loses data; use `CREATE TABLE AS SELECT` | false | migration v20 is `ALTER TABLE beers RENAME COLUMN`, which preserves data by construction (columns were empty in prod anyway) |
| 348 | 2 | `schedule`'s promise chain never releases the gate on a failed request | false | `gate = run.then(() => undefined, () => undefined)` swallows the rejection, so the chain always advances |
| 348 | 3 | `hydrateAbv` does not handle a failing `hydrate.search` | false | the function body is a `try { … } catch { return null }`, documented as best-effort |
| 348 | 4 | quota can exceed the cap under quick successive requests | false | one atomic UPSERT `ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ?`; max stored count is exactly `cap` |
| 352 | 1 | blocked path returns `null` without logging the spent call | false | `isWebFallbackBlocked` is checked *before* `tryConsumeWebSearchQuota`, so nothing is spent; it still writes a `debug` skip line |
| 352 | 2 | `applyLookupOutcome` should return `'merged'`, not `'not_found'` | false | this PR is what adds `'merged'` to `EnrichOutcomeKind` and `return 'merged'`; the finding describes the pre-PR state |
| 352 | 3 | `enrichRoute` does not handle the new `merged` kind | false | same PR adds the `merged` branch answering with the canonical bid |
| 352 | 4 | "review and potentially add tests" for all `merged` paths | unfalsifiable | generic test-coverage ask, no path named, file cited as "various test files" |
| 356 | 1 | comment does not say `'x'` is now covered by `MIN_QUERY_TOKEN_LENGTH` | false | the rewritten comment reads "drop one-character folds (incl. the lone collab connector \"x\")"; also not a correctness bug |
| 356 | 2 | dropping one-character tokens may lose essential tokens | unfalsifiable | no example given; Algolia ANDs terms, so removing a token only widens the pool, and the fix asked for is "consider logging" |
| 358 | 1 | log the proposed query/expected target before stripping the attachment | false | the strip branch already logs `{ beerId, query, expected }`, and `review_note` is kept prefixed `unverified:` |
| 358 | 2 | `unverified` is not incremented when verification errors out | false | `verifyCauses`' `catch` does `out.set(beer_id, false)`, so the caller's `verified.get(...)` is falsy and `unverified += 1` runs |
| 358 | 3 | `collectTriageProbes` should halt the run when a probe fails | unfalsifiable | probe evidence is best-effort by design (`// never fail the run`); a design preference, not a defect |
| 358 | 4 | `verifyCauses` ignores results that do not match the expected target | false | the function *is* `resultKeys(await search(query)).has(expected)` |

## Totals

| label | count |
|---|---|
| real | 1 |
| false | 13 |
| unfalsifiable | 4 |

Precision is 1/18 ≈ 6%: of 18 findings, exactly one described a real defect, and 13 are refuted by reading the diff the reviewer was given. The dominant failure mode is not vagueness but confident invention — most `false` findings assert the absence of a guard (`catch`, `WHERE count < ?`, `.has(expected)`, a redirect, a test) that is present, in several cases *added by the very diff under review*. Any replacement must clear 1 true finding per 18 to be an improvement, and the interesting metric is how many of the 13 fabrications it declines to emit.
