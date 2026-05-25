import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createSnapshot, insertTaps } from '../../storage/snapshots';
import { upsertBeer } from '../../storage/beers';
import { upsertMatch } from '../../storage/match_links';
import { createTranslator } from '../../i18n';
import { buildNewbeersMessage } from './newbeers-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('buildNewbeersMessage', () => {
  test('returns null when there are no snapshots at all', () => {
    const db = fresh();
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toBeNull();
  });

  test('returns null when snapshots exist but no tap survives filtering', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'P', address: null, lat: null, lon: null });
    const snapId = createSnapshot(db, pubId, '2026-05-24T12:00:00Z');
    // Tap with no match_links row → beer_id is NULL, but filterInteresting
    // still allows it under default filters. To force an empty result we
    // simply do not insert any taps at all.
    void snapId;
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toBeNull();
  });

  test('returns non-null HTML containing the beer when a matched tap exists', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-24T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 100,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'AIPA',
      abv: 6.1,
      rating_global: 3.85,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
    insertTaps(db, snapId, [
      {
        tap_number: 1,
        beer_ref: 'PINTA Atak Chmielu',
        brewery_ref: 'PINTA',
        abv: 6.1,
        ibu: null,
        style: 'AIPA',
        u_rating: 3.9,
      },
    ]);

    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t });
    expect(out).not.toBeNull();
    expect(out).toContain('Atak Chmielu');
    expect(out).toContain('Pub A');
  });

  test('returns null when the user has already tried (triedBeerIds) the only tap', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-24T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 200,
      name: 'Buty Skejta',
      brewery: 'Stu Mostow',
      style: 'Pils',
      abv: 5.0,
      rating_global: 3.5,
      normalized_name: 'buty skejta',
      normalized_brewery: 'stu mostow',
    });
    upsertMatch(db, 'Stu Mostow Buty Skejta', beerId, 1.0);
    insertTaps(db, snapId, [
      {
        tap_number: 1,
        beer_ref: 'Stu Mostow Buty Skejta',
        brewery_ref: 'Stu Mostow',
        abv: 5.0,
        ibu: null,
        style: 'Pils',
        u_rating: 3.7,
      },
    ]);

    // Mark the user as having had this beer via untappd_had.
    db.prepare(
      'INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)',
    ).run(1, beerId, '2026-05-24T11:00:00Z');

    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toBeNull();
  });
});
