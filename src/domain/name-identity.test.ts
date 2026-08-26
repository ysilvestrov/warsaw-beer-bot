import { nameIdentity, candidateIdentity, identityAllowsApprox, type NameIdentity } from './name-identity';
import { normalizeBrewery } from './normalize';

const ident = (name: string, brewery: string) => nameIdentity(name, normalizeBrewery(brewery));

describe('nameIdentity', () => {
  test('leaves a name alone when the filter leaves something behind', () => {
    // The filter did its job: "ipa" is noise, "buzdygan rozkoszy" is the beer.
    const out = ident('Buzdygan Rozkoszy IPA', 'Buzdygan');
    expect(out.value).toBe('rozkoszy');
    expect(out.restored).toBe(false);
  });

  test('shape A: recovers a name the filter empties completely', () => {
    const out = ident('Weizen', 'Primátor');
    expect(out.value).toBe('weizen');
    expect(out.restored).toBe(true);
  });

  test('shape B: recovers a name the filter reduces to the bare brand', () => {
    // normalizeName('Kronenbourg 1664') === 'kronenbourg' — non-empty, but no identity.
    const out = ident('Kronenbourg 1664', 'Kronenbourg Brewery');
    expect(out.value).toBe('1664');
    expect(out.restored).toBe(true);
  });

  test('the witness: one name that all three predicates strip', () => {
    // 300 = digit, IBU = spec label, IPA = style word. bid 212077.
    const out = ident('300 IBU IPA', 'Southern Brewing & Winemaking');
    expect(out.value).toBe('300 ibu ipa');
    expect(out.restored).toBe(true);
  });

  test('a sibling with surviving content does NOT restore, so it stays distinct', () => {
    const bare = ident('1664', 'Brasseries Kronenbourg');
    const blanc = ident('1664 Blanc', 'Brasseries Kronenbourg');
    expect(bare.value).toBe('1664');
    expect(blanc.value).toBe('blanc');
    expect(blanc.restored).toBe(false);
    expect(bare.value).not.toBe(blanc.value);
  });

  test('beers indistinguishable today become distinguishable', () => {
    expect(ident('0 IBU', 'Mikkeller').value).toBe('0 ibu');
    expect(ident('1000 IBU', 'Mikkeller').value).toBe('1000 ibu');
  });

  test('a name that is nothing but the brand is not rescued', () => {
    // "Holba Brewery / Holba" has no identity to recover; #306 owns this case.
    const out = ident('Holendr', 'Pivovar Holendr Brewery');
    expect(out.restored).toBe(false);
  });

  test('candidateIdentity keys on the candidate own brewery', () => {
    const out = candidateIdentity('1664', 'Brasseries Kronenbourg');
    expect(out).toEqual({ value: '1664', restored: true });
  });
});

const plain = (value: string): NameIdentity => ({ value, restored: false });
const back = (value: string): NameIdentity => ({ value, restored: true });

describe('identityAllowsApprox', () => {
  test('untouched identities on both sides are never gated', () => {
    expect(identityAllowsApprox(plain('rozkoszy'), plain('rozkoszyy'), null, null)).toBe(true);
  });

  test('restored evidence with an exact match needs no ABV', () => {
    expect(identityAllowsApprox(back('weizen'), back('weizen'), null, null)).toBe(true);
  });

  test('restored evidence approximating needs ABV agreement', () => {
    // "IPA" must not reach "IPALIT" at 7.0 vs 7.5.
    expect(identityAllowsApprox(back('ipa'), plain('ipalit'), 7, 7.5)).toBe(false);
    expect(identityAllowsApprox(back('weizen'), plain('weizenbier'), 4.8, 4.8)).toBe(true);
  });

  test('restored evidence approximating with no ABV at all is refused', () => {
    expect(identityAllowsApprox(back('wheat'), plain('wheatly'), null, 4.3)).toBe(false);
  });

  test('a bare grade is exact-only — ABV is not a substitute', () => {
    // "11" @4.5 must not reach "Session IPA 11%" @4.7 even though 0.2 is inside tolerance.
    expect(identityAllowsApprox(back('11'), back('session 11'), 4.5, 4.7)).toBe(false);
  });

  test('but a beer literally NAMED after the number still matches', () => {
    // Browar Artezan — 11; Nepo Brewing — 15. The number is the name, not the grade.
    expect(identityAllowsApprox(back('11'), back('11'), 6.5, 6.5)).toBe(true);
    expect(identityAllowsApprox(back('15'), back('15'), 6.8, 6.8)).toBe(true);
  });

  test('a number outside the grade range is an ordinary restored token', () => {
    // 1664 is not a grade, so ABV corroboration applies as usual.
    expect(identityAllowsApprox(back('1664'), plain('1664 blanc'), 5, 5)).toBe(true);
  });
});
