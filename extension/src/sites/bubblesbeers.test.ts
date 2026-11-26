import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bubblesbeers } from './bubblesbeers';

const html = readFileSync(
  resolve(__dirname, '../../tests/fixtures/bubblesbeers.html'),
  'utf8',
);

function parseFixture() {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return bubblesbeers.parseCards(doc);
}

function card(
  title: string,
  category = '',
  extraClasses = '',
  opts: { href?: string; successMessage?: string } = {},
): string {
  const hrefAttr = opts.href ? ` href="${opts.href}"` : '';
  const btnHtml = opts.successMessage
    ? `<a class="button add_to_cart_button" data-success_message="${opts.successMessage}">Añadir</a>`
    : '';
  return `
    <li class="product type-product ${extraClasses}">
      <div class="astra-shop-summary-wrap">
        <span class="ast-woo-product-category">${category}</span>
        <a class="ast-loop-product__link"${hrefAttr}>
          <h2 class="woocommerce-loop-product__title">${title}</h2>
        </a>
        ${btnHtml}
      </div>
    </li>
  `;
}

function parse(snippet: string) {
  const doc = new DOMParser().parseFromString(`<ul>${snippet}</ul>`, 'text/html');
  return bubblesbeers.parseCards(doc);
}

let cards: ReturnType<typeof bubblesbeers.parseCards>;
beforeAll(() => {
  cards = parseFixture();
});

describe('bubblesbeers adapter', () => {
  it('identifies non-beer pages like catas, blog, cart, checkout, and account', () => {
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/catas-de-cerveza/'))).toBe(true);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/blog-de-cerveza/'))).toBe(true);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/carrito/'))).toBe(true);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/finalizar-compra/'))).toBe(true);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/mi-cuenta/'))).toBe(true);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/mi-cuenta-2/'))).toBe(true);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/shop/'))).toBe(false);
    expect(bubblesbeers.isNonBeerPage?.(new URL('https://bubblesbeers.com/categoria-producto/lupuladas/'))).toBe(false);
  });

  it('parses all products from live fixture with exact match', () => {
    expect(cards).toHaveLength(12);

    for (const c of cards) {
      expect(c.el).toBeInstanceOf(HTMLElement);
    }

    expect(
      cards.map(({ brewery, name, style, nonBeer }) => ({
        brewery,
        name,
        style,
        nonBeer,
      })),
    ).toEqual([
      { brewery: 'Cervezas Althaia', name: 'Barlovento', style: 'Smoked Imperial Stout', nonBeer: undefined },
      { brewery: 'Cervezas Althaia', name: 'Mascarat', style: 'Black Rye IPA', nonBeer: undefined },
      { brewery: 'Cervezas Althaia', name: 'Mediterranean IPA', style: 'American ipa', nonBeer: undefined },
      { brewery: 'Cervezas Althaia', name: 'Mediterranean Tostada Sin Alcohol', style: undefined, nonBeer: undefined },
      { brewery: 'Attik Brewing', name: 'Smile', style: 'West Coast IPA sin gluten', nonBeer: undefined },
      { brewery: 'Attik Brewing', name: 'Zessie', style: 'Wild Ale Cereza', nonBeer: undefined },
      { brewery: '', name: '', style: undefined, nonBeer: true },
      { brewery: 'Garage Beer Co.', name: 'Lollies', style: 'Berliner weisse', nonBeer: undefined },
      { brewery: 'Garage Beer Co.', name: 'Stef', style: 'West Coast Pils', nonBeer: undefined },
      { brewery: 'Garage Beer Co.', name: 'Viduka', style: 'New England Pale Ale', nonBeer: undefined },
      { brewery: 'La Quince Brewing Co.', name: 'Mr. Bubbles', style: 'Czech Lager Sin Gluten', nonBeer: undefined },
      { brewery: 'La Quince Brewing Co.', name: 'The Wonder Blade', style: 'West Coast Pils – Sin gluten', nonBeer: undefined },
    ]);
  });

  it('never flags real beers with non-beer tokens in name or style as non-beer', () => {
    const realBeers = parse(`
      ${card('Oddity – Tangerine Dream – Hazy IPA')}
      ${card('Garage – Wolf Pack – IPA')}
      ${card('Althaia – Cream Soda Sour – Fruited Sour')}
      ${card('La Quince – Cola de Caballo – Stout')}
      ${card('Attik – Copa del Rey – Lager')}
      ${card('Yakka – Taller de cerveza – IPA')}
    `);

    expect(
      realBeers.map(({ brewery, name, style, nonBeer }) => ({
        brewery,
        name,
        style,
        nonBeer,
      })),
    ).toEqual([
      { brewery: 'Oddity Brewing', name: 'Tangerine Dream', style: 'Hazy IPA', nonBeer: undefined },
      { brewery: 'Garage Beer Co.', name: 'Wolf Pack', style: 'IPA', nonBeer: undefined },
      { brewery: 'Cervezas Althaia', name: 'Cream Soda Sour', style: 'Fruited Sour', nonBeer: undefined },
      { brewery: 'La Quince Brewing Co.', name: 'Cola de Caballo', style: 'Stout', nonBeer: undefined },
      { brewery: 'Attik Brewing', name: 'Copa del Rey', style: 'Lager', nonBeer: undefined },
      { brewery: 'Cervezas Yakka', name: 'Taller de cerveza', style: 'IPA', nonBeer: undefined },
    ]);
  });

  it('strips trailing volume from both beer name and style, keeping internal volume tokens', () => {
    const parsed = parse(`
      ${card('Garage – Soup – Hazy IPA 44cl')}
      ${card('Garage – Soup 33cl – IPA')}
      ${card('Althaia – Mistral 33cl')}
      ${card('Garage – 33cl of Happiness – IPA')}
    `);

    expect(
      parsed.map(({ brewery, name, style, nonBeer }) => ({
        brewery,
        name,
        style,
        nonBeer,
      })),
    ).toEqual([
      { brewery: 'Garage Beer Co.', name: 'Soup', style: 'Hazy IPA', nonBeer: undefined },
      { brewery: 'Garage Beer Co.', name: 'Soup', style: 'IPA', nonBeer: undefined },
      { brewery: 'Cervezas Althaia', name: 'Mistral', style: undefined, nonBeer: undefined },
      { brewery: 'Garage Beer Co.', name: '33cl of Happiness', style: 'IPA', nonBeer: undefined },
    ]);
  });

  it('parses single segment title matching known brewery with word boundary', () => {
    const [c] = parse(card('Yakka Querida Ipa', 'American IPA'));
    expect(c.brewery).toBe('Cervezas Yakka');
    expect(c.name).toBe('Querida Ipa');
    expect(c.nonBeer).toBeUndefined();

    const [saez] = parse(card('Sáez & Son Mistbound'));
    expect(saez.brewery).toBe('Sáez & Son');
    expect(saez.name).toBe('Mistbound');
  });

  it('requires word boundary for known brewery prefix and marks cards with unknown brewery as unparsed', () => {
    const parsed = parse(`
      ${card('Attikus Lager')}
      ${card('Althaias Something')}
      ${card('UnknownBrewery CoolBeer')}
    `);

    expect(
      parsed.map(({ brewery, name, skip, skipReason }) => ({ brewery, name, skip, skipReason })),
    ).toEqual([
      { brewery: '', name: 'Attikus Lager', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: 'Althaias Something', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: 'UnknownBrewery CoolBeer', skip: true, skipReason: 'unparsed' },
    ]);
  });

  it('skips products with empty titles after trimming', () => {
    const parsed = parse(`
      ${card('   ')}
      ${card('')}
    `);
    expect(parsed).toEqual([]);
  });

  it('prefers untranslated title from data-success_message over translated heading', () => {
    const [c] = parse(
      card('Althaia – Середземноморський IPA – Американський IPA', 'Американський IPA', '', {
        href: 'https://bubblesbeers.com/product/althaia-ipa/',
        successMessage: '«Althaia - Mediterranean IPA - American ipa» se ha añadido a tu carrito',
      }),
    );
    expect(c.brewery).toBe('Cervezas Althaia');
    expect(c.name).toBe('Mediterranean IPA');
    expect(c.style).toBe('American ipa');
  });

  it('splits titles with space-before-hyphen without trailing space and normalizes collabs', () => {
    const parsed = parse(`
      ${card('Yakka -Triple – Belgian tripel', 'Belgian Trippel')}
      ${card('Oso Brew X Pühaste – Choc-a-bloc – Imperial Stout', 'Colaboraciones')}
    `);
    expect(parsed[0]).toMatchObject({
      brewery: 'Cervezas Yakka',
      name: 'Triple',
      style: 'Belgian tripel',
    });
    expect(parsed[1]).toMatchObject({
      brewery: 'Oso Brew Co',
      name: 'Choc-a-bloc',
      style: 'Imperial Stout',
    });
  });

  it('applies slug overrides for storefront-specific names and collaborations', () => {
    const parsed = parse(`
      ${card('Rio Azul x LaQuince – A giant leap for an ape – Tiramisu patry stout', 'Colaboraciones', '', {
        href: 'https://bubblesbeers.com/product/rio-azul-x-laquince-a-giant-leap-for-an-ape-tiramisu-patry-stout/',
      })}
      ${card('Sáez & Son – Fresh Press – Terp Smoothie Sour', 'Ácidas', '', {
        href: 'https://bubblesbeers.com/product/saez-son-saezsonf-fresh-press-te-rp-smoothiesour/',
      })}
      ${card('Saez&Son – Felippa – West Coast IPA', 'American IPA', '', {
        href: 'https://bubblesbeers.com/product/saezson-felippa-west-coast-ipa/',
      })}
      ${card('Oddity – Wildfire – Neipa', 'Hazy IPA', '', {
        href: 'https://bubblesbeers.com/product/oddity-wildfires/',
      })}
      ${card('Oso Brew Co. – Mesa – Table Beer', 'Lupuladas', '', {
        href: 'https://bubblesbeers.com/product/oso-brew-co-mesa-table-beer/',
      })}
    `);
    expect(parsed[0]).toMatchObject({ brewery: 'La Quince Brewing Co.', name: 'A GIANT LEAP FOR AN APE!' });
    expect(parsed[1]).toMatchObject({ brewery: 'Sáez & Son', name: 'TERP Fresh Press' });
    expect(parsed[2]).toMatchObject({ brewery: 'FELIPPA BREW CO by Sáez & Son', name: 'FELIPPA' });
    expect(parsed[3]).toMatchObject({ brewery: 'Oddity Brewing', name: 'Wildfires' });
    expect(parsed[4]).toMatchObject({ skip: true, skipReason: 'unparsed' });
  });

  it('marks packs, surprise boxes, merchandise and sodas as non-beer via brand, categories and WooCommerce classes', () => {
    const nonBeers = parse(`
      ${card('Caja Sorpresa 12 Cervezas Artesanas – Pack Degustación Variado', 'Packs')}
      ${card('Pack Garage Beer – Mecánicos del lúpulo', 'Packs', 'product_cat-packs')}
      ${card('Luno Soda – Retro Cola', 'Refrescos', 'product_tag-soda')}
      ${card('Bubbles Beer Club (Club Cervecero)', 'Club')}
      ${card('Merchandise Product', 'Packs', 'product_tag-caja-sorpresa')}
      ${card('Some Item', '', 'product_tag-pack-cervezas')}
      ${card('Degustation Set', '', 'product_tag-pack-degustacion')}
      ${card('Tonic Can', '', 'product_cat-refrescos')}
      ${card('Lemon Soda', '', 'product_tag-refrescos')}
    `);

    expect(nonBeers).toHaveLength(9);
    for (const c of nonBeers) {
      expect(c.nonBeer).toBe(true);
      expect(c.skip).toBeUndefined();
    }
  });

  it('marks incomplete titles with missing segments, volume-only names, or brewery-only titles as unparsed', () => {
    const unparsed = parse(`
      ${card('Garage – – IPA')}
      ${card('– Soup – Hazy IPA')}
      ${card('Garage – 44cl – IPA')}
      ${card('Althaia – ')}
      ${card('Garage Beer Co.')}
      ${card('La Quince Brewing Co.')}
    `);

    expect(
      unparsed.map(({ brewery, name, skip, skipReason }) => ({ brewery, name, skip, skipReason })),
    ).toEqual([
      { brewery: '', name: 'Garage – – IPA', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: '– Soup – Hazy IPA', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: 'Garage – 44cl – IPA', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: 'Althaia –', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: 'Garage Beer Co.', skip: true, skipReason: 'unparsed' },
      { brewery: '', name: 'La Quince Brewing Co.', skip: true, skipReason: 'unparsed' },
    ]);
  });
});
