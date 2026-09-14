import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { seedBeer } from '../../storage/seed-beer.testing';
import { ensureProfile } from '../../storage/user_profiles';
import { mergeCheckin } from '../../storage/checkins';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { createCatalogCache } from '../../domain/catalog-cache';
import { enrichRoute } from './enrich';
import { matchRoute } from './match';
import type { ApiDeps, ApiEnv } from '../types';

// #614: уся петля розширення через справжні роути й спільний кеш каталогу, на даних випадку користувача
// (Flasker, VARVAR BLACK BEAN IS 11%, 4 чекіни Varvar Brew / Black Bean). Кеш — stale-while-revalidate,
// тож перед кожним /match тест чекає перебудови: інакше «після» читав би знімок «до».
const CARD = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
const FLASKER_PAGE = 'https://flasker.pl/pl/p/VARVAR-BLACK-BEAN-IS-11-0.33l/1234';
const RESULT = { ...CARD, bid: 3548624, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } };

function loop(hydrateByBid: NonNullable<ApiDeps['hydrateByBid']> = async () => new Map()) {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  const blackBean = seedBeer(db, {
    untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
    style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
    normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
  });
  mergeCheckin(db, {
    checkin_id: 'c1', telegram_id: 555, beer_id: blackBean, user_rating: 4.5,
    checkin_at: '2026-01-01T00:00:00Z', venue: null,
  });
  const deps = { db, env: {} as never, log: pino({ level: 'silent' }), hydrateByBid } satisfies ApiDeps;
  const app = new Hono<ApiEnv>();
  app.use('/match', async (c, next) => { c.set('telegramId', 555); await next(); });
  const cache = createCatalogCache(db);
  matchRoute(app, deps, cache);
  enrichRoute(app, deps);
  const post = async (path: string, body: unknown) => (await app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const match = async (card: typeof CARD) => {
    await cache.get();
    await cache.idle();
    return (await post('/match', { beers: [card] })).results[0];
  };
  const beerCount = () => (db.prepare('SELECT COUNT(*) AS n FROM beers').get() as { n: number }).n;
  return { db, blackBean, post, match, beerCount };
}

describe('#614 merge memory closes the extension loop', () => {
  it('the card is searched once: /match then answers exactly with the drinker status, and a repeat round mints no orphan', async () => {
    const { blackBean, post, match, beerCount } = loop();

    // Прод-реплей 2026-09-14: без пам'яті злиття картка — null.
    expect((await match(CARD)).matched_beer).toBeNull();
    expect((await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] })).candidates[0].eligible).toBe(true);
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    expect(beerCount()).toBe(1);

    expect(await match(CARD)).toMatchObject({
      matched_beer: { id: blackBean }, source: 'exact', is_drunk: true, user_rating: 4.5,
    });

    // Повторний раунд тієї самої картки (перший /match після злиття — застарілий null, друга вкладка):
    // пошуку немає, сирота не створюється, /match і далі точний.
    expect((await post('/enrich/candidates', { beers: [CARD] })).candidates[0].eligible).toBe(false);
    expect(beerCount()).toBe(1);
    expect(await match(CARD)).toMatchObject({ matched_beer: { id: blackBean }, source: 'exact', is_drunk: true });
  });

  it('an ABV twin of the card gets its own orphan without switching the alias off', async () => {
    const { blackBean, post, match, beerCount } = loop();
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });

    const twin = { ...CARD, abv: 9.5 };
    expect((await match(twin)).matched_beer).toBeNull();
    expect((await post('/enrich/candidates', { beers: [twin] })).candidates[0].eligible).toBe(true);
    expect(beerCount()).toBe(2);

    expect(await match(CARD)).toMatchObject({ matched_beer: { id: blackBean }, source: 'exact', is_drunk: true });
  });

  it('a twin linked by its own bid does not switch the alias off, so the card never contradicts its bid', async () => {
    // Рев'ю 9, M1: вимкнений аліас віддавав картці 11% рядок близнюка як exact → суперечливий bid → репарація #384
    // зливала рядок близнюка в Black Bean → пінг-понг на кожному завантаженні з переїздом чекінів.
    const twinBeer = {
      bid: 777, beer_name: 'Black Bean Light', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-light', style: 'Stout', abv: 9.5, global_rating: 4.0,
    };
    const { db, blackBean, post, match } = loop(async () => new Map([[twinBeer.bid, twinBeer]]));
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });

    const twin = { ...CARD, abv: 9.5 };
    await post('/enrich/candidates', { beers: [{ ...twin, bid: 777 }] });
    expect(await post('/enrich/result', { ...twin, bid: 777, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } }))
      .toMatchObject({ status: 'matched', untappd_id: 777 });
    const twinRow = (db.prepare('SELECT id FROM beers WHERE untappd_id = 777').get() as { id: number }).id;

    expect(await match(CARD)).toMatchObject({
      matched_beer: { id: blackBean, untappd_id: 3548624 }, source: 'exact', is_drunk: true,
    });
    expect(await match(twin)).toMatchObject({ matched_beer: { id: twinRow, untappd_id: 777 }, source: 'exact', is_drunk: false });
  });
});
