import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import type { Geocoder } from '../sources/geocoder';
import { parseWarsawIndex } from '../sources/ontap/index';
import { parsePubPage } from '../sources/ontap/pub';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps } from '../storage/snapshots';
import { upsertMatch } from '../storage/match_links';
import { upsertBeer } from '../storage/beers';
import { matchBeer } from '../domain/matcher';
import { normalizeBrewery, normalizeName } from '../domain/normalize';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  geocoder: Geocoder;
}

export async function refreshOntap(deps: Deps): Promise<void> {
  const { db, log, http, geocoder } = deps;
  const indexHtml = await http.get('https://ontap.pl/warszawa');
  const indexPubs = parseWarsawIndex(indexHtml);
  log.info({ n: indexPubs.length }, 'ontap index parsed');

  for (const ip of indexPubs) {
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
        const m = matchBeer({ brewery, name: t.beer_ref }, catalog);
        if (m) {
          upsertMatch(db, t.beer_ref, m.id, m.confidence);
        } else {
          const beerId = upsertBeer(db, {
            name: t.beer_ref,
            brewery,
            style: t.style,
            abv: t.abv,
            rating_global: t.u_rating,
            normalized_name: normalizeName(t.beer_ref),
            normalized_brewery: normalizeBrewery(brewery),
          });
          upsertMatch(db, t.beer_ref, beerId, 1.0);
        }
      }
    } catch (e) {
      log.warn({ err: e, slug: ip.slug }, 'ontap pub refresh failed');
    }
  }
}

function listBeerCatalog(db: DB): { id: number; brewery: string; name: string }[] {
  return db
    .prepare('SELECT id, brewery, name FROM beers')
    .all() as { id: number; brewery: string; name: string }[];
}
