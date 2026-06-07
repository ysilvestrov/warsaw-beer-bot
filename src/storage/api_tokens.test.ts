import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { hashToken, rotateToken, findTelegramIdByHash } from './api_tokens';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 111);
  ensureProfile(db, 222);
  return db;
}

describe('api_tokens storage', () => {
  it('hashToken is deterministic sha256 hex (64 chars)', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('stores a token and finds the owner by hash', () => {
    const db = fresh();
    rotateToken(db, 111, hashToken('raw-1'), '2026-06-07T00:00:00Z');
    expect(findTelegramIdByHash(db, hashToken('raw-1'))).toBe(111);
    expect(findTelegramIdByHash(db, hashToken('nope'))).toBeNull();
  });

  it('rotation is 1:1 — old token for the same user is removed', () => {
    const db = fresh();
    rotateToken(db, 111, hashToken('old'), '2026-06-07T00:00:00Z');
    rotateToken(db, 111, hashToken('new'), '2026-06-07T01:00:00Z');
    expect(findTelegramIdByHash(db, hashToken('old'))).toBeNull();
    expect(findTelegramIdByHash(db, hashToken('new'))).toBe(111);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE telegram_id = ?')
      .get(111) as { n: number };
    expect(count.n).toBe(1);
  });

  it('rotation does not touch other users tokens', () => {
    const db = fresh();
    rotateToken(db, 111, hashToken('a'), '2026-06-07T00:00:00Z');
    rotateToken(db, 222, hashToken('b'), '2026-06-07T00:00:00Z');
    rotateToken(db, 111, hashToken('a2'), '2026-06-07T02:00:00Z');
    expect(findTelegramIdByHash(db, hashToken('b'))).toBe(222);
  });
});
