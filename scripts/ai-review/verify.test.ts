import { EMPTY_USAGE } from './usage';
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

  // #691, measured in production: the two cases above RETURN an error, so their
  // usage survives by the ordinary path. An empty completion THROWS, and the
  // throw used to take the token count with it — the tokens were paid for and
  // absent from the footer. Seen 3 times in 12 replay draws, always on a large
  // file, where the whole completion budget went to reasoning.
  it('counts the usage of a completed call that returned no content at all', async () => {
    const emptyWithUsage = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: {} }],
          usage: { prompt_tokens: 7100, completion_tokens: 2400 },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await verifyAll(deps(emptyWithUsage), {
      instructions: 'verify',
      requests: [req(), req({ id: 'f1', claim: 'other bug' })],
      fileContent: () => 'file body',
    });

    expect(out.usage.calls).toBe(1);
    expect(out.usage.promptTokens).toBe(7100);
    expect(out.usage.completionTokens).toBe(2400);
    expect(out.results.map((r) => r.verdict)).toEqual(['error', 'error']);
  });

  // A transport failure reports no tokens, so nothing may be added for it. This
  // is the pair to the test above: the fix must add real usage without inventing
  // usage where the API never gave any.
  it('adds nothing for a failure that never reported tokens', async () => {
    const boom = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const out = await verifyAll({ ...deps(boom), attempts: 1 }, {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => 'file body',
    });

    expect(out.usage).toEqual(EMPTY_USAGE);
    expect(out.results[0].verdict).toBe('error');
  });
});

describe('verifyAll — completion budget', () => {
  // The default must not move: production behaviour is out of scope for this change.
  it('asks for max(MIN_VERIFY_TOKENS, n * TOKENS_PER_VERDICT) when no budget is given', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"x"},{"index":2,"verdict":"confirmed","evidence":"y"}]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyAll(deps(capture), {
      instructions: 'verify',
      requests: [req(), req({ id: 'f1' })],
      fileContent: () => 'body',
    });

    // 2 requests * 1200 = 2400, which is above MIN_VERIFY_TOKENS (2000).
    expect(body.max_completion_tokens).toBe(2400);
  });

  it('uses the caller\'s budget when one is given', async () => {
    let body: Record<string, unknown> = {};
    const capture = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdicts":[{"index":1,"verdict":"confirmed","evidence":"x"}]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await verifyAll(deps(capture), {
      instructions: 'verify',
      requests: [req()],
      fileContent: () => 'body',
      maxCompletionTokens: 8000,
    });

    expect(body.max_completion_tokens).toBe(8000);
  });
});
