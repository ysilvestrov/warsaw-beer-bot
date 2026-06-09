import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { getReleaseByVersion } from '../src/storage/extension_releases';

const PROD_DB = '/var/lib/warsaw-beer-bot/bot.db';

function hasSqlite(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v sqlite3'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Patch the hard-coded prod DB path to a temp DB so the wrapper can be exercised without
// sudo. The installed prod copy stays literal — asserted below.
function installPatched(dbPath: string): string {
  const src = readFileSync(
    resolve(__dirname, '..', 'deploy', 'bin', 'apply-extension-release.sh'),
    'utf8',
  );
  expect(src).toContain(PROD_DB);
  const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
  const script = join(dir, 'apply.sh');
  writeFileSync(script, src.replace(PROD_DB, dbPath));
  chmodSync(script, 0o755);
  return script;
}

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wrapdb-'));
  const dbPath = join(dir, 'bot.db');
  const db = openDb(dbPath);
  migrate(db);
  db.close();
  return dbPath;
}

(hasSqlite() ? describe : describe.skip)('apply-extension-release.sh', () => {
  it('upserts a row, preserving single quotes in notes', () => {
    const dbPath = makeDb();
    const script = installPatched(dbPath);
    execFileSync(script, ['0.2.0', 'a'.repeat(64)], { input: "Don't break" });

    const db = openDb(dbPath);
    const row = getReleaseByVersion(db, '0.2.0')!;
    db.close();
    expect(row.sha256).toBe('a'.repeat(64));
    expect(row.notes).toBe("Don't break");
    expect(row.file_id).toBeNull();
  });

  it('is idempotent on version (second run updates sha256 + notes)', () => {
    const dbPath = makeDb();
    const script = installPatched(dbPath);
    execFileSync(script, ['0.2.0', 'a'.repeat(64)], { input: 'first' });
    execFileSync(script, ['0.2.0', 'b'.repeat(64)], { input: 'second' });

    const db = openDb(dbPath);
    const row = getReleaseByVersion(db, '0.2.0')!;
    db.close();
    expect(row.sha256).toBe('b'.repeat(64));
    expect(row.notes).toBe('second');
  });

  it('rejects a malformed version with exit code 2', () => {
    const dbPath = makeDb();
    const script = installPatched(dbPath);
    let status: number | null = null;
    try {
      execFileSync(script, ['not-semver', 'a'.repeat(64)], { input: 'n', stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
