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

  it('defaults both pass models and lets env override them independently', () => {
    const cfg = readConfig(full);
    expect(cfg.findModel).toBeTruthy();
    expect(cfg.verifyModel).toBeTruthy();

    const overridden = readConfig({
      ...full,
      AI_REVIEW_MODEL: 'find-x',
      AI_REVIEW_VERIFY_MODEL: 'verify-y',
    } as NodeJS.ProcessEnv);
    expect(overridden.findModel).toBe('find-x');
    expect(overridden.verifyModel).toBe('verify-y');
  });

  it('throws loudly when OPENAI_API_KEY is missing', () => {
    const { OPENAI_API_KEY, ...rest } = full;
    expect(() => readConfig(rest as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

import { upsertReview, wrapBody, MARKER } from './ai-pr-review';

describe('wrapBody', () => {
  it('embeds the hidden marker', () => {
    expect(wrapBody('hello')).toContain(MARKER);
    expect(wrapBody('hello')).toContain('hello');
  });
});

describe('upsertReview', () => {
  const ghDeps = (fetchFn: typeof fetch) => ({
    repo: 'o/r',
    prNumber: 7,
    token: 't',
    fetchFn,
  });

  it('creates a new top-level COMMENT review when none exists', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]); // list
      return jsonResponse({ id: 1 }); // create
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('x'))).resolves.toBe('created');
    const create = calls[1];
    expect(create.init?.method).toBe('POST');
    expect(JSON.parse(create.init!.body as string).event).toBe('COMMENT');
  });

  it('updates the existing marker review instead of stacking a new one', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        return jsonResponse([{ id: 42, body: `${MARKER}\nold`, user: { type: 'Bot' } }]);
      }
      return jsonResponse({ id: 42 });
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('new'))).resolves.toBe('updated');
    const update = calls[1];
    expect(update.init?.method).toBe('PUT');
    expect(update.url).toContain('/reviews/42');
  });

  it('fails loudly with status + body when the post is rejected', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse([]); // list ok
      return jsonResponse({ message: 'Forbidden' }, 403); // create rejected
    }) as unknown as typeof fetch;

    await expect(upsertReview(ghDeps(fetchFn), wrapBody('x'))).rejects.toThrow(
      /create review HTTP 403.*Forbidden/,
    );
  });
});
