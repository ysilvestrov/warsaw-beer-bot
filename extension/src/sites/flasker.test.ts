import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTitle, isNonBeerTitle, isNonBeerCategory, flasker } from './flasker';

const load = (name: string) =>
  new DOMParser().parseFromString(readFileSync(resolve(__dirname, `../../tests/fixtures/${name}`), 'utf8'), 'text/html');

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
  it('drops Ukrainian glassware and bottle-openers (block-view merch)', () => {
    expect(isNonBeerTitle('Склянка Český Lager (500мл)')).toBe(true);
    expect(isNonBeerTitle('Відкривачка Cap Gun + 2 х 0.33 б/а пива')).toBe(true);
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

describe('flasker adapter', () => {
  it('hostMatch matches the shop and its subdomains, not others', () => {
    expect(flasker.hostMatch(new URL('https://flasker.com.ua/1-2/'))).toBe(true);
    expect(flasker.hostMatch(new URL('https://www.flasker.com.ua/store/'))).toBe(true);
    expect(flasker.hostMatch(new URL('https://example.com/'))).toBe(false);
  });

  it('parses cards from the SSR archive view (li.product)', () => {
    const cards = flasker.parseCards(load('flasker.html'));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.brewery.length).toBeGreaterThan(0);
    }
  });

  it('parses cards from the Barn2 product table view (tr[data-title])', () => {
    expect(flasker.parseCards(load('flasker.table.html')).length).toBeGreaterThan(0);
  });

  it('parses cards from the client-rendered block view (li.wc-block-grid__product)', () => {
    expect(flasker.parseCards(load('flasker.block.html')).length).toBeGreaterThan(0);
  });

  it('drops every product on a non-beer page', () => {
    expect(flasker.parseCards(load('flasker.nonbeer.html'))).toEqual([]);
  });

  it('does not emit glassware/opener merch from the block view', () => {
    const brands = flasker.parseCards(load('flasker.block.html')).map((c) => c.brewery);
    expect(brands).not.toContain('Склянка');
    expect(brands).not.toContain('Відкривачка');
  });
});
