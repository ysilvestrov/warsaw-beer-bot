import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import pino from 'pino';
import { upsertBeer } from '../storage/beers';
import { upsertMatch } from '../storage/match_links';
import { mergeCheckin } from '../storage/checkins';
import { ensureProfile } from '../storage/user_profiles';
import { dedupeBreweryAliases } from './dedupe-brewery-aliases';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const silentLog = pino({ level: 'silent' });

describe('dedupeBreweryAliases', () => {
  test('returns zero when catalog is clean', () => {
    const db = fresh();
    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 0, beersDeleted: 0 });
  });

  test('merges Piwne-Podziemie style alias pair', () => {
    const db = fresh();
    // Canonical Untappd-side row.
    const aId = upsertBeer(db, {
      untappd_id: 1905189,
      name: 'Juicilicious',
      brewery: 'Piwne Podziemie / Beer Underground',
      style: 'NEIPA',
      abv: 6.0,
      rating_global: null,
      normalized_name: 'juicilicious',
      normalized_brewery: 'piwne podziemie beer underground',
    });
    // Orphan ontap-side row.
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Juicilicious',
      brewery: 'Piwne Podziemie Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'juicilicious',
      normalized_brewery: 'piwne podziemie',
    });
    upsertMatch(db, 'Juicilicious', bId, 1.0);

    // User check-in on canonical row.
    ensureProfile(db, 207079110);
    mergeCheckin(db, {
      checkin_id: 'ck-1',
      telegram_id: 207079110,
      beer_id: aId,
      user_rating: 4.25,
      checkin_at: '2026-04-01T00:00:00Z',
      venue: null,
    });

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 1, beersDeleted: 1 });

    // match_links now points to canonical row.
    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Juicilicious') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);

    // Orphan row gone.
    const orphan = db.prepare('SELECT id FROM beers WHERE id = ?').get(bId);
    expect(orphan).toBeUndefined();

    // Canonical row intact, check-in intact.
    const canon = db.prepare('SELECT id, untappd_id FROM beers WHERE id = ?').get(aId) as { id: number; untappd_id: number };
    expect(canon.untappd_id).toBe(1905189);
    const ck = db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?').get('ck-1') as { beer_id: number };
    expect(ck.beer_id).toBe(aId);
  });

  test('moves checkins from orphan onto canonical when both have check-ins', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 12345, name: 'Y', brewery: 'X / Y',
      style: null, abv: null, rating_global: null,
      normalized_name: 'y', normalized_brewery: 'x y',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'Y', brewery: 'X',
      style: null, abv: null, rating_global: null,
      normalized_name: 'y', normalized_brewery: 'x',
    });
    ensureProfile(db, 1);
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 1, beer_id: aId, user_rating: 4.0, checkin_at: '2026-01-01T00:00:00Z', venue: null });
    mergeCheckin(db, { checkin_id: 'b', telegram_id: 1, beer_id: bId, user_rating: 3.5, checkin_at: '2026-01-02T00:00:00Z', venue: null });

    dedupeBreweryAliases(db, silentLog);

    const all = db.prepare('SELECT checkin_id, beer_id FROM checkins ORDER BY checkin_id').all() as { checkin_id: string; beer_id: number }[];
    expect(all).toEqual([
      { checkin_id: 'a', beer_id: aId },
      { checkin_id: 'b', beer_id: aId },
    ]);
  });

  test('handles collab orphan (right-side ontap brewery)', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 999, name: 'Son Of The Son', brewery: 'AleBrowar / Poppels Bryggeri',
      style: null, abv: 8.0, rating_global: null,
      normalized_name: 'son of son', normalized_brewery: 'alebrowar poppels bryggeri',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'Son Of The Son', brewery: 'Poppels Bryggeri Brewery',
      style: null, abv: null, rating_global: null,
      normalized_name: 'son of son', normalized_brewery: 'poppels bryggeri',
    });
    upsertMatch(db, 'Son Of The Son', bId, 1.0);

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result.pairsMerged).toBe(1);

    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Son Of The Son') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);
  });

  test('does NOT merge when the orphan brewery is unrelated', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 111, name: 'Z', brewery: 'X / Y',
      style: null, abv: null, rating_global: null,
      normalized_name: 'z', normalized_brewery: 'x y',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'Z', brewery: 'Browar Stu Mostów',
      style: null, abv: null, rating_global: null,
      normalized_name: 'z', normalized_brewery: 'stu mostow',
    });

    const result = dedupeBreweryAliases(db, silentLog);
    expect(result).toEqual({ pairsMerged: 0, beersDeleted: 0 });
    // Both rows still present.
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(aId)).toBeDefined();
    expect(db.prepare('SELECT id FROM beers WHERE id = ?').get(bId)).toBeDefined();
  });

  test('idempotent — second run is a no-op', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: 1, name: 'N', brewery: 'X / Y',
      style: null, abv: null, rating_global: null,
      normalized_name: 'n', normalized_brewery: 'x y',
    });
    const bId = upsertBeer(db, {
      untappd_id: null, name: 'N', brewery: 'X',
      style: null, abv: null, rating_global: null,
      normalized_name: 'n', normalized_brewery: 'x',
    });
    upsertMatch(db, 'N', bId, 1.0);

    const r1 = dedupeBreweryAliases(db, silentLog);
    expect(r1.pairsMerged).toBe(1);
    const r2 = dedupeBreweryAliases(db, silentLog);
    expect(r2).toEqual({ pairsMerged: 0, beersDeleted: 0 });
  });

  test('merges paren-form alias pair (Kemker Kultuur case)', () => {
    const db = fresh();
    // Canonical Untappd-side row — brewery in "X (Y)" form.
    const aId = upsertBeer(db, {
      untappd_id: 2133795,
      name: 'Stadt Land Bier',
      brewery: 'Kemker Kultuur (Brauerei J. Kemker)',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'stadt land bier',
      normalized_brewery: 'kemker kultuur brauerei j kemker',
    });
    // Orphan ontap-side row — normalized brewery matches one alias half.
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Stadt Land Bier',
      brewery: 'Kemker Kultuur Brewery',
      style: null,
      abv: null,
      rating_global: null,
      normalized_name: 'stadt land bier',
      normalized_brewery: 'kemker kultuur',
    });
    upsertMatch(db, 'Stadt Land Bier', bId, 1.0);
    ensureProfile(db, 42);
    mergeCheckin(db, {
      checkin_id: 'kemker-1',
      telegram_id: 42,
      beer_id: bId,
      user_rating: 4.5,
      checkin_at: '2026-05-10T12:00:00Z',
      venue: null,
    });

    const result = dedupeBreweryAliases(db, silentLog);

    expect(result).toEqual({ pairsMerged: 1, beersDeleted: 1 });
    // Orphan deleted.
    const orphan = db.prepare('SELECT id FROM beers WHERE id = ?').get(bId);
    expect(orphan).toBeUndefined();
    // Canonical survives.
    const canonical = db.prepare('SELECT id FROM beers WHERE id = ?').get(aId);
    expect(canonical).toEqual({ id: aId });
    // match_link transferred to canonical.
    const link = db
      .prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Stadt Land Bier') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(aId);
    // Checkin re-pointed to canonical.
    const checkin = db
      .prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?')
      .get('kemker-1') as { beer_id: number };
    expect(checkin.beer_id).toBe(aId);
  });
});
