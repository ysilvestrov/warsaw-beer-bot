import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import type { Geocoder } from '../sources/geocoder';
import { parseOntapCityIndex, type IndexPub } from '../sources/ontap/index';
import { CITIES, type City } from '../domain/cities';
import { isOntapNonBeerTap } from '../sources/ontap/non-beer';
import { isOntapEmptyTapRef, parsePubPage } from '../sources/ontap/pub';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { upsertBeer } from '../storage/beers';
import { matchPrepared, prepareCatalog } from '../domain/matcher';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { noopProgress, type ProgressFn } from './progress';
import { enrichOneOrphan } from './untappd-enrich';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  geocoder: Geocoder;
  onProgress?: ProgressFn;
  lookupEnabled?: boolean;     // default true
  lookupSleepMs?: number;       // default 500
  now?: () => Date;             // for tests
  pubSlugs?: Set<string>;       // when set, refresh only these pubs (scoped /refresh)
  cities?: readonly City[];     // default CITIES
  inlineEnrichBudget?: number;  // default 20 — total inline Untappd enriches per run
  breaker?: CircuitBreaker;     // default noopBreaker
}

export async function refreshOntap(deps: Deps): Promise<void> {
  const {
    db, log, http, geocoder,
    onProgress = noopProgress,
    lookupEnabled = true,
    lookupSleepMs = 500,
    now = () => new Date(),
    cities = CITIES,
    inlineEnrichBudget = 20,
    breaker = noopBreaker,
  } = deps;

  let enrichBudget = inlineEnrichBudget;
  let inlineEnrichStopped = false;

  for (const city of cities) {
    let indexPubs: IndexPub[];
    try {
      await onProgress(`🍻 ontap ${city.slug}: парсю індекс…`, { force: true });
      const indexHtml = await http.get(`https://ontap.pl/${city.slug}`);
      indexPubs = filterIndexBySlugs(parseOntapCityIndex(indexHtml), deps.pubSlugs);
    } catch (e) {
      log.warn({ err: e, city: city.slug }, 'ontap city index failed');
      continue;
    }
    log.info({ city: city.slug, n: indexPubs.length, scoped: deps.pubSlugs != null }, 'ontap index parsed');
    await onProgress(`🍻 ontap ${city.slug}: 0/${indexPubs.length} пабів`, { force: true });

    let i = 0;
    let ok = 0;
    for (const ip of indexPubs) {
      i++;
      try {
        const html = await http.get(`https://${ip.slug}.ontap.pl/`);
        const { pub, taps: parsedTaps } = parsePubPage(html);
        const taps = parsedTaps.filter((t) => !isOntapNonBeerTap(t));
        const droppedNonBeer = parsedTaps.length - taps.length;
        if (droppedNonBeer > 0) {
          log.info({ slug: ip.slug, droppedNonBeer }, 'ontap non-beer taps filtered');
        }

        let lat = pub.lat;
        let lon = pub.lon;
        if ((lat == null || lon == null) && pub.address) {
          const g = await geocoder(pub.address);
          if (g) { lat = g.lat; lon = g.lon; }
        }

        const pubId = upsertPub(db, {
          slug: ip.slug,
          name: pub.name || ip.name,
          address: pub.address,
          lat,
          lon,
          city: city.slug,
        });
        const snapshotId = createSnapshot(db, pubId, new Date().toISOString());
        insertTaps(db, snapshotId, taps);

        const catalog = listBeerCatalog(db);
        const prepared = prepareCatalog(catalog);
        for (const t of taps) {
          if (isOntapEmptyTapRef(t.beer_ref)) continue;
          const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
          const m = matchPrepared({ brewery, name: t.beer_ref, abv: t.abv }, prepared);
          let beerId: number;
          let isFreshOrphan = false;
          if (m) {
            upsertMatch(db, t.beer_ref, m.id, m.confidence);
            beerId = m.id;
          } else {
            beerId = upsertBeer(db, {
              name: t.beer_ref,
              brewery,
              style: t.style,
              abv: t.abv,
              rating_global: t.u_rating,
              normalized_name: normalizeName(t.beer_ref),
              normalized_brewery: normalizeBrewery(brewery),
            });
            upsertMatch(db, t.beer_ref, beerId, 1.0);
            isFreshOrphan = true;
          }

          // Inline Untappd enrichment ONLY for freshly-created orphans, and only
          // while the per-run budget remains — the multi-city seeding burst is
          // otherwise drained by the rate-limited enrich-orphans cron (#146).
          if (
            lookupEnabled &&
            isFreshOrphan &&
            enrichBudget > 0 &&
            !inlineEnrichStopped &&
            breaker.canAttempt(now())
          ) {
            const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
            if (outcome === 'blocked') {
              breaker.onResult(true, now());
              inlineEnrichStopped = true;
              enrichBudget--;
            } else if (outcome !== 'skipped') {
              breaker.onResult(false, now());
              enrichBudget--;
              if (lookupSleepMs > 0) {
                await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
              }
            }
          }
        }
        ok++;
      } catch (e) {
        log.warn({ err: e, slug: ip.slug }, 'ontap pub refresh failed');
      }
      await onProgress(`🍻 ontap ${city.slug}: ${i}/${indexPubs.length} — ${ip.slug}`);
    }
    await onProgress(`🍻 ontap ${city.slug}: ✓ ${ok}/${indexPubs.length} пабів`, { force: true });
  }
}

export function filterIndexBySlugs(
  pubs: IndexPub[],
  slugs: Set<string> | undefined,
): IndexPub[] {
  if (!slugs) return pubs;
  return pubs.filter((p) => slugs.has(p.slug));
}

function listBeerCatalog(db: DB): { id: number; brewery: string; name: string; abv: number | null }[] {
  return db
    .prepare('SELECT id, brewery, name, abv FROM beers')
    .all() as { id: number; brewery: string; name: string; abv: number | null }[];
}
