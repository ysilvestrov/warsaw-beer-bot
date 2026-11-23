import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extramagazin } from './extramagazin';
import { normalizeKey } from '../shared/normalize';

const beerHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/extramagazin.html'), 'utf8');
const nonBeerHtml = readFileSync(resolve(__dirname, '../../tests/fixtures/extramagazin.nonbeer.html'), 'utf8');

function cardHtml(opts: {
  brand: string;
  title: string;
  visibleTitle?: string;
  href?: string;
}): string {
  const visible = opts.visibleTitle ?? opts.title;
  const href = opts.href ?? 'https://extramagazin.es/uk/products/cerveza-test.html';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `
    <div id="js-product-list">
      <div class="product_content grid">
        <article class="js-product-miniature style_product1" data-id-product="1">
          <div class="product_desc">
            <div class="manufacturer"><a href="https://extramagazin.es/uk/brands/test">${opts.brand}</a></div>
            <h3><a href="${href}" class="product_name" title="${esc(opts.title)}">${visible}</a></h3>
          </div>
        </article>
      </div>
    </div>
  `;
}

function parse(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return extramagazin.parseCards(doc);
}

describe('extramagazin adapter', () => {
  it('matches extramagazin.es apex and subdomains, and rejects lookalike hosts', () => {
    expect(extramagazin.hostMatch(new URL('https://extramagazin.es/uk/cerveza'))).toBe(true);
    expect(extramagazin.hostMatch(new URL('https://www.extramagazin.es/cerveza'))).toBe(true);
    expect(extramagazin.hostMatch(new URL('https://extramagazin.es.example.com/uk/cerveza'))).toBe(false);
  });

  it.each([
    'https://extramagazin.es/uk/cerveza',
    'https://extramagazin.es/uk/cerveza/2',
    'https://extramagazin.es/uk/cerveza-clasica',
    'https://extramagazin.es/uk/cerveza-sin-alcohol',
    'https://extramagazin.es/uk/cerveza-con-aditivos-0',
    'https://extramagazin.es/uk/cerveza-afrutada',
    'https://extramagazin.es/cerveza',
    'https://extramagazin.es/pl/cerveza-clasica',
    'https://extramagazin.es/uk/sidra',
    'https://extramagazin.es/uk/kvas',
    'https://extramagazin.es/uk/hidromiel',
    'https://extramagazin.es/uk/',
    'https://extramagazin.es/',
    'https://extramagazin.es/uk/bebidas-alcoholicas',
    'https://extramagazin.es/uk/bebidas-y-refrescos',
    'https://extramagazin.es/uk/tienda',
    'https://extramagazin.es/uk/novedades',
    'https://extramagazin.es/uk/ofertas',
    'https://extramagazin.es/uk/productos-rebajados',
    'https://extramagazin.es/uk/brands',
    'https://extramagazin.es/uk/brands/opillia',
    'https://extramagazin.es/uk/search',
    'https://extramagazin.es/uk/busqueda',
    'https://extramagazin.es/uk/module/x/search',
    'https://extramagazin.es/uk/products/lager-x.html',
    'https://extramagazin.es/uk/products/cerveza-ipa-60-24x568-ml-lata-volfas-engelman.html',
    'https://extramagazin.es/uk/products/bebida-fermentada-kvas-blanco-24500-ml-lata-opillia.html',
  ])('allows eligible, mixed, and unknown catalog page %s', (url) => {
    expect(extramagazin.isNonBeerPage?.(new URL(url))).toBe(false);
  });

  it.each([
    'https://extramagazin.es/uk/caviar',
    'https://extramagazin.es/uk/vodka',
    'https://extramagazin.es/uk/vino',
    'https://extramagazin.es/uk/bebidas-suaves',
    'https://extramagazin.es/uk/snacks',
    'https://extramagazin.es/uk/agua',
    'https://extramagazin.es/caviar',
    'https://extramagazin.es/uk/products/caviar-de-salmon-keta-en-cristal-12x150-g-lemberg.html',
  ])('blocks known non-beer category or product page %s', (url) => {
    expect(extramagazin.isNonBeerPage?.(new URL(url))).toBe(true);
  });

  it('parses all 24 beer cards from the live /uk/cerveza fixture with canonical Untappd identities', () => {
    const cards = parse(beerHtml);
    expect(cards.map(({ brewery, name, abv, nonBeer }) => ({ brewery, name, abv, nonBeer }))).toEqual([
      { brewery: 'Grupa Żywiec', name: 'Warka Energy Original 0.0%', abv: 0, nonBeer: undefined },
      {
        brewery: 'Carlsberg Ukraine',
        name: 'Львівське 1715 Безалкогольне (Lvivske 1715 Bezalkoholne) 0.0%',
        abv: 0,
        nonBeer: undefined,
      },
      { brewery: 'Browar Łomża', name: 'Łomża Mocna Wiśnia 9%', abv: 9, nonBeer: undefined },
      { brewery: 'Browar Łomża', name: 'Łomża 0,0%', abv: 0, nonBeer: undefined },
      { brewery: 'Perła - Browary Lubelskie S.A.', name: 'PERLA CHMIELOWA', abv: 6, nonBeer: undefined },
      { brewery: 'Lech Browary Wielkopolski', name: 'LECH PREMIUM', abv: 5, nonBeer: undefined },
      { brewery: 'Tyskie Browary Książęce', name: 'Tyskie Gronie', abv: 5.5, nonBeer: undefined },
      { brewery: 'Pivovar Velké Popovice', name: 'Kozel Premium Lager / Kozel 11', abv: 4.6, nonBeer: undefined },
      { brewery: 'Żywiec', name: 'ZYWIEC', abv: 5.6, nonBeer: undefined },
      { brewery: 'Ursus Breweries SA', name: 'Ursus Premium', abv: 5, nonBeer: undefined },
      { brewery: 'Carlsberg Ukraine', name: 'Lvivske Blonde', abv: 3.7, nonBeer: undefined },
      {
        brewery: 'AB InBev Efes',
        name: 'Stary Melnik Iz Bochonka Myagkoe (Старый Мельник Из Бочонка Мягкое) (Staryi Melnyk Yz Bochonka Miahkoe)',
        abv: 4.2,
        nonBeer: undefined,
      },
      { brewery: 'Pivovar Velké Popovice', name: 'Kozel Černý / Dark', abv: 3.8, nonBeer: undefined },
      { brewery: 'Żywiec', name: 'ZYWIEC', abv: 5.6, nonBeer: undefined },
      {
        brewery: 'Lidskae Piva (Лідскае Піва)',
        name: 'Zhigulevskoe special (Жигулевское Специальное) (Zhyhulevskoe Spetsyalnoe)',
        abv: 5.2,
        nonBeer: undefined,
      },
      { brewery: 'Carlsberg Ukraine', name: 'Lvivske 1715', abv: 4.5, nonBeer: undefined },
      { brewery: 'Volfas Engelman', name: 'IPA', abv: 6, nonBeer: undefined },
      { brewery: 'Volfas Engelman', name: 'APA', abv: 5, nonBeer: undefined },
      { brewery: 'Опілля (Opillia)', name: 'DUNKEL EXPORT', abv: 4.8, nonBeer: undefined },
      { brewery: 'Опілля (Opillia)', name: '1851 EXPORT', abv: 4.7, nonBeer: undefined },
      { brewery: 'AB InBev Efes Ukraine', name: 'Чернігівське Light (Chernihivske)', abv: 4.3, nonBeer: undefined },
      { brewery: 'Опілля (Opillia)', name: 'Білий Келих (Bilyi Kelykh)', abv: 4.2, nonBeer: undefined },
      { brewery: 'Опілля (Opillia)', name: 'Корифей (Koryfei)', abv: 4.2, nonBeer: undefined },
      { brewery: 'Browar Namysłów', name: 'Namysłów Pils', abv: 5.8, nonBeer: undefined },
    ]);
  });

  it('prefers untruncated a.product_name[title] over truncated visible text', () => {
    const cards = parse(
      cardHtml({
        brand: 'OPILLIA',
        title: 'Пиво світле 1851 EXPORT 4.7% 12x500 мл ОПІЛЛЯ',
        visibleTitle: 'Пиво світле 1851 EXPORT 4.7% 12x500...',
      }),
    );

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Опілля (Opillia)', name: '1851 EXPORT', abv: 4.7 },
    ]);
  });

  it('falls back to JSON-LD ItemList when the title attribute is also truncated', () => {
    const doc = new DOMParser().parseFromString(
      `
        <head>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
              {"@type":"ListItem","position":0,"name":"Пиво світле 1851 EXPORT 4.7% 12x500 мл ОПІЛЛЯ","url":"https://extramagazin.es/uk/products/cerveza-test-jsonld.html"}
            ]}
          </script>
        </head>
        <body>
          <div id="js-product-list">
            <article class="js-product-miniature" data-id-product="39113">
              <div class="manufacturer"><a href="/uk/brands/opillia">OPILLIA</a></div>
              <h3><a href="https://extramagazin.es/uk/products/cerveza-test-jsonld.html" class="product_name" title="Пиво світле 1851 EXPORT 4.7% 12x500...">Пиво світле 1851 EXPORT 4.7% 12x500...</a></h3>
            </article>
          </div>
        </body>
      `,
      'text/html',
    );
    const grid = doc.querySelector('#js-product-list')!;
    const cards = extramagazin.parseCards(grid);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Опілля (Opillia)', name: '1851 EXPORT', abv: 4.7 },
    ]);
  });

  it('distinguishes 0.0% Lvivske 1715 from regular 4.5% Lvivske 1715', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'LVIVSKE',
        title: 'Пиво безалкогольне «1715» 0,0% 20×450 мл ЛЬВІВСЬКЕ',
        href: 'https://extramagazin.es/uk/products/cerveza-sin-alcohol-1715-00-20450-ml-lvivske.html',
      })}
      ${cardHtml({
        brand: 'LVIVSKE',
        title: 'Пиво «1715» 4,5% 24×480 мл ж/б ЛЬВІВСЬКЕ',
        href: 'https://extramagazin.es/uk/products/cerveza-1715-45-24480-ml-lata-lvivske.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Carlsberg Ukraine', name: 'Львівське 1715 Безалкогольне (Lvivske 1715 Bezalkoholne) 0.0%', abv: 0 },
      { brewery: 'Carlsberg Ukraine', name: 'Lvivske 1715', abv: 4.5 },
    ]);
  });

  it('keeps the alcohol-free 1715 override and a regular 1715 on an unknown slug under different cache keys', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'LVIVSKE',
        title: 'Пиво безалкогольне «1715» 0,0% 20×450 мл ЛЬВІВСЬКЕ',
        href: 'https://extramagazin.es/uk/products/cerveza-sin-alcohol-1715-00-20450-ml-lvivske.html',
      })}
      ${cardHtml({
        brand: 'LVIVSKE',
        title: 'Пиво «1715» 4,7% 20×500 мл ЛЬВІВСЬКЕ',
        href: 'https://extramagazin.es/uk/products/cerveza-1715-47-20500-ml-lvivske.html',
      })}
    `);

    expect(cards.map(({ brewery, name }) => normalizeKey(brewery, name))).toEqual([
      'carlsberg ukraine|львівське 1715 безалкогольне lvivske 1715 bezalkoholne 0 0',
      'carlsberg ukraine|1715',
    ]);
  });

  it('drops trailing producer name VAN PUR from LOMZA 0.0%', () => {
    const cards = parse(
      cardHtml({
        brand: 'LOMZA',
        title: 'Пиво світле LOMZA 0.0% 500мл VAN PUR',
        href: 'https://extramagazin.es/uk/products/cerveza-test.html',
      }),
    );

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Browar Łomża', name: 'LOMZA 0.0%', abv: 0 },
    ]);
  });

  it('does not confuse 5.0% LOMZA with the 0.0% slug override', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'LOMZA',
        title: 'Пиво світле LOMZA 0.0% 500мл VAN PUR',
        href: 'https://extramagazin.es/uk/products/cerveza-clara-lomza-00-500-ml-van-pur.html',
      })}
      ${cardHtml({
        brand: 'LOMZA',
        title: 'Пиво світле LOMZA 5.0% 500мл VAN PUR',
        href: 'https://extramagazin.es/uk/products/cerveza-clara-lomza-50-500-ml-van-pur.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Browar Łomża', name: 'Łomża 0,0%', abv: 0 },
      { brewery: 'Browar Łomża', name: 'LOMZA', abv: 5 },
    ]);
  });

  it('resolves KAYAKI override regardless of pack size and falls back to trailing brewery when manufacturer is Marcas variadas', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'Marcas variadas',
        title: 'Пиво світле 4,7% 20×500 мл KAYAKI',
        href: 'https://extramagazin.es/uk/products/cerveza-clara-47-20500-ml-kayaki.html',
      })}
      ${cardHtml({
        brand: 'Marcas variadas',
        title: 'Пиво світле 4,7% 20×500 мл KAYAKI',
        href: 'https://extramagazin.es/uk/products/cerveza-test.html',
      })}
      ${cardHtml({
        brand: 'KOZEL',
        title: 'Пиво KOZEL "ЧОРНЕ" 3.8% 24x500 мл',
        href: 'https://extramagazin.es/uk/products/cerveza-negro-38-24x500-ml-lata-kozel.html',
      })}
      ${cardHtml({
        brand: 'PERLA',
        title: 'Пиво «Mago con maracuya» 4,0% 12×330 мл PERLA',
        href: 'https://extramagazin.es/uk/products/cerveza-mago-con-maracuya-4-12x330-ml-perla.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Global Beer Georgia', name: 'Kayaki', abv: 4.7 },
      { brewery: 'KAYAKI', name: 'KAYAKI', abv: 4.7 },
      { brewery: 'Pivovar Velké Popovice', name: 'Kozel Černý / Dark', abv: 3.8 },
      { brewery: 'Perła - Browary Lubelskie S.A.', name: 'Perła Mango z Marakują', abv: 4 },
    ]);
  });

  it('canonically resolves Lvivske Svitle to Lvivske Blonde without slug override', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'LVIVSKE',
        title: 'Пиво світле «Світле» 3,7% 20×500 мл ЛЬВІВСЬКЕ',
        href: 'https://extramagazin.es/uk/products/cerveza-test.html',
      })}
      ${cardHtml({
        brand: 'LVIVSKE',
        title: 'Cerveza clara «Svitlo» 3,7% 20×500 ml',
        href: 'https://extramagazin.es/products/cerveza-test.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Carlsberg Ukraine', name: 'Lvivske Blonde', abv: 3.7 },
      { brewery: 'Carlsberg Ukraine', name: 'Lvivske Blonde', abv: 3.7 },
    ]);
  });

  it.each([
    ['Пиво KOZEL "ЧОРНЕ" 3.8% 20x500мл', 'Kozel Černý / Dark', 3.8],
    ['Piwo "KOZEL CIEMNE" 3 8% 20x500ml', 'Kozel Černý / Dark', 3.8],
    ['Cerveza "NEGRO" 3.8% 20x500 ml KOZEL', 'Kozel Černý / Dark', 3.8],
    ['Пиво "ЧЕРНОЕ" 3.8% 20х500 мл KOZEL', 'Kozel Černý / Dark', 3.8],
    ['Bere "KOZEL NEAGRĂ" 3.8% 20x500ml', 'Kozel Černý / Dark', 3.8],
    ['Пиво KOZEL світле 4.6% 20x500мл', 'Kozel Premium Lager / Kozel 11', 4.6],
    ['Cerveza "KOZEL" claro 4.6% 20x500 ml', 'Kozel Premium Lager / Kozel 11', 4.6],
    ['Piwo KOZEL jasne 4.6% 20x500ml', 'Kozel Premium Lager / Kozel 11', 4.6],
  ])('canonically resolves Kozel title %s via name fallback to %s', (title, expectedName, expectedAbv) => {
    const cards = parse(cardHtml({ brand: 'KOZEL', title }));
    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Pivovar Velké Popovice', name: expectedName, abv: expectedAbv },
    ]);
  });

  it.each([
    ['KOZEL', 'Cerveza KOZEL claro 0.0% 500 ml', { brewery: 'Pivovar Velké Popovice', name: 'claro 0.0%', abv: 0 }],
    ['KOZEL', 'Cerveza KOZEL negro 5.2% 500 ml', { brewery: 'Pivovar Velké Popovice', name: 'KOZEL negro', abv: 5.2 }],
    ['LVIVSKE', 'Cerveza LVIVSKE clara 4.8% 500 ml', { brewery: 'Carlsberg Ukraine', name: 'clara', abv: 4.8 }],
    [
      'TYSKIE',
      'Пиво "BROWARY KSIAZECE" 0.0% 500 мл TYSKIE',
      { brewery: 'Tyskie Browary Książęce', name: 'BROWARY KSIAZECE 0.0%', abv: 0 },
    ],
    ['ZYWIEC', 'Пиво світле NAMYSLOW 6,5% 24×500 мл ж б ZYWIEC', { brewery: 'Żywiec', name: 'NAMYSLOW', abv: 6.5 }],
  ])('leaves a %s card with an unproven ABV (%s) to generic matching', (brand, title, expected) => {
    const cards = parse(cardHtml({ brand, title }));
    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([expected]);
  });

  it('canonically resolves Tyskie Browary Książęce and Namysłów fallback names', () => {
    const cards = parse(`
      ${cardHtml({ brand: 'TYSKIE', title: 'Пиво "BROWARY KSIAZECE" 5.5% 500 мл TYSKIE' })}
      ${cardHtml({ brand: 'ZYWIEC', title: 'Пиво світле NAMYSLOW 5,8% 24×500 мл ж б ZYWIEC' })}
    `);
    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'Tyskie Browary Książęce', name: 'Tyskie Gronie', abv: 5.5 },
      { brewery: 'Browar Namysłów', name: 'Namysłów Pils', abv: 5.8 },
    ]);
  });

  it.each([
    ['OPILLIA', 'Опілля (Opillia)', 'Пиво світле «Хмелевар» 4,2% розливне 1 л ОПІЛЛЯ', 'Хмелевар (Khmelevar)'],
    ['OPILLIA', 'Опілля (Opillia)', 'Cerveza clara «Bily kalykh» 4,2% de barril 1 L OPILLIA', 'Bily kalykh'],
    ['OPILLIA', 'Опілля (Opillia)', 'Piwo jasne „Korifey export” 4,2% lane 1 L OPILLIA', 'Korifey export'],
    ['OPILLIA', 'Опілля (Opillia)', 'Bere blondă „Korifey export” 4,2% la draft. 1 l. OPILLIA', 'Korifey export'],
  ])('parses draft beer title %s across locales', (brand, expectedBrewery, title, expectedName) => {
    const cards = parse(cardHtml({ brand, title }));
    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: expectedBrewery, name: expectedName, abv: 4.2 },
    ]);
  });

  it.each([
    [
      'es',
      'URSUS',
      'Cerveza Ursus PREMIUM Blonde Lager 5.0% 24x500 ml lata',
      'https://extramagazin.es/products/cerveza-ursus-premium-blonde-lager-50-24x500-ml-lata.html',
      'Ursus Breweries SA',
      'Ursus Premium',
      5,
    ],
    [
      'es-ch',
      'CHERNIGIVSKE',
      'Cerveza clara «Chernigivske light» 4,3% 24×500 ml lata',
      'https://extramagazin.es/products/cerveza-clara-chernigivske-light-43-24500-ml-lata.html',
      'AB InBev Efes Ukraine',
      'Чернігівське Light (Chernihivske)',
      4.3,
    ],
    [
      'pl-space-abv',
      'KOZEL',
      'Piwo "KOZEL CIEMNE" 3 8% 20x500ml',
      'https://extramagazin.es/pl/products/cerveza-negro-38-20x500-ml-kozel.html',
      'Pivovar Velké Popovice',
      'Kozel Černý / Dark',
      3.8,
    ],
    [
      'pl-lomza',
      'LOMZA',
      'Piwo jasne "ŁOMŻA" 0.0% 500ml VAN PUR',
      'https://extramagazin.es/pl/products/cerveza-clara-lomza-00-500-ml-van-pur.html',
      'Browar Łomża',
      'Łomża 0,0%',
      0,
    ],
    [
      'ru-dot-pack',
      'URSUS',
      'Пиво традиционный лагер URSUS 5.0% 24x.500 мл',
      'https://extramagazin.es/ru/products/cerveza-test.html',
      'Ursus Breweries SA',
      'традиционный лагер URSUS (tradytsyonnyi laher)',
      5,
    ],
    [
      'ro',
      'VOLFAS ENGELMAN',
      'Bere IPA 6.0% 24x0.568 l doze VOLFAS ENGELMAN',
      'https://extramagazin.es/ro/products/cerveza-ipa-60-24x568-ml-lata-volfas-engelman.html',
      'Volfas Engelman',
      'IPA',
      6,
    ],
  ])('parses locale %s quirks cleanly', (_case, brand, title, href, expectedBrewery, expectedName, expectedAbv) => {
    const cards = parse(cardHtml({ brand, title, href }));
    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: expectedBrewery, name: expectedName, abv: expectedAbv },
    ]);
  });

  it('parses kvass cards cleanly without leaking Cyrillic prefix onto Latin kvass names', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'LIDSKIY',
        title: 'Квас ЛІДСЬКИЙ "ХЛІБНИЙ" ж/б 24x450ml',
        href: 'https://extramagazin.es/uk/products/refresco-fermentado-de-pan-lidskiy-jlebniy-lata-24x450-ml.html',
      })}
      ${cardHtml({
        brand: 'LIDSKIY',
        title: 'Квас ЛІДСЬКИЙ темний 1.5 л',
        href: 'https://extramagazin.es/uk/products/refresco-fermentado-de-pan-lidskiy-oscuro-6x15l.html',
      })}
      ${cardHtml({
        brand: 'Marcas variadas',
        title: 'Квас Тарас чорний 12×500 мл',
        href: 'https://extramagazin.es/uk/products/kvas-taras-negro-12500-ml-kayaki.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Квас Білий живого бродіння ж/б 24×500 мл ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/bebida-fermentada-kvas-blanco-24500-ml-lata-opillia.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Квас Чорний живого бродіння ж/б 24×500 мл ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/cerveza-test.html',
      })}
      ${cardHtml({
        brand: 'Staropolski',
        title: 'Kwas chlebowy Staropolski 500 ml',
        href: 'https://extramagazin.es/pl/products/kvas-staropolski-500-ml.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      {
        brewery: 'Lidskae Piva (Лідскае Піва)',
        name: 'Lidski bread kvass (Квас Лидский Хлебный) (Kvas Lydskyi Khlebnyi)',
        abv: undefined,
      },
      {
        brewery: 'Lidskae Piva (Лідскае Піва)',
        name: 'Lidski Dark kvass (Квас Лидский Темный) (Kvas Lydskyi Temnyi)',
        abv: undefined,
      },
      {
        brewery: 'Carlsberg Ukraine',
        name: 'Kvass Taras Chornyi (Квас Тарас Чорний) (Kvas Taras Chornyi)',
        abv: undefined,
      },
      { brewery: 'Опілля (Opillia)', name: 'Квас Білий (Kvas Bilyi)', abv: undefined },
      { brewery: 'Опілля (Opillia)', name: 'Квас Чорний (Kvas Chornyi)', abv: undefined },
      { brewery: 'Staropolski', name: 'Staropolski', abv: undefined },
    ]);
  });

  it('requires kvas after bebida fermentada and silently skips kombucha/kefir and unknown mixed-page items', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'Kombucha Brand',
        title: 'Bebida fermentada Kombucha jengibre 330 ml',
        href: 'https://extramagazin.es/products/bebida-fermentada-kombucha-jengibre-330-ml.html',
      })}
      ${cardHtml({
        brand: 'Молокія',
        title: 'Bebida fermentada kéfir 500 ml',
        href: 'https://extramagazin.es/products/bebida-fermentada-kefir-500-ml.html',
      })}
      ${cardHtml({
        brand: 'Veres',
        title: 'Соус сацебелі 480 г',
        href: 'https://extramagazin.es/uk/products/salsa-satsebeli-480-g.html',
      })}
    `);

    expect(cards).toEqual([]);
  });

  it('treats mead and radler as eligible beverages rather than nonBeer', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'Apimiel',
        title: 'Медовуха 6% 500 мл',
        href: 'https://extramagazin.es/uk/products/hidromiel-6-500-ml.html',
      })}
      ${cardHtml({
        brand: 'Obolon',
        title: 'Radler лимон 2% 500 мл',
        href: 'https://extramagazin.es/uk/products/radler-limon-2-500-ml.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv, nonBeer }) => ({ brewery, name, abv, nonBeer }))).toEqual([
      { brewery: 'Apimiel', name: 'Медовуха (Medovukha)', abv: 6, nonBeer: undefined },
      { brewery: 'Obolon', name: 'Radler лимон (lymon)', abv: 2, nonBeer: undefined },
    ]);
  });

  it('emits skip: true with skipReason unparsed when a beverage card parses to an empty name', () => {
    const cards = parse(
      cardHtml({
        brand: 'OPILLIA',
        title: 'Пиво 500 мл',
        href: 'https://extramagazin.es/uk/products/cerveza-sin-nombre-500-ml.html',
      }),
    );

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      brewery: 'Опілля (Opillia)',
      name: 'Пиво 500 мл',
      skip: true,
      skipReason: 'unparsed',
    });
  });

  it('handles pack numbers before ABV, dots inside beer names, and end-of-name brand tokens', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'TEST',
        title: 'Пиво Pack 6 5% 330 мл',
        href: 'https://extramagazin.es/uk/products/cerveza-pack-6-test.html',
      })}
      ${cardHtml({
        brand: 'St. Bernardus',
        title: 'Cerveza St. Bernardus Abt 12 10.0% 330 ml',
        href: 'https://extramagazin.es/products/cerveza-st-bernardus-abt-12.html',
      })}
      ${cardHtml({
        brand: 'Damm',
        title: 'Cerveza Estrella Damm 5.4% 330 ml',
        href: 'https://extramagazin.es/products/cerveza-estrella-damm.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'TEST', name: 'Pack 6', abv: 5 },
      { brewery: 'St. Bernardus', name: 'St. Bernardus Abt 12', abv: 10 },
      { brewery: 'Damm', name: 'Estrella Damm', abv: 5.4 },
    ]);
  });

  it('classifies positive non-beer cards in a mixed grid with nonBeer: true and no skip flag', () => {
    const mixed = `
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Пиво світле 1851 EXPORT 4.7% 12x500 мл ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/cerveza-clara-1851-export-47-12x500-ml-opillia.html',
      })}
      ${nonBeerHtml}
    `;
    const cards = parse(mixed);

    expect(
      cards.map(({ brewery, name, abv, nonBeer, skip }) => ({ brewery, name, abv, nonBeer, skip })),
    ).toEqual([
      { brewery: 'Опілля (Opillia)', name: '1851 EXPORT', abv: 4.7, nonBeer: undefined, skip: undefined },
      { brewery: '', name: '', abv: undefined, nonBeer: true, skip: undefined },
      { brewery: '', name: '', abv: undefined, nonBeer: true, skip: undefined },
      { brewery: '', name: '', abv: undefined, nonBeer: true, skip: undefined },
    ]);
  });

  it('produces distinct normalizeKey cache keys across all Opillia Cyrillic products and the 24-card fixture', () => {
    const fixtureCards = parse(beerHtml);
    const uniqueFixtureKeys = new Set(fixtureCards.map((c) => normalizeKey(c.brewery, c.name)));
    // 24 cards in fixture contain 2 package formats for flagship Żywiec 5.6% (23 distinct beers).
    expect(uniqueFixtureKeys.size).toBe(23);

    const opilliaCards = parse(`
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Пиво «Корифей» 4,2% 1 л ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/cerveza-clara-korifey-export-42-1-l-opillia.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Пиво світле «Білий Келих» 4,2% 1 л ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/cerveza-clara-bily-kalykh-42-1-l-opillia.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Пиво світле «Хмелевар» 4,2% 1 л ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/cerveza-rubia-khmelevar-42-1-l-opillia.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Квас Білий живого бродіння ж/б 24×500 мл ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/bebida-fermentada-kvas-blanco-24500-ml-lata-opillia.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Квас Чорний живого бродіння ж/б 24×500 мл ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/refresco-fermentado-de-pan-kvas-negro-24500-ml-lata-opillia.html',
      })}
      ${cardHtml({
        brand: 'OPILLIA',
        title: 'Квас Домашній живого бродіння 1 л ОПІЛЛЯ',
        href: 'https://extramagazin.es/uk/products/bebida-fermentada-kvas-domashniy-1-l-opillia.html',
      })}
    `);

    const opilliaKeys = opilliaCards.map((c) => normalizeKey(c.brewery, c.name));
    expect(opilliaKeys).toEqual([
      'опілля opillia|корифей koryfei',
      'опілля opillia|білий келих bilyi kelykh',
      'опілля opillia|хмелевар khmelevar',
      'опілля opillia|квас білий kvas bilyi',
      'опілля opillia|квас чорний kvas chornyi',
      'опілля opillia|квас домашній kvas domashnii',
    ]);
    expect(new Set(opilliaKeys).size).toBe(6);

    const genericCyrillicCards = parse(`
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво світле «Корифей» 4,2% 500 мл ОПІЛЛЯ' })}
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво світле «Білий Келих» 4,2% 500 мл ОПІЛЛЯ' })}
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво безалкогольне «Світле» 0,0% 500 мл ОПІЛЛЯ' })}
    `);
    const genericKeys = genericCyrillicCards.map((c) => normalizeKey(c.brewery, c.name));
    expect(genericKeys).toEqual([
      'опілля opillia|корифей koryfei',
      'опілля opillia|білий келих bilyi kelykh',
      'опілля opillia|світле svitle 0 0',
    ]);
  });

  it('keeps mixed Cyrillic/Latin names that differ only in Cyrillic under different cache keys', () => {
    const cards = parse(`
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво Білий IPA 5% 500 мл' })}
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво Чорний IPA 5% 500 мл' })}
    `);

    expect(cards.map(({ name }) => name)).toEqual(['Білий IPA (Bilyi)', 'Чорний IPA (Chornyi)']);
    expect(cards.map(({ brewery, name }) => normalizeKey(brewery, name))).toEqual([
      'опілля opillia|білий ipa bilyi',
      'опілля opillia|чорний ipa chornyi',
    ]);
  });

  it('keeps mixed names with their own parenthetical apart when they differ only in Cyrillic', () => {
    const cards = parse(`
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво Білий IPA (dry hop) 5% 500 мл' })}
      ${cardHtml({ brand: 'OPILLIA', title: 'Пиво Чорний IPA (dry hop) 5% 500 мл' })}
    `);

    expect(cards.map(({ brewery, name }) => normalizeKey(brewery, name))).toEqual([
      'опілля opillia|білий ipa dry hop bilyi',
      'опілля opillia|чорний ipa dry hop chornyi',
    ]);
  });

  it('keeps alcohol-free beers distinct from regular releases in clean names and cache keys', () => {
    const cards = parse(`
      ${cardHtml({
        brand: 'TEST',
        title: 'Cerveza Premium sin alcohol 0.0% 500 ml',
        href: 'https://extramagazin.es/products/cerveza-premium-sin-alcohol-00.html',
      })}
      ${cardHtml({
        brand: 'TEST',
        title: 'Cerveza Premium 5.0% 500 ml',
        href: 'https://extramagazin.es/products/cerveza-premium-50.html',
      })}
      ${cardHtml({
        brand: 'TEST',
        title: 'Cerveza Clásica sin alcohol 500 ml',
        href: 'https://extramagazin.es/products/cerveza-clasica-sin-alcohol.html',
      })}
    `);

    expect(cards.map(({ brewery, name, abv }) => ({ brewery, name, abv }))).toEqual([
      { brewery: 'TEST', name: 'Premium 0.0%', abv: 0 },
      { brewery: 'TEST', name: 'Premium', abv: 5 },
      { brewery: 'TEST', name: 'Clásica 0.0%', abv: undefined },
    ]);
    expect(new Set(cards.map((c) => normalizeKey(c.brewery, c.name))).size).toBe(3);
  });
});
