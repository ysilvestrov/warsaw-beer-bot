import { runFind } from './find';

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
  model: 'gpt-5.4-mini',
  fetchFn,
  sleep: async () => {},
});

const payload = {
  findings: [
    {
      file: 'src/a.ts',
      start_line: 3,
      end_line: 3,
      quote: "return 'not_found';",
      claim: 'merge reported as failure',
      why_it_breaks: 'cron stats count a success as a miss',
      severity: 'P1',
      confidence: 'medium',
    },
  ],
};

describe('runFind', () => {
  it('parses findings out of the structured response', async () => {
    const { findings } = await runFind(deps(respond(JSON.stringify(payload))), {
      instructions: 'find things',
      context: '# Diff',
      prTitle: 'T',
      prBody: 'B',
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/a.ts');
  });

  it('returns an empty list when the model reports nothing', async () => {
    const { findings } = await runFind(deps(respond('{"findings":[]}')), {
      instructions: 'find things',
      context: '# Diff',
      prTitle: 'T',
      prBody: 'B',
    });
    expect(findings).toEqual([]);
  });

  it('fails loudly on unparseable output', async () => {
    await expect(
      runFind(deps(respond('not json')), {
        instructions: 'x',
        context: 'y',
        prTitle: 'T',
        prBody: 'B',
      }),
    ).rejects.toThrow(/could not be parsed/i);
  });

  it('fails loudly when the payload does not match the schema', async () => {
    await expect(
      runFind(deps(respond('{"findings":[{"file":"a"}]}')), {
        instructions: 'x',
        context: 'y',
        prTitle: 'T',
        prBody: 'B',
      }),
    ).rejects.toThrow(/schema/i);
  });
});

import { runFind as runFindUsage } from './find';

describe('runFind usage', () => {
  it('reports the tokens its call consumed', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          usage: { prompt_tokens: 1234, completion_tokens: 56 },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await runFindUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      { instructions: 'i', context: 'c', prTitle: 't', prBody: 'b' },
    );
    expect(out.findings).toEqual([]);
    expect(out.usage.promptTokens).toBe(1234);
    expect(out.usage.calls).toBe(1);
  });
});
