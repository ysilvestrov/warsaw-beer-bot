import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runOverlay } from './index';
import { BADGE_MARKER, isSeen } from './badge';
import { setCached } from '../cache/store';
import { normalizeKey } from '../shared/normalize';
import type { SiteAdapter, Card } from '../sites/types';
import type { MatchResult, RawBeer } from '../api/types';

function drunkResult(brewery: string, name: string): MatchResult {
  return {
    raw: { brewery, name },
    matched_beer: { id: 1, name, brewery, rating_global: 4.0, untappd_id: 111 },
    is_drunk: true,
    drunk_uncertain: false,
    user_rating: 4.2,
  };
}

function cardEl(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

beforeEach(() => { document.body.innerHTML = ''; });

function adapterFor(cards: Card[]): SiteAdapter {
  return { id: 'test', hostMatch: () => true, parseCards: () => cards };
}

describe('runOverlay', () => {
  it('matches uncached cards via sendMatch and badges drunk ones', async () => {
    const cards: Card[] = [{ el: cardEl(), brewery: 'PINTA', name: 'Hazy Morning' }];
    const sendMatch = vi.fn(async (_b: RawBeer[]) => [drunkResult('PINTA', 'Hazy Morning')]);

    await runOverlay(document, adapterFor(cards), sendMatch);

    expect(sendMatch).toHaveBeenCalledTimes(1);
    expect(cards[0].el.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  });

  it('uses the cache and does not call sendMatch for cached cards', async () => {
    const card: Card = { el: cardEl(), brewery: 'PINTA', name: 'Hazy Morning' };
    await setCached(normalizeKey('PINTA', 'Hazy Morning'), drunkResult('PINTA', 'Hazy Morning'));
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapterFor([card]), sendMatch);

    expect(sendMatch).not.toHaveBeenCalled();
    expect(card.el.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
  });

  it('loads details for uncached cards before sending them to match', async () => {
    const cached: Card = { el: cardEl(), brewery: 'Cached', name: 'Beer' };
    const uncached: Card = { el: cardEl(), brewery: 'FUNKY FLUID', name: 'Ambrosia 9.0' };
    await setCached(normalizeKey('Cached', 'Beer'), drunkResult('Cached', 'Beer'));
    const adapter = {
      ...adapterFor([cached, uncached]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].abv = 7.3;
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FUNKY FLUID', 'Ambrosia 9.0')]);

    await runOverlay(document, adapter, sendMatch);

    expect(adapter.loadCardDetails).toHaveBeenCalledTimes(1);
    expect(adapter.loadCardDetails).toHaveBeenCalledWith([uncached]);
    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FUNKY FLUID', name: 'Ambrosia 9.0', abv: 7.3 }]);
  });

  // #384: /match sees the hydrated identity, but the cache is keyed on the identity the
  // lookup used (pre-hydration) — see "cache key stability" below for why they must agree.
  it('uses the hydrated brewery identity for matching and the looked-up key for the cache', async () => {
    vi.mocked(chrome.storage.local.set).mockClear();
    const card: Card = { el: cardEl(), brewery: '', name: 'Aloha' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].brewery = 'Funky Fluid';
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('Funky Fluid', 'Aloha')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'Funky Fluid', name: 'Aloha' }]);
    const storageSet = vi.mocked(chrome.storage.local.set).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.keys(storageSet)).toEqual([`mc2:${normalizeKey('', 'Aloha')}`]);
  });

  it('does not match cards skipped during detail loading', async () => {
    const card: Card = { el: cardEl(), brewery: '', name: 'Aloha' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].skip = true;
      }),
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).not.toHaveBeenCalled();
  });

  it('awaits waitForGrid before parsing when the adapter defines it', async () => {
    const order: string[] = [];
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const adapter: SiteAdapter = {
      id: 'test',
      hostMatch: () => true,
      waitForGrid: async () => { order.push('wait'); },
      parseCards: () => { order.push('parse'); return [card]; },
    };
    await runOverlay(document, adapter, async () => [drunkResult('B', 'N')]);
    expect(order).toEqual(['wait', 'parse']);
  });

  it('does not throw when sendMatch fails (graceful skip)', async () => {
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const sendMatch = vi.fn(async () => { throw new Error('offline'); });
    await expect(runOverlay(document, adapterFor([card]), sendMatch)).resolves.toBeUndefined();
    expect(card.el.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('marks every parsed card element seen, drunk or not', async () => {
    const a = cardEl();
    const b = cardEl();
    const notDrunk: MatchResult = {
      raw: { brewery: 'X', name: 'Two' }, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null,
    };
    const adapter = adapterFor([
      { el: a, brewery: 'X', name: 'One' },
      { el: b, brewery: 'X', name: 'Two' },
    ]);
    const sendMatch = async () => [drunkResult('X', 'One'), notDrunk];

    await runOverlay(document, adapter, sendMatch);

    expect(isSeen(a)).toBe(true);
    expect(isSeen(b)).toBe(true);
  });

  it('passes not-drunk no-untappd_id beers to the enrich callback', async () => {
    const a = cardEl();
    const orphan: MatchResult = {
      raw: { brewery: 'B', name: 'Orphan One' },
      matched_beer: { id: 1, name: 'Orphan One', brewery: 'B', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null,
    };
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Orphan One' }]);
    const sendMatch = async () => [orphan];
    const enrich = vi.fn();
    await runOverlay(document, adapter, sendMatch, enrich);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0][0][0]).toMatchObject({ brewery: 'B', name: 'Orphan One' });
  });

  it('does not pass drunk_uncertain orphans to the enrich callback', async () => {
    const a = cardEl();
    const b = cardEl();
    const uncertainOrphan: MatchResult = {
      raw: { brewery: 'B', name: 'Uncertain One' },
      matched_beer: { id: 2, name: 'Uncertain One', brewery: 'B', rating_global: 3.8, untappd_id: null },
      is_drunk: false, drunk_uncertain: true, user_rating: null,
    };
    const regularOrphan: MatchResult = {
      raw: { brewery: 'B', name: 'Regular Orphan' },
      matched_beer: { id: 3, name: 'Regular Orphan', brewery: 'B', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null,
    };
    const adapter = adapterFor([
      { el: a, brewery: 'B', name: 'Uncertain One' },
      { el: b, brewery: 'B', name: 'Regular Orphan' },
    ]);
    const sendMatch = async () => [uncertainOrphan, regularOrphan];
    const enrich = vi.fn();
    await runOverlay(document, adapter, sendMatch, enrich);
    expect(enrich).toHaveBeenCalledTimes(1);
    const enriched = enrich.mock.calls[0][0] as Array<{ name: string }>;
    expect(enriched).toHaveLength(1);
    expect(enriched[0]).toMatchObject({ name: 'Regular Orphan' });
  });
});

// #384: a card whose shop-published bid disagrees with the link /match returned is the
// only way the server's repair path can ever be reached — a wrongly-linked card comes
// back *matched* and would otherwise never be offered for enrichment.
describe('runOverlay bid-contradiction orphans (#384)', () => {
  const linked = (brewery: string, name: string, untappd_id: number, over: Partial<MatchResult> = {}): MatchResult => ({
    raw: { brewery, name },
    matched_beer: { id: 7, name, brewery, rating_global: 3.5, untappd_id },
    is_drunk: false, drunk_uncertain: false, user_rating: null,
    ...over,
  });

  it('enriches a matched card whose published bid contradicts the stored link', async () => {
    const a = cardEl();
    const adapter = adapterFor([
      { el: a, brewery: 'Mad Brew', name: 'Tomatol Bulgogi', bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi' },
    ]);
    const enrich = vi.fn();
    await runOverlay(document, adapter, async () => [linked('Mad Brew', 'Tomatol Bulgogi', 6708599)], enrich);

    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0][0][0]).toMatchObject({
      brewery: 'Mad Brew', name: 'Tomatol Bulgogi',
      bid: 6648348, bidSlug: 'mad-brew-tomatol-bulgogi',
    });
  });

  it('leaves a matched card alone when the published bid agrees with the stored link', async () => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'Mad Brew', name: 'Agreeing', bid: 6708599 }]);
    const enrich = vi.fn();
    await runOverlay(document, adapter, async () => [linked('Mad Brew', 'Agreeing', 6708599)], enrich);

    expect(enrich).not.toHaveBeenCalled();
  });

  it('leaves a matched card alone when the shop publishes no bid at all', async () => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'Mad Brew', name: 'No Bid' }]);
    const enrich = vi.fn();
    await runOverlay(document, adapter, async () => [linked('Mad Brew', 'No Bid', 6708599)], enrich);

    expect(enrich).not.toHaveBeenCalled();
  });

  // Deliberate: a check-in means the user engaged with this beer, and re-linking
  // underneath them is a bigger surprise than one wrong badge.
  it.each([
    ['is_drunk', { is_drunk: true }],
    ['drunk_uncertain', { drunk_uncertain: true }],
  ])('never re-links a %s card, contradicting bid or not', async (_label, over) => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'Mad Brew', name: 'Drunk', bid: 6648348 }]);
    const enrich = vi.fn();
    await runOverlay(document, adapter, async () => [linked('Mad Brew', 'Drunk', 6708599, over)], enrich);

    expect(enrich).not.toHaveBeenCalled();
  });

  it('still relays the bid for a plain (unmatched) orphan', async () => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Orphan', bid: 555, bidSlug: 'b-orphan' }]);
    const orphan: MatchResult = {
      raw: { brewery: 'B', name: 'Orphan' },
      matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null,
    };
    const enrich = vi.fn();
    await runOverlay(document, adapter, async () => [orphan], enrich);

    expect(enrich.mock.calls[0][0][0]).toMatchObject({ bid: 555, bidSlug: 'b-orphan' });
  });
});

// #384: the cache lookup key is computed before loadCardDetails; the write key used to be
// recomputed after it. For every hydrated card the two diverged, so the card was a
// permanent cache miss — /match plus a detail fetch on every page load, and the
// MAX_SEARCHES_PER_PAGE window frozen on the same first cards forever.
describe('runOverlay cache key stability (#384)', () => {
  it('stores under the key it looked up, so a second overlay pass is a cache hit', async () => {
    const freshCard = (): Card => ({ el: cardEl(), brewery: '', name: 'Aloha' });
    let card = freshCard();
    const adapter: SiteAdapter = {
      id: 'test',
      hostMatch: () => true,
      parseCards: () => [card],
      loadCardDetails: async (cards: Card[]) => { cards[0].brewery = 'Pravda'; },
    };
    const sendMatch = vi.fn(async () => [drunkResult('Pravda', 'Aloha')]);

    await runOverlay(document, adapter, sendMatch);
    card = freshCard(); // a real re-parse of the same DOM yields the pre-hydration identity
    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledTimes(1);
  });
});

// #369: relayed shop facts must survive the hop from Card to the enrich payload.
describe('runOverlay orphan facts (#369)', () => {
  const orphanResult = (brewery: string, name: string): MatchResult => ({
    raw: { brewery, name },
    matched_beer: { id: 1, name, brewery, rating_global: null, untappd_id: null },
    is_drunk: false, drunk_uncertain: false, user_rating: null,
  });

  it('relays abv and style, keeping 0 as a value rather than dropping it', async () => {
    const a = cardEl();
    const b = cardEl();
    const adapter = adapterFor([
      { el: a, brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny', abv: 0, style: 'Kwas Chlebowy' },
      { el: b, brewery: 'PINTA', name: 'Mystery' },
    ]);
    const sendMatch = async () => [
      orphanResult('AleBrowar', 'Kwas Chlebowy Jasny'),
      orphanResult('PINTA', 'Mystery'),
    ];
    const enrich = vi.fn();
    await runOverlay(document, adapter, sendMatch, enrich);

    const orphans = enrich.mock.calls[0][0] as Array<{ abv?: number; style?: string }>;
    expect(orphans[0].abv).toBe(0); // present, not dropped as falsy
    expect(orphans[0].style).toBe('Kwas Chlebowy');
    expect(orphans[1].abv).toBeUndefined();
    expect(orphans[1].style).toBeUndefined();
  });

  it('still sends abv to /match and never sends style there', async () => {
    const a = cardEl();
    const adapter = adapterFor([
      { el: a, brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny', abv: 0, style: 'Kwas Chlebowy' },
    ]);
    const sendMatch = vi.fn(async (_b: RawBeer[]) => [orphanResult('AleBrowar', 'Kwas Chlebowy Jasny')]);
    await runOverlay(document, adapter, sendMatch, vi.fn());

    expect(sendMatch.mock.calls[0][0][0]).toEqual({
      brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny', abv: 0,
    });
  });
});

// #369 review follow-up: an impossible shop ABV must not reach /match (which has no
// server-side sanitizer) nor the enrich payload (where NaN would serialize as null).
describe('runOverlay sanitizes shop ABV (#369)', () => {
  const orphanResult = (brewery: string, name: string): MatchResult => ({
    raw: { brewery, name },
    matched_beer: { id: 1, name, brewery, rating_global: null, untappd_id: null },
    is_drunk: false, drunk_uncertain: false, user_rating: null,
  });

  it.each([
    ['out of range', 9999],
    ['negative', -1],
    ['NaN', NaN],
    ['Infinity', Infinity],
  ])('drops an %s abv from both the /match and enrich payloads', async (_label, bad) => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Bad Abv', abv: bad }]);
    const sendMatch = vi.fn(async (_b: RawBeer[]) => [orphanResult('B', 'Bad Abv')]);
    const enrich = vi.fn();
    await runOverlay(document, adapter, sendMatch, enrich);

    expect(sendMatch.mock.calls[0][0][0]).toEqual({ brewery: 'B', name: 'Bad Abv' });
    expect((enrich.mock.calls[0][0][0] as { abv?: number }).abv).toBeUndefined();
  });

  it('still passes a legitimate 0 through both payloads', async () => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Zero', abv: 0 }]);
    const sendMatch = vi.fn(async (_b: RawBeer[]) => [orphanResult('B', 'Zero')]);
    const enrich = vi.fn();
    await runOverlay(document, adapter, sendMatch, enrich);

    expect(sendMatch.mock.calls[0][0][0]).toEqual({ brewery: 'B', name: 'Zero', abv: 0 });
    expect((enrich.mock.calls[0][0][0] as { abv?: number }).abv).toBe(0);
  });
});
