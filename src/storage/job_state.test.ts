import { openDb } from './db';
import { migrate } from './schema';
import { getJobState, setJobState } from './job_state';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('getJobState: returns null for an unknown key', () => {
  const db = emptyDb();
  expect(getJobState(db, 'nope')).toBeNull();
});

test('setJobState then getJobState: round-trips the value', () => {
  const db = emptyDb();
  setJobState(db, 'daily_status_last_sent', '2026-06-21');
  expect(getJobState(db, 'daily_status_last_sent')).toBe('2026-06-21');
});

test('setJobState: upserts (updates in place, no duplicate row)', () => {
  const db = emptyDb();
  setJobState(db, 'k', '2026-06-21');
  setJobState(db, 'k', '2026-06-22');
  expect(getJobState(db, 'k')).toBe('2026-06-22');
  const count = (db.prepare('SELECT COUNT(*) AS n FROM job_state').get() as { n: number }).n;
  expect(count).toBe(1);
});
