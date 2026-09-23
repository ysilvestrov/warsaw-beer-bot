import { describe, expect, it } from 'vitest';
import { loadCorpus, parseCorpus, type CorpusEntry } from './verify-corpus';

const entry = (over: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id: '0726-348-4',
  provenance: 'harvested',
  source: 'PR #348 AI review 2026-07-26',
  sha: 'eb20128c2875',
  file: 'src/storage/web_search_quota.ts',
  matchedLine: 8,
  matchedEndLine: 16,
  quote: 'export function tryConsumeWebSearchQuota(db: DB, day: string, cap: number): boolean {',
  quoteOrigin: 'reconstructed',
  claim: 'the quota can exceed the cap under quick successive requests',
  why_it_breaks: 'two concurrent requests both read the count before either writes',
  expected: 'refuted',
  why_expected: 'one atomic UPSERT with ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ? — the max stored count is exactly cap',
  ...over,
});

describe('parseCorpus', () => {
  it('accepts a well-formed entry', () => {
    expect(parseCorpus([entry()])).toEqual([entry()]);
  });

  // Global constraint: out_of_scope is not a v1 label. Its ground truth depends on
  // the diff, and a label we cannot defend poisons the corpus.
  it('rejects out_of_scope as an expected verdict', () => {
    expect(() => parseCorpus([entry({ expected: 'out_of_scope' as never })])).toThrow();
  });

  // A label without its evidence is the "counter in the evidence column" the spec
  // rule forbids.
  it('rejects an entry whose why_expected is empty', () => {
    expect(() => parseCorpus([entry({ why_expected: '   ' })])).toThrow();
  });

  it('rejects an entry with an unknown provenance', () => {
    expect(() => parseCorpus([entry({ provenance: 'invented' as never })])).toThrow();
  });

  // The quote carries the code's own indentation and must survive validation
  // byte-for-byte: it is what the judge is shown. Prose fields may be trimmed.
  it('preserves the quote\'s leading whitespace while trimming prose', () => {
    const [parsed] = parseCorpus([
      entry({ quote: '      if (target.postCreationRows >= MAX) {', why_expected: '  padded  ' }),
    ]);
    expect(parsed.quote).toBe('      if (target.postCreationRows >= MAX) {');
    expect(parsed.why_expected).toBe('padded');
  });

  it('still rejects a whitespace-only quote', () => {
    expect(() => parseCorpus([entry({ quote: '    ' })])).toThrow();
  });

  // One bad entry fails the load. Skipping it would hand the candidate a mark it
  // never earned, and the score would silently be out of a smaller denominator.
  it('fails the whole load when any entry is invalid, naming the id', () => {
    expect(() => parseCorpus([entry(), entry({ id: 'bad-1', why_expected: '' })])).toThrow(/bad-1/);
  });

  it('rejects duplicate ids', () => {
    expect(() => parseCorpus([entry(), entry()])).toThrow(/0726-348-4/);
  });
});

describe('loadCorpus — the committed seed', () => {
  it('loads and validates the shipped corpus', () => {
    const corpus = loadCorpus();
    expect(corpus.length).toBe(6);
  });

  // The seed is not an arbitrary sample: each of these properties is what makes a
  // later task's grouping test provable with real data rather than a fixture.
  it('carries both provenances and both expected verdicts', () => {
    const corpus = loadCorpus();
    expect(new Set(corpus.map((e) => e.provenance))).toEqual(new Set(['harvested', 'constructed']));
    expect(new Set(corpus.map((e) => e.expected))).toEqual(new Set(['confirmed', 'refuted']));
  });

  it('contains two entries sharing one (sha, file) — the batching case', () => {
    const corpus = loadCorpus();
    const same = corpus.filter(
      (e) => e.sha === '584aa66183e55e4371819c9c5b19b2662ddaa6a2' && e.file === 'src/domain/triage-plan.ts',
    );
    expect(same.map((e) => e.id).sort()).toEqual(['0923-418-D3', '0923-418-D4']);
  });

  it('contains one file path at two different shas — the grouping-key case', () => {
    const corpus = loadCorpus();
    const shas = corpus.filter((e) => e.file === 'src/domain/triage-plan.ts').map((e) => e.sha);
    expect(new Set(shas).size).toBe(2);
  });
});
