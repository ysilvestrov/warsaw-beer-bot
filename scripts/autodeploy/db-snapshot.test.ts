import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Merge-deploy (spec 2026-09-30, P1–P3). The rollback window is only as good
 * as these five operations, so every one runs against REAL SQLite files.
 */
const SCRIPT = resolve(__dirname, '../../deploy/db-snapshot.sh');

function snap(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function tags(p: string): string[] {
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare('SELECT tag FROM t ORDER BY id').all() as { tag: string }[]).map((r) => r.tag);
  } finally {
    db.close();
  }
}

/** A DB file whose rows are committed but still ONLY in the WAL. */
function walOnlyDb(dir: string, rows: string[]): { path: string; db: Database.Database } {
  const path = join(dir, 'bot.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, tag TEXT)');
  const ins = db.prepare('INSERT INTO t(tag) VALUES (?)');
  for (const r of rows) ins.run(r);
  return { path, db };
}

/** A closed, checkpointed DB with the given rows. */
function plainDb(path: string, rows: string[]): void {
  const db = new Database(path);
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, tag TEXT)');
  const ins = db.prepare('INSERT INTO t(tag) VALUES (?)');
  for (const r of rows) ins.run(r);
  db.close();
}

describe('db-snapshot.sh snapshot', () => {
  it('captures rows that are committed only to the WAL, and writes a matching checksum', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const { path, db } = walOnlyDb(dir, ['a', 'b']);
    // Premise: the main file alone does NOT hold the table yet — otherwise
    // this test would pass for a snapshot that ignores the WAL.
    copyFileSync(path, join(dir, 'main-only.db'));
    // Read-write on purpose: a read-only open of a WAL file without its -shm fails.
    const mainOnly = new Database(join(dir, 'main-only.db'));
    const inMain = mainOnly.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get() as { n: number };
    mainOnly.close();
    expect(inMain.n).toBe(0);

    const out = join(dir, 'snaps', '20260930T120000Z-abc1234-pre.db');
    const r = snap('snapshot', path, out);
    db.close();

    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(out);
    expect(tags(out)).toEqual(['a', 'b']);
    expect(readFileSync(`${out}.sha256`, 'utf8').trim()).toBe(sha(out));
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('refuses to overwrite an existing snapshot', () => {
    const dir = makeTempDirectory('wbb-snap-');
    plainDb(join(dir, 'bot.db'), ['a']);
    const out = join(dir, 'x-pre.db');
    writeFileSync(out, 'keep me');

    const r = snap('snapshot', join(dir, 'bot.db'), out);

    expect(r.code).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('keep me');
  });

  it('refuses a target path containing a quote instead of splicing it into SQL', () => {
    const dir = makeTempDirectory('wbb-snap-');
    plainDb(join(dir, 'bot.db'), ['a']);
    const out = join(dir, "it's-pre.db");

    const r = snap('snapshot', join(dir, 'bot.db'), out);

    expect(r.code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe('db-snapshot.sh post', () => {
  it('copies the database with its -wal and -shm byte for byte', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const { path, db } = walOnlyDb(dir, ['a']);
    const post = join(dir, 'x-rollback-post');

    const r = snap('post', path, post);
    const walSha = sha(`${path}-wal`); // before close(): closing checkpoints and deletes the WAL
    db.close();

    expect(r.code).toBe(0);
    expect(readdirSync(post).sort()).toEqual(['bot.db', 'bot.db-shm', 'bot.db-wal']);
    expect(sha(join(post, 'bot.db-wal'))).toBe(walSha);
  });
});

describe('db-snapshot.sh mark-rollback', () => {
  it('renames the snapshot and its checksum and prints the new path', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const pre = join(dir, '20260930T120000Z-abc1234-pre.db');
    writeFileSync(pre, 'db');
    writeFileSync(`${pre}.sha256`, 'h\n');

    const r = snap('mark-rollback', pre);

    const marked = join(dir, '20260930T120000Z-abc1234-rollback-pre.db');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(marked);
    expect(readdirSync(dir).sort()).toEqual([
      '20260930T120000Z-abc1234-rollback-pre.db',
      '20260930T120000Z-abc1234-rollback-pre.db.sha256',
    ]);
  });

  it('refuses a file that is not a pre snapshot, and leaves it alone', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const other = join(dir, 'bot.db');
    writeFileSync(other, 'db');

    const r = snap('mark-rollback', other);

    expect(r.code).toBe(1);
    expect(readdirSync(dir)).toEqual(['bot.db']);
  });
});

describe('db-snapshot.sh restore', () => {
  it('replaces the database with the snapshot and removes the stale -wal/-shm', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const live = join(dir, 'bot.db');
    plainDb(live, ['new']);
    writeFileSync(`${live}-wal`, 'stale wal');
    writeFileSync(`${live}-shm`, 'stale shm');
    plainDb(join(dir, 'old.db'), ['old']);
    const pre = join(dir, 's', '20260930T120000Z-abc1234-rollback-pre.db');
    expect(snap('snapshot', join(dir, 'old.db'), pre).code).toBe(0);

    const r = snap('restore', pre, live);

    expect(r.code).toBe(0);
    expect(tags(live)).toEqual(['old']);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
    expect(existsSync(`${live}.restore-partial`)).toBe(false);
  });

  it('refuses a snapshot whose checksum does not match, leaving the database untouched', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const live = join(dir, 'bot.db');
    plainDb(live, ['new']);
    plainDb(join(dir, 'old.db'), ['old']);
    const pre = join(dir, 's', 'x-rollback-pre.db');
    expect(snap('snapshot', join(dir, 'old.db'), pre).code).toBe(0);
    writeFileSync(`${pre}.sha256`, '0'.repeat(64) + '\n');

    const r = snap('restore', pre, live);

    expect(r.code).toBe(1);
    expect(tags(live)).toEqual(['new']);
  });
});

describe('db-snapshot.sh prune', () => {
  it('keeps the newest N settled snapshots and never touches a rollback pair', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const names = [
      '20260901T000000Z-aaaaaaa-rollback-pre.db',
      '20260902T000000Z-bbbbbbb-pre.db',
      '20260903T000000Z-ccccccc-pre.db',
      '20260904T000000Z-ddddddd-pre.db',
      '20260905T000000Z-eeeeeee-pre.db',
      '20260906T000000Z-fffffff-pre.db',
    ];
    for (const n of names) {
      writeFileSync(join(dir, n), n);
      writeFileSync(join(dir, `${n}.sha256`), 'h\n');
    }

    const r = snap('prune', dir, '3');

    expect(r.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([
      '20260901T000000Z-aaaaaaa-rollback-pre.db',
      '20260901T000000Z-aaaaaaa-rollback-pre.db.sha256',
      '20260904T000000Z-ddddddd-pre.db',
      '20260904T000000Z-ddddddd-pre.db.sha256',
      '20260905T000000Z-eeeeeee-pre.db',
      '20260905T000000Z-eeeeeee-pre.db.sha256',
      '20260906T000000Z-fffffff-pre.db',
      '20260906T000000Z-fffffff-pre.db.sha256',
    ]);
  });

  it('refuses keep=0 and deletes nothing', () => {
    const dir = makeTempDirectory('wbb-snap-');
    writeFileSync(join(dir, '20260902T000000Z-bbbbbbb-pre.db'), 'x');

    const r = snap('prune', dir, '0');

    expect(r.code).toBe(1);
    expect(readdirSync(dir)).toEqual(['20260902T000000Z-bbbbbbb-pre.db']);
  });
});

describe('db-snapshot.sh usage', () => {
  it('exits 64 on an unknown subcommand', () => {
    expect(snap('frobnicate').code).toBe(64);
  });
});

describe('db-snapshot.sh mark-unverified (R2/R3)', () => {
  it('renames an unwatched deploy\'s snapshot so prune keeps it', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const pre = join(dir, '20260930T120000Z-abc1234-pre.db');
    writeFileSync(pre, 'db');
    writeFileSync(`${pre}.sha256`, 'h\n');
    writeFileSync(join(dir, '20260930T130000Z-bbbbbbb-pre.db'), 'newer');
    writeFileSync(join(dir, '20260930T130000Z-bbbbbbb-pre.db.sha256'), 'h\n');

    const r = snap('mark-unverified', pre);
    const pruned = snap('prune', dir, '1');

    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(join(dir, '20260930T120000Z-abc1234-unverified-pre.db'));
    expect(pruned.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([
      '20260930T120000Z-abc1234-unverified-pre.db',
      '20260930T120000Z-abc1234-unverified-pre.db.sha256',
      '20260930T130000Z-bbbbbbb-pre.db',
      '20260930T130000Z-bbbbbbb-pre.db.sha256',
    ]);
  });

  it('refuses to re-mark a rollback snapshot', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const marked = join(dir, '20260930T120000Z-abc1234-rollback-pre.db');
    writeFileSync(marked, 'db');
    writeFileSync(`${marked}.sha256`, 'h\n');

    const r = snap('mark-unverified', marked);

    expect(r.code).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      '20260930T120000Z-abc1234-rollback-pre.db',
      '20260930T120000Z-abc1234-rollback-pre.db.sha256',
    ]);
  });
});

describe('db-snapshot.sh discard (R9)', () => {
  it('removes an unmarked pre snapshot and its checksum', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const pre = join(dir, '20260930T120000Z-abc1234-pre.db');
    writeFileSync(pre, 'db');
    writeFileSync(`${pre}.sha256`, 'h\n');

    const r = snap('discard', pre);

    expect(r.code).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never discards a marked snapshot', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const marked = join(dir, '20260930T120000Z-abc1234-rollback-pre.db');
    writeFileSync(marked, 'db');

    const r = snap('discard', marked);

    expect(r.code).toBe(1);
    expect(readdirSync(dir)).toEqual(['20260930T120000Z-abc1234-rollback-pre.db']);
  });
});
