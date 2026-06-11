import { describe, it, expect } from 'vitest';
import { bierloods22 } from './bierloods22';

// Minimal card markup: bierloods22 cards expose the visible title as a.title text and
// the "{brand} {title}" string as the a.title `title=` attribute.
function card(titleAttr: string, titleText: string): string {
  return `<div class="product-block"><h4><a class="title" title="${titleAttr}">${titleText}</a></h4></div>`;
}
function parse(html: string) {
  return bierloods22.parseCards(new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html'));
}

describe('bierloods22 brewery extraction (#117)', () => {
  it('uses the brand prefix for a brewery containing " - " (Kykao)', () => {
    const [c] = parse(card(
      'KYKAO - Handcrafted Kykao - Handcrafted - Sour Berliner Weisse - Raspberry Edition (2025)',
      'Kykao - Handcrafted - Sour Berliner Weisse - Raspberry Edition (2025)',
    ));
    expect(c.brewery).toBe('Kykao - Handcrafted');
    expect(c.name).toBe('Sour Berliner Weisse - Raspberry Edition (2025)');
  });

  it('single-segment brewery still splits on the first dash (Brokreacja)', () => {
    const [c] = parse(card('Brokreacja Browar Brokreacja - The Dancer', 'Browar Brokreacja - The Dancer'));
    expect(c.brewery).toBe('Browar Brokreacja');
    expect(c.name).toBe('The Dancer');
  });

  it('no brand prefix → first-dash fallback', () => {
    const [c] = parse(card('Foo - Bar', 'Foo - Bar'));
    expect(c.brewery).toBe('Foo');
    expect(c.name).toBe('Bar');
  });

  it('brand prefix that is not a suffix of the title → first-dash fallback', () => {
    // Guard: attr is non-empty but does not end with the visible title → ignore it.
    const [c] = parse(card('Totally Unrelated Brand Label', 'Foo - Bar'));
    expect(c.brewery).toBe('Foo');
    expect(c.name).toBe('Bar');
  });

  it('no dash → empty brewery, whole title as name', () => {
    const [c] = parse(card('Solo', 'Solo'));
    expect(c.brewery).toBe('');
    expect(c.name).toBe('Solo');
  });

  it('ignores beer-package cards from the Bierloods22 package category', () => {
    const cards = parse([
      card('Bierloods22 Beerbox - Surprise Box IPA', 'Beerbox - Surprise Box IPA'),
      card('Bierloods22 Beertasting box: all styles', 'Beertasting box: all styles'),
      card('Bierloods22 Beer Package present Birthday', 'Beer Package present Birthday'),
      card('Browar Stu Mostów ART+81', 'Browar Stu Mostów - ART+81'),
    ].join(''));

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      brewery: 'Browar Stu Mostów',
      name: 'ART+81',
    });
  });
});
