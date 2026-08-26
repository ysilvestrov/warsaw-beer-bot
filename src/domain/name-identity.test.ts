import { nameIdentity, candidateIdentity } from './name-identity';
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
