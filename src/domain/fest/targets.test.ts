import { computeTargets, type TargetMenuItem } from './targets';

const criteria = {
  minRating: 3.8,
  minAbv: null,
  stylePatterns: ['Imperial', 'Wild Ale', 'Sour', 'Lambic', 'Eisbock', 'Barleywine', 'Wheatwine'],
};

const item = (beer_id: number, rating_global: number | null, style: string | null, section = 'PINTA', abv: number | null = 5): TargetMenuItem =>
  ({ beer_id, section, rating_global, style, abv });

const run = (menu: TargetMenuItem[], triedByMember: Set<number>[] = [new Set()], overrides = new Map<number, 'add' | 'remove'>()) =>
  computeTargets({ menu, triedByMember, overrides, criteria });

describe('computeTargets', () => {
  it('a rating of 3.79 misses the bar, 3.80 meets it', () => {
    const { targets } = run([item(1, 3.79, 'IPA - American'), item(2, 3.8, 'IPA - American')]);
    expect(targets.map((t) => [t.beerId, t.reasons])).toEqual([[2, ['rating']]]);
  });

  it('an unrated imperial stout qualifies by style', () => {
    const { targets, unrated } = run([item(1, null, 'Stout - Imperial / Double')]);
    expect([targets.map((t) => t.reasons), unrated]).toEqual([[['style']], []]);
  });

  it('an unrated beer with no matching style goes to the unrated list, not away', () => {
    const lager = item(1, null, 'Lager - Pale');
    expect(run([lager])).toEqual({ targets: [], unrated: [lager] });
  });

  it('both reasons are kept when both hold', () => {
    expect(run([item(1, 4.2, 'Sour - Fruited')]).targets[0].reasons).toEqual(['rating', 'style']);
  });

  it('matches style patterns case-insensitively', () => {
    const r = computeTargets({ menu: [item(1, null, 'Stout - Imperial / Double')], triedByMember: [new Set()], overrides: new Map(), criteria: { minRating: 5, minAbv: null, stylePatterns: ['imperial'] } });
    expect(r.targets.map((t) => t.reasons)).toEqual([['style']]);
  });

  it('no default pattern matches common non-target styles', () => {
    const plain = ['Lager - Pale', 'IPA - New England / Hazy', 'Pilsner - Czech / Bohemian', 'Pale Ale - American', 'Stout - Oatmeal'];
    expect(run(plain.map((s, i) => item(i, 3.0, s))).targets).toEqual([]);
  });

  it('one member of three having had it rules it out', () => {
    expect(run([item(1, 4.5, 'IPA - American')], [new Set(), new Set([1]), new Set()])).toEqual({ targets: [], unrated: [] });
  });

  it('a manual add makes even a tried beer a Target, with only the manual reason', () => {
    const r = run([item(1, 4.5, 'Sour - Fruited')], [new Set([1])], new Map([[1, 'add']]));
    expect(r.targets.map((t) => [t.beerId, t.reasons])).toEqual([[1, ['manual']]]);
  });

  it('a manual add on an automatic Target keeps its automatic reasons too', () => {
    const r = run([item(1, 4.5, 'IPA - American')], [new Set()], new Map([[1, 'add']]));
    expect(r.targets[0].reasons).toEqual(['rating', 'manual']);
  });

  it('a manual remove drops an automatic Target and keeps it off the unrated list', () => {
    expect(run([item(1, 4.5, 'IPA - American'), item(2, null, 'Lager - Pale')], [new Set()], new Map([[1, 'remove'], [2, 'remove']])))
      .toEqual({ targets: [], unrated: [] });
  });

  it('an empty team yields nothing rather than the whole menu', () => {
    expect(run([item(1, 4.5, 'IPA - American')], [])).toEqual({ targets: [], unrated: [] });
  });

  it('carries section, rating and style onto the Target', () => {
    expect(run([item(7, 4.03, 'Stout - Imperial / Double', 'Browar X')]).targets).toEqual([
      { beerId: 7, section: 'Browar X', reasons: ['rating', 'style'], rating: 4.03, style: 'Stout - Imperial / Double' },
    ]);
  });

  describe('by strength', () => {
    const runAbv = (menu: TargetMenuItem[], triedByMember: Set<number>[] = [new Set()], overrides = new Map<number, 'add' | 'remove'>()) =>
      computeTargets({ menu, triedByMember, overrides, criteria: { ...criteria, minAbv: 8 } });

    it('an ABV of 7.9 misses the bar, 8.0 meets it', () => {
      const { targets } = runAbv([item(1, 3.0, 'IPA - Belgian', 'PINTA', 7.9), item(2, 3.0, 'IPA - Belgian', 'PINTA', 8)]);
      expect(targets.map((t) => [t.beerId, t.reasons])).toEqual([[2, ['abv']]]);
    });

    it('a strong beer with no rating is a Target, not an unrated leftover', () => {
      expect(runAbv([item(1, null, 'Strong Ale - Other', 'PINTA', 12)])).toEqual({
        targets: [{ beerId: 1, section: 'PINTA', reasons: ['abv'], rating: null, style: 'Strong Ale - Other' }],
        unrated: [],
      });
    });

    it('an unknown strength (null, or the catalogue\'s 0) never qualifies', () => {
      const unknown = [item(1, null, 'Old / Stock Ale', 'PINTA', null), item(2, null, 'Old / Stock Ale', 'PINTA', 0)];
      expect(runAbv(unknown)).toEqual({ targets: [], unrated: unknown });
    });

    it('a threshold of 0 still leaves an unknown strength out, and takes any known one', () => {
      const unknown = item(1, null, 'Lager - Pale', 'PINTA', 0);
      const r = computeTargets({ menu: [unknown, item(2, null, 'Lager - Pale', 'PINTA', 0.5)], triedByMember: [new Set()], overrides: new Map(), criteria: { ...criteria, minAbv: 0 } });
      expect([r.targets.map((t) => [t.beerId, t.reasons]), r.unrated]).toEqual([[[2, ['abv']]], [unknown]]);
    });

    it('without a threshold even a 12% beer gets no strength reason', () => {
      expect(run([item(1, 3.0, 'Strong Ale - Other', 'PINTA', 12)]).targets).toEqual([]);
    });

    it('rating, style and strength are all kept, in that order, before a manual add', () => {
      const r = runAbv([item(1, 4.2, 'Stout - Imperial / Double', 'PINTA', 11)], [new Set()], new Map([[1, 'add']]));
      expect(r.targets[0].reasons).toEqual(['rating', 'style', 'abv', 'manual']);
    });

    it('a strong beer one member has had is not a Target', () => {
      expect(runAbv([item(1, 3.0, 'IPA - Belgian', 'PINTA', 9)], [new Set(), new Set([1])])).toEqual({ targets: [], unrated: [] });
    });

    it('a manual remove drops a Target by strength', () => {
      expect(runAbv([item(1, 3.0, 'IPA - Belgian', 'PINTA', 9)], [new Set()], new Map([[1, 'remove']]))).toEqual({ targets: [], unrated: [] });
    });
  });
});
