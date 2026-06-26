import { describe, it, expect } from 'vitest';
import { onemorebeer } from './onemorebeer';

describe('onemorebeer.isNonBeerPage', () => {
  it('does NOT flag the delikatesy category because it can contain eligible kvass', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/delikatesy')) ?? false).toBe(false);
  });
  it('does NOT flag the beer listing', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/piwa')) ?? false).toBe(false);
  });
  it('does NOT flag the accessories page (it contains the MAGIC ROAD beer)', () => {
    expect(onemorebeer.isNonBeerPage?.(new URL('https://onemorebeer.pl/szklanki-i-akcesoria')) ?? false).toBe(false);
  });
});
