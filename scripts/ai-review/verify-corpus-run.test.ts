import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from './usage';
import { groupEntries, runDraw } from './verify-corpus-run';
import type { CorpusEntry } from './verify-corpus';

const entry = (over: Partial<CorpusEntry>): CorpusEntry => ({
  id: 'x',
  provenance: 'harvested',
  source: 's',
  sha: 'aaa',
  file: 'src/a.ts',
  matchedLine: 1,
  matchedEndLine: 1,
  quote: 'q',
  claim: 'c',
  quoteOrigin: 'original',
  why_it_breaks: 'w',
  expected: 'confirmed',
  why_expected: 'because',
  ...over,
});

describe('groupEntries', () => {
  it('puts two entries on one (sha, file) in the same group', () => {
    const groups = groupEntries([entry({ id: 'a' }), entry({ id: 'b' })]);
    expect(groups.length).toBe(1);
    expect(groups[0].entries.map((e) => e.id)).toEqual(['a', 'b']);
  });

  // The whole point of the pair key. The same path at two shas is two different
  // file bodies, so judging both against one body would guarantee a wrong answer.
  it('splits the same file at different shas into two groups', () => {
    const groups = groupEntries([entry({ id: 'a', sha: 'aaa' }), entry({ id: 'b', sha: 'bbb' })]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.sha).sort()).toEqual(['aaa', 'bbb']);
  });

  it('splits different files at the same sha into two groups', () => {
    const groups = groupEntries([entry({ id: 'a', file: 'src/a.ts' }), entry({ id: 'b', file: 'src/b.ts' })]);
    expect(groups.length).toBe(2);
  });
});

describe('runDraw', () => {
  const okVerify = (byIndex: Record<number, 'confirmed' | 'refuted' | 'out_of_scope'>) =>
    (async (_deps: unknown, p: { requests: Array<{ id: string }> }) => ({
      results: p.requests.map((r, i) => ({
        id: r.id,
        verdict: byIndex[i + 1] ?? 'confirmed',
        evidence: `e${i + 1}`,
      })),
      usage: { ...EMPTY_USAGE, calls: 1, promptTokens: 10, completionTokens: 2 },
    })) as never;

  const deps = { endpoint: 'e', apiKey: 'k', model: 'm' };

  it('scores an entry correct when the verdict matches the expectation', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'confirmed' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: okVerify({ 1: 'confirmed' }),
      deps,
    });
    expect(out.outcomes).toEqual([
      { id: 'a', expected: 'confirmed', actual: 'confirmed', correct: true, evidence: 'e1', provenance: 'harvested' },
    ]);
  });

  it('scores an entry wrong when the verdict differs', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'refuted' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: okVerify({ 1: 'confirmed' }),
      deps,
    });
    expect(out.outcomes[0].correct).toBe(false);
  });

  // #691's lesson: a harness failure made a candidate look blind. An `error` is
  // not the model answering wrongly, so it must not be scored as a wrong answer.
  it('marks an error neither correct nor incorrect', async () => {
    const errorVerify = (async (_d: unknown, p: { requests: Array<{ id: string }> }) => ({
      results: p.requests.map((r) => ({ id: r.id, verdict: 'error' as const, evidence: 'empty completion' })),
      usage: { ...EMPTY_USAGE, calls: 1 },
    })) as never;

    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'refuted' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: errorVerify,
      deps,
    });
    expect(out.outcomes[0].actual).toBe('error');
    expect(out.outcomes[0].correct).toBe(false);
  });

  // Each group must see ITS OWN sha's body. If the runner passed one body to both,
  // one of the two answers would be judged against the wrong code.
  it('gives each group the body of its own sha', async () => {
    const seen: string[] = [];
    const spy = (async (_d: unknown, p: { fileContent: (path: string) => string | null; requests: Array<{ id: string; file: string }> }) => {
      seen.push(p.fileContent(p.requests[0].file) ?? 'null');
      return {
        results: p.requests.map((r) => ({ id: r.id, verdict: 'confirmed' as const, evidence: 'e' })),
        usage: { ...EMPTY_USAGE, calls: 1 },
      };
    }) as never;

    await runDraw({
      entries: [entry({ id: 'a', sha: 'aaa' }), entry({ id: 'b', sha: 'bbb' })],
      instructions: 'verify',
      readBody: (sha) => `body-of-${sha}`,
      verify: spy,
      deps,
    });

    expect(seen.sort()).toEqual(['body-of-aaa', 'body-of-bbb']);
  });

  it('sums usage across groups', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a', sha: 'aaa' }), entry({ id: 'b', sha: 'bbb' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: okVerify({}),
      deps,
    });
    expect(out.usage.calls).toBe(2);
  });

  it('reports an unreadable body as an error rather than throwing', async () => {
    const out = await runDraw({
      entries: [entry({ id: 'a' })],
      instructions: 'verify',
      readBody: () => null,
      verify: okVerify({}),
      deps,
    });
    expect(out.outcomes[0].actual).toBe('error');
  });
});
