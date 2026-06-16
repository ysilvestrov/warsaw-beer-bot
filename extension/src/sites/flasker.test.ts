import { describe, it, expect } from 'vitest';
import { parseTitle, isNonBeerTitle, isNonBeerCategory } from './flasker';

describe('parseTitle', () => {
  it('single-token brewery + style name', () => {
    expect(parseTitle('Burgomistr NEIPA 6% 500ml')).toEqual({ brewery: 'Burgomistr', name: 'NEIPA', abv: 6 });
  });

  it('comma decimal abv, Cyrillic name', () => {
    expect(parseTitle('REBREW Труханів Острів SIPA 4,3% 330ml'))
      .toEqual({ brewery: 'REBREW', name: 'Труханів Острів SIPA', abv: 4.3 });
  });

  it('brewery = first token; dash + style stay in the name', () => {
    expect(parseTitle('Ципа 380 – Triple IPA 7.9% 500ml'))
      .toEqual({ brewery: 'Ципа', name: '380 – Triple IPA', abv: 7.9 });
  });

  it('parenthetical second token joins the brewery', () => {
    expect(parseTitle('ШО (IIIO) Totem IPA 6% 0.33l'))
      .toEqual({ brewery: 'ШО (IIIO)', name: 'Totem IPA', abv: 6 });
  });

  it('known two-word brewery + bare-decimal volume', () => {
    expect(parseTitle('Vibrant Pour Frost & Flame Imperial Porter 10% 0.33'))
      .toEqual({ brewery: 'Vibrant Pour', name: 'Frost & Flame Imperial Porter', abv: 10 });
  });

  it('no abv → volume marks the head end', () => {
    expect(parseTitle('Orval {2025} 330ml')).toEqual({ brewery: 'Orval', name: '{2025}' });
  });

  it('zero abv', () => {
    expect(parseTitle('Barely Beer 0% ABV 330ml')).toEqual({ brewery: 'Barely', name: 'Beer', abv: 0 });
  });

  it('returns null when there is no volume token — sauces', () => {
    expect(parseTitle('ВИТРЕБЕНЬКИ. Крафтові соуси')).toBeNull();
  });

  it('returns null when there is no volume token — salo', () => {
    expect(parseTitle('Золота Сота – Найдорожче сало в Україні')).toBeNull();
  });

  it('does not treat a weight decimal as a volume', () => {
    expect(parseTitle('Сало традиційне 0.5кг')).toBeNull();
  });

  it('detects Cyrillic volume units (мл / л)', () => {
    expect(parseTitle('Brovar Lager 4% 500мл')).toEqual({ brewery: 'Brovar', name: 'Lager', abv: 4 });
    expect(parseTitle('Brovar Lager 4% 0,5л')).toEqual({ brewery: 'Brovar', name: 'Lager', abv: 4 });
  });

  it('single-token head → brewery equals name', () => {
    expect(parseTitle('Orval 330ml')).toEqual({ brewery: 'Orval', name: 'Orval' });
  });
});

describe('isNonBeerTitle (secondary gate — sets/glassware that DO quote a volume)', () => {
  it('drops a tasting set bundled with a glass', () => {
    expect(isNonBeerTitle('Набір 4×0.33 + келих')).toBe(true);
    expect(isNonBeerTitle('Tasting set 4×0.33l')).toBe(true);
  });
  it('keeps a real beer whose name merely contains "set"', () => {
    expect(isNonBeerTitle('Sunset Hazy IPA 6% 330ml')).toBe(false);
  });
  it('keeps an ordinary beer', () => {
    expect(isNonBeerTitle('Burgomistr NEIPA 6% 500ml')).toBe(false);
  });
  it('drops merch the shared detector misses (local regex branch)', () => {
    expect(isNonBeerTitle('Flasker branded glass 0.33l')).toBe(true);   // \bglass\b, not in isNonBeerName
    expect(isNonBeerTitle('Сувенір set 330ml')).toBe(true);            // сувенір, not in isNonBeerName
  });
});

describe('isNonBeerCategory (table data-product_cat hint)', () => {
  it('drops snack/merch categories', () => {
    expect(isNonBeerCategory('812:Снеки, ')).toBe(true);
    expect(isNonBeerCategory('900:Аксесуари, ')).toBe(true);
  });
  it('keeps a beer-style category', () => {
    expect(isNonBeerCategory('812:Темне міцне, ')).toBe(false);
  });
});
