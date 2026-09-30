import { computeTargets, type TargetMenuItem } from './targets';

const criteria = {
  minRating: 3.8,
  stylePatterns: ['Imperial', 'Wild Ale', 'Sour', 'Lambic', 'Eisbock', 'Barleywine', 'Wheatwine'],
};

const item = (beer_id: number, rating_global: number | null, style: string | null, section = 'PINTA'): TargetMenuItem =>
  ({ beer_id, section, rating_global, style });

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
    const r = computeTargets({ menu: [item(1, null, 'Stout - Imperial / Double')], triedByMember: [new Set()], overrides: new Map(), criteria: { minRating: 5, stylePatterns: ['imperial'] } });
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
});
