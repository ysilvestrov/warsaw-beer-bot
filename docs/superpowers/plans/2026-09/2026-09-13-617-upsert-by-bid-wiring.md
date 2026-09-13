# Ідентичність пива за bid — план обв'язки (#617)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** перевести п'ять викликачів старого `upsertBeer` на `upsertBeerByBid` / `ensureOrphan`,
прибрати `upsertBeer` з продакшн-коду (тестові сіди — `seedBeer` + страж), оновити `spec.md`.

**Architecture:** друга стадія #617. Ядро (`numericTokensCompatible`, `upsertBeerByBid`,
`ensureOrphan`) реалізоване, пройшло наскрізне рев'ю й виправлення (коміти `f35b56d`, `6ae59a8`,
`96868fe` після rebase на `origin/main`; до rebase — `61ebe93`, `4f307eb`, `a0db1a9`). Цей план лише
**перемикає** викликачів і прибирає стару функцію.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Hono, Vitest 4 (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-617-upsert-by-bid-design.md`
**Ядро:** `docs/superpowers/plans/2026-09/2026-09-13-617-upsert-by-bid-core.md` (розділ «Результат наскрізного рев'ю ядра»)

## Global Constraints

- **Коментарі українською, ідентифікатори англійською.**
- **Повний гейт після КОЖНОЇ задачі**: `npm test && npm run typecheck`. Розширення не зачіпається.
- **Кожен новий тест мутаційно доведений** (крок «мутація» в задачі): прибери/зміни названий рядок —
  тест мусить впасти; поверни.
- **Сіди з видимими значеннями**, не `null`.
- **Ніяких `as unknown as`.**
- **Код важить більше за цей план**: розбіжність у сигнатурі/імпорті — іди за кодом і назви її у звіті.
- Робота у worktree `617-upsert-by-bid` (гілка `worktree-617-upsert-by-bid`).
- Задачі 1, 2, 3, 5 — дрібні за CLAUDE.md (повний код, ≤2 файли + тести, без рішень) → **інлайн**.
  Задача 4 зачіпає ~30 тестових файлів → **диспатч імплементера** з вартою коміту у worktree.
  Інлайнові задачі входять у review-пакет наступної задачі й у наскрізне рев'ю.

## Виміряно spike-ом перед планом (2026-09-13, код не комітився)

Переведення всіх п'яти викликачів на нові функції з наявними тестами: **3 падіння, typecheck чистий**.

| Тест | Причина | Що робить план |
|---|---|---|
| `refresh-ontap.test.ts` «a fresh orphan from one pub is reused by a later pub» | `vi.mock`-шпигун рахує виклики `upsertBeer`, а гілка тепер кличе `ensureOrphan` — поведінка та сама | Задача 3: шпигун на `ensureOrphan` |
| `refresh-untappd.test.ts` «matches existing row by normalized name+brewery; updates rating_global only» | засіяна **сирота** тепер резолвиться за bid 101 і бере стиль Untappd (`IPA`) — правило рев'ю ядра | Задача 2: переписати під нову поведінку |
| `refresh-untappd.test.ts` «global_rating null on /beers → row.rating_global set to NULL» | засіяна сирота з bid 555 резолвиться через `upsertBeerByBid`, `COALESCE` лишає 3.9 | Задача 2: сід із `untappd_id: 555` (запис `NULL` у рядок за bid не змінюється; семантика — #616) |

**Рішення щодо відкритого питання спеки** («чи заповнює `ensureOrphan` порожні факти наявної сироти
з крана»): **ні**. Гілка сироти в `refresh-ontap` досягається лише при промаху матчера; наявна сирота
з тією самою нормалізованою парою вже є в каталозі й ловиться точною стадією матчера. Отже старе
«переписати факти сироти з крана» спрацьовувало фактично лише в дефектному випадку (вінтаж-близнюк,
який матчер свідомо відкинув). YAGNI; відоме обмеження (сироти злипаються) лишається як було.

## Файлова структура

| Файл | Задача | Відповідальність |
|---|---|---|
| `src/api/routes/checkins.ts` + `.test.ts` | 1 | синк чекінів → `upsertBeerByBid` |
| `src/bot/commands/import-checkins.ts` + `.test.ts` | 1 | `/import` → `upsertBeerByBid` / `ensureOrphan` |
| `src/jobs/refresh-untappd.ts` + `.test.ts` | 2 | рядок за bid зі скрейпу |
| `src/jobs/refresh-ontap.ts` + `.test.ts` | 3 | гілка сироти → `ensureOrphan` |
| `src/api/routes/enrich.ts` | 3 | `ensureBeerRow` вставляє через `ensureOrphan` |
| `src/storage/seed-beer.testing.ts` (новий) | 4 | тестовий сід `seedBeer` (стара поведінка `upsertBeer`) |
| `src/storage/seed-beer-guard.test.ts` (новий) | 4 | страж: продакшн-код не імпортує сід і не відроджує `upsertBeer` |
| `src/storage/beers.ts`, ~29 `*.test.ts` | 4 | видалення `upsertBeer`, кодмод сідів |
| `spec.md` | 5 | правила #617 |

---

### Task 1: синк чекінів і `/import`

**Files:**
- Modify: `src/api/routes/checkins.ts` (імпорт у рядку 6; виклик ~рядок 111)
- Modify: `src/bot/commands/import-checkins.ts` (імпорт рядок 3; тіло циклу рядки 20-30)
- Test: `src/api/routes/checkins.test.ts`, `src/bot/commands/import-checkins.test.ts`

**Interfaces:**
- Consumes: `upsertBeerByBid(db, BidBeerInput): number`, `ensureOrphan(db, OrphanBeerInput): number` з `src/storage/beers.ts`; `FeedCheckin.bid: number` (`src/sources/untappd/checkin-feed.ts`); `Checkin.bid: number | null` (`src/sources/untappd/export.ts`).
- Produces: нічого нового для наступних задач.

- [ ] **Step 1: Тести синку, що падають**

У `src/api/routes/checkins.test.ts` додати імпорти (поруч з наявними):

```ts
import { upsertBeer } from '../../storage/beers';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
```

Після константи `PAGE_BOTTOM` додати хелпер:

```ts
// #617: сторінка стрічки з одним чекіном — та сама розмітка, що PAGE_ONE, але з довільним пивом.
const feedPage = (checkinId: string, bid: number, beer: string, brewery: string) => `
<html><body>
  <div class="stats"><a><span class="stat">1</span><span class="title">Total</span></a></div>
  <div class="item" data-checkin-id="${checkinId}">
    <a href="/b/x/${bid}" class="label"><img></a>
    <p class="text">
      <a href="/user/bob" class="user">Bob</a> is drinking an <a href="/b/x/${bid}">${beer}</a>
      by <a href="/Brewery">${brewery}</a> at <a href="/v/some-bar/7">Some Bar</a>
    </p>
    <div class="caps " data-rating="4"></div>
    <a href="/user/bob/checkin/${checkinId}" class="time timezoner">Mon, 15 Jun 2026 18:00:00 +0000</a>
  </div>
</body></html>`;
```

У кінець файлу:

```ts
describe('POST /checkins/sync — beer identity (#617)', () => {
  type Row = { id: number; untappd_id: number | null; name: string; style: string | null; abv: number | null; rating_global: number | null; untappd_id_source: string | null };
  const beerById = (db: ReturnType<typeof openDb>, id: number) =>
    db.prepare('SELECT * FROM beers WHERE id = ?').get(id) as Row;

  function seed(
    db: ReturnType<typeof openDb>,
    bid: number, name: string, brewery: string,
    over: Partial<Parameters<typeof upsertBeer>[1]> = {},
  ): number {
    return upsertBeer(db, {
      untappd_id: bid, name, brewery,
      style: 'Belgian Strong Dark Ale', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
      untappd_id_source: 'search',
      ...over,
    });
  }

  it('a linked beer keeps its rating, style and ABV (the sync wipe)', async () => {
    const { db, app } = setup();
    const id = seed(db, 42, 'Some IPA', 'Some Brewery');
    expect((await post(app, '/checkins/sync', { html: PAGE_ONE, maxId: null }, RAW_TOKEN)).status).toBe(200);
    const row = beerById(db, id);
    expect(row.style).toBe('Belgian Strong Dark Ale');
    expect(row.abv).toBeCloseTo(9.2);
    expect(row.rating_global).toBeCloseTo(3.95);
    expect(row.untappd_id_source).toBe('checkin');
  });

  it('a vintage twin is never re-pointed to the synced bid', async () => {
    const { db, app } = setup();
    const eight = seed(db, 1001, 'Trappistes Rochefort 8', 'Rochefort');
    const html = feedPage('777', 2002, 'Trappistes Rochefort 10', 'Rochefort');
    expect((await post(app, '/checkins/sync', { html, maxId: null }, RAW_TOKEN)).status).toBe(200);
    const e = beerById(db, eight);
    expect(e.untappd_id).toBe(1001);
    expect(e.name).toBe('Trappistes Rochefort 8');
    expect(e.rating_global).toBeCloseTo(3.95);
    const ck = db.prepare("SELECT beer_id FROM checkins WHERE checkin_id = '777'").get() as { beer_id: number };
    expect(ck.beer_id).not.toBe(eight);
    expect(beerById(db, ck.beer_id).untappd_id).toBe(2002);
  });

  it('a curated link stays curated', async () => {
    const { db, app } = setup();
    const id = seed(db, 42, 'Some IPA', 'Some Brewery', { untappd_id_source: 'curated' });
    await post(app, '/checkins/sync', { html: PAGE_ONE, maxId: null }, RAW_TOKEN);
    expect(beerById(db, id).untappd_id_source).toBe('curated');
  });

  it('the synced name does not rename the stored beer (#618 owns Untappd names)', async () => {
    const { db, app } = setup();
    const id = seed(db, 42, 'Some IPA (old shop name)', 'Some Brewery');
    await post(app, '/checkins/sync', { html: PAGE_ONE, maxId: null }, RAW_TOKEN);
    expect(beerById(db, id).name).toBe('Some IPA (old shop name)');
  });
});
```

- [ ] **Step 2: Тести `/import`, що падають**

У `src/bot/commands/import-checkins.test.ts` додати імпорти:

```ts
import { upsertBeer, getBeer } from '../../storage/beers';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
```

і всередину `describe('importCheckins', …)` після останнього `it`:

```ts
  // #617: рядок експорту без bid не має ідентичності — він сирота й злінкованого пива не торкається.
  it('a row without bid becomes an orphan and leaves a linked beer of the same name alone', () => {
    const linked = upsertBeer(db, {
      untappd_id: 7, name: 'Some IPA', brewery: 'Some Brewery',
      style: 'IPA', abv: 6, rating_global: 3.9,
      normalized_name: normalizeName('Some IPA'), normalized_brewery: normalizeBrewery('Some Brewery'),
      untappd_id_source: 'search',
    });
    importCheckins(db, 1, [row({ checkin_id: '100', bid: null })]);
    const l = getBeer(db, linked)!;
    expect(l.untappd_id).toBe(7);
    expect(l.rating_global).toBeCloseTo(3.9);
    expect(l.untappd_id_source).toBe('search');
    const ck = db.prepare("SELECT beer_id FROM checkins WHERE checkin_id = '100'").get() as { beer_id: number };
    expect(ck.beer_id).not.toBe(linked);
    expect(getBeer(db, ck.beer_id)!.untappd_id).toBeNull();
  });

  it('import fills empty facts of a beer found by bid but never overwrites stored ones', () => {
    const id = upsertBeer(db, {
      untappd_id: 42, name: 'Some IPA', brewery: 'Some Brewery',
      style: 'IPA', abv: null, rating_global: 3.9,
      normalized_name: normalizeName('Some IPA'), normalized_brewery: normalizeBrewery('Some Brewery'),
      untappd_id_source: 'search',
    });
    importCheckins(db, 1, [row({ checkin_id: '100', bid: 42, beer_abv: 6.5, global_rating: 4.2, beer_type: 'Hazy IPA' })]);
    const r = getBeer(db, id)!;
    expect(r.abv).toBeCloseTo(6.5);
    expect(r.rating_global).toBeCloseTo(3.9);
    expect(r.style).toBe('IPA');
  });
```

- [ ] **Step 3: Переконатися, що падають**

Run: `npx vitest run src/api/routes/checkins.test.ts src/bot/commands/import-checkins.test.ts`
Expected: FAIL — усі 4 нові тести синку і обидва нові тести імпорту (старий `upsertBeer` стирає факти,
перейменовує, понижує `curated`, переписує bid близнюка).

- [ ] **Step 4: Реалізація**

`src/api/routes/checkins.ts`: рядок імпорту

```ts
import { upsertBeer } from '../../storage/beers';
```

замінити на

```ts
import { upsertBeerByBid } from '../../storage/beers';
```

і у циклі транзакції `const beerId = upsertBeer(deps.db, {` замінити на
`const beerId = upsertBeerByBid(deps.db, {` (решта аргументів без змін: стрічка не несе фактів, тож
`style/abv/rating_global: null` лишаються — у `upsertBeerByBid` порожнє значення нічого не стирає).

`src/bot/commands/import-checkins.ts`: імпорт

```ts
import { upsertBeer } from '../../storage/beers';
```

замінити на

```ts
import { upsertBeerByBid, ensureOrphan } from '../../storage/beers';
```

і тіло виклику

```ts
      const beerId = upsertBeer(db, {
        untappd_id: r.bid ?? null,
        name: r.beer_name,
        brewery: r.brewery_name,
        style: r.beer_type,
        abv: r.beer_abv,
        rating_global: r.global_rating,
        normalized_name: normalizeName(r.beer_name),
        normalized_brewery: normalizeBrewery(r.brewery_name),
        untappd_id_source: 'checkin',
      });
```

замінити на

```ts
      // #617: рядок із bid — ідентичність за bid (лише заповнення фактів, без перейменування);
      // без bid ідентичності немає — сирота, яка злінкованого пива не торкається.
      const facts = {
        name: r.beer_name,
        brewery: r.brewery_name,
        style: r.beer_type,
        abv: r.beer_abv,
        rating_global: r.global_rating,
        normalized_name: normalizeName(r.beer_name),
        normalized_brewery: normalizeBrewery(r.brewery_name),
      };
      const beerId = r.bid != null
        ? upsertBeerByBid(db, { ...facts, untappd_id: r.bid, untappd_id_source: 'checkin' })
        : ensureOrphan(db, facts);
```

- [ ] **Step 5: Проходять**

Run: `npx vitest run src/api/routes/checkins.test.ts src/bot/commands/import-checkins.test.ts`
Expected: PASS.

- [ ] **Step 6: Мутації** (після кожної — команда Step 5, мусить впасти; поверни)

1. У `checkins.ts` поверни старий виклик `upsertBeer(deps.db, {` (і імпорт `upsertBeer`) → падають усі 4 тести `beer identity (#617)`.
2. У `import-checkins.ts` заміни `: ensureOrphan(db, facts)` на `: upsertBeerByBid(db, { ...facts, untappd_id: 0, untappd_id_source: 'checkin' })` → падає «a row without bid becomes an orphan…» (сирота отримує bid 0). Поверни.
3. У `import-checkins.ts` поверни весь старий виклик `upsertBeer(...)` → падає «import fills empty facts…» (rating_global стає 4.2, style — 'Hazy IPA').

- [ ] **Step 7: Повний гейт** — `npm test && npm run typecheck`, усе зелене.

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(#617): синк чекінів і /import — ідентичність за bid, факти не стираються

Синк на кожному чекіні стирав рейтинг/стиль/ABV злінкованого пива й через фолбек
за назвою переписував bid вінтаж-близнюка. Тепер upsertBeerByBid: лише заповнення,
без перейменування, провенанс лише вгору; рядок /import без bid — ensureOrphan." -- src/api/routes/checkins.ts src/api/routes/checkins.test.ts src/bot/commands/import-checkins.ts src/bot/commands/import-checkins.test.ts
```

---

### Task 2: `refresh-untappd` — рядок за bid зі скрейпу

**Files:**
- Modify: `src/jobs/refresh-untappd.ts` (імпорт рядок 8; блок пошуку рядки 54-96)
- Test: `src/jobs/refresh-untappd.test.ts` (імпорти; тести «matches existing row by normalized name+brewery…» і «global_rating null on /beers…»; новий тест)

**Interfaces:**
- Consumes: `upsertBeerByBid` з `src/storage/beers.ts`.
- Produces: нічого.

- [ ] **Step 1: Тести**

У `src/jobs/refresh-untappd.test.ts` додати імпорт `import { normalizeName, normalizeBrewery } from '../domain/normalize';` і після `fakeHttp` хелпер:

```ts
// #617: сід напряму — upsertBeer злив би два рядки з однаковою нормалізованою назвою в один
// (саме той дефект, який тут перевіряється).
function insertBeer(db: ReturnType<typeof fresh>, bid: number, name: string, brewery: string, rating: number): number {
  return Number(db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, rating_global, normalized_name, normalized_brewery)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(bid, name, brewery, rating, normalizeName(name), normalizeBrewery(brewery)).lastInsertRowid);
}
```

Тест «matches existing row by normalized name+brewery; updates rating_global only» **замінити цілком** на:

```ts
  test('#617: resolves a same-name orphan by the scraped bid and takes Untappd facts over its own', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');

    const seededId = upsertBeer(db, {
      untappd_id: null,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'NEIPA — Hazy',
      abv: 6.5,
      rating_global: null,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(101, 'Atak Chmielu', 'Pinta', '4.20'),
    });

    const v = catalogVersion();
    await refreshAllUntappd({ db, log: silentLog, http });
    expect(catalogVersion()).toBeGreaterThan(v);

    const row = findBeerByNormalized(db, 'pinta', 'atak chmielu')!;
    expect(row.id).toBe(seededId);
    expect(row.untappd_id).toBe(101);
    expect(row.untappd_id_source).toBe('checkin');
    expect(row.rating_global).toBe(4.20);
    expect(row.style).toBe('IPA');         // Untappd переважає факт сироти (spec §/newbeers)
    expect(row.abv).toBe(6.5);             // сторінка без ABV → лишається ABV сироти
    expect(row.name).toBe('Atak Chmielu');
    expect(row.brewery).toBe('Pinta');
  });
```

У тесті «global_rating null on /beers → row.rating_global set to NULL (idempotent re-read)» у сіді
`untappd_id: null,` замінити на `untappd_id: 555,`, а назву тесту — на
`'global_rating null on /beers → rating_global of the row found by bid set to NULL (idempotent re-read)'`.

Після тесту «marks each scraped beer in untappd_had for that user» додати:

```ts
  test('#617: updates and marks the row with the scraped bid, not a same-name vintage twin', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');
    const eight = insertBeer(db, 1001, 'Trappistes Rochefort 8', 'Rochefort', 3.95);
    const ten = insertBeer(db, 2002, 'Trappistes Rochefort 10', 'Rochefort', 3.8);

    const http = fakeHttp({
      'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(2002, 'Trappistes Rochefort 10', 'Rochefort', '4.05'),
    });
    await refreshAllUntappd({ db, log: silentLog, http });

    const rating = (id: number) =>
      (db.prepare('SELECT rating_global FROM beers WHERE id = ?').get(id) as { rating_global: number }).rating_global;
    expect(rating(ten)).toBe(4.05);
    expect(rating(eight)).toBe(3.95);
    const had = db.prepare('SELECT beer_id FROM untappd_had WHERE telegram_id = 1').all() as { beer_id: number }[];
    expect(had.map((h) => h.beer_id)).toEqual([ten]);
  });
```

- [ ] **Step 2: Переконатися, що падають**

Run: `npx vitest run src/jobs/refresh-untappd.test.ts`
Expected: FAIL — «resolves a same-name orphan…» (старий код не ставить bid) і «updates and marks the row
with the scraped bid…» (старий `findBeerByNormalized` бере `eight`). Тест `NULL` із сідом 555 проходить і
до реалізації — це нормально, він закріплює незмінну поведінку.

- [ ] **Step 3: Реалізація**

`src/jobs/refresh-untappd.ts`: імпорт

```ts
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
```

замінити на

```ts
import { upsertBeerByBid } from '../storage/beers';
```

Після оголошення `updateRatingAndAbv` додати:

```ts
  // #617: рядок шукається за bid зі сторінки, а не за нормалізованою назвою: normalizeName викидає
  // цифри, тож «Rochefort 8» і «Rochefort 10» мають одну назву, і рейтинг та позначка «пив»
  // лягали б на вінтаж-близнюка.
  const findByBid = db.prepare('SELECT id FROM beers WHERE untappd_id = ?');
```

і рядки

```ts
        const existing = findBeerByNormalized(db, nb, nn);
        let beerId: number;
        if (existing) {
          updateRatingAndAbv.run(it.global_rating, it.abv, existing.id);
          bumpCatalogVersion();
          beerId = existing.id;
        } else {
          beerId = upsertBeer(db, {
```

замінити на

```ts
        const existing = findByBid.get(it.bid) as { id: number } | undefined;
        let beerId: number;
        if (existing) {
          updateRatingAndAbv.run(it.global_rating, it.abv, existing.id);
          bumpCatalogVersion();
          beerId = existing.id;
        } else {
          beerId = upsertBeerByBid(db, {
```

(аргументи виклику без змін).

- [ ] **Step 4: Проходять** — `npx vitest run src/jobs/refresh-untappd.test.ts`, PASS.

- [ ] **Step 5: Мутації**

1. Заміни `findByBid.get(it.bid)` на `db.prepare('SELECT id FROM beers WHERE normalized_brewery = ? AND normalized_name = ?').get(nb, nn)` → падає «updates and marks the row with the scraped bid…». Поверни.
2. У `src/storage/beers.ts`, функція `upsertBeerByBid`, заміни рядок `const orphan = resolvableOrphan(db, b);` на `const orphan = null;` → падає «resolves a same-name orphan by the scraped bid…» (доводить, що тест дістає гілку резолвлення сироти крізь job, а не лише через юніт-тести ядра). Поверни.

- [ ] **Step 6: Повний гейт** — `npm test && npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(#617): refresh-untappd шукає рядок за bid зі скрейпу, а не за назвою

findBeerByNormalized брав перший рядок з однаковою нормалізованою назвою, тож рейтинг
і позначка «пив» лягали на вінтаж-близнюка; новий рядок — через upsertBeerByBid." -- src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
```

---

### Task 3: `refresh-ontap` і `ensureBeerRow` → `ensureOrphan`

**Files:**
- Modify: `src/jobs/refresh-ontap.ts` (імпорт рядок 13; гілка сироти ~рядки 133-145)
- Modify: `src/api/routes/enrich.ts` (імпорт рядки 5-15; `ensureBeerRow` рядки 135-139)
- Test: `src/jobs/refresh-ontap.test.ts` (імпорт рядок 9; `vi.mock` рядки 18-24; тест «a fresh orphan from one pub is reused…»; новий тест)

**Interfaces:**
- Consumes: `ensureOrphan(db, OrphanBeerInput): number`.
- Produces: нічого.

- [ ] **Step 1: Тести**

`src/jobs/refresh-ontap.test.ts`, рядок 9:

```ts
import { listLookupCandidates, upsertBeer } from '../storage/beers';
```

→

```ts
import { listLookupCandidates, upsertBeer, ensureOrphan } from '../storage/beers';
```

Блок

```ts
// Wrap upsertBeer in a spy while keeping the real implementation (and every other
// export, e.g. listLookupCandidates) intact. Lets the orphan-reuse test assert that a
// second pub with the same beer takes the in-memory match path — NOT a second insert.
vi.mock('../storage/beers', async (importActual) => {
  const actual = await importActual<typeof import('../storage/beers')>();
  return { ...actual, upsertBeer: vi.fn(actual.upsertBeer) };
});
```

→

```ts
// Wrap ensureOrphan in a spy while keeping the real implementation (and every other
// export, e.g. listLookupCandidates) intact. Lets the orphan-reuse test assert that a
// second pub with the same beer takes the in-memory match path — NOT a second insert.
vi.mock('../storage/beers', async (importActual) => {
  const actual = await importActual<typeof import('../storage/beers')>();
  return { ...actual, ensureOrphan: vi.fn(actual.ensureOrphan) };
});
```

У тесті «a fresh orphan from one pub is reused by a later pub (no duplicate insert)»:
`vi.mocked(upsertBeer).mockClear();` → `vi.mocked(ensureOrphan).mockClear();`;
коментар `pub B's identical tap takes the in-memory matchPrepared path (m truthy) → upsertBeer` →
`… → ensureOrphan`; `upsertBeer runs a SECOND time (DB UPSERT still dedups to 1 row, so beerCount alone` →
`ensureOrphan runs a SECOND time (it still returns the same orphan, so beerCount alone`;
`expect(upsertBeer).toHaveBeenCalledTimes(1);` → `expect(ensureOrphan).toHaveBeenCalledTimes(1);`.

Одразу після цього тесту додати:

```ts
  test('#617: a tap of another vintage becomes an orphan instead of renaming the linked row', async () => {
    const db = openDb(':memory:'); migrate(db);
    const linked = upsertBeer(db, {
      untappd_id: 6300175, name: 'O Tiole Mio! 2026', brewery: 'Monsters Brewery',
      style: 'Pastry Sour', abv: 6.0, rating_global: 3.7,
      normalized_name: normalizeName('O Tiole Mio! 2026'), normalized_brewery: normalizeBrewery('Monsters Brewery'),
      untappd_id_source: 'search',
    });
    const index = `<div onclick="location.assign('https://puba.ontap.pl/')"><div class="panel-body">A 1 taps</div></div>`;
    const body = `<body>${panel(1, 'Monsters Brewery', 'O Tiole Mio! 2025 6%', 'Sour')}</body>`;
    const http: Http = {
      async get(url: string): Promise<string> {
        if (url === 'https://ontap.pl/warszawa') return index;
        if (url === 'https://puba.ontap.pl/')
          return `<html><head><meta property="og:title" content="P / ontap.pl"></head>${body}</html>`;
        return '';
      },
    };
    await refreshOntap({
      db, log: silentLog, http, search: { search: async () => [] }, geocoder,
      cities: oneCity, lookupEnabled: false,
    });
    expect(db.prepare('SELECT untappd_id, name, style, rating_global FROM beers WHERE id = ?').get(linked))
      .toEqual({ untappd_id: 6300175, name: 'O Tiole Mio! 2026', style: 'Pastry Sour', rating_global: 3.7 });
    expect(beerCount(db)).toBe(2);
    const orphan = db.prepare('SELECT untappd_id, name FROM beers WHERE id != ?').get(linked) as { untappd_id: number | null; name: string };
    expect(orphan.untappd_id).toBeNull();
    expect(orphan.name).toMatch(/2025/);
  });
```

Якщо перед реалізацією цей тест **проходить** на старому коді — засновок «матчер відкидає інший рік
і гілка сироти знаходить злінкований рядок» у цьому сетапі не справджується: зупинись і назви у звіті,
що саме повертає `matchPrepared` для цього крана (не підганяй тест).

- [ ] **Step 2: Переконатися, що падають**

Run: `npx vitest run src/jobs/refresh-ontap.test.ts`
Expected: FAIL — «a fresh orphan from one pub is reused…» (шпигун на `ensureOrphan` = 0 викликів) і
«a tap of another vintage becomes an orphan…» (старий `upsertBeer` перейменовує злінкований рядок).

- [ ] **Step 3: Реалізація**

`src/jobs/refresh-ontap.ts`, рядок 13:

```ts
import { upsertBeer, getBeer } from '../storage/beers';
```

→

```ts
import { ensureOrphan, getBeer } from '../storage/beers';
```

У гілці сироти

```ts
            beerId = upsertBeer(db, {
```

→

```ts
            // #617: промах матчера — сирота. ensureOrphan шукає лише серед сиріт: кран іншого
            // вінтажу, якого матчер свідомо не зматчив, не перейменовує злінкований рядок.
            beerId = ensureOrphan(db, {
```

(аргументи без змін).

`src/api/routes/enrich.ts`: у списку імпорту з `'../../storage/beers'` рядок `  upsertBeer,` → `  ensureOrphan,`;
у `ensureBeerRow`

```ts
  const id = upsertBeer(db, {
    untappd_id: null, name, brewery,
    style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
    rating_global: null, normalized_name, normalized_brewery,
  });
```

→

```ts
  // #617: сюди доходимо, лише коли рядка з цією нормалізованою парою немає зовсім — вставка сироти.
  const id = ensureOrphan(db, {
    name, brewery,
    style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
    rating_global: null, normalized_name, normalized_brewery,
  });
```

(поведінка `ensureBeerRow` не змінюється — перевіряють наявні тести `enrich.test.ts`; окремого тесту немає,
бо це заміна виклику з ідентичним результатом).

- [ ] **Step 4: Проходять** — `npx vitest run src/jobs/refresh-ontap.test.ts src/api/routes/enrich.test.ts`, PASS.

- [ ] **Step 5: Мутація**

У `refresh-ontap.ts` поверни `beerId = upsertBeer(db, {` (і імпорт `upsertBeer`) → падають обидва тести з Step 2. Поверни.

- [ ] **Step 6: Повний гейт** — `npm test && npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(#617): промах матчера в refresh-ontap створює сироту, а не перейменовує злінкований вінтаж

Матчер свідомо не зматчує кран іншого року; upsertBeer без bid знаходив цей вінтаж за
нормалізованою назвою і переписував йому назву/факти. ensureOrphan шукає лише серед
сиріт. ensureBeerRow вставляє через ту саму функцію." -- src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts src/api/routes/enrich.ts
```

---

### Task 4: `seedBeer`, видалення `upsertBeer`, страж

**Диспатч імплементера** (не інлайн). У промпті: шлях worktree
`/home/ysi/warsaw-beer-bot/.claude/worktrees/617-upsert-by-bid`, **комітити лише там** (перевір
`git rev-parse --show-toplevel` перед комітом), код важить більше за план.

**Files:**
- Create: `src/storage/seed-beer.testing.ts`
- Create: `src/storage/seed-beer-guard.test.ts`
- Modify: `src/storage/beers.ts` (видалити `upsertBeer`, рядки 48-88 на момент плану)
- Modify: `src/storage/beers.test.ts` (видалити 6 тестів самої `upsertBeer`)
- Modify: кожен `src/**/*.test.ts`, що імпортує `upsertBeer` (кодмод)

**Interfaces:**
- Consumes: `BeerInput` (лишається експортованим з `src/storage/beers.ts`).
- Produces: `export function seedBeer(db: DB, b: BeerInput): number` у `src/storage/seed-beer.testing.ts` — **лише для тестів**.

- [ ] **Step 1: Сід**

Створити `src/storage/seed-beer.testing.ts` — тіло старої `upsertBeer` з `src/storage/beers.ts`
**дослівно** (скопіювати з файлу, не з плану), перейменоване на `seedBeer`, із шапкою:

```ts
import type { DB } from './db';
import { bumpCatalogVersion } from './catalog-version';
import type { BeerInput } from './beers';

// #617: ТІЛЬКИ ДЛЯ ТЕСТІВ. Стара upsertBeer: шукає рядок за untappd_id, інакше за нормалізованою
// парою, і БЕЗУМОВНО перезаписує поля. У продакшні саме це стирало рейтинги синком і переписувало
// bid вінтаж-близнюка, тому продакшн-код ходить через upsertBeerByBid / ensureOrphan, а цей сід
// лишено тестам, яким потрібен довільний рядок. Страж — seed-beer-guard.test.ts.
export function seedBeer(db: DB, b: BeerInput): number {
  // … тіло старої upsertBeer без змін …
}
```

- [ ] **Step 2: Видалити власні тести `upsertBeer` із `src/storage/beers.test.ts`**

Цілком видалити (за назвою, не за номером рядка):
`test('upsertBeer inserts then updates by normalized key', …)`,
`test('upsertBeer matches by untappd_id when normalization drifts', …)`,
`test('upsertBeer falls back to (normalized_brewery, normalized_name) when untappd_id is null', …)`,
`test('upsertBeer prefers untappd_id row over a normalized-only match', …)`,
`it('upsertBeer records the source it is given', …)`,
`it('upsertBeer leaves the source alone when not given one', …)`.
Вони тестують функцію, якої більше немає. Інші тести в `describe('#384 provenance')` лишаються.

- [ ] **Step 3: Кодмод сідів**

Записати й запустити **поза репо** (scratch, не комітити) `node <scratch>/codemod-seedbeer.mjs` з кореня worktree:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync("grep -rlw upsertBeer src --include='*.test.ts'", { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);
for (const f of files) {
  let s = readFileSync(f, 'utf8');
  s = s.replace(/import\s*\{([^}]*)\}\s*from\s*'((?:\.\.?\/)+(?:storage\/)?beers)';/g, (m, names, from) => {
    const list = names.split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.includes('upsertBeer')) return m;
    const rest = list.filter((x) => x !== 'upsertBeer');
    const seedImport = `import { seedBeer } from '${from.replace(/beers$/, 'seed-beer.testing')}';`;
    return rest.length ? `import { ${rest.join(', ')} } from '${from}';\n${seedImport}` : seedImport;
  });
  s = s.replace(/\bupsertBeer\b/g, 'seedBeer');
  writeFileSync(f, s);
  console.log('rewrote', f);
}
```

`\bupsertBeer\b` не зачіпає `upsertBeerByBid` (між `r` і `B` немає межі слова). Після запуску:
`grep -rnw upsertBeer src --include='*.test.ts'` → порожньо.

- [ ] **Step 4: Видалити `upsertBeer` з `src/storage/beers.ts`**

Видалити функцію `export function upsertBeer(db: DB, b: BeerInput): number { … }` цілком (разом із її
коментарем про «Prefer match by untappd_id…»). `BeerInput` і `BeerRow` лишаються.
Run: `grep -rnw upsertBeer src scripts --include='*.ts'` → лише коментарі (у `beers.ts` біля `SOURCE_RANK`
і в тестових коментарях, переписаних кодмодом), жодного виклику чи імпорту.

- [ ] **Step 5: Страж**

Створити `src/storage/seed-beer-guard.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(__dirname, '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsFiles(p));
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    if (name === 'seed-beer.testing.ts') continue;
    out.push(p);
  }
  return out;
}

// Той самий прийом, що в fetch-dispatcher-guard.test.ts: страж дивиться на код, а не на прозу —
// коментарі в beers.ts пояснюють, чому upsertBeer прибрано, і мусять лишатися можливими.
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

// #617: upsertBeer (безумовний перезапис + фолбек за назвою) стирав рейтинги синком і переписував
// bid вінтаж-близнюка. Продакшн ходить через upsertBeerByBid / ensureOrphan; стара поведінка живе
// лише в тестовому сіді. Шостий викликач, що відродить її, мусить впасти тут, а не в проді.
test('no production module imports the test seed or revives upsertBeer (#617)', () => {
  const offenders: string[] = [];
  for (const file of tsFiles(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/seed-beer\.testing/.test(code) || /\b(?:upsertBeer|seedBeer)\b/.test(code)) {
      offenders.push(relative(SRC, file));
    }
  }
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 6: Мутація стража**

У `src/storage/beers.ts` тимчасово додай у кінець рядок `export const upsertBeer = 1;` →
`npx vitest run src/storage/seed-beer-guard.test.ts` мусить впасти з `storage/beers.ts` у списку. Прибери.
Потім тимчасово додай у `src/jobs/refresh-ontap.ts` рядок `import { seedBeer } from '../storage/seed-beer.testing';` →
мусить впасти з `jobs/refresh-ontap.ts`. Прибери.

- [ ] **Step 7: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: зелено; кількість тестів = кількість після Task 3 − 6 (видалені тести `upsertBeer`) + 1 (страж).
Звіт задачі називає обидва числа.

- [ ] **Step 8: Commit**

```bash
git add src/storage/seed-beer.testing.ts src/storage/seed-beer-guard.test.ts
git commit -m "refactor(#617): upsertBeer прибрано з продакшну — тестовий seedBeer і страж

Жоден продакшн-модуль більше не має безумовного перезапису з фолбеком за назвою.
Стара поведінка лишилась тестовим сідом; страж не дає її відродити." -a
```

(перед `-a` переконайся `git status --short`, що змінено лише очікувані файли: `beers.ts`, `beers.test.ts`, тестові файли з кодмоду і два нові файли).

---

### Task 5: `spec.md`

**Files:**
- Modify: `spec.md`

**Interfaces:** немає.

- [ ] **Step 1: Правки** (кожна — точна заміна; якщо якір не знайдено дослівно, знайди те саме місце за змістом і назви це у звіті)

1. Рядок таблиці `beers`, колонка `abv`. Було:
   ```
   | `abv` | REAL | nullable | міцність, %; заповнюється з Untappd (`refreshAllUntappd` парсить `.abv`, backfill через `COALESCE`; orphan-lookup — теж) |
   ```
   Стало:
   ```
   | `abv` | REAL | nullable | міцність, %; заповнюється з Untappd (`refreshAllUntappd` парсить `.abv`, backfill через `COALESCE`; orphan-lookup — теж). Шлях за bid (синк чекінів, `/import`, `refreshAllUntappd`) на рядку, знайденому за bid, **лише заповнює порожнє** й нічого не стирає; на резолвленій сироті Untappd-значення переважає (#617) |
   ```
2. Колонка `rating_global`. Було:
   ```
   | `rating_global` | REAL | nullable | публічний рейтинг Untappd (`global_weighted_rating_score`) |
   ```
   Стало:
   ```
   | `rating_global` | REAL | nullable | публічний рейтинг Untappd (`global_weighted_rating_score`); шлях за bid — те саме правило, що для `abv` (#617) |
   ```
3. §3.7. Було:
   ```
   Заповнюється скрейпером (`markHad`).
   ```
   Стало:
   ```
   Заповнюється скрейпером (`markHad`); рядок пива шукається за bid зі сторінки `/beers`, а не за нормалізованою назвою — інакше позначка «пив» лягала б на вінтаж-близнюка (#617).
   ```
4. §`/import`: текст
   ```
   Ідемпотентний за `UNIQUE(telegram_id, checkin_id)`. Зчитує
   `rating_global` у `beers` (через `upsertBeer`).
   ```
   →
   ```
   Ідемпотентний за `UNIQUE(telegram_id, checkin_id)`. Рядок пива — через `upsertBeerByBid`
   (рядок експорту з bid: `style`/`abv`/`rating_global` лише заповнюють порожнє, без перейменування)
   або `ensureOrphan` (рядок без bid; злінкованого пива не торкається), #617.
   ```
5. §`POST /checkins/sync`: текст
   ```
   `400 { error: "bad_cursor" }`; парсить `parseCheckinFeedPage(html)`; на кожен чекін `upsertBeer`
   за **bid** (канонічний `untappd_id` — без fuzzy, попутно резолвить orphan'и) → локальний
   ```
   →
   ```
   `400 { error: "bad_cursor" }`; парсить `parseCheckinFeedPage(html)`; на кожен чекін `upsertBeerByBid`
   за **bid** (канонічний `untappd_id`; не знайдено — резолвить **єдину** сироту з тією самою нормалізованою
   парою й сумісними цифровими токенами назви, інакше новий рядок; факти не стираються, назва не змінюється,
   провенанс лише посилюється, #617) → локальний
   ```
6. §провенанс. Після речення
   ```
   bid міг би **послабити** ручний пін (#343) чи check-in-based зв'язок.
   ```
   дописати (через пробіл, у тому ж абзаці):
   ```
   Шлях за bid (`upsertBeerByBid`, #617) тримає ранг `curated` > `checkin` > `bid` > `search` > `NULL`: провенанс лише посилюється, тож синк чекінів не понижує пін до `checkin`.
   ```
7. Після абзацу **«Підготовка каталогу раз на запуск (#278).»** (закінчується `той самий чанк-білд (одноразовий, без інкрементального add).`) додати окремим абзацом:
   ```

   **Сирота при промаху матчера (#617).** Промах іде в `ensureOrphan`: вона шукає за нормалізованою парою
   **лише серед сиріт** і злінкованого рядка не торкається ніколи — кран іншого вінтажу, якого матчер свідомо
   не зматчив, дає нову сироту, а не перейменування злінкованого рядка. Факти наявної сироти не
   переписуються. Відоме обмеження: сироти з однаковою нормалізованою назвою злипаються.
   ```

8. Абзац про кеш каталогу (§ продуктивність `/match`). Було:
   ```
   storage-мутатори (`upsertBeer`, `recordLookupSuccess`, `mergeIntoCanonical`,
   ```
   Стало:
   ```
   storage-мутатори (`upsertBeerByBid`, `ensureOrphan`, `recordLookupSuccess`, `mergeIntoCanonical`,
   ```

- [ ] **Step 2: Перевірка** — `grep -n "upsertBeer\b" spec.md` → порожньо. На момент плану згадок три
  (рядки ~640, ~920, ~1524); правки 4, 8 і 5 прибирають усі три. `\b` не зачіпає `upsertBeerByBid`.

- [ ] **Step 3: Повний гейт** — `npm test && npm run typecheck` (spec не впливає, але гейт повний за правилом).

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(#617): spec.md — ідентичність за bid, лише заповнення фактів, ранг провенансу" -- spec.md
```

---

## Результат наскрізного рев'ю гілки (2026-09-13)

Задачі 1, 2, 3, 5 — інлайн; Task 4 — імплементер. Порядок змінено: Task 5 перед Task 4, бо
імплементер комітить `git commit -a`. Блокерів немає; знахідки, перевірені по коду:

- **Обґрунтування цього плану щодо `ensureOrphan` було перевернуте.** Тут написано, що наявна сирота
  з тією ж парою «ловиться точною стадією матчера», і з цього зроблено висновок, що reuse безпечний.
  Насправді звідси випливає протилежне: у гілці сироти `refresh-ontap` така сирота досяжна лише коли
  матчер відкинув її як інший рік, тож reuse спрацьовував саме в поганому випадку (кран «2025» →
  сирота «2024», реплей рецензента). Виправлено: `ensureOrphan` фільтрує сироти
  `numericTokensCompatible`. Рішення «факти не заповнювати» лишається — з тієї самої причини.
- **`spec.md` приписував `refreshAllUntappd` «лише заповнення»** на рядку за bid — хибно: джоба
  перезаписує `rating_global` своїм `UPDATE` (семантика до #616). Виправлено.
- §3.13 `spec.md`: `upsertBeerByBid` теж видаляє `enrich_failures` — дописано.
- Страж сканує й `scripts/` (rsync-иться в прод). Динамічний `import()` зі склеєним рядком обходить
  будь-який статичний страж — прийнято.
- Тест `/import` без bid не перевіряв `untappd_id_source` (мутація `!= null` → `!== undefined`
  виживала) — дописано. Тест інструментації версії каталогу перевіряв тестовий сід — переведено на
  `ensureOrphan`/`upsertBeerByBid`.
- Поза межами (окремі issue на розсуд користувача): матчер серед близнюків без ABV бере найновіший;
  Untappd, що перепризначив bid, дає дубль у `refresh-untappd`; `/import` без bid лінкує чекіни до
  сироти поза пулами enrich.

## Після обв'язки

1. Наскрізне рев'ю всієї гілки (ядро + обв'язка), у диспатчі названі інлайнові задачі 1, 2, 3, 5.
2. `git fetch origin main` → `git rebase origin/main` → повний гейт → PR (CLAUDE.md).
3. Перевірка користувацького чейнджлогу: зміна серверна, `extension/CHANGELOG.md` не зачіпається.
