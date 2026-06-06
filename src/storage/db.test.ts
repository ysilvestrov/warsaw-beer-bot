import { rmSync } from 'fs';
import { openDb } from './db';

test('openDb pins a 5s busy_timeout (WAL + litestream contention guard)', () => {
  const db = openDb(':memory:');
  expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
});

test('openDb enables WAL journal mode', () => {
  // :memory: databases report "memory" journal_mode regardless of the WAL
  // request, so assert against a real temp file to verify WAL is applied.
  const path = `/tmp/wbb-db-test-${process.pid}-${Date.now()}.sqlite`;
  const fileDb = openDb(path);
  expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal');
  fileDb.close();
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
});
