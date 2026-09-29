# Cross-review between agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run cross-review -- --reviewer codex|claude` runs the *other* local agent as a
read-only reviewer over the branch diff before the PR opens. Both agent files carry the rule
and the PR marker.

**Architecture:** Pure logic (`scripts/cross-review/core.ts`: argument parsing, guards, reviewer
command, prompt rendering, result classification) is kept apart from a thin runner
(`scripts/cross-review/cli.ts`: git calls, `spawnSync` with a timeout, file writes). The
runner writes the diff to `tmp/`. Codex reviews in its `read-only` sandbox, and Claude reviews
under `--restricted` with only Read/Grep/Glob. A repo `.codex/rules` allow rule lets Codex
reach the network for the `claude` direction.

**Tech Stack:** TypeScript run by `tsx`, Vitest, `node:child_process`, and the CLIs
`codex` 0.158 and `claude`.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md`

## Global Constraints

- Exit codes: `0` report written · `2` usage/preflight (unknown reviewer, dirty tree, empty diff) · `3` recursion guard · `5` reviewer failure.
- The recursion guard env var is `CROSS_REVIEW_ACTIVE=1`. The runner sets it in the child env and refuses to start when it is already set.
- The timeout is 15 min (`900_000` ms).
- The reviewer's result line matches exactly `CROSS-REVIEW-RESULT: <n> finding(s)`. If it is missing, the run is a failure and never counts as zero findings.
- Network-failure text is `EAI_AGAIN` or `Can't reach the API server`. It maps to the reason `no network — Codex sandbox without the allow rule? see AGENTS.md`.
- The claude reviewer is invoked with `-p --restricted --strict-mcp-config --tools Read,Grep,Glob --add-dir <tmpDir> [--model m] -- <prompt>`, stdin ignored.
- The codex reviewer is invoked with `exec -s read-only --ephemeral -o <report> [-m m] <prompt>`, stdin ignored.
- Artifacts: `<repo>/tmp/cross-review-<branch with / → ->-<sha7>.{diff,md,log}`.
- PR marker: `Cross-review: <reviewer> @ <sha7> — <n> findings: <f> fixed, <r> rejected`, or `Cross-review: skipped (docs-only)`, or `Cross-review: failed (<reason>)`.
- No curated model list lives in code. No change to the GH AI reviewer or to `spec.md`.
- Test rules from CLAUDE.md apply: exact asserts, no conditionals in tests, no tautologies. The full gate `npm test && npm run typecheck` runs on every task.

---

### Task 1: Pure core — args, guards, result classification

**Files:**
- Create: `scripts/cross-review/core.ts`
- Test: `scripts/cross-review/core.test.ts`
- Modify: `tsconfig.scripts.json` (add `"scripts/cross-review/**/*"` to `include`)

**Interfaces:**
- Produces:
  - `type Reviewer = 'codex' | 'claude'`
  - `interface Options { reviewer: Reviewer; base: string; model?: string }`
  - `parseArgs(argv: string[]): { ok: true; opts: Options } | { ok: false; error: string }`
  - `isNestedRun(env: Record<string, string | undefined>): boolean`
  - `preflight(s: { dirty: boolean; diffBytes: number }): string | null`
  - `interface RunOutcome { exitCode: number | null; timedOut: boolean; report: string; log: string }`
  - `type Verdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string }`
  - `classifyResult(r: RunOutcome): Verdict`
  - `const EXIT = { ok: 0, usage: 2, nested: 3, reviewerFailed: 5 } as const`
  - `const TIMEOUT_MS = 900_000`

- [ ] **Step 1: Write the failing tests** in `scripts/cross-review/core.test.ts`

```ts
import { describe, test, expect } from 'vitest';
import { parseArgs, isNestedRun, preflight, classifyResult } from './core';

describe('parseArgs', () => {
  test('reviewer codex with the default base', () => {
    expect(parseArgs(['--reviewer', 'codex'])).toEqual({ ok: true, opts: { reviewer: 'codex', base: 'origin/main' } });
  });
  test('reviewer claude with explicit base and model', () => {
    expect(parseArgs(['--reviewer', 'claude', '--base', 'origin/dev', '--model', 'claude-opus-5-5'])).toEqual({
      ok: true,
      opts: { reviewer: 'claude', base: 'origin/dev', model: 'claude-opus-5-5' },
    });
  });
  test('missing --reviewer is a usage error, never a default', () => {
    expect(parseArgs([])).toEqual({ ok: false, error: '--reviewer codex|claude is required' });
  });
  test('unknown reviewer is rejected by name', () => {
    expect(parseArgs(['--reviewer', 'gemini'])).toEqual({ ok: false, error: 'unknown reviewer "gemini" (expected codex|claude)' });
  });
  test('a flag without its value is rejected', () => {
    expect(parseArgs(['--reviewer', 'codex', '--base'])).toEqual({ ok: false, error: '--base needs a value' });
  });
  test('an unknown flag is rejected', () => {
    expect(parseArgs(['--reviewer', 'codex', '--fast'])).toEqual({ ok: false, error: 'unknown argument "--fast"' });
  });
});

describe('isNestedRun', () => {
  test('set to 1 means a reviewer is calling a reviewer', () => {
    expect(isNestedRun({ CROSS_REVIEW_ACTIVE: '1' })).toBe(true);
  });
  test('absent means a top-level run', () => {
    expect(isNestedRun({})).toBe(false);
  });
  test('any other value is not the guard', () => {
    expect(isNestedRun({ CROSS_REVIEW_ACTIVE: '0' })).toBe(false);
  });
});

describe('preflight', () => {
  test('clean tree with a diff passes', () => {
    expect(preflight({ dirty: false, diffBytes: 120 })).toBeNull();
  });
  test('dirty tree is refused: the marker names a SHA', () => {
    expect(preflight({ dirty: true, diffBytes: 120 })).toBe('working tree is dirty — commit first; the review is pinned to a SHA');
  });
  test('empty diff is refused', () => {
    expect(preflight({ dirty: false, diffBytes: 0 })).toBe('empty diff against the base — nothing to review');
  });
  test('dirty wins over empty (the first thing to fix)', () => {
    expect(preflight({ dirty: true, diffBytes: 0 })).toBe('working tree is dirty — commit first; the review is pinned to a SHA');
  });
});

const run = (o: Partial<{ exitCode: number | null; timedOut: boolean; report: string; log: string }>) => ({
  exitCode: 0, timedOut: false, report: '', log: '', ...o,
});

describe('classifyResult', () => {
  test('zero findings only from the explicit line', () => {
    expect(classifyResult(run({ report: 'looked at everything\nCROSS-REVIEW-RESULT: 0 findings\n' }))).toEqual({ kind: 'ok', findings: 0 });
  });
  test('singular form is accepted', () => {
    expect(classifyResult(run({ report: '1. bug\nCROSS-REVIEW-RESULT: 1 finding' }))).toEqual({ kind: 'ok', findings: 1 });
  });
  test('the last result line wins when the prompt is quoted back', () => {
    expect(classifyResult(run({ report: 'CROSS-REVIEW-RESULT: 0 findings\n...\nCROSS-REVIEW-RESULT: 3 findings' }))).toEqual({ kind: 'ok', findings: 3 });
  });
  test('empty output is a failure, never zero findings', () => {
    expect(classifyResult(run({ report: '' }))).toEqual({ kind: 'failed', reason: 'reviewer output has no CROSS-REVIEW-RESULT line' });
  });
  test('output without the result line is a failure', () => {
    expect(classifyResult(run({ report: 'Looks good to me!' }))).toEqual({ kind: 'failed', reason: 'reviewer output has no CROSS-REVIEW-RESULT line' });
  });
  test('timeout beats everything else', () => {
    expect(classifyResult(run({ timedOut: true, exitCode: null, report: 'CROSS-REVIEW-RESULT: 0 findings' }))).toEqual({ kind: 'failed', reason: 'timeout after 15 min' });
  });
  test('network failure in the log is named (measured P1 text)', () => {
    expect(classifyResult(run({ exitCode: 1, log: "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)" }))).toEqual({
      kind: 'failed', reason: 'no network — Codex sandbox without the allow rule? see AGENTS.md',
    });
  });
  test('EAI_AGAIN alone is recognised', () => {
    expect(classifyResult(run({ exitCode: 1, report: 'getaddrinfo EAI_AGAIN api.anthropic.com' }))).toEqual({
      kind: 'failed', reason: 'no network — Codex sandbox without the allow rule? see AGENTS.md',
    });
  });
  test('non-zero exit fails even with a result line', () => {
    expect(classifyResult(run({ exitCode: 2, report: 'CROSS-REVIEW-RESULT: 0 findings' }))).toEqual({ kind: 'failed', reason: 'reviewer exited with code 2' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: FAIL, `Failed to resolve import "./core"`.

- [ ] **Step 3: Implement** `scripts/cross-review/core.ts`

```ts
// Pure logic of `npm run cross-review` (spec: docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md).
// The runner (cli.ts) does the I/O; everything that decides lives here so it can be tested.

export type Reviewer = 'codex' | 'claude';
export interface Options { reviewer: Reviewer; base: string; model?: string }

export const EXIT = { ok: 0, usage: 2, nested: 3, reviewerFailed: 5 } as const;
export const TIMEOUT_MS = 900_000;
const RESULT_LINE = /^CROSS-REVIEW-RESULT: (\d+) findings?\s*$/gm;
const NO_NETWORK = /EAI_AGAIN|Can't reach the API server/;

export function parseArgs(argv: string[]): { ok: true; opts: Options } | { ok: false; error: string } {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--reviewer' && flag !== '--base' && flag !== '--model') {
      return { ok: false, error: `unknown argument "${flag}"` };
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { ok: false, error: `${flag} needs a value` };
    values[flag] = value;
    i++;
  }
  const reviewer = values['--reviewer'];
  if (reviewer === undefined) return { ok: false, error: '--reviewer codex|claude is required' };
  if (reviewer !== 'codex' && reviewer !== 'claude') {
    return { ok: false, error: `unknown reviewer "${reviewer}" (expected codex|claude)` };
  }
  const opts: Options = { reviewer, base: values['--base'] ?? 'origin/main' };
  if (values['--model'] !== undefined) opts.model = values['--model'];
  return { ok: true, opts };
}

export function isNestedRun(env: Record<string, string | undefined>): boolean {
  return env.CROSS_REVIEW_ACTIVE === '1';
}

export function preflight(s: { dirty: boolean; diffBytes: number }): string | null {
  if (s.dirty) return 'working tree is dirty — commit first; the review is pinned to a SHA';
  if (s.diffBytes === 0) return 'empty diff against the base — nothing to review';
  return null;
}

export interface RunOutcome { exitCode: number | null; timedOut: boolean; report: string; log: string }
export type Verdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string };

export function classifyResult(r: RunOutcome): Verdict {
  if (r.timedOut) return { kind: 'failed', reason: 'timeout after 15 min' };
  if (NO_NETWORK.test(r.log) || NO_NETWORK.test(r.report)) {
    return { kind: 'failed', reason: 'no network — Codex sandbox without the allow rule? see AGENTS.md' };
  }
  if (r.exitCode !== 0) return { kind: 'failed', reason: `reviewer exited with code ${r.exitCode}` };
  const matches = [...r.report.matchAll(RESULT_LINE)];
  if (matches.length === 0) return { kind: 'failed', reason: 'reviewer output has no CROSS-REVIEW-RESULT line' };
  return { kind: 'ok', findings: Number(matches[matches.length - 1][1]) };
}
```

Add `"scripts/cross-review/**/*"` as a new entry at the end of the `include` array in
`tsconfig.scripts.json`, with a one-line comment above it:
`// cross-review: the pre-PR reviewer between local agents (2026-09-29).`

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: PASS (22 tests).

- [ ] **Step 5: Mutation-check two guards.** Temporarily change `env.CROSS_REVIEW_ACTIVE === '1'` to `!== undefined`, and confirm that `any other value is not the guard` fails. Then remove the `if (r.exitCode !== 0)` line and confirm that `non-zero exit fails even with a result line` fails. Revert both.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add scripts/cross-review/core.ts scripts/cross-review/core.test.ts tsconfig.scripts.json
git commit -m "feat(cross-review): pure core — args, guards, result classification"
```

---

### Task 2: Reviewer command, prompt template, artifact paths

**Files:**
- Modify: `scripts/cross-review/core.ts`
- Create: `scripts/cross-review/prompt.md`
- Test: `scripts/cross-review/core.test.ts` (append)

**Interfaces:**
- Consumes: `Reviewer`, `Options` from Task 1.
- Produces:
  - `artifactPaths(tmpDir: string, branch: string, sha: string): { diff: string; report: string; log: string }`
  - `renderPrompt(template: string, vars: { base: string; sha: string; branch: string; diffPath: string }): string`, which throws `Error('unfilled placeholder {{x}}')` when a `{{…}}` is left over
  - `interface ReviewerCommand { cmd: string; args: string[]; reportFromStdout: boolean }`
  - `buildReviewerCommand(p: { reviewer: Reviewer; model?: string; prompt: string; reportPath: string; tmpDir: string }): ReviewerCommand`

- [ ] **Step 1: Append failing tests** to `scripts/cross-review/core.test.ts`. Extend the existing import line to
`import { parseArgs, isNestedRun, preflight, classifyResult, artifactPaths, renderPrompt, buildReviewerCommand } from './core';`,
add `import { readFileSync } from 'node:fs';` and `import { join } from 'node:path';` below it
(`import.meta` would fail `tsc -p tsconfig.scripts.json`, which compiles as CommonJS, while
`__dirname` works in both Vitest and tsc), then add:

```ts
describe('artifactPaths', () => {
  test('slashes in the branch become dashes; sha is cut to 7', () => {
    expect(artifactPaths('/r/tmp', 'feat/cross-review', '0123456789abcdef')).toEqual({
      diff: '/r/tmp/cross-review-feat-cross-review-0123456.diff',
      report: '/r/tmp/cross-review-feat-cross-review-0123456.md',
      log: '/r/tmp/cross-review-feat-cross-review-0123456.log',
    });
  });
});

describe('renderPrompt', () => {
  test('fills every placeholder, repeated ones included', () => {
    expect(renderPrompt('{{branch}}@{{sha}} vs {{base}}: {{diffPath}} ({{sha}})', {
      base: 'origin/main', sha: 'abc1234', branch: 'b', diffPath: '/t/d.diff',
    })).toBe('b@abc1234 vs origin/main: /t/d.diff (abc1234)');
  });
  test('an unknown placeholder is an error, not silent text', () => {
    expect(() => renderPrompt('{{spec}}', { base: 'x', sha: 'y', branch: 'z', diffPath: 'w' })).toThrow('unfilled placeholder {{spec}}');
  });
});

describe('buildReviewerCommand', () => {
  const base = { prompt: 'P', reportPath: '/t/r.md', tmpDir: '/t' };
  test('codex: read-only sandbox, report via -o', () => {
    expect(buildReviewerCommand({ ...base, reviewer: 'codex' })).toEqual({
      cmd: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/r.md', 'P'],
      reportFromStdout: false,
    });
  });
  test('codex: model passes through as -m', () => {
    expect(buildReviewerCommand({ ...base, reviewer: 'codex', model: 'gpt-5.5' }).args).toEqual(
      ['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/r.md', '-m', 'gpt-5.5', 'P'],
    );
  });
  test('claude: restricted, read-only tool set, tmp dir readable, prompt after --', () => {
    expect(buildReviewerCommand({ ...base, reviewer: 'claude' })).toEqual({
      cmd: 'claude',
      args: ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', '/t', '--', 'P'],
      reportFromStdout: true,
    });
  });
  test('claude: model passes through before --', () => {
    expect(buildReviewerCommand({ ...base, reviewer: 'claude', model: 'claude-sonnet-5-5' }).args).toEqual(
      ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', '/t', '--model', 'claude-sonnet-5-5', '--', 'P'],
    );
  });
});

describe('prompt.md template', () => {
  test('renders with the runner variables and demands the result line', () => {
    const tpl = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
    const out = renderPrompt(tpl, { base: 'origin/main', sha: 'abc1234', branch: 'feat/x', diffPath: '/t/x.diff' });
    expect(out.includes('/t/x.diff')).toBe(true);
    expect(out.includes('CROSS-REVIEW-RESULT: <n> findings')).toBe(true);
  });
});
```

(`toBe(true)` on `includes` is exact here: the test asserts that one specific string is
present, and the rest of the prose is free to change.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: FAIL, because `artifactPaths`, `renderPrompt` and `buildReviewerCommand` are not exported.

- [ ] **Step 3: Implement.** Append to `scripts/cross-review/core.ts`:

```ts
export function artifactPaths(tmpDir: string, branch: string, sha: string): { diff: string; report: string; log: string } {
  const stem = `${tmpDir}/cross-review-${branch.replace(/\//g, '-')}-${sha.slice(0, 7)}`;
  return { diff: `${stem}.diff`, report: `${stem}.md`, log: `${stem}.log` };
}

export function renderPrompt(
  template: string,
  vars: { base: string; sha: string; branch: string; diffPath: string },
): string {
  const table: Record<string, string> = vars;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in table)) throw new Error(`unfilled placeholder {{${key}}}`);
    return table[key];
  });
}

export interface ReviewerCommand { cmd: string; args: string[]; reportFromStdout: boolean }

// Read-only is enforced by the tool, not requested of the model (spec, probes P2/P3):
// codex by its sandbox; claude by --restricted (ignores settings allow rules) and a tool set with no writer.
export function buildReviewerCommand(p: {
  reviewer: Reviewer; model?: string; prompt: string; reportPath: string; tmpDir: string;
}): ReviewerCommand {
  if (p.reviewer === 'codex') {
    return {
      cmd: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '-o', p.reportPath, ...(p.model ? ['-m', p.model] : []), p.prompt],
      reportFromStdout: false,
    };
  }
  return {
    cmd: 'claude',
    args: ['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--add-dir', p.tmpDir,
      ...(p.model ? ['--model', p.model] : []), '--', p.prompt],
    reportFromStdout: true,
  };
}
```

Create `scripts/cross-review/prompt.md`:

```markdown
You are reviewing a branch of the warsaw-beer-bot repository before its pull request opens.
You are read-only: do not try to change any file. Your report is read by the author, who will
verify each finding before acting on it.

Branch: {{branch}} at {{sha}}, compared with {{base}}.
The full diff is in the file {{diffPath}}. Read it first. You may open any file in the
repository for context. In particular, read the branch's own spec and plan under
docs/superpowers/specs/ and docs/superpowers/plans/ (the files this diff adds or touches), the
root spec.md where the change touches bot behaviour, and the Testing bullet in CLAUDE.md.

Report only:
1. Correctness defects: give file:line and a concrete failure scenario (input/state → wrong output or crash).
2. Divergence from the branch's spec/plan or from spec.md.
3. Violations of the Testing rules in CLAUDE.md: weak assertions, conditional test logic,
   tautological tests, missing boundary/error cases, expected values computed by re-implementing
   production logic.
4. Claim→evidence gaps: places where the code records something as fact (a state row, cursor,
   cache, verdict, marker) that the code does not actually prove.

Do not report style, naming, or formatting preferences. Do not report something you have not
checked in the code: quote the line you are talking about. If you are unsure, say so in the finding.

Format: a numbered list, one finding per item, most severe first. Then, as the very last line
of your answer, exactly:
CROSS-REVIEW-RESULT: <n> findings
where <n> is the number of findings (0 if none).
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run scripts/cross-review/core.test.ts`
Expected: PASS (30 tests).

- [ ] **Step 5: Mutation-check.** Delete `'--restricted'` from the claude args and confirm that
the `claude: restricted…` test fails. Then change `'read-only'` to `'workspace-write'` and confirm
that the `codex: read-only…` test fails. Revert both.

- [ ] **Step 6: Full gate** — `npm test && npm run typecheck`, all green.

- [ ] **Step 7: Commit**

```bash
git add scripts/cross-review/core.ts scripts/cross-review/core.test.ts scripts/cross-review/prompt.md
git commit -m "feat(cross-review): reviewer commands, prompt template, artifact paths"
```

---

### Task 3: Runner, npm entry, Codex allow rule, live smoke

**Files:**
- Create: `scripts/cross-review/cli.ts`
- Modify: `package.json` (`scripts`: add `"cross-review": "tsx scripts/cross-review/cli.ts"` next to `"verify-corpus"`)
- Modify: `.codex/rules/default.rules` (append the rule)

**Interfaces:**
- Consumes: everything that Tasks 1–2 export from `./core`.
- Produces: the npm command `npm run cross-review -- --reviewer codex|claude [--base b] [--model m]` with the exit codes listed in Global Constraints.

The runner is I/O glue with no decisions of its own, so its test is the live smoke in Step 4.
Every branch in it calls a function that Tasks 1–2 already test.

- [ ] **Step 1: Implement** `scripts/cross-review/cli.ts`

```ts
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT, TIMEOUT_MS, parseArgs, isNestedRun, preflight, classifyResult,
  artifactPaths, renderPrompt, buildReviewerCommand,
} from './core';

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function main(argv: string[]): number {
  if (isNestedRun(process.env)) {
    console.error('cross-review: refusing to run inside a cross-review (CROSS_REVIEW_ACTIVE=1)');
    return EXIT.nested;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`cross-review: ${parsed.error}\nUsage: npm run cross-review -- --reviewer codex|claude [--base origin/main] [--model <id>]`);
    return EXIT.usage;
  }
  const { reviewer, base, model } = parsed.opts;

  const root = git(['rev-parse', '--show-toplevel']).trim();
  const sha = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const diff = git(['diff', `${base}...HEAD`]);
  const refusal = preflight({ dirty: git(['status', '--porcelain']).trim() !== '', diffBytes: diff.length });
  if (refusal) {
    console.error(`cross-review: ${refusal}`);
    return EXIT.usage;
  }

  const tmpDir = join(root, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const paths = artifactPaths(tmpDir, branch, sha);
  writeFileSync(paths.diff, diff);
  const template = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
  const prompt = renderPrompt(template, { base, sha: sha.slice(0, 7), branch, diffPath: paths.diff });
  const command = buildReviewerCommand({ reviewer, model, prompt, reportPath: paths.report, tmpDir });

  writeFileSync(paths.report, ''); // a stale report from an earlier run at this SHA must not survive a failed one
  console.error(`cross-review: ${reviewer} reviewing ${branch} @ ${sha.slice(0, 7)} vs ${base} (up to 15 min)…`);
  const r = spawnSync(command.cmd, command.args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CROSS_REVIEW_ACTIVE: '1' },
  });
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  writeFileSync(paths.log, log);
  if (command.reportFromStdout) writeFileSync(paths.report, r.stdout ?? '');
  const report = existsSync(paths.report) ? readFileSync(paths.report, 'utf8') : '';

  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const verdict = classifyResult({ exitCode: r.status, timedOut, report, log });
  if (verdict.kind === 'failed') {
    console.error(`cross-review: FAILED — ${verdict.reason}. Log: ${paths.log}`);
    console.log(`PR marker: Cross-review: failed (${verdict.reason})`);
    return EXIT.reviewerFailed;
  }
  console.log(`cross-review: ${reviewer} @ ${sha.slice(0, 7)} — ${verdict.findings} finding(s). Report: ${paths.report}`);
  console.log(`PR marker: Cross-review: ${reviewer} @ ${sha.slice(0, 7)} — ${verdict.findings} findings: <f> fixed, <r> rejected`);
  return EXIT.ok;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`cross-review: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT.usage;
  }
}
```

Add to `package.json` `scripts`: `"cross-review": "tsx scripts/cross-review/cli.ts",`

Append to `.codex/rules/default.rules`:

```
# cross-review: Codex calls Claude as a read-only reviewer before the PR. The call
# needs network, which the sandbox denies; probe P1 (2026-09-29) proved this rule grants it.
prefix_rule(
    pattern = ["npm", "run", "cross-review"],
    decision = "allow",
    justification = "Pre-PR cross-review by the other agent (docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md)"
)
```

- [ ] **Step 2: Full gate** — `npm test && npm run typecheck`, all green.

- [ ] **Step 3: Commit** (the tree must be clean before the smoke, because the runner refuses a dirty one)

```bash
git add scripts/cross-review/cli.ts package.json .codex/rules/default.rules
git commit -m "feat(cross-review): runner, npm entry, Codex allow rule"
```

- [ ] **Step 4: Live smoke — record every output in the task report.**
  1. Guard: `CROSS_REVIEW_ACTIVE=1 npm run cross-review -- --reviewer codex; echo $?` → the stderr line `refusing to run inside a cross-review` and npm's exit, non-zero.
  2. Usage: `npm run cross-review; echo $?` → `--reviewer codex|claude is required`.
  3. Dirty: `touch tmp-dirty-probe && npm run cross-review -- --reviewer codex; rm tmp-dirty-probe` → `working tree is dirty`.
  4. Claude → Codex, for real on this branch: `npm run cross-review -- --reviewer codex` → exit 0, a report with a `CROSS-REVIEW-RESULT` line, and `git status --short` empty afterwards.
  5. Codex → Claude, for real (P1 on the real script): `codex exec --ephemeral "Run exactly: npm run cross-review -- --reviewer claude — and report its stdout verbatim" < /dev/null` → the stdout contains `PR marker: Cross-review: claude @`, and `git status --short` is empty.

  If step 5 fails with the `no network` reason, stop and report: the P1 premise did not hold on
  the real script.

---

### Task 4: The rule in both agent files

**Files:**
- Modify: `CLAUDE.md` (new bullet directly after the `**PR створюється за замовчуванням…**` bullet if PR #734 is merged by then, otherwise directly before `**Перед відкриттям PR`)
- Modify: `AGENTS.md` (the `Pull Requests` section, a new sub-block after the rebase bullets)

**Interfaces:**
- Consumes: the npm command and the PR marker format from Task 3 / Global Constraints.

- [ ] **Step 1: CLAUDE.md** — insert this bullet:

```markdown
- **Перехресне рев'ю іншим агентом перед PR** (дизайн: `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md`): коли рішення готове — гейт зелений, рібейс зроблено — і PR ось-ось відкриється, запусти `npm run cross-review -- --reviewer codex`. Codex рев'юїть diff гілки проти `origin/main` у read-only пісочниці; звіт — у `tmp/cross-review-<гілка>-<sha>.md`. **Кожну** знахідку перевір як коментар GH-рев'ю — виправ або відхили з причиною, ніколи не застосовуй наосліп; виправлення комітяться, гейт проганяється наново. Опис PR несе маркер `Cross-review: codex @ <sha> — <n> findings: <f> fixed, <r> rejected` (скрипт друкує заготовку). Раз на PR, не на кожен коміт і не після фіксів у відкритому PR. PR лише з документами — `Cross-review: skipped (docs-only)`. Збій рецензента (exit 5) PR не блокує — маркер `Cross-review: failed (<причина>)`, гейтом лишається GH-рев'ю. Мета — менше раундів «пуш → коментар → фікс» на GH, де кожен раунд платний, а локальні агенти — на підписці. Маркер — самозвіт і нічого не вмикає: він лише дає порахувати ефект.
```

- [ ] **Step 2: AGENTS.md** — in `Pull Requests`, after the bullet that begins `- if \`git fetch\` fails with`, insert:

```markdown
- **before creating the PR, have Claude cross-review the branch**: once the solution is ready (gate green, rebase done), run `npm run cross-review -- --reviewer claude`. Claude reviews the branch diff against `origin/main` read-only (`--restricted`, Read/Grep/Glob only); the report lands in `tmp/cross-review-<branch>-<sha>.md`. The repo's `.codex/rules/default.rules` allows this command, so it reaches the network without a manual approval; if it fails with `no network`, the rule was not loaded — ask the user to approve the escalation. Verify **each** finding like a GH review comment: fix it or reject it with a reason, never apply findings blindly; commit fixes and re-run the gate. The PR body carries the marker `Cross-review: claude @ <sha> — <n> findings: <f> fixed, <r> rejected` (the script prints a template). Once per PR — not per commit, not after fixes to an open PR. A docs-only PR says `Cross-review: skipped (docs-only)`. A reviewer failure (exit 5) does not block the PR: the marker says `Cross-review: failed (<reason>)` and the GH review remains the gate. Why: every push to a PR runs the paid GH AI reviewer; local agents run on flat subscriptions, so catching a finding before the PR saves a paid round. The marker is self-reported and gates nothing — it exists to count the effect later. Design: `docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md`.
```

- [ ] **Step 3: Check both files say the same thing.** Confirm that the command, the reviewer
name (the *other* agent), the marker format, docs-only skipping, and failure not blocking
appear in both files.

- [ ] **Step 4: Full gate** — `npm test && npm run typecheck`, all green.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: cross-review by the other agent before every code PR"
```

---

## After the tasks

Rebase onto `origin/main` (with PR #734 merged, move the CLAUDE.md bullet next to the
PR-by-default one), run the gate again, run `npm run cross-review -- --reviewer codex` on the
finished branch (this branch dogfoods itself), handle its findings, and open the PR with the
marker.
