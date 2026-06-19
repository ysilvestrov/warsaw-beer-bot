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
