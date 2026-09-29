# #739 Cross-review failure diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three changes to `npm run cross-review`:
- a failing `git` call during preparation, such as a bad `--base`, becomes a usage error;
- a failed run's reason comes from the reviewer CLI's own error line instead of a text search over the whole transcript;
- the marker/report decisions move into tested core.

**Architecture:** All decisions live in pure functions in `scripts/cross-review/core.ts`: `reviewerErrorLine`, `markerReason`, `reportText`, and `classifyResult` over separate stdout/stderr. `scripts/cross-review/cli.ts` only wires the I/O, and it splits preparation (exit 2, no marker) from the run (exit 5, marker).

**Tech Stack:** TypeScript run through `tsx`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-29-739-cross-review-diagnosis-design.md` (amends `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md`)

## Global Constraints

- Error line: for `claude`, the last non-empty line of **stdout**, if it starts with `API Error:`. For `codex`, the last non-empty line of **stderr**, if it starts with `ERROR:`. Only the last non-empty line counts.
- The no-network hint is for claude only. It applies when claude's error line contains `EAI_AGAIN` or `Can't reach the API server`. The reason is `no network — Codex sandbox without the allow rule? see AGENTS.md (<error line>)`.
- Any other error line gives the reason `<reviewer>: <error line with its prefix and following whitespace removed>`. With no error line the reason is `reviewer exited with code N`.
- `markerReason`: the first non-empty line, trimmed, capped at **200** characters in total. When the line is cut, the result is 199 characters plus `…`. Empty input gives `unknown error`.
- Every `PR marker: Cross-review: failed (…)` goes through `markerReason`.
- Preparation `git` failures (`rev-parse` ×3, `diff`, `status`) exit 2 with `cross-review: <markerReason(message)>` and print **no** marker line.
- Exit codes are unchanged: 0 ok · 2 usage · 3 nested · 5 reviewer failed.
- Test rules from CLAUDE.md apply: exact asserts, no conditionals in tests, no tautologies. The probe lines are verbatim fixtures, including the curly apostrophe in `You’ve`. The full gate `npm test && npm run typecheck` runs on every task.

---

### Task 1: Core — error line, marker reason, report source, classification over stdout/stderr

**Files:**
- Modify: `scripts/cross-review/core.ts`
- Modify: `scripts/cross-review/cli.ts` (only the block that calls `classifyResult`, so the gate stays green)
- Test: `scripts/cross-review/core.test.ts`

**Interfaces:**
- Produces:
  - `reviewerErrorLine(reviewer: Reviewer, stdout: string, stderr: string): string | null`
  - `markerReason(text: string): string`
  - `reportText(reviewer: Reviewer, stdout: string, reportFile: string | null): string`
  - `interface RunOutcome { reviewer: Reviewer; exitCode: number | null; timedOut: boolean; spawnError?: string; report: string; stdout: string; stderr: string }`. The `log` field is removed.
  - `classifyResult(r: RunOutcome): Verdict`. The signature is the same and the input is the new `RunOutcome`.

- [ ] **Step 1: Write the failing tests.** In `scripts/cross-review/core.test.ts`:

(a) Add `reviewerErrorLine, markerReason, reportText` to the `import { … } from './core'` line.

(b) Replace the `run` helper with:

```ts
const run = (o: Partial<{ reviewer: 'codex' | 'claude'; exitCode: number | null; timedOut: boolean; spawnError: string; report: string; stdout: string; stderr: string }>) => ({
  reviewer: 'claude' as const, exitCode: 0, timedOut: false, report: '', stdout: '', stderr: '', ...o,
});
```

(c) Delete the two tests `'network failure in the log is named (measured P1 text)'` and `'EAI_AGAIN alone is recognised'`. The whole-transcript search they pinned is removed by the spec.

(d) Append these blocks. Their fixtures are the verbatim probe lines from the spec:

```ts
const CLAUDE_NO_NET = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";
const CODEX_LIMIT = 'ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:20 AM.';
const CODEX_NO_NET_STDERR = [
  '2026-09-29T09:38:47.000090Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out',
  'ERROR: Reconnecting... 5/5',
  'ERROR: workspace routing discovery failed',
  '',
].join('\n');

describe('reviewerErrorLine', () => {
  test('claude reports its fatal error on stdout (measured)', () => {
    expect(reviewerErrorLine('claude', `${CLAUDE_NO_NET}\n`, '')).toBe(CLAUDE_NO_NET);
  });
  test('codex reports its fatal error on stderr (measured: usage limit)', () => {
    expect(reviewerErrorLine('codex', '', `OpenAI Codex v0.158.0\n${CODEX_LIMIT}\n${CODEX_LIMIT}\n`)).toBe(CODEX_LIMIT);
  });
  test('codex without network ends on its own ERROR line (measured)', () => {
    expect(reviewerErrorLine('codex', '', CODEX_NO_NET_STDERR)).toBe('ERROR: workspace routing discovery failed');
  });
  test('an error line in the middle of the transcript is not the error line', () => {
    expect(reviewerErrorLine('claude', `${CLAUDE_NO_NET}\nand then the review went on`, '')).toBeNull();
  });
  test('the right prefix on the wrong stream does not count', () => {
    expect(reviewerErrorLine('codex', CODEX_LIMIT, '')).toBeNull();
  });
  test("claude's prefix is not codex's", () => {
    expect(reviewerErrorLine('codex', '', CLAUDE_NO_NET)).toBeNull();
  });
  test('empty streams have no error line', () => {
    expect(reviewerErrorLine('claude', '', '')).toBeNull();
  });
});

describe('classifyResult — reviewer error lines', () => {
  test('claude without network names the sandbox hint and the line', () => {
    expect(classifyResult(run({ reviewer: 'claude', exitCode: 1, stdout: CLAUDE_NO_NET }))).toEqual({
      kind: 'failed', reason: `no network — Codex sandbox without the allow rule? see AGENTS.md (${CLAUDE_NO_NET})`,
    });
  });
  test('codex usage limit is named as such', () => {
    expect(classifyResult(run({ reviewer: 'codex', exitCode: 1, stderr: `${CODEX_LIMIT}\n` }))).toEqual({
      kind: 'failed',
      reason: 'codex: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:20 AM.',
    });
  });
  test('codex without network gets its own reason, not the claude sandbox hint', () => {
    expect(classifyResult(run({ reviewer: 'codex', exitCode: 1, stderr: CODEX_NO_NET_STDERR }))).toEqual({
      kind: 'failed', reason: 'codex: workspace routing discovery failed',
    });
  });
  test('a codex error line mentioning EAI_AGAIN gets no claude sandbox hint', () => {
    expect(classifyResult(run({ reviewer: 'codex', exitCode: 1, stderr: 'ERROR: getaddrinfo EAI_AGAIN chatgpt.com' }))).toEqual({
      kind: 'failed', reason: 'codex: getaddrinfo EAI_AGAIN chatgpt.com',
    });
  });
  test('a claude API error other than network is named without the hint', () => {
    expect(classifyResult(run({ reviewer: 'claude', exitCode: 1, stdout: 'API Error: 529 Overloaded' }))).toEqual({
      kind: 'failed', reason: 'claude: 529 Overloaded',
    });
  });
  test('EAI_AGAIN quoted mid-transcript by a failing reviewer is not a diagnosis', () => {
    expect(classifyResult(run({ reviewer: 'codex', exitCode: 1, stderr: `exec cat branch.diff\n+ const NO_NETWORK = /EAI_AGAIN/;\nsomething else went wrong` }))).toEqual({
      kind: 'failed', reason: 'reviewer exited with code 1',
    });
  });
  test('an error line on a successful exit is ignored; the result line decides', () => {
    expect(classifyResult(run({ reviewer: 'codex', exitCode: 0, stderr: CODEX_LIMIT, report: 'CROSS-REVIEW-RESULT: 1 finding' }))).toEqual({
      kind: 'ok', findings: 1,
    });
  });
});

describe('markerReason', () => {
  test('a short single line passes through', () => {
    expect(markerReason('reviewer exited with code 1')).toBe('reviewer exited with code 1');
  });
  test('only the first non-empty line, trimmed', () => {
    expect(markerReason('\n  git diff origin/mian...abc failed: fatal: bad revision  \nusage: git diff\n')).toBe('git diff origin/mian...abc failed: fatal: bad revision');
  });
  test('exactly 200 characters is not cut', () => {
    expect(markerReason('a'.repeat(200))).toBe('a'.repeat(200));
  });
  test('201 characters is cut to 199 plus an ellipsis', () => {
    expect(markerReason('a'.repeat(201))).toBe(`${'a'.repeat(199)}…`);
  });
  test('empty input still gives a reason', () => {
    expect(markerReason('  \n\n')).toBe('unknown error');
  });
});

describe('reportText', () => {
  test('claude: the report is its stdout', () => {
    expect(reportText('claude', 'review\nCROSS-REVIEW-RESULT: 0 findings', null)).toBe('review\nCROSS-REVIEW-RESULT: 0 findings');
  });
  test('codex: the report is the -o file, not stdout', () => {
    expect(reportText('codex', 'noise', 'CROSS-REVIEW-RESULT: 2 findings')).toBe('CROSS-REVIEW-RESULT: 2 findings');
  });
  test('codex: a missing -o file is an empty report (then a failure, never zero)', () => {
    expect(reportText('codex', 'noise', null)).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: FAIL. `reviewerErrorLine` / `markerReason` / `reportText` are not functions, and the classify tests fail because the reviewer-line logic does not exist yet.

- [ ] **Step 3: Implement** in `scripts/cross-review/core.ts`.

Delete the line `const NO_NETWORK = /EAI_AGAIN|Can't reach the API server/;` and add in its place:

```ts
// Each CLI reports its own fatal error on one stream, with its own prefix (measured, #739 spec):
// claude → stdout `API Error: …`, codex → stderr `ERROR: …`. Only the LAST non-empty line counts,
// so text quoted mid-transcript (a diff, a command output) can never be the diagnosis.
const ERROR_LINE: Record<Reviewer, { stream: 'stdout' | 'stderr'; prefix: string }> = {
  claude: { stream: 'stdout', prefix: 'API Error:' },
  codex: { stream: 'stderr', prefix: 'ERROR:' },
};
const CLAUDE_NO_NETWORK = /EAI_AGAIN|Can't reach the API server/;
const MARKER_REASON_MAX = 200;

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.length === 0 ? '' : lines[lines.length - 1];
}
```

Replace the `RunOutcome` interface and `classifyResult` with:

```ts
export interface RunOutcome {
  reviewer: Reviewer; exitCode: number | null; timedOut: boolean; spawnError?: string;
  report: string; stdout: string; stderr: string;
}
export type Verdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string };

export function reviewerErrorLine(reviewer: Reviewer, stdout: string, stderr: string): string | null {
  const { stream, prefix } = ERROR_LINE[reviewer];
  const last = lastNonEmptyLine(stream === 'stdout' ? stdout : stderr);
  return last.startsWith(prefix) ? last : null;
}

export function classifyResult(r: RunOutcome): Verdict {
  if (r.timedOut) return { kind: 'failed', reason: 'timeout after 15 min' };
  if (r.spawnError) return { kind: 'failed', reason: `reviewer did not run to completion: ${r.spawnError}` };
  if (r.exitCode !== 0) {
    const line = reviewerErrorLine(r.reviewer, r.stdout, r.stderr);
    if (line === null) return { kind: 'failed', reason: `reviewer exited with code ${r.exitCode}` };
    if (r.reviewer === 'claude' && CLAUDE_NO_NETWORK.test(line)) {
      return { kind: 'failed', reason: `no network — Codex sandbox without the allow rule? see AGENTS.md (${line})` };
    }
    return { kind: 'failed', reason: `${r.reviewer}: ${line.slice(ERROR_LINE[r.reviewer].prefix.length).trim()}` };
  }
  const last = r.report.trimEnd().split('\n').pop() ?? '';
  const m = RESULT_LINE.exec(last);
  if (!m) return { kind: 'failed', reason: 'reviewer output does not end with a CROSS-REVIEW-RESULT line' };
  return { kind: 'ok', findings: Number(m[1]) };
}

// The text inside `PR marker: Cross-review: failed (…)`: one line, bounded (a codex usage-limit line carries URLs).
export function markerReason(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  if (first === '') return 'unknown error';
  return first.length <= MARKER_REASON_MAX ? first : `${first.slice(0, MARKER_REASON_MAX - 1)}…`;
}

// Where each reviewer's report comes from: claude prints it, codex writes it to its -o file.
export function reportText(reviewer: Reviewer, stdout: string, reportFile: string | null): string {
  return reviewer === 'claude' ? stdout : (reportFile ?? '');
}
```

- [ ] **Step 4: Update the one call site in `cli.ts`** so that everything type-checks. Add `reportText, markerReason` to its `./core` import, then replace the block from `const log = ` through the `const verdict = classifyResult(...)` line with:

```ts
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  writeFileSync(paths.log, `${stdout}\n${stderr}${r.error ? `\n${r.error.message}` : ''}`);
  if (command.reportFromStdout) writeFileSync(paths.report, stdout);
  const report = reportText(reviewer, stdout, existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : null);

  const { timedOut, spawnError } = spawnOutcome({
    status: r.status,
    signal: r.signal,
    errorCode: (r.error as NodeJS.ErrnoException | undefined)?.code,
    errorMessage: r.error?.message,
  });
  const verdict = classifyResult({ reviewer, exitCode: r.status, timedOut, spawnError, report, stdout, stderr });
```

Change the failed-verdict marker line to
`console.log(\`PR marker: Cross-review: failed (${markerReason(verdict.reason)})\`);`.

In the `require.main` catch, replace `reason.split('\n')[0]` with `markerReason(reason)`, and change the comment to
`// after preparation: a run was attempted and broke (file write, worktree add) — a failed review`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: all PASS.

- [ ] **Step 6: Mutation checks.** Revert each mutation after you run it.
  - Use the first non-empty line instead of the last in `lastNonEmptyLine`. Then `'an error line in the middle of the transcript is not the error line'` must fail.
  - Drop `r.reviewer === 'claude' &&`. Then `'a codex error line mentioning EAI_AGAIN gets no claude sandbox hint'` must fail.
  - Change `MARKER_REASON_MAX - 1` to `MARKER_REASON_MAX`. Then `'201 characters is cut to 199 plus an ellipsis'` must fail.

- [ ] **Step 7: Full gate.** Run `npm test && npm run typecheck`. Everything must be green.

- [ ] **Step 8: Commit**

```bash
git add scripts/cross-review/core.ts scripts/cross-review/core.test.ts scripts/cross-review/cli.ts
git commit -m "fix(cross-review): diagnose failures from the reviewer's own error line (#739)"
```

---

### Task 2: Runner — preparation is usage, the run goes through core; spec table

**Files:**
- Modify: `scripts/cross-review/cli.ts`
- Modify: `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md` ("Guards and errors" table)

**Interfaces:**
- Consumes: `markerReason` from Task 1, which `cli.ts` already imports after Task 1 Step 4.

- [ ] **Step 1: Preparation phase.** In `cli.ts`, add this function above `main`:

```ts
// Everything read from git before a run exists. A failure here (e.g. `--base origin/mian`) means no
// review was attempted: a usage error, never a `failed` PR marker (#739).
function readRepo(base: string): { root: string; sha: string; branch: string; diff: string; dirty: boolean } {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const sha = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const diff = git(['diff', `${base}...${sha}`]);
  const dirty = git(['status', '--porcelain']).trim() !== '';
  return { root, sha, branch, diff, dirty };
}
```

In `main`, replace the five lines from `const root = git(['rev-parse', '--show-toplevel']).trim();` through `const refusal = preflight(...)` with:

```ts
  let repo: ReturnType<typeof readRepo>;
  try {
    repo = readRepo(base);
  } catch (error) {
    console.error(`cross-review: ${markerReason(error instanceof Error ? error.message : String(error))}`);
    return EXIT.usage;
  }
  const { root, sha, branch, diff } = repo;
  const refusal = preflight({ dirty: repo.dirty, diffBytes: diff.length });
```

- [ ] **Step 2: Spec table.** In `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md` "Guards and errors":
  - Replace the row that begins `| reviewer output contains \`EAI_AGAIN\`` with
    `| reviewer exits non-zero and its own last error line (claude: stdout \`API Error:\`, codex: stderr \`ERROR:\`) is claude's and names \`EAI_AGAIN\` / \`Can't reach the API server\` | exit 5, \`no network — Codex sandbox without the allow rule? see AGENTS.md (<line>)\` (#739) |`.
  - Replace the row that begins `| reviewer exits non-zero |` with
    `| reviewer exits non-zero | exit 5, \`<reviewer>: <its own error line>\` when there is one (e.g. the codex usage limit), else \`reviewer exited with code N\`; the log path is printed (#739) |`.
  - Replace the row that begins `| any other runtime error` with two rows:
    `| a \`git\` call while preparing fails (e.g. a bad \`--base\`) | exit 2, \`cross-review: <message>\`, no PR marker — no review was attempted (#739) |` and
    `| any other runtime error after preparation (a file write, \`worktree add\`) | exit 5, \`PR marker: Cross-review: failed (<reason>)\` |`.
  - Add one sentence under the table: `Every \`failed (…)\` reason is one line of at most 200 characters (#739).`

- [ ] **Step 3: AGENTS.md check.** Its sentence "if it fails with `no network`, the rule was not loaded" still matches the claude-only hint. Confirm it by grep and change nothing.

- [ ] **Step 4: Full gate** — `npm test && npm run typecheck`, all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/cross-review/cli.ts docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md
git commit -m "fix(cross-review): preparation failures are usage errors; markers via markerReason (#739)"
```

- [ ] **Step 6: Live smoke.** The tree must be clean. Record every output verbatim.
  1. Bad base: `npm run cross-review -- --reviewer codex --base origin/mian; echo "exit=$?"` → a `cross-review: git diff origin/mian...` line, npm exit non-zero, and **no** `PR marker` line anywhere in the output.
  2. Claude without network:
     `mkdir -p tmp/ctmp && unshare -rn env CLAUDE_CODE_TMPDIR="$PWD/tmp/ctmp" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' npm run cross-review -- --reviewer claude; echo "exit=$?"`
     (`unshare -r` maps us to uid 0, so git would refuse the repo as "dubious ownership" without `safe.directory`, and claude would refuse `/tmp/claude-0` without its own tmp dir. Both were measured in the spec probe.)
     → `PR marker: Cross-review: failed (no network — Codex sandbox without the allow rule? see AGENTS.md (API Error: Can't reach…` with the reason at most 200 chars. Afterwards `git worktree list` shows no `snapshot`.
  3. Codex, whatever state it is in right now: `npm run cross-review -- --reviewer codex; echo "exit=$?"`. Either exit 0 with a report, or exit 5 with `failed (codex: …)` naming codex's own error (e.g. the usage limit). Record which one you got.
