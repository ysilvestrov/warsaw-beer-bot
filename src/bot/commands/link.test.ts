import { Context, Telegram } from 'telegraf';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { mergeCheckin, countCheckins } from '../../storage/checkins';
import { createTranslator } from '../../i18n';
import { parseLinkArgs, linkCommand } from './link';

test('accepts a bare username', () => {
  expect(parseLinkArgs('yuriy')).toEqual({ username: 'yuriy' });
});

test('accepts a full URL', () => {
  expect(parseLinkArgs('https://untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
});

test('accepts a www URL', () => {
  expect(parseLinkArgs('https://www.untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
});

test('tolerates trailing slash', () => {
  expect(parseLinkArgs('yuriy/')).toEqual({ username: 'yuriy' });
});

// #609: the scheme was mandatory inside the optional URL group, so the schemeless form
// was rejected — the very form spec.md:629 promises, that `link.usage` tells the user to
// send, and that `link.success` echoes back at them.
test('accepts the schemeless URL that the usage text and spec promise', () => {
  expect(parseLinkArgs('untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
  expect(parseLinkArgs('www.untappd.com/user/yuriy')).toEqual({ username: 'yuriy' });
  expect(parseLinkArgs('untappd.com/user/yuriy/')).toEqual({ username: 'yuriy' });
});

test('accepts the exact string link.success echoes, so copying it back works', () => {
  // link.success renders "✅ Linked to untappd.com/user/{username}".
  expect(parseLinkArgs('untappd.com/user/AlexFavorov')).toEqual({ username: 'AlexFavorov' });
});

test('rejects empty or junk', () => {
  expect(parseLinkArgs('')).toBeNull();
  expect(parseLinkArgs('not a username!')).toBeNull();
  expect(parseLinkArgs('a')).toBeNull();
});

// Widening the scheme must not widen the host: a lookalike domain would silently link the
// user to a username parsed out of somebody else's URL.
test('rejects hosts that are not untappd.com', () => {
  expect(parseLinkArgs('evil.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('untappd.com.evil.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('notuntappd.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('https://evil.com/user/yuriy')).toBeNull();
  expect(parseLinkArgs('untappd.com/brewery/yuriy')).toBeNull();
});


function linkContext(db: ReturnType<typeof openDb>, username: string) {
  const ctx = new Context({ update_id: 1, message: { message_id: 1, date: 1,
    chat: { id: 1, type: 'private', first_name: 'Test' }, from: { id: 1, is_bot: false, first_name: 'Test' },
    text: `/link ${username}`, entities: [{ type: 'bot_command', offset: 0, length: 5 }] } }, new Telegram('test'), {} as never);
  Object.assign(ctx, { deps: { db }, t: createTranslator('en') });
  vi.spyOn(ctx, 'reply').mockResolvedValue({ message_id: 2 } as never);
  return ctx;
}

test.each([{ kind: 'first', prepare: (_db: ReturnType<typeof openDb>) => {} },
  { kind: 'case-only', prepare: (db: ReturnType<typeof openDb>) => setUntappdUsername(db, 1, 'account-a') }])('/link $kind explains the selected history and how to update it', async ({ prepare }) => {
  const db = openDb(':memory:'); migrate(db); ensureProfile(db, 1);
  prepare(db);
  const ctx = linkContext(db, 'Account-A');
  await linkCommand.middleware()(ctx as never, async () => {});
  expect(ctx.reply).toHaveBeenCalledExactlyOnceWith('✅ Linked to untappd.com/user/Account-A. Showing this account’s history. Use “Sync my check-ins” in the extension or /import to update it.');
  db.close();
});

test('/link switch and return preserve history and explain the change', async () => {
  const db = openDb(':memory:'); migrate(db); ensureProfile(db, 1); setUntappdUsername(db, 1, 'account-a');
  mergeCheckin(db, { telegram_id: 1, checkin_id: 'one', beer_id: null, user_rating: 0,
    checkin_at: '2026-01-05T18:00:00Z', venue: null });
  const b = linkContext(db, 'account-b');
  await linkCommand.middleware()(b as never, async () => {});
  expect(b.reply).toHaveBeenCalledExactlyOnceWith('✅ Linked to untappd.com/user/account-b. Showing this account’s history; the previous account’s history is saved separately. Use “Sync my check-ins” in the extension or /import to update it.');
  expect(countCheckins(db, 1)).toBe(0);
  const a = linkContext(db, 'account-a');
  await linkCommand.middleware()(a as never, async () => {});
  expect(a.reply).toHaveBeenCalledExactlyOnceWith('✅ Linked to untappd.com/user/account-a. Showing this account’s history; the previous account’s history is saved separately. Use “Sync my check-ins” in the extension or /import to update it.');
  expect(countCheckins(db, 1)).toBe(1);
  db.close();
});
