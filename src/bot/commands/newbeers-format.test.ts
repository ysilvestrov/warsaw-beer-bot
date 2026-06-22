import {
  groupTaps,
  rankGroups,
  formatGroupedBeers,
  type CandidateTap,
  type BeerGroup,
} from './newbeers-format';
import type { Translator } from '../../i18n/types';

const stubT: Translator = (key, params) => {
  if (key === 'newbeers.more_pubs_suffix') return ` +${params!.extra} інших`;
  return String(key);
};

const tap = (over: Partial<CandidateTap> = {}): CandidateTap => ({
  beer_id: null,
  display: 'X',
  brewery_norm: 'b',
  name_norm: 'x',
  style: null,
  abv: null,
  rating: null,
  pub_name: 'P',
  ...over,
});

describe('groupTaps', () => {
  test('groups by matched beer_id across pubs', () => {
    const r = groupTaps([
      tap({ beer_id: 1, display: 'Salamander', rating: 3.9, pub_name: 'Cuda' }),
      tap({ beer_id: 1, display: 'Salamander IPA', rating: 3.8, pub_name: 'PiwPaw' }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].pubs).toEqual(['Cuda', 'PiwPaw']);
    expect(r[0].rating).toBe(3.9);
    expect(r[0].display).toBe('Salamander');
  });

  test('falls back to (brewery_norm,name_norm) when beer_id is null', () => {
    const r = groupTaps([
      tap({ beer_id: null, brewery_norm: 'b', name_norm: 'x', display: 'X', pub_name: 'A' }),
      tap({ beer_id: null, brewery_norm: 'b', name_norm: 'x', display: 'X', pub_name: 'B' }),
      tap({ beer_id: null, brewery_norm: 'b', name_norm: 'y', display: 'Y', pub_name: 'A' }),
    ]);
    expect(r).toHaveLength(2);
    const xs = r.find((g) => g.display === 'X')!;
    expect(xs.pubs).toEqual(['A', 'B']);
  });

  test('dedups identical pub names', () => {
    const r = groupTaps([
      tap({ beer_id: 1, pub_name: 'Cuda' }),
      tap({ beer_id: 1, pub_name: 'Cuda' }),
    ]);
    expect(r[0].pubs).toEqual(['Cuda']);
  });

  test('group rating is max of non-null ratings', () => {
    const r = groupTaps([
      tap({ beer_id: 1, rating: null, pub_name: 'A' }),
      tap({ beer_id: 1, rating: 3.5, pub_name: 'B' }),
      tap({ beer_id: 1, rating: 3.9, pub_name: 'C' }),
    ]);
    expect(r[0].rating).toBe(3.9);
  });

  test('group rating null when all ratings null', () => {
    const r = groupTaps([
      tap({ beer_id: 1, rating: null, pub_name: 'A' }),
      tap({ beer_id: 1, rating: null, pub_name: 'B' }),
    ]);
    expect(r[0].rating).toBeNull();
  });

  test('group abv comes from highest-rated rep, with non-null fallback', () => {
    const r = groupTaps([
      tap({ beer_id: 1, rating: 3.5, abv: 5.0, pub_name: 'A' }),
      tap({ beer_id: 1, rating: 3.9, abv: 5.5, pub_name: 'B' }),
    ]);
    expect(r[0].abv).toBe(5.5);
  });

  test('group abv falls back to non-null when rep tap has null abv', () => {
    const r = groupTaps([
      tap({ beer_id: 1, rating: 3.9, abv: null, pub_name: 'A' }),
      tap({ beer_id: 1, rating: 3.5, abv: 5.0, pub_name: 'B' }),
    ]);
    expect(r[0].abv).toBe(5.0);
  });

  test('group style comes from highest-rated representative, with non-null fallback', () => {
    const r = groupTaps([
      tap({ beer_id: 1, rating: 3.5, style: 'IPA', pub_name: 'A' }),
      tap({ beer_id: 1, rating: 3.9, style: 'Double IPA', pub_name: 'B' }),
    ]);
    expect(r[0].style).toBe('Double IPA');
  });

  test('group style falls back to a non-null value', () => {
    const r = groupTaps([
      tap({ beer_id: 1, rating: 3.9, style: null, pub_name: 'A' }),
      tap({ beer_id: 1, rating: 3.5, style: 'IPA', pub_name: 'B' }),
    ]);
    expect(r[0].style).toBe('IPA');
  });
});

describe('rankGroups', () => {
  const g = (display: string, rating: number | null, pubs: string[]): BeerGroup => ({
    display,
    rating,
    style: null,
    abv: null,
    pubs,
  });

  test('sorts by rating desc, nulls last', () => {
    const r = rankGroups([g('a', null, ['p']), g('b', 3.9, ['p']), g('c', 4.0, ['p'])]);
    expect(r.map((x) => x.display)).toEqual(['c', 'b', 'a']);
  });

  test('breaks rating ties by pub-count desc', () => {
    const r = rankGroups([g('a', 3.9, ['p1']), g('b', 3.9, ['p1', 'p2', 'p3'])]);
    expect(r.map((x) => x.display)).toEqual(['b', 'a']);
  });

  test('breaks pub-count ties by display asc', () => {
    const r = rankGroups([g('b', 3.9, ['p1']), g('a', 3.9, ['p1'])]);
    expect(r.map((x) => x.display)).toEqual(['a', 'b']);
  });
});

describe('formatGroupedBeers', () => {
  test('numbered list with bold name, rating and ABV', () => {
    const text = formatGroupedBeers(
      [{ display: 'Salamander', style: null, rating: 3.9, abv: 5.5, pubs: ['Cuda'] }],
      'uk', stubT,
    );
    expect(text).toContain('1. <b>Salamander</b>');
    expect(text).toContain('⭐ 3.9');
    expect(text).toContain('5,5%');
    expect(text).toContain('· Cuda');
  });

  test('renders integer ABV without decimal separator', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: null, rating: 4.0, abv: 6, pubs: ['A'] }],
      'uk', stubT,
    );
    expect(text).toContain('6%');
    expect(text).not.toContain('6,0%');
  });

  test('omits ABV chip when abv is null', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: null, rating: 4.0, abv: null, pubs: ['A'] }],
      'uk', stubT,
    );
    expect(text).not.toMatch(/%/);
  });

  test('caps pub list at maxPubs and appends +N інших', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: null, rating: 4.0, abv: null, pubs: ['A', 'B', 'C', 'D', 'E'] }],
      'uk', stubT,
      { maxPubs: 3 },
    );
    expect(text).toContain('A, B, C +2 інших');
  });

  test('renders null rating as ⭐ —', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: null, rating: null, abv: null, pubs: ['A'] }],
      'uk', stubT,
    );
    expect(text).toContain('⭐ —');
  });

  test('HTML-escapes special chars in name and pubs', () => {
    const text = formatGroupedBeers(
      [{ display: 'Pivo & <Co>', style: null, rating: null, abv: null, pubs: ['Bar & Grill'] }],
      'uk', stubT,
    );
    expect(text).toContain('Pivo &amp; &lt;Co&gt;');
    expect(text).toContain('Bar &amp; Grill');
  });

  test('respects topN', () => {
    const groups: BeerGroup[] = Array.from({ length: 20 }, (_, i) => ({
      display: `B${i}`,
      style: null,
      rating: 5 - i * 0.1,
      abv: null,
      pubs: ['P'],
    }));
    const text = formatGroupedBeers(groups, 'uk', stubT, { topN: 3 });
    expect(text).toContain('1. <b>B0</b>');
    expect(text).toContain('3. <b>B2</b>');
    expect(text).not.toContain('4. <b>B3</b>');
  });

  test('empty input → empty string', () => {
    expect(formatGroupedBeers([], 'uk', stubT)).toBe('');
  });

  test('two-line layout per beer', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: null, rating: 4.0, abv: null, pubs: ['A', 'B'] }],
      'uk', stubT,
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1\. <b>X<\/b>/);
    expect(lines[1]).toMatch(/^\s+· /);
  });

  test('renders and HTML-escapes a known style inline', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: 'IPA & <Ale>', rating: 4, abv: 6, pubs: ['A'] }],
      'uk', stubT,
    );
    expect(text).toContain('<b>X</b> • IPA &amp; &lt;Ale&gt;  ⭐ 4');
  });

  test('omits an unknown style and its separator', () => {
    const text = formatGroupedBeers(
      [{ display: 'X', style: null, rating: 4, abv: null, pubs: ['A'] }],
      'uk', stubT,
    );
    expect(text).toContain('<b>X</b>  ⭐ 4');
    expect(text).not.toContain('<b>X</b> •');
  });
});
