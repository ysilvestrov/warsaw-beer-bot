import pino from 'pino';
import { filterIndexBySlugs, refreshOntap } from './refresh-ontap';
import type { IndexPub } from '../sources/ontap/index';
import type { Http } from '../sources/http';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { latestSnapshot, tapsForSnapshot } from '../storage/snapshots';
import { listLookupCandidates } from '../storage/beers';
import { CITIES } from '../domain/cities';
import { listPubs } from '../storage/pubs';

const silentLog = pino({ level: 'silent' });

const idx: IndexPub[] = [
  { slug: 'bracka', name: 'Bracka 4', taps: 10 },
  { slug: 'piwpaw', name: 'PiwPaw', taps: 20 },
  { slug: 'kufle', name: 'Kufle i kapsle', taps: 30 },
];

describe('filterIndexBySlugs', () => {
  test('returns the full list unchanged when no slugs given', () => {
    expect(filterIndexBySlugs(idx, undefined)).toEqual(idx);
  });

  test('keeps only entries whose slug is in the set', () => {
    const out = filterIndexBySlugs(idx, new Set(['piwpaw', 'kufle']));
    expect(out.map((p) => p.slug)).toEqual(['piwpaw', 'kufle']);
  });

  test('empty set yields empty list', () => {
    expect(filterIndexBySlugs(idx, new Set())).toEqual([]);
  });
});

describe('refreshOntap non-beer filtering', () => {
  test('drops style/brewery non-beer taps before snapshots, catalog, and enrichment', async () => {
    const db = openDb(':memory:');
    migrate(db);

    const indexHtml = `
      <div onclick="location.assign('https://mixed.ontap.pl/')">
        <div class="panel-body">Mixed Pub 6 taps</div>
      </div>
    `;
    const pubHtml = `
      <html>
        <head><meta property="og:title" content="Mixed Pub / ontap.pl"></head>
        <body>
          ${panel(1, 'PINTA Brewery', 'PINTA Atak Chmielu 6%', 'West Coast IPA')}
          ${panel(2, 'Maccari', 'Glera Frizzante IGT Veneto 10,5%', 'PROSECCO')}
          ${panel(3, 'SAN MARTINO', 'SAN MARTINO Chardonnay 11,5%', 'Białe Wytrawne')}
          ${panel(4, 'HUGO', 'HUGO 7%', '')}
          ${panel(5, 'Chyliczki', 'Chyliczki Antonówka 2025 5,5%', 'Cydr Wytrawny')}
          ${panel(6, 'Vilniaus Alus Brewery', 'Vilniaus Alus Brewery Kwas Chlebowy Retro', 'Kwas chlebowy')}
        </body>
      </html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://mixed.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db,
      log: silentLog,
      http,
      geocoder: async () => null,
      lookupEnabled: false,
      now: () => new Date('2026-06-14T12:00:00Z'),
    });

    const pub = db.prepare('SELECT id FROM pubs WHERE slug = ?').get('mixed') as { id: number };
    const snap = latestSnapshot(db, pub.id);
    expect(snap).not.toBeNull();

    const taps = tapsForSnapshot(db, snap!.id);
    expect(taps.map((t) => t.tap_number)).toEqual([1, 5, 6]);
    expect(taps.map((t) => t.style)).toEqual(['West Coast IPA', 'Cydr Wytrawny', 'Kwas chlebowy']);

    const beers = db.prepare('SELECT brewery, name, style FROM beers ORDER BY id').all() as Array<{
      brewery: string;
      name: string;
      style: string | null;
    }>;
    expect(beers).toEqual([
      expect.objectContaining({ brewery: 'PINTA Brewery', style: 'West Coast IPA' }),
      expect.objectContaining({ brewery: 'Chyliczki', style: 'Cydr Wytrawny' }),
      expect.objectContaining({ brewery: 'Vilniaus Alus Brewery', style: 'Kwas chlebowy' }),
    ]);
    expect(beers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ brewery: 'Maccari' }),
      expect.objectContaining({ brewery: 'SAN MARTINO' }),
      expect.objectContaining({ brewery: 'HUGO' }),
    ]));

    const links = db.prepare('SELECT ontap_ref FROM match_links ORDER BY id').all() as Array<{ ontap_ref: string }>;
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.ontap_ref).join(' ')).not.toMatch(/Frizzante|Chardonnay|HUGO/i);

    const candidates = listLookupCandidates(db, 20, new Date('2026-06-14T12:00:00Z'));
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.brewery)).toEqual([
      'PINTA Brewery',
      'Chyliczki',
      'Vilniaus Alus Brewery',
    ]);
  });

  test('keeps N/A in the snapshot without creating catalog or match rows', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const indexHtml = `
      <div onclick="location.assign('https://empty-tap.ontap.pl/')">
        <div class="panel-body">Empty Tap Pub 2 taps</div>
      </div>
    `;
    const pubHtml = `
      <html><head><meta property="og:title" content="Empty Tap Pub / ontap.pl"></head>
      <body>
        ${panel(1, 'Real Brewery', 'Real Beer 5%', 'Pils')}
        ${panel(2, '', 'N/A', '')}
      </body></html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://empty-tap.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db, log: silentLog, http, geocoder: async () => null,
      lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
    });

    const pub = db.prepare('SELECT id FROM pubs WHERE slug = ?').get('empty-tap') as { id: number };
    const snap = latestSnapshot(db, pub.id);
    expect(tapsForSnapshot(db, snap!.id).map((tap) => tap.beer_ref))
      .toEqual(['Real Beer', 'N/A']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM beers WHERE name = 'N/A'").get())
      .toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM match_links WHERE ontap_ref = 'N/A'").get())
      .toEqual({ n: 0 });
  });
});

function panel(
  tap: number,
  brewery: string,
  h4: string,
  style: string,
): string {
  return `
    <div class="panel panel-default" onclick="location.href='https://mixed.ontap.pl/beer?mode=view'">
      <h5><span class="label label-primary">${tap}</span></h5>
      <div class="brewery">${brewery}</div>
      <h4>${h4}</h4>
      <span class="cml_shadow"><b>${style}</b></span>
    </div>
  `;
}

describe('refreshOntap multi-city', () => {
  const cityIndex = (slug: string) => `
    <div onclick="location.assign('https://${slug}pub.ontap.pl/')">
      <div class="panel-body">${slug} Pub 2 taps</div>
    </div>`;
  const pubPage = (name: string) => `
    <html><head><meta property="og:title" content="${name} / ontap.pl"></head>
    <body></body></html>`;

  function makeHttp(throwOn?: string) {
    const calls: string[] = [];
    const http = {
      async get(url: string): Promise<string> {
        calls.push(url);
        if (throwOn && url === `https://ontap.pl/${throwOn}`) throw new Error('boom');
        if (url === 'https://ontap.pl/warszawa') return cityIndex('warszawa');
        if (url === 'https://ontap.pl/krakow') return cityIndex('krakow');
        if (url.endsWith('.ontap.pl/')) return pubPage('Some Pub');
        return '';
      },
    };
    return { http, calls };
  }
  const geocoder = async () => null;
  const twoCities = CITIES.filter((c) => c.slug === 'warszawa' || c.slug === 'krakow');

  test('tags pubs with the city whose index they came from', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = makeHttp();
    await refreshOntap({ db, log: silentLog, http, geocoder, cities: twoCities, lookupEnabled: false });
    expect(listPubs(db, 'warszawa').map((p) => p.slug)).toEqual(['warszawapub']);
    expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['krakowpub']);
  });

  test('a city whose index fetch throws is skipped; others still scrape', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = makeHttp('warszawa');
    await refreshOntap({ db, log: silentLog, http, geocoder, cities: twoCities, lookupEnabled: false });
    expect(listPubs(db, 'warszawa')).toEqual([]);
    expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['krakowpub']);
  });

  // A pub page with two distinct beer taps → two fresh orphans (empty catalog).
  function budgetHttp() {
    const calls: string[] = [];
    const http = {
      async get(url: string): Promise<string> {
        calls.push(url);
        if (url === 'https://ontap.pl/warszawa') return cityIndex('warszawa');
        if (url === 'https://warszawapub.ontap.pl/') {
          return `<html><head><meta property="og:title" content="Budget Pub / ontap.pl"></head>
            <body>
              ${panel(1, 'Foo Brewery', 'Foo Hazy 6%', 'IPA')}
              ${panel(2, 'Bar Brewery', 'Bar Pils 5%', 'Pilsner')}
            </body></html>`;
        }
        return ''; // untappd search etc. → not_found (still a real lookup)
      },
    };
    return { http, calls };
  }
  const oneCity = CITIES.filter((c) => c.slug === 'warszawa');
  const enrichedCount = (db: ReturnType<typeof openDb>) =>
    (db.prepare('SELECT COUNT(*) AS n FROM beers WHERE untappd_lookup_count > 0').get() as { n: number }).n;
  const beerCount = (db: ReturnType<typeof openDb>) =>
    (db.prepare('SELECT COUNT(*) AS n FROM beers').get() as { n: number }).n;

  test('inlineEnrichBudget 0 enriches nothing even though orphans exist', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = budgetHttp();
    await refreshOntap({
      db, log: silentLog, http, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 0, lookupSleepMs: 0,
    });
    expect(beerCount(db)).toBe(2);       // orphans WERE created (path is reachable)
    expect(enrichedCount(db)).toBe(0);   // budget 0 → none enriched
  });

  test('inlineEnrichBudget caps enrichment across the run', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = budgetHttp();
    await refreshOntap({
      db, log: silentLog, http, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 1, lookupSleepMs: 0,
    });
    expect(beerCount(db)).toBe(2);       // two orphans
    expect(enrichedCount(db)).toBe(1);   // only one enriched — budget cap holds
  });
});
