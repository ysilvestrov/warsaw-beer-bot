import { describe, it, expect } from 'vitest';
import { pickAdapter } from './registry';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';

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

  it('returns null for an unknown host', () => {
    expect(pickAdapter(new URL('https://example.com/'))).toBeNull();
  });
});

describe('adapter ids', () => {
  it('every adapter has a unique non-empty id', () => {
    const ids = [beerrepublic, onemorebeer, beerfreak].map((a) => a.id);
    expect(ids).toEqual(['beerrepublic', 'onemorebeer', 'beerfreak']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});
