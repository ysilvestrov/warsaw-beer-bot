import { decideMode } from './incremental';
import type { ReviewState } from './state';

const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(40);

const state = (over: Partial<ReviewState> = {}): ReviewState => ({
  v: 1,
  head: OLD,
  findings: [],
  spend: { usd: 0, runs: 1, unpriced: 0 },
  ...over,
});

const deps = (over: Partial<{ hasCommit: (s: string) => boolean; isAncestor: (a: string, b: string) => boolean }> = {}) => ({
  hasCommit: () => true,
  isAncestor: () => true,
  ...over,
});

describe('decideMode', () => {
  it('reviews in full when there is no previous state', () => {
    const d = decideMode({ state: null, headSha: HEAD, baseRef: 'main', ...deps() });
    expect(d.mode).toBe('full');
    expect(d.diffSpec).toBe('origin/main...HEAD');
    expect(d.reason).toMatch(/no previous review/i);
  });

  it('reviews in full when the stored head is not in this clone', () => {
    const d = decideMode({
      state: state(),
      headSha: HEAD,
      baseRef: 'main',
      ...deps({ hasCommit: () => false }),
    });
    expect(d.mode).toBe('full');
    expect(d.diffSpec).toBe('origin/main...HEAD');
    expect(d.reason).toContain(OLD);
  });

  it('republishes without any API call when HEAD has not moved', () => {
    const d = decideMode({ state: state({ head: HEAD }), headSha: HEAD, baseRef: 'main', ...deps() });
    expect(d.mode).toBe('republish');
  });

  it('checks equality before ancestry, so a re-run never becomes an empty incremental', () => {
    const d = decideMode({
      state: state({ head: HEAD }),
      headSha: HEAD,
      baseRef: 'main',
      ...deps({ isAncestor: () => true }),
    });
    expect(d.mode).toBe('republish');
  });

  it('reviews in full after a rebase or force-push', () => {
    const d = decideMode({
      state: state(),
      headSha: HEAD,
      baseRef: 'main',
      ...deps({ isAncestor: () => false }),
    });
    expect(d.mode).toBe('full');
    expect(d.reason).toMatch(/rebase|force-push/i);
  });

  it('reviews incrementally from the stored head on an ordinary push', () => {
    const d = decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps() });
    expect(d.mode).toBe('incremental');
    expect(d.diffSpec).toBe(`${OLD}..HEAD`);
  });
});
