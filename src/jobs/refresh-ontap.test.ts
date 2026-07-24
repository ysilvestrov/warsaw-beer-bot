import pino from 'pino';
import { vi } from 'vitest';
import { filterIndexBySlugs, refreshOntap } from './refresh-ontap';
import type { IndexPub } from '../sources/ontap/index';
import { HttpError, type Http } from '../sources/http';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { latestSnapshot, tapsForSnapshot } from '../storage/snapshots';
import { listLookupCandidates, upsertBeer } from '../storage/beers';
import { CITIES } from '../domain/cities';
import { listPubs } from '../storage/pubs';
import { createCircuitBreaker } from '../domain/untappd-circuit';
import { prepareCatalogChunked } from '../domain/catalog-cache';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import type { BeerSearch } from '../sources/untappd/search';
import { getMatch, upsertMatch } from '../storage/match_links';

// Wrap upsertBeer in a spy while keeping the real implementation (and every other
// export, e.g. listLookupCandidates) intact. Lets the orphan-reuse test assert that a
// second pub with the same beer takes the in-memory match path — NOT a second insert.
vi.mock('../storage/beers', async (importActual) => {
  const actual = await importActual<typeof import('../storage/beers')>();
  return { ...actual, upsertBeer: vi.fn(actual.upsertBeer) };
});

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
      search: { search: async () => [] },
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

  test('leaves a pinned tap link untouched instead of re-matching it', async () => {
    const db = openDb(':memory:');
    migrate(db);

    // Canonical target beer (already matched) + a curated pin whose ontap_ref does NOT
    // describe it, so normal matching would re-orphan the tap and clobber the link.
    const canonicalId = upsertBeer(db, {
      untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
      style: null, abv: null, rating_global: 4.1,
      normalized_name: normalizeName('Banany Na Rauszu 2026'),
      normalized_brewery: normalizeBrewery('ReCraft'),
    });
    upsertMatch(db, 'Urodzinowe', canonicalId, 1.0);
    db.prepare("UPDATE match_links SET reviewed_by_user = 1 WHERE ontap_ref = 'Urodzinowe'").run();

    const indexHtml = `
      <div onclick="location.assign('https://mixed.ontap.pl/')">
        <div class="panel-body">Mixed Pub 1 taps</div>
      </div>
    `;
    const pubHtml = `
      <html><head><meta property="og:title" content="Mixed Pub / ontap.pl"></head>
      <body>${panel(1, 'Recraft', 'Urodzinowe 5%', 'Ale')}</body></html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://mixed.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder: async () => null,
      lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
    });

    const link = getMatch(db, 'Urodzinowe');
    expect(link?.untappd_beer_id).toBe(canonicalId);
    expect(link?.reviewed_by_user).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM beers WHERE name = 'Urodzinowe'").get()).toEqual({ n: 0 });
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
      db, log: silentLog, http, search: { search: async () => [] }, geocoder: async () => null,
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

  test('drops ontap parser-polluted brewery-only and location rows before catalog writes', async () => {
    const db = openDb(':memory:');
    migrate(db);

    const indexHtml = `
      <div onclick="location.assign('https://polluted.ontap.pl/')">
        <div class="panel-body">Polluted Pub 4 taps</div>
      </div>
    `;
    const pubHtml = `
      <html><head><meta property="og:title" content="Polluted Pub / ontap.pl"></head>
      <body>
        ${panel(1, 'Przetwórnia Chmielu Brewery', 'Przetwórnia Chmielu Brewery 5%', 'Pszeniczne')}
        ${panel(2, 'Frankies Brewery', 'Frankies Brewery 4,5%', 'Svetlý Ležák')}
        ${panel(3, 'W Brzesku Brewery', 'Žatecký Nealko 0%', 'Pilzner bezalkoholowy')}
        ${panel(4, 'PINTA Brewery', 'PINTA Atak Chmielu 6%', 'West Coast IPA')}
      </body></html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://polluted.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder: async () => null,
      lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
    });

    const beers = db.prepare('SELECT brewery, name FROM beers ORDER BY id').all();
    expect(beers).toEqual([
      expect.objectContaining({ brewery: 'PINTA Brewery', name: 'PINTA Atak Chmielu' }),
    ]);
  });

  test('writes normalized cider producer identities instead of ontap product-line breweries', async () => {
    const db = openDb(':memory:');
    migrate(db);

    const indexHtml = `
      <div onclick="location.assign('https://cider.ontap.pl/')">
        <div class="panel-body">Cider Pub 2 taps</div>
      </div>
    `;
    const pubHtml = `
      <html><head><meta property="og:title" content="Cider Pub / ontap.pl"></head>
      <body>
        ${panel(1, 'CYDR DZIK Brewery', 'Cydr Jabłko 4,5%', 'Cydr Jabłkowy')}
        ${panel(2, 'Cydr Flirt Tradycynis', 'Cydr malina i skórka pomarańczowa 5%', 'Cydr z gruszką')}
      </body></html>
    `;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return indexHtml;
        if (url === 'https://cider.ontap.pl/') return pubHtml;
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder: async () => null,
      lookupEnabled: false, cities: CITIES.filter((c) => c.slug === 'warszawa'),
    });

    const beers = db.prepare('SELECT brewery, name, style FROM beers ORDER BY id').all();
    expect(beers).toEqual([
      { brewery: 'Cydrownia', name: 'Dzik Jabłko', style: 'Cydr Jabłkowy' },
      {
        brewery: 'Kauno Alus',
        name: 'Tradycynis Cydr Flirt malina i skórka pomarańczowa',
        style: 'Cydr z gruszką',
      },
    ]);
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
    await refreshOntap({ db, log: silentLog, http, search: { search: async () => [] }, geocoder, cities: twoCities, lookupEnabled: false });
    expect(listPubs(db, 'warszawa').map((p) => p.slug)).toEqual(['warszawapub']);
    expect(listPubs(db, 'krakow').map((p) => p.slug)).toEqual(['krakowpub']);
  });

  test('a city whose index fetch throws is skipped; others still scrape', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = makeHttp('warszawa');
    await refreshOntap({ db, log: silentLog, http, search: { search: async () => [] }, geocoder, cities: twoCities, lookupEnabled: false });
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
      db, log: silentLog, http, search: { search: async () => [] }, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 0, lookupSleepMs: 0,
    });
    expect(beerCount(db)).toBe(2);       // orphans WERE created (path is reachable)
    expect(enrichedCount(db)).toBe(0);   // budget 0 → none enriched
  });

  test('inlineEnrichBudget caps enrichment across the run', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http } = budgetHttp();
    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 1, lookupSleepMs: 0,
    });
    expect(beerCount(db)).toBe(2);       // two orphans
    expect(enrichedCount(db)).toBe(1);   // only one enriched — budget cap holds
  });

  test('inline enrich block trips breaker and disables later inline enrich while ontap continues', async () => {
    const db = openDb(':memory:'); migrate(db);
    const calls: string[] = [];
    const http: Http = {
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
        throw new Error(`Unexpected URL ${url}`);
      },
    };
    const searchCalls: string[] = [];
    const search = {
      search: async (q: string) => {
        searchCalls.push(q);
        throw new HttpError(403, 'u');
      },
    };
    const events: string[] = [];
    const T = new Date('2026-06-25T12:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => events.push('trip'),
      onRecover: () => events.push('recover'),
    });

    await refreshOntap({
      db, log: silentLog, http, search, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 20, lookupSleepMs: 0,
      breaker, now: () => T,
    });

    expect(beerCount(db)).toBe(2);
    expect(searchCalls).toHaveLength(1);
    expect(calls.some((url) => url.startsWith('https://untappd.com'))).toBe(false);
    expect(events).toEqual(['trip']);
    expect(breaker.state).toBe('open');
    expect(enrichedCount(db)).toBe(0);
  });

  test('search dep: Untappd lookups use search, not http', async () => {
    const db = openDb(':memory:'); migrate(db);
    const ontapCalls: string[] = [];
    const searchCalls: string[] = [];

    const http: Http = {
      async get(url: string): Promise<string> {
        if (url.startsWith('https://untappd.com')) {
          throw new Error(`Unexpected untappd call on shop http: ${url}`);
        }
        ontapCalls.push(url);
        if (url === 'https://ontap.pl/warszawa') return cityIndex('warszawa');
        if (url === 'https://warszawapub.ontap.pl/') {
          return `<html><head><meta property="og:title" content="Warsaw Pub / ontap.pl"></head>
            <body>
              ${panel(1, 'Fresh Brewery', 'Fresh Beer 5%', 'IPA')}
            </body></html>`;
        }
        return '';
      },
    };
    const search = {
      search: async (q: string) => {
        searchCalls.push(q);
        return []; // no results → not_found
      },
    };

    await refreshOntap({
      db, log: silentLog, http, search, geocoder: async () => null,
      cities: oneCity, lookupEnabled: true, inlineEnrichBudget: 5, lookupSleepMs: 0,
      now: () => new Date('2026-06-25T12:00:00Z'),
    });

    // Untappd search went to search dep, not to http
    expect(searchCalls.length).toBeGreaterThan(0);
    expect(ontapCalls.some((u) => u.startsWith('https://untappd.com'))).toBe(false);
  });

  test('open breaker skips inline enrich without failing ontap refresh', async () => {
    const db = openDb(':memory:'); migrate(db);
    const { http, calls } = budgetHttp();
    const T = new Date('2026-06-25T12:00:00Z');
    const breaker = createCircuitBreaker({
      cooldownMs: 6 * 3600_000,
      onTrip: () => {},
      onRecover: () => {},
    });
    breaker.onResult(true, T);

    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 20, lookupSleepMs: 0,
      breaker, now: () => new Date(T.getTime() + 3600_000),
    });

    expect(beerCount(db)).toBe(2);
    expect(calls.filter((url) => url.startsWith('https://untappd.com/search'))).toHaveLength(0);
    expect(enrichedCount(db)).toBe(0);
    expect(breaker.state).toBe('open');
  });

  test('prepares the catalog once per run regardless of pub count', async () => {
    const db = openDb(':memory:'); migrate(db);
    const index = `
      <div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>
      <div onclick="location.assign('https://pubb.ontap.pl/')"><div class="panel-body">B 1 taps</div></div>`;
    const pubHtml = (n: string) =>
      `<html><head><meta property="og:title" content="${n} / ontap.pl"></head>
        <body>${panel(1, 'Foo Brewery', 'Foo Hazy 6%', 'IPA')}</body></html>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/') return pubHtml('A');
        if (url === 'https://pubb.ontap.pl/') return pubHtml('B');
        return '';
      },
    };
    const prepareSpy = vi.fn((rows) => prepareCatalogChunked(rows));
    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false, prepareCatalog: prepareSpy,
    });
    expect(prepareSpy).toHaveBeenCalledTimes(1);
  });

  test('a fresh orphan from one pub is reused by a later pub (no duplicate insert)', async () => {
    const db = openDb(':memory:'); migrate(db);
    vi.mocked(upsertBeer).mockClear();
    const index = `
      <div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>
      <div onclick="location.assign('https://pubb.ontap.pl/')"><div class="panel-body">B 1 taps</div></div>`;
    const sharedBody = `<body>${panel(1, 'Foo Brewery', 'Foo Hazy 6%', 'IPA')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/' || url === 'https://pubb.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${sharedBody}</html>`;
        return '';
      },
    };
    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false,
    });
    // The discriminating assertion: pub A inserts the orphan and prepared.add()s it, so
    // pub B's identical tap takes the in-memory matchPrepared path (m truthy) → upsertBeer
    // fires exactly ONCE. Without prepared.add, pub B re-enters the orphan else-branch and
    // upsertBeer runs a SECOND time (DB UPSERT still dedups to 1 row, so beerCount alone
    // can't tell the two apart — hence the call-count check).
    expect(upsertBeer).toHaveBeenCalledTimes(1);
    expect(beerCount(db)).toBe(1); // one orphan, reused across pubs — not duplicated
  });

  test('a fresh orphan merged by inline enrich in one pub does not FK-crash a later pub', async () => {
    const db = openDb(':memory:'); migrate(db);
    // Canonical beer already owns untappd_id 999.
    upsertBeer(db, {
      untappd_id: 999, name: 'Marine', brewery: 'Moon Lark Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
    });
    // Two pubs list the SAME beer. It is NOT name-matchable to the canonical (different name)
    // so it becomes a fresh orphan, but inline enrich resolves it to bid 999 → UNIQUE
    // collision → mergeIntoCanonical deletes the orphan mid-run.
    const index = `
      <div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>
      <div onclick="location.assign('https://pubb.ontap.pl/')"><div class="panel-body">B 1 taps</div></div>`;
    const body = `<body>${panel(1, 'Moon Lark Brewery', 'Deep Sea Diver 6%', 'IPA')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/' || url === 'https://pubb.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${body}</html>`;
        return '';
      },
    };
    const search: BeerSearch = {
      search: async () => [
        { bid: 999, beer_name: 'Deep Sea Diver', brewery_name: 'Moon Lark Brewery', style: null, abv: null, global_rating: null },
      ],
    };
    const lines: any[] = [];
    const log = pino({ level: 'warn' }, { write: (s: string) => lines.push(JSON.parse(s)) });
    await refreshOntap({
      db, log, http, search, geocoder, cities: oneCity,
      lookupEnabled: true, inlineEnrichBudget: 5, lookupSleepMs: 0,
    });
    // The merge fired both times → only the canonical row remains, still owning 999.
    expect(beerCount(db)).toBe(1);
    expect((db.prepare('SELECT untappd_id FROM beers').get() as { untappd_id: number }).untappd_id).toBe(999);
    // Regression guard: the second pub must NOT have FK-crashed.
    expect(lines.find((l) => l.msg === 'ontap pub refresh failed')).toBeUndefined();
  });
});
