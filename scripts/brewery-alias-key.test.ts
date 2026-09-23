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

  test('handles apostrophes and quotes', () => {
    expect(formatAliasPair("O'Hara's Brewery", 'Carlow Brewing'))
      .toBe("['o hara s', 'carlow'],");
  });

  test('handles empty inputs', () => {
    expect(formatAliasPair('', ''))
      .toBe("['', ''],");
  });

  test('handles identical brewery names', () => {
    expect(formatAliasPair('Pinta', 'Pinta'))
      .toBe("['pinta', 'pinta'],");
  });

  test('handles surrounding whitespace and punctuation', () => {
    expect(formatAliasPair('  Browar Pinta!  ', 'PINTA - Barrel... Brewing'))
      .toBe("['pinta', 'pinta barrel'],");
  });
});
