import { applyGate, changedLineRanges, locateQuote, normalizeWs } from './gate';
import type { RawFinding } from './types';

const base: RawFinding = {
  file: 'src/a.ts',
  start_line: 1,
  end_line: 1,
  quote: "return 'not_found';",
  claim: 'wrong outcome',
  why_it_breaks: 'merge is reported as a failure',
  severity: 'P1',
  confidence: 'medium',
};

const CONTENT = [
  'export function f() {',
  '  if (clash) {',
  "    return 'not_found';",
  '  }',
  '  return ok;',
  '}',
].join('\n');

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +2,4 @@',
  ' context',
  '+added',
  'diff --git a/src/gone.ts b/src/gone.ts',
  '--- a/src/gone.ts',
  '+++ /dev/null',
].join('\n');

describe('normalizeWs', () => {
  it('collapses runs of whitespace and trims', () => {
    expect(normalizeWs('  a\n\t b  ')).toBe('a b');
  });
});

describe('locateQuote', () => {
  it('finds a single-line quote regardless of indentation', () => {
    expect(locateQuote(CONTENT, "return 'not_found';")).toBe(3);
  });

  it('finds a quote spanning several lines', () => {
    expect(locateQuote(CONTENT, "if (clash) {\n  return 'not_found';\n}")).toBe(2);
  });

  it('returns null when the quote is absent', () => {
    expect(locateQuote(CONTENT, "return 'merged';")).toBeNull();
  });

  it('returns null for an empty quote', () => {
    expect(locateQuote(CONTENT, '   ')).toBeNull();
  });

  // Known, deliberate limitation: a multi-line quote must begin at the start of
  // a line. Anchoring Phase 2 at the window start is what prevents the
  // substring false-positive that reports a line-3 quote as line 1. The cost is
  // that a mid-line multi-line quote is not located, so applyGate drops the
  // finding as `quote_not_found` — failing closed, which is the safe direction.
  it('does not locate a multi-line quote that starts mid-line', () => {
    expect(locateQuote(CONTENT, "(clash) {\n  return 'not_found';")).toBeNull();
  });
});

describe('changedLineRanges', () => {
  it('parses post-image hunk ranges per file and skips deletions', () => {
    const ranges = changedLineRanges(DIFF);
    expect(ranges.get('src/a.ts')).toEqual([[2, 5]]);
    expect(ranges.has('src/gone.ts')).toBe(false);
  });

  it('treats a hunk without an explicit count as one line', () => {
    const ranges = changedLineRanges('+++ b/src/b.ts\n@@ -1 +7 @@');
    expect(ranges.get('src/b.ts')).toEqual([[7, 7]]);
  });
});

describe('applyGate', () => {
  const gate = (finding: RawFinding, content: string | null = CONTENT) =>
    applyGate({
      findings: [finding],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[1, 6]] as Array<[number, number]>]]),
      fileContent: () => content,
    });

  it('keeps a finding whose quote exists inside the changed range', () => {
    const result = gate(base);
    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(1);
  });

  it('corrects the model-reported line number to the real match', () => {
    const result = gate({ ...base, start_line: 99, end_line: 99 });
    expect(result.kept[0].matchedLine).toBe(3);
    expect(result.kept[0].matchedEndLine).toBe(3);
  });

  it('drops a hallucinated quote', () => {
    const result = gate({ ...base, quote: "return 'merged';" });
    expect(result.kept).toEqual([]);
    expect(result.dropped[0].reason).toBe('quote_not_found');
  });

  it('drops a real quote that lies outside the changed lines', () => {
    const result = applyGate({
      findings: [base],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[5, 6]] as Array<[number, number]>]]),
      fileContent: () => CONTENT,
    });
    expect(result.dropped[0].reason).toBe('outside_changed_lines');
  });

  it('drops a finding about a file outside the reviewed scope', () => {
    const result = gate({ ...base, file: 'docs/guide.md' });
    expect(result.dropped[0].reason).toBe('out_of_scope');
  });

  it('drops a finding whose file has no readable content', () => {
    const result = gate(base, null);
    expect(result.dropped[0].reason).toBe('out_of_scope');
  });

  it('keeps the first of two findings quoting the same code', () => {
    const result = applyGate({
      findings: [base, { ...base, claim: 'restated' }],
      reviewable: ['src/a.ts'],
      changed: new Map([['src/a.ts', [[1, 6]] as Array<[number, number]>]]),
      fileContent: () => CONTENT,
    });
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].claim).toBe('wrong outcome');
    expect(result.dropped[0].reason).toBe('duplicate');
  });
});
