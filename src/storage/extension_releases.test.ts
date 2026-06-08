import { openDb } from './db';
import { migrate } from './schema';
import {
  compareVersions,
  upsertRelease,
  latestRelease,
  getReleaseByVersion,
  attachFileId,
  listExtensionTokenHolders,
} from './extension_releases';

function seedToken(db: ReturnType<typeof openDb>, telegramId: number) {
  db.prepare('INSERT OR IGNORE INTO user_profiles (telegram_id) VALUES (?)').run(telegramId);
  db.prepare('INSERT INTO api_tokens (token_hash, telegram_id, created_at) VALUES (?, ?, ?)')
    .run(`hash-${telegramId}`, telegramId, '2026-06-08T00:00:00Z');
}

describe('extension_releases storage', () => {
  it('compareVersions orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  it('upsert + latestRelease returns the highest semver', () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.9.0', sha256: 'a', notes: 'old' });
    upsertRelease(db, { version: '0.10.0', sha256: 'b', notes: 'new' });
    expect(latestRelease(db)!.version).toBe('0.10.0');
  });

  it('upsert is idempotent on version (updates sha256 + notes)', () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.2.0', sha256: 'a', notes: 'first' });
    upsertRelease(db, { version: '0.2.0', sha256: 'b', notes: 'second' });
    const r = getReleaseByVersion(db, '0.2.0')!;
    expect(r.sha256).toBe('b');
    expect(r.notes).toBe('second');
  });

  it('attachFileId sets file_id + attached_by on the row', () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.2.0', sha256: 'a', notes: 'n' });
    attachFileId(db, '0.2.0', 'FILEID', 42);
    const r = getReleaseByVersion(db, '0.2.0')!;
    expect(r.file_id).toBe('FILEID');
    expect(r.attached_by).toBe(42);
  });

  it('listExtensionTokenHolders returns distinct telegram_ids', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedToken(db, 1);
    seedToken(db, 2);
    expect(listExtensionTokenHolders(db).sort()).toEqual([1, 2]);
  });
});
