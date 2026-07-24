import { describe, test, expect } from 'vitest';
import { parseBid } from './pin-match';

describe('parseBid', () => {
  test('extracts the trailing id from an Untappd beer URL', () => {
    expect(parseBid('https://untappd.com/b/a-le-coq-cider-fizz-pear-taste/1093012')).toBe(1093012);
  });
  test('accepts a bare numeric id', () => {
    expect(parseBid('6614460')).toBe(6614460);
  });
  test('tolerates a trailing slash', () => {
    expect(parseBid('https://untappd.com/b/x/6614460/')).toBe(6614460);
  });
  test('returns null for garbage', () => {
    expect(parseBid('not-a-bid')).toBeNull();
  });
});
