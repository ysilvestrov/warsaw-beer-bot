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
