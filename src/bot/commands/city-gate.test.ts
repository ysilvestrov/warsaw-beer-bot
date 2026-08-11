import { vi } from 'vitest';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, getProfile, setUserCity } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import { CITY_SCOPED_COMMANDS, cityGateHandler, type CommandCtx } from './city-gate';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function ctxFor(db: ReturnType<typeof fresh>, telegramId: number) {
  const reply = vi.fn();
  const ctx = { deps: { db }, t: createTranslator('en'), from: { id: telegramId }, reply };
  return { ctx: ctx as unknown as CommandCtx, reply };
}

test('the gated command list comes from the catalog flag', () => {
  expect([...CITY_SCOPED_COMMANDS].sort()).toEqual(['beers', 'newbeers', 'pubs', 'refresh', 'route']);
  expect(CITY_SCOPED_COMMANDS).toEqual(['newbeers', 'route', 'pubs', 'beers', 'refresh']);
});

test('a user with a Polish city passes through untouched', async () => {
  const db = fresh();
  ensureProfile(db, 1);
  setUserCity(db, 1, 'krakow');
  const { ctx, reply } = ctxFor(db, 1);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(reply).not.toHaveBeenCalled();
});

test('a user without a city is blocked and told how to fix it', async () => {
  const db = fresh();
  ensureProfile(db, 2); // city stays NULL → outside-pl
  const { ctx, reply } = ctxFor(db, 2);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledWith(createTranslator('en')('city.blocked'));
});

test('a user who explicitly picked outside-pl is blocked too', async () => {
  const db = fresh();
  ensureProfile(db, 3);
  setUserCity(db, 3, 'outside-pl');
  const { ctx, reply } = ctxFor(db, 3);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});

test('the gate creates a profile for a first-time user (and still blocks them)', async () => {
  const db = fresh(); // no ensureProfile
  const { ctx, reply } = ctxFor(db, 99);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(getProfile(db, 99)).not.toBeNull();
});
