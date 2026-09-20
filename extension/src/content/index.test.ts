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
    source: 'exact',
    searched: true,
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

  it('enriches a cached catalogue orphan without matching it again', async () => {
    const card: Card = { el: cardEl(), brewery: 'PINTA', name: 'Still Missing' };
    const cached: MatchResult = {
      raw: { brewery: 'PINTA', name: 'Still Missing' },
      matched_beer: {
        id: 12, name: 'Still Missing', brewery: 'PINTA', rating_global: null, untappd_id: null,
      },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    };
    await setCached(normalizeKey('PINTA', 'Still Missing'), cached);
    const sendMatch = vi.fn(async () => [] as MatchResult[]);
    const enrich = vi.fn();

    await runOverlay(document, adapterFor([card]), sendMatch, enrich);

    expect(sendMatch).not.toHaveBeenCalled();
    expect(enrich).toHaveBeenCalledWith([expect.objectContaining({
      key: normalizeKey('PINTA', 'Still Missing'), brewery: 'PINTA', name: 'Still Missing',
    })]);
  });

  it('rechecks an unresolved cached beer so its registered orphan badge returns', async () => {
    const card: Card = { el: cardEl(), brewery: 'PINTA', name: 'Unknown' };
    const unresolved: MatchResult = {
      raw: { brewery: 'PINTA', name: 'Unknown' },
      matched_beer: null,
      is_drunk: false,
      drunk_uncertain: false,
      user_rating: null,
      source: null,
      searched: true,
    };
    await setCached(normalizeKey('PINTA', 'Unknown'), unresolved);
    const sendMatch = vi.fn(async (): Promise<MatchResult[]> => [{
      ...unresolved,
      matched_beer: {
        id: 7,
        name: 'Unknown',
        brewery: 'PINTA',
        rating_global: null,
        untappd_id: null,
      },
    }]);

    await runOverlay(document, adapterFor([card]), sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'PINTA', name: 'Unknown' }]);
    // #648: the ⚪ glyph is gone; a catalogue row with no Untappd page is the "not found"
    // class, whose click still opens a prefilled search.
    expect(
      card.el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon'),
    ).toBe('search');
  });

  it('rechecks an unresolved cached beer even when stale cache marks it drunk', async () => {
    const card: Card = { el: cardEl(), brewery: 'PINTA', name: 'Unknown' };
    const unresolved: MatchResult = {
      raw: { brewery: 'PINTA', name: 'Unknown' },
      matched_beer: null,
      is_drunk: true,
      drunk_uncertain: false,
      user_rating: 4,
      source: null,
      searched: true,
    };
    await setCached(normalizeKey('PINTA', 'Unknown'), unresolved);
    const sendMatch = vi.fn(async (): Promise<MatchResult[]> => [{
      ...unresolved,
      matched_beer: {
        id: 7,
        name: 'Unknown',
        brewery: 'PINTA',
        rating_global: null,
        untappd_id: null,
      },
    }]);

    await runOverlay(document, adapterFor([card]), sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'PINTA', name: 'Unknown' }]);
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

  // #633: the shop's own Untappd link is the strongest identity we have for a card, and the
  // server can only use it together with the brand it is verified against.
  it('sends the shop-published bid and brand for a card that has them', async () => {
    const card: Card = { el: cardEl(), brewery: 'FLASKER', name: 'Abrikoos' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].bid = 5081070;
        cards[0].brand = 'Mad Brew';
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([
      { brewery: 'FLASKER', name: 'Abrikoos', bid: 5081070, brand: 'Mad Brew' },
    ]);
  });

  it('never sends a brand without a bid', async () => {
    // Without a bid the brand proves nothing to the server, so it must not travel at all.
    const card: Card = { el: cardEl(), brewery: 'FLASKER', name: 'Abrikoos' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].brand = 'Mad Brew';
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FLASKER', name: 'Abrikoos' }]);
  });

  it('never sends a bid without the brand that verifies it', async () => {
    // The server refuses a bid it has no brewery evidence for, and a bid sent alone would
    // still reach the "name and bid agree" rule. Keep the pair whole on this side instead.
    const card: Card = { el: cardEl(), brewery: 'FLASKER', name: 'Abrikoos' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].bid = 5081070;
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FLASKER', name: 'Abrikoos' }]);
  });

  it('never sends a blank brand as evidence', async () => {
    // The server trims the brand and treats an empty one as no evidence at all, so sending
    // it would ship a field that cannot answer anything — the pair is kept whole instead.
    const card: Card = { el: cardEl(), brewery: 'FLASKER', name: 'Abrikoos' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].bid = 5081070;
        cards[0].brand = '   ';
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FLASKER', name: 'Abrikoos' }]);
  });

  it('never sends a bid outside the safe integer range', async () => {
    // An id above 2^53 is already rounded by the time it is a JS number, so sending it would
    // publish a DIFFERENT id than the shop did. Untappd ids are seven digits — depth, not a
    // live case (AI review, PR #654).
    const card: Card = { el: cardEl(), brewery: 'FLASKER', name: 'Abrikoos' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].bid = Number.MAX_SAFE_INTEGER + 2;
        cards[0].brand = 'Mad Brew';
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FLASKER', name: 'Abrikoos' }]);
  });

  it('never sends a malformed bid', async () => {
    // A shop value is sanitised where it first enters a payload — the same rule `abv`
    // follows. One bad id would otherwise 400 the whole page's batch and badge nothing.
    const card: Card = { el: cardEl(), brewery: 'FLASKER', name: 'Abrikoos' };
    const adapter = {
      ...adapterFor([card]),
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].bid = 0;
        cards[0].brand = 'Mad Brew';
      }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FLASKER', name: 'Abrikoos' }]);
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

  it('classifies before cache and renders confirmed non-beer without API or cache writes', async () => {
    const card: Card = { el: cardEl(), brewery: 'Термос', name: 'для пляшки' };
    await setCached(
      normalizeKey(card.brewery, card.name),
      drunkResult(card.brewery, card.name),
    );
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(chrome.storage.local.set).mockClear();
    const adapter: SiteAdapter = {
      ...adapterFor([card]),
      loadDetailsBeforeCache: true,
      loadCardDetails: vi.fn(async (cards: Card[]) => {
        cards[0].nonBeer = true;
        cards[0].skip = true;
      }),
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);
    const enrich = vi.fn();

    await runOverlay(document, adapter, sendMatch, enrich);

    expect(adapter.loadCardDetails).toHaveBeenCalledWith([card]);
    expect(
      card.el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon'),
    ).toBe('cross');
    expect(isSeen(card.el)).toBe(true);
    expect(sendMatch).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('renders an already-confirmed non-beer before identity or cache work', async () => {
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(chrome.storage.local.set).mockClear();
    const card: Card = {
      el: cardEl(),
      brewery: undefined as unknown as string,
      name: undefined as unknown as string,
      nonBeer: true,
      skip: true,
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);
    const enrich = vi.fn();

    await runOverlay(document, adapterFor([card]), sendMatch, enrich);

    expect(
      card.el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon'),
    ).toBe('cross');
    expect(isSeen(card.el)).toBe(true);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(sendMatch).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
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

  it('does not throw when sendMatch fails, and settles the card for this pass', async () => {
    const card: Card = { el: cardEl(), brewery: 'B', name: 'N' };
    const sendMatch = vi.fn(async () => { throw new Error('offline'); });
    await expect(runOverlay(document, adapterFor([card]), sendMatch)).resolves.toBeUndefined();
    // #648: the card is no longer left blank (see the failure test below). It is marked
    // seen because the failure badge is itself a DOM write, and an unseen card would make
    // the re-render observer re-run the pass that drew it, once per debounce interval.
    expect(isSeen(card.el)).toBe(true);
  });

  it('marks every parsed card element seen, drunk or not', async () => {
    const a = cardEl();
    const b = cardEl();
    const notDrunk: MatchResult = {
      raw: { brewery: 'X', name: 'Two' }, matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null, source: null, searched: true,
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
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
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
      is_drunk: false, drunk_uncertain: true, user_rating: null, source: 'fuzzy', searched: true,
    };
    const regularOrphan: MatchResult = {
      raw: { brewery: 'B', name: 'Regular Orphan' },
      matched_beer: { id: 3, name: 'Regular Orphan', brewery: 'B', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
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

// #648: до цієї зміни порожня картка означала п'ятнадцять різних речей — зокрема два
// протилежні: «зараз буде» і «більше нічого не буде». Ці тести доводять переходи, а не
// кінцеві кадри: стан має бути видно в кожну мить, а не лише після відповіді.
describe('#648 стан картки на всьому шляху', () => {
  const badgeOf = (el: HTMLElement): HTMLElement | null =>
    el.querySelector(`[${BADGE_MARKER}]`);
  const iconOf = (el: HTMLElement): string | null =>
    badgeOf(el)?.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null;

  // A promise the test holds open, so the assertions land *while* /match is in flight.
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

  const found = (brewery: string, name: string): MatchResult => ({
    raw: { brewery, name },
    matched_beer: { id: 9, name, brewery, rating_global: 3.9, untappd_id: 222 },
    is_drunk: false, drunk_uncertain: false, user_rating: null,
    source: 'exact', searched: true,
  });
  const orphanResult = (brewery: string, name: string): MatchResult => ({
    raw: { brewery, name },
    matched_beer: { id: 5, name, brewery, rating_global: null, untappd_id: null },
    is_drunk: false, drunk_uncertain: false, user_rating: null,
    source: 'exact', searched: true,
  });

  it('1. queues every card before it touches the network or the cache', async () => {
    const a = cardEl();
    const b = cardEl();
    const c = cardEl();
    const cards: Card[] = [
      { el: a, brewery: 'PINTA', name: 'One' },
      { el: b, brewery: 'PINTA', name: 'Two' },
      { el: c, brewery: 'Термос', name: 'для пляшки', nonBeer: true },
    ];
    const d = deferred<MatchResult[]>();
    const sendMatch = vi.fn(() => d.promise);

    const run = runOverlay(document, adapterFor(cards), sendMatch);

    // Synchronous on purpose: not one await has run yet, so nothing but the parse
    // could have produced these badges.
    expect(iconOf(a)).toBe('ring');
    expect(iconOf(b)).toBe('ring');
    expect(sendMatch).not.toHaveBeenCalled();

    d.resolve([found('PINTA', 'One'), found('PINTA', 'Two')]);
    await run;
  });

  it('2. shows "working" while /match is in flight, and the answer after', async () => {
    const a = cardEl();
    const d = deferred<MatchResult[]>();
    const sendMatch = vi.fn(() => d.promise);

    const run = runOverlay(document, adapterFor([{ el: a, brewery: 'PINTA', name: 'One' }]), sendMatch);
    await flush();

    expect(sendMatch).toHaveBeenCalledTimes(1);
    expect(iconOf(a)).toBe('arc');
    expect(badgeOf(a)?.getAttribute('aria-label')).toBe('Шукаємо це пиво');

    d.resolve([found('PINTA', 'One')]);
    await run;
    expect(iconOf(a)).toBe('star');
  });

  it('3. renders the final state carried by the response', async () => {
    const a = cardEl();
    const b = cardEl();
    const adapter = adapterFor([
      { el: a, brewery: 'PINTA', name: 'New One' },
      { el: b, brewery: 'PINTA', name: 'Hazy Morning' },
    ]);

    await runOverlay(document, adapter, async () => [
      found('PINTA', 'New One'),
      drunkResult('PINTA', 'Hazy Morning'),
    ]);

    expect(iconOf(a)).toBe('star');
    expect(badgeOf(a)?.getAttribute('aria-label')).toBe('Ти це не пив. Глобальна оцінка 3,9');
    expect(iconOf(b)).toBe('check');
    expect(badgeOf(b)?.getAttribute('aria-label')).toBe('Ти це пив. Твоя оцінка 4,2');
  });

  it('4. says so when /match fails instead of leaving the page blank', async () => {
    const a = cardEl();
    const b = cardEl();
    await setCached(normalizeKey('PINTA', 'Cached'), drunkResult('PINTA', 'Cached'));
    const adapter = adapterFor([
      { el: a, brewery: 'PINTA', name: 'One' },
      { el: b, brewery: 'PINTA', name: 'Cached' },
    ]);
    const sendMatch = vi.fn(async () => { throw new Error('offline'); });

    await expect(runOverlay(document, adapter, sendMatch)).resolves.toBeUndefined();

    expect(iconOf(a)).toBe('warn');
    expect(badgeOf(a)?.getAttribute('aria-label')).toBe('Не вдалося перевірити: не було звʼязку');
    expect(iconOf(b)).toBe('check'); // the cached card keeps its own answer
  });

  it('5. renders non-beer at parse time and never sends it to /match', async () => {
    const a = cardEl();
    const b = cardEl();
    const d = deferred<MatchResult[]>();
    const sendMatch = vi.fn(() => d.promise);
    // The non-beer card sits *behind* a beer card on purpose: the cache lookup for the
    // first card is an await, so anything that badges non-beer later than the parse pass
    // cannot have drawn this cross by the time the assertion below runs.
    const adapter = adapterFor([
      { el: b, brewery: 'PINTA', name: 'One' },
      { el: a, brewery: 'Термос', name: 'для пляшки', nonBeer: true },
    ]);

    const run = runOverlay(document, adapter, sendMatch);

    // Before any await: a badge drawn after the response would still be `cross` at the
    // end, so the moment is the assertion.
    expect(iconOf(a)).toBe('cross');
    expect(badgeOf(a)?.getAttribute('aria-label')).toBe('Не пиво');

    await flush();
    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'PINTA', name: 'One' }]);

    d.resolve([found('PINTA', 'One')]);
    await run;
    expect(iconOf(a)).toBe('cross');
  });

  it('6. draws a cached card from the cache and keeps it out of /match', async () => {
    const a = cardEl();
    await setCached(normalizeKey('PINTA', 'New One'), found('PINTA', 'New One'));
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapterFor([{ el: a, brewery: 'PINTA', name: 'New One' }]), sendMatch);

    expect(iconOf(a)).toBe('star');
    expect(sendMatch).not.toHaveBeenCalled();
  });

  it('7. settles an unmatched card as "not found" when no enrichment can follow', async () => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Orphan' }]);

    await runOverlay(document, adapter, async () => [orphanResult('B', 'Orphan')]);

    expect(iconOf(a)).toBe('search');
  });

  it('8. leaves the same card queued when enrichment will look at it', async () => {
    const a = cardEl();
    const adapter = adapterFor([{ el: a, brewery: 'B', name: 'Orphan' }]);
    const enrich = vi.fn();

    await runOverlay(document, adapter, async () => [orphanResult('B', 'Orphan')], enrich);

    expect(iconOf(a)).toBe('ring');
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(enrich.mock.calls[0][0][0]).toMatchObject({ brewery: 'B', name: 'Orphan' });
  });

  // PR #670 review: the render loop walks the RESULTS, so a response shorter than the
  // request left the leftover cards spinning — and unseen, which re-arms the overlay on
  // every DOM mutation the shop makes.
  it('9. does not leave a card spinning when /match answers short', async () => {
    const a = cardEl();
    const b = cardEl();
    const adapter = adapterFor([
      { el: a, brewery: 'B', name: 'One' },
      { el: b, brewery: 'B', name: 'Two' },
    ]);

    await runOverlay(document, adapter, async () => [found('B', 'One')]);

    expect(iconOf(a)).toBe('star');
    expect(iconOf(b)).toBe('warn');
    expect(badgeOf(b)!.getAttribute('aria-label'))
      .toBe('Не вдалося перевірити: сервер не відповів');
    expect(isSeen(b)).toBe(true);
  });
});

// #648 (спека §5.2): `skip` — три різні поняття під одним прапорцем, і всі три раніше
// закінчувались мовчазною карткою без бейджа. Кожне тепер має свій клас.
describe('#648 card.skip — три поняття по трьох класах', () => {
  const iconOf = (el: HTMLElement): string | null =>
    el.querySelector(`[${BADGE_MARKER}] [data-icon]`)?.getAttribute('data-icon') ?? null;
  const labelOf = (el: HTMLElement): string | null =>
    el.querySelector(`[${BADGE_MARKER}]`)?.getAttribute('aria-label') ?? null;

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it('1. a shop-confirmed non-beer still ends as ✕, whatever `skip` says', async () => {
    const el = cardEl();
    const cards: Card[] = [{ el, brewery: '', name: '', nonBeer: true, skip: true }];
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapterFor(cards), sendMatch);

    expect(iconOf(el)).toBe('cross');
    expect(labelOf(el)).toBe('Не пиво');
    expect(sendMatch).not.toHaveBeenCalled();
    expect(isSeen(el)).toBe(true);
  });

  it('2. a card waiting for its product page reads as "working", not "queued"', async () => {
    const el = cardEl();
    const cards: Card[] = [
      { el, brewery: 'VibrantPour', name: 'Mystery Gose', skip: true, skipReason: 'pending-detail' },
    ];
    const detail = deferred<void>();
    const adapter: SiteAdapter = {
      ...adapterFor(cards),
      loadDetailsBeforeCache: true,
      loadCardDetails: () => detail.promise,
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    const run = runOverlay(document, adapter, sendMatch);

    // Synchronous: the detail request is still in flight, nothing has been awaited yet.
    expect(iconOf(el)).toBe('arc');

    detail.resolve();
    await run;
  });

  it('3. a card whose product page never arrived fails with the network reason', async () => {
    const el = cardEl();
    const cards: Card[] = [
      { el, brewery: 'VibrantPour', name: 'Mystery Gose', skip: true, skipReason: 'pending-detail' },
    ];
    const adapter: SiteAdapter = {
      ...adapterFor(cards),
      loadDetailsBeforeCache: true,
      // The shop's detail page failed or carried no categories: `skip` is still true.
      loadCardDetails: vi.fn(async () => {}),
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapter, sendMatch);

    expect(iconOf(el)).toBe('warn');
    expect(labelOf(el)).toBe('Не вдалося перевірити: не було звʼязку');
    expect(sendMatch).not.toHaveBeenCalled();
    expect(isSeen(el)).toBe(true);
  });

  it('4. a card whose title never parsed fails with the "unparsed" reason', async () => {
    const el = cardEl();
    const cards: Card[] = [
      { el, brewery: '', name: 'Набір 6 пляшок', skip: true, skipReason: 'unparsed' },
    ];
    const adapter: SiteAdapter = {
      ...adapterFor(cards),
      loadDetailsBeforeCache: true,
      loadCardDetails: vi.fn(async () => {}),
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapter, sendMatch);

    expect(iconOf(el)).toBe('warn');
    expect(labelOf(el)).toBe('Не змогли розібрати цю картку');
    expect(sendMatch).not.toHaveBeenCalled();
    expect(isSeen(el)).toBe(true);
  });

  it('5. a card the detail page gave no brewery fails with the "unparsed" reason', async () => {
    const el = cardEl();
    const cards: Card[] = [{ el, brewery: '', name: 'Aloha' }];
    const adapter: SiteAdapter = {
      ...adapterFor(cards),
      // funkyshop hydrates *after* the cache lookup, so this card reaches the miss list
      // first and only then turns out to be unusable.
      loadCardDetails: vi.fn(async (hydrated: Card[]) => {
        hydrated[0].skip = true;
        hydrated[0].skipReason = 'unparsed';
      }),
    };
    const sendMatch = vi.fn(async () => [] as MatchResult[]);

    await runOverlay(document, adapter, sendMatch);

    expect(iconOf(el)).toBe('warn');
    expect(labelOf(el)).toBe('Не змогли розібрати цю картку');
    expect(sendMatch).not.toHaveBeenCalled();
    expect(isSeen(el)).toBe(true);
  });

  it('6. a card whose product page did arrive goes on to /match as a normal one', async () => {
    const el = cardEl();
    const cards: Card[] = [
      { el, brewery: 'VibrantPour', name: 'Mystery Gose', skip: true, skipReason: 'pending-detail' },
    ];
    const adapter: SiteAdapter = {
      ...adapterFor(cards),
      loadDetailsBeforeCache: true,
      loadCardDetails: vi.fn(async (hydrated: Card[]) => { hydrated[0].skip = false; }),
    };
    const sendMatch = vi.fn(async () => [drunkResult('VibrantPour', 'Mystery Gose')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'VibrantPour', name: 'Mystery Gose' }]);
    expect(iconOf(el)).toBe('check');
  });
});

// #384: a card whose shop-published bid disagrees with the link /match returned is the
// only way the server's repair path can ever be reached — a wrongly-linked card comes
// back *matched* and would otherwise never be offered for enrichment.
describe('runOverlay bid-contradiction orphans (#384)', () => {
  const linked = (brewery: string, name: string, untappd_id: number, over: Partial<MatchResult> = {}): MatchResult => ({
    raw: { brewery, name },
    matched_beer: { id: 7, name, brewery, rating_global: 3.5, untappd_id },
    is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
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
    ['drunk_uncertain', { drunk_uncertain: true, source: 'fuzzy' as const }],
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
      matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null, source: null, searched: true,
    };
    const enrich = vi.fn();
    await runOverlay(document, adapter, async () => [orphan], enrich);

    expect(enrich.mock.calls[0][0][0]).toMatchObject({ bid: 555, bidSlug: 'b-orphan' });
  });

  it('relays a placeholder brand separately from the title-derived brewery (#307)', async () => {
    const a = cardEl();
    const adapter = adapterFor([{
      el: a,
      brewery: 'Trappistes',
      name: 'Rochefort 8 (2025)',
      brand: 'Імпортне пиво',
      bid: 6134078,
      bidSlug: 'abbaye-notre-dame-de-saint-remy-trappistes-rochefort-8-2025',
    }]);
    const orphan: MatchResult = {
      raw: { brewery: 'Trappistes', name: 'Rochefort 8 (2025)' },
      matched_beer: null, is_drunk: false, drunk_uncertain: false, user_rating: null, source: null, searched: true,
    };
    const enrich = vi.fn();

    await runOverlay(document, adapter, async () => [orphan], enrich);

    expect(enrich.mock.calls[0][0][0]).toMatchObject({
      brewery: 'Trappistes',
      name: 'Rochefort 8 (2025)',
      brand: 'Імпортне пиво',
      bid: 6134078,
    });
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
    is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
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
    is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
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
