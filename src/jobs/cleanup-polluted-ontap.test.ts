import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertBeer } from '../storage/beers';
import { cleanupPollutedOntap } from './cleanup-polluted-ontap';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function getRow(db: ReturnType<typeof openDb>, id: number) {
  return db.prepare('SELECT id, name, brewery, normalized_name, normalized_brewery, untappd_id FROM beers WHERE id = ?').get(id) as
    | { id: number; name: string; brewery: string; normalized_name: string; normalized_brewery: string; untappd_id: number | null }
    | undefined;
}

describe('cleanupPollutedOntap', () => {
  test('empty DB → no-op', () => {
    const db = fresh();
    expect(cleanupPollutedOntap(db, silentLog)).toEqual({ rewritten: 0, merged: 0 });
  });

  test('single polluted row, no canonical → rewrite in place', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 1, merged: 0 });

    const row = getRow(db, id)!;
    expect(row.name).toBe('Oxymel');
    expect(row.normalized_name).toBe('oxymel');
    expect(row.brewery).toBe('Wagabunda Brewery');
    expect(row.normalized_brewery).toBe('wagabunda');
  });

  test('polluted + ontap canonical → merge with match_links + checkins repointed', () => {
    const db = fresh();
    const cleanId = upsertBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const pollutedId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    db.prepare(
      'INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence) VALUES (?, ?, ?)',
    ).run('Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale', pollutedId, 1.0);
    db.prepare(
      'INSERT INTO checkins (checkin_id, telegram_id, beer_id, checkin_at) VALUES (?, ?, ?, ?)',
    ).run('chk-1', 42, pollutedId, '2026-04-01 12:00:00');

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 1 });

    expect(getRow(db, pollutedId)).toBeUndefined();
    expect(getRow(db, cleanId)?.name).toBe('Oxymel');

    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?')
      .get('Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale') as { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(cleanId);

    const checkin = db.prepare('SELECT beer_id FROM checkins WHERE checkin_id = ?')
      .get('chk-1') as { beer_id: number };
    expect(checkin.beer_id).toBe(cleanId);
  });

  test('polluted ontap-side row merges into untappd-side canonical (cross-source)', () => {
    const db = fresh();
    const untappdId = upsertBeer(db, {
      untappd_id: 12345,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: 3.7,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const pollutedId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 1 });
    expect(getRow(db, pollutedId)).toBeUndefined();
    expect(getRow(db, untappdId)?.untappd_id).toBe(12345);
    expect(getRow(db, untappdId)?.name).toBe('Oxymel');
  });

  test('two polluted rows resolving to the same clean name, no canonical → both rewrite (become duplicates)', () => {
    const db = fresh();
    const aId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    const bId = upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 12°·4,2% — Sour',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.2,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 12 4 2',
      normalized_brewery: 'wagabunda',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 2, merged: 0 });

    expect(getRow(db, aId)?.name).toBe('Oxymel');
    expect(getRow(db, aId)?.normalized_name).toBe('oxymel');
    expect(getRow(db, bId)?.name).toBe('Oxymel');
    expect(getRow(db, bId)?.normalized_name).toBe('oxymel');
  });

  test('idempotent: second invocation returns {0, 0}', () => {
    const db = fresh();
    upsertBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const first = cleanupPollutedOntap(db, silentLog);
    expect(first).toEqual({ rewritten: 1, merged: 0 });

    const second = cleanupPollutedOntap(db, silentLog);
    expect(second).toEqual({ rewritten: 0, merged: 0 });
  });

  test('clean rows preserved — no pollution markers means no touching', () => {
    const db = fresh();
    const cleanId = upsertBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const untappdRowId = upsertBeer(db, {
      untappd_id: 99,
      name: 'Some Brewery Stuff 14°·5%',
      brewery: 'Some Brewery',
      style: null,
      abv: 5.0,
      rating_global: 3.5,
      normalized_name: 'some stuff 14 5',
      normalized_brewery: 'some',
    });

    const result = cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 0 });
    expect(getRow(db, cleanId)?.name).toBe('Oxymel');
    expect(getRow(db, untappdRowId)?.name).toBe('Some Brewery Stuff 14°·5%');
  });
});
