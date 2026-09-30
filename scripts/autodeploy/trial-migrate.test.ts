import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Merge-deploy step 5: the NEW build's migrate() on a COPY of production,
 * twice, then foreign_key_check and integrity_check. The clone here is fake —
 * a dist/storage/schema.js written per test — but SQLite is real.
 */
const SCRIPT = resolve(__dirname, '../../deploy/trial-migrate.cjs');
const NODE_MODULES = resolve(__dirname, '../../node_modules');

/** What production's openDb does that matters here: foreign keys ON (R1). */
const OPEN_DB = `exports.openDb = (p) => {
  const Database = require('better-sqlite3');
  const db = new Database(p);
  db.pragma('foreign_keys = ON');
  return db;
};`;

function fakeClone(schemaJs: string | null, dbJs: string | null = OPEN_DB): string {
  const clone = makeTempDirectory('wbb-trial-clone-');
  symlinkSync(NODE_MODULES, join(clone, 'node_modules'));
  mkdirSync(join(clone, 'dist', 'storage'), { recursive: true });
  if (schemaJs !== null) writeFileSync(join(clone, 'dist', 'storage', 'schema.js'), schemaJs);
  if (dbJs !== null) writeFileSync(join(clone, 'dist', 'storage', 'db.js'), dbJs);
  return clone;
}

/** A copy "of production": schema_version at 1, plus whatever `extra` adds. */
function dbAtV1(extra = ''): string {
  const p = join(makeTempDirectory('wbb-trial-db-'), 'trial.db');
  const db = new Database(p);
  db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (1);');
  db.pragma('foreign_keys = OFF');
  if (extra) db.exec(extra);
  db.close();
  return p;
}

function trial(...args: string[]): { code: number | null; first: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, first: r.stdout.split('\n')[0] };
}

const TO_V2 = `exports.migrate = (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS t2(id INTEGER PRIMARY KEY)');
  db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (2)');
};`;

describe('trial-migrate.cjs', () => {
  it('reports the schema move of a sound, idempotent migration', () => {
    const r = trial(fakeClone(TO_V2), dbAtV1());
    expect(r.code).toBe(0);
    expect(r.first).toBe('TRIAL OK: schema 1 -> 2');
  });

  it('fails when migrate() throws', () => {
    const r = trial(fakeClone(`exports.migrate = () => { throw new Error('boom v2'); };`), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toBe('TRIAL FAILED: boom v2');
  });

  it('fails when a second migrate() moves the schema again', () => {
    const bumpEveryCall = `exports.migrate = (db) => {
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(v + 1);
    };`;
    const r = trial(fakeClone(bumpEveryCall), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toBe('TRIAL FAILED: a second migrate() moved the schema: 2 -> 3');
  });

  it('fails when the migrated database has a foreign-key violation', () => {
    const orphanChild = `CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      INSERT INTO child VALUES (1, 99);`;
    const r = trial(fakeClone(TO_V2), dbAtV1(orphanChild));
    expect(r.code).toBe(1);
    expect(r.first).toMatch(/^TRIAL FAILED: foreign_key_check: 1 violation\(s\), first /);
  });

  it('fails, not crashes, when the clone has no build', () => {
    const r = trial(fakeClone(null), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toMatch(/^TRIAL FAILED: Cannot find module /);
  });

  it('exits 64 without both arguments', () => {
    expect(trial('only-one').code).toBe(64);
  });

  it('enforces foreign keys during the trial, so a table rebuild with referencing rows fails', () => {
    const referenced = `CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1, 1);`;
    const rebuildParent = `exports.migrate = (db) => {
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      if (v >= 2) return;
      db.exec('DROP TABLE parent');
      db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY)');
      db.exec('INSERT INTO schema_version(version) VALUES (2)');
    };`;
    const r = trial(fakeClone(rebuildParent), dbAtV1(referenced));
    expect(r.code).toBe(1);
    expect(r.first).toBe('TRIAL FAILED: FOREIGN KEY constraint failed');
  });

  it('fails, not crashes, when the build has no openDb', () => {
    const r = trial(fakeClone(TO_V2, null), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toMatch(/^TRIAL FAILED: Cannot find module '.*dist\/storage\/db\.js'/);
  });

  it('fails when the migrated database does not pass integrity_check', () => {
    const p = dbAtV1();
    // An index whose declared collation no longer matches its stored order:
    // SQLite opens it, and integrity_check reports the rows it cannot find.
    execFileSync('sqlite3', ['-cmd', '.dbconfig defensive off', p,
      "CREATE TABLE t(a TEXT); INSERT INTO t VALUES ('a'),('B'),('c'),('D'); CREATE INDEX i ON t(a); " +
      "PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql='CREATE INDEX i ON t(a COLLATE NOCASE)' WHERE name='i';"],
      { stdio: 'ignore' });
    const r = trial(fakeClone(TO_V2), p);
    expect(r.code).toBe(1);
    expect(r.first).toBe('TRIAL FAILED: integrity_check: [{"integrity_check":"row 1 missing from index i"},{"integrity_check":"row 3 missing from index i"}]');
  });
});
