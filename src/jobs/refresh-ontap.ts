import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import type { Geocoder } from '../sources/geocoder';
import { parseWarsawIndex, type IndexPub } from '../sources/ontap/index';
import { parsePubPage } from '../sources/ontap/pub';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { upsertBeer } from '../storage/beers';
import { matchBeer } from '../domain/matcher';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { noopProgress, type ProgressFn } from './progress';
import { enrichOneOrphan } from './untappd-enrich';

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
}

export async function refreshOntap(deps: Deps): Promise<void> {
  const {
    db, log, http, geocoder,
    onProgress = noopProgress,
    lookupEnabled = true,
    lookupSleepMs = 500,
    now = () => new Date(),
  } = deps;
  await onProgress('🍻 ontap: парсю індекс…', { force: true });
  const indexHtml = await http.get('https://ontap.pl/warszawa');
  const indexPubs = filterIndexBySlugs(parseWarsawIndex(indexHtml), deps.pubSlugs);
  log.info({ n: indexPubs.length, scoped: deps.pubSlugs != null }, 'ontap index parsed');
  await onProgress(`🍻 ontap: 0/${indexPubs.length} пабів`, { force: true });

  let i = 0;
  let ok = 0;
  for (const ip of indexPubs) {
    i++;
    try {
      const html = await http.get(`https://${ip.slug}.ontap.pl/`);
      const { pub, taps } = parsePubPage(html);

      let lat = pub.lat;
      let lon = pub.lon;
      if ((lat == null || lon == null) && pub.address) {
        const g = await geocoder(pub.address);
        if (g) {
          lat = g.lat;
          lon = g.lon;
        }
      }

      const pubId = upsertPub(db, {
        slug: ip.slug,
        name: pub.name || ip.name,
        address: pub.address,
        lat,
        lon,
      });
      const snapshotId = createSnapshot(db, pubId, new Date().toISOString());
      insertTaps(db, snapshotId, taps);

      const catalog = listBeerCatalog(db);
      for (const t of taps) {
        const brewery = t.brewery_ref ?? t.beer_ref.split(/[—-]\s|:\s/)[0] ?? '';
        const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
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

        // Inline Untappd enrichment ONLY for beers we just created
        // (matchBeer returned null). Existing orphans (matched to a row
        // that has untappd_id NULL) are handled by the enrich-orphans
        // cron — letting inline try them every 12h multiplies HTTP +
        // sleep across the full backlog. PR-D2.1 perf fix (2026-05-26).
        // Sleep only when HTTP actually fired (outcome !== 'skipped')
        // as a defense in depth.
        if (lookupEnabled && isFreshOrphan) {
          const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
          if (lookupSleepMs > 0 && outcome !== 'skipped') {
            await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
          }
        }
      }
      ok++;
    } catch (e) {
      log.warn({ err: e, slug: ip.slug }, 'ontap pub refresh failed');
    }
    await onProgress(`🍻 ontap: ${i}/${indexPubs.length} — ${ip.slug}`);
  }
  await onProgress(`🍻 ontap: ✓ ${ok}/${indexPubs.length} пабів`, { force: true });
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
