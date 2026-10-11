import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import { countCheckins } from '../../storage/checkins';
import { importCommand, importFailureKind } from './import';
import { Context, Telegram } from 'telegraf';
import pino from 'pino';

function setupImport(n: number) {
  const db = openDb(':memory:'); migrate(db); ensureProfile(db, 1); setUntappdUsername(db, 1, 'a');
  const rows = Array.from({ length: n }, (_, i) => ({ checkin_id: String(i + 1), bid: 42,
    beer_name: 'IPA', brewery_name: 'Pinta', created_at: '2026-09-01T00:00:00Z', rating_score: 0 }));
  const response = () => new Response(JSON.stringify(rows));
  const ctx = new Context({ update_id: 1, message: { message_id: 1, date: 1,
    chat: { id: 1, type: 'private', first_name: 'Test' }, from: { id: 1, is_bot: false, first_name: 'Test' },
    document: { file_id: 'export', file_unique_id: 'export', file_name: 'history.json' } } }, new Telegram('test'), {} as never);
  Object.assign(ctx, { deps: { db, log: pino({ level: 'silent' }) }, t: createTranslator('uk') });
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

test('a failing import tells the person once, records /import, and does not re-throw', async () => {
  const { db, ctx, messages, response } = setupImport(1);
  vi.stubGlobal('fetch', async () => response());
  vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new Error('disk on fire'); });
  await expect(importCommand.middleware()(ctx as never, async () => {})).resolves.toBeUndefined();
  expect(messages).toEqual(['❌ Помилка після 0 рядків: disk on fire']);
  // The message («disk on fire») goes to the person and the journal; the row keeps only the kind.
  expect(db.prepare('SELECT source, error FROM handler_failures').all()).toEqual([{ source: '/import', error: 'Error' }]);
  db.close();
});

test('an account change is not a failure: nothing is recorded', async () => {
  const { db, ctx, response } = setupImport(1);
  vi.stubGlobal('fetch', async () => { setUntappdUsername(db, 1, 'b'); return response(); });
  await importCommand.middleware()(ctx as never, async () => {});
  expect(db.prepare('SELECT source FROM handler_failures').all()).toEqual([]);
  db.close();
});

test('importFailureKind: a parser error that quotes the file is reduced to its code', () => {
  const parserError = Object.assign(
    new Error('Invalid Opening Quote: a quote is found on field "venue_name" at line 2, value is "Private home"'),
    { code: 'INVALID_OPENING_QUOTE' },
  );
  expect(importFailureKind(parserError)).toBe('INVALID_OPENING_QUOTE');
});

test('importFailureKind: an error without a code is its class name; a non-error is "unknown"', () => {
  expect([importFailureKind(new TypeError('x is not iterable')), importFailureKind('plain'), importFailureKind(null)]).toEqual([
    'TypeError', 'unknown', 'unknown',
  ]);
});
