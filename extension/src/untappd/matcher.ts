import type { MatchResult, RawBeer } from '../api/types';
import { getCardMatch, saveCardMatch, getUserHadByBid, findUserHadByName, findCatalogBeer } from '../db/indexed-db';
import { searchUntappdBeer } from './search';
import { getAuthState } from './auth';

export function makeCardKey(card: RawBeer): string {
  const b = (card.brewery || '').toLowerCase().trim();
  const n = (card.name || '').toLowerCase().trim();
  const a = card.abv !== undefined ? card.abv : '';
  const bid = card.bid !== undefined ? card.bid : '';
  return `${b}::${n}::${a}::${bid}`;
}

export async function matchLocalCards(cards: RawBeer[]): Promise<MatchResult[]> {
  const auth = await getAuthState();
  const results: MatchResult[] = [];

  for (const card of cards) {
    const cardKey = makeCardKey(card);

    // 1. Try local cache in IndexedDB
    const cached = await getCardMatch(cardKey);
    if (cached) {
      // Re-verify personal drank status with user's local history if user is logged in
      if (auth.isLoggedIn && cached.matched_beer?.untappd_id) {
        const had = await getUserHadByBid(cached.matched_beer.untappd_id);
        if (had) {
          cached.is_drunk = true;
          cached.user_rating = had.rating;
        }
      }
      results.push(cached);
      continue;
    }

    // 2. Resolve identity from local DB first
    let matchedId: number | null = null;
    let matchedName = card.name;
    let matchedBrewery = card.brewery;
    let globalRating: number | null = null;
    let isDrunk = false;
    let userRating: number | null = null;

    // Check by published BID
    if (card.bid) {
      matchedId = card.bid;
      const had = await getUserHadByBid(card.bid);
      if (had) {
        isDrunk = true;
        userRating = had.rating;
        matchedName = had.name;
        matchedBrewery = had.brewery;
      }
    }

    // If not found yet, check user_had by name
    if (!matchedId) {
      const had = await findUserHadByName(card.brewery, card.name);
      if (had) {
        matchedId = had.bid;
        isDrunk = true;
        userRating = had.rating;
        matchedName = had.name;
        matchedBrewery = had.brewery;
      }
    }

    // If not in user_had, check local catalog
    if (!matchedId) {
      const inCat = await findCatalogBeer(card.brewery, card.name);
      if (inCat) {
        matchedId = inCat.bid;
        matchedName = inCat.name;
        matchedBrewery = inCat.brewery;
        globalRating = inCat.ratingGlobal;
      }
    }

    // 3. If still unknown, query Untappd search
    if (!matchedId) {
      const searched = await searchUntappdBeer(card.brewery, card.name);
      if (searched) {
        matchedId = searched.bid;
        matchedName = searched.beerName;
        matchedBrewery = searched.breweryName;
        globalRating = searched.ratingGlobal;

        // Check if user had this newly discovered beer
        const had = await getUserHadByBid(searched.bid);
        if (had) {
          isDrunk = true;
          userRating = had.rating;
        }
      }
    }

    const matchRes: MatchResult = {
      raw: { brewery: card.brewery, name: card.name },
      matched_beer: matchedId
        ? {
            id: matchedId,
            untappd_id: matchedId,
            name: matchedName,
            brewery: matchedBrewery,
            rating_global: globalRating,
          }
        : null,
      is_drunk: isDrunk,
      drunk_uncertain: false,
      user_rating: userRating,
      source: matchedId ? 'exact' : null,
      searched: true,
    };

    // Save in local match cache in IndexedDB
    await saveCardMatch(cardKey, matchRes);
    results.push(matchRes);
  }

  return results;
}
