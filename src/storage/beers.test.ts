import { openDb } from './db';
import { migrate } from './schema';
import { upsertBeerByBid, ensureOrphan, findBeerByNormalized, loadCatalog, readWebTriedAt, stampWebTried } from './beers';
import { seedBeer } from './seed-beer.testing';
import { normalizeName, normalizeBrewery } from '../domain/normalize';
import { cardText } from '../domain/card-text';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('findBeerByNormalized returns null when absent', () => {
  expect(findBeerByNormalized(fresh(), 'x', 'y')).toBeNull();
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
    const id = seedBeer(db, {
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
    const id = seedBeer(db, {
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
    const id = seedBeer(db, {
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
    const id = seedBeer(db, {
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
    const id = seedBeer(db, {
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
    const id = seedBeer(db, {
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
    const beerId = seedBeer(db, {
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
    seedBeer(db, {
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
    const beerId = seedBeer(db, {
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
    const beerId = seedBeer(db, {
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
    const beerId = seedBeer(db, {
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

describe('loadCatalog', () => {
  it('returns id, brewery, name, abv, rating_global for every beer', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = seedBeer(db, {
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
    const id = seedBeer(db, {
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
  const canonicalId = seedBeer(db, {
    untappd_id: 999, name: 'Marine', brewery: 'Moon Lark Brewery',
    style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Marine'), normalized_brewery: normalizeBrewery('Moon Lark Brewery'),
  });
  const orphanId = seedBeer(db, {
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

// --- #614: пам'ять злиття для назв з крамниць -------------------------------------------------

type AliasRow = {
  beer_id: number; brewery: string; name: string;
  brewery_text: string; name_text: string; created_at: string;
};

function aliasesOf(db: ReturnType<typeof fresh>, beerId: number): AliasRow[] {
  return db.prepare(
    `SELECT beer_id, brewery, name, brewery_text, name_text, created_at
       FROM beer_aliases WHERE beer_id = ? ORDER BY id`,
  ).all(beerId) as AliasRow[];
}

// Випадок користувача 2026-09-14: картка Flasker «VARVAR BLACK BEAN IS 11% 0.33л» проти
// каталожного «Varvar Brew / Black Bean» (bid 3548624).
function aliasFixture() {
  const db = fresh();
  const canonicalId = seedBeer(db, {
    untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
    style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
    normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
  });
  const orphanId = seedBeer(db, {
    name: 'BLACK BEAN IS', brewery: 'VARVAR', style: null, abv: 11, rating_global: null,
    normalized_name: normalizeName('BLACK BEAN IS'), normalized_brewery: normalizeBrewery('VARVAR'),
  });
  return { db, canonicalId, orphanId };
}

test('#614 mergeIntoCanonical remembers the orphan\'s shop pair as an alias of the canonical row', () => {
  const { db, canonicalId, orphanId } = aliasFixture();

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T07:13:20Z');

  expect(aliasesOf(db, canonicalId)).toEqual([{
    beer_id: canonicalId,
    brewery: 'VARVAR',
    name: 'BLACK BEAN IS',
    brewery_text: 'varvar',
    name_text: 'black bean is',
    created_at: '2026-09-14T07:13:20Z',
  }]);
});

test('#614 mergeIntoCanonical lets a merged linked row\'s aliases go instead of moving them to the new bid\'s owner', () => {
  const db = fresh();
  // Злінкований рядок з хибним bid (пошук угадав Spicy Edition) і аліас, записаний під цим bid.
  const wrongId = seedBeer(db, {
    untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5.4, rating_global: 3.61,
    normalized_name: normalizeName('Red Mexican Spicy Edition'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  const ownerId = seedBeer(db, {
    untappd_id: 5120103, name: 'Red Mexican', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5, rating_global: 3.72,
    normalized_name: normalizeName('Red Mexican'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, created_at)
     VALUES (?, 'Copper Head', 'RED MEXICAN Tomato Gose', ?, ?, '2026-09-02T10:00:00Z')`,
  ).run(wrongId, cardText('Copper Head'), cardText('RED MEXICAN Tomato Gose'));

  // Репарація #384: крамниця опублікувала bid 5120103 для рядка wrongId, власник уже є → злиття.
  mergeIntoCanonical(db, wrongId, ownerId, '2026-09-14T07:11:40Z');

  // Пара самого рядка доведена прийнятим bid і стає аліасом; «Tomato Gose» доводив 6037305 і зникає.
  expect(aliasesOf(db, ownerId).map((a) => a.name)).toEqual(['Red Mexican Spicy Edition']);
});

test('#614 mergeIntoCanonical re-points an existing alias of the same pair to the newest merge target', () => {
  const db = fresh();
  const oldTarget = seedBeer(db, {
    untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5.4, rating_global: 3.61,
    normalized_name: normalizeName('Red Mexican Spicy Edition'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  const newTarget = seedBeer(db, {
    untappd_id: 5120103, name: 'Red Mexican', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5, rating_global: 3.72,
    normalized_name: normalizeName('Red Mexican'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  const cardBrewery = 'Copper Head';
  const cardName = 'RED MEXICAN Tomato Gose';
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-02T10:00:00Z')`,
  ).run(oldTarget, cardBrewery, cardName, cardText(cardBrewery), cardText(cardName));
  // Нова сирота тієї самої картки (досяжно зі шляху кранів або з репарації #384).
  const orphanId = seedBeer(db, {
    name: cardName, brewery: cardBrewery, style: 'Gose', abv: 5, rating_global: null,
    normalized_name: normalizeName(cardName), normalized_brewery: normalizeBrewery(cardBrewery),
  });

  mergeIntoCanonical(db, orphanId, newTarget, '2026-09-14T07:11:40Z');

  const rows = db.prepare('SELECT beer_id, created_at FROM beer_aliases').all();
  expect(rows).toEqual([{ beer_id: newTarget, created_at: '2026-09-14T07:11:40Z' }]);
});

test('#614 mergeIntoCanonical writes the alias from the searched text, not from an orphan another card created', () => {
  const db = fresh();
  const g7 = seedBeer(db, {
    untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
    style: 'Stout', abv: 7, rating_global: 3.9,
    normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
  });
  // Сирота картки «#6»; ensureBeerRow цифр не бачить і віддає її картці «#7», чий пошук знайшов bid 4007.
  const orphanId = seedBeer(db, {
    name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
    normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
  });

  mergeIntoCanonical(db, orphanId, g7, '2026-09-14T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7' });

  expect(aliasesOf(db, g7).map((a) => [a.brewery, a.name, a.brewery_text, a.name_text])).toEqual([['Ґвара', 'Ґвара #7', 'ґвара', 'ґвара #7']]);
});

test('#614 twin cards of one shop keep one alias each', () => {
  const db = fresh();
  const pairName = normalizeName('Trappistes Rochefort 8');
  const pairBrewery = normalizeBrewery('Brasserie de Rochefort');
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, abv, normalized_name, normalized_brewery)
     VALUES (8, 1001, 'Trappistes Rochefort 8', 'Brasserie de Rochefort', 9.2, ?, ?),
            (10, 2002, 'Trappistes Rochefort 10', 'Brasserie de Rochefort', 11.3, ?, ?)`,
  ).run(pairName, pairBrewery, pairName, pairBrewery);
  const card8 = seedBeer(db, {
    name: 'Rochefort 8 IS', brewery: 'ROCH', style: null, abv: 9.2, rating_global: null,
    normalized_name: normalizeName('Rochefort 8 IS'), normalized_brewery: normalizeBrewery('ROCH'),
  });
  mergeIntoCanonical(db, card8, 8, '2026-09-14T07:10:00Z');
  const card10 = seedBeer(db, {
    name: 'Rochefort 10 IS', brewery: 'ROCH', style: null, abv: 11.3, rating_global: null,
    normalized_name: normalizeName('Rochefort 10 IS'), normalized_brewery: normalizeBrewery('ROCH'),
  });
  mergeIntoCanonical(db, card10, 10, '2026-09-14T07:11:00Z');

  const rows = db.prepare('SELECT beer_id, name_text FROM beer_aliases ORDER BY beer_id').all();
  expect(rows).toEqual([{ beer_id: 8, name_text: 'rochefort 8 is' }, { beer_id: 10, name_text: 'rochefort 10 is' }]);
});

test('#614 mergeIntoCanonical writes no alias for a card whose brewery text is empty', () => {
  const db = fresh();
  const canonicalId = seedBeer(db, {
    untappd_id: 6810840, name: 'Amigo Mate Bananowe', brewery: 'Amigo Mate',
    style: 'Mate', abv: 0, rating_global: 3.4,
    normalized_name: normalizeName('Amigo Mate Bananowe'), normalized_brewery: normalizeBrewery('Amigo Mate'),
  });
  const orphanId = seedBeer(db, {
    name: 'AMIGO MATE BANANOWE', brewery: '  ', style: null, abv: 0, rating_global: null,
    normalized_name: normalizeName('AMIGO MATE BANANOWE'), normalized_brewery: normalizeBrewery('  '),
  });

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T10:00:00Z', { brewery: '  ', name: 'AMIGO MATE BANANOWE' });

  const n = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
  expect(n.n).toBe(0);
});

test('#614 mergeIntoCanonical writes no alias for a card whose name text is empty', () => {
  const db = fresh();
  const canonicalId = seedBeer(db, {
    untappd_id: 6810840, name: 'Amigo Mate Bananowe', brewery: 'Amigo Mate',
    style: 'Mate', abv: 0, rating_global: 3.4,
    normalized_name: normalizeName('Amigo Mate Bananowe'), normalized_brewery: normalizeBrewery('Amigo Mate'),
  });
  const orphanId = seedBeer(db, {
    name: 'Amigo Mate Bananowe Cydr', brewery: 'Amigo Mate', style: null, abv: 0, rating_global: null,
    normalized_name: normalizeName('Amigo Mate Bananowe Cydr'), normalized_brewery: normalizeBrewery('Amigo Mate'),
  });

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T10:00:00Z', { brewery: 'Amigo Mate', name: ' \t ' });

  const n = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
  expect(n.n).toBe(0);
});

function linkedRowWithAlias(db: ReturnType<typeof fresh>) {
  const rowId = seedBeer(db, {
    untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5.4, rating_global: 3.61,
    normalized_name: normalizeName('Red Mexican Spicy Edition'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, created_at)
     VALUES (?, 'Copper Head', 'RED MEXICAN Tomato Gose', ?, ?, '2026-09-02T10:00:00Z')`,
  ).run(rowId, cardText('Copper Head'), cardText('RED MEXICAN Tomato Gose'));
  return rowId;
}

test('#614 recordLookupSuccess drops a linked row\'s aliases when its bid is rewritten', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);

  recordLookupSuccess(db, rowId, { bid: 5120103, style: 'Gose', abv: 5, global_rating: 3.72 }, '2026-09-14T07:11:40Z');

  expect(getBeer(db, rowId)?.untappd_id).toBe(5120103);
  expect(aliasesOf(db, rowId)).toEqual([]);
});

test('#614 recordLookupSuccess keeps aliases when the same bid is confirmed', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);

  recordLookupSuccess(db, rowId, { bid: 6037305, style: 'Gose', abv: 5.4, global_rating: 3.61 }, '2026-09-14T07:11:40Z');

  expect(aliasesOf(db, rowId).map((a) => a.name)).toEqual(['RED MEXICAN Tomato Gose']);
});

test('#614 recordLookupSuccess leaves aliases alone when the rewrite hits UNIQUE — the merge that follows decides', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);
  seedBeer(db, {
    untappd_id: 5120103, name: 'Red Mexican', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5, rating_global: 3.72,
    normalized_name: normalizeName('Red Mexican'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });

  expect(() => recordLookupSuccess(
    db, rowId, { bid: 5120103, style: 'Gose', abv: 5, global_rating: 3.72 }, '2026-09-14T07:11:40Z',
  )).toThrow(/UNIQUE/);

  // Відкат транзакції: частковий стан (аліаси стерто, bid ні) не лишається.
  expect(aliasesOf(db, rowId).map((a) => a.name)).toEqual(['RED MEXICAN Tomato Gose']);
  expect(getBeer(db, rowId)?.untappd_id).toBe(6037305);
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
  return seedBeer(db, {
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
    const id = seedBeer(db, {
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
  seedBeer(db, {
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
    const id = seedBeer(db, {
      untappd_id: null, name: 'N', brewery: 'B',
      normalized_name: 'n', normalized_brewery: 'b',
    });
    recordLookupSuccess(db, id, { bid: 900, style: null, abv: null, global_rating: null }, '2026-08-09T00:00:00Z');
    const row = db.prepare('SELECT untappd_id, untappd_id_source FROM beers WHERE id = ?').get(id);
    expect(row).toEqual({ untappd_id: 900, untappd_id_source: 'search' });
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

    const mk = (name: string): number => seedBeer(db, {
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

describe('upsertBeerByBid (#617)', () => {
  const ROCHEFORT = 'Abbaye Notre-Dame de Saint-Rémy';
  const PP = 'Piwne Podziemie';

  function bidInput(
    bid: number, name: string, brewery: string,
    extra: Partial<Parameters<typeof upsertBeerByBid>[1]> = {},
  ) {
    return {
      untappd_id: bid, name, brewery,
      normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
      untappd_id_source: 'checkin' as const,
      ...extra,
    };
  }

  // Сирота напряму, в обхід seedBeer: той зливає дві сироти з однаковою нормалізованою парою.
  function insertOrphanRaw(db: ReturnType<typeof fresh>, name: string, brewery: string, abv: number): number {
    const res = db.prepare(
      `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global, normalized_name, normalized_brewery)
       VALUES (NULL, ?, ?, 'Sour', ?, NULL, ?, ?)`,
    ).run(name, brewery, abv, normalizeName(name), normalizeBrewery(brewery));
    return Number(res.lastInsertRowid);
  }

  test('fills only empty facts on the row found by bid', () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: null, abv: 9.2, rating_global: null,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    const got = upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, {
      style: 'Belgian Quadrupel', abv: 5.0, rating_global: 3.95,
    }));
    expect(got).toBe(id);
    const row = getBeer(db, id)!;
    expect(row.style).toBe('Belgian Quadrupel');   // було порожнє → заповнено
    expect(row.abv).toBeCloseTo(9.2);               // було 9.2 → не перезаписано
    expect(row.rating_global).toBeCloseTo(3.95);    // було порожнє → заповнено
  });

  // Окремо від тесту вище: там style і rating порожні, тож обидва порядки COALESCE дають те саме
  // (рев'ю ядра: мутація порядку для style і rating_global виживала).
  test('stored facts on the row found by bid are never overwritten by incoming ones', () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Belgian Strong Dark Ale', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, {
      style: 'Belgian Quadrupel', abv: 5.0, rating_global: 4.2,
    }));
    const row = getBeer(db, id)!;
    expect(row.style).toBe('Belgian Strong Dark Ale');
    expect(row.abv).toBeCloseTo(9.2);
    expect(row.rating_global).toBeCloseTo(3.95);
  });

  test('empty input never wipes stored facts (the sync wipe)', () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Belgian Strong Dark Ale', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, {
      style: null, abv: null, rating_global: null,
    }));
    const row = getBeer(db, id)!;
    expect(row.style).toBe('Belgian Strong Dark Ale');
    expect(row.abv).toBeCloseTo(9.2);
    expect(row.rating_global).toBeCloseTo(3.95);
  });

  test('never renames the row found by bid (#618 owns Untappd names)', () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 6700001, name: "Don't Shoot", brewery: 'Inne Beczki Brewery',
      style: 'IPA', abv: 5.8, rating_global: 3.8,
      normalized_name: normalizeName("Don't Shoot"), normalized_brewery: normalizeBrewery('Inne Beczki Brewery'),
      untappd_id_source: 'search',
    });
    upsertBeerByBid(db, bidInput(6700001, "HopGang: Don't Shoot", 'Inne Beczki'));
    const row = getBeer(db, id)!;
    expect(row.name).toBe("Don't Shoot");
    expect(row.brewery).toBe('Inne Beczki Brewery');
    expect(row.normalized_name).toBe(normalizeName("Don't Shoot"));
  });

  test.each([
    ['search', 'checkin', 'checkin'],
    ['search', 'bid', 'bid'],
    ['bid', 'checkin', 'checkin'],
    ['checkin', 'bid', 'checkin'],
    ['curated', 'checkin', 'curated'],
    ['curated', 'bid', 'curated'],
  ] as const)('provenance only strengthens: stored %s + incoming %s → %s', (stored, incoming, expected) => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Quad', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: stored,
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, { untappd_id_source: incoming }));
    expect(getBeer(db, id)!.untappd_id_source).toBe(expected);
  });

  test('a row with no provenance takes the incoming one', () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Quad', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, { untappd_id_source: 'bid' }));
    expect(getBeer(db, id)!.untappd_id_source).toBe('bid');
  });

  test('a vintage twin with another bid is never touched: a new row is inserted', () => {
    const db = fresh();
    const eight = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Belgian Strong Dark Ale', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    const ten = upsertBeerByBid(db, bidInput(2002, 'Trappistes Rochefort 10', ROCHEFORT, {
      style: 'Belgian Quadrupel', abv: 11.3, rating_global: 4.05,
    }));
    expect(ten).not.toBe(eight);
    const e = getBeer(db, eight)!;
    expect(e.untappd_id).toBe(1001);
    expect(e.name).toBe('Trappistes Rochefort 8');
    expect(e.abv).toBeCloseTo(9.2);
    expect(e.rating_global).toBeCloseTo(3.95);
    expect(e.untappd_id_source).toBe('search');
    const t = getBeer(db, ten)!;
    expect(t.untappd_id).toBe(2002);
    expect(t.name).toBe('Trappistes Rochefort 10');
    expect(t.untappd_id_source).toBe('checkin');
    expect(t.style).toBe('Belgian Quadrupel');
    expect(t.abv).toBeCloseTo(11.3);
    expect(t.rating_global).toBeCloseTo(4.05);
    // без нормалізованої пари новий рядок не знайде ні матчер, ні наступний синк
    expect(t.normalized_name).toBe(normalizeName('Trappistes Rochefort 10'));
    expect(t.normalized_brewery).toBe(normalizeBrewery(ROCHEFORT));
  });

  // Числа тут однакові, тож numericTokensCompatible злінкований рядок не відсіє — від перехоплення
  // його береже лише умова `untappd_id IS NULL` у resolvableOrphan. Тест «vintage twin» вище цю
  // умову не ловить: там 8 ≠ 10 і фільтр чисел відсіює рядок сам.
  test('a linked row with the same name and numbers but another bid is never taken over', () => {
    const db = fresh();
    const linked = seedBeer(db, {
      untappd_id: 111, name: 'Juicy Trap #20', brewery: PP,
      style: 'Sour', abv: 6.5, rating_global: 3.9,
      normalized_name: normalizeName('Juicy Trap #20'), normalized_brewery: normalizeBrewery(PP),
      untappd_id_source: 'search',
    });
    const got = upsertBeerByBid(db, bidInput(222, 'Juicy Trap #20', PP));
    expect(got).not.toBe(linked);
    expect(getBeer(db, linked)!.untappd_id).toBe(111);
    expect(getBeer(db, got)!.untappd_id).toBe(222);
  });

  test('resolves the one orphan with the same pair and compatible numeric tokens', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Juicy Trap #20', PP, 6.5);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP, { rating_global: 4.1 }));
    expect(got).toBe(orphan);
    const row = getBeer(db, orphan)!;
    expect(row.untappd_id).toBe(6625206);
    expect(row.untappd_id_source).toBe('checkin');
    expect(row.abv).toBeCloseTo(6.5);      // вхід без ABV (стрічка) → лишається ABV сироти
    expect(row.style).toBe('Sour');
    expect(row.rating_global).toBeCloseTo(4.1);
  });

  // Рев'ю ядра: факти сироти прийшли з тексту крана/крамниці, а той ABV «буває помилковим,
  // тож авторитетний Untappd-ABV переважає» (spec.md §/newbeers) — як і в recordLookupSuccess.
  test("a resolved orphan takes Untappd's facts over its own", () => {
    const db = fresh();
    const res = db.prepare(
      `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global, normalized_name, normalized_brewery)
       VALUES (NULL, 'Juicy Trap #20', ?, 'Sour', 6.5, 3.5, ?, ?)`,
    ).run(PP, normalizeName('Juicy Trap #20'), normalizeBrewery(PP));
    const orphan = Number(res.lastInsertRowid);
    upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP, {
      style: 'Sour - Smoothie / Pastry', abv: 6.8, rating_global: 4.1,
    }));
    const row = getBeer(db, orphan)!;
    expect(row.style).toBe('Sour - Smoothie / Pastry');
    expect(row.abv).toBeCloseTo(6.8);
    expect(row.rating_global).toBeCloseTo(4.1);
  });

  // Рев'ю ядра: listUntriagedFailures і listLockedRows не фільтрують untappd_id IS NULL, тож
  // стан сироти, що пережив резолвлення, тріажив би й розмикав уже злінковане пиво.
  test('resolving an orphan clears its orphan state', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Juicy Trap #20', PP, 6.5);
    recordEnrichFailure(db, {
      beer_id: orphan, brewery: PP, name: 'Juicy Trap #20',
      search_url: '', source_url: '', outcome: 'not_found',
      candidates_count: 0, candidates_summary: '', at: '2026-09-13T10:00:00Z',
    });
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM enrich_failures WHERE beer_id = ?').get(orphan) as { n: number }).n;
    expect(count()).toBe(1);
    upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP));
    expect(count()).toBe(0);
  });

  test('an orphan of another brewery with the same name is not resolved', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Juicy Trap #20', 'Browar Inny', 6.5);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP));
    expect(got).not.toBe(orphan);
    expect(getBeer(db, orphan)!.untappd_id).toBeNull();
  });

  test('an orphan whose numbers differ is not resolved', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Juicy Trap #19', PP, 6.5);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP));
    expect(got).not.toBe(orphan);
    expect(getBeer(db, orphan)!.untappd_id).toBeNull();
  });

  test('a year on one side only still resolves the orphan', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Krzyż Południa', 'Ziemia Obiecana', 5.5);
    const got = upsertBeerByBid(db, bidInput(6800001, 'Krzyż Południa (2026)', 'Ziemia Obiecana'));
    expect(got).toBe(orphan);
    expect(getBeer(db, orphan)!.untappd_id).toBe(6800001);
  });

  test('two compatible orphans are ambiguous: neither is resolved, a new row is inserted', () => {
    const db = fresh();
    const a = insertOrphanRaw(db, 'Juicy Trap #20', PP, 6.5);
    const b = insertOrphanRaw(db, 'Juicy Trap #20 18°', PP, 6.6);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP));
    expect(got).not.toBe(a);
    expect(got).not.toBe(b);
    expect(getBeer(db, a)!.untappd_id).toBeNull();
    expect(getBeer(db, b)!.untappd_id).toBeNull();
    expect(getBeer(db, got)!.untappd_id).toBe(6625206);
  });

  test('bumps the catalog version on insert and on update', () => {
    const db = fresh();
    let v = catalogVersion();
    const id = upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT));
    expect(catalogVersion()).toBeGreaterThan(v);
    v = catalogVersion();
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, { abv: 9.2 }));
    expect(catalogVersion()).toBeGreaterThan(v);
    expect(getBeer(db, id)!.abv).toBeCloseTo(9.2);
  });
});

describe('ensureOrphan (#617)', () => {
  const MONSTERS = 'Monsters Brewery';

  // Рев'ю гілки #617: у гілці сироти refresh-ontap наявна сирота з тією ж нормалізованою парою
  // досяжна лише тоді, коли матчер відкинув її як інший рік, — повернути її означало б приліпити
  // кран «2025» до сироти «2024» (і шукати його на Untappd під назвою 2024).
  test('an orphan of another year is not reused: a new orphan is inserted', () => {
    const db = fresh();
    const old = ensureOrphan(db, {
      name: 'Piwobranie 2024', brewery: 'Browar Grodzisk', style: 'Grodziskie', abv: 3.1, rating_global: null,
      normalized_name: normalizeName('Piwobranie 2024'), normalized_brewery: normalizeBrewery('Browar Grodzisk'),
    });
    const got = ensureOrphan(db, {
      name: 'Piwobranie 2025', brewery: 'Browar Grodzisk', style: null, abv: 3.2, rating_global: null,
      normalized_name: normalizeName('Piwobranie 2025'), normalized_brewery: normalizeBrewery('Browar Grodzisk'),
    });
    expect(got).not.toBe(old);
    expect(getBeer(db, old)!.name).toBe('Piwobranie 2024');
    expect(getBeer(db, got)!.name).toBe('Piwobranie 2025');
  });

  test('inserts a new orphan beside a linked vintage with the same normalized name', () => {
    const db = fresh();
    const linked = seedBeer(db, {
      untappd_id: 6300175, name: 'O Tiole Mio! 2026 15°', brewery: MONSTERS,
      style: 'Pastry Sour', abv: 6.0, rating_global: 3.7,
      normalized_name: normalizeName('O Tiole Mio! 2026 15°'), normalized_brewery: normalizeBrewery(MONSTERS),
      untappd_id_source: 'search',
    });
    const got = ensureOrphan(db, {
      name: 'O tiole mio! 2025', brewery: MONSTERS, style: null, abv: 6.5, rating_global: null,
      normalized_name: normalizeName('O tiole mio! 2025'), normalized_brewery: normalizeBrewery(MONSTERS),
    });
    expect(got).not.toBe(linked);
    const l = getBeer(db, linked)!;
    expect(l.name).toBe('O Tiole Mio! 2026 15°');
    expect(l.untappd_id).toBe(6300175);
    expect(l.style).toBe('Pastry Sour');
    expect(l.rating_global).toBeCloseTo(3.7);
    const o = getBeer(db, got)!;
    expect(o.untappd_id).toBeNull();
    expect(o.untappd_id_source).toBeNull();
    expect(o.abv).toBeCloseTo(6.5);
  });

  test('returns an existing orphan with the same pair without overwriting it', () => {
    const db = fresh();
    const first = ensureOrphan(db, {
      name: 'Łan', brewery: 'Sadyba Brewery', style: 'Pszeniczne', abv: 4.8, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    });
    const again = ensureOrphan(db, {
      name: 'Łan 12°', brewery: 'Sadyba Brewery', style: null, abv: 5.5, rating_global: null,
      normalized_name: normalizeName('Łan 12°'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    });
    expect(again).toBe(first);
    const row = getBeer(db, first)!;
    expect(row.name).toBe('Łan');
    expect(row.style).toBe('Pszeniczne');
    expect(row.abv).toBeCloseTo(4.8);
  });

  test("another brewery's orphan with the same name is not returned", () => {
    const db = fresh();
    const other = ensureOrphan(db, {
      name: 'Łan', brewery: 'Browar Inny', style: 'Pszeniczne', abv: 4.8, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Browar Inny'),
    });
    const got = ensureOrphan(db, {
      name: 'Łan', brewery: 'Sadyba Brewery', style: null, abv: 5.5, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    });
    expect(got).not.toBe(other);
  });

  test('of several equal orphans the oldest is returned', () => {
    const db = fresh();
    const insert = (name: string) => Number(db.prepare(
      `INSERT INTO beers (untappd_id, name, brewery, normalized_name, normalized_brewery)
       VALUES (NULL, ?, 'Sadyba Brewery', ?, ?)`,
    ).run(name, normalizeName(name), normalizeBrewery('Sadyba Brewery')).lastInsertRowid);
    const oldest = insert('Łan');
    insert('Łan 12°');
    const got = ensureOrphan(db, {
      name: 'Łan', brewery: 'Sadyba Brewery', style: null, abv: null, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    });
    expect(got).toBe(oldest);
  });

  test('bumps the catalog version only when it inserts', () => {
    const db = fresh();
    const input = {
      name: 'Łan', brewery: 'Sadyba Brewery', style: 'Pszeniczne', abv: 4.8, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    };
    let v = catalogVersion();
    ensureOrphan(db, input);
    expect(catalogVersion()).toBeGreaterThan(v);
    v = catalogVersion();
    ensureOrphan(db, input);
    expect(catalogVersion()).toBe(v);
  });
});

// ---------------------------------------------------------------------------
// #616 — гідратація рейтингів
// ---------------------------------------------------------------------------

import { listRatingHydrationCandidates, applyHydratedRatings, RATING_RECHECK_DAYS } from './beers';

describe('listRatingHydrationCandidates (#616)', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  function seed(
    db: ReturnType<typeof fresh>,
    o: { bid: number | null; name: string; rating: number | null; checkedAt?: string | null; refreshAt?: string | null; refreshCount?: number },
  ): number {
    const id = seedBeer(db, {
      untappd_id: o.bid, name: o.name, brewery: 'Browar Test', style: 'IPA', abv: 6.2,
      rating_global: o.rating, normalized_name: o.name.toLowerCase(), normalized_brewery: 'browar test',
    });
    db.prepare('UPDATE beers SET rating_checked_at = ?, rating_refresh_at = ?, rating_refresh_count = ? WHERE id = ?')
      .run(o.checkedAt ?? null, o.refreshAt ?? null, o.refreshCount ?? 0, id);
    return id;
  }

  test('takes linked rows never checked or checked more than 30 days ago; skips orphans and fresh stamps', () => {
    const db = fresh();
    const never = seed(db, { bid: 101, name: 'Never', rating: 3.9 });
    const stale = seed(db, { bid: 102, name: 'Stale', rating: 3.9, checkedAt: daysAgo(RATING_RECHECK_DAYS + 1) });
    seed(db, { bid: 103, name: 'Fresh', rating: 3.9, checkedAt: daysAgo(RATING_RECHECK_DAYS - 1) });
    seed(db, { bid: null, name: 'Orphan', rating: null });
    expect(listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id).sort()).toEqual([never, stale].sort());
  });

  test('order: missing or zero rating → never checked → oldest checked → id', () => {
    const db = fresh();
    const oldChecked = seed(db, { bid: 201, name: 'Old checked', rating: 4.1, checkedAt: daysAgo(90) });
    const newerChecked = seed(db, { bid: 202, name: 'Newer checked', rating: 4.1, checkedAt: daysAgo(40) });
    const neverChecked = seed(db, { bid: 203, name: 'Never checked', rating: 4.1 });
    const zero = seed(db, { bid: 204, name: 'Zero', rating: 0, checkedAt: daysAgo(40) });
    const missing = seed(db, { bid: 205, name: 'Missing', rating: null });
    // missing (штампа немає) іде перед zero (штамп 40 днів) усередині першої групи — NULL перший при ASC.
    expect(listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id))
      .toEqual([missing, zero, neverChecked, oldChecked, newerChecked]);
  });

  test('a bid Algolia did not know waits out its backoff; exhausted schedule is excluded', () => {
    const db = fresh();
    const waiting = seed(db, { bid: 301, name: 'Waiting', rating: null, refreshAt: daysAgo(1), refreshCount: 1 });
    const due = seed(db, { bid: 302, name: 'Due', rating: null, refreshAt: daysAgo(4), refreshCount: 1 });
    const exhausted = seed(db, { bid: 303, name: 'Exhausted', rating: null, refreshAt: daysAgo(400), refreshCount: 4 });
    const ids = listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id);
    expect(ids).toContain(due);
    expect(ids).not.toContain(waiting);
    expect(ids).not.toContain(exhausted);
  });

  test('a stamp exactly 30 days old is not yet due; a millisecond older is', () => {
    const db = fresh();
    seed(db, { bid: 111, name: 'Exact', rating: 3.9, checkedAt: daysAgo(RATING_RECHECK_DAYS) });
    const older = seed(db, {
      bid: 112, name: 'Older', rating: 3.9,
      checkedAt: new Date(NOW.getTime() - RATING_RECHECK_DAYS * 86_400_000 - 1).toISOString(),
    });
    expect(listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id)).toEqual([older]);
  });

  test('a negative limit returns no rows instead of slicing from the end (review #625)', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) seed(db, { bid: 450 + i, name: `Neg ${i}`, rating: null });
    expect(listRatingHydrationCandidates(db, -1, NOW)).toEqual([]);
  });

  test('respects the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) seed(db, { bid: 400 + i, name: `Beer ${i}`, rating: null });
    expect(listRatingHydrationCandidates(db, 3, NOW)).toHaveLength(3);
  });
});

describe('applyHydratedRatings (#616)', () => {
  const NOW_ISO = '2026-09-13T12:00:00.000Z';

  function seedLinked(db: ReturnType<typeof fresh>, bid: number, o: { rating: number | null; style: string | null; abv: number | null }): number {
    const id = seedBeer(db, {
      untappd_id: bid, name: `Beer ${bid}`, brewery: 'Browar Test', style: o.style, abv: o.abv,
      rating_global: o.rating, normalized_name: `beer ${bid}`, normalized_brewery: 'browar test',
    });
    db.prepare("UPDATE beers SET rating_refresh_at = '2026-09-01T00:00:00.000Z', rating_refresh_count = 2 WHERE id = ?").run(id);
    return id;
  }

  test('overwrites the rating, fills only empty style/abv, stamps and clears the backoff', () => {
    const db = fresh();
    const rated = seedLinked(db, 501, { rating: 3.5, style: 'Pils', abv: 5.0 });
    const bare = seedLinked(db, 502, { rating: null, style: null, abv: null });
    const out = applyHydratedRatings(db, new Map([
      [501, { global_rating: 4.06, style: 'Gose', abv: 4.2 }],
      [502, { global_rating: 3.77, style: 'Stout - Irish Dry', abv: 4.2 }],
    ]), [501, 502], NOW_ISO);
    expect(out).toEqual({ updated: 2, changed: 2, unknown: 0, skipped: 0 });
    expect(getBeer(db, rated)).toMatchObject({
      rating_global: 4.06, style: 'Pils', abv: 5.0,
      rating_checked_at: NOW_ISO, rating_refresh_at: null, rating_refresh_count: 0,
    });
    expect(getBeer(db, bare)).toMatchObject({ rating_global: 3.77, style: 'Stout - Irish Dry', abv: 4.2, rating_checked_at: NOW_ISO });
  });

  test('Untappd without a rating (<10 ratings) overwrites a stale number with NULL and stamps', () => {
    const db = fresh();
    const id = seedLinked(db, 601, { rating: 3.64, style: 'IPA', abv: 6.0 });
    applyHydratedRatings(db, new Map([[601, { global_rating: null, style: 'IPA', abv: 6.0 }]]), [601], NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: null, rating_checked_at: NOW_ISO });
  });

  test('a bid with no entry in the map (no proof either way) is skipped: no stamp, no backoff', () => {
    const db = fresh();
    const id = seedLinked(db, 702, { rating: 3.9, style: 'IPA', abv: 6.0 });
    const out = applyHydratedRatings(db, new Map(), [702], NOW_ISO);
    expect(out).toEqual({ updated: 0, changed: 0, unknown: 0, skipped: 1 });
    expect(getBeer(db, id)).toMatchObject({
      rating_global: 3.9, rating_checked_at: null, rating_refresh_at: '2026-09-01T00:00:00.000Z', rating_refresh_count: 2,
    });
  });

  test("Algolia's explicit null for a bid only advances the backoff", () => {
    const db = fresh();
    const id = seedLinked(db, 701, { rating: 3.9, style: 'IPA', abv: 6.0 });
    const out = applyHydratedRatings(db, new Map([[701, null]]), [701], NOW_ISO);
    expect(out).toEqual({ updated: 0, changed: 0, unknown: 1, skipped: 0 });
    expect(getBeer(db, id)).toMatchObject({
      rating_global: 3.9, rating_checked_at: null, rating_refresh_at: NOW_ISO, rating_refresh_count: 3,
    });
  });

  test('bumps the catalog version once when something changed, never when nothing did', () => {
    const db = fresh();
    seedLinked(db, 801, { rating: 3.5, style: 'IPA', abv: 6.0 });
    seedLinked(db, 802, { rating: 3.6, style: 'IPA', abv: 6.0 });
    const hits = new Map([
      [801, { global_rating: 4.0, style: 'IPA', abv: 6.0 }],
      [802, { global_rating: 4.1, style: 'IPA', abv: 6.0 }],
    ]);
    const v0 = catalogVersion();
    applyHydratedRatings(db, hits, [801, 802], NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 1);
    const again = applyHydratedRatings(db, hits, [801, 802], '2026-10-14T12:00:00.000Z');
    expect(again).toEqual({ updated: 2, changed: 0, unknown: 0, skipped: 0 });
    expect(catalogVersion()).toBe(v0 + 1);
  });

  test('filling only an empty style or only an empty ABV still bumps the catalog version', () => {
    const db = fresh();
    seedLinked(db, 811, { rating: 4.0, style: null, abv: 6.0 });
    seedLinked(db, 812, { rating: 4.1, style: 'IPA', abv: null });
    const v0 = catalogVersion();
    applyHydratedRatings(db, new Map([[811, { global_rating: 4.0, style: 'IPA', abv: 6.0 }]]), [811], NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 1);
    applyHydratedRatings(db, new Map([[812, { global_rating: 4.1, style: 'IPA', abv: 5.5 }]]), [812], NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);
  });

  test('a bid whose row vanished between selection and write touches nothing', () => {
    const db = fresh();
    const other = seedLinked(db, 901, { rating: 3.9, style: 'IPA', abv: 6.0 });
    const out = applyHydratedRatings(db, new Map([[999, { global_rating: 4.2, style: 'Lager', abv: 5.0 }]]), [999], NOW_ISO);
    expect(out).toEqual({ updated: 0, changed: 0, unknown: 0, skipped: 0 });
    expect(getBeer(db, other)).toMatchObject({ rating_global: 3.9, rating_checked_at: null });
  });
});

// ---------------------------------------------------------------------------
// #616 — рядок, знайдений за bid зі сторінки /beers профілю
// ---------------------------------------------------------------------------

import { recordProfileBeer } from './beers';

describe('recordProfileBeer (#616)', () => {
  const NOW_ISO = '2026-09-13T03:00:00.000Z';
  type Source = 'search' | 'bid' | 'checkin' | 'curated' | null;

  function seedRow(db: ReturnType<typeof fresh>, o: { rating: number | null; abv: number | null; source?: Source; checkedAt?: string | null }): number {
    const id = seedBeer(db, {
      untappd_id: 6869890, name: 'Prototype', brewery: 'Funky Fluid', style: 'IPA', abv: o.abv,
      rating_global: o.rating, normalized_name: 'prototype', normalized_brewery: 'funky fluid',
    });
    // `source: null` — справжній кейс «провенансу немає», тож дефолт лише для відсутнього ключа.
    db.prepare('UPDATE beers SET untappd_id_source = ?, rating_checked_at = ? WHERE id = ?')
      .run(o.source === undefined ? 'search' : o.source, o.checkedAt ?? null, id);
    return id;
  }

  test('a Global Rating number overwrites the rating and stamps; page ABV wins when present', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 3.5, abv: 5.0 });
    recordProfileBeer(db, id, { global_rating: 4.05, global_rating_shown: true, abv: 6.3 }, NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 4.05, abv: 6.3, rating_checked_at: NOW_ISO });
  });

  test('Global Rating (N/A) writes NULL and stamps; an absent page ABV keeps the stored one', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 3.64, abv: 6.0 });
    recordProfileBeer(db, id, { global_rating: null, global_rating_shown: true, abv: null }, NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: null, abv: 6.0, rating_checked_at: NOW_ISO });
  });

  test('a card without the block leaves rating and stamp alone but still takes the page ABV', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 3.9, abv: 5.0, checkedAt: '2026-09-01T00:00:00.000Z' });
    recordProfileBeer(db, id, { global_rating: null, global_rating_shown: false, abv: 6.3 }, NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 3.9, abv: 6.3, rating_checked_at: '2026-09-01T00:00:00.000Z' });
  });

  test.each([
    [null, 'checkin'], ['search', 'checkin'], ['bid', 'checkin'], ['checkin', 'checkin'], ['curated', 'curated'],
  ] as [Source, Source][])('provenance %s → %s, with and without the block', (stored, expected) => {
    for (const shown of [true, false]) {
      const db = fresh();
      const id = seedRow(db, { rating: 3.9, abv: 5.0, source: stored });
      recordProfileBeer(db, id, { global_rating: 3.9, global_rating_shown: shown, abv: 5.0 }, NOW_ISO);
      expect(getBeer(db, id)?.untappd_id_source).toBe(expected);
    }
  });

  test('bumps the catalog only when the rating or the ABV actually changed', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 4.05, abv: 6.3 });
    const v0 = catalogVersion();
    recordProfileBeer(db, id, { global_rating: 4.05, global_rating_shown: true, abv: 6.3 }, NOW_ISO);
    expect(catalogVersion()).toBe(v0);                     // нічого не змінилось
    recordProfileBeer(db, id, { global_rating: 4.1, global_rating_shown: true, abv: 6.3 }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 1);                 // рейтинг
    recordProfileBeer(db, id, { global_rating: 4.1, global_rating_shown: false, abv: 7.0 }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);                 // лише ABV
    recordProfileBeer(db, id, { global_rating: 4.1, global_rating_shown: false, abv: null }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);                 // ABV сторінки порожній — не зміна
    recordProfileBeer(db, id, { global_rating: null, global_rating_shown: false, abv: null }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);                 // без блоку рейтинг не змінюється
  });

  test('a Global Rating block clears an Algolia-unknown backoff; a card without it leaves the backoff (review #625)', () => {
    for (const [shown, expected] of [
      [true, { rating_refresh_at: null, rating_refresh_count: 0 }],
      [false, { rating_refresh_at: '2026-06-01T00:00:00.000Z', rating_refresh_count: 4 }],
    ] as const) {
      const db = fresh();
      const id = seedRow(db, { rating: 3.9, abv: 5.0 });
      db.prepare("UPDATE beers SET rating_refresh_at = '2026-06-01T00:00:00.000Z', rating_refresh_count = 4 WHERE id = ?").run(id);
      recordProfileBeer(db, id, { global_rating: 3.9, global_rating_shown: shown, abv: 5.0 }, NOW_ISO);
      expect(getBeer(db, id)).toMatchObject(expected);
    }
  });

  test('an unknown beer id is a no-op', () => {
    const db = fresh();
    const v0 = catalogVersion();
    expect(() => recordProfileBeer(db, 99_999, { global_rating: 4.0, global_rating_shown: true, abv: 5.0 }, NOW_ISO)).not.toThrow();
    expect(catalogVersion()).toBe(v0);
  });
});

// --- #614: аліаси в каталозі матчера ------------------------------------------------------------
import { loadAliases } from './beers';

describe('loadAliases (#614)', () => {
  function canonicalWithAlias(db: ReturnType<typeof fresh>, untappdId: number | null) {
    const canonicalId = seedBeer(db, {
      untappd_id: untappdId, name: 'Black Bean', brewery: 'Varvar Brew',
      style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, created_at)
       VALUES (?, 'VARVAR', 'BLACK BEAN IS', ?, ?, '2026-09-14T07:13:20Z')`,
    ).run(canonicalId, cardText('VARVAR'), cardText('BLACK BEAN IS'));
    return canonicalId;
  }

  test('returns each alias of a linked row with its exact card text', () => {
    const db = fresh();
    const canonicalId = canonicalWithAlias(db, 3548624);
    expect(loadAliases(db)).toEqual([{ beer_id: canonicalId, brewery_text: 'varvar', name_text: 'black bean is' }]);
  });

  test('skips an alias whose canonical row has no untappd_id', () => {
    const db = fresh();
    canonicalWithAlias(db, null);
    expect(loadAliases(db)).toEqual([]);
  });
});
