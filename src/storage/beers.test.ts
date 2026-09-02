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
import { recordEnrichFailure, setEnrichFailureReview, markUnrescued } from './enrich_failures';
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

  // #377 part B: not_a_beer is the ONLY class that leaves the pool. Adding
  // 'unidentifiable' back into the exclusion clause in listLookupCandidates turns
  // this red — and that clause is the whole of the change.
  test('excludes only not_a_beer; an unidentifiable orphan stays in the on-tap pool', () => {
    const db = fresh();
    const notABeer = seedBeerOnTap(db, { brewery: 'Beer Republic', name: 'Surprise Box XL (36)' });
    const unidentifiable = seedBeerOnTap(db, { brewery: 'MGM-15', name: 'MGM-15' });
    const live = seedBeerOnTap(db, { brewery: 'Magic Road', name: 'Clementine' });
    for (const [id, brewery, name] of [
      [notABeer, 'Beer Republic', 'Surprise Box XL (36)'],
      [unidentifiable, 'MGM-15', 'MGM-15'],
    ] as const) {
      recordEnrichFailure(db, {
        beer_id: id, brewery, name,
        search_url: '', source_url: '', outcome: 'not_found',
        candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
      });
    }
    setEnrichFailureReview(db, notABeer, 'not_a_beer', null, '2026-05-26T11:30:00Z');
    setEnrichFailureReview(db, unidentifiable, 'unidentifiable', null, '2026-05-26T11:30:00Z');

    const now = new Date('2026-05-26T12:00:00Z');
    const out = listLookupCandidates(db, 10, now);
    expect(out.map((c) => c.id).sort()).toEqual([unidentifiable, live].sort());
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

  test('keeps orphans triaged with a non-terminal class (e.g. matcher_bug)', () => {
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

  // #421. A verdict naming an unfixed bug is a settled question: while the issue is open
  // the answer cannot move, so re-asking Untappd spends quota on nothing AND burns the
  // row's four backoff attempts before its fix ships.
  //
  // Seeds a failure row and a verdict in one step — the shape every locked row has.
  function seedVerdict(
    db: ReturnType<typeof fresh>,
    beerId: number,
    cls: 'matcher_bug' | 'parser_bug' | 'not_on_untappd' | 'unidentifiable',
    issueNumber: number | null,
  ): void {
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: 'b', name: 'n',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 3, candidates_summary: '', at: '2026-05-26T11:00:00Z',
    });
    // `not_on_untappd` is refused unless absence was actually proved by a probe (#408), so
    // seeding it without this flag silently leaves review_class NULL and every assertion
    // about that class passes vacuously. Asserted, not assumed, below.
    const result = setEnrichFailureReview(
      db, beerId, cls, 'note', '2026-05-26T11:30:00Z', issueNumber,
      { absenceProved: cls === 'not_on_untappd' },
    );
    if (result !== 'written') throw new Error(`seedVerdict refused: ${result}`);
  }

  // Red if `AND NOT ${lockedRowPredicate}` is dropped from listLookupCandidates.
  test('holds a locked row out of the on-tap pool until it is unlocked', () => {
    const db = fresh();
    const locked = seedBeerOnTap(db, { brewery: 'Mad Brew', name: 'Bitter Cost' });
    seedVerdict(db, locked, 'matcher_bug', 347);
    const now = new Date('2026-05-26T12:00:00Z');

    expect(listLookupCandidates(db, 10, now).map((c) => c.id)).not.toContain(locked);

    db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?')
      .run('2026-05-26T11:45:00Z', locked);

    expect(listLookupCandidates(db, 10, now).map((c) => c.id)).toContain(locked);
  });

  // Red if the predicate keys off the class alone. A verdict with no issue names no fix,
  // so nothing could ever unlock it — locking it would be a permanent seal, which is the
  // whole defect #377 spent a design removing.
  test('does not lock an actionable row that carries no issue_number', () => {
    const db = fresh();
    const legacy = seedBeerOnTap(db, { brewery: 'Mad Brew', name: 'Legacy Row' });
    seedVerdict(db, legacy, 'matcher_bug', null);

    expect(listLookupCandidates(db, 10, new Date('2026-05-26T12:00:00Z')).map((c) => c.id))
      .toContain(legacy);
  });

  // Red if the predicate widens past the two actionable classes. not_on_untappd and
  // unidentifiable name no fix owner: the first waits on Untappd's catalogue, the second
  // on our own resolving power. Neither is settled by an issue closing.
  test('does not lock not_on_untappd or unidentifiable rows', () => {
    const db = fresh();
    const absent = seedBeerOnTap(db, { brewery: 'Hoppy Hog', name: 'Charred Memory' });
    const garbled = seedBeerOnTap(db, { brewery: 'MGM-15', name: 'MGM-15' });
    seedVerdict(db, absent, 'not_on_untappd', 405);
    seedVerdict(db, garbled, 'unidentifiable', 405);

    const ids = listLookupCandidates(db, 10, new Date('2026-05-26T12:00:00Z')).map((c) => c.id);
    expect(ids).toContain(absent);
    expect(ids).toContain(garbled);
  });

  // #421. Red if the pool stops passing review_class into isEligible: the 24 not_on_untappd
  // rows sitting one miss from exhaustion today would go dormant forever, contradicting the
  // only justification that class has ("Untappd grows").
  test('keeps an exhausted not_on_untappd row in the pool once the last delay has passed', () => {
    const db = fresh();
    const absent = seedBeerOnTap(db, {
      brewery: 'Hoppy Hog', name: 'Charred Memory',
      lookupAt: '2026-06-01T00:00:00Z', lookupCount: 5,
    });
    seedVerdict(db, absent, 'not_on_untappd', null);

    expect(listLookupCandidates(db, 10, new Date('2026-07-05T00:00:00Z')).map((c) => c.id))
      .toContain(absent);
  });

  // Red if the recurring flag leaks to every class instead of being read per row.
  test('leaves an exhausted unidentifiable row dormant', () => {
    const db = fresh();
    const garbled = seedBeerOnTap(db, {
      brewery: 'MGM-15', name: 'MGM-15',
      lookupAt: '2026-06-01T00:00:00Z', lookupCount: 5,
    });
    seedVerdict(db, garbled, 'unidentifiable', null);

    expect(listLookupCandidates(db, 10, new Date('2026-07-05T00:00:00Z')).map((c) => c.id))
      .not.toContain(garbled);
  });

  // Red if the pool stops selecting review_class. Task 4 picks the backoff schedule from
  // it, and a column absent from the SELECT fails silently as `undefined`.
  test('returned shape carries review_class', () => {
    const db = fresh();
    const id = seedBeerOnTap(db, { brewery: 'Hoppy Hog', name: 'Charred Memory' });
    seedVerdict(db, id, 'not_on_untappd', null);

    const [c] = listLookupCandidates(db, 10, new Date('2026-05-26T12:00:00Z'));
    expect(c.review_class).toBe('not_on_untappd');
  });

  // #486: the gap between the two pools, reduced to one row. The beer was on a tap once,
  // that snapshot is no longer the pub's latest, and the `match_links` row outlives it.
  // Before the fix it is in NEITHER pool: the on-tap join wants a latest-snapshot tap and
  // the relay predicate wants no link at all. spec.md called this deliberate; #486 measured
  // 462 of 911 live orphans sitting in it, 376 never queried once.
  test('#486: a beer whose tap left the latest snapshot is in exactly one pool', () => {
    const db = fresh();
    const beerId = upsertBeer(db, {
      untappd_id: null, name: 'Dunkelweizen', brewery: 'Weihenstephaner',
      style: null, abv: null, rating_global: null,
      normalized_name: 'dunkelweizen', normalized_brewery: 'weihenstephaner',
    });
    const pubId = upsertPub(db, {
      slug: 'pub-486', name: 'Pub 486', address: null, lat: null, lon: null, city: 'warszawa',
    });
    const ref = 'Weihenstephaner Dunkelweizen';

    // The beer was poured on an older snapshot...
    const oldSnap = createSnapshot(db, pubId, '2026-05-01T12:00:00Z');
    upsertMatch(db, ref, beerId, 1.0);
    insertTaps(db, oldSnap, [{
      tap_number: 1, beer_ref: ref, brewery_ref: 'Weihenstephaner',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);
    // ...and the pub's LATEST snapshot pours something else.
    const newSnap = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');
    insertTaps(db, newSnap, [{
      tap_number: 1, beer_ref: 'Something Else', brewery_ref: 'Other',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    const now = new Date('2026-05-26T12:00:00Z');
    const onTap = listLookupCandidates(db, 10, now).map((c) => c.id);
    const relay = listRelayLookupCandidates(db, 10, now).map((c) => c.id);

    expect(onTap).not.toContain(beerId);   // correct: nobody is pouring it
    expect(relay).toContain(beerId);       // the point of #486: relay is the complement
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

  // The relay pool is where 51 of the 75 sealed rows actually sit, so this is the
  // clause that does the work in production. Restoring 'unidentifiable' to the
  // exclusion in orphanNotOnTapPredicate turns this red.
  test('excludes only not_a_beer; an unidentifiable orphan stays in the relay pool', () => {
    const db = fresh();
    const notABeer = seedRelayOrphan(db, { brewery: 'Stoelzle', name: 'Kelih Fino 545' });
    const unidentifiable = seedRelayOrphan(db, { brewery: '', name: 'N/A' });
    const live = seedRelayOrphan(db, { brewery: 'The Bruery', name: 'Barrel Pie' });
    for (const [id, brewery, name] of [
      [notABeer, 'Stoelzle', 'Kelih Fino 545'],
      [unidentifiable, '', 'N/A'],
    ] as const) {
      recordEnrichFailure(db, {
        beer_id: id, brewery, name,
        search_url: '', source_url: 'https://winetime.com.ua/x', outcome: 'not_found',
        candidates_count: 0, candidates_summary: '', at: '2026-05-26T11:00:00Z',
      });
    }
    setEnrichFailureReview(db, notABeer, 'not_a_beer', null, '2026-05-26T11:30:00Z');
    setEnrichFailureReview(db, unidentifiable, 'unidentifiable', null, '2026-05-26T11:30:00Z');

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id).sort())
      .toEqual([unidentifiable, live].sort());
  });

  // The mechanism part B exists to unlock. recordEnrichFailure already clears the
  // verdict when candidates_count crosses 0 <-> >0, but under the old `wontfix`
  // exclusion the row never reached a lookup, so this transition could not occur at
  // all. Re-adding 'unidentifiable' to the exclusion does not turn this red directly —
  // it makes the row unreachable, which the two pool tests above catch.
  test('a re-observed unidentifiable orphan loses its verdict when candidates appear', () => {
    const db = fresh();
    const id = seedRelayOrphan(db, { brewery: 'Krusnohor Brewery', name: 'Jedenactka' });
    const failure = {
      beer_id: id, brewery: 'Krusnohor Brewery', name: 'Jedenactka',
      search_url: '', source_url: 'https://flasker.pl/x', outcome: 'not_found' as const,
      candidates_summary: '', at: '2026-05-26T11:00:00Z',
    };
    recordEnrichFailure(db, { ...failure, candidates_count: 0 });
    setEnrichFailureReview(db, id, 'unidentifiable', 'cannot tell which beer', '2026-05-26T11:30:00Z');

    recordEnrichFailure(db, { ...failure, candidates_count: 3, at: '2026-06-01T11:00:00Z' });

    const row = db
      .prepare('SELECT review_class AS c, reviewed_at AS r FROM enrich_failures WHERE beer_id = ?')
      .get(id) as { c: string | null; r: string | null };
    expect(row.c).toBeNull();
    expect(row.r).toBeNull();
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

  test('keeps orphans triaged with a non-terminal class (e.g. matcher_bug re-armed by rearm-*)', () => {
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

  // #421. Red if `AND NOT ${lockedRowPredicate}` is dropped from the relay pool's query.
  // Both pools share the lock and it is easy to add it to one and believe it covers both;
  // this is the assertion that proves the relay half. Note the row above — the same class,
  // but with NO issue_number — must stay in the pool, so the two tests bracket the rule.
  test('holds a locked row out of the relay pool until it is unlocked', () => {
    const db = fresh();
    const locked = seedRelayOrphan(db, { brewery: 'flasker', name: 'Cyrillic Row' });
    recordEnrichFailure(db, {
      beer_id: locked, brewery: 'flasker', name: 'Cyrillic Row',
      search_url: '', source_url: 'https://flasker.com.ua/x', outcome: 'not_found',
      candidates_count: 2, candidates_summary: 'x — y', at: '2026-05-26T11:00:00Z',
    });
    setEnrichFailureReview(db, locked, 'parser_bug', 'split → #376', '2026-05-26T11:30:00Z', 376);

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).not.toContain(locked);

    db.prepare('UPDATE enrich_failures SET unlocked_at = ? WHERE beer_id = ?')
      .run('2026-05-26T11:45:00Z', locked);

    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toContain(locked);
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

  test('#486: an orphan with a link that fell off the latest snapshot is now caught by the relay pool', () => {
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

    // Before #486 this landed in NEITHER pool (the on-tap gate, #368): the
    // on-tap join wants a latest-snapshot tap and the old relay predicate
    // wanted no match_links row at all. orphanNotOnTapPredicate is now the
    // literal negation of onLatestTapPredicate, so the relay pool catches it.
    expect(listLookupCandidates(db, 10, NOW)).toEqual([]);
    expect(listRelayLookupCandidates(db, 10, NOW).map((c) => c.id)).toEqual([beerId]);
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

// A locked orphan (#421): has a failure row, a review_class that keeps it locked, and an
// owning issue. Asserts the seed write actually landed — a silently no-op'd seed would
// produce a green test that proves nothing (see seedLocked in unlock-fixed-orphans.test.ts).
function orphanWithIssue(db: ReturnType<typeof openDb>, beerId: number, issue: number): void {
  upsertBeer(db, {
    untappd_id: null, name: `n${beerId}`, brewery: `b${beerId}`,
    normalized_name: `n${beerId}`, normalized_brewery: `b${beerId}`,
  });
  recordEnrichFailure(db, {
    beer_id: beerId, brewery: `b${beerId}`, name: `n${beerId}`,
    search_url: 'u', source_url: '', outcome: 'not_found', candidates_count: 0,
    candidates_summary: '', at: '2026-09-01T00:00:00Z',
  });
  const written = setEnrichFailureReview(db, beerId, 'parser_bug', 'note', '2026-09-01T00:00:00Z', issue);
  expect(written).toBe('written');
}

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

  it('clears the unrescued marker — an explicit re-arm is new evidence (#558)', () => {
    const db = fresh();
    orphanWithIssue(db, 1, 558);
    markUnrescued(db, 1, 558, '2026-09-02T10:00:00Z');
    rearmLookup(db, 1);
    const row = db.prepare('SELECT unrescued_at, unrescued_issue FROM enrich_failures WHERE beer_id = 1')
      .get() as { unrescued_at: string | null; unrescued_issue: number | null };
    expect(row.unrescued_at).toBeNull();
    expect(row.unrescued_issue).toBeNull();
  });
});

describe('#384 provenance', () => {
  it('recordLookupSuccess stamps search', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: null, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
    });
    recordLookupSuccess(db, id, { bid: 900, style: null, abv: null, global_rating: null }, '2026-08-09T00:00:00Z');
    const row = db.prepare('SELECT untappd_id, untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id: 900, untappd_id_source: 'search' });
  });

  it('upsertBeer records the source it is given', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 901, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
      untappd_id_source: 'checkin',
    });
    const row = db.prepare('SELECT untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id_source: 'checkin' });
  });

  it('upsertBeer leaves the source alone when not given one', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 902, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
      untappd_id_source: 'checkin',
    });
    upsertBeer(db, {
      untappd_id: 902, name: 'N2', brewery: 'B',
      normalized_name: 'n2', normalized_brewery: 'b',
    });
    const row = db.prepare('SELECT untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id_source: 'checkin' });
  });
});

describe('#486 pool partition', () => {
  // The invariant stated as an assertion instead of a comment: with one predicate and its
  // negation, an orphan cannot fall between the pools however its taps and links are arranged.
  // Every case below is a shape that exists in production.
  test('every eligible orphan is in exactly one pool, across every tap/link arrangement', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'partition', name: 'Partition', address: null, lat: null, lon: null, city: 'warszawa',
    });
    const oldSnap = createSnapshot(db, pubId, '2026-05-01T12:00:00Z');
    const newSnap = createSnapshot(db, pubId, '2026-05-26T12:00:00Z');

    const mk = (name: string): number => upsertBeer(db, {
      untappd_id: null, name, brewery: 'Br', style: null, abv: null, rating_global: null,
      normalized_name: name.toLowerCase(), normalized_brewery: 'br',
    });

    // 1. on a tap on the latest snapshot
    const current = mk('Current');
    upsertMatch(db, 'ref-current', current, 1.0);
    insertTaps(db, newSnap, [{
      tap_number: 1, beer_ref: 'ref-current', brewery_ref: 'Br',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    // 2. link + tap, but only on the OLDER snapshot (the #486 gap)
    const rotatedOff = mk('RotatedOff');
    upsertMatch(db, 'ref-rotated', rotatedOff, 1.0);
    insertTaps(db, oldSnap, [{
      tap_number: 2, beer_ref: 'ref-rotated', brewery_ref: 'Br',
      abv: null, ibu: null, style: null, u_rating: null,
    }]);

    // 3. link whose ref matches no tap at all (retention deleted them)
    const deadLink = mk('DeadLink');
    upsertMatch(db, 'ref-dead-no-tap-anywhere', deadLink, 1.0);

    // 4. no link at all (shop-sourced relay orphan)
    const noLink = mk('NoLink');

    // Pin cases 2 and 3 apart from each other: without this, a typo'd `ref` would silently
    // collapse rotatedOff into the deadLink shape (no tap reachable at all) and the pool
    // assertions below would still pass, but for the wrong reason.
    const joinsSomeTap = (beerRef: string): boolean => !!db
      .prepare(
        `SELECT 1 FROM match_links ml JOIN taps t ON t.beer_ref = ml.ontap_ref
         WHERE ml.ontap_ref = ?`,
      )
      .get(beerRef);
    expect(joinsSomeTap('ref-rotated')).toBe(true);
    expect(joinsSomeTap('ref-dead-no-tap-anywhere')).toBe(false);

    const now = new Date('2026-05-26T12:00:00Z');
    const onTap = listLookupCandidates(db, 100, now).map((c) => c.id);
    const relay = listRelayLookupCandidates(db, 100, now).map((c) => c.id);

    // Exactly one, for every arrangement. The membership pair is asserted as a labelled
    // tuple so a failure names the beer and which side it fell on, instead of "false !== true".
    const membership = [current, rotatedOff, deadLink, noLink].map((id) => ({
      id, onTap: onTap.includes(id), relay: relay.includes(id),
    }));
    expect(membership).toEqual([
      { id: current,    onTap: true,  relay: false },
      { id: rotatedOff, onTap: false, relay: true  },
      { id: deadLink,   onTap: false, relay: true  },
      { id: noLink,     onTap: false, relay: true  },
    ]);
    // and the split is the one we intend, not merely disjoint
    expect(onTap).toEqual([current]);
    expect(relay.sort()).toEqual([rotatedOff, deadLink, noLink].sort());
  });
});
