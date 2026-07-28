import { verifyAll } from './verify';
import type { GatedFinding } from './types';

const finding: GatedFinding = {
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
};

const respond = (content: string) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response) as unknown as typeof fetch;

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.5',
  fetchFn,
  sleep: async () => {},
});

describe('verifyAll', () => {
  it('publishes a confirmed finding', async () => {
    const out = await verifyAll(deps(respond('{"verdict":"confirmed","evidence":"line 3 returns not_found"}')), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => 'file body',
    });
    expect(out.confirmed).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });

  it('withholds a refuted finding', async () => {
    const out = await verifyAll(deps(respond('{"verdict":"refuted","evidence":"the PR already returns merged"}')), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => 'file body',
    });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected[0].verdict).toBe('refuted');
  });

  it('withholds a finding whose verification call fails, without throwing', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'nope' }) as unknown as Response) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => 'file body',
    });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected[0].verdict).toBe('error');
  });

  it('withholds a finding whose file body vanished', async () => {
    const out = await verifyAll(deps(respond('{"verdict":"confirmed","evidence":"x"}')), {
      instructions: 'verify',
      findings: [finding],
      fileContent: () => null,
    });
    expect(out.confirmed).toEqual([]);
    expect(out.rejected[0].verdict).toBe('error');
  });
});
