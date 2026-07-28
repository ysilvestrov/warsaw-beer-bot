import { renderBody } from './render';
import type { GatedFinding, VerifiedFinding } from './types';

const gated = (over: Partial<GatedFinding> = {}): GatedFinding => ({
  file: 'src/a.ts',
  start_line: 3,
  end_line: 3,
  matchedLine: 3,
  matchedEndLine: 3,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  confidence: 'medium',
  ...over,
});

const verified = (over: Partial<GatedFinding> = {}): VerifiedFinding => ({
  finding: gated(over),
  verdict: 'confirmed',
  evidence: 'line 3 returns not_found after a successful merge',
});

describe('renderBody', () => {
  it('states plainly when nothing survived, and still shows the counters', () => {
    const body = renderBody({ confirmed: [], counts: { raised: 6, gated: 3, verified: 0 } });
    expect(body).toContain('No verified findings');
    expect(body).toContain('6 raised → 3 passed the evidence gate → 0 confirmed');
  });

  it('orders findings P0 before P1 before P2', () => {
    const body = renderBody({
      confirmed: [verified({ severity: 'P2' }), verified({ severity: 'P0', file: 'src/z.ts' })],
      counts: { raised: 2, gated: 2, verified: 2 },
    });
    expect(body.indexOf('P0')).toBeLessThan(body.indexOf('P2'));
  });

  it('shows file, line and the verbatim quote for each finding', () => {
    const body = renderBody({
      confirmed: [verified()],
      counts: { raised: 1, gated: 1, verified: 1 },
    });
    expect(body).toContain('src/a.ts:3');
    expect(body).toContain("return 'not_found';");
    expect(body).toContain('merge reported as failure');
  });
});
