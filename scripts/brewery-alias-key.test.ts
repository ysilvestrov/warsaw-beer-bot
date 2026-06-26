import { describe, test, expect } from 'vitest';
import { formatAliasPair } from './brewery-alias-key';

describe('formatAliasPair', () => {
  test('prints a paste-ready normalized pair literal', () => {
    expect(formatAliasPair('Brouwerij Van Honsebrouck Brewery', 'Kasteel Brouwerij Vanhonsebrouck'))
      .toBe("['van honsebrouck', 'kasteel vanhonsebrouck'],");
  });

  test('normalizes both sides', () => {
    expect(formatAliasPair('Nepomucen Brewery', 'Nepo Brewing'))
      .toBe("['nepomucen', 'nepo'],");
  });
});
