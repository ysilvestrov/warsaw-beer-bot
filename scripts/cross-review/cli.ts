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
