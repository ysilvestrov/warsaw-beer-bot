import { filterReviewableFiles, globToRegExp } from './ai-pr-review';

describe('globToRegExp', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/deep/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a.js')).toBe(false);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/ci.yml')).toBe(true);
    expect(globToRegExp('.github/workflows/*.yml').test('.github/workflows/sub/ci.yml')).toBe(false);
  });
});

describe('filterReviewableFiles', () => {
  it('keeps in-scope source files and drops ignored/out-of-scope ones', () => {
    const input = [
      'src/a.ts',
      'tests/b.ts',
      'scripts/c.ts',
      'extension/d.ts',
      '.github/workflows/ci.yml',
      'src/e.js',
      'README.md',
      'spec.md',
      'docs/guide.md',
      'package-lock.json',
    ];
    expect(filterReviewableFiles(input)).toEqual([
      'src/a.ts',
      'tests/b.ts',
      'scripts/c.ts',
      'extension/d.ts',
      '.github/workflows/ci.yml',
    ]);
  });
});

import { readConfig } from './ai-pr-review';

describe('readConfig', () => {
  const full = {
    OPENAI_API_KEY: 'sk-test',
    GITHUB_TOKEN: 'ghs-test',
    REPO: 'ysilvestrov/warsaw-beer-bot',
    PR_NUMBER: '173',
    BASE_REF: 'main',
    HEAD_REF: 'feature',
    PR_TITLE: 'Title',
    PR_BODY: 'Body',
  } as NodeJS.ProcessEnv;

  it('reads a full env and defaults the endpoint', () => {
    const cfg = readConfig(full);
    expect(cfg.openaiEndpoint).toBe('https://api.openai.com/v1');
    expect(cfg.prNumber).toBe(173);
    expect(cfg.repo).toBe('ysilvestrov/warsaw-beer-bot');
  });

  it('throws loudly when OPENAI_API_KEY is missing', () => {
    const { OPENAI_API_KEY, ...rest } = full;
    expect(() => readConfig(rest as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
  });
});

import { truncateDiff, buildMessages } from './ai-pr-review';

describe('truncateDiff', () => {
  it('returns the diff unchanged when within budget', () => {
    expect(truncateDiff('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
  it('cuts to the budget and flags truncation when over', () => {
    expect(truncateDiff('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
  });
});

describe('buildMessages', () => {
  it('puts instructions in system and PR context + diff in user, noting truncation', () => {
    const msgs = buildMessages({
      instructions: 'REVIEW RULES',
      prTitle: 'My PR',
      prBody: 'desc',
      baseRef: 'main',
      headRef: 'feat',
      diff: 'diff-body',
      truncated: true,
    });
    expect(msgs[0]).toEqual({ role: 'system', content: 'REVIEW RULES' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[1].content).toContain('Title: My PR');
    expect(msgs[1].content).toContain('diff-body');
    expect(msgs[1].content).toContain('truncated');
  });
});

import { callOpenAI } from './ai-pr-review';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const completion = { choices: [{ message: { content: 'LGTM' } }] };
const deps = (fetchFn: typeof fetch) => ({
  endpoint: 'https://api.openai.com/v1',
  apiKey: 'sk',
  fetchFn,
  sleep: async () => {},
});

describe('callOpenAI', () => {
  it('returns the completion content on success', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(completion)) as unknown as typeof fetch;
    await expect(callOpenAI(deps(fetchFn), [])).resolves.toBe('LGTM');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse(completion)) as unknown as typeof fetch;
    await expect(callOpenAI(deps(fetchFn), [])).resolves.toBe('LGTM');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('fails loudly after exhausting retries on persistent 429', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 429)) as unknown as typeof fetch;
    await expect(callOpenAI({ ...deps(fetchFn), attempts: 3 }, [])).rejects.toThrow(/429|attempts/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 401 auth error', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401)) as unknown as typeof fetch;
    await expect(callOpenAI(deps(fetchFn), [])).rejects.toThrow(/401/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
