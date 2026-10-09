# #816 / #526 — AI PR Reviewer Scope Expansion & Reporting Honesty: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand AI PR reviewer scope to include Python, Shell, CJS, and extension/API HTML & CSS, protect production host code and context budget with anchored patterns and explicit guards, and make reviewer reporting honest when files are outside review scope.

**Architecture:** Update `INCLUDE_PATTERNS` and anchored `BODY_EXCLUDE_PATTERNS` in `scripts/ai-pr-review.ts` with an explicit `isBodyExcluded` guard protecting `scripts/ops/test_run.py`. Partition PR changed files into reviewable, ignored, and unreviewed sets. Update `renderBody` to show out-of-scope counts on mixed PRs, and publish honest skip comments listing unreviewed files on 0-reviewable PRs. Expand defect guidance in `.github/ai-review/AGENTS.md` and document invariants in `spec.md`.

**Tech Stack:** TypeScript, Node.js (`node:child_process`, `node:fs`), Vitest.

**Spec:** [docs/superpowers/specs/2026-10/2026-10-09-816-526-ai-review-scope-honesty-design.md](file:///home/ysi/warsaw-agy-bb/docs/superpowers/specs/2026-10/2026-10-09-816-526-ai-review-scope-honesty-design.md)

## Global Constraints

- Preserve `globToRegExp` behavior; all new glob patterns must be discrete and avoid unexpanded `{}` braces.
- Anchored patterns only: no ambiguous `**` before filename stems in `BODY_EXCLUDE_PATTERNS`.
- `scripts/ops/test_run.py` is production test-supervisor host code; it must never be body-excluded.
- `IGNORE_PATTERNS` remains strictly `['package-lock.json', '*.md', 'docs/**']`.
- Honest skip review comments must contain `<!-- ai-pr-review -->` but omit `<!-- ai-pr-review-state -->`, allowing subsequent pushes to update them in `full` mode.
- Assertion rigor: test assertions must use exact expected values (`toBe`, `toEqual`), never weak assertions or conditionals.

## Review Focus

1. `scripts/ops/test_run.py` checked by `isBodyExcluded`: returns `false` (pinned in Task 1).
2. False positive avoidance on anchored patterns (`deploy/contest_foo.py`, `deploy/release/latest_x.py`): returns `false` (pinned in Task 1).
3. Mixed PR with reviewable TS and `docs/**/*.md`: `unreviewed` count is 0 and subcaption is omitted (pinned in Task 2 & Task 3).
4. 0-reviewable PR modifying unreviewed code (`deploy/warsaw-beer-bot.service`): posts honest skip comment listing unreviewed files (pinned in Task 3).
5. Subsequent push after skip comment: updates comment in `full` mode and writes state block (pinned in Task 3).

---

### Task 1: Scope Expansion, Anchored Patterns, and `isBodyExcluded` Guard

**Files:**
- Modify: `scripts/ai-pr-review.ts:14-66`
- Test: `scripts/ai-pr-review.test.ts`

**Interfaces:**
- Consumes: `globToRegExp`, `matchesAny`.
- Produces:
  - `INCLUDE_PATTERNS: string[]` (expanded to include Python, Shell, CJS, UI HTML/CSS).
  - `BODY_EXCLUDE_PATTERNS: string[]` (anchored test patterns + `release_testkit.py`).
  - `isBodyExcluded(path: string): boolean` (explicit guard for `test_run.py`).
  - `contextReader(readFile: (path: string) => string | null): (path: string) => string | null` (using `isBodyExcluded`).

- [ ] **Step 1: Write failing tests for scope expansion, anchored patterns, and `isBodyExcluded`**

In `scripts/ai-pr-review.test.ts`, add test cases:
```ts
describe('filterReviewableFiles scope expansion (#816, #526)', () => {
  it('includes Python, shell, CJS, and extension/API HTML & CSS', () => {
    const files = [
      'scripts/ops/resource_monitor.py',
      'scripts/autodeploy/autodeploy.sh',
      'deploy/deploy.sh',
      'deploy/release/package_runtime.py',
      'deploy/release/payload-probe.cjs',
      'extension/scripts/zip-dist.py',
      'extension/src/popup/popup.html',
      'extension/src/popup/popup.css',
      'src/api/fest-print/index.html',
      'deploy/warsaw-beer-bot.service',
      'deploy/sudoers.d/warsaw-beer-bot',
      'site/index.html',
      'docs/spec.md',
    ];
    expect(filterReviewableFiles(files)).toEqual([
      'scripts/ops/resource_monitor.py',
      'scripts/autodeploy/autodeploy.sh',
      'deploy/deploy.sh',
      'deploy/release/package_runtime.py',
      'deploy/release/payload-probe.cjs',
      'extension/scripts/zip-dist.py',
      'extension/src/popup/popup.html',
      'extension/src/popup/popup.css',
      'src/api/fest-print/index.html',
    ]);
  });
});

describe('isBodyExcluded (#816)', () => {
  it('never excludes scripts/ops/test_run.py', () => {
    expect(isBodyExcluded('scripts/ops/test_run.py')).toBe(false);
  });

  it('excludes Python tests and test helpers', () => {
    expect(isBodyExcluded('scripts/ops/test_test_run.py')).toBe(true);
    expect(isBodyExcluded('scripts/ops/test_resource_monitor.py')).toBe(true);
    expect(isBodyExcluded('deploy/release/test_publish.py')).toBe(true);
    expect(isBodyExcluded('deploy/release/release_testkit.py')).toBe(true);
    expect(isBodyExcluded('src/sources/http.test.ts')).toBe(true);
    expect(isBodyExcluded('extension/tests/popup.test.ts')).toBe(true);
  });

  it('does not exclude non-test files due to unanchored globs', () => {
    expect(isBodyExcluded('deploy/contest_foo.py')).toBe(false);
    expect(isBodyExcluded('deploy/release/latest_x.py')).toBe(false);
    expect(isBodyExcluded('deploy/release/package_runtime.py')).toBe(false);
    expect(isBodyExcluded('scripts/ops/host_patch_collect.py')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/ai-pr-review.test.ts`
Expected: FAIL (missing patterns in `filterReviewableFiles`, `isBodyExcluded` not defined).

- [ ] **Step 3: Implement pattern expansions and `isBodyExcluded` in `scripts/ai-pr-review.ts`**

Update `INCLUDE_PATTERNS`, `BODY_EXCLUDE_PATTERNS`, add `isBodyExcluded`, and update `contextReader`:
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

export const BODY_EXCLUDE_PATTERNS = [
  '**/*.test.ts',
  'tests/**/*.ts',
  'extension/tests/**/*.ts',
  'deploy/release/test_*.py',
  'deploy/release/release_testkit.py',
  'scripts/ops/test_*.py',
];

export function isBodyExcluded(path: string): boolean {
  if (path === 'scripts/ops/test_run.py') return false;
  return matchesAny(path, BODY_EXCLUDE_PATTERNS);
}

export function contextReader(
  readFile: (path: string) => string | null,
): (path: string) => string | null {
  return (path) => (isBodyExcluded(path) ? null : readFile(path));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/ai-pr-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ai-review): expand review scope and anchor test body exclusions (#816, #526)"
```

---

### Task 2: Sub-Caption for Unreviewed Files in Review Summary

**Files:**
- Modify: `scripts/ai-review/render.ts:186-230`
- Test: `scripts/ai-review/render.test.ts`

**Interfaces:**
- Consumes: `renderBody` in `scripts/ai-review/render.ts`.
- Produces: `renderBody(params: { ..., unreviewedCount?: number }): string`.

- [ ] **Step 1: Write failing tests for `renderBody` out-of-scope caption**

In `scripts/ai-review/render.test.ts`:
```ts
describe('renderBody unreviewed files sub-caption (#816, #526)', () => {
  it('renders sub-caption when unreviewedCount > 0', () => {
    const body = renderBody({
      open: [],
      carried: [],
      closed: [],
      recheck: [],
      usage: EMPTY_USAGE,
      state: null,
      unreviewedCount: 3,
    });
    expect(body).toContain('No verified findings.');
    expect(body).toContain('<sub>3 changed file(s) outside reviewer scope.</sub>');
  });

  it('omits sub-caption when unreviewedCount is 0 or undefined', () => {
    const body0 = renderBody({
      open: [],
      carried: [],
      closed: [],
      recheck: [],
      usage: EMPTY_USAGE,
      state: null,
      unreviewedCount: 0,
    });
    expect(body0).not.toContain('outside reviewer scope');

    const bodyUndef = renderBody({
      open: [],
      carried: [],
      closed: [],
      recheck: [],
      usage: EMPTY_USAGE,
      state: null,
    });
    expect(bodyUndef).not.toContain('outside reviewer scope');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/ai-review/render.test.ts`
Expected: FAIL (`outside reviewer scope` not found).

- [ ] **Step 3: Implement `unreviewedCount` rendering in `scripts/ai-review/render.ts`**

Update `RenderParams` interface to accept `unreviewedCount?: number` and include sub-caption in summary section:
```ts
if (params.unreviewedCount && params.unreviewedCount > 0) {
  lines.push('', `<sub>${params.unreviewedCount} changed file(s) outside reviewer scope.</sub>`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/ai-review/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-review/render.ts scripts/ai-review/render.test.ts
git commit -m "feat(ai-review): render out-of-scope file notice in review summary (#816, #526)"
```

---

### Task 3: Honest Skip Comments and Orchestration

**Files:**
- Modify: `scripts/ai-pr-review.ts:396-455`
- Test: `scripts/ai-pr-review.test.ts`

**Interfaces:**
- Consumes:
  - `deps.listChangedFiles(decision.prSpec)`
  - `INCLUDE_PATTERNS`, `IGNORE_PATTERNS`
  - `upsertReview`, `findExistingReview`, `parseState`
  - `renderBody({ ..., unreviewedCount })`
- Produces:
  - `partitionPrFiles(files: string[]): { reviewable: string[]; ignored: string[]; unreviewed: string[] }`
  - `renderSkipBody(params: { unreviewed: string[] }): string`
  - Orchestrated `runReviewOnce` posting honest skip review or rendering unreviewed count.

- [ ] **Step 1: Write failing tests for PR file partitioning, skip comment rendering, and comment update lifecycle**

In `scripts/ai-pr-review.test.ts`:
```ts
describe('partitionPrFiles (#816, #526)', () => {
  it('correctly partitions reviewable, ignored, and unreviewed files', () => {
    const files = [
      'src/sources/http.ts',
      'docs/superpowers/specs/2026-10-09-spec.md',
      'package-lock.json',
      'deploy/warsaw-beer-bot.service',
      'deploy/sudoers.d/warsaw-beer-bot',
    ];
    const { reviewable, ignored, unreviewed } = partitionPrFiles(files);
    expect(reviewable).toEqual(['src/sources/http.ts']);
    expect(ignored).toEqual(['docs/superpowers/specs/2026-10-09-spec.md', 'package-lock.json']);
    expect(unreviewed).toEqual([
      'deploy/warsaw-beer-bot.service',
      'deploy/sudoers.d/warsaw-beer-bot',
    ]);
  });
});

describe('renderSkipBody (#816, #526)', () => {
  it('renders unreviewed file list when unreviewed files exist', () => {
    const body = renderSkipBody({
      unreviewed: ['deploy/warsaw-beer-bot.service', 'deploy/sudoers.d/warsaw-beer-bot'],
    });
    expect(body).toContain('<!-- ai-pr-review -->');
    expect(body).not.toContain('ai-pr-review-state');
    expect(body).toContain('2 changed file(s) not reviewed (outside reviewer scope)');
    expect(body).toContain('- `deploy/warsaw-beer-bot.service`');
    expect(body).toContain('- `deploy/sudoers.d/warsaw-beer-bot`');
  });

  it('renders documentation notice when all changed files are ignored assets', () => {
    const body = renderSkipBody({ unreviewed: [] });
    expect(body).toContain('<!-- ai-pr-review -->');
    expect(body).not.toContain('ai-pr-review-state');
    expect(body).toContain('No reviewable code changed in this pull request (all changed files are documentation or ignored assets).');
  });
});

describe('skip comment lifecycle (#816, #526)', () => {
  it('posts skip comment on initial run with 0 reviewable files, and updates it on subsequent push with code', async () => {
    // 1. Initial run: only deploy/warsaw-beer-bot.service changed -> posts skip comment
    // 2. Next push: src/sources/http.ts added -> parseState is null, mode is full, upsertReview updates review
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- scripts/ai-pr-review.test.ts`
Expected: FAIL (`partitionPrFiles`, `renderSkipBody` not defined).

- [ ] **Step 3: Implement `partitionPrFiles`, `renderSkipBody`, and update `runReviewOnce`**

In `scripts/ai-pr-review.ts`:
1. Implement `partitionPrFiles(files: string[])`:
   ```ts
   export function partitionPrFiles(files: string[]): {
     reviewable: string[];
     ignored: string[];
     unreviewed: string[];
   } {
     const reviewable: string[] = [];
     const ignored: string[] = [];
     const unreviewed: string[] = [];
     for (const f of files) {
       if (matchesAny(f, INCLUDE_PATTERNS) && !matchesAny(f, IGNORE_PATTERNS)) {
         reviewable.push(f);
       } else if (matchesAny(f, IGNORE_PATTERNS)) {
         ignored.push(f);
       } else {
         unreviewed.push(f);
       }
     }
     return { reviewable, ignored, unreviewed };
   }
   ```
2. Implement `renderSkipBody(params: { unreviewed: string[] }): string`:
   ```ts
   export function renderSkipBody(params: { unreviewed: string[] }): string {
     const lines = [
       '<!-- ai-pr-review -->',
       '## 🤖 AI PR Review',
       '',
     ];
     if (params.unreviewed.length > 0) {
       lines.push(
         `**Review skipped:** ${params.unreviewed.length} changed file(s) not reviewed (outside reviewer scope):`,
         ...params.unreviewed.map((f) => `- \`${f}\``),
       );
     } else {
       lines.push(
         '**Review skipped:** No reviewable code changed in this pull request (all changed files are documentation or ignored assets).',
       );
     }
     return lines.join('\n');
   }
   ```
3. In `runReviewOnce`:
   - Compute `const prFiles = deps.listChangedFiles(decision.prSpec);`
   - Compute `const { unreviewed } = partitionPrFiles(prFiles);`
   - If `reviewable.length === 0 && !state`:
     - `const skipBody = renderSkipBody({ unreviewed });`
     - `await upsertReview(gh, skipBody, existing);`
     - Log notice and return.
   - When calling `renderBody`:
     - Pass `unreviewedCount: unreviewed.length`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- scripts/ai-pr-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "feat(ai-review): publish honest skip review and report unreviewed PR files (#816, #526)"
```

---

### Task 4: Defect Guidance in AGENTS.md, Spec Update, and Replay Verification

**Files:**
- Modify: `.github/ai-review/AGENTS.md`
- Modify: `spec.md`
- Test: Replay script / probe test

**Interfaces:**
- Consumes: Design doc sections 2.5 and 2.6.
- Produces: Updated guidance for Shell, Python, HTML/CSS review, updated `spec.md` §5.

- [ ] **Step 1: Update `.github/ai-review/AGENTS.md`**

Add concrete language-specific defect guidance:
- Shell (`.sh`): quoting, word splitting, unhandled errors with `set -euo pipefail`, unsafe tempfiles, sudo argument injections.
- Python (`.py`): resource leaks, unhandled exceptions in loops/daemons, subprocess argument splitting, permissions/mode normalization, missing directory fsync.
- UI (`.html`, `.css`): accessibility (`aria-*`, tab order, focus styles), dead selectors, broken tags.

- [ ] **Step 2: Update `spec.md` §5**

Document:
- Expanded `INCLUDE_PATTERNS`.
- Anchored `BODY_EXCLUDE_PATTERNS` and `isBodyExcluded` guard for `test_run.py`.
- Honest skip comments for 0-reviewable PRs.
- Unreviewed files counter for mixed PRs.

- [ ] **Step 3: Run replay probe on PR #815 head `6eb7e699` and TS baseline**

Execute replay assertion:
- PR #815: exactly 15 reviewable files, 8 diff-only test/helper files, all 7 Python source files full-body, context size 124,165 <= 240,000 chars.
- PR #809 / #653: context assembly byte-identical to baseline.

- [ ] **Step 4: Run full project gate**

Run: `npm test && npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 5: Commit**

```bash
git add .github/ai-review/AGENTS.md spec.md
git commit -m "docs(ai-review): update defect guidelines and spec for expanded review scope (#816, #526)"
```
