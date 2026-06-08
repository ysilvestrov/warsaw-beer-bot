import { describe, it, expect } from 'vitest';
import { pickAdapter } from './registry';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';

describe('pickAdapter', () => {
  it('selects beerrepublic for beerrepublic.eu', () => {
    expect(pickAdapter(new URL('https://beerrepublic.eu/collections/all'))).toBe(beerrepublic);
  });

  it('selects onemorebeer for onemorebeer.pl', () => {
    expect(pickAdapter(new URL('https://onemorebeer.pl/piwa'))).toBe(onemorebeer);
  });

  it('returns null for an unknown host', () => {
    expect(pickAdapter(new URL('https://example.com/'))).toBeNull();
  });
});
