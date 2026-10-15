# Spec owner summary + spec cross-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 1–3 carry their complete code and are small by the CLAUDE.md sizing rule: the controller implements them inline (change, full gate, commit) and names them in the whole-branch review.

**Goal:** New architectural specs open with an owner section and carry the owner's and the author's size estimates; before the owner reads a spec, the other agent reviews it with `npm run cross-review -- --spec <file>` (codex for Claude's specs, claude for Codex's).

**Architecture:** `--spec` is a second mode of the existing `scripts/cross-review` runner. Pure decisions (argument rules, spec path rule, spec preflight, run-dir prefix, marker line) go into `core.ts` with tests. `cli.ts` only branches the I/O: no diff in spec mode, a different prompt template (`prompt-spec.md`). The format rules live in `docs/spec-format.md`, referenced from `CLAUDE.md` and `AGENTS.md`.

**Tech Stack:** TypeScript run through `tsx`, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-15-spec-owner-summary-design.md`

## Global Constraints

- Exit codes are unchanged: 0 ok · 2 usage · 3 nested · 5 reviewer failed.
- `--spec` together with `--base` → exit 2, error `--spec and --base cannot be combined: a spec review has no base`.
- Spec path: backslashes become `/`, a leading `./` is dropped, then it must match `^docs/superpowers/specs/\d{4}-\d{2}/[^/]+\.md$`; otherwise exit 2.
- Spec mode preflight: dirty tree → the existing dirty message; spec not in `HEAD`'s tree → `the spec is not committed at HEAD — commit it first; the review is pinned to a SHA`. Dirty wins. The empty-diff check does not apply.
- Run dir in spec mode: `tmp/cross-review-spec-<reviewer>-<branch>-<sha7>-XXXXXX/`. Diff mode prefix is unchanged.
- Marker lines: diff mode `PR marker: Cross-review: <body>` (unchanged text); spec mode `Spec marker: Spec-review: <body>`.
- Test rules from CLAUDE.md apply: exact asserts, no conditionals, no tautologies, boundaries and errors covered. The full gate `npm test && npm run typecheck` runs on every task.
- `spec.md` is not changed: this is the development process, not bot behaviour.

---

### Task 1: Core — `--spec` argument, spec path rule, spec preflight, run-dir prefix, marker line

**Files:**
- Modify: `scripts/cross-review/core.ts`
- Modify: `scripts/cross-review/cli.ts` (only the `runDirPrefix` call, so the gate stays green)
- Test: `scripts/cross-review/core.test.ts`

**Interfaces:**
- Produces:
  - `type Mode = 'diff' | 'spec'`
  - `interface Options { reviewer: Reviewer; base: string; model?: string; spec?: string }`
  - `normalizeSpecPath(p: string): string`
  - `specPathError(p: string): string | null`
  - `specPreflight(s: { dirty: boolean; inHead: boolean }): string | null`
  - `runDirPrefix(tmpDir, reviewer, branch, sha, mode: Mode): string` (new required last parameter)
  - `markerLine(mode: Mode, body: string): string`
  - `renderPrompt(template: string, vars: Record<string, string>): string` (vars widened from the fixed diff-mode shape)

- [ ] **Step 1: Write the failing tests.** In `scripts/cross-review/core.test.ts`:

(a) Extend the import line:

```ts
import { parseArgs, isNestedRun, preflight, specPreflight, normalizeSpecPath, specPathError, markerLine, classifyResult, reviewerErrorLine, markerReason, reportText, spawnOutcome, runDirPrefix, runArtifacts, renderPrompt, buildReviewerCommand } from './core';
```

(b) Inside `describe('parseArgs', …)` append:

```ts
  test('--spec is carried as given; base keeps its default', () => {
    expect(parseArgs(['--reviewer', 'codex', '--spec', 'docs/superpowers/specs/2026-10/x-design.md'])).toEqual({
      ok: true,
      opts: { reviewer: 'codex', base: 'origin/main', spec: 'docs/superpowers/specs/2026-10/x-design.md' },
    });
  });
  test('--spec with --base is a usage error: a spec review has no base', () => {
    expect(parseArgs(['--reviewer', 'claude', '--spec', 'a.md', '--base', 'origin/main'])).toEqual({
      ok: false, error: '--spec and --base cannot be combined: a spec review has no base',
    });
  });
  test('--spec without its value is rejected', () => {
    expect(parseArgs(['--reviewer', 'codex', '--spec'])).toEqual({ ok: false, error: '--spec needs a value' });
  });
```

(c) Replace `describe('runDirPrefix', …)` with:

```ts
describe('runDirPrefix', () => {
  test('diff mode: reviewer, branch with slashes as dashes, sha cut to 7, open for the mkdtemp suffix', () => {
    expect(runDirPrefix('/r/tmp', 'codex', 'feat/cross-review', '0123456789abcdef', 'diff')).toBe('/r/tmp/cross-review-codex-feat-cross-review-0123456-');
  });
  test('spec mode is told apart by its own prefix', () => {
    expect(runDirPrefix('/r/tmp', 'claude', 'main', '0123456789abcdef', 'spec')).toBe('/r/tmp/cross-review-spec-claude-main-0123456-');
  });
});
```

(d) Append:

```ts
describe('normalizeSpecPath', () => {
  test('Windows separators become forward slashes', () => {
    expect(normalizeSpecPath('docs\\superpowers\\specs\\2026-10\\x-design.md')).toBe('docs/superpowers/specs/2026-10/x-design.md');
  });
  test('a leading ./ is dropped', () => {
    expect(normalizeSpecPath('./docs/superpowers/specs/2026-10/x-design.md')).toBe('docs/superpowers/specs/2026-10/x-design.md');
  });
  test('a plain repo-relative path is unchanged', () => {
    expect(normalizeSpecPath('docs/superpowers/specs/2026-10/x-design.md')).toBe('docs/superpowers/specs/2026-10/x-design.md');
  });
});

describe('specPathError', () => {
  test('a markdown file in a month folder passes', () => {
    expect(specPathError('docs/superpowers/specs/2026-10/2026-10-15-x-design.md')).toBeNull();
  });
  test('a file at the top of specs/ is refused: specs live in month folders', () => {
    expect(specPathError('docs/superpowers/specs/x-design.md')).toBe('--spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/, got "docs/superpowers/specs/x-design.md"');
  });
  test('a plan is not a spec', () => {
    expect(specPathError('docs/superpowers/plans/2026-10/x.md')).toBe('--spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/, got "docs/superpowers/plans/2026-10/x.md"');
  });
  test('a nested folder under the month is refused', () => {
    expect(specPathError('docs/superpowers/specs/2026-10/a/x.md')).toBe('--spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/, got "docs/superpowers/specs/2026-10/a/x.md"');
  });
  test('a non-markdown file is refused', () => {
    expect(specPathError('docs/superpowers/specs/2026-10/x.txt')).toBe('--spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/, got "docs/superpowers/specs/2026-10/x.txt"');
  });
  test('an empty path is refused', () => {
    expect(specPathError('')).toBe('--spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/, got ""');
  });
});

describe('specPreflight', () => {
  test('clean tree with the spec committed passes', () => {
    expect(specPreflight({ dirty: false, inHead: true })).toBeNull();
  });
  test('a spec missing from HEAD is refused', () => {
    expect(specPreflight({ dirty: false, inHead: false })).toBe('the spec is not committed at HEAD — commit it first; the review is pinned to a SHA');
  });
  test('dirty wins over a missing spec (the first thing to fix)', () => {
    expect(specPreflight({ dirty: true, inHead: false })).toBe('working tree is dirty — commit first; the review is pinned to a SHA');
  });
});

describe('markerLine', () => {
  test('diff mode keeps the PR marker text', () => {
    expect(markerLine('diff', 'codex @ abc1234 — 2 findings: <f> fixed, <r> rejected')).toBe('PR marker: Cross-review: codex @ abc1234 — 2 findings: <f> fixed, <r> rejected');
  });
  test('spec mode prints the Spec-review header line', () => {
    expect(markerLine('spec', 'failed (timeout after 15 min)')).toBe('Spec marker: Spec-review: failed (timeout after 15 min)');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail.** `npx vitest run scripts/cross-review/core.test.ts` — expected FAIL: the new imports are not exported, and `runDirPrefix` has no mode.

- [ ] **Step 3: Implement.** In `scripts/cross-review/core.ts`:

(a) Replace the `Options` line with:

```ts
export type Mode = 'diff' | 'spec';
export interface Options { reviewer: Reviewer; base: string; model?: string; spec?: string }
```

(b) Below `const MARKER_REASON_MAX = 200;` add:

```ts
const FLAGS = ['--reviewer', '--base', '--model', '--spec'];
const DIRTY = 'working tree is dirty — commit first; the review is pinned to a SHA';
const SPEC_PATH = /^docs\/superpowers\/specs\/\d{4}-\d{2}\/[^/]+\.md$/;
```

(c) In `parseArgs`, replace the flag check with `if (!FLAGS.includes(flag)) {`, and replace everything from `const opts: Options = …` to the end of the function with:

```ts
  if (values['--spec'] !== undefined && values['--base'] !== undefined) {
    return { ok: false, error: '--spec and --base cannot be combined: a spec review has no base' };
  }
  const opts: Options = { reviewer, base: values['--base'] ?? 'origin/main' };
  if (values['--model'] !== undefined) opts.model = values['--model'];
  if (values['--spec'] !== undefined) opts.spec = values['--spec'];
  return { ok: true, opts };
```

(d) In `preflight`, replace the dirty message literal with `DIRTY`. Below `preflight` add:

```ts
// A spec review reads one committed file, so the path is normalised (a Windows shell passes
// backslashes) and must name a spec in a month folder; anything else is a usage error.
export function normalizeSpecPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function specPathError(p: string): string | null {
  return SPEC_PATH.test(p) ? null : `--spec must name a .md file under docs/superpowers/specs/<YYYY-MM>/, got "${p}"`;
}

export function specPreflight(s: { dirty: boolean; inHead: boolean }): string | null {
  if (s.dirty) return DIRTY;
  if (!s.inHead) return 'the spec is not committed at HEAD — commit it first; the review is pinned to a SHA';
  return null;
}
```

(e) Replace `runDirPrefix` with:

```ts
export function runDirPrefix(tmpDir: string, reviewer: Reviewer, branch: string, sha: string, mode: Mode): string {
  const kind = mode === 'spec' ? 'spec-' : '';
  return `${tmpDir}/cross-review-${kind}${reviewer}-${branch.replace(/\//g, '-')}-${sha.slice(0, 7)}-`;
}

// Where the author pastes the result: a PR body (diff mode) or the spec's own header (spec mode).
export function markerLine(mode: Mode, body: string): string {
  return mode === 'spec' ? `Spec marker: Spec-review: ${body}` : `PR marker: Cross-review: ${body}`;
}
```

(f) In `renderPrompt`, change the parameter type `vars: { base: string; sha: string; branch: string; diffPath: string }` to `vars: Record<string, string>`, and the line `const table: Record<string, string> = vars;` to `const table = vars;`.

(g) In `scripts/cross-review/cli.ts`, change the `runDirPrefix(tmpDir, reviewer, branch, sha)` call to `runDirPrefix(tmpDir, reviewer, branch, sha, 'diff')`.

- [ ] **Step 4: Full gate.** `npm test && npm run typecheck` — expected PASS.

- [ ] **Step 5: Commit.** `git commit -am "cross-review: core rules for --spec (path, preflight, run dir, marker)"`

---

### Task 2: Runner — spec mode in `cli.ts`, `prompt-spec.md`

**Files:**
- Modify: `scripts/cross-review/cli.ts`
- Create: `scripts/cross-review/prompt-spec.md`
- Test: `scripts/cross-review/core.test.ts` (template test only)

- [ ] **Step 1: Write the failing test.** Append to `scripts/cross-review/core.test.ts`:

```ts
describe('prompt-spec.md template', () => {
  test('renders with the spec-mode variables, points at the format doc, demands the result line', () => {
    const tpl = readFileSync(join(__dirname, 'prompt-spec.md'), 'utf8');
    const out = renderPrompt(tpl, { sha: 'abc1234', branch: 'main', specPath: 'docs/superpowers/specs/2026-10/x-design.md' });
    expect(out.includes('docs/superpowers/specs/2026-10/x-design.md')).toBe(true);
    expect(out.includes('docs/spec-format.md')).toBe(true);
    expect(out.includes('CROSS-REVIEW-RESULT: <n> findings')).toBe(true);
  });
  test('a diff-mode variable set does not fill it', () => {
    const tpl = readFileSync(join(__dirname, 'prompt-spec.md'), 'utf8');
    expect(() => renderPrompt(tpl, { base: 'origin/main', sha: 'abc1234', branch: 'main', diffPath: '/t/x.diff' })).toThrow('unfilled placeholder {{specPath}}');
  });
});
```

- [ ] **Step 2: Run it and see it fail.** `npx vitest run scripts/cross-review/core.test.ts` — expected FAIL: `ENOENT … prompt-spec.md`.

- [ ] **Step 3: Create `scripts/cross-review/prompt-spec.md`:**

```markdown
You are reviewing a design spec of the warsaw-beer-bot repository before its owner reads it.
You are read-only: do not try to change any file. Your report is read by the spec's author, who
will verify each finding and fix it or reject it with a reason before the owner approves the spec.

Spec: {{specPath}} on branch {{branch}} at {{sha}}.
Read, in this order: docs/spec-format.md (the format the spec must follow), the spec itself, then
the root spec.md and the code wherever the spec talks about them, and CLAUDE.md for the project's
rules. Project constraints: one host, SQLite, a budget of $20–40/month, a single maintainer.

The spec has two readers. The section «Для власника» at its top is for the owner, who approves the
spec from that section alone; the body is for whoever writes the plan. Your most important job is
to find what the owner would miss by reading only that section.

Report only:
1. Body → summary: a decision in the body that changes visible behaviour, the operational regime
   (what now happens without a human), access rights, or is irreversible, and that the owner
   section leaves out or blurs. Quote the body line. Do not report the other direction (a summary
   line the body repeats) unless the two contradict.
2. Premises: a premise in «На чому стоїть рішення» without a source tag; a [проба] tag with no
   probe in the body; a [виведення] that does not follow from what the spec gives.
3. Contradictions: the owner section and the body say different things (numbers, limits, who
   does what).
4. Claim→evidence: a place where the design records something as fact and the evidence is a
   count, an assumption about external data, or "it has always been so".
5. Reinvention: a place where the design builds its own mechanism and an existing one covers it —
   systemd, litestream, sqlite, git, `gh`, a dependency already in package.json, or a module
   already in this repository. Name the concrete tool and what it would not cover; a finding that
   cannot name both is not reported.
6. Design defects: a scenario where the described mechanism gives a wrong result, with the
   concrete input or state.

Do not report style, wording, or "add more detail" without naming what is missing. Quote the spec
line you are talking about. If you are unsure, say so in the finding.

Format: a numbered list, one finding per item, most severe first, each tagged with its check
number (e.g. "[1]"). Then, as the very last line of your answer, exactly:
CROSS-REVIEW-RESULT: <n> findings
where <n> is the number of findings (0 if none).
```

- [ ] **Step 4: Replace `scripts/cross-review/cli.ts` with:**

```ts
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT, TIMEOUT_MS, parseArgs, isNestedRun, preflight, specPreflight, normalizeSpecPath, specPathError,
  classifyResult, reportText, markerReason, markerLine, spawnOutcome, runDirPrefix, runArtifacts,
  renderPrompt, buildReviewerCommand, type Mode,
} from './core';

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// Best-effort cleanup of a snapshot worktree; a failure here must not mask the review's own result.
function removeSnapshot(dir: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { encoding: 'utf8' });
  spawnSync('git', ['worktree', 'prune'], { encoding: 'utf8' });
}

// Everything read from git before a run exists. A failure here (e.g. `--base origin/mian`) means no
// review was attempted: a usage error, never a `failed` marker (#739).
function readRepo(): { root: string; sha: string; branch: string; dirty: boolean } {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  const sha = git(['rev-parse', 'HEAD']).trim();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const dirty = git(['status', '--porcelain']).trim() !== '';
  return { root, sha, branch, dirty };
}

// `git cat-file -e` exits non-zero when the path is not in HEAD's tree: an answer, not a failure.
function existsAtHead(path: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `HEAD:${path}`], { encoding: 'utf8' }).status === 0;
}

function modeOf(spec: string | undefined): Mode {
  return spec === undefined ? 'diff' : 'spec';
}

function main(argv: string[]): number {
  if (isNestedRun(process.env)) {
    console.error('cross-review: refusing to run inside a cross-review (CROSS_REVIEW_ACTIVE=1)');
    return EXIT.nested;
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`cross-review: ${parsed.error}\nUsage: npm run cross-review -- --reviewer codex|claude [--base origin/main | --spec <spec file>] [--model <id>]`);
    return EXIT.usage;
  }
  const { reviewer, base, model, spec } = parsed.opts;
  const mode = modeOf(spec);
  const specPath = spec === undefined ? '' : normalizeSpecPath(spec);
  const pathError = mode === 'spec' ? specPathError(specPath) : null;
  if (pathError) {
    console.error(`cross-review: ${pathError}`);
    return EXIT.usage;
  }

  let repo: ReturnType<typeof readRepo>;
  let diff = '';
  try {
    repo = readRepo();
    if (mode === 'diff') diff = git(['diff', `${base}...${repo.sha}`]);
  } catch (error) {
    console.error(`cross-review: ${markerReason(error instanceof Error ? error.message : String(error))}`);
    return EXIT.usage;
  }
  const { root, sha, branch } = repo;
  const sha7 = sha.slice(0, 7);
  const refusal = mode === 'spec'
    ? specPreflight({ dirty: repo.dirty, inHead: existsAtHead(specPath) })
    : preflight({ dirty: repo.dirty, diffBytes: diff.length });
  if (refusal) {
    console.error(`cross-review: ${refusal}`);
    return EXIT.usage;
  }

  const tmpDir = join(root, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const runDir = mkdtempSync(runDirPrefix(tmpDir, reviewer, branch, sha, mode));
  const paths = runArtifacts(runDir);
  let prompt: string;
  if (mode === 'spec') {
    prompt = renderPrompt(readFileSync(join(__dirname, 'prompt-spec.md'), 'utf8'), { sha: sha7, branch, specPath });
  } else {
    writeFileSync(paths.diff, diff);
    prompt = renderPrompt(readFileSync(join(__dirname, 'prompt.md'), 'utf8'), { base, sha: sha7, branch, diffPath: paths.diff });
  }
  const command = buildReviewerCommand({ reviewer, model, prompt, reportPath: paths.report, tmpDir: runDir });

  // The reviewer runs in a detached worktree of exactly `sha`, so the review describes that SHA by
  // construction — whatever happens in the author's checkout during the (up to 15 min) run (PR #738 review).
  git(['worktree', 'add', '--detach', paths.snapshot, sha]);
  let r: SpawnSyncReturns<string>;
  try {
    const subject = mode === 'spec' ? `${specPath} @ ${sha7}` : `${branch} @ ${sha7} vs ${base}`;
    console.error(`cross-review: ${reviewer} reviewing ${subject} (up to 15 min)…`);
    r = spawnSync(command.cmd, command.args, {
      cwd: paths.snapshot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CROSS_REVIEW_ACTIVE: '1' },
    });
  } finally {
    removeSnapshot(paths.snapshot);
  }
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
  if (verdict.kind === 'failed') {
    console.error(`cross-review: FAILED — ${verdict.reason}. Log: ${paths.log}`);
    console.log(markerLine(mode, `failed (${markerReason(verdict.reason)})`));
    return EXIT.reviewerFailed;
  }
  console.log(`cross-review: ${reviewer} @ ${sha7} — ${verdict.findings} finding(s). Report: ${paths.report}`);
  console.log(markerLine(mode, `${reviewer} @ ${sha7} — ${verdict.findings} findings: <f> fixed, <r> rejected`));
  return EXIT.ok;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    process.exitCode = main(argv);
  } catch (error) {
    // after preparation: a run was attempted and broke (file write, worktree add) — a failed review
    const reason = error instanceof Error ? error.message : String(error);
    const parsed = parseArgs(argv);
    console.error(`cross-review: FAILED — ${reason}`);
    console.log(markerLine(modeOf(parsed.ok ? parsed.opts.spec : undefined), `failed (${markerReason(reason)})`));
    process.exitCode = EXIT.reviewerFailed;
  }
}
```

- [ ] **Step 5: Full gate.** `npm test && npm run typecheck` — expected PASS.

- [ ] **Step 6: Smoke the usage errors (no reviewer is spawned by any of these):**
  - `npm run cross-review -- --reviewer codex --spec docs/superpowers/plans/2026-10/2026-10-15-spec-owner-summary.md` → exit 2, the path message.
  - `npm run cross-review -- --reviewer codex --spec docs/superpowers/specs/2026-10/nope-design.md` → exit 2, `the spec is not committed at HEAD …`.
  - `npm run cross-review -- --reviewer codex --spec x.md --base origin/main` → exit 2, the combination message.

- [ ] **Step 7: Commit.** `git add scripts/cross-review && git commit -m "cross-review: --spec mode reviews one committed spec with its own prompt"`

---

### Task 3: Rules — `docs/spec-format.md`, `CLAUDE.md`, `AGENTS.md`

**Files:**
- Create: `docs/spec-format.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Create `docs/spec-format.md`:**

````markdown
# Формат архітектурної спеки: секція «Для власника», оцінка, рев'ю спеки

Дизайн: `docs/superpowers/specs/2026-10/2026-10-15-spec-owner-summary-design.md`. Діє для кожної
нової архітектурної спеки, хоч би хто її писав — Claude чи Codex. Легкий шлях для фіксів спеки не
має, тож і цього формату теж.

У спеки два читачі. Власник затверджує її з першої секції й тіла читати не зобов'язаний; тіло — для
того, хто пише план. Усе, що власник мусить знати, щоб сказати «так» або «стоп», стоїть нагорі.

## Заголовок

```
# <тема>

Дата: YYYY-MM-DD
Статус: чернетка | чекає на затвердження | затверджено YYYY-MM-DD
Spec-review: <reviewer> @ <sha> — <n> findings: <f> fixed, <r> rejected
```

Рядок `Spec-review:` друкує `npm run cross-review -- --spec …` (див. нижче). Збій рецензента:
`Spec-review: failed (<причина>)`.

## Секція «Для власника»

Перша секція після заголовка. Не більше одного екрана. Українською, термінами того, що зміниться для
людини або бюджету, а не механізму. Поля по порядку:

| Поле | Що в ньому | Правило |
|---|---|---|
| Мета | 1–2 речення: що зміниться для людини, яка питає про пиво, або для бюджету | Без назв модулів |
| Що зміниться для тебе | Що тепер відбувається без власника; що він мусить робити інакше; що стає незворотним | Обов'язкове. «Нічого» — лише з поясненням |
| На чому стоїть рішення | Засновки й інваріанти, кожен з позначкою `[вимога власника]`, `[проба]` (з посиланням на розділ проб) або `[виведення]` | Засновок без позначки — дефект |
| Ключові рішення | 3–5 рішень, які дорого скасовувати, кожне з відкинутою альтернативою; плюс «Розглянуто стандартне: X — відкинуто, бо Y» на кожну розглянуту стандартну альтернативу | Рішення з тіла, яке міняє видиму поведінку, операційний режим, права доступу або незворотне, мусить бути тут |
| Що стане гірше | Ціна, втрати, нові ризики | Обов'язкове, не порожнє |
| Оцінка | Оцінка власника, оцінка автора, розклад, дешевший варіант; після мерджу — «Фактично» | Див. «Оцінка» |
| Питання до власника | Не більше трьох | «Немає» допустимо |

`[виведення]` — це місце, куди власнику варто дивитися першим: там автор міг помилитися.

**Поправки.** Поправка, яка змінює засновок, ключове рішення або оцінку з викладу, змінює й виклад і
повертає статус на «чекає на затвердження». Поправка, яка викладу не зачіпає, — ні.

## Оцінка

| Розмір | Що означає |
|---|---|
| XS | без коду або одна правка в межах легкого шляху |
| S | один PR, план ≤ 4 задачі |
| M | один PR, ядро + окремий план на обв'язку |
| L | 2–3 PR або крок на хості (`[deploy:hold]`) |
| XL | розпадається на кілька спек |

1. На початку brainstorming автор переказує задачу своїми словами й питає оцінку власника. Своєї
   не називає і не натякає на неї: інакше вона стає якорем.
2. Коли підхід обрано, але спеку ще не написано, автор дає свою оцінку з розкладом (частки роботи за
   складниками) і, якщо він існує, дешевшим варіантом із тим, що в ньому втрачається.
3. Розбіжність на ≥ 2 розміри — обов'язкова зупинка й розбір: автор пропустив пастку, переускладнює,
   чи власник недооцінює. Результат розбору йде в поле «Оцінка» окремим абзацом.
4. Після мерджу останнього PR зміни автор дописує «Фактично: <розмір>, <n> PR, <m> задач у планах».
   Відсоток тижневого ліміту — лише зміряний, не оцінений.

## Рев'ю спеки

Після проб і до того, як спеку читає власник, автор запускає рев'ю іншим агентом:

- спеку писав Claude → `npm run cross-review -- --spec <файл> --reviewer codex`;
- спеку писав Codex → `npm run cross-review -- --spec <файл> --reviewer claude`.

Спека має бути закомічена (рев'ю прив'язане до SHA). Запуск — у фоні: рев'ю триває до 15 хв. Один
раз на спеку; поправки після затвердження його не перезапускають.

Кожну знахідку автор розбирає як коментар рев'ю: виправляє або відхиляє з причиною. Знахідка про
велосипед (перевірка 5) прийнята — міняє дизайн; відхилена — дає рядок «Розглянуто стандартне» у
викладі. Збій рецензента (exit 5) спеку не блокує.

Слід: рядок `Spec-review:` у заголовку і останній розділ спеки:

```
## Рев'ю спеки

| № | Перевірка | Рішення | Причина / що змінено |
|---|---|---|---|
```

Звіт рецензента лежить у `tmp/` і не комітиться, тож ця таблиця — єдиний слід.
````

- [ ] **Step 2: `CLAUDE.md`.** Insert this bullet right after the bullet that starts with `- **Спека виписує таблицю «заявка → доказ»**`:

```markdown
- **Спека починається з секції «Для власника»; оцінка власника звучить раніше за твою; спеку рецензує інша модель до власника** (формат і правила: `docs/spec-format.md`; дизайн: `docs/superpowers/specs/2026-10/2026-10-15-spec-owner-summary-design.md`): власник затверджує спеку з першої секції й тіла читати не зобов'язаний, тож рішення, яке живе лише в тілі, він пропускає — так пройшло «мердж = деплой» у merge-deploy. На початку brainstorming переказуєш задачу своїми словами й питаєш оцінку власника, **не називаючи своєї**; свою — коли підхід обрано, до спеки, з розкладом і дешевшим варіантом; розбіжність ≥ 2 розміри — зупинка й розбір. Після проб, із закоміченою спекою, запусти **у фоні** `npm run cross-review -- --spec <файл> --reviewer codex`; кожну знахідку виправ або відхили з причиною, рядок `Spec-review:` — у заголовок, таблиця рішень — у `## Рев'ю спеки`. Після мерджу останнього PR — «Фактично» в оцінці.
```

- [ ] **Step 3: `AGENTS.md`.** Insert this section right before the line `Staging a Large Change`, after the `---` that ends "Claims and Their Evidence":

```markdown
Writing a Design Spec

Every new architectural spec follows `docs/spec-format.md`, whichever agent writes it. The owner
approves a spec from its first section, «Для власника», and is not required to read the body; a
decision that lives only in the body is a decision the owner misses. That is how "merge means
deploy" went through in the merge-deploy spec.

- At the start of brainstorming, restate the task in your own words and ask for the owner's size
  estimate **before giving yours** — yours would anchor it. Give yours once the approach is chosen
  and before the spec is written, with a breakdown and a cheaper variant. A gap of two sizes or
  more stops the work until it is talked through.
- After the probes, with the spec committed, have Claude review it: `npm run cross-review -- --spec
  <file> --reviewer claude`, with a command timeout of at least 16 minutes. The same
  `.codex/rules/default.rules` entry as for the code review lets it reach the network. Verify each
  finding: fix it or reject it with a reason. Put the printed `Spec-review:` line in the spec's
  header and the decisions in its final `## Рев'ю спеки` table. Once per spec.
- After the last PR of the change merges, add the actual size to the spec's estimate.

---

```

- [ ] **Step 4: Full gate.** `npm test && npm run typecheck` — expected PASS (docs only; the gate guards nothing broke).

- [ ] **Step 5: Commit.** `git add docs/spec-format.md CLAUDE.md AGENTS.md && git commit -m "docs: spec format with an owner section, estimate-first grooming, spec cross-review"`

---

### Task 4: Prompt probe and the first real run (needs `codex` on PATH)

**Files:**
- Modify: `docs/superpowers/specs/2026-10/2026-10-15-spec-owner-summary-design.md`

- [ ] **Step 1: Probe the body → summary check.** Make a probe copy of the spec,
  `docs/superpowers/specs/2026-10/2026-10-15-zz-probe-design.md`. Delete from its «Ключові рішення» the bullet
  that starts `- Рев'ю запускається один раз`, and leave section 3 of the body as is. Commit it on a
  throwaway branch, then run
  `npm run cross-review -- --spec docs/superpowers/specs/2026-10/2026-10-15-zz-probe-design.md --reviewer codex`
  in the background. **Pass:** the report has a `[1]` finding that quotes the body's «Один раз на спеку».
  **Fail:** tighten check 1 in `prompt-spec.md` (commit on the feature branch, gate) and probe again;
  give up after two rounds and record the miss in the spec instead. Delete the throwaway branch.
  Record the outcome (pass/fail, rounds, finding count) under a new `## Проби` section of the spec.

- [ ] **Step 2: First real run.** On the feature branch, with the tree clean:
  `npm run cross-review -- --spec docs/superpowers/specs/2026-10/2026-10-15-spec-owner-summary-design.md --reviewer codex`
  in the background.

- [ ] **Step 3: Disposition.** Verify every finding against the spec. Fix the accepted ones in the
  spec. If a fix changes a premise, a key decision or the estimate in «Для власника», set the status
  back to «чекає на затвердження» and show the owner what changed before opening the PR. Replace the
  `Spec-review: pending …` header line with the printed marker (filled in), and add the
  `## Рев'ю спеки` table at the end of the spec.

- [ ] **Step 4: Full gate, commit.** `npm test && npm run typecheck`; `git commit -am "spec: first spec cross-review of the owner-summary design"`

---

## After merge

- Add «Фактично: <розмір>, 1 PR, 4 задачі» to the spec's estimate (in the next PR that touches the
  spec, or a docs-only PR).
- Retro on 2026-10-23: scheduled task `spec-process-retro`.
