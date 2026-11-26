import { describe, it, expect } from 'vitest';
import { ADAPTERS, pickAdapter } from './registry';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';
import { bierloods22 } from './bierloods22';
import { winetime } from './winetime';
import { hoptimaal } from './hoptimaal';
import { flasker } from './flasker';
import { piwnemosty } from './piwnemosty';
import { funkyshop } from './funkyshop';
import { extramagazin } from './extramagazin';
import { bubblesbeers } from './bubblesbeers';

describe('pickAdapter', () => {
  it('selects beerrepublic for beerrepublic.eu', () => {
    expect(pickAdapter(new URL('https://beerrepublic.eu/collections/all'))).toBe(beerrepublic);
  });

  it('selects onemorebeer for onemorebeer.pl', () => {
    expect(pickAdapter(new URL('https://onemorebeer.pl/piwa'))).toBe(onemorebeer);
  });

  it('selects beerfreak for beerfreak.org', () => {
    expect(pickAdapter(new URL('https://beerfreak.org/beer/'))).toBe(beerfreak);
  });

  it('selects bierloods22 for bierloods22.nl', () => {
    expect(pickAdapter(new URL('https://www.bierloods22.nl/en/all-beers/'))).toBe(bierloods22);
  });

  it('selects winetime for winetime.com.ua', () => {
    expect(pickAdapter(new URL('https://winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(winetime);
    expect(pickAdapter(new URL('https://www.winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo'))).toBe(winetime);
  });

  it('selects hoptimaal for hoptimaal.com', () => {
    expect(pickAdapter(new URL('https://hoptimaal.com/en/collections/craft-beers'))).toBe(hoptimaal);
    expect(pickAdapter(new URL('https://www.hoptimaal.com/collections/speciaalbier-kopen'))).toBe(hoptimaal);
  });

  it('selects flasker for flasker.com.ua', () => {
    expect(pickAdapter(new URL('https://flasker.com.ua/shop/'))).toBe(flasker);
    expect(pickAdapter(new URL('https://www.flasker.com.ua/shop/'))).toBe(flasker);
  });

  it('selects piwnemosty for piwnemosty.pl', () => {
    expect(pickAdapter(new URL('https://piwnemosty.pl/pol_m_PIWO-KRAFTOWE-100.html'))).toBe(piwnemosty);
    expect(pickAdapter(new URL('https://www.piwnemosty.pl/pol_m_PIWO-KRAFTOWE-100.html'))).toBe(piwnemosty);
  });

  it('selects funkyshop for funkyshop.pl', () => {
    expect(pickAdapter(new URL('https://funkyshop.pl/pl/4-piwo-rzemieslnicze'))).toBe(funkyshop);
    expect(pickAdapter(new URL('https://www.funkyshop.pl/en/4-craft-beer'))).toBe(funkyshop);
  });

  it('selects extramagazin for extramagazin.es', () => {
    expect(pickAdapter(new URL('https://extramagazin.es/uk/cerveza'))).toBe(extramagazin);
    expect(pickAdapter(new URL('https://www.extramagazin.es/cerveza'))).toBe(extramagazin);
  });

  it('selects bubblesbeers for bubblesbeers.com', () => {
    expect(pickAdapter(new URL('https://bubblesbeers.com/shop/'))).toBe(bubblesbeers);
    expect(pickAdapter(new URL('https://www.bubblesbeers.com/shop/'))).toBe(bubblesbeers);
  });

  it('returns null for an unknown host', () => {
    expect(pickAdapter(new URL('https://example.com/'))).toBeNull();
  });
});

describe('adapter ids', () => {
  it('every adapter has a unique non-empty id', () => {
    const ids = ADAPTERS.map((a) => a.id);
    expect(ids).toEqual(['beerrepublic', 'onemorebeer', 'beerfreak', 'bierloods22', 'winetime', 'hoptimaal', 'flasker', 'piwnemosty', 'funkyshop', 'beershop', 'extramagazin', 'bubblesbeers']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});
