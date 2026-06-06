import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import pino from 'pino';
import { upsertBeer } from '../storage/beers';
import { backfillNormalizedBrewery } from './backfill-normalized-brewery';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const silentLog = pino({ level: 'silent' });

describe('backfillNormalizedBrewery', () => {
  test('recomputes stale normalized_brewery under new rules', () => {
    const db = fresh();
    const id = upsertBeer(db, {
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
    upsertBeer(db, {
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
