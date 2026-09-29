# #742 — incremental AI review scope excludes files merged in from the base

Status: minimal variant approved in chat on 2026-09-29. Issue re-rated to Severity-4 / effort/S after
measurement.

## Defect (verified)

`decideMode` (`scripts/ai-review/incremental.ts`) picks `incremental` whenever the previously
reviewed head is an ancestor of HEAD. It then uses `diffSpec: \`${stored}..HEAD\`` for two things:
- the file list, via `listChangedFiles`;
- the diff shown to the finder, via `getDiff`.

When a PR branch is updated with a **merge** from the base (GitHub's "Update branch"), the old head
stays an ancestor. `stored..HEAD` then contains everything the base gained, and that is **not the
PR's own change**.

PR #741 shows the effect: 2 own files in `src/domain/`, 10 lines. The review after the merge
`51aca4d` had 3 files in scope, `scripts/cross-review/*` from the already-reviewed PR #740, and 0 of
the PR's own. It cost $0.21: find 9.9k→2.5k tokens, verify 2 calls, 3 findings raised and 0
confirmed. The full review of the same PR one push earlier cost $0.03.

## Measured frequency (last 60 PRs, 2026-09-29)

| PR | Merge commits | Effect |
|---|---|---|
| #741 | 1 (Update branch) | **≈ $0.18 wasted**. The only case. |
| #738 | 1 (Update branch) | The merge brought only CI workflow files, which are outside the reviewer's scope. 0 files, $0. |
| #730 | 1 | The merge was the branch's first commit, so it fell inside the full review. |
| #715 | 8 | These were the author's **own** task branches merged into the feature branch. Incremental was correct. |

What follows:
- The harm is pennies, hence Severity-4.
- "A merge means fall back to full" would be wrong. #715's merges are the author's work, so the
  discriminator must be **files the PR itself does not change**, not the presence of a merge.

## Design

In `incremental` mode the reviewer's scope is

```
files(stored..HEAD) ∩ files(origin/<base>...HEAD)
```

This means "changed since the last review" **and** "part of this PR's own diff". A pure function in
`scripts/ai-review/incremental.ts` computes it:

```
incrementalScope(sinceStored: string[], prFiles: string[]): { inScope: string[]; mergedIn: string[] }
```

It preserves the order of `sinceStored`. `mergedIn` holds the files that changed since the stored
head but are not part of the PR, and the runner logs their count in a `::notice::`.

- `ModeDecision` gains `prSpec` (always `origin/<base>...HEAD`). The runner lists the PR's files
  with it **only in incremental mode**. `full` mode is unchanged, because its `diffSpec` already is
  the PR spec.
- `getDiff` keeps using `stored..HEAD`, now restricted to `inScope`. Normal incremental runs are
  therefore identical to today: an author's own new commits touch only files in the PR's diff, so
  the intersection is a no-op.
- An empty intersection with a previous state takes the existing path: "this push changed no
  reviewable file; find pass skipped". Stored findings are still reconciled and re-checked as
  today. For #741 that means a find cost of $0.
- `republish` and `full` are untouched.

### Accepted residual (not handled)

The residual case: a merge from the base touches a file that **the PR also changes**. That file is
in scope, and its `stored..HEAD` diff contains the base's edits as well as the author's. This did
not occur in the 60 measured PRs. It stays a known over-review of one file, never a missed file.
Workaround: update PR branches with rebase, which makes the next run `full` over the PR's own
diff.

## Claims → evidence

| Recorded / relied-on fact | What it claims | Evidence |
|---|---|---|
| A file in `inScope` | the PR changed it and it changed since the last review | membership in both `git diff --name-only` lists, which is pure git with no inference |
| `mergedIn` count in the notice | these files came from the base, not from the PR | changed since the stored head but absent from `origin/<base>...HEAD` |
| "author's commits are unaffected" | for a branch with no merge from the base, `inScope == sinceStored` | replay of #715 and #730 heads (below); every file an author commits on the branch is in the PR's own diff unless the author reverts it to base, and then it is correctly out of scope |
| #741 costs $0 in find | the intersection is empty | replay of `62570a7..51aca4d` (below) |

## Replay (plain git, real heads, 2026-09-29 — done before the plan)

`sinceStored = git diff --name-only <stored>..<head>`, `prFiles = git diff --name-only origin/main...<head>`:

| PR | stored..head | sinceStored | inScope | mergedIn |
|---|---|---|---|---|
| #741 | 62570a7..51aca4d | 6 | **0** | 6 (#740's docs + `scripts/cross-review/*`) |
| #730 | 2f14522..7d9fd6b | 5 | 5 | 0 |
| #730 | 7d9fd6b..d966556 | 3 | 3 | 0 |
| #730 | d966556..1946102 | 15 | 15 | 0 |
| #730 | 1946102..8888d52 | 5 | 5 | 0 |
| #715 | ea5295e..e01b12b | 8 | 8 | 0 |
| #715 | e01b12b..6a09158 | 6 | 6 | 0 |
| #715 | 6a09158..92b4633 | 2 | 2 | 0 |

This confirms both claims. #741's find pass would have been skipped. Every other incremental run,
including those after #715's own task-branch merges, keeps exactly today's scope. (The counts
include files that `filterReviewableFiles` later drops. The logged "3 files in scope" for #741 is
after that filter.)

## Verification

- Unit tests (Vitest) for `incrementalScope`:
  - the #741 file lists give an empty `inScope`, with the 3 `scripts/cross-review/*` files in
    `mergedIn`;
  - an identical list;
  - partial overlap;
  - empty inputs;
  - order is preserved.
- Unit test for `decideMode`: `prSpec` equals `origin/<base>...HEAD` in every mode.
- Runner test (`scripts/ai-pr-review.test.ts`):
  - an incremental run whose `stored..HEAD` files are all outside the PR makes **no** find call;
  - a normal incremental run still diffs `stored..HEAD`.

  The existing test `'diffs from the stored head, not from the base branch'` asserts that *every*
  spec seen is `stored..HEAD`. It is narrowed to `getDiff` and `stored..HEAD` listing, because the
  PR listing is now intentionally the base spec.
- Replay with plain git on the real heads before implementation: #741, #715's last incremental
  pair, and #730's.

## Scope

- `scripts/ai-review/incremental.ts`: `incrementalScope`, and `prSpec` on `ModeDecision`.
- `scripts/ai-pr-review.ts`: in incremental mode, intersect the scope before
  `filterReviewableFiles`, and log the merged-in count.
- The tests above.

No change to the prompts, models, gate, verify or state format.
