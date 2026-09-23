import { describe, expect, it } from 'vitest';
import { checkEntry, resolveArgs } from './verify-corpus-cli';
import type { CorpusEntry } from './verify-corpus';

// I5 (final review): --check re-derives each entry's span from its own `quote`
// (the way production does, gate.ts) and checks it against the pinned tree, so
// an edited `matchedLine` or a retyped `quote` is caught instead of silently
// pointing every future measurement at the wrong lines.

const entry = (over: Partial<CorpusEntry>): CorpusEntry => ({
  id: 'x',
  provenance: 'harvested',
  source: 's',
  sha: 'deadbeef',
  file: 'src/a.ts',
  matchedLine: 2,
  matchedEndLine: 2,
  quote: 'const b = 2;',
  claim: 'c',
  quoteOrigin: 'original',
  why_it_breaks: 'w',
  expected: 'confirmed',
  why_expected: 'because',
  ...over,
});

// A small three-line fixture, injected the same way `runDraw` injects `readBody`
// so this never shells out to git.
const BODY = ['const a = 1;', 'const b = 2;', '  const c = 3; // indented'].join('\n');
const readOk = () => BODY;
const readMissing = () => null;

describe('checkEntry', () => {
  it('passes when the quote matches the body byte-for-byte at matchedLine', () => {
    const r = checkEntry(entry({ matchedLine: 2, matchedEndLine: 2, quote: 'const b = 2;' }), readOk);
    expect(r).toEqual({ id: 'x', ok: true, detail: 'ok' });
  });

  it('fails when the sha/file does not resolve', () => {
    const r = checkEntry(entry({}), readMissing);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does not resolve/);
  });

  it('fails when the quote was retyped and no longer matches the line', () => {
    const r = checkEntry(entry({ matchedLine: 2, matchedEndLine: 2, quote: 'const b = 20;' }), readOk);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does not match/);
  });

  // Byte-for-byte INCLUDES indentation: a quote missing the leading spaces of an
  // indented line must fail even though a whitespace-normalised compare would
  // pass it.
  it('fails when the quote drops the line\'s leading indentation', () => {
    const r = checkEntry(
      entry({ matchedLine: 3, matchedEndLine: 3, quote: 'const c = 3; // indented' }),
      readOk,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/does not match/);
  });

  it('fails when matchedEndLine - matchedLine + 1 disagrees with the quote\'s own line count', () => {
    // A single-line quote claiming a 2-line span — the exact shape I2 fixed.
    const r = checkEntry(
      entry({ matchedLine: 1, matchedEndLine: 2, quote: 'const a = 1;' }),
      readOk,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/matchedEndLine - matchedLine \+ 1 is 2 but the quote has 1 line/);
  });

  it('passes a multi-line quote whose span matches its own line count', () => {
    const r = checkEntry(
      entry({ matchedLine: 1, matchedEndLine: 2, quote: 'const a = 1;\nconst b = 2;' }),
      readOk,
    );
    expect(r.ok).toBe(true);
  });

  it('fails when matchedLine is out of range for the body', () => {
    const r = checkEntry(entry({ matchedLine: 99, matchedEndLine: 99, quote: 'const b = 2;' }), readOk);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/out of range/);
  });
});

describe('resolveArgs — --check', () => {
  it('accepts --check alone, with no model required', () => {
    expect(resolveArgs(['--check'])).toEqual({ check: true, model: '', draws: 1, only: undefined });
  });

  it('accepts --check together with --only', () => {
    expect(resolveArgs(['--check', '--only', '0726'])).toEqual({
      check: true,
      model: '',
      draws: 1,
      only: '0726',
    });
  });

  // --check makes no API call and must reject anything that implies one.
  it('rejects --check combined with --model', () => {
    expect(() => resolveArgs(['--check', '--model', 'gpt-5.5'])).toThrow(/--check/);
    expect(() => resolveArgs(['--model', 'gpt-5.5', '--check'])).toThrow(/--check/);
  });
});
