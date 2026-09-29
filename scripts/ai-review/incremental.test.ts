import { decideMode, incrementalScope } from './incremental';
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

  it('names the PR\'s own diff in every mode, so the runner can scope an incremental pass', () => {
    const specs = [
      decideMode({ state: null, headSha: HEAD, baseRef: 'main', ...deps() }).prSpec,
      decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps({ hasCommit: () => false }) }).prSpec,
      decideMode({ state: state({ head: HEAD }), headSha: HEAD, baseRef: 'main', ...deps() }).prSpec,
      decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps({ isAncestor: () => false }) }).prSpec,
      decideMode({ state: state(), headSha: HEAD, baseRef: 'main', ...deps() }).prSpec,
    ];
    expect(specs).toEqual(['origin/main...HEAD', 'origin/main...HEAD', 'origin/main...HEAD', 'origin/main...HEAD', 'origin/main...HEAD']);
  });
});

describe('incrementalScope', () => {
  it('drops every file a merge from the base brought in (replay of PR #741, 62570a7..51aca4d)', () => {
    const sinceStored = [
      'docs/superpowers/plans/2026-09/2026-09-29-739-cross-review-diagnosis.md',
      'docs/superpowers/specs/2026-09/2026-09-29-739-cross-review-diagnosis-design.md',
      'docs/superpowers/specs/2026-09/2026-09-29-cross-review-design.md',
      'scripts/cross-review/cli.ts',
      'scripts/cross-review/core.test.ts',
      'scripts/cross-review/core.ts',
    ];
    const prFiles = ['src/domain/brewery-aliases.test.ts', 'src/domain/brewery-aliases.ts'];
    expect(incrementalScope(sinceStored, prFiles)).toEqual({ inScope: [], mergedIn: sinceStored });
  });

  it('keeps an ordinary push exactly as it was (author commits touch only PR files)', () => {
    expect(incrementalScope(['src/b.ts', 'src/a.ts'], ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual({
      inScope: ['src/b.ts', 'src/a.ts'],
      mergedIn: [],
    });
  });

  it('splits a mixed push, preserving the order of the since-stored list', () => {
    expect(incrementalScope(['scripts/x.ts', 'src/a.ts', 'docs/y.md', 'src/b.ts'], ['src/b.ts', 'src/a.ts'])).toEqual({
      inScope: ['src/a.ts', 'src/b.ts'],
      mergedIn: ['scripts/x.ts', 'docs/y.md'],
    });
  });

  it('a file reverted back to the base is out of the PR and out of scope', () => {
    expect(incrementalScope(['src/a.ts'], [])).toEqual({ inScope: [], mergedIn: ['src/a.ts'] });
  });

  it('nothing changed since the stored head means nothing in scope', () => {
    expect(incrementalScope([], ['src/a.ts'])).toEqual({ inScope: [], mergedIn: [] });
  });
});

import { reconcileFindings } from './incremental';
import type { StoredFinding } from './state';

const stored = (over: Partial<StoredFinding> = {}): StoredFinding => ({
  file: 'src/a.ts',
  quote: "return 'not_found';",
  matchedLine: 3,
  matchedEndLine: 3,
  claim: 'merge reported as failure',
  why_it_breaks: 'cron stats count a success as a miss',
  severity: 'P1',
  evidence: 'line 3 returns not_found',
  ...over,
});

describe('reconcileFindings', () => {
  it('carries a finding whose quote is still there, refreshing its line numbers', () => {
    const content = ['// a new line on top', 'function f() {', "  return 'not_found';", '}'].join('\n');
    const out = reconcileFindings({ stored: [stored()], fileContent: () => content });
    expect(out.carried).toHaveLength(1);
    expect(out.carried[0].matchedLine).toBe(3);
    expect(out.carried[0].matchedEndLine).toBe(3);
    expect(out.recheck).toEqual([]);
    expect(out.closed).toEqual([]);
  });

  it('closes a finding whose file was deleted or became unreadable', () => {
    const out = reconcileFindings({ stored: [stored()], fileContent: () => null });
    expect(out.closed).toEqual([{ finding: stored(), reason: 'obsolete' }]);
    expect(out.carried).toEqual([]);
    expect(out.recheck).toEqual([]);
  });

  it('queues a re-check when the quoted code was edited away', () => {
    const out = reconcileFindings({
      stored: [stored()],
      fileContent: () => "function f() {\n  return 'merged';\n}",
    });
    expect(out.recheck).toHaveLength(1);
    expect(out.carried).toEqual([]);
  });

  it('re-anchors to the occurrence nearest the stored line when the quote repeats', () => {
    const content = [
      "  return 'not_found';", // line 1
      'const filler = 0;',
      "  return 'not_found';", // line 3
    ].join('\n');
    const out = reconcileFindings({ stored: [stored({ matchedLine: 3 })], fileContent: () => content });
    expect(out.carried[0].matchedLine).toBe(3);
  });

  it('handles a mixed batch across several files', () => {
    const a = stored({ file: 'src/a.ts', quote: 'const a = 1;' });
    const b = stored({ file: 'src/b.ts', quote: 'const b = 2;' });
    const c = stored({ file: 'src/c.ts', quote: 'const c = 3;' });
    const out = reconcileFindings({
      stored: [a, b, c],
      fileContent: (path) => {
        if (path === 'src/a.ts') return 'const a = 1;';
        if (path === 'src/b.ts') return 'const b = 99;';
        return null;
      },
    });
    expect(out.carried.map((f) => f.file)).toEqual(['src/a.ts']);
    expect(out.recheck.map((f) => f.file)).toEqual(['src/b.ts']);
    expect(out.closed.map((c) => c.finding.file)).toEqual(['src/c.ts']);
  });
});
