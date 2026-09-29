import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT, TIMEOUT_MS, parseArgs, isNestedRun, preflight, classifyResult, reportText, markerReason,
  spawnOutcome, runDirPrefix, runArtifacts, renderPrompt, buildReviewerCommand,
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
  const diff = git(['diff', `${base}...${sha}`]);
  const refusal = preflight({ dirty: git(['status', '--porcelain']).trim() !== '', diffBytes: diff.length });
  if (refusal) {
    console.error(`cross-review: ${refusal}`);
    return EXIT.usage;
  }

  const tmpDir = join(root, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const runDir = mkdtempSync(runDirPrefix(tmpDir, reviewer, branch, sha));
  const paths = runArtifacts(runDir);
  writeFileSync(paths.diff, diff);
  const template = readFileSync(join(__dirname, 'prompt.md'), 'utf8');
  const prompt = renderPrompt(template, { base, sha: sha.slice(0, 7), branch, diffPath: paths.diff });
  const command = buildReviewerCommand({ reviewer, model, prompt, reportPath: paths.report, tmpDir: runDir });

  // The reviewer runs in a detached worktree of exactly `sha`, so the review describes that SHA by
  // construction — whatever happens in the author's checkout during the (up to 15 min) run (PR #738 review).
  git(['worktree', 'add', '--detach', paths.snapshot, sha]);
  let r: SpawnSyncReturns<string>;
  try {
    console.error(`cross-review: ${reviewer} reviewing ${branch} @ ${sha.slice(0, 7)} vs ${base} (up to 15 min)…`);
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
    console.log(`PR marker: Cross-review: failed (${markerReason(verdict.reason)})`);
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
    // after preparation: a run was attempted and broke (file write, worktree add) — a failed review
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`cross-review: FAILED — ${reason}`);
    console.log(`PR marker: Cross-review: failed (${markerReason(reason)})`);
    process.exitCode = EXIT.reviewerFailed;
  }
}
