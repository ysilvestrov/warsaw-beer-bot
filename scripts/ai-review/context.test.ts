import { buildReviewContext, fileChurn } from './context';

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
    const { text, diffOnly } = buildReviewContext({
      diff: DIFF,
      reviewable: ['src/big.ts', 'src/small.ts'],
      readFile,
      budget: DIFF.length + 60,
    });
    expect(text).toContain('BIG BODY');
    expect(text).not.toContain('SMALL BODY');
    expect(diffOnly).toEqual(['src/small.ts']);
    expect(text).toContain('you see only the diff');
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
