# AI review: stop sending test-file bodies — Implementation Plan (stage 1 of #687)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop embedding the full bodies of test files in the AI review context, so the source files they were crowding out are actually shown to the model.

**Architecture:** One exported wrapper, `contextReader`, turns the reviewer's file reader into one that returns `null` for test paths. `buildReviewContext` then lists those paths as diff-only instead of embedding them. The wrapper is applied at **both** call sites (CI and replay) and nowhere else — the gate and verify keep the unfiltered reader, because they need the real bytes to anchor a quote and to adjudicate. A source guard test enforces the "both call sites, only these call sites" rule.

**Tech Stack:** TypeScript, Vitest, `tsx` (scripts run uncompiled).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-22-ai-review-cost-and-context-design.md`

## Global Constraints

- `BODY_EXCLUDE_PATTERNS = ['**/*.test.ts', 'tests/**/*.ts']` — exact value, matched with the existing `matchesAny`/`globToRegExp`.
- Test files stay **reviewable**: their diffs are still sent, and findings inside them are still legal and publishable.
- The exclusion applies to **context assembly only**. `applyGate` and `verifyAll` keep receiving `deps.readFile` unfiltered. Passing the filtered reader to either turns every test-file finding into `quote_not_found` and deletes the class silently.
- No new dependency direction: `context.ts` must not import from `ai-pr-review.ts` (that would be an import cycle).
- Every task runs the **full** gate before its commit: `npm test && npm run typecheck`. Never a scoped run.

---

### Task 1: Exclude test bodies from the assembled context

**Files:**
- Modify: `scripts/ai-pr-review.ts` (add `BODY_EXCLUDE_PATTERNS` and `contextReader` beside `IGNORE_PATTERNS` at line 22; apply at the `buildReviewContext` call around line 373)
- Test: `scripts/ai-pr-review.test.ts`

**Interfaces:**
- Consumes: `matchesAny(path, patterns)` and `filterReviewableFiles(files)`, already exported from `scripts/ai-pr-review.ts`.
- Produces:
  - `export const BODY_EXCLUDE_PATTERNS: string[]`
  - `export function contextReader(readFile: (path: string) => string | null): (path: string) => string | null` — returns `null` for body-excluded paths, otherwise delegates. Task 2 imports this into `replay.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/ai-pr-review.test.ts`, in the block that already imports from `./ai-pr-review` (top of file, line 1):

```typescript
import {
  BODY_EXCLUDE_PATTERNS,
  contextReader,
  filterReviewableFiles,
  globToRegExp,
  matchesAny,
} from './ai-pr-review';

describe('BODY_EXCLUDE_PATTERNS', () => {
  it('excludes test bodies at any depth without touching source that merely contains "test"', () => {
    expect(matchesAny('src/storage/x.test.ts', BODY_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAny('x.test.ts', BODY_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAny('extension/src/a.test.ts', BODY_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAny('tests/b.ts', BODY_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAny('tests/a/b.ts', BODY_EXCLUDE_PATTERNS)).toBe(true);
    expect(matchesAny('src/domain/latest.ts', BODY_EXCLUDE_PATTERNS)).toBe(false);
    expect(matchesAny('src/domain/triage-plan.ts', BODY_EXCLUDE_PATTERNS)).toBe(false);
  });

  it('does NOT remove test files from review scope', () => {
    expect(filterReviewableFiles(['src/a.test.ts'])).toEqual(['src/a.test.ts']);
  });
});

describe('contextReader', () => {
  it('hides a test body and passes every other read through untouched', () => {
    const read = contextReader((p) => `BODY OF ${p}`);
    expect(read('src/a.test.ts')).toBeNull();
    expect(read('tests/helpers.ts')).toBeNull();
    expect(read('src/a.ts')).toBe('BODY OF src/a.ts');
  });

  it('propagates a null from the underlying reader', () => {
    expect(contextReader(() => null)('src/a.ts')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/ai-pr-review.test.ts -t 'BODY_EXCLUDE_PATTERNS'`
Expected: FAIL — `BODY_EXCLUDE_PATTERNS` and `contextReader` are not exported.

- [ ] **Step 3: Implement**

In `scripts/ai-pr-review.ts`, directly after `IGNORE_PATTERNS` (line 22):

```typescript
/**
 * Paths whose BODY is never embedded in the review context — their diff still is,
 * and findings inside them are still legal and publishable.
 *
 * Deliberately not `IGNORE_PATTERNS`: that removes a file from review entirely.
 * This removes only the body, because a test body is the most expensive thing in
 * the context and the least useful. Measured 2026-09-22: test bodies were 41% of
 * the assembled context (687k of 1686k chars over nine PRs), and when the budget
 * binds, churn ordering spends it on them — on PR #670 that demoted 31 SOURCE
 * files to diff-only, on #669 the context held 168k chars of tests against 2k of
 * source. Only 1 of 38 published findings in live reviews targeted a test file,
 * and its quoted line was an ADDED line, present in the diff without the body —
 * which is general, not luck: the gate drops everything `outside_changed_lines`,
 * so a publishable finding always anchors to a line the diff already carries.
 */
export const BODY_EXCLUDE_PATTERNS = ['**/*.test.ts', 'tests/**/*.ts'];

/**
 * Wrap a file reader for CONTEXT ASSEMBLY ONLY.
 *
 * `buildReviewContext` treats `null` as "list this path as diff-only", which is
 * exactly the behaviour we want for a test file.
 *
 * Never hand this to `applyGate` or `verifyAll`. The gate locates the model's
 * verbatim quote in the real file and corrects the line number; verify reads the
 * body to adjudicate. Give either of them this reader and every finding inside a
 * test file becomes `quote_not_found` — the run stays green and a whole class of
 * finding disappears without a trace.
 */
export function contextReader(
  readFile: (path: string) => string | null,
): (path: string) => string | null {
  return (path) => (matchesAny(path, BODY_EXCLUDE_PATTERNS) ? null : readFile(path));
}
```

Then, at the `buildReviewContext` call inside `runReviewOnce` (currently line 373), change only the reader:

```typescript
    const { text: context, diffOnly } = buildReviewContext({
      diff,
      reviewable,
      readFile: contextReader(deps.readFile),
    });
```

Leave the three `fileContent: deps.readFile` sites (the `reconcileFindings` call, the `applyGate` call, and the `verifyAll` call) exactly as they are.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/ai-pr-review.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the separation test — a finding inside a test file must still publish**

This is the regression that would otherwise be invisible. Append to `scripts/ai-pr-review.test.ts`, after the existing `describe('runReview — full mode', …)` block. It reuses the `CFG`, `openaiFetch`, `githubFetch` and `deps` helpers already defined in that file (lines 183–265):

```typescript
describe('runReview — test-file bodies', () => {
  const TEST_FILE = 'src/a.test.ts';
  const TEST_BODY = "it('guards', () => {\n  expect(scan(SRC, SCRIPTS)).toBe(0);\n});\n";
  const TEST_DIFF = [
    `--- a/${TEST_FILE}`,
    `+++ b/${TEST_FILE}`,
    '@@ -1,2 +1,3 @@',
    " it('guards', () => {",
    '+  expect(scan(SRC, SCRIPTS)).toBe(0);',
    ' });',
  ].join('\n');

  const TEST_FINDING = {
    file: TEST_FILE,
    start_line: 2,
    end_line: 2,
    quote: 'expect(scan(SRC, SCRIPTS)).toBe(0);',
    claim: 'the guard test scans a directory that need not exist',
    why_it_breaks: 'readdirSync throws ENOENT before the assertion runs',
    severity: 'P2',
    confidence: 'high',
  };

  function testFileDeps(over = {}) {
    return deps({
      listChangedFiles: () => [TEST_FILE],
      getDiff: () => TEST_DIFF,
      readFile: () => TEST_BODY,
      ...over,
    });
  }

  it('publishes a finding quoting a test file, although its body was never sent', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [TEST_FINDING] }),
      JSON.stringify({
        verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'line 2 calls scan(SRC, SCRIPTS)' }],
      }),
    ]);
    const gh = githubFetch(null);

    await runReview(CFG, testFileDeps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    // The gate must have anchored the quote — which is only possible if it was
    // given the UNFILTERED reader. Filtered, this finding is silently dropped.
    expect(gh.put.body).toContain('the guard test scans a directory that need not exist');
  });

  it('sends the test file as diff-only, so its body never reaches the model', async () => {
    const bodies: string[] = [];
    const capture = (async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
        text: async () => '',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runReview(
      CFG,
      testFileDeps({ openaiFetch: capture, githubFetch: githubFetch(null).fetchFn }),
    );

    const findRequest = bodies[0];
    // The diff still carries the changed line — that is what a finding anchors to.
    expect(findRequest).toContain('+  expect(scan(SRC, SCRIPTS)).toBe(0);');
    // …but the body block (`## <path>` + fence) and its section heading are gone,
    // and the model is told explicitly that it is seeing only a diff for this path.
    expect(findRequest).toContain('Files where you see only the diff');
    expect(findRequest).not.toContain('## src/a.test.ts');
    expect(findRequest).not.toContain('# Full contents of changed files (at HEAD)');
  });
});
```

- [ ] **Step 6: Run the separation test and watch it prove itself**

Run: `npx vitest run scripts/ai-pr-review.test.ts -t 'test-file bodies'`
Expected: PASS.

Now **mutation-prove it**: temporarily change the `applyGate` call in `scripts/ai-pr-review.ts` from `fileContent: deps.readFile` to `fileContent: contextReader(deps.readFile)`, re-run the same command, and confirm the first test FAILS with the claim missing from the body. Revert the mutation and confirm PASS again. A separation test that survives this mutation is not testing anything.

- [ ] **Step 7: Write the budget-binding test**

The spec's central claim is not that the prompt shrinks — it is that when the budget
*binds*, the freed space goes to source. Append to `scripts/ai-review/context.test.ts`:

```typescript
describe('buildReviewContext under a binding budget', () => {
  const BIG_TEST = 'T'.repeat(4000);
  const SRC = 'S'.repeat(400);
  const DIFF_BOTH = [
    '--- a/src/a.test.ts',
    '+++ b/src/a.test.ts',
    '@@ -1,1 +1,4 @@',
    '+t1',
    '+t2',
    '+t3',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    '+s1',
  ].join('\n');

  const read = (p: string) => (p === 'src/a.test.ts' ? BIG_TEST : SRC);
  const args = { diff: DIFF_BOTH, reviewable: ['src/a.test.ts', 'src/a.ts'], budget: 3000 };

  it('spends a binding budget on the test body, demoting the source', () => {
    // The test file has more churn, so churn ordering offers it the budget first.
    const { diffOnly } = buildReviewContext({ ...args, readFile: read });
    expect(diffOnly).toContain('src/a.ts');
  });

  it('gives that budget back to the source once the test body is withheld', () => {
    const { text, diffOnly } = buildReviewContext({
      ...args,
      readFile: (p) => (p === 'src/a.test.ts' ? null : read(p)),
    });
    expect(diffOnly).toEqual(['src/a.test.ts']);
    expect(diffOnly).not.toContain('src/a.ts');
    expect(text).toContain(SRC);
  });
});
```

Run: `npx vitest run scripts/ai-review/context.test.ts -t 'binding budget'`
Expected: PASS — `context.ts` itself is unchanged, so this test documents the behaviour the
whole change depends on and will fail loudly if the ordering or the `null` contract changes.

- [ ] **Step 8: Update `spec.md`**

`spec.md` is the source of truth and must change in the same PR. The rule belongs in
**§5.10 → the `**Контекст:**` bullet** (around line 2251), which currently promises "повний
HEAD-вміст змінених файлів". That promise is now narrower, so amend the first sentence and
append the exception. Change:

> - **Контекст:** `scripts/ai-review/context.ts` шле моделі і діф, і повний HEAD-вміст
>   змінених файлів, у порядку спадання churn…

to:

> - **Контекст:** `scripts/ai-review/context.ts` шле моделі і діф, і повний HEAD-вміст
>   змінених файлів **крім тестових** (`BODY_EXCLUDE_PATTERNS`: `**/*.test.ts`,
>   `tests/**/*.ts`), у порядку спадання churn…

and add at the end of that bullet:

> Тіло тестового файлу не шлеться ніколи: його діф шлеться, знахідки в ньому лишаються
> легальними, і він потрапляє у список «Files where you see only the diff». Причина —
> вимір 2026-09-22: тіла тестів займали 41 % зібраного контексту, а що порядок спадання
> churn ставить тест поперед його ж сорсу, то при впертому бюджеті витіснявся саме
> **вихідний** код (на #670 — 31 файл у diff-only, на #669 контекст містив 168k символів
> тестів проти 2k сорсів). Ціна нульова: з 38 опублікованих зауважень живих рев'ю лише
> одне припадало на тестовий файл, і його цитата була на **доданому** рядку — що не
> випадковість, а наслідок гейта, який відкидає все `outside_changed_lines`, тож будь-яке
> публіковане зауваження анкерується на рядок, який діф і так несе. Виняток діє **лише**
> на збірку контексту: гейт і verify читають справжній файл, інакше кожне зауваження в
> тесті стало б `quote_not_found`.

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add scripts/ai-pr-review.ts scripts/ai-pr-review.test.ts scripts/ai-review/context.test.ts spec.md
git commit -m "fix(ai-review): test bodies no longer crowd source out of the review context (#687)

Test-file bodies were 41% of the assembled context and, because bodies
are ordered by churn, they were spending the budget that the source they
test needed: 31 source files demoted to diff-only on #670, 168k chars of
tests against 2k of source on #669.

Their diffs still go, and a finding inside a test file is still legal:
the gate and verify keep the unfiltered reader, which is the one way
this change can break and is now covered by a mutation-proven test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Keep the replay harness measuring what CI measures

**Files:**
- Modify: `scripts/ai-review/replay.ts` (the `buildReviewContext` call in `main`, around line 156)
- Test: `scripts/ai-pr-review.test.ts` (source guard)

**Interfaces:**
- Consumes: `contextReader` from Task 1, imported from `../ai-pr-review` — `replay.ts` already imports `filterReviewableFiles` from there, so this adds no new dependency direction.
- Produces: nothing new.

**Why this is a separate task:** `replay.ts` is how every model and prompt decision in this project has been measured, including the one that produced this plan. If CI assembles a context that replay does not, the harness silently measures a configuration that never runs — and the protocol in `docs/ai-review-model-evaluation.md` explicitly requires holding the context constant while comparing.

- [ ] **Step 1: Write the failing source guard**

Append to `scripts/ai-pr-review.test.ts`:

```typescript
import { readFileSync } from 'node:fs';

describe('context reader is applied at every call site', () => {
  const CALL_SITES = ['scripts/ai-pr-review.ts', 'scripts/ai-review/replay.ts'];

  it('every buildReviewContext call passes contextReader, and nothing else does', () => {
    for (const file of CALL_SITES) {
      const src = readFileSync(file, 'utf8');
      const calls = src.split('buildReviewContext({').length - 1;
      expect(calls, `${file} should call buildReviewContext`).toBeGreaterThan(0);
      const wrapped = src.split('readFile: contextReader(').length - 1;
      expect(wrapped, `${file} must wrap every buildReviewContext reader`).toBe(calls);
    }

    // The gate and verify must NOT be wrapped: they need the real bytes.
    const reviewer = readFileSync('scripts/ai-pr-review.ts', 'utf8');
    expect(reviewer).toContain('fileContent: deps.readFile');
    expect(reviewer).not.toContain('fileContent: contextReader');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run scripts/ai-pr-review.test.ts -t 'every call site'`
Expected: FAIL — `replay.ts` calls `buildReviewContext` with a bare `readFile`.

- [ ] **Step 3: Implement**

In `scripts/ai-review/replay.ts`, extend the existing import from `../ai-pr-review` (currently lines 17–21) to include `contextReader`:

```typescript
import {
  DEFAULT_FIND_MODEL,
  DEFAULT_VERIFY_MODEL,
  contextReader,
  filterReviewableFiles,
} from '../ai-pr-review';
```

Then change only the reader at the `buildReviewContext` call in `main`:

```typescript
  const { text: context } = buildReviewContext({
    diff,
    reviewable,
    readFile: contextReader(readFile),
  });
```

Leave the `applyGate` and `verifyAll` calls in `main` reading the bare `readFile`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run scripts/ai-pr-review.test.ts -t 'every call site'`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-review/replay.ts scripts/ai-pr-review.test.ts
git commit -m "fix(ai-review): replay assembles the same context CI does (#687)

replay.ts calls buildReviewContext directly, so the body exclusion added
in the previous commit would otherwise apply only to CI — and replay is
how every model and prompt decision here gets measured. A harness that
measures a configuration which never runs is worse than no harness.

A source guard keeps both call sites wrapped and keeps the gate and
verify unwrapped, since that asymmetry is the whole correctness argument.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `replay --head <sha>` so a recall probe stops being a rediscovery

**Files:**
- Modify: `scripts/ai-review/replay.ts` (argument parsing in `main`, currently lines 95–97 and the `head` assignment at line 108)
- Test: `scripts/ai-review/replay.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function resolveReplayArgs(argv: string[]): { pr: string; explicitBase?: string; headOverride?: string }` — a pure helper beside the existing `replayModels` and `resolveReplayBase`.

**Why:** the stock replay always uses `headRefOid`, so it can only replay the *merged* head, where the defects a review found are already fixed. That measures nothing about recall, and it has now cost two investigations: the 2026-07 measurement noted it for #344, and the 2026-09 one repeated it on #418 — whose next commit is literally `fix(#408): close all five findings from the AI review`. Stage 2's recall probe needs this option, so it lands before stage 2, not inside it.

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-review/replay.test.ts`, extending the import on line 1 to
`import { ensureHeadCommit, replayModels, resolveReplayArgs } from './replay';`:

```typescript
describe('resolveReplayArgs', () => {
  it('reads a bare PR number', () => {
    expect(resolveReplayArgs(['418'])).toEqual({ pr: '418' });
  });

  it('keeps the positional base-sha working', () => {
    expect(resolveReplayArgs(['418', 'abc123'])).toEqual({ pr: '418', explicitBase: 'abc123' });
  });

  it('takes --head before or after the positionals without eating them', () => {
    expect(resolveReplayArgs(['418', '--head', 'deadbee'])).toEqual({
      pr: '418',
      headOverride: 'deadbee',
    });
    expect(resolveReplayArgs(['--head', 'deadbee', '418', 'abc123'])).toEqual({
      pr: '418',
      explicitBase: 'abc123',
      headOverride: 'deadbee',
    });
  });

  it('rejects --head with no value rather than silently replaying the merged head', () => {
    expect(() => resolveReplayArgs(['418', '--head'])).toThrow('--head needs a commit sha');
  });

  it('rejects a missing PR number', () => {
    expect(() => resolveReplayArgs([])).toThrow('usage:');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run scripts/ai-review/replay.test.ts -t 'resolveReplayArgs'`
Expected: FAIL — `resolveReplayArgs` is not exported.

- [ ] **Step 3: Implement**

In `scripts/ai-review/replay.ts`, add beside `resolveReplayBase`:

```typescript
/**
 * Replay arguments: `<pr> [base-sha] [--head <sha>]`.
 *
 * `--head` exists for the recall probe. Replaying a PR at its merged head
 * measures nothing about what a config would have FOUND: the findings the live
 * review produced have been fixed by then, which is precisely why they are known
 * to be real. The head the live review saw is in its own state block
 * (`<!-- ai-pr-review-state {"head":…} -->`), or is the commit before the fix.
 */
export function resolveReplayArgs(argv: string[]): {
  pr: string;
  explicitBase?: string;
  headOverride?: string;
} {
  const positional: string[] = [];
  let headOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--head') {
      positional.push(argv[i]);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error('--head needs a commit sha');
    headOverride = value;
    i++;
  }

  const [pr, explicitBase] = positional;
  if (!pr) throw new Error('usage: npm run ai-review-replay -- <pr-number> [base-sha] [--head <sha>]');
  return { pr, ...(explicitBase ? { explicitBase } : {}), ...(headOverride ? { headOverride } : {}) };
}
```

Then replace the first three lines of `main` (currently `const pr = process.argv[2];`, the
`if (!pr) throw …`, and `const explicitBase = process.argv[3];`) with:

```typescript
  const { pr, explicitBase, headOverride } = resolveReplayArgs(process.argv.slice(2));
```

and change the `head` assignment (currently `const head = meta.headRefOid;`) to:

```typescript
  const head = headOverride ?? meta.headRefOid;
```

`ensureHeadCommit` below it is unchanged and still fetches `pull/<pr>/head` when the commit
is not in the clone, which is what an older head needs.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run scripts/ai-review/replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-review/replay.ts scripts/ai-review/replay.test.ts
git commit -m "feat(ai-review): replay --head, so a recall probe is a flag rather than a rediscovery (#687)

Replaying a PR at its merged head cannot measure recall: the findings
that make the PR worth probing have been fixed by then, which is exactly
why they are known to be real. The trap has now cost two investigations
(#344 in 2026-07, #418 in 2026-09).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Price the gpt-5.6 tiers so the footer can still be read

**Files:**
- Modify: `scripts/ai-review/usage.ts` (the `PRICES` table and `PRICES_CHECKED_ON`)
- Test: `scripts/ai-review/usage.test.ts`

**Interfaces:**
- Consumes: nothing. Produces: nothing new — `PRICES` gains entries.

**Why now rather than with stage 2:** an unpriced model prints tokens and no dollars, which is the correct failure but also makes the footer useless for exactly the comparison stage 2 has to make. The table is also two months stale.

- [ ] **Step 1: Write the failing test**

Append to `scripts/ai-review/usage.test.ts`:

```typescript
describe('gpt-5.6 tiers', () => {
  it('prices every tier the reviewer might be pointed at', () => {
    expect(PRICES['gpt-5.6-luna']).toEqual({ input: 0.2, cachedInput: 0.02, output: 1.2 });
    expect(PRICES['gpt-5.6-terra']).toEqual({ input: 2, cachedInput: 0.2, output: 12 });
    expect(PRICES['gpt-5.6-sol']).toEqual({ input: 4, cachedInput: 0.4, output: 20 });
  });

  it('bills a luna find pass at luna rates, not gpt-5.5 rates', () => {
    const usage = {
      calls: 1,
      promptTokens: 1_000_000,
      cachedTokens: 0,
      completionTokens: 100_000,
      reasoningTokens: 90_000,
    };
    expect(costUsd('gpt-5.6-luna', usage)).toBeCloseTo(0.2 + 0.12, 6);
    expect(costUsd('gpt-5.5', usage)).toBeCloseTo(5 + 3, 6);
  });

  it('records when the table was last checked against the vendor page', () => {
    expect(PRICES_CHECKED_ON).toBe('2026-09-22');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run scripts/ai-review/usage.test.ts -t 'gpt-5.6'`
Expected: FAIL — the tiers are absent and `PRICES_CHECKED_ON` is `2026-07-30`.

- [ ] **Step 3: Implement**

In `scripts/ai-review/usage.ts`:

```typescript
export const PRICES: Record<string, Price> = {
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
};

export const PRICES_CHECKED_ON = '2026-09-22';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run scripts/ai-review/usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add scripts/ai-review/usage.ts scripts/ai-review/usage.test.ts
git commit -m "chore(ai-review): price the gpt-5.6 tiers, table checked 2026-09-22 (#687)

An unpriced model prints tokens and no dollars — the right failure, but
it also makes the footer useless for the comparison stage 2 has to make.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the four tasks: end-to-end review

Per the project's staging rule, the periphery (stage 2 — moving `find` to `gpt-5.6-luna`) gets its own plan only **after** an end-to-end review of this core. The review packet is all four tasks above, and the reviewer is asked specifically to check:

1. That no path reaches `applyGate`, `verifyAll` or `reconcileFindings` with a filtered reader — including any path added since this plan was written.
2. That the separation test actually fails under the mutation described in Task 1 Step 6.
3. That `BODY_EXCLUDE_PATTERNS` cannot match a source file, in particular that a file named `latest.ts` or `contest.ts` is unaffected.

## Verification before the PR

- `npm test && npm run typecheck` green.
- `git fetch origin main && git rebase origin/main`, then **re-run the full gate**, then `git push --force-with-lease`.
- On the PR itself, read the AI review's own footer: this change reviews its own implementation, so `Context budget: N file(s) sent as diff only` should name test files and no source file, and `find` input should be visibly smaller than a comparable recent PR.
- `spec.md` §5.10 is updated in Task 1 Step 8 — confirm it is in the PR's diff.
- No `extension/**` files are touched, so `docs/extension-install-uk.md` and `extension/CHANGELOG.md` are out of scope.
- The throwaway scripts under `./tmp/` from the spike are not part of this change and must not appear in the diff (`./tmp/` is gitignored; confirm with `git status --porcelain`).
