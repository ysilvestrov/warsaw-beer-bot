// Pure logic of `npm run cross-review` (spec: docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md).
// The runner (cli.ts) does the I/O; everything that decides lives here so it can be tested.

export type Reviewer = 'codex' | 'claude';
export interface Options { reviewer: Reviewer; base: string; model?: string }

export const EXIT = { ok: 0, usage: 2, nested: 3, reviewerFailed: 5 } as const;
export const TIMEOUT_MS = 900_000;
const RESULT_LINE = /^CROSS-REVIEW-RESULT: (\d+) findings?\s*$/;
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

// Every run owns a fresh directory (mkdtemp appends a unique suffix to this prefix), so two concurrent
// runs — same reviewer, branch and SHA included — never share a diff, report, log or snapshot.
export function runDirPrefix(tmpDir: string, reviewer: Reviewer, branch: string, sha: string): string {
  return `${tmpDir}/cross-review-${reviewer}-${branch.replace(/\//g, '-')}-${sha.slice(0, 7)}-`;
}

export function runArtifacts(runDir: string): { diff: string; report: string; log: string; snapshot: string } {
  return { diff: `${runDir}/branch.diff`, report: `${runDir}/report.md`, log: `${runDir}/reviewer.log`, snapshot: `${runDir}/snapshot` };
}

// How spawnSync ended, reduced to what classifyResult needs. Node reports a timeout as error code
// ETIMEDOUT (plus the kill signal), which is the timeout and never a spawn error.
export function spawnOutcome(r: {
  status: number | null; signal: string | null; errorCode?: string; errorMessage?: string;
}): { timedOut: boolean; spawnError?: string } {
  if (r.errorCode === 'ETIMEDOUT') return { timedOut: true };
  const spawnError = r.errorCode ?? r.errorMessage ?? (r.signal && r.status === null ? `killed by ${r.signal}` : undefined);
  return spawnError === undefined ? { timedOut: false } : { timedOut: false, spawnError };
}

export function renderPrompt(
  template: string,
  vars: { base: string; sha: string; branch: string; diffPath: string },
): string {
  const table: Record<string, string> = vars;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(table, key)) throw new Error(`unfilled placeholder {{${key}}}`);
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
