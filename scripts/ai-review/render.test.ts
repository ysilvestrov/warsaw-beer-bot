import { MAX_BODY_CHARS, renderBody } from './render';
import { MAX_OPEN_FINDINGS, parseState, type StoredFinding } from './state';

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

const base = {
  counts: { raised: 0, gated: 0, verified: 0, carried: 0, closed: 0 },
  costLine: 'find skipped · verify skipped · this run $0.00 · PR total $0.00',
  head: 'a'.repeat(40),
  spend: { usd: 0, runs: 1, unpriced: 0 },
};

describe('renderBody', () => {
  it('states plainly when nothing is open, and still shows the counters', () => {
    const body = renderBody({
      ...base,
      open: [],
      closed: [],
      counts: { raised: 6, gated: 3, verified: 0, carried: 0, closed: 0 },
    });
    expect(body).toContain('No verified findings');
    expect(body).toContain('6 raised → 3 gated → 0 confirmed');
  });

  it('shows file, line, verbatim quote and evidence for an open finding', () => {
    const body = renderBody({ ...base, open: [{ finding: stored() }], closed: [] });
    expect(body).toContain('src/a.ts:3');
    expect(body).toContain("return 'not_found';");
    expect(body).toContain('merge reported as failure');
    expect(body).toContain('line 3 returns not_found after a successful merge');
  });

  it('orders open findings P0 before P1 before P2', () => {
    const body = renderBody({
      ...base,
      open: [{ finding: stored({ severity: 'P2' }) }, { finding: stored({ severity: 'P0' }) }],
      closed: [],
    });
    expect(body.indexOf('P0')).toBeLessThan(body.indexOf('P2'));
  });

  it('annotates a carried finding and one whose fix did not close it', () => {
    const body = renderBody({
      ...base,
      open: [
        { finding: stored({ claim: 'still open' }), note: 'carried from an earlier push' },
        { finding: stored({ claim: 'not closed' }), note: 'the fix did not close this' },
      ],
      closed: [],
    });
    expect(body).toContain('carried from an earlier push');
    expect(body).toContain('the fix did not close this');
  });

  it('lists what this push closed, with the reason', () => {
    const body = renderBody({
      ...base,
      open: [],
      closed: [
        { finding: stored({ claim: 'was fixed' }), reason: 'fixed' },
        { finding: stored({ claim: 'file deleted', file: 'src/gone.ts' }), reason: 'obsolete' },
      ],
      counts: { raised: 0, gated: 0, verified: 0, carried: 0, closed: 2 },
    });
    expect(body).toContain('Closed by this push');
    expect(body).toContain('was fixed');
    expect(body).toContain('src/gone.ts');
  });

  it('prints the cost line and the counters in the footer', () => {
    const body = renderBody({
      ...base,
      open: [{ finding: stored() }],
      closed: [{ finding: stored({ claim: 'gone' }), reason: 'fixed' }],
      counts: { raised: 4, gated: 2, verified: 1, carried: 1, closed: 1 },
      costLine: 'find 1 call 12.3k→3.1k · verify 1 call 8.0k→900 · this run $0.07 · PR total $0.21',
    });
    expect(body).toContain('4 raised → 2 gated → 1 confirmed · 1 carried · 1 closed');
    expect(body).toContain('PR total $0.21');
  });

  it('embeds a state block that parses back to the findings it displayed', () => {
    const body = renderBody({
      ...base,
      open: [{ finding: stored({ severity: 'P2', claim: 'second' }) }, { finding: stored({ severity: 'P0', claim: 'first' }) }],
      closed: [],
      head: 'c'.repeat(40),
      spend: { usd: 0.21, runs: 3, unpriced: 0 },
    });
    const state = parseState(body)!;
    expect(state.head).toBe('c'.repeat(40));
    expect(state.spend).toEqual({ usd: 0.21, runs: 3, unpriced: 0 });
    expect(state.findings.map((f) => f.claim)).toEqual(['first', 'second']);
  });

  it('caps the number of open findings and says it did', () => {
    const open = Array.from({ length: MAX_OPEN_FINDINGS + 3 }, (_, i) => ({
      finding: stored({ severity: 'P2', claim: `claim ${i}` }),
    }));
    const body = renderBody({ ...base, open, closed: [] });
    expect(parseState(body)!.findings).toHaveLength(MAX_OPEN_FINDINGS);
    expect(body).toMatch(/3 (further |more )?finding/i);
  });

  it('keeps the body under the size limit by dropping closed entries first', () => {
    // closedLine() renders claim/file/reason, not why_it_breaks — pad the
    // field that actually lands in the body, or the cap never triggers.
    const fat = 'x'.repeat(4000);
    const body = renderBody({
      ...base,
      open: [{ finding: stored() }],
      closed: Array.from({ length: 40 }, (_, i) => ({
        finding: stored({ claim: `closed ${i} ${fat}` }),
        reason: 'fixed' as const,
      })),
    });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body).toContain("return 'not_found';"); // the open finding survived
    expect(body).toMatch(/omitted to fit/i);
  });

  it('drops open findings too, and keeps the state in step with what it shows', () => {
    const fat = 'y'.repeat(20_000);
    const open = Array.from({ length: 6 }, (_, i) => ({
      finding: stored({ severity: 'P2', claim: `claim ${i}`, why_it_breaks: fat }),
    }));
    const body = renderBody({ ...base, open, closed: [] });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    const state = parseState(body)!;
    for (const f of state.findings) expect(body).toContain(f.claim);
    expect(state.findings.length).toBeLessThan(6);
  });
});
