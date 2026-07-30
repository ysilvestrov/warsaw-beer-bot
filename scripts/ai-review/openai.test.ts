import { callStructured, NonRetryableError } from './openai';

const SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  fetchFn,
  sleep: async () => {},
});

const ok = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

describe('callStructured', () => {
  it('sends max_completion_tokens and never max_tokens or temperature', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return ok('{}');
    }) as unknown as typeof fetch;

    await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });

    expect(body.max_completion_tokens).toBe(8000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'review', strict: true, schema: SCHEMA },
    });
  });

  it('returns the completion content on success', async () => {
    const fetchFn = (async () => ok('{"a":1}')) as unknown as typeof fetch;
    const out = await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });
    expect(out.content).toBe('{"a":1}');
  });

  it('retries a 500 then succeeds', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, text: async () => 'boom' } as unknown as Response;
      return ok('{}');
    }) as unknown as typeof fetch;

    await callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
      name: 'review',
      schema: SCHEMA,
    });
    expect(calls).toBe(2);
  });

  it('does not retry a 400 and surfaces the API message', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        text: async () => "Unsupported parameter: 'max_tokens'",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA,
      }),
    ).rejects.toThrow(/Unsupported parameter/);
    expect(calls).toBe(1);
  });

  it('treats an empty completion as non-retryable', async () => {
    const fetchFn = (async () =>
      ({ ok: true, status: 200, json: async () => ({ choices: [] }) }) as unknown as Response) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA,
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe('callStructured — 429 handling', () => {
  const SCHEMA429 = { type: 'object', properties: {}, additionalProperties: false };

  it('does not retry an exhausted quota and names it plainly', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        text: async () =>
          '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA429,
      }),
    ).rejects.toThrow(/quota exhausted/);
    expect(calls).toBe(1);
  });

  it('still retries a genuine rate limit and surfaces the body', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return {
        ok: false,
        status: 429,
        text: async () => '{"error":{"code":"rate_limit_exceeded"}}',
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      callStructured(deps(fetchFn), [{ role: 'user', content: 'hi' }], {
        name: 'review',
        schema: SCHEMA429,
      }),
    ).rejects.toThrow(/rate_limit_exceeded/);
    expect(calls).toBe(3);
  });
});

import { callStructured as callWithUsage } from './openai';

describe('callStructured usage', () => {
  const schema = { type: 'object', additionalProperties: false, required: [], properties: {} };

  it('returns the usage block alongside the content', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{}' } }],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 128 },
            completion_tokens_details: { reasoning_tokens: 32 },
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await callWithUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      [{ role: 'user', content: 'hi' }],
      { name: 'x', schema },
    );
    expect(out.content).toBe('{}');
    expect(out.usage).toEqual({
      calls: 1,
      promptTokens: 900,
      cachedTokens: 128,
      completionTokens: 40,
      reasoningTokens: 32,
    });
  });

  it('still returns a counted call when the response omits usage', async () => {
    const fetchFn = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{}' } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const out = await callWithUsage(
      { endpoint: 'https://api.openai.com/v1', apiKey: 'sk', model: 'gpt-5.5', fetchFn, sleep: async () => {} },
      [{ role: 'user', content: 'hi' }],
      { name: 'x', schema },
    );
    expect(out.usage.calls).toBe(1);
    expect(out.usage.promptTokens).toBe(0);
  });
});
