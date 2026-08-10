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
      'extension/tests/fixtures/flasker.product.html',
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

import { DEFAULT_FIND_MODEL, DEFAULT_VERIFY_MODEL, readConfig } from './ai-pr-review';

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
    // Pinned to the exported constants so the replay tool, which imports the
    // same two, cannot end up measuring a configuration CI does not run.
    expect(cfg.findModel).toBe(DEFAULT_FIND_MODEL);
    expect(cfg.verifyModel).toBe(DEFAULT_VERIFY_MODEL);

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

import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readReviewableFile } from './ai-pr-review';

describe('readReviewableFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-symlink-'));

  it('reads a regular file', () => {
    const p = join(dir, 'real.ts');
    writeFileSync(p, 'export const a = 1;\n');
    expect(readReviewableFile(p)).toBe('export const a = 1;\n');
  });

  it('refuses to follow a symlink instead of shipping the target to the model', () => {
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'SUPER_SECRET_TOKEN\n');
    const link = join(dir, 'leak.ts');
    symlinkSync(secret, link);
    expect(readReviewableFile(link)).toBeNull();
  });

  it('returns null for a directory and for a missing path', () => {
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    expect(readReviewableFile(sub)).toBeNull();
    expect(readReviewableFile(join(dir, 'nope.ts'))).toBeNull();
  });
});

import { FAILURE_MARKER, findExistingReview, runReview, type ReviewDeps } from './ai-pr-review';
import { renderState } from './ai-review/state';

const CFG = {
  openaiApiKey: 'sk-test',
  openaiEndpoint: 'https://api.openai.com/v1',
  findModel: 'gpt-5.5',
  verifyModel: 'gpt-5.5',
  githubToken: 't',
  repo: 'o/r',
  prNumber: 7,
  baseRef: 'main',
  headRef: 'feature',
  prTitle: 'Title',
  prBody: 'Body',
};

const FILE_BODY = "function f() {\n  return 'not_found';\n}\n";
const DIFF = [
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' function f() {',
  "+  return 'not_found';",
  ' }',
].join('\n');

const FINDING = {
  file: 'src/a.ts',
  start_line: 2,
  end_line: 2,
  quote: "return 'not_found';",
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  confidence: 'high',
};

function openaiFetch(responses: string[]): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    const content = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      }),
      text: async () => content,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function deps(over: Partial<ReviewDeps> = {}): ReviewDeps {
  return {
    headSha: 'b'.repeat(40),
    hasCommit: () => true,
    isAncestor: () => true,
    listChangedFiles: () => ['src/a.ts'],
    getDiff: () => DIFF,
    readFile: () => FILE_BODY,
    readInstructions: () => 'instructions',
    log: () => {},
    openaiFetch: (undefined as unknown) as typeof fetch,
    githubFetch: (undefined as unknown) as typeof fetch,
    ...over,
  };
}

function githubFetch(existingBody: string | null): { fetchFn: typeof fetch; put: { body?: string } } {
  const put: { body?: string } = {};
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    if (!init || init.method === undefined) {
      return jsonResponse(
        existingBody === null ? [] : [{ id: 42, body: existingBody, user: { type: 'Bot' } }],
      );
    }
    put.body = JSON.parse(init.body as string).body;
    return jsonResponse({ id: 42 });
  }) as unknown as typeof fetch;
  return { fetchFn, put };
}

describe('runReview — full mode', () => {
  it('reviews the whole PR when there is no previous review and publishes the finding', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [FINDING] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'line 2 returns not_found' }] }),
    ]);
    const gh = githubFetch(null);

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toHaveLength(2); // one find, one verify
    expect(gh.put.body).toContain('merge reported as failure');
    expect(gh.put.body).toContain('ai-pr-review-state');
  });

  it('posts a PR failure comment and still rejects when OpenAI returns an empty completion', async () => {
    const ai = openaiFetch(['']);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) return jsonResponse([]);
      return jsonResponse({ id: 1 });
    }) as unknown as typeof fetch;

    await expect(
      runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch })),
    ).rejects.toThrow('OpenAI returned an empty completion');

    const comment = calls.find(({ url }) => url.endsWith('/issues/7/comments'));
    expect(comment?.init?.method).toBe('POST');
    const body = JSON.parse(comment!.init!.body as string).body;
    expect(body).toContain(FAILURE_MARKER);
    expect(body).toContain('AI PR Review failed');
    expect(body).toContain('OpenAI returned an empty completion');
    expect(body).toContain('b'.repeat(40));
    expect(body).toContain('No new AI review was published for this run.');
    expect(body).not.toContain('this PR has not received an AI review');
  });

  it('reuses the failure marker comment across identical failed reruns', async () => {
    const issueComments: Array<{ id: number; body: string; user: { type: string } }> = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method === undefined) {
        if (url.includes('/pulls/7/reviews')) return jsonResponse([]);
        return jsonResponse(issueComments);
      }
      const body = JSON.parse(init.body as string).body;
      if (init.method === 'POST') {
        issueComments.push({ id: 99, body, user: { type: 'Bot' } });
      } else if (init.method === 'PATCH') {
        issueComments[0].body = body;
      }
      return jsonResponse({ id: 99, body });
    }) as unknown as typeof fetch;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ai = openaiFetch(['']);
      await expect(
        runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch })),
      ).rejects.toThrow('OpenAI returned an empty completion');
    }

    const writes = calls.filter(({ init }) => init?.method === 'POST' || init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0].init?.method).toBe('POST');
    expect(issueComments).toHaveLength(1);
  });

  it('keeps the original review error when posting the failure comment also fails', async () => {
    const ai = openaiFetch(['']);
    const logs: string[] = [];
    let failureSignal: AbortSignal | null | undefined;
    const githubFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse([]);
      failureSignal = init.signal;
      return jsonResponse({ message: 'Forbidden' }, 403);
    }) as unknown as typeof fetch;

    await expect(
      runReview(CFG, deps({
        openaiFetch: ai.fetchFn,
        githubFetch,
        log: (message) => logs.push(message),
      })),
    ).rejects.toThrow('OpenAI returned an empty completion');
    expect(failureSignal).toBeInstanceOf(AbortSignal);
    expect(logs.some((message) => message.includes('failure comment could not be posted'))).toBe(
      true,
    );
  });
});

describe('runReview — republish mode', () => {
  it('re-posts the previous body byte-for-byte and calls OpenAI zero times', async () => {
    const previous = `${MARKER}\n\nold body\n\n${renderState({
      v: 1,
      head: 'b'.repeat(40),
      findings: [],
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
    })}`;
    const ai = openaiFetch(['{}']);
    const gh = githubFetch(previous);

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toEqual([]);
    expect(gh.put.body).toBe(previous);
  });
});

describe('runReview — incremental mode', () => {
  const previousState = (findings: unknown[]) =>
    `${MARKER}\n\nold\n\n${renderState({
      v: 1,
      head: 'a'.repeat(40),
      findings: findings as never,
      spend: { usd: 0.1, runs: 1, unpriced: 0 },
    })}`;

  const carried = {
    file: 'src/a.ts',
    quote: "return 'not_found';",
    matchedLine: 2,
    matchedEndLine: 2,
    claim: 'merge reported as failure',
    why_it_breaks: 'cron stats count a success as a miss',
    severity: 'P1',
    evidence: 'line 2 returns not_found',
  };

  it('diffs from the stored head, not from the base branch', async () => {
    const seen: string[] = [];
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: (spec) => {
          seen.push(spec);
          return ['src/a.ts'];
        },
        getDiff: (spec) => {
          seen.push(spec);
          return DIFF;
        },
      }),
    );
    expect(seen.every((s) => s === `${'a'.repeat(40)}..HEAD`)).toBe(true);
  });

  it('carries a still-anchored finding for free and does not re-publish it twice', async () => {
    // The find pass re-raises the very same finding; the gate must swallow it.
    const ai = openaiFetch([JSON.stringify({ findings: [FINDING] })]);
    const gh = githubFetch(previousState([carried]));

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    expect(ai.calls).toHaveLength(1); // find only — nothing to verify
    // Counted in the visible body only: the state block repeats every open
    // finding verbatim by design, so a whole-body count can never be 1.
    const visible = gh.put.body!.split('<!-- ai-pr-review-state')[0];
    expect(visible.split('merge reported as failure')).toHaveLength(2);
    expect(gh.put.body).toContain('carried');
  });

  it('closes a finding whose quoted code was edited away and re-adjudicated as fixed', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'refuted', evidence: 'the function now returns merged' }] }),
    ]);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => "function f() {\n  return 'merged';\n}\n",
      }),
    );

    expect(gh.put.body).toContain('Closed by this push');
    expect(gh.put.body).toContain('No verified findings');
  });

  it('keeps a re-checked finding open when the verifier confirms the fix did not close it', async () => {
    const ai = openaiFetch([
      JSON.stringify({ findings: [] }),
      JSON.stringify({ verdicts: [{ index: 1, verdict: 'confirmed', evidence: 'still returns not_found via the helper' }] }),
    ]);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => 'function f() {\n  return helper();\n}\n',
      }),
    );
    expect(gh.put.body).toContain('the fix did not close this');
  });

  it('keeps a re-checked finding open when its verification errors, unlike a fresh one', async () => {
    const ai = {
      calls: [] as string[],
      fetchFn: (async (url: string, init?: RequestInit) => {
        ai.calls.push(url);
        if (ai.calls.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
              usage: { prompt_tokens: 10, completion_tokens: 1 },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 400, text: async () => 'boom' } as unknown as Response;
      }) as unknown as typeof fetch,
    };
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        readFile: () => 'function f() {\n  return helper();\n}\n',
      }),
    );
    expect(gh.put.body).toContain('merge reported as failure');
    expect(gh.put.body).toMatch(/unverified this run/i);
  });

  it('skips the find call entirely when the push touched no reviewable file', async () => {
    const ai = openaiFetch(['{}']);
    const gh = githubFetch(previousState([carried]));

    await runReview(
      CFG,
      deps({
        openaiFetch: ai.fetchFn,
        githubFetch: gh.fetchFn,
        listChangedFiles: () => ['docs/guide.md'],
      }),
    );
    expect(ai.calls).toEqual([]);
    expect(gh.put.body).toContain('merge reported as failure'); // still published
  });

  it('accumulates the PR spend across runs in the state block', async () => {
    const ai = openaiFetch([JSON.stringify({ findings: [] })]);
    const gh = githubFetch(previousState([]));

    await runReview(CFG, deps({ openaiFetch: ai.fetchFn, githubFetch: gh.fetchFn }));

    const state = parseStateFromBody(gh.put.body!);
    expect(state.spend.runs).toBe(2);
    expect(state.spend.usd).toBeGreaterThan(0.1);
  });
});

import { parseState } from './ai-review/state';
function parseStateFromBody(body: string) {
  const s = parseState(body);
  if (!s) throw new Error('no state in body');
  return s;
}

describe('findExistingReview', () => {
  it('returns the bot marker review so the body is read once and reused by the upsert', async () => {
    const gh = githubFetch(`${MARKER}\nbody here`);
    const found = await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: gh.fetchFn });
    expect(found).toEqual({ id: 42, body: `${MARKER}\nbody here` });
  });

  it('returns null when the bot has never reviewed this PR', async () => {
    const gh = githubFetch(null);
    const found = await findExistingReview({ repo: 'o/r', prNumber: 7, token: 't', fetchFn: gh.fetchFn });
    expect(found).toBeNull();
  });
});
