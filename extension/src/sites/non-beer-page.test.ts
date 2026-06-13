import { describe, it, expect } from 'vitest';
import { onemorebeer } from './onemorebeer';

describe('onemorebeer.isNonBeerPage', () => {
  it('flags the delikatesy (soft-drinks) category', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/delikatesy'))).toBe(true);
  });
  it('does NOT flag the beer listing', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/piwa'))).toBe(false);
  });
  it('does NOT flag the accessories page (it contains the MAGIC ROAD beer)', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/szklanki-i-akcesoria'))).toBe(false);
  });
});
