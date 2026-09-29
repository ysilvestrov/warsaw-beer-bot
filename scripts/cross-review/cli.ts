import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT, TIMEOUT_MS, parseArgs, isNestedRun, preflight, postflight, classifyResult,
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
  const spawnError = timedOut
    ? undefined
    : (r.error as NodeJS.ErrnoException | undefined)?.code
      ?? r.error?.message
      ?? (r.signal && r.status === null ? `killed by ${r.signal}` : undefined);
  const moved = postflight({
    startSha: sha,
    endSha: git(['rev-parse', 'HEAD']).trim(),
    dirty: git(['status', '--porcelain']).trim() !== '',
  });
  const verdict = moved
    ? { kind: 'failed' as const, reason: moved }
    : classifyResult({ exitCode: r.status, timedOut, spawnError, report, log });
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
    // git or filesystem failure: no review happened, so it is a failed review, not a usage error
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`cross-review: FAILED — ${reason}`);
    console.log(`PR marker: Cross-review: failed (${reason.split('\n')[0]})`);
    process.exitCode = EXIT.reviewerFailed;
  }
}
