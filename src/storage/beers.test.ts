import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeer, findBeerByNormalized, loadCatalog, readWebTriedAt, stampWebTried } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';

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
  mergeIntoCanonical,
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
    }, '2026-06-28T10:00:00.000Z');
    const row = getBeer(db, id);
    expect(row?.untappd_id).toBe(5001);
    expect(row?.style).toBe('IPA');
    expect(row?.abv).toBeCloseTo(6.5);
    expect(row?.rating_global).toBeCloseTo(3.98);
    expect(row?.untappd_lookup_at).toBe('2026-06-28T10:00:00.000Z');
  });

  test('NULL rating_global does NOT overwrite existing non-null rating', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', style: 'Lager', abv: 5.0, rating_global: 3.5,
      normalized_name: 'x', normalized_brewery: 'y',
    });
    recordLookupSuccess(db, id, {
      bid: 5001, style: 'IPA', abv: 6.5, global_rating: null,
    }, '2026-06-28T10:00:00.000Z');
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
    }, '2026-06-28T10:00:00.000Z');
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
import { recordEnrichFailure, setEnrichFailureReview } from './enrich_failures';
import { listLookupCandidates, listRelayLookupCandidates } from './beers';

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
      address: null, lat: null, lon: null, city: 'warszawa',
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
    // count=1 → 72h delay; 73h ago is past due.
    const id = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine',
      lookupAt: '2026-05-23T11:00:00Z', lookupCount: 1,
    });
    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('excludes orphans triaged as wontfix', () => {
    const db = fresh();
    const wontfix = seedBeerOnTap(db, { brewery: 'Hopeless', name: 'Never' });
    const live = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
    recordEnrichFailure(db, {
      beer_id: wontfix, brewery: 'Hopeless', name: 'Never',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, wontfix, 'wontfix', null, '2026-05-26T11:30:00Z');

    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([live]);
  });

  test('excludes retired orphans (retired_at set)', () => {
    const db = fresh();
    const retired = seedBeerOnTap(db, { brewery: 'VINO KARPATIA', name: 'Bialy bez' });
    const live = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
    recordEnrichFailure(db, {
      beer_id: retired, brewery: 'VINO KARPATIA', name: 'Bialy bez',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, retired, 'parser_bug', 'wine', '2026-05-26T11:30:00Z');
    db.prepare('UPDATE enrich_failures SET retired_at = ? WHERE beer_id = ?')
      .run('2026-05-26T11:45:00Z', retired);
    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([live]);
  });

  test('keeps orphans triaged with a non-wontfix class (e.g. matcher_bug)', () => {
    const db = fresh();
    const matcherBug = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
    recordEnrichFailure(db, {
      beer_id: matcherBug, brewery: 'Magic Road', name: 'Clementine',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 1, candidates_summary: 'x — y', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, matcherBug, 'matcher_bug', null, '2026-05-26T11:30:00Z');

    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id)).toEqual([matcherBug]);
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

describe('listRelayLookupCandidates', () => {
  // Relay-orphan: рядок у `beers` БЕЗ жодного рядка в `match_links`. Саме такі
  // мінтить `/enrich/candidates` через ensureBeerRow для кожної картки крамниці.
  function seedRelayOrphan(
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
    return beerId;
  }

  // Той самий on-tap сид, що й у listLookupCandidates: beers + pub + snapshot +
  // match_links + taps. Потрібен, щоб довести диз'юнктність пулів.
  function seedBeerOnTapLocal(
    db: ReturnType<typeof fresh>,
    opts: { brewery: string; name: string },
  ): number {
    const beerId = upsertBeer(db, {
      untappd_id: null,
      name: opts.name, brewery: opts.brewery,
      style: null, abv: null, rating_global: null,
      normalized_name: opts.name.toLowerCase(),
      normalized_brewery: opts.brewery.toLowerCase(),
    });
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null, city: 'warszawa',
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

  const NOW = new Date('2026-05-26T12:00:00Z');

  test('returns an orphan that has no match_links row at all', () => {
    const db = fresh();
    const id = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'All the Creamy Cows' });
    const out = listRelayLookupCandidates(db, 10, NOW);
    expect(out.map((c) => c.id)).toEqual([id]);
  });

  test('the two pools are disjoint: an on-tap linked orphan is NOT in the relay pool', () => {
    const db = fresh();
    const onTap = seedBeerOnTapLocal(db, { brewery: 'Magic Road', name: 'Clementine' });
    const relay = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Toasted Delight' });

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([relay]);
    expect(listLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([onTap]);
  });

  test('omits beers already matched (untappd_id set)', () => {
    const db = fresh();
    seedRelayOrphan(db, { brewery: 'Pinta', name: 'Atak', untappdId: 12345 });
    expect(listRelayLookupCandidates(db, 10, NOW)).toEqual([]);
  });

  test('excludes orphans triaged as wontfix', () => {
    const db = fresh();
    const wontfix = seedRelayOrphan(db, { brewery: 'Stoelzle', name: 'Kelih Fino 545' });
    const live = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Barrel Pie' });
    recordEnrichFailure(db, {
      beer_id: wontfix, brewery: 'Stoelzle', name: 'Kelih Fino 545',
      search_url: '', source_url: 'https://winetime.com.ua/x', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, wontfix, 'wontfix', null, '2026-05-26T11:30:00Z');

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([live]);
  });

  test('excludes retired orphans (retired_at set)', () => {
    const db = fresh();
    const retired = seedRelayOrphan(db, { brewery: 'VINO KARPATIA', name: 'Bialy bez' });
    const live = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Barrel Pie' });
    recordEnrichFailure(db, {
      beer_id: retired, brewery: 'VINO KARPATIA', name: 'Bialy bez',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, retired, 'parser_bug', 'wine', '2026-05-26T11:30:00Z');
    db.prepare('UPDATE enrich_failures SET retired_at = ? WHERE beer_id = ?')
      .run('2026-05-26T11:45:00Z', retired);

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([live]);
  });

  test('keeps orphans triaged with a non-wontfix class (e.g. matcher_bug re-armed by rearm-*)', () => {
    const db = fresh();
    const matcherBug = seedRelayOrphan(db, { brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny' });
    recordEnrichFailure(db, {
      beer_id: matcherBug, brewery: 'AleBrowar', name: 'Kwas Chlebowy Jasny',
      search_url: '', source_url: 'https://onemorebeer.pl/x', outcome: 'not_found',
      candidates_count: 1, candidates_summary: 'x — y', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, matcherBug, 'matcher_bug', null, '2026-05-26T11:30:00Z');

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([matcherBug]);
  });

  test('respects backoff: not eligible when lookup_at + delay > now', () => {
    const db = fresh();
    seedRelayOrphan(db, {
      brewery: 'The Bruery', name: 'Barrel Pie',
      lookupAt: '2026-05-26T11:00:00Z', lookupCount: 1,
    });
    expect(listRelayLookupCandidates(db, 10, NOW)).toEqual([]);
  });

  test('backoff-eligible orphan IS returned', () => {
    const db = fresh();
    // count=1 → затримка 72 год; 73 год тому вже прострочено.
    const id = seedRelayOrphan(db, {
      brewery: 'The Bruery', name: 'Barrel Pie',
      lookupAt: '2026-05-23T11:00:00Z', lookupCount: 1,
    });
    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([id]);
  });

  test('orders never-searched (count=0) ahead of already-searched (count=1)', () => {
    const db = fresh();
    const searched = seedRelayOrphan(db, {
      brewery: 'Transient', name: 'Junie',
      lookupAt: '2026-05-23T11:00:00Z', lookupCount: 1,
    });
    const never = seedRelayOrphan(db, { brewery: 'Finback', name: 'Starry Eyed' });

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([never, searched]);
  });

  test('applies the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      seedRelayOrphan(db, { brewery: `Brew ${i}`, name: `Beer ${i}` });
    }
    expect(listRelayLookupCandidates(db, 2, NOW).length).toBe(2);
  });

  test('returned shape carries raw brewery and name plus backoff fields', () => {
    const db = fresh();
    seedRelayOrphan(db, { brewery: 'Magic Road', name: 'Clementine & Passionfruit' });
    const [c] = listRelayLookupCandidates(db, 10, NOW);
    expect(c.brewery).toBe('Magic Road');
    expect(c.name).toBe('Clementine & Passionfruit');
    expect(c.untappd_lookup_at).toBeNull();
    expect(c.untappd_lookup_count).toBe(0);
  });

  test('an orphan with a link that fell off the latest snapshot is in NEITHER pool (the on-tap gate, #368)', () => {
    const db = fresh();
    const beerId = seedBeerOnTapLocal(db, { brewery: 'Magic Road', name: 'Clementine' });

    // Sanity: the beer really has a match_links row. Otherwise it would
    // trivially land in the relay pool (NOT EXISTS match_links) and this
    // test would pass for the wrong reason.
    const linked = db
      .prepare('SELECT 1 FROM match_links WHERE untappd_beer_id = ?')
      .get(beerId);
    expect(linked).toBeTruthy();

    // Pub's tap list changes: a NEWER snapshot for the same pub that does
    // NOT include this beer's tap — exactly what happens in production
    // when a pub rotates its taps. seedBeerOnTapLocal's own snapshot
    // (2026-05-26T12:00:00Z) is now no longer the latest for this pub, so
    // the beer's match_links row no longer joins to a current tap.
    const pubId = upsertPub(db, {
      slug: `pub-${beerId}`, name: `Pub ${beerId}`,
      address: null, lat: null, lon: null, city: 'warszawa',
    });
    const newerSnapId = createSnapshot(db, pubId, '2026-05-27T12:00:00Z');
    insertTaps(db, newerSnapId, [{
      tap_number: 1, beer_ref: 'Someone Else Entirely', brewery_ref: 'Someone Else',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    expect(listLookupCandidates(db, 10, NOW)).toEqual([]);
    expect(listRelayLookupCandidates(db, 10, NOW)).toEqual([]);
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
      address: null, lat: null, lon: null, city: 'warszawa',
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
      slug: 'p', name: 'P', address: null, lat: null, lon: null, city: 'warszawa',
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
    // count=1 → 72h delay. Last refresh 1h ago → not eligible.
    seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
      refreshAt: '2026-05-27T11:00:00Z', refreshCount: 1,
    });
    const now = new Date('2026-05-27T12:00:00Z');
    expect(listRatingRefreshCandidates(db, 10, now)).toEqual([]);
  });

  test('returns backoff-eligible beer 73h after last refresh attempt', () => {
    const db = fresh();
    // count=1 → 72h delay; 73h ago is past due.
    const id = seedBeerOnTap(db, {
      brewery: 'Magic Road', name: 'Clementine', untappdId: 6645513,
      refreshAt: '2026-05-24T11:00:00Z', refreshCount: 1,
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

describe('loadCatalog', () => {
  it('returns id, brewery, name, abv, rating_global for every beer', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = upsertBeer(db, {
      untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
      style: 'IPA', abv: 6.0, rating_global: 3.85,
      normalized_name: normalizeName('Pan IPAni'),
      normalized_brewery: normalizeBrewery('Trzech Kumpli'),
    });
    const cat = loadCatalog(db);
    expect(cat).toContainEqual({
      id, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85,
      untappd_id: 9001,
    });
  });
});

describe('web_tried_at', () => {
  it('is null until stamped, then reads back the stamp', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = upsertBeer(db, {
      name: 'X', brewery: 'Y', normalized_name: 'x', normalized_brewery: 'y',
    });
    expect(readWebTriedAt(db, id)).toBeNull();
    stampWebTried(db, id, '2026-07-24T10:00:00.000Z');
    expect(readWebTriedAt(db, id)).toBe('2026-07-24T10:00:00.000Z');
    db.close();
  });
});

function mergeFixture() {
  const db = fresh();
  const canonicalId = upsertBeer(db, {
    untappd_id: 999, name: 'Marine', brewery: 'Moon Lark Brewery',
    style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
  });
  const orphanId = upsertBeer(db, {
    name: 'Deep Sea Diver', brewery: 'Moon Lark Brewery',
    style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Deep Sea Diver'),
    normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
  });
  db.prepare(
    "INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user) VALUES ('Deep Sea Diver', ?, 1.0, 0)",
  ).run(orphanId);
  return { db, canonicalId, orphanId };
}

test('mergeIntoCanonical redirects the link and stamps it as merge-established', () => {
  const { db, canonicalId, orphanId } = mergeFixture();

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-07-30T10:00:00Z');

  const link = db.prepare('SELECT untappd_beer_id, merged_at FROM match_links WHERE ontap_ref = ?')
    .get('Deep Sea Diver') as { untappd_beer_id: number; merged_at: string | null };
  expect(link.untappd_beer_id).toBe(canonicalId);
  expect(link.merged_at).toBe('2026-07-30T10:00:00Z');
  expect(getBeer(db, orphanId)).toBeNull();
});

test('mergeIntoCanonical redirects a fuzzy satellite link without making it durable', () => {
  const { db, canonicalId, orphanId } = mergeFixture();
  // A second tap text the matcher merely guessed onto the orphan (confidence < 1). The lookup
  // that produced the merge never saw this text, so it must keep re-orphaning on its own.
  db.prepare(
    "INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user) VALUES ('Deep Sea Diver Nitro', ?, 0.87, 0)",
  ).run(orphanId);

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-07-30T10:00:00Z');

  const fuzzy = db.prepare('SELECT untappd_beer_id, merged_at FROM match_links WHERE ontap_ref = ?')
    .get('Deep Sea Diver Nitro') as { untappd_beer_id: number; merged_at: string | null };
  expect(fuzzy.untappd_beer_id).toBe(canonicalId);   // still redirected, as before
  expect(fuzzy.merged_at).toBeNull();                // but not remembered
});

test('mergeIntoCanonical redirects check-ins instead of FK-crashing on the delete', () => {
  const { db, canonicalId, orphanId } = mergeFixture();
  db.prepare(
    "INSERT INTO checkins (checkin_id, telegram_id, beer_id, checkin_at) VALUES ('c1', 42, ?, '2026-07-30T09:00:00Z')",
  ).run(orphanId);

  expect(() => mergeIntoCanonical(db, orphanId, canonicalId, '2026-07-30T10:00:00Z')).not.toThrow();

  const checkin = db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?').get('c1') as { beer_id: number };
  expect(checkin.beer_id).toBe(canonicalId);
  expect(getBeer(db, orphanId)).toBeNull();
});

// --- #369: relayed shop facts (abv/style) -----------------------------------
import { sanitizeAbv, fillOrphanFacts, rearmLookup, getBeer as getBeerRow } from './beers';
import { catalogVersion } from './catalog-version';

describe('sanitizeAbv', () => {
  test('keeps 0 — 0.0% is a real, load-bearing ABV (#322 Kwas Chlebowy Bright)', () => {
    expect(sanitizeAbv(0)).toBe(0);
  });

  test('keeps ordinary and high-but-real values', () => {
    expect(sanitizeAbv(4.8)).toBe(4.8);
    expect(sanitizeAbv(67.5)).toBe(67.5); // freeze-distilled beers exist
  });

  test('drops undefined, non-finite and out-of-range values', () => {
    expect(sanitizeAbv(undefined)).toBeUndefined();
    expect(sanitizeAbv(NaN)).toBeUndefined();
    expect(sanitizeAbv(Infinity)).toBeUndefined();
    expect(sanitizeAbv(-1)).toBeUndefined();
    expect(sanitizeAbv(101)).toBeUndefined();
  });
});

function orphanRow(db: ReturnType<typeof openDb>, over: { abv?: number | null; style?: string | null } = {}) {
  return upsertBeer(db, {
    untappd_id: null, name: 'Kwas Chlebowy Jasny', brewery: 'AleBrowar',
    style: over.style ?? null, abv: over.abv ?? null, rating_global: null,
    normalized_name: 'kwas chlebowy jasny', normalized_brewery: 'alebrowar',
  });
}

describe('fillOrphanFacts', () => {
  test('fills NULL abv and style on an orphan and reports the ABV gain', () => {
    const db = fresh();
    const id = orphanRow(db);
    expect(fillOrphanFacts(db, id, { abv: 0, style: 'Kwas Chlebowy' }))
      .toEqual({ abvGained: true, changed: true });
    const row = getBeerRow(db, id)!;
    expect(row.abv).toBe(0); // 0, not null — the #322 case
    expect(row.style).toBe('Kwas Chlebowy');
  });

  test('never overwrites a value that is already set', () => {
    const db = fresh();
    const id = orphanRow(db, { abv: 5.5, style: 'IPA' });
    expect(fillOrphanFacts(db, id, { abv: 0, style: 'Kwas Chlebowy' }))
      .toEqual({ abvGained: false, changed: false });
    const row = getBeerRow(db, id)!;
    expect(row.abv).toBe(5.5);
    expect(row.style).toBe('IPA');
  });

  test('leaves matched rows untouched', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 5489374, name: 'Kwas Chlebowy Bright', brewery: 'AleBrowar',
      style: null, abv: null, rating_global: null,
      normalized_name: 'kwas chlebowy bright', normalized_brewery: 'alebrowar',
    });
    expect(fillOrphanFacts(db, id, { abv: 0, style: 'Kwas Chlebowy' }))
      .toEqual({ abvGained: false, changed: false });
    const row = getBeerRow(db, id)!;
    expect(row.abv).toBeNull();
    expect(row.style).toBeNull();
  });

  test('reports a style-only fill as changed but NOT an ABV gain', () => {
    const db = fresh();
    const id = orphanRow(db, { abv: 4.8 });
    expect(fillOrphanFacts(db, id, { style: 'IPA' })).toEqual({ abvGained: false, changed: true });
    expect(getBeerRow(db, id)!.style).toBe('IPA');
  });

  test('drops an out-of-range abv rather than writing it', () => {
    const db = fresh();
    const id = orphanRow(db);
    expect(fillOrphanFacts(db, id, { abv: 9999 })).toEqual({ abvGained: false, changed: false });
    expect(getBeerRow(db, id)!.abv).toBeNull();
  });

  test('bumps the catalog version when it writes and not when it does not', () => {
    const db = fresh();
    const id = orphanRow(db);
    const before = catalogVersion();
    fillOrphanFacts(db, id, { abv: 4.8 });
    const afterWrite = catalogVersion();
    expect(afterWrite).toBeGreaterThan(before);
    fillOrphanFacts(db, id, { abv: 4.8 }); // already set → no-op
    expect(catalogVersion()).toBe(afterWrite);
  });

  test('does nothing when there are no facts to apply', () => {
    const db = fresh();
    expect(fillOrphanFacts(db, orphanRow(db), {})).toEqual({ abvGained: false, changed: false });
  });
});

describe('rearmLookup', () => {
  test('clears the backoff so an orphan is retried at once', () => {
    const db = fresh();
    const id = orphanRow(db);
    db.prepare('UPDATE beers SET untappd_lookup_at = ?, untappd_lookup_count = 4 WHERE id = ?')
      .run('2026-07-31T10:00:00Z', id);
    rearmLookup(db, id);
    const row = getBeerRow(db, id)!;
    expect(row.untappd_lookup_at).toBeNull();
    expect(row.untappd_lookup_count).toBe(0);
  });
});
