import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
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

function fakeClone(schemaJs: string | null): string {
  const clone = makeTempDirectory('wbb-trial-clone-');
  symlinkSync(NODE_MODULES, join(clone, 'node_modules'));
  if (schemaJs !== null) {
    mkdirSync(join(clone, 'dist', 'storage'), { recursive: true });
    writeFileSync(join(clone, 'dist', 'storage', 'schema.js'), schemaJs);
  }
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
});
