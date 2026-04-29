import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUserLanguage } from '../../storage/user_profiles';
import { i18nMiddleware } from './i18n';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

interface FakeCtx {
  from?: { id: number; language_code?: string };
  deps: { db: ReturnType<typeof fresh> };
  locale?: string;
  t?: (k: string) => string;
}

async function runMiddleware(ctx: FakeCtx): Promise<FakeCtx> {
  await i18nMiddleware(ctx as any, async () => {});
  return ctx;
}

describe('i18nMiddleware', () => {
  test('uses stored language from DB when present (ignores language_code)', async () => {
    const db = fresh();
    ensureProfile(db, 42);
    setUserLanguage(db, 42, 'pl');
    const ctx: FakeCtx = { from: { id: 42, language_code: 'uk' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('pl');
  });

  test('falls back to detectLocale when no row in DB and persists the result', async () => {
    const db = fresh();
    const ctx: FakeCtx = { from: { id: 7, language_code: 'pl-PL' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('pl');
    // Persisted: ensureProfile + setUserLanguage during the middleware run.
    const stored = db
      .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
      .get(7) as { language: string } | undefined;
    expect(stored?.language).toBe('pl');
  });

  test('ru language_code maps to en (and persists en)', async () => {
    const db = fresh();
    const ctx: FakeCtx = { from: { id: 8, language_code: 'ru' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('en');
    const stored = db
      .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
      .get(8) as { language: string } | undefined;
    expect(stored?.language).toBe('en');
  });

  test('absent ctx.from (e.g. channel_post) falls back to en, no DB write', async () => {
    const db = fresh();
    const ctx: FakeCtx = { deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('en');
    const rows = db.prepare('SELECT COUNT(*) as n FROM user_profiles').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test('exposes a working ctx.t', async () => {
    const db = fresh();
    const ctx: FakeCtx = { from: { id: 1, language_code: 'uk' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.t!('app.no_data_in_snapshot')).toBe('Наразі немає цікавих непитих пив.');
  });
});
