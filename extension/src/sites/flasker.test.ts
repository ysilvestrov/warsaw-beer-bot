import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseTitle, stripMerchandisingPrefix, isNonBeerTitle, isNonBeerCategory, flasker,
  breweryFromRegistryTags, breweryFromRegistryHead,
} from './flasker';

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
      .toEqual({ brewery: 'Rebrew', name: 'Труханів Острів SIPA', abv: 4.3 });
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
      {
        productTags: ['Imperial Stout'],
        productUrl: 'https://flasker.com.ua/product/unknown-mystery-beer-5-330ml/',
      },
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

  it('cleans a leading merchandising banner before metadata resolution', () => {
    expect(parseTitle('ПРЕДРЕЛІЗ Galaxy Juice 6% 330ml', {
      productTags: ['mad brew'],
    })).toEqual({ brewery: 'Mad Brew', name: 'Galaxy Juice', abv: 6 });
  });

  // The name-side stripMerchandisingPrefix call is only reachable for a banner that
  // lands mid-title (not at the very head, which the head-level strip above already
  // handles) — here the fallback splitBreweryName hands "Foo" to the brewery, leaving
  // the banner leading the name, where the second strip removes it.
  it('cleans a mid-title merchandising banner on the name side (fallback split)', () => {
    expect(parseTitle('Foo ПРЕДРЕЛІЗ Bar 4% 330ml')).toEqual({ brewery: 'Foo', name: 'Bar', abv: 4 });
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

  // #385: Tomatøl is a Mad Brew series, and the title carries only the series
  // name — the fallback split would emit "Tomatol" as the brewery.
  it('resolves the Tomatol series to Mad Brew from the product slug', () => {
    expect(parseTitle('Tomatol Bulgogi 3.8% 330мл', {
      productUrl: 'https://flasker.com.ua/product/tomatol-bulgogi-3-8-330мл/',
    })).toEqual({ brewery: 'Mad Brew', name: 'Tomatol Bulgogi', abv: 3.8 });
    expect(parseTitle('Tomatol Wasabi 3.8% 330мл', {
      productUrl: 'https://flasker.com.ua/product/tomatol-wasabi-3-8-330%d0%bc%d0%bb/',
    })).toEqual({ brewery: 'Mad Brew', name: 'Tomatol Wasabi', abv: 3.8 });
  });

  // The trailing hyphen is what keeps `tomatol-` off Tomatoland (a real, unrelated
  // Odna Tonna beer) — without it the prefix would swallow that brewery too.
  it('does not let the Tomatol family prefix swallow Tomatoland', () => {
    expect(parseTitle('Tomatoland Mountain Herbs 5% 330ml', {
      productUrl: 'https://flasker.com.ua/product/tomatoland-mountain-herbs-5-330ml/',
    })).toEqual({ brewery: 'Tomatoland', name: 'Mountain Herbs', abv: 5 });
  });

  // #385/#376: pre-release listings prefix the slug with `предреліз-`, which hid the
  // family prefix from the resolver (34198 "ПРЕДРЕЛІЗ: Tomatol Wasabi"). The banner
  // is stripped from the slug the same way it is stripped from the title.
  it('sees through the ПРЕДРЕЛІЗ slug banner to the family prefix', () => {
    expect(parseTitle('ПРЕДРЕЛІЗ: Tomatol Wasabi 3.8% 330мл', {
      productUrl: 'https://flasker.com.ua/product/предреліз-tomatol-wasabi-3-8-330мл/',
    })).toEqual({ brewery: 'Mad Brew', name: 'Tomatol Wasabi', abv: 3.8 });
  });

  it('sees through the ПРЕДРЕЛІЗ slug banner to a plain brewery prefix', () => {
    expect(parseTitle('Hoppy Hog Charred Memory IS 10% 330ml', {
      productUrl: 'https://flasker.com.ua/product/предреліз-hoppy-hog-charred-memory-is-10-330ml/',
    })).toEqual({ brewery: 'Hoppy Hog Family Brewery', name: 'Charred Memory IS', abv: 10 });
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

  it('registry: two-word brewery at the head splits correctly (no tags)', () => {
    expect(parseTitle('Хмільний кіт №4 APA 5.5% 330ml'))
      .toEqual({ brewery: 'Хмільний кіт', name: '№4 APA', abv: 5.5 });
  });

  it('registry: canonicalizes an abbreviation brewery from the title head', () => {
    expect(parseTitle('KLB Kyiv Lager 4.8% 500ml'))
      .toEqual({ brewery: 'Kyiv Local Brewery', name: 'Kyiv Lager', abv: 4.8 });
  });

  it('registry: transliterates a Cyrillic brewery to its catalog form', () => {
    expect(parseTitle('Правда Framboise 5% 330ml'))
      .toEqual({ brewery: 'Pravda', name: 'Framboise', abv: 5 });
  });

  it('registry: resolves via a brewery tag when the head omits it', () => {
    expect(parseTitle('Some Guest Gose 4% 330ml', { productTags: ['REBREW', 'Gose'] }))
      .toEqual({ brewery: 'Rebrew', name: 'Some Guest Gose', abv: 4 });
  });

  it('registry: unknown brewery still falls back to the first-word split', () => {
    expect(parseTitle('Unknownbrew Mystery Ale 5% 330ml'))
      .toEqual({ brewery: 'Unknownbrew', name: 'Mystery Ale', abv: 5 });
  });

  it('does not let a pre-release banner become the brewery (#376)', () => {
    expect(parseTitle('ПРЕДРЕЛІЗ White Chalk Stout 6% 330ml'))
      .toEqual({ brewery: 'White', name: 'Chalk Stout', abv: 6 });
  });

  it('resolves the registry brewery hidden behind a banner prefix (#376)', () => {
    // "DE ZWARTE REGEL" from the task brief has no registry entry reachable by
    // breweryFromRegistryHead (confirmed live: it is only known via a
    // productUrl family-slug rule, not by title text) — REBREW is a real
    // registry entry, so it demonstrates the actual bug: pre-fix, the banner
    // sits in front of "REBREW" so breweryFromRegistryHead's prefix match
    // never fires and splitBreweryName takes "ПРЕДРЕЛІЗ" as the brewery;
    // post-fix, the banner is stripped first and the registry match succeeds.
    expect(parseTitle('ПРЕДРЕЛІЗ REBREW Some Guest Gose 4% 330ml'))
      .toEqual({ brewery: 'Rebrew', name: 'Some Guest Gose', abv: 4 });
  });

  it('leaves a colon-bearing brewery alone when there is no banner (negative guard)', () => {
    // No registry entry for "DE ZWARTE REGEL" exists (verified against
    // flasker-breweries.generated.ts), so this is the pre-existing
    // first-word fallback — unrelated to the fix, and unchanged by it since
    // there is no banner here for stripMerchandisingPrefix to act on.
    expect(parseTitle('DE ZWARTE REGEL: Laatste Plicht 9 9% 330ml'))
      .toEqual({ brewery: 'DE', name: 'ZWARTE REGEL: Laatste Plicht 9', abv: 9 });
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

describe('registry lookup helpers', () => {
  it('breweryFromRegistryTags matches a brewery tag case-insensitively', () => {
    expect(breweryFromRegistryTags(['330 ml', 'COPPER', 'REBREW', 'Україна'])?.canonical).toBe('Rebrew');
  });

  it('breweryFromRegistryTags returns null when no tag is a known brewery', () => {
    expect(breweryFromRegistryTags(['Imperial Stout', 'Україна'])).toBeNull();
  });

  it('breweryFromRegistryTags returns null when two different breweries tie', () => {
    expect(breweryFromRegistryTags(['REBREW', 'Burgomistr'])).toBeNull();
  });

  it('breweryFromRegistryHead matches the longest brewery prefix of the head', () => {
    const hit = breweryFromRegistryHead('Хмільний кіт №4 APA');
    expect(hit?.brewery.canonical).toBe('Хмільний кіт');
    expect(hit?.matched).toBe('Хмільний кіт');
  });

  it('breweryFromRegistryHead requires a word boundary (no partial-token match)', () => {
    expect(breweryFromRegistryHead('DUMArine Special')).toBeNull();
  });

  it('breweryFromRegistryHead returns null when the head starts with an unknown brewery', () => {
    expect(breweryFromRegistryHead('ШО (IIIO) Totem IPA')).toBeNull();
  });
});

describe('flasker non-beer gates', () => {
  it('drops a 0% ginger beer but keeps a 0% beer (#376)', () => {
    const html = `<ul>
      <li class="product"><h2 class="woocommerce-loop-product__title">Old Jamaica Ginger Beer Regular 0% 330ml</h2></li>
      <li class="product"><h2 class="woocommerce-loop-product__title">AleBrowar Kwas Chlebowy Jasny 0% 500ml</h2></li>
    </ul>`;
    const names = flasker.parseCards(new DOMParser().parseFromString(html, 'text/html')).map((c) => c.name);
    expect(names).toContain('Kwas Chlebowy Jasny');
    expect(names.join(' ')).not.toContain('Ginger Beer');
  });

  // #376 follow-up: splitBreweryName hands the leading brand token ("Ginger"/"Root") to
  // the brewery, so a name-only check would miss these — the gate must see brewery+name.
  it('drops a title that STARTS with the family phrase, where the brand token goes to the brewery', () => {
    const html = `<ul>
      <li class="product"><h2 class="woocommerce-loop-product__title">Ginger Beer Old Jamaica 0% 330ml</h2></li>
    </ul>`;
    const cards = flasker.parseCards(new DOMParser().parseFromString(html, 'text/html'));
    expect(cards).toEqual([]);
  });

  it('drops a 0% root beer title', () => {
    const html = `<ul>
      <li class="product"><h2 class="woocommerce-loop-product__title">Root Beer 0% 355ml</h2></li>
    </ul>`;
    const cards = flasker.parseCards(new DOMParser().parseFromString(html, 'text/html'));
    expect(cards).toEqual([]);
  });
});
