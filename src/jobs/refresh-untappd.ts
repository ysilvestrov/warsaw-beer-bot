import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { parseUserBeerPage } from '../sources/untappd/scraper';
import { allProfiles } from '../storage/user_profiles';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { mergeCheckin } from '../storage/checkins';
import { normalizeBrewery, normalizeName } from '../domain/normalize';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
}

export async function refreshAllUntappd(deps: Deps): Promise<void> {
  const { db, log, http } = deps;
  for (const p of allProfiles(db)) {
    if (!p.untappd_username) continue;
    try {
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beer`);
      const items = parseUserBeerPage(html);
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        const beerId =
          existing?.id ??
          upsertBeer(db, {
            untappd_id: it.bid ?? null,
            name: it.beer_name,
            brewery: it.brewery_name,
            style: null,
            abv: null,
            rating_global: it.rating_score,
            normalized_name: nn,
            normalized_brewery: nb,
          });
        mergeCheckin(db, {
          checkin_id: it.checkin_id,
          telegram_id: p.telegram_id,
          beer_id: beerId,
          user_rating: it.rating_score,
          checkin_at: it.checkin_at || new Date().toISOString(),
          venue: null,
        });
      }
    } catch (e) {
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
  }
}
