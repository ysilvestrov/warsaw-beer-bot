import { ensureHeadCommit, replayModels } from './replay';
import { readConfig } from '../ai-pr-review';

describe('replayModels', () => {
  const prodEnv = {
    OPENAI_API_KEY: 'sk-test',
    GITHUB_TOKEN: 'ghs-test',
    REPO: 'ysilvestrov/warsaw-beer-bot',
    PR_NUMBER: '1',
    BASE_REF: 'main',
  } as NodeJS.ProcessEnv;

  // Replay exists to measure the configuration CI actually runs. If the two
  // default sets drift apart it silently measures something else.
  it('defaults to exactly the models the production reviewer defaults to', () => {
    const prod = readConfig(prodEnv);
    expect(replayModels({} as NodeJS.ProcessEnv)).toEqual({
      findModel: prod.findModel,
      verifyModel: prod.verifyModel,
    });
  });

  it('honours the same env overrides as the production reviewer', () => {
    expect(
      replayModels({
        AI_REVIEW_MODEL: 'find-x',
        AI_REVIEW_VERIFY_MODEL: 'verify-y',
      } as NodeJS.ProcessEnv),
    ).toEqual({ findModel: 'find-x', verifyModel: 'verify-y' });
  });
});

describe('ensureHeadCommit', () => {
  const spy = () => {
    const calls: string[] = [];
    return { calls, fn: (m: string) => calls.push(m) };
  };

  it('does nothing when the head commit is already local', () => {
    const fetched = spy();
    const log = spy();
    ensureHeadCommit({
      pr: '352',
      head: 'abc123',
      hasCommit: () => true,
      fetchHead: () => fetched.fn('fetch'),
      log: log.fn,
    });
    expect(fetched.calls).toEqual([]);
    expect(log.calls).toEqual([]);
  });

  it('fetches the PR head when the object is missing and says so', () => {
    const log = spy();
    let fetches = 0;
    ensureHeadCommit({
      pr: '352',
      head: 'abc123',
      hasCommit: () => fetches > 0,
      fetchHead: () => {
        fetches += 1;
      },
      log: log.fn,
    });
    expect(fetches).toBe(1);
    expect(log.calls.join('\n')).toContain('pull/352/head');
  });

  it('fails loudly when the fetch does not produce the head commit', () => {
    expect(() =>
      ensureHeadCommit({
        pr: '352',
        head: 'abc123',
        hasCommit: () => false,
        fetchHead: () => undefined,
        log: () => undefined,
      }),
    ).toThrow(/abc123/);
  });

  it('reports the failing fetch instead of a bare git error', () => {
    expect(() =>
      ensureHeadCommit({
        pr: '352',
        head: 'abc123',
        hasCommit: () => false,
        fetchHead: () => {
          throw new Error('fatal: could not read from remote');
        },
        log: () => undefined,
      }),
    ).toThrow(/pull\/352\/head/);
  });
});

import { resolveReplayBase } from './replay';

describe('resolveReplayBase', () => {
  it('uses the merge-base with the PR base branch by default', () => {
    const base = resolveReplayBase({
      explicit: undefined,
      baseRefName: 'main',
      head: 'head-sha',
      mergeBase: (a, b) => `merge-base(${a},${b})`,
    });
    expect(base).toBe('merge-base(origin/main,head-sha)');
  });

  it('uses an explicit base verbatim so an incremental push can be replayed', () => {
    const base = resolveReplayBase({
      explicit: 'abc123',
      baseRefName: 'main',
      head: 'head-sha',
      mergeBase: () => 'should-not-be-called',
    });
    expect(base).toBe('abc123');
  });
});

import { resolveReplayArgs } from './replay';

describe('resolveReplayArgs', () => {
  it('reads a bare PR number', () => {
    expect(resolveReplayArgs(['418'])).toEqual({ pr: '418' });
  });

  it('keeps the positional base-sha working', () => {
    expect(resolveReplayArgs(['418', 'abc123'])).toEqual({ pr: '418', explicitBase: 'abc123' });
  });

  it('takes --head before or after the positionals without eating them', () => {
    expect(resolveReplayArgs(['418', '--head', 'deadbee'])).toEqual({
      pr: '418',
      headOverride: 'deadbee',
    });
    expect(resolveReplayArgs(['--head', 'deadbee', '418', 'abc123'])).toEqual({
      pr: '418',
      explicitBase: 'abc123',
      headOverride: 'deadbee',
    });
  });

  it('rejects --head with no value rather than silently replaying the merged head', () => {
    expect(() => resolveReplayArgs(['418', '--head'])).toThrow('--head needs a commit sha');
  });

  it('rejects a missing PR number', () => {
    expect(() => resolveReplayArgs([])).toThrow('usage:');
  });

  it('rejects an unrecognised --flag instead of silently treating it as a positional base-sha', () => {
    expect(() => resolveReplayArgs(['418', '--head=deadbee'])).toThrow(
      'unrecognised option: --head=deadbee',
    );
    expect(() => resolveReplayArgs(['--base', 'abc123', '418'])).toThrow(
      'unrecognised option: --base',
    );
  });

  it('still allows extra positionals and lets the last --head win', () => {
    expect(resolveReplayArgs(['418', 'abc123', 'extra'])).toEqual({
      pr: '418',
      explicitBase: 'abc123',
    });
    expect(
      resolveReplayArgs(['418', '--head', 'first', '--head', 'second']),
    ).toEqual({ pr: '418', headOverride: 'second' });
  });
});
