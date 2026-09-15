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
    // Рев'ю 10, N2: Untappd-ABV близнюка (11) дорівнює ABV іншої картки — правило читання з ABV рядка знову вимикало аліас.
    const twinBeer = {
      bid: 777, beer_name: 'Black Bean Light', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-light', style: 'Stout', abv: 11, global_rating: 4.0,
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

  it('a shop bid accepted on the card\'s own row moves the card off an older alias, even when Untappd\'s ABV differs', async () => {
    // Рев'ю 10, N1: ABV рядка після лінка — з Untappd (10.8), ключ аліасу — з картки (11). Правило читання з ABV
    // рядка лишало давній аліас, і картка назавжди показувала ✅ на пиві, яке суперечить bid крамниці.
    const corrected = {
      bid: 2002, beer_name: 'Black Bean IS', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-is', style: 'Stout', abv: 10.8, global_rating: 4.3,
    };
    const { db, blackBean, post, match } = loop(async () => new Map([[corrected.bid, corrected]]));
    // Раунд 1: картка злита в Black Bean за bid крамниці — аліас (текст, 11) → Black Bean.
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    // Раунд 2: та сама картка без ABV (деталі товару не завантажились) — власна сирота з текстом картки.
    const noAbv = { brewery: CARD.brewery, name: CARD.name };
    expect((await post('/enrich/candidates', { beers: [noAbv] })).candidates[0].eligible).toBe(true);
    // Раунд 3: картка з ABV і правильним bid крамниці — аліас → репарація; ensureOrphan повертає власну сироту картки.
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 2002 }] });
    expect(await post('/enrich/result', { ...CARD, bid: 2002, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } }))
      .toMatchObject({ status: 'matched', untappd_id: 2002 });
    const own = (db.prepare('SELECT id FROM beers WHERE untappd_id = 2002').get() as { id: number }).id;

    expect(own).not.toBe(blackBean);
    expect(await match(CARD)).toMatchObject({ matched_beer: { id: own, untappd_id: 2002 }, source: 'exact', is_drunk: false });
  });

  it('a shop bid changing twice on the card never relinks the linked ABV twin of its pair — no bid ping-pong', async () => {
    // Рев'ю 11, R3 (проба review10/writetime, PD): ensureBeerRow брав пару раніше за аліас — рядок близнюка з тим
    // самим текстом. Суперечливий bid картки перелінковував його, bid близнюка — назад, на кожному завантаженні.
    const beer = (bid: number, beer_name: string, abv: number) => ({
      bid, beer_name, brewery_name: 'Varvar Brew', brewery_alias: ['varvar'], beer_slug: null, style: 'Stout', abv, global_rating: 4.0,
    });
    const hydrated = new Map([
      [777, beer(777, 'Black Bean Light', 9.5)], [7777, beer(7777, 'Black Bean IS', 10.8)], [8888, beer(8888, 'Black Bean IS v2', 10.8)],
    ]);
    const { db, post, match } = loop(async () => hydrated);
    const page = (card: typeof CARD, bid: number) => ({ ...card, bid, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } });
    const bidOf = (id: number) => (db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(id) as { untappd_id: number }).untappd_id;

    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    const twin = { ...CARD, abv: 9.5 };
    await post('/enrich/candidates', { beers: [{ ...twin, bid: 777 }] });
    expect(await post('/enrich/result', page(twin, 777))).toMatchObject({ status: 'matched', untappd_id: 777 });
    const twinRow = (db.prepare('SELECT id FROM beers WHERE untappd_id = 777').get() as { id: number }).id;

    for (const bid of [7777, 8888, 8888]) {
      await post('/enrich/candidates', { beers: [{ ...CARD, bid }, { ...twin, bid: 777 }] });
      expect(await post('/enrich/result', page(CARD, bid))).toMatchObject({ status: 'matched', untappd_id: bid });
      expect(await post('/enrich/result', page(twin, 777))).toMatchObject({ status: 'matched', untappd_id: 777 });
      expect(bidOf(twinRow)).toBe(777);
    }
    expect(await match(CARD)).toMatchObject({ matched_beer: { untappd_id: 8888 }, source: 'exact' });
  });
});
