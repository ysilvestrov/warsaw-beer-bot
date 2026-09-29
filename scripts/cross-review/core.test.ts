import { describe, test, expect } from 'vitest';
import { parseArgs, isNestedRun, preflight, classifyResult, spawnOutcome, runDirPrefix, runArtifacts, renderPrompt, buildReviewerCommand } from './core';
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

const run = (o: Partial<{ exitCode: number | null; timedOut: boolean; spawnError: string; report: string; log: string }>) => ({
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
