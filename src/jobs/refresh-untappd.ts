import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { parseUserBeersPage } from '../sources/untappd/scraper';
import { allProfiles } from '../storage/user_profiles';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { markHad } from '../storage/untappd_had';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { noopProgress, type ProgressFn } from './progress';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  onProgress?: ProgressFn;
}

export async function refreshAllUntappd(deps: Deps): Promise<void> {
  const { db, log, http, onProgress = noopProgress } = deps;
  const profiles = allProfiles(db).filter((p) => p.untappd_username);
  await onProgress(`👤 untappd: 0/${profiles.length} профілів`, { force: true });

  const updateRatingOnly = db.prepare('UPDATE beers SET rating_global = ? WHERE id = ?');

  let i = 0;
  let ok = 0;
  for (const p of profiles) {
    i++;
    try {
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
      const items = parseUserBeersPage(html);
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        let beerId: number;
        if (existing) {
          updateRatingOnly.run(it.global_rating, existing.id);
          beerId = existing.id;
        } else {
          beerId = upsertBeer(db, {
            untappd_id: it.bid,
            name: it.beer_name,
            brewery: it.brewery_name,
            style: it.style,
            abv: null,
            rating_global: it.global_rating,
            normalized_name: nn,
            normalized_brewery: nb,
          });
        }
        markHad(db, p.telegram_id, beerId, new Date().toISOString());
      }
      ok++;
    } catch (e) {
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
    await onProgress(`👤 untappd: ${i}/${profiles.length} — ${p.untappd_username}`);
  }
  await onProgress(`👤 untappd: ✓ ${ok}/${profiles.length} профілів`, { force: true });
}
