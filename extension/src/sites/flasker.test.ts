import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTitle, stripMerchandisingPrefix, isNonBeerTitle, isNonBeerCategory, flasker } from './flasker';

const load = (name: string) =>
  new DOMParser().parseFromString(readFileSync(resolve(__dirname, `../../tests/fixtures/${name}`), 'utf8'), 'text/html');

const findCard = (fixture: string, expectedName: string) => {
  const card = flasker.parseCards(load(fixture)).find((item) => item.name === expectedName);
  expect(card, `${fixture}: ${expectedName}`).toBeDefined();
  return card!;
};

describe('parseTitle', () => {
  it('single-token brewery + style name', () => {
    expect(parseTitle('Burgomistr NEIPA 6% 500ml')).toEqual({ brewery: 'Burgomistr', name: 'NEIPA', abv: 6 });
  });

  it('comma decimal abv, Cyrillic name', () => {
    expect(parseTitle('REBREW Труханів Острів SIPA 4,3% 330ml'))
      .toEqual({ brewery: 'REBREW', name: 'Труханів Острів SIPA', abv: 4.3 });
  });

  it('brewery = first token; dash + style stay in the name', () => {
    expect(parseTitle('Ципа 380 – Triple IPA 7.9% 500ml'))
      .toEqual({ brewery: 'Ципа', name: '380 – Triple IPA', abv: 7.9 });
  });

  it('parenthetical second token joins the brewery', () => {
    expect(parseTitle('ШО (IIIO) Totem IPA 6% 0.33l'))
      .toEqual({ brewery: 'ШО (IIIO)', name: 'Totem IPA', abv: 6 });
  });

  it('known two-word brewery + bare-decimal volume', () => {
    expect(parseTitle('Vibrant Pour Frost & Flame Imperial Porter 10% 0.33'))
      .toEqual({ brewery: 'Vibrant Pour', name: 'Frost & Flame Imperial Porter', abv: 10 });
  });

  it('canonicalizes a brewery from a trusted product tag', () => {
    expect(parseTitle('Vibrant Pour Frost & Flame Imperial Porter 10% 0.33', {
      productTags: ['330 ml', 'VIBRANT POUR', 'Україна'],
    })).toEqual({ brewery: 'VibrantPour', name: 'Frost & Flame Imperial Porter', abv: 10 });
  });

  it('uses a trusted product slug when block cards have no tags', () => {
    expect(parseTitle('Barely Beer 0% ABV 330ml', {
      productUrl: 'https://flasker.com.ua/product/mad-barely-beer-0-abv-pale-ale-330ml/',
    })).toEqual({ brewery: 'Mad Brew', name: 'Barely Beer', abv: 0 });
  });

  it('retains the complete name when the brewery is absent from the title', () => {
    expect(parseTitle('Barely Beer 0% ABV 330ml', { productTags: ['mad brew'] }))
      .toEqual({ brewery: 'Mad Brew', name: 'Barely Beer', abv: 0 });
  });

  it('prefers one trusted tag over a conflicting URL rule', () => {
    expect(parseTitle('Barely Beer 0% ABV 330ml', {
      productTags: ['mad brew'],
      productUrl: 'https://flasker.com.ua/product/vibrant-pour-barely-beer/',
    })).toEqual({ brewery: 'Mad Brew', name: 'Barely Beer', abv: 0 });
  });

  it('falls back to title parsing when trusted tags conflict', () => {
    expect(parseTitle('Mystery Beer 5% 330ml', {
      productTags: ['mad brew', 'Vibrant Pour'],
      productUrl: 'https://flasker.com.ua/product/mad-mystery-beer/',
    })).toEqual({ brewery: 'Mystery', name: 'Beer', abv: 5 });
  });

  it('falls back for unknown tags, foreign URLs, and malformed URLs', () => {
    for (const evidence of [
      { productTags: ['Imperial Stout'] },
      { productUrl: 'https://example.com/product/mad-mystery-beer/' },
      { productUrl: 'not a URL' },
    ]) {
      expect(parseTitle('Mystery Beer 5% 330ml', evidence))
        .toEqual({ brewery: 'Mystery', name: 'Beer', abv: 5 });
    }
  });

  it('removes the longest matching title alias', () => {
    expect(parseTitle('Hoppy Hog — Winter Cherry 8% 330ml', {
      productTags: ['Hoppy Hog'],
    })).toEqual({ brewery: 'Hoppy Hog Family Brewery', name: 'Winter Cherry', abv: 8 });
  });

  it('cleans a merchandising label after metadata resolution', () => {
    expect(parseTitle('ПРЕДРЕЛІЗ Galaxy Juice 6% 330ml', {
      productTags: ['mad brew'],
    })).toEqual({ brewery: 'Mad Brew', name: 'Galaxy Juice', abv: 6 });
  });

  it('keeps Lost Philosopher names under Mad Brew when tags identify the brewery', () => {
    expect(parseTitle('The Lost Philosopher X 330ml', {
      productTags: ['mad brew'],
    })).toEqual({ brewery: 'Mad Brew', name: 'The Lost Philosopher X' });

    expect(parseTitle('The Lost Philosopher Xmas Eve 10% [2025] 330ml', {
      productTags: ['mad brew'],
    })).toEqual({ brewery: 'Mad Brew', name: 'The Lost Philosopher Xmas Eve', abv: 10 });
  });

  it('uses the explicit Copper Head rule instead of splitting the first word', () => {
    expect(parseTitle('Copper Head Royal Cookie 9% 0.33l', {
      productTags: ['COPPER HEAD'],
    })).toEqual({ brewery: 'Copper Head. Beer Workshop', name: 'Royal Cookie', abv: 9 });
  });

  it('uses Hoppy Hog product slugs when tags are missing', () => {
    expect(parseTitle('Hoppy Hog Charred Memory IS 10% 330ml', {
      productUrl: 'https://flasker.com.ua/product/hoppy-hog-charred-memory-is-10-330ml/',
    })).toEqual({ brewery: 'Hoppy Hog Family Brewery', name: 'Charred Memory IS', abv: 10 });
  });

  it('uses known Mad Brew product-family slugs over misleading generic tags', () => {
    expect(parseTitle('DE ZWARTE REGEL: Tweede Kring 6.5% 0.33', {
      productTags: ['Vibrant Pour'],
      productUrl: 'https://flasker.com.ua/product/предреліз-de-zwarte-regel-tweede-kring-6-5-0-33/',
    })).toEqual({ brewery: 'Mad Brew', name: 'DE ZWARTE REGEL: Tweede Kring', abv: 6.5 });
  });

  it('no abv → volume marks the head end', () => {
    expect(parseTitle('Orval {2025} 330ml')).toEqual({ brewery: 'Orval', name: '{2025}' });
  });

  it('zero abv', () => {
    expect(parseTitle('Barely Beer 0% ABV 330ml')).toEqual({ brewery: 'Barely', name: 'Beer', abv: 0 });
  });

  it('returns null when there is no volume token — sauces', () => {
    expect(parseTitle('ВИТРЕБЕНЬКИ. Крафтові соуси')).toBeNull();
  });

  it('returns null when there is no volume token — salo', () => {
    expect(parseTitle('Золота Сота – Найдорожче сало в Україні')).toBeNull();
  });

  it('does not treat a weight decimal as a volume', () => {
    expect(parseTitle('Сало традиційне 0.5кг')).toBeNull();
  });

  it('detects Cyrillic volume units (мл / л)', () => {
    expect(parseTitle('Brovar Lager 4% 500мл')).toEqual({ brewery: 'Brovar', name: 'Lager', abv: 4 });
    expect(parseTitle('Brovar Lager 4% 0,5л')).toEqual({ brewery: 'Brovar', name: 'Lager', abv: 4 });
  });

  it('single-token head → brewery equals name', () => {
    expect(parseTitle('Orval 330ml')).toEqual({ brewery: 'Orval', name: 'Orval' });
  });

  it('does not parse a gravity (°) reading as ABV', () => {
    expect(parseTitle('Vibrant IS 9° 330ml')).toEqual({ brewery: 'Vibrant', name: 'IS 9°' });
  });
});

describe('stripMerchandisingPrefix', () => {
  it.each([
    ['ПРЕДРЕЛІЗ Galaxy Juice', 'Galaxy Juice'],
    ['предреліз: Galaxy Juice', 'Galaxy Juice'],
    ['ПРЕДРЕДІЗ — Candlelit', 'Candlelit'],
    ['ПРОБНИК: MGM Tapped Ed.', 'MGM Tapped Ed.'],
  ])('strips an approved leading label from %s', (input, expected) => {
    expect(stripMerchandisingPrefix(input)).toBe(expected);
  });

  it('does not strip unknown or mid-name labels', () => {
    expect(stripMerchandisingPrefix('РЕЛІЗ Galaxy Juice')).toBe('РЕЛІЗ Galaxy Juice');
    expect(stripMerchandisingPrefix('Galaxy ПРЕДРЕЛІЗ Juice')).toBe('Galaxy ПРЕДРЕЛІЗ Juice');
    expect(stripMerchandisingPrefix('ПРОБНИК Galaxy Juice')).toBe('ПРОБНИК Galaxy Juice');
  });

  it('retains the original when cleanup would empty the name', () => {
    expect(stripMerchandisingPrefix('ПРЕДРЕЛІЗ')).toBe('ПРЕДРЕЛІЗ');
    expect(stripMerchandisingPrefix('ПРОБНИК:')).toBe('ПРОБНИК:');
  });
});

describe('isNonBeerTitle (secondary gate — sets/glassware that DO quote a volume)', () => {
  it('drops a tasting set bundled with a glass', () => {
    expect(isNonBeerTitle('Набір 4×0.33 + келих')).toBe(true);
    expect(isNonBeerTitle('Tasting set 4×0.33l')).toBe(true);
  });
  it('keeps a real beer whose name merely contains "set"', () => {
    expect(isNonBeerTitle('Sunset Hazy IPA 6% 330ml')).toBe(false);
  });
  it('keeps an ordinary beer', () => {
    expect(isNonBeerTitle('Burgomistr NEIPA 6% 500ml')).toBe(false);
  });
  it('drops merch the shared detector misses (local regex branch)', () => {
    expect(isNonBeerTitle('Flasker branded glass 0.33l')).toBe(true);   // \bglass\b, not in isNonBeerName
    expect(isNonBeerTitle('Сувенір set 330ml')).toBe(true);            // сувенір, not in isNonBeerName
  });
  it('drops Ukrainian glassware and bottle-openers (block-view merch)', () => {
    expect(isNonBeerTitle('Склянка Český Lager (500мл)')).toBe(true);
    expect(isNonBeerTitle('Відкривачка Cap Gun + 2 х 0.33 б/а пива')).toBe(true);
  });
  it('drops sets and snacks that quote a bottle volume', () => {
    expect(isNonBeerTitle('Сет 4 пива 0.33л')).toBe(true);
    expect(isNonBeerTitle('Соус крафтовий 0.33л')).toBe(true);
    expect(isNonBeerTitle('Сало в шоколаді 0.33')).toBe(true);
  });
});

describe('isNonBeerCategory (table data-product_cat hint)', () => {
  it('drops snack/merch categories', () => {
    expect(isNonBeerCategory('812:Снеки, ')).toBe(true);
    expect(isNonBeerCategory('900:Аксесуари, ')).toBe(true);
  });
  it('keeps a beer-style category', () => {
    expect(isNonBeerCategory('812:Темне міцне, ')).toBe(false);
  });
});

describe('flasker adapter', () => {
  it('hostMatch matches the shop and its subdomains, not others', () => {
    expect(flasker.hostMatch(new URL('https://flasker.com.ua/1-2/'))).toBe(true);
    expect(flasker.hostMatch(new URL('https://www.flasker.com.ua/store/'))).toBe(true);
    expect(flasker.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses cards from the SSR archive view (li.product)', () => {
    const cards = flasker.parseCards(load('flasker.html'));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.brewery.length).toBeGreaterThan(0);
    }
  });

  it('parses cards from the Barn2 product table view (tr[data-title])', () => {
    expect(flasker.parseCards(load('flasker.table.html')).length).toBeGreaterThan(0);
  });

  it('parses cards from the client-rendered block view (li.wc-block-grid__product)', () => {
    expect(flasker.parseCards(load('flasker.block.html')).length).toBeGreaterThan(0);
  });

  it('uses visible archive tags for canonical identity', () => {
    expect(findCard('flasker.html', 'Frost & Flame Imperial Porter')).toMatchObject({
      brewery: 'VibrantPour',
      name: 'Frost & Flame Imperial Porter',
      abv: 10,
    });
  });

  it('uses table data-product_tag when the title omits the brewery', () => {
    expect(findCard('flasker.table.html', 'Barely Beer')).toMatchObject({
      brewery: 'Mad Brew',
      name: 'Barely Beer',
      abv: 0,
    });
  });

  it('uses fixture tags for Flasker canonical identity', () => {
    expect(findCard('flasker.table.html', 'Berry Sour')).toMatchObject({
      brewery: 'Flasker',
      name: 'Berry Sour',
      abv: 6.5,
    });
  });

  it('uses fixture tags for Hoppy Hog canonical identity', () => {
    expect(findCard('flasker.table.html', 'Real Jam Fruit BOOM')).toMatchObject({
      brewery: 'Hoppy Hog Family Brewery',
      name: 'Real Jam Fruit BOOM',
      abv: 5,
    });
  });

  it('uses the block product URL when tags are unavailable', () => {
    expect(findCard('flasker.block.html', 'Barely Beer')).toMatchObject({
      brewery: 'Mad Brew',
      name: 'Barely Beer',
      abv: 0,
    });
  });

  it('uses fixture metadata for known malformed Flasker identities', () => {
    expect(findCard('flasker.table.html', 'The Lost Philosopher X')).toMatchObject({
      brewery: 'Mad Brew',
      name: 'The Lost Philosopher X',
    });

    expect(findCard('flasker.html', 'Royal Cookie')).toMatchObject({
      brewery: 'Copper Head. Beer Workshop',
      name: 'Royal Cookie',
      abv: 9,
    });

    expect(findCard('flasker.table.html', 'DE ZWARTE REGEL: Tweede Kring')).toMatchObject({
      brewery: 'Mad Brew',
      name: 'DE ZWARTE REGEL: Tweede Kring',
      abv: 6.5,
    });

    expect(findCard('flasker.table.html', 'Amber Ritual Hop Benediction')).toMatchObject({
      brewery: 'VibrantPour',
      name: 'Amber Ritual Hop Benediction',
      abv: 8,
    });
  });

  it('resolves a root-relative block product URL against the Flasker document', () => {
    const doc = new DOMParser().parseFromString(`
      <base href="https://flasker.com.ua/store/">
      <li class="wc-block-grid__product">
        <h2 class="wc-block-grid__product-title">
          <a href="/product/mad-barely-beer-0-abv-pale-ale-330ml/">Barely Beer 0% ABV 330ml</a>
        </h2>
      </li>
    `, 'text/html');

    expect(flasker.parseCards(doc)[0]).toMatchObject({
      brewery: 'Mad Brew',
      name: 'Barely Beer',
      abv: 0,
    });
  });

  it('drops every product on a non-beer page', () => {
    expect(flasker.parseCards(load('flasker.nonbeer.html'))).toEqual([]);
  });

  it('does not emit glassware/opener merch from the block view', () => {
    const brands = flasker.parseCards(load('flasker.block.html')).map((c) => c.brewery);
    expect(brands).not.toContain('Склянка');
    expect(brands).not.toContain('Відкривачка');
  });
});
