import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import type { Http } from '../sources/http';
import { enrichOneOrphan } from './untappd-enrich';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function fakeHttp(html: string): Http {
  return { async get(): Promise<string> { return html; } };
}

function throwingHttp(err: Error): Http {
  return {
    async get(): Promise<string> { throw err; },
  };
}

function searchHtml(items: Array<{ bid: number; name: string; brewery: string; rating?: string }>): string {
  const cards = items
    .map((it) => `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/${it.bid}">${it.name}</a></p>
          <p class="brewery"><a>${it.brewery}</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">5% ABV</p>
          <div class="rating">
            <div class="caps" data-rating="${it.rating ?? '3.5'}"></div>
          </div>
        </div>
      </div>`)
    .join('');
  return `<html><body>${cards}</body></html>`;
}

describe('enrichOneOrphan', () => {
  test('matched: fills untappd_id + rating, returns "matched"', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'Fifty/Fifty Clementine & Passionfruit', brewery: 'Magic Road Brewery',
      style: null, abv: 4.6, rating_global: null,
      normalized_name: 'fifty fifty clementine passionfruit',
      normalized_brewery: 'magic road',
    });
    const http = fakeHttp(searchHtml([
      { bid: 6645513, name: 'Fifty Fifty - Clementine & Passionfruit', brewery: 'Magic Road', rating: '3.98' },
    ]));

    const out = await enrichOneOrphan({ db, log: silentLog, http }, beerId);

    expect(out).toBe('matched');
    const row = getBeer(db, beerId);
    expect(row?.untappd_id).toBe(6645513);
    expect(row?.rating_global).toBeCloseTo(3.98);
    expect(row?.untappd_lookup_count).toBe(0); // success doesn't increment
  });

  test('not_found: increments count + records lookup_at, returns "not_found"', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'Something Obscure', brewery: 'Unknown Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: 'something obscure', normalized_brewery: 'unknown',
    });
    const http = fakeHttp('<html><body></body></html>');
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const out = await enrichOneOrphan(
      { db, log: silentLog, http, now: () => fixedNow }, beerId,
    );

    expect(out).toBe('not_found');
    const row = getBeer(db, beerId);
    expect(row?.untappd_id).toBeNull();
    expect(row?.untappd_lookup_count).toBe(1);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00.000Z');
  });

  test('transient: HTTP error, records lookup_at without incrementing count', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    const http = throwingHttp(new Error('ETIMEDOUT'));
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const out = await enrichOneOrphan(
      { db, log: silentLog, http, now: () => fixedNow }, beerId,
    );

    expect(out).toBe('transient');
    const row = getBeer(db, beerId);
    expect(row?.untappd_lookup_count).toBe(0);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00.000Z');
  });

  test('skipped: beer already has untappd_id', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      untappd_id: 42,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    let httpCalled = false;
    const http: Http = {
      async get(): Promise<string> { httpCalled = true; return ''; },
    };

    const out = await enrichOneOrphan({ db, log: silentLog, http }, beerId);

    expect(out).toBe('skipped');
    expect(httpCalled).toBe(false);
  });

  test('skipped: backoff not yet elapsed', async () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    db.prepare(
      'UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = ? WHERE id = ?',
    ).run('2026-05-26T11:00:00Z', 1, beerId);
    let httpCalled = false;
    const http: Http = {
      async get(): Promise<string> { httpCalled = true; return ''; },
    };
    const fixedNow = new Date('2026-05-26T12:00:00Z');

    const out = await enrichOneOrphan(
      { db, log: silentLog, http, now: () => fixedNow }, beerId,
    );

    expect(out).toBe('skipped');
    expect(httpCalled).toBe(false);
  });

  test('duplicate untappd_id: merges orphan into canonical, returns not_found', async () => {
    const db = fresh();

    // Canonical entry already has untappd_id=999.
    const canonicalId = upsertBeer(db, {
      untappd_id: 999,
      name: 'Marine', brewery: 'Moon Lark Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: 'marine', normalized_brewery: 'moon lark',
    });

    // Orphan for the same Untappd beer (collab ontap name, no untappd_id).
    const orphanId = upsertBeer(db, {
      name: 'Marine', brewery: 'Moon Lark & AleBrowar Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: 'marine', normalized_brewery: 'moon lark alebrowar',
    });
    db.prepare('INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence) VALUES (?,?,1)')
      .run('Marine ontap', orphanId);

    // Untappd returns bid=999 — same as canonical.
    const http = fakeHttp(searchHtml([
      { bid: 999, name: 'Marine', brewery: 'Moon Lark Brewery' },
    ]));

    const out = await enrichOneOrphan({ db, log: silentLog, http }, orphanId);

    expect(out).toBe('not_found');
    // Orphan row deleted.
    expect(getBeer(db, orphanId)).toBeNull();
    // match_link redirected to canonical.
    const ml = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Marine ontap') as { untappd_beer_id: number } | undefined;
    expect(ml?.untappd_beer_id).toBe(canonicalId);
  });

  test('skipped: beer does not exist (defensive)', async () => {
    const db = fresh();
    let httpCalled = false;
    const http: Http = {
      async get(): Promise<string> { httpCalled = true; return ''; },
    };
    const out = await enrichOneOrphan({ db, log: silentLog, http }, 9999);
    expect(out).toBe('skipped');
    expect(httpCalled).toBe(false);
  });
});
