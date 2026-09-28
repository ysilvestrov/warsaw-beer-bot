import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import { countCheckins } from '../../storage/checkins';
import { importCommand } from './import';
import { Context, Telegram } from 'telegraf';

function setupImport(n: number) {
  const db = openDb(':memory:'); migrate(db); ensureProfile(db, 1); setUntappdUsername(db, 1, 'a');
  const rows = Array.from({ length: n }, (_, i) => ({ checkin_id: String(i + 1), bid: 42,
    beer_name: 'IPA', brewery_name: 'Pinta', created_at: '2026-09-01T00:00:00Z', rating_score: 0 }));
  const response = () => new Response(JSON.stringify(rows));
  const ctx = new Context({ update_id: 1, message: { message_id: 1, date: 1,
    chat: { id: 1, type: 'private', first_name: 'Test' }, from: { id: 1, is_bot: false, first_name: 'Test' },
    document: { file_id: 'export', file_unique_id: 'export', file_name: 'history.json' } } }, new Telegram('test'), {} as never);
  Object.assign(ctx, { deps: { db }, t: createTranslator('uk') });
  vi.spyOn(ctx, 'reply').mockResolvedValue({ message_id: 2 } as never);
  vi.spyOn(ctx.telegram, 'getFileLink').mockResolvedValue(new URL('https://test.invalid/export'));
  const messages: string[] = [];
  vi.spyOn(ctx.telegram, 'editMessageText').mockImplementation(async (...args) => {
    messages.push(String(args[3])); return true;
  });
  return { db, ctx, messages, response };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('a relink during file download stops import before catalog or history writes', async () => {
  const { db, ctx, messages, response } = setupImport(1);
  vi.stubGlobal('fetch', async () => { setUntappdUsername(db, 1, 'b'); return response(); });
  await importCommand.middleware()(ctx as never, async () => {});
  expect(db.prepare('SELECT * FROM beers').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM checkins').all()).toEqual([]);
  expect(messages).toEqual(['⏹ Імпорт для a зупинено: акаунт змінився. Збережено 0 рядків; запустіть імпорт знову для поточного акаунта.']);
  db.close();
});

test('a relink between streamed batches keeps 500 committed rows with A and stops B writes', async () => {
  const { db, ctx, messages, response } = setupImport(501);
  vi.stubGlobal('fetch', async () => response());
  let ticks = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => ++ticks * 3000);
  vi.spyOn(ctx.telegram, 'editMessageText').mockImplementation(async (...args) => {
    messages.push(String(args[3])); setUntappdUsername(db, 1, 'b'); return true;
  });
  await importCommand.middleware()(ctx as never, async () => {});
  expect(countCheckins(db, 1, 'a')).toBe(500);
  expect(countCheckins(db, 1, 'b')).toBe(0);
  expect(messages).toEqual(['⏳ Імпортовано 500…', '⏹ Імпорт для a зупинено: акаунт змінився. Збережено 500 рядків; запустіть імпорт знову для поточного акаунта.']);
  setUntappdUsername(db, 1, 'a');
  expect(countCheckins(db, 1)).toBe(500);
  db.close();
});

test('a busy retry rechecks the original binding rather than adopting the new account', async () => {
  const { db, ctx, messages, response } = setupImport(1);
  vi.stubGlobal('fetch', async () => response());
  vi.spyOn(db, 'transaction').mockImplementationOnce(() => {
    setTimeout(() => setUntappdUsername(db, 1, 'b'), 0);
    throw Object.assign(new Error('writer busy'), { code: 'SQLITE_BUSY' });
  });
  await importCommand.middleware()(ctx as never, async () => {});
  expect(db.prepare('SELECT * FROM checkins').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM beers').all()).toEqual([]);
  expect(messages).toEqual(['⏹ Імпорт для a зупинено: акаунт змінився. Збережено 0 рядків; запустіть імпорт знову для поточного акаунта.']);
  db.close();
});
