import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createSnapshot, insertTaps } from '../../storage/snapshots';
import { upsertBeer } from '../../storage/beers';
import { upsertMatch } from '../../storage/match_links';
import { createTranslator } from '../../i18n';
import { setFilters } from '../../storage/user_filters';
import { ensureProfile } from '../../storage/user_profiles';
import { buildNewbeersMessage, filterPubsByQuery } from './newbeers-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Fixture: two pubs each with one matched tap. Used by several pubQuery tests.
function seedTwoPubs(db: ReturnType<typeof fresh>) {
  const pubA = upsertPub(db, {
    slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null, city: 'warszawa',
  });
  const pubB = upsertPub(db, {
    slug: 'pub-b', name: 'Pub B', address: null, lat: null, lon: null, city: 'warszawa',
  });
  const snapA = createSnapshot(db, pubA, '2026-05-25T12:00:00Z');
  const snapB = createSnapshot(db, pubB, '2026-05-25T12:00:00Z');
  const beerA = upsertBeer(db, {
    untappd_id: 1, name: 'Atak Chmielu', brewery: 'Pinta', style: 'AIPA',
    abv: 6.1, rating_global: 3.85,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  const beerB = upsertBeer(db, {
    untappd_id: 2, name: 'Buty Skejta', brewery: 'Stu Mostow', style: 'Pils',
    abv: 5.0, rating_global: 3.5,
    normalized_name: 'buty skejta', normalized_brewery: 'stu mostow',
  });
  upsertMatch(db, 'PINTA Atak Chmielu', beerA, 1.0);
  upsertMatch(db, 'Stu Mostow Buty Skejta', beerB, 1.0);
  insertTaps(db, snapA, [{
    tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA',
    abv: 6.1, ibu: null, style: 'AIPA', u_rating: 3.9,
  }]);
  insertTaps(db, snapB, [{
    tap_number: 1, beer_ref: 'Stu Mostow Buty Skejta', brewery_ref: 'Stu Mostow',
    abv: 5.0, ibu: null, style: 'Pils', u_rating: 3.7,
  }]);
}

function seedOrphanAndEmptyTap(db: ReturnType<typeof fresh>) {
  const pubId = upsertPub(db, {
    slug: 'orphan-pub', name: 'Orphan Pub', address: null, lat: null, lon: null, city: 'warszawa',
  });
  const snapId = createSnapshot(db, pubId, '2026-06-21T00:00:00Z');
  const mysteryId = upsertBeer(db, {
    name: 'Mystery Beer', brewery: 'Mystery Brewery', style: 'IPA', abv: 6,
    rating_global: null, normalized_name: 'mystery beer', normalized_brewery: 'mystery brewery',
  });
  const emptyId = upsertBeer(db, {
    name: 'N/A', brewery: 'N/A', style: null, abv: null, rating_global: null,
    normalized_name: 'n a', normalized_brewery: 'n a',
  });
  upsertMatch(db, 'Mystery Beer', mysteryId, 1);
  upsertMatch(db, 'N/A', emptyId, 1);
  insertTaps(db, snapId, [
    { tap_number: 1, beer_ref: 'Mystery Beer', brewery_ref: 'Mystery Brewery', abv: 6, ibu: null, style: 'IPA', u_rating: null },
    { tap_number: 2, beer_ref: 'N/A', brewery_ref: null, abv: null, ibu: null, style: null, u_rating: null },
  ]);
}

describe('buildNewbeersMessage', () => {
  test('returns kind=empty when there are no snapshots at all', () => {
    const db = fresh();
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' })).toEqual({ kind: 'empty' });
  });

  test('returns kind=empty when snapshots exist but no tap survives filtering', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'P', address: null, lat: null, lon: null, city: 'warszawa' });
    const snapId = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    void snapId; // no taps inserted
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' })).toEqual({ kind: 'empty' });
  });

  test('returns kind=ok with HTML containing the beer when a matched tap exists', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return; // type narrow
    expect(out.html).toContain('Atak Chmielu');
    expect(out.html).toContain('Pub A');
    expect(out.html).toContain('Buty Skejta');
    expect(out.html).toContain('Pub B');
    expect(out.html).toContain('• AIPA');
    expect(out.html).toContain('• Pils');
  });

  test('unfiltered results keep ordinary orphans but always hide N/A taps', () => {
    const db = fresh();
    seedOrphanAndEmptyTap(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('Mystery Beer');
    expect(out.html).not.toContain('<b>N/A</b>');
  });

  test('active user filters hide ordinary orphans', () => {
    const db = fresh();
    seedOrphanAndEmptyTap(db);
    ensureProfile(db, 1);
    setFilters(db, 1, {
      styles: [], min_rating: null, abv_min: null, abv_max: 8, default_route_n: null,
    });
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' }))
      .toEqual({ kind: 'empty' });
  });

  test('returns kind=empty when the user has already tried (triedBeerIds) the only tap', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null, city: 'warszawa',
    });
    const snapId = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 200, name: 'Buty Skejta', brewery: 'Stu Mostow', style: 'Pils',
      abv: 5.0, rating_global: 3.5,
      normalized_name: 'buty skejta', normalized_brewery: 'stu mostow',
    });
    upsertMatch(db, 'Stu Mostow Buty Skejta', beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: 'Stu Mostow Buty Skejta', brewery_ref: 'Stu Mostow',
      abv: 5.0, ibu: null, style: 'Pils', u_rating: 3.7,
    }]);
    db.prepare(
      'INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)',
    ).run(1, beerId, '2026-05-25T11:00:00Z');
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, city: 'warszawa' })).toEqual({ kind: 'empty' });
  });

  test('pubQuery="A" (case-insensitive substring) keeps only Pub A', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: 'A', city: 'warszawa' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('Atak Chmielu');
    expect(out.html).toContain('Pub A');
    expect(out.html).not.toContain('Buty Skejta');
    expect(out.html).not.toContain('Pub B');
  });

  test('pubQuery matching several pubs groups them into one entry per beer', () => {
    const db = fresh();
    const pubX = upsertPub(db, { slug: 'pub-x', name: 'Pub X', address: null, lat: null, lon: null, city: 'warszawa' });
    const pubY = upsertPub(db, { slug: 'pub-y', name: 'Pub Y', address: null, lat: null, lon: null, city: 'warszawa' });
    const snapX = createSnapshot(db, pubX, '2026-05-25T12:00:00Z');
    const snapY = createSnapshot(db, pubY, '2026-05-25T12:00:00Z');
    const beer = upsertBeer(db, {
      untappd_id: 50, name: 'Shared Brew', brewery: 'Co-op', style: 'IPA',
      abv: 6.0, rating_global: 3.7,
      normalized_name: 'shared brew', normalized_brewery: 'co op',
    });
    upsertMatch(db, 'Co-op Shared Brew', beer, 1.0);
    for (const snapId of [snapX, snapY]) {
      insertTaps(db, snapId, [{
        tap_number: 1, beer_ref: 'Co-op Shared Brew', brewery_ref: 'Co-op',
        abv: 6.0, ibu: null, style: 'IPA', u_rating: 3.7,
      }]);
    }

    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: 'Pub', city: 'warszawa' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('Shared Brew');
    expect(out.html).toContain('Pub X');
    expect(out.html).toContain('Pub Y');
  });

  test('pubQuery with no match returns kind=pub_not_found preserving the original query', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: 'nonexistent', city: 'warszawa' });
    expect(out).toEqual({ kind: 'pub_not_found', query: 'nonexistent' });
  });

  test('pub_not_found preserves leading/trailing whitespace in the original query', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: '  Nope  ', city: 'warszawa' });
    expect(out).toEqual({ kind: 'pub_not_found', query: '  Nope  ' });
  });

  test('whitespace-only pubQuery is treated as no filter', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: '   ', city: 'warszawa' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Both pubs visible — same as no-arg call.
    expect(out.html).toContain('Pub A');
    expect(out.html).toContain('Pub B');
  });
});

describe('filterPubsByQuery', () => {
  const pubChmielna = {
    id: 1, slug: 'pinta-chmielna', name: 'PINTA Warszawa',
    address: 'Chmielna 7/9, Warszawa', lat: null, lon: null, city: 'warszawa',
  };
  const pubNowogrodzka = {
    id: 2, slug: 'pinta-nowogrodzka', name: 'PINTA Warszawa',
    address: 'Nowogrodzka 4, Warszawa', lat: null, lon: null, city: 'warszawa',
  };
  const pubKufel = {
    id: 3, slug: 'kufel', name: 'Kufel i Chmiel',
    address: 'Nowy Swiat 22, Warszawa', lat: null, lon: null, city: 'warszawa',
  };
  const allPubs = [pubChmielna, pubNowogrodzka, pubKufel];

  test('unique name-match returns that pub without address check', () => {
    expect(filterPubsByQuery(allPubs, 'kufel')).toEqual([pubKufel]);
  });

  test('2 name-matches without disambiguating word returns both', () => {
    expect(filterPubsByQuery(allPubs, 'pinta warszawa')).toEqual([pubChmielna, pubNowogrodzka]);
  });

  test('2 name-matches + address word narrows to Nowogrodzka', () => {
    expect(filterPubsByQuery(allPubs, 'pinta nowogrodzka')).toEqual([pubNowogrodzka]);
  });

  test('2 name-matches + address word narrows to Chmielna', () => {
    expect(filterPubsByQuery(allPubs, 'pinta chmielna')).toEqual([pubChmielna]);
  });

  test('0 name-matches uses address fallback', () => {
    expect(filterPubsByQuery(allPubs, 'nowogrodzka')).toEqual([pubNowogrodzka]);
  });

  test('unknown query returns empty array', () => {
    expect(filterPubsByQuery(allPubs, 'xxxxxx')).toEqual([]);
  });
});
