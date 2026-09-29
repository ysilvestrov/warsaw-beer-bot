# #742 Incremental review scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `incremental` mode, the AI PR reviewer reviews only the files that changed since the last review **and** that the PR itself changes. Files merged in from the base no longer reach the finder.

**Architecture:** A pure `incrementalScope()` in `scripts/ai-review/incremental.ts` intersects two `git diff --name-only` lists. `decideMode` also returns `prSpec` (`origin/<base>...HEAD`). The runner (`scripts/ai-pr-review.ts`) applies the intersection before `filterReviewableFiles`, and only in incremental mode.

**Tech Stack:** TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-29-742-incremental-scope-design.md`

## Global Constraints

- `prSpec` is exactly `` `origin/${baseRef}...HEAD` `` in **every** mode.
- `full` and `republish` behaviour is unchanged, and so are prompts, models, gate, verify and the state format.
- `getDiff` keeps using `decision.diffSpec` (`stored..HEAD` in incremental), restricted to the in-scope files.
- `incrementalScope` preserves the order of `sinceStored`.
- The notice text is exactly: `::notice::AI review: ${n} file(s) changed since the last review are not in this PR's own diff (merged in from the base) — left out of scope.` It is logged only when `n > 0`.
- CLAUDE.md test rules apply: exact asserts, no conditionals, no tautologies. The full gate `npm test && npm run typecheck` runs per task.

---

### Task 1: `incrementalScope` and `prSpec`

**Files:**
- Modify: `scripts/ai-review/incremental.ts`
- Test: `scripts/ai-review/incremental.test.ts`

**Interfaces:**
- Produces:
  - `ModeDecision.prSpec: string`
  - `incrementalScope(sinceStored: string[], prFiles: string[]): { inScope: string[]; mergedIn: string[] }`

- [ ] **Step 1: Write the failing tests.** In `scripts/ai-review/incremental.test.ts`:
  - change the first import line to `import { decideMode, incrementalScope } from './incremental';`
  - add to the `describe('decideMode', …)` block:

```ts
  it('names the PR\'s own diff in every mode, so the runner can scope an incremental pass', () => {
    const specs = [
      decideMode({ state: null, headSha: HEAD, baseRef: 'main', ...deps() }).prSpec,
      decideMode({ state: state({ head: HEAD }), headSha: HEAD, baseRef: 'main', ...deps() }).prSpec,
      decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps({ isAncestor: () => false }) }).prSpec,
      decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps() }).prSpec,
    ];
    expect(specs).toEqual(['origin/main...HEAD', 'origin/main...HEAD', 'origin/main...HEAD', 'origin/main...HEAD']);
  });
```

  - append after the `decideMode` describe block:

```ts
describe('incrementalScope', () => {
  it('drops every file a merge from the base brought in (replay of PR #741, 62570a7..51aca4d)', () => {
    const sinceStored = [
      'docs/superpowers/plans/2026-09/2026-09-29-739-cross-review-diagnosis.md',
      'docs/superpowers/specs/2026-09/2026-09-29-739-cross-review-diagnosis-design.md',
      'docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md',
      'scripts/cross-review/cli.ts',
      'scripts/cross-review/core.test.ts',
      'scripts/cross-review/core.ts',
    ];
    const prFiles = ['src/domain/brewery-aliases.test.ts', 'src/domain/brewery-aliases.ts'];
    expect(incrementalScope(sinceStored, prFiles)).toEqual({ inScope: [], mergedIn: sinceStored });
  });

  it('keeps an ordinary push exactly as it was (author commits touch only PR files)', () => {
    expect(incrementalScope(['src/b.ts', 'src/a.ts'], ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual({
      inScope: ['src/b.ts', 'src/a.ts'],
      mergedIn: [],
    });
  });

  it('splits a mixed push, preserving the order of the since-stored list', () => {
    expect(incrementalScope(['scripts/x.ts', 'src/a.ts', 'docs/y.md', 'src/b.ts'], ['src/b.ts', 'src/a.ts'])).toEqual({
      inScope: ['src/a.ts', 'src/b.ts'],
      mergedIn: ['scripts/x.ts', 'docs/y.md'],
    });
  });

  it('a file reverted back to the base is out of the PR and out of scope', () => {
    expect(incrementalScope(['src/a.ts'], [])).toEqual({ inScope: [], mergedIn: ['src/a.ts'] });
  });

  it('nothing changed since the stored head means nothing in scope', () => {
    expect(incrementalScope([], ['src/a.ts'])).toEqual({ inScope: [], mergedIn: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/ai-review/incremental.test.ts`
Expected: FAIL. `incrementalScope` is not a function, and `prSpec` is `undefined`.

- [ ] **Step 3: Implement** in `scripts/ai-review/incremental.ts`:

In `interface ModeDecision`, add after `diffSpec`:

```ts
  /** The PR's own diff (`origin/<base>...HEAD`), in every mode — what an incremental pass is scoped to. */
  prSpec: string;
```

In `decideMode`, add `prSpec: full` to **each** of the five returned objects. `full` is the existing local `` `origin/${p.baseRef}...HEAD` ``.

Append after `decideMode`:

```ts
/**
 * An incremental pass reviews what changed since the stored head AND belongs to
 * this PR. A merge from the base (GitHub "Update branch") keeps the stored head
 * an ancestor, so `stored..HEAD` also carries everything the base gained — code
 * other PRs already paid to review (#742: PR #741, $0.21 for zero own lines).
 * Author commits are unaffected: every file they touch is in the PR's own diff.
 */
export function incrementalScope(
  sinceStored: string[],
  prFiles: string[],
): { inScope: string[]; mergedIn: string[] } {
  const own = new Set(prFiles);
  return {
    inScope: sinceStored.filter((f) => own.has(f)),
    mergedIn: sinceStored.filter((f) => !own.has(f)),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run scripts/ai-review/incremental.test.ts`
Expected: all PASS.

- [ ] **Step 5: Mutation check.** Change `own.has(f)` in `inScope` to `true`. The #741 replay test must fail. Revert.

- [ ] **Step 6: Full gate.** Run `npm test && npm run typecheck`. Everything must be green.

- [ ] **Step 7: Commit**

```bash
git add scripts/ai-review/incremental.ts scripts/ai-review/incremental.test.ts
git commit -m "feat(ai-review): incrementalScope + prSpec — scope an incremental pass to the PR's own files (#742)"
```

---

### Task 2: Runner applies the scope in incremental mode

**Files:**
- Modify: `scripts/ai-pr-review.ts` (the `const reviewable = …` line in `runReviewOnce`, and the import from `./ai-review/incremental`)
- Test: `scripts/ai-pr-review.test.ts` (the `describe('runReview — incremental mode', …)` block)

**Interfaces:**
- Consumes: `incrementalScope` and `ModeDecision.prSpec` from Task 1.

- [ ] **Step 1: Write the failing tests.** In `scripts/ai-pr-review.test.ts`, inside `describe('runReview — incremental mode', …)`:

(a) Replace the whole test `it('diffs from the stored head, not from the base branch', …)` with:

```ts
  it('diffs from the stored head, and lists the PR\'s own files only to scope that diff', async () => {
    const listed: string[] = [];
    const diffed: string[] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => {
          listed.push(spec);
          return ['src/a.ts'];
        },
        getDiff: (spec) => {
          diffed.push(spec);
          return DIFF;
        },
      }),
    );
    expect(listed).toEqual([`${'a'.repeat(40)}..HEAD`, 'origin/main...HEAD']);
    expect(diffed).toEqual([`${'a'.repeat(40)}..HEAD`]);
  });
```

(b) Add these tests:

```ts
  it('skips the find pass when everything since the stored head was merged in from the base (#742)', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [FINDING] })]);
    const gh = githubFetch(previousState([]));
    const logs: string[] = [];

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        log: (m) => logs.push(m),
        listChangedFiles: (spec) =>
          spec === 'origin/main...HEAD' ? ['src/domain/brewery-aliases.ts'] : ['scripts/cross-review/core.ts', 'scripts/cross-review/cli.ts'],
      }),
    );
    expect(ai.calls).toEqual([]);
    expect(logs).toContain(
      "::notice::AI review: 2 file(s) changed since the last review are not in this PR's own diff (merged in from the base) — left out of scope.",
    );
  });

  it('reviews only the PR\'s own file out of a mixed push', async () => {
    const diffedFiles: string[][] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => (spec === 'origin/main...HEAD' ? ['src/a.ts'] : ['scripts/other.ts', 'src/a.ts']),
        getDiff: (_spec, files) => {
          diffedFiles.push(files);
          return DIFF;
        },
      }),
    );
    expect(diffedFiles).toEqual([['src/a.ts']]);
  });

  it('logs no merged-in notice on an ordinary push', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));
    const logs: string[] = [];

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn, log: (m) => logs.push(m) }));
    expect(logs.filter((l) => l.includes('merged in from the base'))).toEqual([]);
  });
```

(c) In `describe('runReview — full mode', …)`, add:

```ts
  it('lists files once, from the PR diff, and never asks for a second list', async () => {
    const listed: string[] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(null);

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => {
          listed.push(spec);
          return ['src/a.ts'];
        },
      }),
    );
    expect(listed).toEqual(['origin/main...HEAD']);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: FAIL. The new incremental tests fail because `listed` has one entry, `ai.calls` is not empty, and `diffedFiles` includes `scripts/other.ts`. The full-mode test already passes, which is expected: it pins that the change leaves full mode alone.

- [ ] **Step 3: Implement.** In `scripts/ai-pr-review.ts`, change the import from `'./ai-review/incremental'` to also import `incrementalScope`. Replace the line

```ts
  const reviewable = filterReviewableFiles(deps.listChangedFiles(decision.diffSpec));
```

with

```ts
  const sinceDiffSpec = deps.listChangedFiles(decision.diffSpec);
  let changedFiles = sinceDiffSpec;
  if (decision.mode === 'incremental') {
    // A merge from the base keeps the stored head an ancestor, so stored..HEAD also
    // carries what the base gained; review only what this PR itself changes (#742).
    const { inScope, mergedIn } = incrementalScope(sinceDiffSpec, deps.listChangedFiles(decision.prSpec));
    if (mergedIn.length > 0) {
      deps.log(
        `::notice::AI review: ${mergedIn.length} file(s) changed since the last review are not in this PR's own diff (merged in from the base) — left out of scope.`,
      );
    }
    changedFiles = inScope;
  }
  const reviewable = filterReviewableFiles(changedFiles);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run scripts/ai-pr-review.test.ts scripts/ai-review/incremental.test.ts`
Expected: all PASS.

- [ ] **Step 5: Mutation check.** Replace `changedFiles = inScope;` with `changedFiles = sinceDiffSpec;`. The skip-find test and the mixed-push test must fail. Revert.

- [ ] **Step 6: Full gate.** Run `npm test && npm run typecheck`. Everything must be green.

- [ ] **Step 7: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts
git commit -m "fix(ai-review): an incremental pass skips files merged in from the base (#742)"
```
