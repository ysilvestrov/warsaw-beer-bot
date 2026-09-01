import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile, setUserLanguage } from './user_profiles';
import { hashToken, rotateToken } from './api_tokens';
import { announceRecipients, getAnnounceOptOut, setAnnounceOptOut } from './announce';

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function withToken(db: DB, id: number): void {
  ensureProfile(db, id);
  rotateToken(db, id, hashToken(`raw-${id}`), '2026-09-01T00:00:00Z');
}

describe('migration 26', () => {
  test('user_profiles gains announce_opt_out defaulting to 0', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    const row = db.prepare('SELECT announce_opt_out FROM user_profiles WHERE telegram_id = 1')
      .get() as { announce_opt_out: number };
    expect(row.announce_opt_out).toBe(0);
  });
});

describe('announceRecipients', () => {
  test('token holders only — a profile without a token is not a recipient', () => {
    const db = freshDb();
    withToken(db, 1);
    ensureProfile(db, 2); // profile, no token
    expect(announceRecipients(db).map((r) => r.telegramId)).toEqual([1]);
  });

  test('carries each recipient language, and null for an unset or unknown one', () => {
    const db = freshDb();
    withToken(db, 1);
    setUserLanguage(db, 1, 'uk');
    withToken(db, 2); // language never set
    withToken(db, 3);
    db.prepare("UPDATE user_profiles SET language = 'kl' WHERE telegram_id = 3").run();
    expect(announceRecipients(db)).toEqual([
      { telegramId: 1, language: 'uk' },
      { telegramId: 2, language: null },
      { telegramId: 3, language: null },
    ]);
  });

  test('an opted-out token holder is excluded', () => {
    const db = freshDb();
    withToken(db, 1);
    withToken(db, 2);
    setAnnounceOptOut(db, 2, true);
    expect(announceRecipients(db).map((r) => r.telegramId)).toEqual([1]);
  });

  test('opting back in restores the recipient', () => {
    const db = freshDb();
    withToken(db, 1);
    setAnnounceOptOut(db, 1, true);
    expect(announceRecipients(db)).toEqual([]);
    setAnnounceOptOut(db, 1, false);
    expect(announceRecipients(db).map((r) => r.telegramId)).toEqual([1]);
  });
});

describe('getAnnounceOptOut', () => {
  test('false by default, true after opting out, false again after opting in', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
    setAnnounceOptOut(db, 1, true);
    expect(getAnnounceOptOut(db, 1)).toBe(true);
    setAnnounceOptOut(db, 1, false);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
  });

  test('false for a user with no profile row at all', () => {
    expect(getAnnounceOptOut(freshDb(), 999)).toBe(false);
  });
});
