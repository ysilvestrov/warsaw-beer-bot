import { describe, test, expect } from 'vitest';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer, getBeer } from '../storage/beers';
import { upsertMatch, getMatch } from '../storage/match_links';
import { recordEnrichFailure } from '../storage/enrich_failures';
import { pinMatch, unpinByRef, unpinByBeer, listPins } from './pin-match';

function newDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function orphan(db: ReturnType<typeof openDb>, brewery: string, name: string): number {
  return upsertBeer(db, {
    untappd_id: null, name, brewery, style: null, abv: null, rating_global: null,
    normalized_name: name.toLowerCase(), normalized_brewery: brewery.toLowerCase(),
  });
}

const AT = '2026-07-23T12:00:00.000Z';

describe('pinMatch', () => {
  test('merge case: redirects the orphan link to the canonical row, pins it, deletes orphan', () => {
    const db = newDb();
    const canonicalId = upsertBeer(db, {
      untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
      style: null, abv: null, rating_global: 4.1,
      normalized_name: 'banany na rauszu 2026', normalized_brewery: 'recraft',
    });
    upsertMatch(db, 'Banany Na Rauszu', canonicalId, 1.0);
    const orphanId = orphan(db, 'Recraft / Z INNEJ BECZKI Brewery', 'Urodzinowe');
    upsertMatch(db, 'Urodzinowe', orphanId, 1.0);
    recordEnrichFailure(db, {
      beer_id: orphanId, brewery: 'Recraft', name: 'Urodzinowe', search_url: '',
      source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: AT,
    });

    const res = pinMatch(db, orphanId, 6614460, AT);

    expect(res).toEqual({ kind: 'merged', canonicalId, redirected: 1 });
    expect(getBeer(db, orphanId)).toBeNull();
    const link = getMatch(db, 'Urodzinowe');
    expect(link?.untappd_beer_id).toBe(canonicalId);
    expect(link?.reviewed_by_user).toBe(1);
    expect(getMatch(db, 'Banany Na Rauszu')?.reviewed_by_user).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrich_failures').get()).toEqual({ n: 0 });
  });

  test('merge case: redirects the orphan checkins to the canonical row (no FK abort)', () => {
    const db = newDb();
    const canonicalId = upsertBeer(db, {
      untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
      style: null, abv: null, rating_global: 4.1,
      normalized_name: 'banany na rauszu 2026', normalized_brewery: 'recraft',
    });
    const orphanId = orphan(db, 'Recraft', 'Urodzinowe');
    upsertMatch(db, 'Urodzinowe', orphanId, 1.0);
    // checkins.beer_id → beers(id) has NO CASCADE; a checkin on the orphan would abort
    // the DELETE with foreign_keys=ON unless pinMatch redirects it first.
    db.prepare(
      'INSERT INTO checkins (checkin_id, telegram_id, beer_id, user_rating, checkin_at) VALUES (?, ?, ?, ?, ?)',
    ).run('c1', 42, orphanId, 4.0, AT);

    const res = pinMatch(db, orphanId, 6614460, AT);

    expect(res.kind).toBe('merged');
    expect(getBeer(db, orphanId)).toBeNull();
    expect(db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?').get('c1'))
      .toEqual({ beer_id: canonicalId });
  });

  test('new-bid case: sets untappd_id on the orphan row, pins its link, clears failure', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    recordEnrichFailure(db, {
      beer_id: orphanId, brewery: 'CYDR Fizz', name: 'Pear taste', search_url: '',
      source_url: '', outcome: 'not_found', candidates_count: 0, candidates_summary: '', at: AT,
    });

    const res = pinMatch(db, orphanId, 1093012, AT);

    expect(res).toEqual({ kind: 'set', beerId: orphanId });
    expect(getBeer(db, orphanId)?.untappd_id).toBe(1093012);
    expect(getMatch(db, 'Pear taste')?.reviewed_by_user).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrich_failures').get()).toEqual({ n: 0 });
  });

  test('idempotent: re-pinning an already-pinned beer is a no-op that keeps the flag', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    pinMatch(db, orphanId, 1093012, AT);

    const res = pinMatch(db, orphanId, 1093012, AT);

    expect(res).toEqual({ kind: 'set', beerId: orphanId });
    expect(getBeer(db, orphanId)?.untappd_id).toBe(1093012);
    expect(getMatch(db, 'Pear taste')?.reviewed_by_user).toBe(1);
  });

  test('unknown beer: returns noop without throwing', () => {
    const db = newDb();
    const res = pinMatch(db, 99999, 1093012, AT);
    expect(res.kind).toBe('noop');
  });
});

describe('unpin & list', () => {
  test('unpinByRef clears the flag for a merged pin addressed by its ontap_ref', () => {
    const db = newDb();
    const canonicalId = upsertBeer(db, {
      untappd_id: 6614460, name: 'Banany Na Rauszu 2026', brewery: 'ReCraft',
      style: null, abv: null, rating_global: null,
      normalized_name: 'banany na rauszu 2026', normalized_brewery: 'recraft',
    });
    const orphanId = orphan(db, 'Recraft', 'Urodzinowe');
    upsertMatch(db, 'Urodzinowe', orphanId, 1.0);
    pinMatch(db, orphanId, 6614460, AT); // merges → 'Urodzinowe' pinned to canonicalId

    expect(unpinByRef(db, 'Urodzinowe')).toBe(1);
    expect(getMatch(db, 'Urodzinowe')?.reviewed_by_user).toBe(0);
    expect(getMatch(db, 'Urodzinowe')?.untappd_beer_id).toBe(canonicalId);
  });

  test('unpinByBeer clears the flag for a same-row pin', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    pinMatch(db, orphanId, 1093012, AT);

    expect(unpinByBeer(db, orphanId)).toBe(1);
    expect(getMatch(db, 'Pear taste')?.reviewed_by_user).toBe(0);
  });

  test('listPins returns all pinned links with their beer + untappd_id', () => {
    const db = newDb();
    const orphanId = orphan(db, 'CYDR Fizz', 'Pear taste');
    upsertMatch(db, 'Pear taste', orphanId, 1.0);
    pinMatch(db, orphanId, 1093012, AT);

    expect(listPins(db)).toEqual([
      { ontap_ref: 'Pear taste', beer_id: orphanId, brewery: 'CYDR Fizz', name: 'Pear taste', untappd_id: 1093012 },
    ]);
  });
});
