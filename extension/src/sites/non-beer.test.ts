import { describe, it, expect } from 'vitest';
import { isNonBeerName } from './non-beer';

describe('isNonBeerName', () => {
  it.each([
    'Drekker Brewery Pack',
    'Limited Edition Anniversary Vertical Set',
    'Beer Package December',
    'Tasting Box 12',
    'Advent Calendar 2024',
    'Surprise Box',
    'Zestaw Prezentowy 6 piw',
    'Подарунковий набір українського крафтового пива!',
    'Подарункове пакування замовлення!',
    'Сертифікат 1000',
    'Gift Certificate 500',
    'Mixed Pack IPA',
    'Beer Club Subscription',
    'Underwood Culture tasting big set + келих',
  ])('flags packaging/voucher product %j', (name) => {
    expect(isNonBeerName(name)).toBe(true);
  });

  it.each([
    'Beer in a Box',
    'Glass',
    'India Pale Ale',
    'Imperial Hard Cider',
    'Traditional Kvass',
    'Kwas Chlebowy Retro',
    'Квас / Kvass',
    'MAGIC ROAD YES CANNONS SLOW MARKET PUSZKA 0,5 L KAUCJA',
    'Pomelo Nealko',
  ])('keeps real beer %j', (name) => {
    expect(isNonBeerName(name)).toBe(false);
  });
});
