# #816 / #526 — AI PR Reviewer Scope Expansion & Reporting Honesty: Design

**Date:** 2026-10-09  
**Status:** draft (revised after review)  
**Issues:** #816, #526  
**Severity:** Severity-3, effort/M  

---

## 1. Problem Statement

The AI PR reviewer (`scripts/ai-pr-review.ts`) orchestrates automated code review in CI. Currently, `INCLUDE_PATTERNS` (lines 14–20) matches only:
- `src/**/*.ts`
- `tests/**/*.ts`
- `scripts/**/*.ts`
- `extension/**/*.ts`
- `.github/workflows/*.yml`

Every other file type is completely invisible to the reviewer. This creates three distinct failures:

1. **Security & System Code Blindness (#816):**
   - High-privilege code running as root or managing production secrets in `deploy/` (`deploy.sh`, `autodeploy.sh`, `install-*.sh`, `db-snapshot.sh`), `deploy/release/*.py` (artifact packaging, manifest verification, payload validation), and `scripts/ops/*.py` (host patch collection, reboot requests, resource monitoring) is never reviewed.
   - In PR #815 (artifact deployment Ядро-2а), ~1,500 lines of Python deployment logic were changed. The reviewer saw only 1 file (`scripts/deploy-rsync.test.ts`), sent it diff-only, consumed 2.6k tokens, and posted `No verified findings`.
   - Meanwhile, manual review of the same head (`6eb7e699`) uncovered two defects (P1 permissive mode acceptance, P2 missing fsync before receipt). A clean green check on an unreviewed pull request is a silent tool failure.

2. **UI Blindness (#526):**
   - Markup and styling in `extension/src/**/*.{html,css}` and live API UI (`src/api/fest-print/index.html`) is ignored.
   - In PR #525 (popup restyle), changes included DOM reordering that changed tab navigation order, `aria-describedby` wiring, and `:focus-visible` styles. Because `.html` and `.css` were not in `INCLUDE_PATTERNS`, the review job skipped entirely.

3. **Deceptive Review Output (#526, #816):**
   - When all changed files in a PR are out of review scope (e.g. systemd units, sudoers, or docs), the CI job logs a notice and exits 0 with no review posted, leaving a green tick that implies code was verified clean.
   - When a PR modifies both in-scope and out-of-scope code (e.g. TS changes alongside unreviewed `deploy/*.service`), "No verified findings" is published with no indication that code files were completely excluded from examination.

---

## 2. Decisions & Scope

### Decision 1: Scope Expansion (`INCLUDE_PATTERNS`)
Following user decisions **1Б** (scripts/code only, excluding sudoers and unit files), **2Б** (extension UI only, excluding `site/`), and the explicit inclusion of live API UI (`src/api/fest-print/index.html`):

Expand `INCLUDE_PATTERNS` in `scripts/ai-pr-review.ts`:
```ts
export const INCLUDE_PATTERNS = [
  'src/**/*.ts',
  'src/api/**/*.html',
  'tests/**/*.ts',
  'scripts/**/*.ts',
  'scripts/**/*.py',
  'scripts/**/*.sh',
  'deploy/**/*.py',
  'deploy/**/*.sh',
  'deploy/**/*.cjs',
  'extension/**/*.ts',
  'extension/**/*.py',
  'extension/src/**/*.html',
  'extension/src/**/*.css',
  '.github/workflows/*.yml',
];
```

*Notes on glob syntax & scope:*
- `globToRegExp()` in `scripts/ai-pr-review.ts` escapes `{` and `}` as literals and does not support brace expansion. Each pattern is declared as a discrete glob.
- `extension/**/*.py` currently covers `extension/scripts/zip-dist.py`.
- `site/` remains completely excluded (static landing/marketing assets, decision 2Б).
- `deploy/*.service`, `deploy/*.timer`, `deploy/*.path`, configs, and `deploy/sudoers.d/*` remain excluded from automated review (decision 1Б).

### Decision 2: Ignore Patterns (`IGNORE_PATTERNS`)
`IGNORE_PATTERNS` remains unchanged:
```ts
export const IGNORE_PATTERNS = ['package-lock.json', '*.md', 'docs/**'];
```

*Evidence on fixtures:* A live probe over `git ls-files` across all fixture paths (`extension/tests/fixtures/**`, `scripts/autodeploy/fixtures/**`, `scripts/ops/fixtures/**`, `tests/fixtures/**`, `src/**/__fixtures__/**`) confirmed that zero fixture files match any pattern in `INCLUDE_PATTERNS` (fixtures are `.json`, `.html` outside `extension/src` or `src/api`, `.gpg`, `.conf`, `.txt`, `.csv`, `.zip`). Adding unanchored `**/fixtures/**` would introduce regex flaws (matching `src/myfixtures/...`) without providing value. Consciously ignored files remain strictly documentation and dependency locks.

### Decision 3: Context Budget Protection & Path Anchoring (`BODY_EXCLUDE_PATTERNS`)
The find-pass context has a strict budget of 240,000 characters (`CONTEXT_BUDGET`). Test bodies must not crowd out production code in churn ordering.

#### A. Anchored Patterns
`globToRegExp` compiles `**` as `.*` with no directory-boundary anchoring. Unanchored patterns like `deploy/**/test_*.py` compile to `^deploy\/.*test_[^/]*\.py$`, which erroneously matches `deploy/contest_foo.py` or `deploy/release/latest_x.py`.
Therefore, test body exclusions are strictly path-anchored without ambiguous wildcards:
```ts
export const BODY_EXCLUDE_PATTERNS = [
  '**/*.test.ts',
  'tests/**/*.ts',
  'extension/tests/**/*.ts',
  'deploy/release/test_*.py',
  'deploy/release/release_testkit.py',
  'scripts/ops/test_*.py',
];
```
- `deploy/release/release_testkit.py` is explicitly included: it is a test helper (measured: 1,899 chars), so its body is suppressed to save budget.

#### B. Explicit Protection for `scripts/ops/test_run.py`
`scripts/ops/test_run.py` is the test supervisor invoked by `npm test` and deployed to host via `install-resource-monitor.sh`. It is **production host code**, not a test.
Because its filename begins with `test_`, pattern `scripts/ops/test_*.py` matches it.
To prevent production code from being silently hidden from review context, `isBodyExcluded(path)` explicitly guards `test_run.py`:

```ts
export function isBodyExcluded(path: string): boolean {
  if (path === 'scripts/ops/test_run.py') return false;
  return matchesAny(path, BODY_EXCLUDE_PATTERNS);
}
```

Tests explicitly verify:
- `isBodyExcluded('scripts/ops/test_run.py') === false`
- `isBodyExcluded('scripts/ops/test_test_run.py') === true`
- `isBodyExcluded('deploy/contest_foo.py') === false`
- `isBodyExcluded('deploy/release/latest_x.py') === false`

### Decision 4: Honest Review Reporting (Decision 3А)

Files changed across the PR (`decision.prSpec`) are partitioned into three distinct groups:
1. `reviewable`: matched `INCLUDE_PATTERNS` and not in `IGNORE_PATTERNS`.
2. `ignored`: matched `IGNORE_PATTERNS` (docs, markdown, package-lock).
3. `unreviewed`: neither in `INCLUDE_PATTERNS` nor in `IGNORE_PATTERNS` (code/configs outside review scope, e.g. `deploy/*.service`, `sudoers`, `site/*`).

#### 1. PR with 0 reviewable files (`reviewable.length === 0` and no previous `state`):
Instead of exiting silently with a misleading green checkmark, post an explicit review comment via `upsertReview`:
- **If `unreviewed.length > 0` (unreviewed code/configs present):**
  ```markdown
  <!-- ai-pr-review -->
  ## 🤖 AI PR Review

  **Review skipped:** ${unreviewed.length} changed file(s) not reviewed (outside reviewer scope):
  - `deploy/warsaw-beer-bot.service`
  - `deploy/sudoers.d/warsaw-beer-bot`
  ```
- **If `unreviewed.length === 0` (only documentation / ignored assets changed):**
  ```markdown
  <!-- ai-pr-review -->
  ## 🤖 AI PR Review

  **Review skipped:** No reviewable code changed in this pull request (all changed files are documentation or ignored assets).
  ```

*Comment State & Subsequent Pushes:*
The skip comment contains `<!-- ai-pr-review -->` so `findExistingReview` finds it, but does **not** contain `<!-- ai-pr-review-state ... -->`.
When a subsequent push adds reviewable code:
- `parseState(existing?.body)` returns `null`.
- `decideMode` selects `mode: 'full'`.
- `upsertReview` updates the existing skip comment via `PUT /reviews/${id}` with the full review findings and writes the new state block.
This lifecycle is verified by unit tests.

#### 2. PR with mixed files (`reviewable.length > 0`):
- Calculate `unreviewed` files from `decision.prSpec` (measuring the whole PR, not merely the latest push in incremental mode).
- Do not count `ignored` docs/markdown files, avoiding false noise on every PR with a spec or plan.
- Pass `unreviewedCount` into `renderBody`.
- In `assemble()` (`scripts/ai-review/render.ts`):
  When `unreviewedCount > 0`, include a sub-caption in the summary:
  `<sub>${unreviewedCount} changed file(s) outside reviewer scope.</sub>`

### Decision 5: Reviewer Prompt Guidance (`.github/ai-review/AGENTS.md`)
Update `.github/ai-review/AGENTS.md` to provide concrete defect guidance for non-TS languages:
- **Shell (`.sh`)**: Quoting errors, word splitting, unchecked command failures, broken `set -euo pipefail` pipelines, sudo/root path injection, unsafe temporary file handling, signal traps.
- **Python (`.py`)**: Resource/descriptor leaks, unhandled exceptions in daemon or ops loops, subprocess injection/argument splitting, file permission/mode normalization errors, missing `fsync` on critical files/directories.
- **UI (`.html`, `.css`)**: Accessibility regressions (broken `aria-*` associations, missing labels, keyboard navigation/focus trap issues), dead/unreachable selectors, invalid markup.

### Decision 6: Specification Update (`spec.md`)
Update §5 in `spec.md` to document the new `INCLUDE_PATTERNS`, `BODY_EXCLUDE_PATTERNS`, `isBodyExcluded` guard, and honest reporting invariants.

---

## 3. Claims and Their Evidence

| Claim | What records it as fact | Evidence proving it |
| :--- | :--- | :--- |
| `deploy/` and `scripts/ops/` code was previously completely ignored by AI review | `scripts/ai-pr-review.ts:14-20` (`INCLUDE_PATTERNS`) | Git review state on PR #815 (commit `6eb7e699`): 14 Python deploy files excluded; only `deploy-rsync.test.ts` was reviewed. |
| `scripts/ops/test_run.py` is production code that would be masked by `test_*.py` | `package.json:7`, `install-resource-monitor.sh` | File is the test supervisor invoked by `npm test`. Probe confirmed `scripts/ops/test_*.py` matches `test_run.py`. |
| Unanchored `deploy/**/test_*.py` matches non-test files | `globToRegExp` compilation | `globToRegExp('deploy/**/test_*.py').test('deploy/contest_foo.py') === true` and `test('deploy/release/latest_x.py') === true`. |
| Zero fixtures match `INCLUDE_PATTERNS` | `git ls-files` probe across repository | Probe across 35 fixture files showed 0 matched `INCLUDE_PATTERNS`. |
| Excluding Python test bodies preserves context budget for deploy code | Probe on PR #815 head `6eb7e699` | Measured: 7 test files = 52,980 chars. 7 source files = 46,184 chars. Total context = 124,165 / 240,000 chars. Zero source files demoted to diff-only. |
| Existing TS PRs are not starved by new pattern logic | Probe on PR #809 / #653 | Context assembly on TS changes is byte-identical; 0 source files demoted. |
| Skip comment without state transitions to full review on next push | `decideMode` and `findExistingReview` | `parseState(skipComment) === null` triggers `mode: 'full'`; `upsertReview` updates existing review ID. |

---

## 4. Verification & Cost Plan

### 1. Cost & Token Impact Assessment
- **Find Phase:**
  - Incumbent find model (`gpt-5.6-sol` / $2.50 per 1M input, $10 per 1M output).
  - On deploy PR #815: context increases from 2.7k chars (~700 tokens) to 124k chars (~31k tokens).
  - Find input cost increases by ~30k tokens = **+$0.075 per run**.
- **Verify Phase:**
  - Verify model is invoked once per candidate finding passing the gate.
  - On a typical deploy change raising 2–4 candidate findings: 2–4 verify calls @ ~3k tokens each = ~10k tokens = **+$0.05–$0.12**.
  - Total incremental cost on a large deploy PR: **~$0.15–$0.25** (previously $0.01 for blind pass).
  - For project budget ($20–40/month), ~10 PRs/month with deploy code costs ~$2.00/month, well within budget.

### 2. Context Budget & Churn Replay
- Replay on PR #815 (`6eb7e699`):
  - Assert `reviewable` has 15 files.
  - Assert 8 test/helper files in `diffOnly`.
  - Assert all 7 source Python files included with full body.
  - Assert assembled context size <= 240,000 chars (measured: 124,165).
- Replay on PR #809 (`00fcf7a`):
  - Assert context assembly unchanged; zero source files demoted.

### 3. Unit Tests
- `scripts/ai-pr-review.test.ts`:
  - `filterReviewableFiles`: includes Python, shell, CJS, extension HTML/CSS, `src/api/**/*.html`; excludes `deploy/*.service`, `deploy/sudoers.d/*`, `site/*`.
  - `isBodyExcluded`: returns `false` for `scripts/ops/test_run.py`, `deploy/contest_foo.py`, `deploy/release/latest_x.py`; returns `true` for `scripts/ops/test_*.py`, `deploy/release/test_*.py`, `deploy/release/release_testkit.py`.
  - Skip review posting: posts honest comment when 0 files in scope; distinguishes unreviewed code from ignored docs.
  - Subsequent push transition: skip comment without state updates cleanly to full review.
- `scripts/ai-review/render.test.ts`:
  - `renderBody`: renders sub-caption when `unreviewedCount > 0`; omits sub-caption when only reviewable or ignored files changed.

### 4. Full Project Gate
- `npm test` and `npm run typecheck` passing cleanly.
