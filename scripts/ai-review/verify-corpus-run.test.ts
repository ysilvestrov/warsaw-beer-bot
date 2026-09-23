import { describe, expect, it } from 'vitest';
import { EMPTY_USAGE } from './usage';
import { gitBody, groupEntries, runDraw } from './verify-corpus-run';
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

describe('gitBody', () => {
  // A commit already in the repo's own history, so this test needs no network
  // and cannot flake. `gitBody`'s two arguments are `(sha, file)` — swapped,
  // every entry in a real run would come back null and the whole corpus would
  // report `error`, which reads as a catastrophic judge failure rather than the
  // one-line bug it is. This pins the argument order directly.
  const SHA = '584aa66183e55e4371819c9c5b19b2662ddaa6a2';

  it('reads a file that exists at a pinned sha', () => {
    const body = gitBody(SHA, 'src/domain/triage-plan.ts');
    expect(body).not.toBeNull();
    expect(body).toContain('PlannedNewIssue');
  });

  it('returns null, not a throw, for a path absent at that sha', () => {
    expect(() => gitBody(SHA, 'scripts/ai-review/verify-corpus.ts')).not.toThrow();
    expect(gitBody(SHA, 'scripts/ai-review/verify-corpus.ts')).toBeNull();
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
    expect(out.outcomes[0].correct).toBe(false);
  });

  // Two entries on the same group: the stub answers in an order that differs
  // from request order, and the two entries have opposite `expected` values.
  // An index-based (rather than id-based) lookup would swap the verdicts and
  // score both entries wrong; only id-matching scores both correct.
  it('maps verdicts back to entries by id, not by request order', async () => {
    const reversedOrderVerify = (async (_d: unknown, _p: { requests: Array<{ id: string }> }) => ({
      results: [
        { id: 'b', verdict: 'refuted' as const, evidence: 'eb' },
        { id: 'a', verdict: 'confirmed' as const, evidence: 'ea' },
      ],
      usage: { ...EMPTY_USAGE, calls: 1 },
    })) as never;

    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'confirmed' }), entry({ id: 'b', expected: 'refuted' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: reversedOrderVerify,
      deps,
    });

    const byId = Object.fromEntries(out.outcomes.map((o) => [o.id, o]));
    expect(byId.a.actual).toBe('confirmed');
    expect(byId.a.correct).toBe(true);
    expect(byId.b.actual).toBe('refuted');
    expect(byId.b.correct).toBe(true);
  });

  // Two entries on the same group, but the stub answers for only one of them.
  // The entry with no matching result must become `error`, never silently
  // inherit its neighbour's verdict.
  it('marks a missing result as error rather than inheriting a neighbour\'s verdict', async () => {
    const partialVerify = (async (_d: unknown, _p: { requests: Array<{ id: string }> }) => ({
      results: [{ id: 'b', verdict: 'confirmed' as const, evidence: 'eb' }],
      usage: { ...EMPTY_USAGE, calls: 1 },
    })) as never;

    const out = await runDraw({
      entries: [entry({ id: 'a', expected: 'refuted' }), entry({ id: 'b', expected: 'confirmed' })],
      instructions: 'verify',
      readBody: () => 'body',
      verify: partialVerify,
      deps,
    });

    const byId = Object.fromEntries(out.outcomes.map((o) => [o.id, o]));
    expect(byId.a.actual).toBe('error');
    expect(byId.a.correct).toBe(false);
    expect(byId.b.actual).toBe('confirmed');
  });
});
