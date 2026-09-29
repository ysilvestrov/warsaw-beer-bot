// Pure logic of `npm run cross-review` (spec: docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md).
// The runner (cli.ts) does the I/O; everything that decides lives here so it can be tested.

export type Reviewer = 'codex' | 'claude';
export interface Options { reviewer: Reviewer; base: string; model?: string }

export const EXIT = { ok: 0, usage: 2, nested: 3, reviewerFailed: 5 } as const;
export const TIMEOUT_MS = 900_000;
const RESULT_LINE = /^CROSS-REVIEW-RESULT: (\d+) findings?\s*$/;
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

// The report is pinned to the SHA captured before launch; a review of up to 15 min can outlive that
// SHA (another terminal commits or checks out), and then the reviewer read files the diff does not describe.
export function postflight(s: { startSha: string; endSha: string; dirty: boolean }): string | null {
  if (s.startSha !== s.endSha) {
    return `HEAD moved during the review (${s.startSha.slice(0, 7)} → ${s.endSha.slice(0, 7)}) — the report does not describe one SHA`;
  }
  if (s.dirty) return 'working tree changed during the review — the report does not describe one SHA';
  return null;
}

export interface RunOutcome { exitCode: number | null; timedOut: boolean; spawnError?: string; report: string; log: string }
export type Verdict = { kind: 'ok'; findings: number } | { kind: 'failed'; reason: string };

export function classifyResult(r: RunOutcome): Verdict {
  if (r.timedOut) return { kind: 'failed', reason: 'timeout after 15 min' };
  if (r.spawnError) return { kind: 'failed', reason: `reviewer did not run to completion: ${r.spawnError}` };
  if (r.exitCode !== 0) {
    if (NO_NETWORK.test(r.log) || NO_NETWORK.test(r.report)) {
      return { kind: 'failed', reason: 'no network — Codex sandbox without the allow rule? see AGENTS.md' };
    }
    return { kind: 'failed', reason: `reviewer exited with code ${r.exitCode}` };
  }
  const last = r.report.trimEnd().split('\n').pop() ?? '';
  const m = RESULT_LINE.exec(last);
  if (!m) return { kind: 'failed', reason: 'reviewer output does not end with a CROSS-REVIEW-RESULT line' };
  return { kind: 'ok', findings: Number(m[1]) };
}

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
