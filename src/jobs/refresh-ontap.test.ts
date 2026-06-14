import pino from 'pino';
import { filterIndexBySlugs, refreshOntap } from './refresh-ontap';
import type { IndexPub } from '../sources/ontap/index';
import type { Http } from '../sources/http';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { latestSnapshot, tapsForSnapshot } from '../storage/snapshots';
import { listLookupCandidates } from '../storage/beers';

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
