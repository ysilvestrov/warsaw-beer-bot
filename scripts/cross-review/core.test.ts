import { describe, test, expect } from 'vitest';
import { parseArgs, isNestedRun, preflight, classifyResult, reviewerErrorLine, markerReason, reportText, spawnOutcome, runDirPrefix, runArtifacts, renderPrompt, buildReviewerCommand } from './core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  test('a value that looks like a flag is rejected, for any flag', () => {
    expect(parseArgs(['--reviewer', '--base', 'x'])).toEqual({ ok: false, error: '--reviewer needs a value' });
    expect(parseArgs(['--reviewer', 'codex', '--model'])).toEqual({ ok: false, error: '--model needs a value' });
  });
  test('an empty value is rejected, so --model "$UNSET" cannot drop the codex Sol pin', () => {
    expect(parseArgs(['--reviewer', 'codex', '--model', ''])).toEqual({ ok: false, error: '--model needs a value' });
    expect(parseArgs(['--reviewer', 'codex', '--base', ''])).toEqual({ ok: false, error: '--base needs a value' });
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

const run = (o: Partial<{ reviewer: 'codex' | 'claude'; exitCode: number | null; timedOut: boolean; spawnError: string; report: string; stdout: string; stderr: string }>) => ({
  reviewer: 'claude' as const, exitCode: 0, timedOut: false, report: '', stdout: '', stderr: '', ...o,
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
  test('a result line quoted in a code fence is not the verdict when the report ends otherwise', () => {
    expect(classifyResult(run({ report: 'Example:\n```\nCROSS-REVIEW-RESULT: 0 findings\n```\nI could not read the diff.' }))).toEqual({ kind: 'failed', reason: 'reviewer output does not end with a CROSS-REVIEW-RESULT line' });
  });
  test('an indented result line is not the result line', () => {
    expect(classifyResult(run({ report: '  CROSS-REVIEW-RESULT: 0 findings' }))).toEqual({ kind: 'failed', reason: 'reviewer output does not end with a CROSS-REVIEW-RESULT line' });
  });
  test('trailing blank lines after the result line are ignored', () => {
    expect(classifyResult(run({ report: 'findings\nCROSS-REVIEW-RESULT: 2 findings\n\n' }))).toEqual({ kind: 'ok', findings: 2 });
  });
  test('a spawn failure is named, never reported as a missing result line', () => {
    expect(classifyResult(run({ exitCode: null, spawnError: 'ENOENT' }))).toEqual({ kind: 'failed', reason: 'reviewer did not run to completion: ENOENT' });
  });
  test('timeout wins over the spawn error it caused', () => {
    expect(classifyResult(run({ exitCode: null, timedOut: true, spawnError: 'ETIMEDOUT' }))).toEqual({ kind: 'failed', reason: 'timeout after 15 min' });
  });
  test('empty output is a failure, never zero findings', () => {
    expect(classifyResult(run({ report: '' }))).toEqual({ kind: 'failed', reason: 'reviewer output does not end with a CROSS-REVIEW-RESULT line' });
  });
  test('output without the result line is a failure', () => {
    expect(classifyResult(run({ report: 'Looks good to me!' }))).toEqual({ kind: 'failed', reason: 'reviewer output does not end with a CROSS-REVIEW-RESULT line' });
  });
  test('timeout beats everything else', () => {
    expect(classifyResult(run({ timedOut: true, exitCode: null, report: 'CROSS-REVIEW-RESULT: 0 findings' }))).toEqual({ kind: 'failed', reason: 'timeout after 15 min' });
  });
  test('a successful review quoting EAI_AGAIN is not a network failure', () => {
    expect(classifyResult(run({ exitCode: 0, report: 'the code matches EAI_AGAIN in core.ts\nCROSS-REVIEW-RESULT: 2 findings' }))).toEqual({ kind: 'ok', findings: 2 });
  });
  test('non-zero exit fails even with a result line', () => {
    expect(classifyResult(run({ exitCode: 2, report: 'CROSS-REVIEW-RESULT: 0 findings' }))).toEqual({ kind: 'failed', reason: 'reviewer exited with code 2' });
  });
});

describe('runDirPrefix', () => {
  test('reviewer, branch with slashes as dashes, sha cut to 7, open for the mkdtemp suffix', () => {
    expect(runDirPrefix('/r/tmp', 'codex', 'feat/cross-review', '0123456789abcdef')).toBe('/r/tmp/cross-review-codex-feat-cross-review-0123456-');
  });
});

describe('runArtifacts', () => {
  test('every artifact of a run lives inside its own directory', () => {
    expect(runArtifacts('/r/tmp/cross-review-codex-b-0123456-Ab12Cd')).toEqual({
      diff: '/r/tmp/cross-review-codex-b-0123456-Ab12Cd/branch.diff',
      report: '/r/tmp/cross-review-codex-b-0123456-Ab12Cd/report.md',
      log: '/r/tmp/cross-review-codex-b-0123456-Ab12Cd/reviewer.log',
      snapshot: '/r/tmp/cross-review-codex-b-0123456-Ab12Cd/snapshot',
    });
  });
});

describe('spawnOutcome', () => {
  test('a clean exit is neither a timeout nor a spawn error', () => {
    expect(spawnOutcome({ status: 0, signal: null })).toEqual({ timedOut: false });
  });
  test('ETIMEDOUT is the timeout and never a spawn error (Node also sets SIGKILL)', () => {
    expect(spawnOutcome({ status: null, signal: 'SIGKILL', errorCode: 'ETIMEDOUT', errorMessage: 'spawnSync codex ETIMEDOUT' })).toEqual({ timedOut: true });
  });
  test('a missing CLI is named by its error code', () => {
    expect(spawnOutcome({ status: null, signal: null, errorCode: 'ENOENT', errorMessage: 'spawnSync codex ENOENT' })).toEqual({ timedOut: false, spawnError: 'ENOENT' });
  });
  test('output over the buffer is named', () => {
    expect(spawnOutcome({ status: null, signal: 'SIGTERM', errorCode: 'ENOBUFS', errorMessage: 'spawnSync claude ENOBUFS' })).toEqual({ timedOut: false, spawnError: 'ENOBUFS' });
  });
  test('an error without a code falls back to its message', () => {
    expect(spawnOutcome({ status: null, signal: null, errorMessage: 'boom' })).toEqual({ timedOut: false, spawnError: 'boom' });
  });
  test('a signal kill with no exit status is named', () => {
    expect(spawnOutcome({ status: null, signal: 'SIGKILL' })).toEqual({ timedOut: false, spawnError: 'killed by SIGKILL' });
  });
  test('a signal alongside an exit status is not a spawn error', () => {
    expect(spawnOutcome({ status: 1, signal: 'SIGTERM' })).toEqual({ timedOut: false });
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
  test('an inherited Object name is not a filled placeholder', () => {
    expect(() => renderPrompt('{{constructor}}', { base: 'x', sha: 'y', branch: 'z', diffPath: 'w' })).toThrow('unfilled placeholder {{constructor}}');
  });
});

describe('buildReviewerCommand', () => {
  const base = { prompt: 'P', reportPath: '/t/r.md', tmpDir: '/t' };
  test('codex: read-only sandbox, report via -o, Sol model by default', () => {
    expect(buildReviewerCommand({ ...base, reviewer: 'codex' })).toEqual({
      cmd: 'codex',
      args: ['exec', '-s', 'read-only', '--ephemeral', '-o', '/t/r.md', '-m', 'gpt-6.1-sol', 'P'],
      reportFromStdout: false,
    });
  });
  test('codex: an explicit model overrides the default', () => {
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
  test('a bare carriage return separates lines too (progress output)', () => {
    expect(reviewerErrorLine('codex', '', 'Reconnecting... 5/5\rERROR: workspace routing discovery failed')).toBe('ERROR: workspace routing discovery failed');
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
  test('a bare prefix with nothing after it falls back to the exit code', () => {
    expect(classifyResult(run({ reviewer: 'codex', exitCode: 1, stderr: 'ERROR:' }))).toEqual({
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
  test('the cut never splits a character outside the BMP', () => {
    expect(markerReason(`${'a'.repeat(198)}😀bc`)).toBe(`${'a'.repeat(198)}😀…`);
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
