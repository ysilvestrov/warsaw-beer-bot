import { describe, it, expect } from 'vitest';
import { isNonBeerName, isNonAlcoholicSoftDrinkFamily } from './non-beer';

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
    'Variety Pack',
    'Twelve Pack',
    'Samuel Adams Winter Break Variety Twelve Pack',
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
    'Pack Mentality IPA',
    'Backpack Stout',
    'Variety Packaging IPA',
    'Twelve Packard Stout',
  ])('keeps real beer %j', (name) => {
    expect(isNonBeerName(name)).toBe(false);
  });
});

describe('isNonAlcoholicSoftDrinkFamily', () => {
  it('drops a 0% ginger beer — the soft drink that borrowed the word "beer"', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Jamaica Ginger Beer Regular', abv: 0 })).toBe(true);
  });

  it('drops a 0% root beer', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Classic Root Beer', abv: 0 })).toBe(true);
  });

  it('keeps an alcoholic ginger beer', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Alcoholic Ginger Beer', abv: 4 })).toBe(false);
  });

  it('keeps the product when the shop publishes no ABV — never hide a beer on a guess', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Ginger Beer' })).toBe(false);
  });

  it('matches on the shop style as well as the name', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Old Jamaica', style: 'Ginger Beer', abv: 0 })).toBe(true);
  });

  it('never touches alcohol-free beer: 0.0% is a real ABV (#322)', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Kwas Chlebowy Jasny', abv: 0 })).toBe(false);
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'BezalkØ Pan IPAni', style: 'Pale Ale', abv: 0 })).toBe(false);
  });

  // #376 follow-up: callers must pass the FULL brewery+name string, not the post-split
  // name alone — splitBreweryName can hand the leading brand token ("Ginger") to the
  // brewery, leaving "Beer" alone in the name, which used to escape the gate.
  it('drops when the family spans a brewery+name join (e.g. brewery "Ginger", name "Beer")', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Ginger Beer', abv: 0 })).toBe(true);
  });

  describe('a published style outranks the name guess (#376 follow-up)', () => {
    it('style absent: falls back to deciding from name/brewery+name, as before', () => {
      expect(isNonAlcoholicSoftDrinkFamily({ name: 'Classic Root Beer', abv: 0 })).toBe(true);
      expect(isNonAlcoholicSoftDrinkFamily({ name: 'Kwas Chlebowy Jasny', abv: 0 })).toBe(false);
    });

    it('style published and matches the family: drop (shop confirms the soft drink)', () => {
      expect(isNonAlcoholicSoftDrinkFamily({ name: 'Old Jamaica', style: 'Root beer', abv: 0 })).toBe(true);
    });

    it('style published and is anything else: KEEP even though the name says "ginger beer" — the shop contradicted the name guess', () => {
      expect(isNonAlcoholicSoftDrinkFamily({ name: 'Ginger Beer Stout', style: 'Stout', abv: 0 })).toBe(false);
    });
  });
});

describe('isNonBeerName — energy drinks', () => {
  it('drops energy drinks unconditionally', () => {
    expect(isNonBeerName('Doze energy drink zero')).toBe(true);
  });

  it('keeps a beer that merely mentions energy', () => {
    expect(isNonBeerName('Liquid Energy IPA')).toBe(false);
  });
});

describe('review follow-ups (#383)', () => {
  it('treats an empty style as absent and still drops a 0% root beer', () => {
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Classic Root Beer', style: '', abv: 0 })).toBe(true);
    expect(isNonAlcoholicSoftDrinkFamily({ name: 'Classic Root Beer', style: '   ', abv: 0 })).toBe(true);
  });

  it('keeps a beer whose name merely starts with the energy-drink phrase', () => {
    expect(isNonBeerName('Energy Drinkability IPA')).toBe(false);
  });

  it('keeps a beer where the phrase is glued to a preceding word', () => {
    expect(isNonBeerName('Bioenergy Drink IPA')).toBe(false);
  });

  it('keeps it glued across scripts too — JS \\b is ASCII-only', () => {
    expect(isNonBeerName('Біоenergy Drink IPA')).toBe(false);
    expect(isNonBeerName('Енергyenergy Drinks IPA')).toBe(false);
  });

  it('still drops the phrase after Cyrillic punctuation/space', () => {
    expect(isNonBeerName('Доза energy drink zero')).toBe(true);
  });

  it('still drops the plural form', () => {
    expect(isNonBeerName('Doze Energy Drinks 250ml')).toBe(true);
    expect(isNonBeerName('Doze energy drink zero')).toBe(true);
  });
});
