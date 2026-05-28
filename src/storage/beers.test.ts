import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer, findBeerByNormalized } from './beers';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('upsertBeer inserts then updates by normalized key', () => {
  const db = fresh();
  const id1 = upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA',
    abv: 6.1, rating_global: 3.9,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  const id2 = upsertBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA',
    abv: 6.2, rating_global: 3.95,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  expect(id1).toBe(id2);
  const row = findBeerByNormalized(db, 'pinta', 'atak chmielu');
  expect(row?.abv).toBeCloseTo(6.2);
});

test('findBeerByNormalized returns null when absent', () => {
  expect(findBeerByNormalized(fresh(), 'x', 'y')).toBeNull();
});

test('upsertBeer matches by untappd_id when normalization drifts', () => {
  // Simulates the production state where a row was stored under one
  // normalized form (e.g. legacy "captain hazy foreign legion" without
  // numeric tokens) and re-import passes a different normalized form
  // (current "captain hazy foreign legion 2025"). Without the
  // untappd_id-first lookup, the SELECT misses, INSERT fires, and the
  // UNIQUE constraint on beers.untappd_id throws.
  const db = fresh();
  const oldId = upsertBeer(db, {
    untappd_id: 6455502,
    name: 'Captain Hazy - Foreign Legion 2025',
    brewery: 'KOMPAAN Dutch Craft Beer Company',
    style: null, abv: null, rating_global: null,
    normalized_name: 'captain hazy foreign legion',
    normalized_brewery: 'kompaan dutch craft beer',
  });
  const newId = upsertBeer(db, {
    untappd_id: 6455502,
    name: 'Captain Hazy - Foreign Legion 2025',
    brewery: 'KOMPAAN Dutch Craft Beer Company',
    style: 'Bock - Doppelbock', abv: 8.0, rating_global: 3.55,
    normalized_name: 'captain hazy foreign legion 2025',
    normalized_brewery: 'kompaan dutch craft beer',
  });
  expect(newId).toBe(oldId);
  const row = db
    .prepare('SELECT name, style, abv, rating_global, normalized_name FROM beers WHERE id = ?')
    .get(oldId) as { name: string; style: string; abv: number; rating_global: number; normalized_name: string };
  expect(row.rating_global).toBeCloseTo(3.55);
  expect(row.style).toBe('Bock - Doppelbock');
  expect(row.normalized_name).toBe('captain hazy foreign legion 2025');
});

test('upsertBeer falls back to (normalized_brewery, normalized_name) when untappd_id is null', () => {
  const db = fresh();
  const id1 = upsertBeer(db, {
    untappd_id: null, name: 'Foo', brewery: 'Bar',
    style: null, abv: null, rating_global: null,
    normalized_name: 'foo', normalized_brewery: 'bar',
  });
  const id2 = upsertBeer(db, {
    untappd_id: null, name: 'Foo', brewery: 'Bar',
    style: null, abv: 5.0, rating_global: null,
    normalized_name: 'foo', normalized_brewery: 'bar',
  });
  expect(id2).toBe(id1);
});

test('upsertBeer prefers untappd_id row over a normalized-only match', () => {
  // A canonical Untappd-side row exists with bid=42; an orphan ontap-side
  // row exists with same normalized but null bid. Re-importing the bid'd
  // beer must update the canonical, not the orphan.
  const db = fresh();
  const canonId = upsertBeer(db, {
    untappd_id: 42, name: 'Foo', brewery: 'Bar',
    style: null, abv: null, rating_global: null,
    normalized_name: 'foo', normalized_brewery: 'bar',
  });
  const orphanId = upsertBeer(db, {
    untappd_id: null, name: 'Foo', brewery: 'Bar',
    style: null, abv: null, rating_global: null,
    normalized_name: 'foo extra', normalized_brewery: 'bar',
  });
  expect(orphanId).not.toBe(canonId);
  // Re-import: bid=42, but the data lookup happens to also match orphan by normalized
  const updatedId = upsertBeer(db, {
    untappd_id: 42, name: 'Foo Renamed', brewery: 'Bar',
    style: null, abv: null, rating_global: 4.0,
    normalized_name: 'foo extra', normalized_brewery: 'bar',
  });
  expect(updatedId).toBe(canonId);
  const orphan = db.prepare('SELECT name FROM beers WHERE id = ?').get(orphanId) as { name: string };
  expect(orphan.name).toBe('Foo'); // orphan untouched
});

// ---------------------------------------------------------------------------
// PR-D1 helpers below
// ---------------------------------------------------------------------------

import {
  getBeer,
  recordLookupSuccess,
  recordLookupNotFound,
  recordLookupTransient,
} from './beers';

describe('getBeer', () => {
  test('returns full row including new lookup_at + lookup_count columns', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    const row = getBeer(db, id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.untappd_id).toBeNull();
    expect(row?.untappd_lookup_at).toBeNull();
    expect(row?.untappd_lookup_count).toBe(0);
  });

  test('returns null when beer does not exist', () => {
    expect(getBeer(fresh(), 9999)).toBeNull();
  });
});

describe('recordLookupSuccess', () => {
  test('sets untappd_id, style, abv, rating_global from SearchResult', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, style: 'IPA', abv: 6.5, global_rating: 3.98,
    });
    const row = getBeer(db, id);
    expect(row?.untappd_id).toBe(5001);
    expect(row?.style).toBe('IPA');
    expect(row?.abv).toBeCloseTo(6.5);
    expect(row?.rating_global).toBeCloseTo(3.98);
  });

  test('NULL rating_global does NOT overwrite existing non-null rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: 'Lager', abv: 5.0, rating_global: 3.5,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, style: 'IPA', abv: 6.5, global_rating: null,
    });
    const row = getBeer(db, id);
    expect(row?.rating_global).toBeCloseTo(3.5);    // preserved
    expect(row?.untappd_id).toBe(5001);             // set
    expect(row?.style).toBe('IPA');                  // overwritten
  });

  test('NULL abv does NOT overwrite existing non-null abv', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: 4.6, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, style: null, abv: null, global_rating: 3.5,
    });
    const row = getBeer(db, id);
    expect(row?.abv).toBeCloseTo(4.6);    // preserved
  });
});

describe('recordLookupNotFound', () => {
  test('increments count + sets lookup_at', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupNotFound(db, id, '2026-05-26T12:00:00Z');
    let row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00Z');
    expect(row?.untappd_lookup_count).toBe(1);

    recordLookupNotFound(db, id, '2026-05-27T12:00:00Z');
    row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-27T12:00:00Z');
    expect(row?.untappd_lookup_count).toBe(2);
  });
});

describe('recordLookupTransient', () => {
  test('updates lookup_at but does NOT increment count', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupTransient(db, id, '2026-05-26T12:00:00Z');
    let row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T12:00:00Z');
    expect(row?.untappd_lookup_count).toBe(0);

    recordLookupTransient(db, id, '2026-05-26T13:00:00Z');
    row = getBeer(db, id);
    expect(row?.untappd_lookup_at).toBe('2026-05-26T13:00:00Z');
    expect(row?.untappd_lookup_count).toBe(0);
  });
});

import { upsertPub } from './pubs';
import { createSnapshot, insertTaps } from './snapshots';
import { upsertMatch } from './match_links';
import { listLookupCandidates } from './beers';

describe('listLookupCandidates', () => {
  function seedBeerOnTap(
    db: ReturnType<typeof fresh>,
    opts: { brewery: string; name: string; untappdId?: number | null;
            lookupAt?: string | null; lookupCount?: number },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: opts.untappdId ?? null,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null, rating_global: null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    if (opts.lookupAt !== undefined || opts.lookupCount !== undefined) {
      db.prepare(
        'UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = ? WHERE id = ?',
      ).run(opts.lookupAt ?? null, opts.lookupCount ?? 0, beerId);
    }
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
    const ref = `${opts.brewery} ${opts.name}`;
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: ref, brewery_ref: opts.brewery,
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    return beerId;
  }

  test('returns orphan beers currently on tap, omits beers with untappd_id', () => {
    const db = fresh();
    const orphan = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
    seedBeerOnTap(db, { brewery: 'Pinta', name: 'Atak', untappdId: 12345 });

    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    const ids = out.map((c) => c.id);
    expect(ids).toContain(orphan);
    expect(ids.length).toBe(1);
  });

  test('omits orphans not on any current tap', () => {
    const db = fresh();
    upsertBeer(db, {
      name: 'Ghost', brewery: 'Old', style: null, abv: null, rating_global: null,
      normalized_name: 'ghost', normalized_brewery: 'old',
    });
    const now = new Date('2026-05-26T12:00:00Z');
    expect(listLookupCandidates(db, 10, now)).toEqual([]);
  });

  test('respects backoff: not eligible when lookup_at + delay > now', () => {
    const db = fresh();
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine',
      lookupAt: '2026-05-26T11:00:00Z', lookupCount: 1,
    });
    const now = new Date('2026-05-26T12:00:00Z');
    expect(listLookupCandidates(db, 10, now)).toEqual([]);
  });

  test('backoff-eligible orphan IS returned', () => {
    const db = fresh();
    const id = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine',
      lookupAt: '2026-05-25T11:00:00Z', lookupCount: 1,
    });
    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('applies the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedBeerOnTap(db, { brewery: `Brew ${i}`, name: `Beer ${i}` });
    }
    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 2, now);
    expect(out.length).toBe(2);
  });

  test('returned shape carries brewery and name (raw, not normalized)', () => {
    const db = fresh();
    seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine & Passionfruit' });
    const now = new Date('2026-05-26T12:00:00Z');
    const [c] = listLookupCandidates(db, 10, now);
    expect(c.brewery).toBe('Magic Road');
    expect(c.name).toBe('Clementine & Passionfruit');
    expect(c.untappd_lookup_at).toBeNull();
    expect(c.untappd_lookup_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR-D3 helpers — rating-refresh
// ---------------------------------------------------------------------------

import {
  recordRatingSuccess,
  recordRatingNotFound,
  recordRatingTransient,
  listRatingRefreshCandidates,
} from './beers';

describe('recordRatingSuccess', () => {
  test('sets rating_global from the parsed beer-page rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 6645513,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingSuccess(db, id, 3.98);
    const row = getBeer(db, id);
    expect(row?.rating_global).toBeCloseTo(3.98);
    expect(row?.rating_refresh_count).toBe(0);     // success doesn't increment
  });

  test('overwrites a stale existing rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 100,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: 3.5,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingSuccess(db, id, 3.9);
    expect(getBeer(db, id)?.rating_global).toBeCloseTo(3.9);
  });
});

describe('recordRatingNotFound', () => {
  test('increments count + sets refresh_at', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 100,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingNotFound(db, id, '2026-05-27T12:00:00Z');
    let row = getBeer(db, id);
    expect(row?.rating_refresh_at).toBe('2026-05-27T12:00:00Z');
    expect(row?.rating_refresh_count).toBe(1);

    recordRatingNotFound(db, id, '2026-05-28T12:00:00Z');
    row = getBeer(db, id);
    expect(row?.rating_refresh_at).toBe('2026-05-28T12:00:00Z');
    expect(row?.rating_refresh_count).toBe(2);
  });
});

describe('recordRatingTransient', () => {
  test('updates refresh_at but does NOT increment count', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 100,
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordRatingTransient(db, id, '2026-05-27T12:00:00Z');
    expect(getBeer(db, id)?.rating_refresh_count).toBe(0);
    expect(getBeer(db, id)?.rating_refresh_at).toBe('2026-05-27T12:00:00Z');
  });
});

describe('listRatingRefreshCandidates', () => {
  function seedBeerOnTap(
    db: ReturnType<typeof fresh>,
    opts: {
      brewery: string; name: string;
      untappdId: number;
      ratingGlobal?: number | null;
      refreshAt?: string | null;
      refreshCount?: number;
    },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: opts.untappdId,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null,
      rating_global: opts.ratingGlobal ?? null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    if (opts.refreshAt !== undefined || opts.refreshCount !== undefined) {
      db.prepare(
        'UPDATE beers SET rating_refresh_at = ?, rating_refresh_count = ? WHERE id = ?',
      ).run(opts.refreshAt ?? null, opts.refreshCount ?? 0, beerId);
    }
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
    const ref = `${opts.brewery} ${opts.name}`;
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: ref, brewery_ref: opts.brewery,
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    return beerId;
  }

  test('returns beers with untappd_id AND rating_global IS NULL on a current tap', () => {
    const db = fresh();
    const candidate = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
    });
    // Has rating already — must be excluded.
    seedBeerOnTap(db, {
      brewery: 'Pinta', name: 'Atak', untappdId: 12345, ratingGlobal: 3.9,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    const out = listRatingRefreshCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([candidate]);
    expect(out[0].untappd_id).toBe(6645513);
  });

  test('omits orphan beers (untappd_id NULL — those are PR-D2 territory)', () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: null, abv: null, rating_global: null,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    const pubId = upsertPub(db, {
      slug: 'p', name: 'P', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
    upsertMatch(db, 'X', beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: 'X', brewery_ref: 'Y',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('omits beers not on any current tap', () => {
    const db = fresh();
    upsertBeer(db, {
      untappd_id: 100,
      name: 'Ghost', brewery: 'Old', style: null, abv: null, rating_global: null,
      normalized_name: 'ghost', normalized_brewery: 'old',
    });
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('respects backoff via shared lookup-backoff isEligible', () => {
    const db = fresh();
    // count=1 → 24h delay. Last refresh 1h ago → not eligible.
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
      refreshAt: '2026-05-27T11:00:00Z', refreshCount: 1,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('returns backoff-eligible beer 25h after last refresh attempt', () => {
    const db = fresh();
    const id = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
      refreshAt: '2026-05-26T11:00:00Z', refreshCount: 1,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    const out = listRatingRefreshCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('applies the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedBeerOnTap(db, {
        brewery: `Brew${i}`, name: `Beer${i}`, untappdId: 1000 + i,
      });
    }
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 2, now).length).toBe(2);
  });

  test('returned shape carries untappd_id for the cron to use as URL input', () => {
    const db = fresh();
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    const [c] = listRatingRefreshCandidates(db, 10, now);
    expect(c).toEqual(expect.objectContaining({
      id: expect.any(Number),
      untappd_id: 6645513,
      rating_refresh_at: null,
      rating_refresh_count: 0,
    }));
  });
});
