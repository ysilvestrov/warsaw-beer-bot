import { describe, it, expect } from 'vitest';
import { pickAdapter } from './registry';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';
import { bierloods22 } from './bierloods22';
import { winetime } from './winetime';
import { hoptimaal } from './hoptimaal';

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

  it('returns null for an unknown host', () => {
    expect(pickAdapter(new URL('https://example.com/'))).toBeNull();
  });
});

describe('adapter ids', () => {
  it('every adapter has a unique non-empty id', () => {
    const ids = [beerrepublic, onemorebeer, beerfreak, bierloods22, winetime, hoptimaal].map((a) => a.id);
    expect(ids).toEqual(['beerrepublic', 'onemorebeer', 'beerfreak', 'bierloods22', 'winetime', 'hoptimaal']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});
