import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { seedBeer } from '../storage/seed-beer.testing';
import { catalogVersion } from '../storage/catalog-version';
import { cleanupPollutedOntap } from './cleanup-polluted-ontap';
import { cardAbv, cardText } from '../domain/card-text';
import { insertLegacyDisposition } from '../storage/legacy-orphan-dispositions';

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
  test('does not rewrite or delete an inactive polluted row', async () => {
    const db = fresh();
    const name = 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale';
    const old = seedBeer(db, {
      untappd_id: null, name, brewery: 'Wagabunda Brewery', style: null, abv: 4.5,
      rating_global: null, normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    insertLegacyDisposition(db, {
      beerId: old, issueNumber: 677, cardBrewery: 'Wagabunda Brewery', cardName: name, cardAbv: 4.5,
      breweryText: cardText('Wagabunda Brewery'), nameText: cardText(name), abvKey: cardAbv(4.5),
      failureSourceUrl: '', reason: 'Identity unknown', evidenceUrl: 'https://example.com/evidence',
      operator: 'test', inactiveAt: '2026-09-23T00:00:00Z',
    });
    expect(await cleanupPollutedOntap(db, silentLog)).toEqual({ rewritten: 0, merged: 0 });
    expect(getRow(db, old)?.name).toBe(name);
    db.close();
  });

  test('does not merge a live polluted row into an inactive catalog target', async () => {
    const db = fresh();
    const target = seedBeer(db, {
      untappd_id: null, name: 'Oxymel 14°', brewery: 'Wagabunda Brewery',
      style: null, abv: 4.5, rating_global: null,
      normalized_name: 'oxymel', normalized_brewery: 'wagabunda',
    });
    insertLegacyDisposition(db, {
      beerId: target, issueNumber: 677, cardBrewery: 'Wagabunda Brewery', cardName: 'Oxymel 14°', cardAbv: 4.5,
      breweryText: cardText('Wagabunda Brewery'), nameText: cardText('Oxymel 14°'), abvKey: cardAbv(4.5),
      failureSourceUrl: '', reason: 'Identity unknown', evidenceUrl: 'https://example.com/evidence',
      operator: 'test', inactiveAt: '2026-09-23T00:00:00Z',
    });
    const polluted = seedBeer(db, {
      untappd_id: null, name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery', style: null, abv: 4.5, rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale', normalized_brewery: 'wagabunda',
    });
    expect(await cleanupPollutedOntap(db, silentLog)).toEqual({ rewritten: 1, merged: 0 });
    expect(getRow(db, target)?.name).toBe('Oxymel 14°');
    expect(getRow(db, polluted)?.name).toBe('Oxymel 14°');
    db.close();
  });

  test('does not execute a prepared rewrite after an operator seals the source', async () => {
    const db = fresh();
    const name = 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale';
    const old = seedBeer(db, {
      untappd_id: null, name, brewery: 'Wagabunda Brewery', style: null, abv: 4.5,
      rating_global: null, normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    const running = cleanupPollutedOntap(db, silentLog);
    insertLegacyDisposition(db, {
      beerId: old, issueNumber: 677, cardBrewery: 'Wagabunda Brewery', cardName: name, cardAbv: 4.5,
      breweryText: cardText('Wagabunda Brewery'), nameText: cardText(name), abvKey: cardAbv(4.5),
      failureSourceUrl: '', reason: 'Identity unknown', evidenceUrl: 'https://example.com/evidence',
      operator: 'test', inactiveAt: '2026-09-23T00:00:00Z',
    });
    expect(await running).toEqual({ rewritten: 0, merged: 0 });
    expect(getRow(db, old)?.name).toBe(name);
    db.close();
  });
  test('empty DB → no-op', async () => {
    const db = fresh();
    expect(await cleanupPollutedOntap(db, silentLog)).toEqual({ rewritten: 0, merged: 0 });
  });

  test('single polluted row, no canonical → rewrite in place', async () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const v = catalogVersion();
    const result = await cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 1, merged: 0 });
    expect(catalogVersion()).toBeGreaterThan(v);

    const row = getRow(db, id)!;
    // #306: the trailing °Plato grade is part of the identity and stays in the stored
    // name; only the ABV tail and the appended style are stripped. `normalized_name`
    // drops the grade on its own, so matching is unaffected.
    expect(row.name).toBe('Oxymel 14°');
    expect(row.normalized_name).toBe('oxymel');
    expect(row.brewery).toBe('Wagabunda Brewery');
    expect(row.normalized_brewery).toBe('wagabunda');
  });

  test('polluted + ontap canonical → merge with match_links + checkins repointed', async () => {
    const db = fresh();
    const cleanId = seedBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const pollutedId = seedBeer(db, {
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

    const result = await cleanupPollutedOntap(db, silentLog);
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

  test('polluted ontap-side row merges into untappd-side canonical (cross-source)', async () => {
    const db = fresh();
    const untappdId = seedBeer(db, {
      untappd_id: 12345,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: 3.7,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const pollutedId = seedBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const result = await cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 1 });
    expect(getRow(db, pollutedId)).toBeUndefined();
    expect(getRow(db, untappdId)?.untappd_id).toBe(12345);
    expect(getRow(db, untappdId)?.name).toBe('Oxymel');
  });

  test('two polluted rows resolving to the same normalized name, no canonical → both rewrite (become duplicates)', async () => {
    const db = fresh();
    const aId = seedBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });
    const bId = seedBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 12°·4,2% — Sour',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.2,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 12 4 2',
      normalized_brewery: 'wagabunda',
    });

    const result = await cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 2, merged: 0 });

    // #306: the two rows keep their distinct °Plato grades ("Konrad 10°" ≠ "Konrad 12°"),
    // but both normalize to the same key, so they are still duplicates for the matcher.
    expect(getRow(db, aId)?.name).toBe('Oxymel 14°');
    expect(getRow(db, aId)?.normalized_name).toBe('oxymel');
    expect(getRow(db, bId)?.name).toBe('Oxymel 12°');
    expect(getRow(db, bId)?.normalized_name).toBe('oxymel');
  });

  test('idempotent: second invocation returns {0, 0}', async () => {
    const db = fresh();
    seedBeer(db, {
      untappd_id: null,
      name: 'Wagabunda Brewery Oxymel 14°·4,5% — Sour Ale',
      brewery: 'Wagabunda Brewery',
      style: null,
      abv: 4.5,
      rating_global: null,
      normalized_name: 'wagabunda brewery oxymel 14 4 5 ale',
      normalized_brewery: 'wagabunda',
    });

    const first = await cleanupPollutedOntap(db, silentLog);
    expect(first).toEqual({ rewritten: 1, merged: 0 });

    const second = await cleanupPollutedOntap(db, silentLog);
    expect(second).toEqual({ rewritten: 0, merged: 0 });
  });

  test('clean rows preserved — no pollution markers means no touching', async () => {
    const db = fresh();
    const cleanId = seedBeer(db, {
      untappd_id: null,
      name: 'Oxymel',
      brewery: 'Wagabunda Brewery',
      style: 'Sour Ale',
      abv: 4.5,
      rating_global: null,
      normalized_name: 'oxymel',
      normalized_brewery: 'wagabunda',
    });
    const untappdRowId = seedBeer(db, {
      untappd_id: 99,
      name: 'Some Brewery Stuff 14°·5%',
      brewery: 'Some Brewery',
      style: null,
      abv: 5.0,
      rating_global: 3.5,
      normalized_name: 'some stuff 14 5',
      normalized_brewery: 'some',
    });

    const result = await cleanupPollutedOntap(db, silentLog);
    expect(result).toEqual({ rewritten: 0, merged: 0 });
    expect(getRow(db, cleanId)?.name).toBe('Oxymel');
    expect(getRow(db, untappdRowId)?.name).toBe('Some Brewery Stuff 14°·5%');
  });
});
