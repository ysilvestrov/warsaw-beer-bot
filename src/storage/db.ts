import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // Pin the WAL/litestream contention guard explicitly rather than relying on
  // better-sqlite3's implicit 5s default — a future library bump could change
  // it to 0 and silently drop the baseline that protects every writer (startup
  // jobs, crons, ad-hoc writes). The long-running import path adds a second
  // layer via withBusyRetry.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
