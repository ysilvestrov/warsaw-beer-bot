export interface SupportedShop {
  id: string;
  name: string;
  url: string;
}

type ShopCountry = 'Ukraine' | 'Poland' | 'The Netherlands' | 'Czechia';

export interface SupportedShopGroup {
  country: ShopCountry;
  shops: SupportedShop[];
}

type SupportedLanguage = 'uk' | 'pl' | 'en';

interface ShopDefinition {
  id: string;
  name: string;
  country: ShopCountry;
  url: string | ({ en: string } & Partial<Record<Exclude<SupportedLanguage, 'en'>, string>>);
}

const COUNTRY_ORDER: ShopCountry[] = ['Ukraine', 'Poland', 'The Netherlands', 'Czechia'];

const SHOPS: ShopDefinition[] = [
  { id: 'beerrepublic', name: 'Beer Republic', country: 'The Netherlands', url: 'https://beerrepublic.eu/' },
  { id: 'onemorebeer', name: 'OneMoreBeer', country: 'Poland', url: 'https://onemorebeer.pl/' },
  { id: 'beerfreak', name: 'BeerFreak', country: 'Ukraine', url: 'https://beerfreak.org/' },
  { id: 'bierloods22', name: 'Bierloods22', country: 'The Netherlands', url: 'https://bierloods22.nl/en/' },
  { id: 'winetime', name: 'WineTime', country: 'Ukraine', url: 'https://winetime.com.ua/' },
  { id: 'hoptimaal', name: 'Hoptimaal', country: 'The Netherlands', url: 'https://hoptimaal.com/en/' },
  { id: 'flasker', name: 'Flasker', country: 'Ukraine', url: 'https://flasker.com.ua/' },
  { id: 'piwnemosty', name: 'Piwne Mosty', country: 'Poland', url: 'https://piwnemosty.pl/' },
  { id: 'funkyshop', name: 'Funkyshop', country: 'Poland', url: 'https://funkyshop.pl/' },
  {
    id: 'beershop',
    name: 'Beershop',
    country: 'Czechia',
    url: { pl: 'https://beershop.pl/', en: 'https://beershop.eu/' },
  },
];

function preferredSupportedLanguage(languages: readonly string[]): SupportedLanguage {
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0];
    if (base === 'uk' || base === 'pl' || base === 'en') return base;
  }
  return 'en';
}

function shopUrl(definition: ShopDefinition, language: SupportedLanguage): string {
  if (typeof definition.url === 'string') return definition.url;
  return definition.url[language] ?? definition.url.en;
}

export function supportedShopGroups(languages: readonly string[]): SupportedShopGroup[] {
  const language = preferredSupportedLanguage(languages);
  return COUNTRY_ORDER.map((country) => ({
    country,
    shops: SHOPS
      .filter((shop) => shop.country === country)
      .map((shop) => ({ id: shop.id, name: shop.name, url: shopUrl(shop, language) })),
  }));
}

type ShopOpener = (url: string) => void | Promise<void>;

function externalIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'shop-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M14 5h5v5M19 5l-9 9M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />';
  return svg;
}

export function renderSupportedShops(
  container: HTMLElement,
  languages: readonly string[],
  open: ShopOpener = openShopWindow,
): number {
  container.replaceChildren();
  let count = 0;
  for (const group of supportedShopGroups(languages)) {
    const section = document.createElement('section');
    section.className = 'shop-group';

    const heading = document.createElement('h2');
    heading.className = 'shop-country';
    heading.textContent = group.country;
    section.append(heading);

    for (const shop of group.shops) {
      count += 1;
      const link = document.createElement('a');
      link.className = 'shop-link';
      link.href = shop.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('aria-label', `Open ${shop.name} in a new window`);
      link.append(document.createTextNode(shop.name), externalIcon());
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void open(shop.url);
      });
      section.append(link);
    }

    container.append(section);
  }
  return count;
}

interface WindowCreator {
  create(createData: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>;
}

export async function openShopWindow(
  url: string,
  windowsApi: WindowCreator = chrome.windows,
): Promise<void> {
  await windowsApi.create({ focused: true, url });
}
