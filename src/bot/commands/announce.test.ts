import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { hashToken, rotateToken } from '../../storage/api_tokens';
import { getAnnounceOptOut, setAnnounceOptOut } from '../../storage/announce';
import { handleAnnounce } from './announce';
import { createTranslator } from '../../i18n';
import { COMMAND_CATALOG } from './catalog';

function freshDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const t = createTranslator('en');

function run(db: DB, telegramId: number, text: string): string[] {
  const replies: string[] = [];
  handleAnnounce({ db, telegramId, text, t, reply: (m) => { replies.push(m); } });
  return replies;
}

describe('handleAnnounce', () => {
  test('no argument, opted in, with a token → status only', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    rotateToken(db, 1, hashToken('raw'), '2026-09-01T00:00:00Z');
    expect(run(db, 1, '/announce')).toEqual([t('announce.status_on')]);
  });

  test('no argument without a token → status plus the honest caveat', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(run(db, 1, '/announce')).toEqual([
      `${t('announce.status_on')}\n${t('announce.no_token')}`,
    ]);
  });

  test('no argument while opted out reports off', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    rotateToken(db, 1, hashToken('raw'), '2026-09-01T00:00:00Z');
    setAnnounceOptOut(db, 1, true);
    expect(run(db, 1, '/announce')).toEqual([t('announce.status_off')]);
  });

  test('"off" persists the opt-out and confirms', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    expect(run(db, 1, '/announce off')).toEqual([t('announce.turned_off')]);
    expect(getAnnounceOptOut(db, 1)).toBe(true);
  });

  test('"on" clears the opt-out and confirms', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    setAnnounceOptOut(db, 1, true);
    expect(run(db, 1, '/announce on')).toEqual([t('announce.turned_on')]);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
  });

  test('the argument is case-insensitive and tolerates extra spaces', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    run(db, 1, '/announce   OFF');
    expect(getAnnounceOptOut(db, 1)).toBe(true);
  });

  test('an unrecognized argument shows status rather than silently changing anything', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    rotateToken(db, 1, hashToken('raw'), '2026-09-01T00:00:00Z');
    expect(run(db, 1, '/announce maybe')).toEqual([t('announce.status_on')]);
    expect(getAnnounceOptOut(db, 1)).toBe(false);
  });

  test('creates the profile row for a first-time user', () => {
    const db = freshDb();
    run(db, 7, '/announce off');
    expect(getAnnounceOptOut(db, 7)).toBe(true);
  });
});

describe('catalog', () => {
  test('/announce is listed and is not city-scoped (#399 must not gate it)', () => {
    const entry = COMMAND_CATALOG.find((e) => e.command === 'announce');
    expect(entry).toEqual({ command: 'announce', descKey: 'cmd.announce' });
  });
});
