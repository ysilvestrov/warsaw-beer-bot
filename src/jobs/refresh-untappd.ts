import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { CookieExpiredError, HttpError } from '../sources/http';
import { isBlockPage, isBlockStatus } from '../sources/untappd/block';
import { parseUserBeersPage } from '../sources/untappd/scraper';
import { allProfiles } from '../storage/user_profiles';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { markHad } from '../storage/untappd_had';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';
import { noopProgress, type ProgressFn } from './progress';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  onProgress?: ProgressFn;
  notifyAdmin?: (msg: string) => Promise<void>;
  breaker?: CircuitBreaker;
  now?: () => Date;
}

export async function refreshAllUntappd(deps: Deps): Promise<void> {
  const {
    db,
    log,
    http,
    onProgress = noopProgress,
    notifyAdmin,
    breaker = noopBreaker,
    now = () => new Date(),
  } = deps;

  if (!breaker.canAttempt(now())) {
    log.info('refresh-untappd skipped (untappd circuit open)');
    return;
  }

  const profiles = allProfiles(db).filter((p) => p.untappd_username);
  await onProgress(`👤 untappd: 0/${profiles.length} профілів`, { force: true });

  // Refresh the rating and backfill abv when Untappd has it; COALESCE keeps an
  // existing abv if this scrape didn't surface one (don't wipe known values).
  const updateRatingAndAbv = db.prepare(
    'UPDATE beers SET rating_global = ?, abv = COALESCE(?, abv) WHERE id = ?',
  );

  let i = 0;
  let ok = 0;
  for (const p of profiles) {
    i++;
    try {
      const tickNow = now();
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
      if (isBlockPage(html)) {
        breaker.onResult(true, tickNow);
        log.warn({ user: p.untappd_username }, 'untappd scrape blocked');
        break;
      }
      const items = parseUserBeersPage(html);
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        let beerId: number;
        if (existing) {
          updateRatingAndAbv.run(it.global_rating, it.abv, existing.id);
          beerId = existing.id;
        } else {
          beerId = upsertBeer(db, {
            untappd_id: it.bid,
            name: it.beer_name,
            brewery: it.brewery_name,
            style: it.style,
            abv: it.abv,
            rating_global: it.global_rating,
            normalized_name: nn,
            normalized_brewery: nb,
          });
        }
        markHad(db, p.telegram_id, beerId, new Date().toISOString());
      }
      ok++;
      breaker.onResult(false, tickNow);
    } catch (e) {
      if (e instanceof CookieExpiredError) {
        log.warn('untappd cookie expired — stopping scrape');
        await notifyAdmin?.(
          '⚠️ Untappd cookie expired. Run: ./deploy/refresh-cookie.sh <new-value>',
        );
        break;
      }
      if (e instanceof HttpError && isBlockStatus(e.status)) {
        breaker.onResult(true, now());
        log.warn({ err: e, user: p.untappd_username }, 'untappd scrape blocked');
        break;
      }
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
    await onProgress(`👤 untappd: ${i}/${profiles.length} — ${p.untappd_username}`);
  }
  await onProgress(`👤 untappd: ✓ ${ok}/${profiles.length} профілів`, { force: true });
}
