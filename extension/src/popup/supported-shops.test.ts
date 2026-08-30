import { describe, expect, it, vi } from 'vitest';
import { ADAPTERS } from '../sites/registry';
import {
  openShopWindow,
  renderSupportedShops,
  supportedShopGroups,
} from './supported-shops';

describe('supportedShopGroups', () => {
  it('groups every supported adapter once by the country orders ship from', () => {
    const groups = supportedShopGroups(['en-GB']);

    expect(groups.map(({ country, shops }) => [country, shops.map(({ name }) => name)])).toEqual([
      ['Ukraine', ['BeerFreak', 'WineTime', 'Flasker']],
      ['Poland', ['OneMoreBeer', 'Piwne Mosty', 'Funkyshop']],
      ['The Netherlands', ['Beer Republic', 'Bierloods22', 'Hoptimaal']],
      ['Czechia', ['Beershop']],
    ]);
    expect(groups.flatMap(({ shops }) => shops.map(({ id }) => id)).sort())
      .toEqual(ADAPTERS.map(({ id }) => id).sort());
  });

  it('uses the Polish Beershop storefront when Polish is the preferred supported language', () => {
    const groups = supportedShopGroups(['de-DE', 'pl-PL', 'en-US']);
    const beershop = groups.flatMap(({ shops }) => shops).find(({ id }) => id === 'beershop');

    expect(beershop?.url).toBe('https://beershop.pl/');
  });

  it('uses the English Beershop storefront for Ukrainian and English users', () => {
    for (const languages of [['uk-UA'], ['en-GB'], ['de-DE']]) {
      const groups = supportedShopGroups(languages);
      const beershop = groups.flatMap(({ shops }) => shops).find(({ id }) => id === 'beershop');

      expect(beershop?.url).toBe('https://beershop.eu/');
    }
  });
});

describe('renderSupportedShops', () => {
  it('renders country headings and opens the selected shop from its link', () => {
    const container = document.createElement('div');
    const open = vi.fn();

    const count = renderSupportedShops(container, ['en-GB'], open);

    expect(Array.from(container.querySelectorAll('.shop-country')).map((el) => el.textContent)).toEqual([
      'Ukraine',
      'Poland',
      'The Netherlands',
      'Czechia',
    ]);
    expect(container.querySelectorAll<HTMLAnchorElement>('.shop-link')).toHaveLength(10);
    expect(count).toBe(10);
    const flasker = Array.from(container.querySelectorAll<HTMLAnchorElement>('.shop-link'))
      .find((link) => link.textContent?.includes('Flasker'))!;

    flasker.click();

    expect(open).toHaveBeenCalledWith('https://flasker.com.ua/');
  });
});

describe('openShopWindow', () => {
  it('opens the chosen shop in a separate focused browser window', async () => {
    const create = vi.fn(async () => ({} as chrome.windows.Window));

    await openShopWindow('https://beerfreak.org/', { create });

    expect(create).toHaveBeenCalledWith({ focused: true, url: 'https://beerfreak.org/' });
  });
});
