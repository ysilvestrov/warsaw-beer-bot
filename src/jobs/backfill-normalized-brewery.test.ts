import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import pino from 'pino';
import { seedBeer } from '../storage/seed-beer.testing';
import { backfillNormalizedBrewery } from './backfill-normalized-brewery';
import { cardAbv, cardText } from '../domain/card-text';
import { insertLegacyDisposition } from '../storage/legacy-orphan-dispositions';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const silentLog = pino({ level: 'silent' });

describe('backfillNormalizedBrewery', () => {
  test('leaves the historical key of an inactive orphan untouched', () => {
    const db = fresh();
    const old = seedBeer(db, {
      untappd_id: null, name: 'Old Card', brewery: 'Harpagan Contracts',
      style: null, abv: null, rating_global: null,
      normalized_name: 'old card', normalized_brewery: 'harpagan contracts',
    });
    insertLegacyDisposition(db, {
      beerId: old, issueNumber: 677, cardBrewery: 'Harpagan Contracts', cardName: 'Old Card', cardAbv: null,
      breweryText: cardText('Harpagan Contracts'), nameText: cardText('Old Card'), abvKey: cardAbv(null),
      failureSourceUrl: '', reason: 'Identity unknown', evidenceUrl: 'https://example.com/evidence',
      operator: 'test', inactiveAt: '2026-09-23T00:00:00Z',
    });
    expect(backfillNormalizedBrewery(db, silentLog).updated).toBe(0);
    expect(db.prepare('SELECT normalized_brewery FROM beers WHERE id = ?').get(old))
      .toEqual({ normalized_brewery: 'harpagan contracts' });
    db.close();
  });
  test('recomputes stale normalized_brewery under new rules', () => {
    const db = fresh();
    const id = seedBeer(db, {
      untappd_id: 2388534,
      name: 'Buzdygan Rozkoszy',
      brewery: 'Harpagan Contracts',
      style: null,
      abv: 8.5,
      rating_global: null,
      normalized_name: 'buzdygan rozkoszy',
      normalized_brewery: 'harpagan contracts', // stale: pre-"contracts"-noise value
    });

    const result = backfillNormalizedBrewery(db, silentLog);

    expect(result.updated).toBe(1);
    const row = db.prepare('SELECT normalized_brewery FROM beers WHERE id = ?').get(id) as {
      normalized_brewery: string;
    };
    expect(row.normalized_brewery).toBe('harpagan');
  });

  test('leaves already-correct rows untouched and is idempotent', () => {
    const db = fresh();
    seedBeer(db, {
      untappd_id: 1,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: null,
      abv: 6.1,
      rating_global: null,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });

    expect(backfillNormalizedBrewery(db, silentLog).updated).toBe(0);
    expect(backfillNormalizedBrewery(db, silentLog).updated).toBe(0);
  });
});
