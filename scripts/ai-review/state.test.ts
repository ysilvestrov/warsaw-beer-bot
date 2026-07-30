import {
  MAX_OPEN_FINDINGS,
  MAX_QUOTE_CHARS,
  capOpenFindings,
  orderBySeverity,
  parseState,
  renderState,
  toStored,
  type ReviewState,
  type StoredFinding,
} from './state';
import type { GatedFinding } from './types';

const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  file: 'src/a.ts',
  quote: "return 'not_found';",
  matchedLine: 3,
  matchedEndLine: 3,
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  evidence: 'line 3 returns not_found after a successful merge',
  ...over,
});

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  v: 1,
  head: 'a'.repeat(40),
  findings: [stored()],
  spend: { usd: 0.21, runs: 3, unpriced: 0 },
  ...over,
});

describe('renderState / parseState', () => {
  it('round-trips a state through a review body', () => {
    const s = state();
    const body = `## 🤖 AI PR Review\n\nsome text\n\n${renderState(s)}\n`;
    expect(parseState(body)).toEqual(s);
  });

  it('never emits a sequence that would close the HTML comment early', () => {
    const rendered = renderState(state({ findings: [stored({ quote: 'if (a --> b) {}' })] }));
    expect(rendered.indexOf('-->')).toBe(rendered.length - '-->'.length);
    expect(parseState(rendered)!.findings[0].quote).toBe('if (a --> b) {}');
  });

  it('treats a body with no state block as no state', () => {
    expect(parseState('## 🤖 AI PR Review\n\nNo verified findings.')).toBeNull();
  });

  it('treats an empty, missing or hand-mangled body as no state', () => {
    expect(parseState('')).toBeNull();
    expect(parseState(undefined)).toBeNull();
    expect(parseState('<!-- ai-pr-review-state {oops -->')).toBeNull();
  });

  it('rejects a state block from a future format version', () => {
    const body = renderState(state()).replace('"v":1', '"v":2');
    expect(parseState(body)).toBeNull();
  });

  it('rejects a state block whose findings do not match the schema', () => {
    const body = '<!-- ai-pr-review-state {"v":1,"head":"abc","findings":[{"file":1}],"spend":{"usd":0,"runs":1,"unpriced":0}} -->';
    expect(parseState(body)).toBeNull();
  });
});

describe('toStored', () => {
  it('keeps only the fields a later run needs, truncating a huge quote', () => {
    const gated: GatedFinding = {
      file: 'src/a.ts',
      start_line: 1,
      end_line: 2,
      matchedLine: 3,
      matchedEndLine: 4,
      quote: 'x'.repeat(MAX_QUOTE_CHARS + 500),
      claim: 'c',
      why_it_breaks: 'w',
      severity: 'P0',
      confidence: 'high',
    };
    const out = toStored(gated, 'because line 3');
    expect(out.quote).toHaveLength(MAX_QUOTE_CHARS);
    expect(out.evidence).toBe('because line 3');
    expect(out).not.toHaveProperty('confidence');
    expect(out.matchedLine).toBe(3);
  });
});

describe('orderBySeverity', () => {
  it('sorts P0 before P1 before P2 and keeps insertion order within a severity', () => {
    const items = [
      { finding: stored({ severity: 'P2', claim: 'c1' }) },
      { finding: stored({ severity: 'P0', claim: 'c2' }) },
      { finding: stored({ severity: 'P2', claim: 'c3' }) },
      { finding: stored({ severity: 'P1', claim: 'c4' }) },
    ];
    expect(orderBySeverity(items, (i) => i.finding).map((i) => i.finding.claim)).toEqual([
      'c2',
      'c4',
      'c1',
      'c3',
    ]);
  });
});

describe('capOpenFindings', () => {
  it('keeps everything when under the cap', () => {
    const items = [{ finding: stored() }];
    const out = capOpenFindings(items, (i) => i.finding);
    expect(out.kept).toHaveLength(1);
    expect(out.dropped).toBe(0);
  });

  it('drops the least severe, newest findings past the cap', () => {
    const items = [
      ...Array.from({ length: MAX_OPEN_FINDINGS }, (_, i) => ({
        finding: stored({ severity: 'P2', claim: `p2-${i}` }),
      })),
      { finding: stored({ severity: 'P0', claim: 'critical' }) },
    ];
    const out = capOpenFindings(items, (i) => i.finding);
    expect(out.kept).toHaveLength(MAX_OPEN_FINDINGS);
    expect(out.dropped).toBe(1);
    expect(out.kept.map((i) => i.finding.claim)).toContain('critical');
    expect(out.kept.map((i) => i.finding.claim)).not.toContain(`p2-${MAX_OPEN_FINDINGS - 1}`);
  });
});
