import { describe, it, expect } from 'vitest';
import { usableAbv } from './abv';

describe('usableAbv', () => {
  it('keeps 0 — the #322 disambiguator', () => {
    expect(usableAbv(0)).toBe(0);
  });

  it('keeps ordinary and high-but-real values', () => {
    expect(usableAbv(4.8)).toBe(4.8);
    expect(usableAbv(67.5)).toBe(67.5);
  });

  it('drops undefined, non-finite and out-of-range values', () => {
    expect(usableAbv(undefined)).toBeUndefined();
    expect(usableAbv(NaN)).toBeUndefined();
    expect(usableAbv(Infinity)).toBeUndefined();
    expect(usableAbv(-1)).toBeUndefined();
    expect(usableAbv(9999)).toBeUndefined();
  });
});
