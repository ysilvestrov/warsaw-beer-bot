import { describe, expect, it } from 'vitest';
import { loadCorpus, parseCorpus, type CorpusEntry } from './verify-corpus';

const entry = (over: Partial<CorpusEntry> = {}): CorpusEntry => ({
  id: '0726-348-4',
  provenance: 'harvested',
  source: 'PR #348 AI review 2026-07-26',
  // Full 40-character sha (M6, final review): the schema now rejects a short prefix.
  sha: 'eb20128c2875a67fabe0971b08608020d259f1a8',
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
  // The explicit id inventory, not a bare count: `parseCorpus([])` returns `[]`
  // without throwing, so a length-only assertion cannot tell 7 entries from 1, and
  // it is the only thing watching the total (verify-corpus.ts's own header warns a
  // skipped entry "shrinks the denominator invisibly"). Naming every id also means
  // an honest drop shows up in the diff as "this id left", not as a changed number
  // with no story — see `0923-418-D1` below, dropped by stage-2 task-1 fix round 1.
  it('loads and validates the shipped corpus', () => {
    expect(
      loadCorpus()
        .map((e) => e.id)
        .sort(),
    ).toEqual(
      [
        '0726-348-4',
        '0728-358-4',
        '0923-418-D2',
        '0923-418-D3',
        '0923-418-D4',
        '0923-418-D4t',
        '0923-418-D5',
      ].sort(),
    );
  });

  // A judge comparison run against one entry per verdict class measures nothing.
  it('keeps enough of each verdict class to measure anything', () => {
    const corpus = loadCorpus();
    expect(corpus.filter((e) => e.expected === 'confirmed').length).toBeGreaterThanOrEqual(3);
    expect(corpus.filter((e) => e.expected === 'refuted').length).toBeGreaterThanOrEqual(2);
  });

  // The in-file evidence rule, measured into existence on 2026-09-23: an entry whose
  // truth cannot be established from the ONE file body verify sends measures whether
  // the judge guesses, not whether it reads. Two entries have failed it so far.
  // `0723-344-1` (dropped before this task, in 58e6ead): its claim turned on
  // `checkins.beer_id` having no `ON DELETE CASCADE`, which lives in
  // `src/storage/schema.ts`, while the judge saw only `src/domain/pin-match.ts` (whose
  // own comment says "enrich_failures CASCADE-drop", actively suggesting the delete is
  // safe) — both judges measured wavered on it and on nothing else.
  // `0923-418-D1` (dropped by this task's fix round 1): `parseScopeBlock` is
  // byte-identical at 584aa661, at the fix commit 2170717, and in main today — the
  // fix never touched the quoted code, only its caller in the OTHER file
  // (`src/jobs/orphan-triage.ts`, which concatenates model-authored `issue.body`
  // ahead of the rendered scope block). Worse, `triage-scope.ts` itself asserts the
  // opposite of the claim (lines 130-133: "the model never authors the text") and
  // names the flagged first-match behaviour as already handled (lines 138-144). A
  // judge reading only this file has no ground truth for "confirmed" and every
  // in-file signal points it toward "refuted" or "out_of_scope" instead.
  // Neither may return.
  it('holds no entry whose file differs from the one its verdict turns on', () => {
    const corpus = loadCorpus();
    expect(corpus.map((e) => e.id)).not.toContain('0723-344-1');
    expect(corpus.map((e) => e.id)).not.toContain('0923-418-D1');
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

  // Stage 2, task 1: known-true entries must not all sit in one file, or a judge
  // that reads that file well scores perfectly on every confirmable claim there is.
  it('spreads the known-true entries over more than one file', () => {
    const confirmed = loadCorpus().filter((e) => e.expected === 'confirmed');
    expect(new Set(confirmed.map((e) => e.file)).size).toBeGreaterThan(1);
  });
});
