import { describe, it, expect } from 'vitest';
import { canRefresh } from './popup';

describe('canRefresh', () => {
  it('true on a supported shop URL', () => {
    expect(canRefresh('https://beerfreak.org/some/page')).toBe(true);
    expect(canRefresh('https://winetime.com.ua/x')).toBe(true);
  });
  it('false on an unsupported URL', () => {
    expect(canRefresh('https://example.com/')).toBe(false);
  });
  it('false on a malformed or empty URL', () => {
    expect(canRefresh('not a url')).toBe(false);
    expect(canRefresh('')).toBe(false);
  });
});
