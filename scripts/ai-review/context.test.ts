import { buildReviewContext, DIFF_BUDGET_SHARE, fileChurn } from './context';

const DIFF = [
  '--- a/src/small.ts',
  '+++ b/src/small.ts',
  '@@ -1,1 +1,2 @@',
  '+one',
  '--- a/src/big.ts',
  '+++ b/src/big.ts',
  '@@ -1,1 +1,4 @@',
  '+one',
  '+two',
  '+three',
  '-gone',
].join('\n');

describe('fileChurn', () => {
  it('counts added and removed lines per file', () => {
    const churn = fileChurn(DIFF);
    expect(churn.get('src/big.ts')).toBe(4);
    expect(churn.get('src/small.ts')).toBe(1);
  });
});

describe('buildReviewContext', () => {
  const readFile = (p: string) => (p === 'src/big.ts' ? 'BIG BODY' : 'SMALL BODY');

  it('always includes the diff', () => {
    const { text } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile,
    });
    expect(text).toContain('@@ -1,1 +1,4 @@');
  });

  it('includes full file bodies, most-changed first', () => {
    const { text, diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/small.ts', 'src/big.ts'],
      readFile,
    });
    expect(text.indexOf('BIG BODY')).toBeLessThan(text.indexOf('SMALL BODY'));
    expect(diffOnly).toEqual([]);
  });

  it('degrades to diff-only for files that do not fit the budget', () => {
    // Bodies large enough that what fits is decided by their size: the budget
    // now also has to cover the headings, the fences and the ~250-character
    // diff-only notice, which would otherwise dominate at this scale.
    const padded = (p: string) =>
      p === 'src/big.ts' ? `BIG BODY\n${'x'.repeat(400)}` : `SMALL BODY\n${'y'.repeat(400)}`;
    const budget = 1_000;
    const { text, diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile: padded,
      budget,
    });
    expect(text).toContain('BIG BODY');
    expect(text).not.toContain('SMALL BODY');
    expect(diffOnly).toEqual(['src/small.ts']);
    expect(text).toContain('you see only the diff');
    expect(text.length).toBeLessThanOrEqual(budget);
  });

  it('truncates a diff that does not fit the budget and says so', () => {
    const huge = [
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,1 +1,400 @@',
      ...Array.from({ length: 400 }, (_, i) => `+line ${i}`),
      '+LAST LINE OF THE DIFF',
    ].join('\n');
    const { text } = buildReviewContext({
      diff: huge,
      reviewable: ['src/big.ts'],
      readFile,
      budget: 1_000,
    });
    expect(huge.length).toBeGreaterThan(1_000);
    expect(text).not.toContain('LAST LINE OF THE DIFF');
    expect(text).toContain('TRUNCATED');
    // The diff itself is held to its share of the budget; the surrounding
    // section headers are small and deliberately not charged against it.
    const diffBlock = text.split('```diff\n')[1].split('\n```')[0];
    expect(diffBlock.length).toBeLessThanOrEqual(1_000 * DIFF_BUDGET_SHARE);
  });

  it('leaves room for file bodies even when the diff overflows', () => {
    const huge = [
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,1 +1,400 @@',
      ...Array.from({ length: 400 }, (_, i) => `+line ${i}`),
    ].join('\n');
    const { text, diffOnly } = buildReviewContext({
      diff: huge,
      reviewable: ['src/big.ts'],
      readFile,
      budget: 1_000,
    });
    expect(text).toContain('BIG BODY');
    expect(diffOnly).toEqual([]);
  });

  it('keeps the whole assembled message inside the budget', () => {
    const huge = [
      '--- a/src/big.ts',
      '+++ b/src/big.ts',
      '@@ -1,1 +1,400 @@',
      ...Array.from({ length: 400 }, (_, i) => `+line ${i}`),
    ].join('\n');
    const fat = (p: string) => `## ${p}\n${'body '.repeat(200)}`;
    // Budgets spanning "every body degrades to diff-only" up to "everything
    // fits": the assembled message is what gets sent, so all of them hold.
    // The floor is the two notices themselves, a few hundred characters —
    // they are never dropped, because a model told nothing about what is
    // missing is worse than a slightly oversized prompt.
    for (const budget of [600, 800, 1_500, 3_000, 20_000]) {
      const { text } = buildReviewContext({
        diff: huge,
        reviewable: ['src/big.ts', 'src/small.ts', 'src/third.ts'],
        readFile: fat,
        budget,
      });
      expect(text.length).toBeLessThanOrEqual(budget);
    }
  });

  it('lists a deleted file as diff-only instead of throwing', () => {
    const { diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile: (p) => (p === 'src/big.ts' ? 'BIG BODY' : null),
    });
    expect(diffOnly).toEqual(['src/small.ts']);
  });
});
