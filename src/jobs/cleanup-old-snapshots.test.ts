import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { upsertPub } from '../storage/pubs';
import { createSnapshot, insertTaps, tapsForSnapshot } from '../storage/snapshots';
import { cleanupOldSnapshots } from './cleanup-old-snapshots';

const silentLog = pino({ level: 'silent' });

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function snap(db: ReturnType<typeof fresh>, pubId: number, at: string): number {
  const id = createSnapshot(db, pubId, at);
  insertTaps(db, id, [{
    tap_number: 1, beer_ref: `ref-${id}`, brewery_ref: null,
    abv: null, ibu: null, style: null, u_rating: null,
  }]);
  return id;
}

describe('cleanupOldSnapshots', () => {
  test('deletes snapshots older than retentionDays, keeps recent + latest', () => {
    const db = fresh();
    const p = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null, city: 'warszawa' });
    const old = snap(db, p, '2026-05-01T12:00:00Z');   // 34 days before now
    const recent = snap(db, p, '2026-06-03T12:00:00Z'); // 1 day before now, latest
    const now = () => new Date('2026-06-04T00:00:00Z');

    const deleted = cleanupOldSnapshots(db, silentLog, 14, now);

    expect(deleted).toBe(1);
    expect(tapsForSnapshot(db, old)).toHaveLength(0);
    expect(tapsForSnapshot(db, recent)).toHaveLength(1);
  });

  test('returns 0 on an already-clean DB', () => {
    const db = fresh();
    const p = upsertPub(db, { slug: 'a', name: 'a', address: null, lat: null, lon: null, city: 'warszawa' });
    snap(db, p, '2026-06-03T12:00:00Z');
    const deleted = cleanupOldSnapshots(db, silentLog, 14, () => new Date('2026-06-04T00:00:00Z'));
    expect(deleted).toBe(0);
  });
});
