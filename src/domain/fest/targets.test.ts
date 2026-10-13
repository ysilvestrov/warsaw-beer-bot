import { computeTargets, type TargetMenuItem } from './targets';

const criteria = {
  minRating: 3.8,
  minAbv: null,
  stylePatterns: ['Imperial', 'Wild Ale', 'Sour', 'Lambic', 'Eisbock', 'Barleywine', 'Wheatwine'],
  namePatterns: [] as string[],
};

const item = (beer_id: number, rating_global: number | null, style: string | null, section = 'PINTA', abv: number | null = 5, name = 'Atak Chmielu'): TargetMenuItem =>
  ({ beer_id, section, name, rating_global, style, abv });

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
    const r = computeTargets({ menu: [item(1, null, 'Stout - Imperial / Double')], triedByMember: [new Set()], overrides: new Map(), criteria: { minRating: 5, minAbv: null, stylePatterns: ['imperial'], namePatterns: [] } });
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

  describe('by name', () => {
    const named = (beer_id: number, name: string, rating: number | null = null) => item(beer_id, rating, 'Lager - Pale', 'Green Head', 5.5, name);
    const runName = (menu: TargetMenuItem[], namePatterns = ['WFP'], triedByMember: Set<number>[] = [new Set()], overrides = new Map<number, 'add' | 'remove'>()) =>
      computeTargets({ menu, triedByMember, overrides, criteria: { ...criteria, namePatterns } });

    it('a festival special with no rating is a Target by name; its neighbour stays unrated', () => {
      const plain = named(2, 'Hyperjuice Mango');
      expect(runName([named(1, '8. HYPERJUICE WFP 22'), plain])).toEqual({
        targets: [{ beerId: 1, section: 'Green Head', reasons: ['name'], rating: null, style: 'Lager - Pale' }],
        unrated: [plain],
      });
    });

    it('matches name patterns case-insensitively, in either direction', () => {
      const r = runName([named(1, 'Stargazer wfp Speciality 1'), named(2, 'KRASNOLÓD WFP 2026')], ['Wfp']);
      expect(r.targets.map((t) => [t.beerId, t.reasons])).toEqual([[1, ['name']], [2, ['name']]]);
    });

    it('any one of several patterns is enough', () => {
      const r = runName([named(1, 'Festiwalowe 22'), named(2, 'Pils WFP'), named(3, 'Pils')], ['WFP', 'Festiwal']);
      expect(r.targets.map((t) => t.beerId)).toEqual([1, 2]);
    });

    it('the pattern is looked for in the name only, not in the section or style', () => {
      const elsewhere = item(1, null, 'WFP Ale', 'WFP Brewery', 5, 'Pils');
      expect(runName([elsewhere])).toEqual({ targets: [], unrated: [elsewhere] });
    });

    it('with no name patterns a festival special gets no name reason', () => {
      const special = named(1, 'HYPERJUICE WFP 22');
      expect(run([special])).toEqual({ targets: [], unrated: [special] });
    });

    it('a blank pattern is ignored rather than matching every name', () => {
      const plain = named(1, 'Hyperjuice Mango');
      expect(runName([plain, named(2, 'Pils WFP')], ['', '  ', ' WFP '])).toEqual({
        targets: [{ beerId: 2, section: 'Green Head', reasons: ['name'], rating: null, style: 'Lager - Pale' }],
        unrated: [plain],
      });
    });

    it('the name reason comes after rating, style and strength, before a manual add', () => {
      const r = computeTargets({
        menu: [item(1, 4.2, 'Barleywine - Other', 'Brokreacja', 12, 'SWEET TEMPTATION WFP SPECIALITY 1')],
        triedByMember: [new Set()],
        overrides: new Map([[1, 'add']]),
        criteria: { ...criteria, minAbv: 8, namePatterns: ['WFP'] },
      });
      expect(r.targets[0].reasons).toEqual(['rating', 'style', 'abv', 'name', 'manual']);
    });

    it('a festival special one member has had is not a Target', () => {
      expect(runName([named(1, 'Pils WFP', 3.0)], ['WFP'], [new Set(), new Set([1])])).toEqual({ targets: [], unrated: [] });
    });

    it('a manual remove drops a Target by name', () => {
      expect(runName([named(1, 'Pils WFP')], ['WFP'], [new Set()], new Map([[1, 'remove']]))).toEqual({ targets: [], unrated: [] });
    });
  });
});
