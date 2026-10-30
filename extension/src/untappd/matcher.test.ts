import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeCardKey, matchLocalCards } from './matcher';
import * as db from '../db/indexed-db';
import * as auth from './auth';
import * as search from './search';

describe('makeCardKey', () => {
  it('creates stable normalized key', () => {
    const key = makeCardKey({
      brewery: ' PINTA ',
      name: ' Hazy Morning ',
      abv: 4.4,
      bid: 12345,
    });
    expect(key).toBe('pinta::hazy morning::4.4::12345');
  });
});

describe('matchLocalCards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('matches beer from user_had in local browser DB and returns drunk status', async () => {
    vi.spyOn(auth, 'getAuthState').mockResolvedValue({
      isLoggedIn: true,
      user: { username: 'ton', name: 'Ton', avatar: '', totalCheckins: 10, totalBeers: 10, authMethod: 'web_session' },
      lastChecked: Date.now(),
    });

    vi.spyOn(db, 'getCardMatch').mockResolvedValue(null);
    vi.spyOn(db, 'getUserHadByBid').mockResolvedValue(null);
    vi.spyOn(db, 'findUserHadByName').mockResolvedValue({
      bid: 999,
      name: 'Hazy Morning',
      brewery: 'PINTA',
      rating: 4.25,
      normalizedKey: 'pinta|hazy morning',
    });
    vi.spyOn(db, 'saveCardMatch').mockResolvedValue();

    const results = await matchLocalCards([{ brewery: 'PINTA', name: 'Hazy Morning' }]);
    expect(results).toHaveLength(1);
    expect(results[0].is_drunk).toBe(true);
    expect(results[0].user_rating).toBe(4.25);
    expect(results[0].matched_beer?.untappd_id).toBe(999);
  });

  it('falls back to search when not in local DB, then saves to local DB', async () => {
    vi.spyOn(auth, 'getAuthState').mockResolvedValue({
      isLoggedIn: false,
      user: null,
      lastChecked: Date.now(),
    });

    vi.spyOn(db, 'getCardMatch').mockResolvedValue(null);
    vi.spyOn(db, 'getUserHadByBid').mockResolvedValue(null);
    vi.spyOn(db, 'findUserHadByName').mockResolvedValue(null);
    vi.spyOn(db, 'findCatalogBeer').mockResolvedValue(null);
    vi.spyOn(search, 'searchUntappdBeer').mockResolvedValue({
      bid: 777,
      beerName: 'Modern IPA',
      breweryName: 'Artezan',
      ratingGlobal: 3.88,
    });
    const saveSpy = vi.spyOn(db, 'saveCardMatch').mockResolvedValue();

    const results = await matchLocalCards([{ brewery: 'Artezan', name: 'Modern IPA' }]);
    expect(results).toHaveLength(1);
    expect(results[0].is_drunk).toBe(false);
    expect(results[0].matched_beer?.untappd_id).toBe(777);
    expect(results[0].matched_beer?.rating_global).toBe(3.88);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});
