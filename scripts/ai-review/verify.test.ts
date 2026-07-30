import { verifyAll, type VerifyRequest } from './verify';

const req = (over: Partial<VerifyRequest> = {}): VerifyRequest => ({
  id: 'f0',
  file: 'src/a.ts',
  matchedLine: 3,
  matchedEndLine: 3,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  ...over,
});

const respond = (content: string) =>
  (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    }) as unknown as Response) as unknown as typeof fetch;

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.5',
  fetchFn,
  sleep: async () => {},
});

describe('verifyAll', () => {
  it('returns the verdict for a single finding', async () => {
    const out = await verifyAll(deps(respond('{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"line 3"}]}')), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => 'file body',
    });
    expect(out.results).toEqual([{ id: 'f0', verdict: 'confirmed', evidence: 'line 3' }]);
    expect(out.usage.calls).toBe(1);
  });

  it('sends ONE call for several findings in the same file and maps verdicts back by index', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdicts: [
                  { index: 2, verdict: 'refuted', evidence: 'second is wrong' },
                  { index: 1, verdict: 'confirmed', evidence: 'first holds' },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    })) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other bug' })],
      fileContent: () => 'file body',
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([
      { id: 'f0', verdict: 'confirmed', evidence: 'first holds' },
      { id: 'f1', verdict: 'refuted', evidence: 'second is wrong' },
    ]);
    expect(out.usage.calls).toBe(1);
  });

  it('sends one call per file when findings span several files', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"e"}]}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    })) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0', file: 'src/a.ts' }), req({ id: 'f1', file: 'src/b.ts' })],
      fileContent: () => 'file body',
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.results.map((r) => r.id).sort()).toEqual(['f0', 'f1']);
    expect(out.usage.calls).toBe(2);
  });

  it('errors only the finding whose index the model failed to answer', async () => {
    const out = await verifyAll(
      deps(respond('{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"first holds"}]}')),
      {
        instructions: 'verify',
        requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other bug' })],
        fileContent: () => 'file body',
      },
    );
    expect(out.results[0]).toEqual({ id: 'f0', verdict: 'confirmed', evidence: 'first holds' });
    expect(out.results[1].verdict).toBe('error');
    expect(out.results[1].evidence).toMatch(/no verdict/i);
  });

  it('ignores an out-of-range index instead of crashing', async () => {
    const out = await verifyAll(
      deps(respond('{"verdicts":[{"index":7,"verdict":"confirmed","evidence":"nonsense"}]}')),
      { instructions: 'verify', requests: [req()], fileContent: () => 'file body' },
    );
    expect(out.results[0].verdict).toBe('error');
  });

  it('errors every finding in a file whose call fails, without throwing', async () => {
    const fetchFn = (async () =>
      ({ ok: false, status: 400, text: async () => 'nope' }) as unknown as Response) as unknown as typeof fetch;

    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other' })],
      fileContent: () => 'file body',
    });
    expect(out.results.map((r) => r.verdict)).toEqual(['error', 'error']);
  });

  it('errors every finding in a file whose body vanished, and spends nothing on it', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const out = await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => null,
    });
    expect(out.results[0].verdict).toBe('error');
    expect(out.usage.calls).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends the file body exactly once no matter how many findings it carries', async () => {
    let sent = '';
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      sent = init!.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"e"},{"index":2,"verdict":"confirmed","evidence":"e"}]}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyAll(deps(fetchFn), {
      instructions: 'verify',
      requests: [req({ id: 'f0' }), req({ id: 'f1', claim: 'other' })],
      fileContent: () => 'UNIQUE_BODY_MARKER',
    });
    expect(sent.split('UNIQUE_BODY_MARKER')).toHaveLength(2); // present exactly once
  });
  it('never throws even when the caller\'s fileContent callback itself throws', async () => {
    const out = await verifyAll(deps((async () => {
      throw new Error('should not be reached');
    }) as unknown as typeof fetch), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => {
        throw new Error('disk exploded');
      },
    });
    expect(out.results[0].verdict).toBe('error');
    expect(out.results[0].evidence).toContain('disk exploded');
  });
});

describe('verifyAll — billing of a completed but malformed call', () => {
  it('counts the usage of a 200 response whose content is not usable', async () => {
    const out = await verifyAll(deps(respond('not json at all')), {
      instructions: 'verify',
      requests: [req(), req({ id: 'f1', claim: 'other bug' })],
      fileContent: () => 'file body',
    });

    // The call happened and is billed; dropping its usage would make the
    // footer under-report money we actually spent.
    expect(out.usage.calls).toBe(1);
    expect(out.usage.promptTokens).toBe(100);
    expect(out.results.map((r) => r.verdict)).toEqual(['error', 'error']);
  });

  it('counts the usage of a 200 response that misses the verdict schema', async () => {
    const out = await verifyAll(deps(respond('{"verdicts":[{"index":1,"verdict":"maybe"}]}')), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => 'file body',
    });
    expect(out.usage.calls).toBe(1);
    expect(out.results[0].verdict).toBe('error');
  });
});
