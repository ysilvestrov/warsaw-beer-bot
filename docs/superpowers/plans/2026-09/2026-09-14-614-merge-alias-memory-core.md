# Пам'ять злиття для назв з крамниць — план ядра (#614)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** злиття сироти в канонічний рядок запам'ятовує пару «броварня + назва» сироти як аліас
канонічного рядка. Кеш каталогу `/match` і MCP читає аліаси. Та сама картка крамниці після першого
пошуку дає `exact` з особистим статусом «пив» і оцінкою.

**Architecture:** це **ядро** стадійної зміни (правило CLAUDE.md «план на ядро → рев'ю → окремий
план на обв'язку»). Ядро складається з трьох частин:
- таблиця `beer_aliases` (міграція v32);
- запис у `mergeIntoCanonical`, єдиній точці, де сирота зникає;
- читання в `createCatalogCache`.

Уже на ядрі петля #614 закривається. Ядро безпечне для окремого деплою: картка з аліасом і
суперечливим bid створює звичайну сироту, злиття переписує аліас, канонічний рядок не
зачіпається (спека, «Стадії»).

**Периферія йде окремим планом після наскрізного рев'ю ядра:**
- аліасне влучання в `ensureBeerRow`;
- репарація #384 через аліас;
- наскрізний API-тест;
- `spec.md`.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest 4 (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською**, як у решті репо.
- **Повний гейт після КОЖНОЇ задачі** (`npm test && npm run typecheck`), ніколи не звужений до
  своїх файлів. Розширення (`extension/`) ця зміна не зачіпає.
- **Кожен тест мутаційно доведений.** У кроці «мутація» прибери або зміни названий рядок
  реалізації: тест має впасти. Потім поверни рядок. Тест, що лишається зеленим без реалізації, у
  мердж не йде.
- **Сіди з видимими значеннями**, не `null`: `null`-сід робить «проігноровано» і «використано»
  однаковими (пам'ять `feedback_stub_defaults_hide_mutations`).
- **Два рядки з однаковою нормалізованою парою сідуються лише сирим `INSERT`.** `seedBeer` шукає
  наявний рядок за парою і переписав би перший рядок другим.
- **Ніяких `as unknown as` кастів.**
- **Поза ядром:** `ensureBeerRow`, `/enrich/*`, `refresh-ontap`, `ensureOrphan` і `spec.md` у
  ядрі не змінюються.
- **Код важить більше за цей план.** Якщо сигнатура, імпорт чи назва в репо розходиться з текстом
  плану, іди за кодом і назви розбіжність у звіті задачі.
- **Worktree.** Робота йде у worktree від `origin/main`. Спершу `git cherry-pick` комітів спеки й
  цього плану з локального `main` (пам'ять `reference_worktree_docs_cherrypick`).
- **Виконання інлайн.** Усі три задачі дрібні за правилом CLAUDE.md: повний код у тексті, ≤2
  файли + тести, без нових рішень. Контролер виконує їх **інлайн**. Усі три обов'язково
  називаються в диспатчі наскрізного рев'ю ядра.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `src/storage/schema.ts` (зміна) | міграція v32: таблиця `beer_aliases` |
| `src/storage/schema.test.ts` (зміна) | тести v32; голова версії 31 → 32 у двох наявних тестах |
| `src/storage/beers.ts` (зміна) | запис аліасу в `mergeIntoCanonical`; нова `loadAliasCatalog` |
| `src/storage/beers.test.ts` (зміна) | тести запису й читання аліасів |
| `src/domain/catalog-cache.ts` (зміна) | опція `loadAliases`; аліаси йдуть у `prepare`, `byId` лише з рядків `beers` |
| `src/domain/catalog-cache.test.ts` (зміна) | юніт на `byId`; інтеграційний тест «злиття → `exact` з ✅» |

---

### Task 1: міграція v32 — таблиця `beer_aliases`

**Files:**
- Modify: `src/storage/schema.ts` (новий елемент `MIGRATIONS` після `version: 31`)
- Test: `src/storage/schema.test.ts` (новий `describe` у кінці файлу; дві наявні перевірки
  голови версії — рядки ~536–538 і ~585–587)

**Interfaces:**
- Consumes: нічого.
- Produces: таблиця `beer_aliases(id, beer_id → beers(id) ON DELETE CASCADE, brewery, name,
  normalized_brewery, normalized_name, created_at)` з `UNIQUE (normalized_brewery,
  normalized_name)` та індексом `idx_beer_aliases_beer`. Задачі 2 і 3 пишуть і читають саме ці
  колонки.

- [ ] **Step 1: Write the failing tests**

Додай у кінець `src/storage/schema.test.ts`:

```ts
describe('v32 beer_aliases (#614)', () => {
  it('creates beer_aliases with the spec columns and one alias per normalized pair', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(beer_aliases)').all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toEqual([
      'id', 'beer_id', 'brewery', 'name', 'normalized_brewery', 'normalized_name', 'created_at',
    ]);
    db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
                VALUES (2815, 3548624, 'Black Bean', 'Varvar Brew', 'black bean', 'varvar brew')`).run();
    const insert = db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
       VALUES (2815, 'VARVAR', 'BLACK BEAN IS', 'varvar', 'black bean is', '2026-09-14T07:13:20Z')`,
    );
    insert.run();
    // Одна пара з картки означає одне пиво: друга така сама пара відмовляється.
    expect(() => insert.run()).toThrow(/UNIQUE constraint failed/);
  });

  it('drops a beer row\'s aliases together with the row', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
                VALUES (2815, 3548624, 'Black Bean', 'Varvar Brew', 'black bean', 'varvar brew')`).run();
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
       VALUES (2815, 'VARVAR', 'BLACK BEAN IS', 'varvar', 'black bean is', '2026-09-14T07:13:20Z')`,
    ).run();
    db.prepare('DELETE FROM beers WHERE id = 2815').run();
    const left = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
    expect(left.n).toBe(0);
  });
});
```

У двох наявних перевірках голови версії заміни `toBe(31)` на `toBe(32)` і допиши в їхній коментар
`, 31 -> 32 by #614`:

- у тесті `rewrites legacy wontfix rows during the rebuild` (рядок ~538);
- у тесті `v25 is reachable and recorded in schema_version` (рядок ~587).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: FAIL. Нові тести падають на `PRAGMA table_info(beer_aliases)`: порожній список
замість колонок і `no such table: beer_aliases` на `INSERT`. Дві перевірки голови падають з
`expected 31 to be 32`.

- [ ] **Step 3: Write the migration**

У `src/storage/schema.ts` додай після елемента `version: 31` (перед закриваючою `];` масиву
`MIGRATIONS`):

```ts
  {
    version: 32,
    // #614: злиття сироти в канонічний рядок видаляє єдиний запис того, що пара «броварня + назва»
    // з картки крамниці — це саме це пиво. Без нього `/match` на кожне завантаження сторінки знову
    // не впізнає картку, розширення знову шукає в сесії Untappd і сервер знову зливає нову сироту.
    // Аліас зберігає сиру пару (для матчера: nameKeys, breweryAliases і рік читаються з сирого
    // тексту) і нормалізовану (унікальність і пошук). Без бекфілу: сирота видаляється при злитті,
    // тож відновлювати пару нема з чого — таблиця заповнюється першим же злиттям (як merged_at, #366).
    // IF NOT EXISTS — бо тести відкату в schema.test.ts перезапускають усі міграції від v22.
    sql: `
      CREATE TABLE IF NOT EXISTS beer_aliases (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        beer_id            INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
        brewery            TEXT NOT NULL,
        name               TEXT NOT NULL,
        normalized_brewery TEXT NOT NULL,
        normalized_name    TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        UNIQUE (normalized_brewery, normalized_name)
      );
      CREATE INDEX IF NOT EXISTS idx_beer_aliases_beer ON beer_aliases(beer_id);
    `,
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: PASS (усі тести файлу, зокрема три тести відкату v22/v23/v24).

- [ ] **Step 5: Mutations**

1. **Прибери рядок `UNIQUE (normalized_brewery, normalized_name)`.** Перший тест має впасти на
   `toThrow`. Поверни рядок.
2. **Заміни `ON DELETE CASCADE` на порожній рядок.** Другий тест має впасти: `DELETE FROM beers`
   відмовить з `FOREIGN KEY constraint failed` (у `openDb` `foreign_keys = ON`). Поверни.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS, typecheck без помилок.

- [ ] **Step 7: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(#614): add beer_aliases table (migration v32)"
```

---

### Task 2: `mergeIntoCanonical` запам'ятовує пару сироти

**Files:**
- Modify: `src/storage/beers.ts` — тіло `mergeIntoCanonical` (рядки ~320–342)
- Test: `src/storage/beers.test.ts` — нові тести одразу після тесту
  `mergeIntoCanonical redirects check-ins instead of FK-crashing on the delete` (рядок ~791)

**Interfaces:**
- Consumes: таблиця `beer_aliases` з Task 1.
- Produces: після `mergeIntoCanonical(db, orphanId, canonicalId, at)`:
  - кожен аліас, що вказував на `orphanId`, вказує на `canonicalId`;
  - якщо жоден рядок `beers`, крім сироти, не має її нормалізованої пари, у `beer_aliases` є
    рядок `{beer_id: canonicalId, brewery, name, normalized_brewery, normalized_name}` сироти
    з `created_at = at`. Наявний аліас тієї самої пари переписується на `canonicalId`.

  Сигнатура функції не змінюється.

- [ ] **Step 1: Write the failing tests**

Додай після тесту `mergeIntoCanonical redirects check-ins instead of FK-crashing on the delete`:

```ts
// --- #614: пам'ять злиття для назв з крамниць -------------------------------------------------

type AliasRow = {
  beer_id: number; brewery: string; name: string;
  normalized_brewery: string; normalized_name: string; created_at: string;
};

function aliasesOf(db: ReturnType<typeof fresh>, beerId: number): AliasRow[] {
  return db.prepare(
    `SELECT beer_id, brewery, name, normalized_brewery, normalized_name, created_at
       FROM beer_aliases WHERE beer_id = ? ORDER BY id`,
  ).all(beerId) as AliasRow[];
}

// Випадок користувача 2026-09-14: картка Flasker «VARVAR BLACK BEAN IS 11% 0.33л» проти
// каталожного «Varvar Brew / Black Bean» (bid 3548624).
function aliasFixture() {
  const db = fresh();
  const canonicalId = seedBeer(db, {
    untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
    style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
    normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
  });
  const orphanId = seedBeer(db, {
    name: 'BLACK BEAN IS', brewery: 'VARVAR', style: null, abv: 11, rating_global: null,
    normalized_name: normalizeName('BLACK BEAN IS'), normalized_brewery: normalizeBrewery('VARVAR'),
  });
  return { db, canonicalId, orphanId };
}

test('#614 mergeIntoCanonical remembers the orphan\'s shop pair as an alias of the canonical row', () => {
  const { db, canonicalId, orphanId } = aliasFixture();

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T07:13:20Z');

  expect(aliasesOf(db, canonicalId)).toEqual([{
    beer_id: canonicalId,
    brewery: 'VARVAR',
    name: 'BLACK BEAN IS',
    normalized_brewery: normalizeBrewery('VARVAR'),
    normalized_name: normalizeName('BLACK BEAN IS'),
    created_at: '2026-09-14T07:13:20Z',
  }]);
});

test('#614 mergeIntoCanonical carries a merged row\'s own aliases over instead of cascading them away', () => {
  const { db, canonicalId, orphanId } = aliasFixture();
  // Сирота сама вже була ціллю давнішого злиття іншої картки.
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
     VALUES (?, 'Varvar', 'Black Bean Tonka', ?, ?, '2026-09-01T10:00:00Z')`,
  ).run(orphanId, normalizeBrewery('Varvar'), normalizeName('Black Bean Tonka'));

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T07:13:20Z');

  expect(aliasesOf(db, canonicalId).map((a) => a.name)).toEqual(['Black Bean Tonka', 'BLACK BEAN IS']);
});

test('#614 mergeIntoCanonical writes no alias for a pair another beer row already holds (vintage twin)', () => {
  const db = fresh();
  // normalizeName відкидає числові токени, тож «… 10» і «… 8» мають одну пару. Без цієї
  // передумови тест нічого б не доводив.
  expect(normalizeName('Trappistes Rochefort 10')).toBe(normalizeName('Trappistes Rochefort 8'));
  const pairName = normalizeName('Trappistes Rochefort 10');
  const pairBrewery = normalizeBrewery('Abbaye de Rochefort');
  // Сирий INSERT: seedBeer злив би двох близнюків з однаковою парою в один рядок.
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, abv, normalized_name, normalized_brewery)
     VALUES (10, 2002, 'Rochefort 10', 'Brasserie Rochefort', 11.3, ?, ?),
            (8, 1001, 'Trappistes Rochefort 8', 'Abbaye de Rochefort', 9.2, ?, ?),
            (77, NULL, 'Trappistes Rochefort 10', 'Abbaye de Rochefort', 11.3, ?, ?)`,
  ).run(
    normalizeName('Rochefort 10'), normalizeBrewery('Brasserie Rochefort'),
    pairName, pairBrewery,
    pairName, pairBrewery,
  );

  mergeIntoCanonical(db, 77, 10, '2026-09-14T00:03:58Z');

  // Аліас на пару близнюка 8 дав би /match для «Rochefort 8» другого точного кандидата з id 10.
  const n = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
  expect(n.n).toBe(0);
});

test('#614 mergeIntoCanonical re-points an existing alias of the same pair to the newest merge target', () => {
  const db = fresh();
  const oldTarget = seedBeer(db, {
    untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5.4, rating_global: 3.61,
    normalized_name: normalizeName('Red Mexican Spicy Edition'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  const newTarget = seedBeer(db, {
    untappd_id: 5120103, name: 'Red Mexican', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5, rating_global: 3.72,
    normalized_name: normalizeName('Red Mexican'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  const cardBrewery = 'Copper Head';
  const cardName = 'RED MEXICAN Tomato Gose';
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
     VALUES (?, ?, ?, ?, ?, '2026-09-02T10:00:00Z')`,
  ).run(oldTarget, cardBrewery, cardName, normalizeBrewery(cardBrewery), normalizeName(cardName));
  // Нова сирота тієї самої картки (досяжно зі шляху кранів або з репарації #384).
  const orphanId = seedBeer(db, {
    name: cardName, brewery: cardBrewery, style: 'Gose', abv: 5, rating_global: null,
    normalized_name: normalizeName(cardName), normalized_brewery: normalizeBrewery(cardBrewery),
  });

  mergeIntoCanonical(db, orphanId, newTarget, '2026-09-14T07:11:40Z');

  const rows = db.prepare('SELECT beer_id, created_at FROM beer_aliases').all();
  expect(rows).toEqual([{ beer_id: newTarget, created_at: '2026-09-14T07:11:40Z' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/beers.test.ts -t "#614"`
Expected: FAIL.
- Тести 1, 2, 4 падають: аліасів немає, у тесті 2 давніший аліас зникає каскадом.
- Тест 3 (близнюк) проходить уже зараз: без запису аліасів таблиця порожня. Він стане
  значущим після Step 3, і його доводить мутація 3.

- [ ] **Step 3: Implement**

У `src/storage/beers.ts` всередині транзакції `mergeIntoCanonical` додай блок **між** рядком
`db.prepare('UPDATE checkins SET beer_id = ? WHERE beer_id = ?').run(canonicalId, orphanId);` і
рядком `db.prepare('DELETE FROM beers WHERE id = ?').run(orphanId);`:

```ts
    // #614: злиття — єдиний момент, коли відомо «пара броварня + назва цієї сироти = канонічний
    // рядок». DELETE нижче знищив би це знання, і /match на кожне завантаження сторінки знову не
    // впізнавав би ту саму картку крамниці. Спершу аліаси самої сироти переходять на канонічний
    // рядок, інакше ON DELETE CASCADE забрав би пам'ять давніших злиттів.
    db.prepare('UPDATE beer_aliases SET beer_id = ? WHERE beer_id = ?').run(canonicalId, orphanId);
    const orphan = db
      .prepare('SELECT brewery, name, normalized_brewery, normalized_name FROM beers WHERE id = ?')
      .get(orphanId) as
      | { brewery: string; name: string; normalized_brewery: string; normalized_name: string }
      | undefined;
    if (orphan) {
      // Пару, яку тримає інший рядок, аліасом не робимо: normalizeName відкидає числові токени,
      // тож ontap-сирота «Rochefort 10» має пару злінкованого близнюка «Rochefort 8», і аліас дав би
      // /match для «Rochefort 8» другого точного кандидата з id іншого вінтажу.
      const claimed = db
        .prepare('SELECT 1 FROM beers WHERE normalized_brewery = ? AND normalized_name = ? AND id <> ?')
        .get(orphan.normalized_brewery, orphan.normalized_name, orphanId);
      if (!claimed) {
        // Та сама пара вже вказує на інший рядок → переходить на новий: найсвіжіше злиття має
        // найсвіжіший доказ.
        db.prepare(
          `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(normalized_brewery, normalized_name) DO UPDATE SET
             beer_id = excluded.beer_id,
             brewery = excluded.brewery,
             name = excluded.name,
             created_at = excluded.created_at`,
        ).run(
          canonicalId, orphan.brewery, orphan.name,
          orphan.normalized_brewery, orphan.normalized_name, at,
        );
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: PASS (усі тести файлу, зокрема три наявні тести `mergeIntoCanonical`).

- [ ] **Step 5: Mutations**

Кожну поверни після перевірки.

1. **Прибери `INSERT … ON CONFLICT` цілком.** Мають упасти тести 1 і 4.
2. **Прибери `UPDATE beer_aliases SET beer_id = ? WHERE beer_id = ?`.** Має впасти тест 2:
   залишиться лише `BLACK BEAN IS`.
3. **Заміни `if (!claimed)` на `if (true)`.** Має впасти тест 3 (`expected 1 to be 0`).
4. **Прибери `AND id <> ?`** разом з аргументом `orphanId` у `.get(...)`. Має впасти тест 1:
   сирота «тримає» власну пару, і аліас не пишеться.
5. **Заміни `DO UPDATE SET …` на `DO NOTHING`.** Має впасти тест 4: `beer_id` лишиться `oldTarget`.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS, typecheck без помилок.

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#614): remember a merged orphan's shop pair as an alias"
```

---

### Task 3: кеш каталогу читає аліаси

**Files:**
- Modify: `src/storage/beers.ts` — нова `loadAliasCatalog` одразу після `loadCatalog` (рядок ~275)
- Modify: `src/domain/catalog-cache.ts` — опція `loadAliases`, збірка в `rebuild`
- Test: `src/storage/beers.test.ts` (нові тести в кінці файлу)
- Test: `src/domain/catalog-cache.test.ts`:
  - хелпер `make` (рядок ~19–21);
  - нові тести в кінці `describe('createCatalogCache', …)`;
  - новий інтеграційний `describe` у кінці файлу.

**Interfaces:**
- Consumes: таблиця `beer_aliases` (Task 1), аліаси, які пише `mergeIntoCanonical` (Task 2).
- Produces:
  - `export function loadAliasCatalog(db: DB): CatalogRow[]`. Повертає по рядку на аліас,
    канонічний рядок якого має `untappd_id`, у формі `{ id: beer_id, brewery: сира броварня
    аліасу, name: сира назва аліасу, abv, rating_global, untappd_id — канонічного рядка }`.
  - `CatalogCacheOptions.loadAliases?: () => CatalogBeerWithRating[]`. За замовчуванням
    `loadAliasCatalog(db)`.
  - `CachedCatalog.prepared` містить рядки `beers` і аліаси, `CachedCatalog.byId` — **лише**
    рядки `beers`.

  Периферія спиратиметься саме на ці назви.

- [ ] **Step 1: Write the failing tests**

**(a)** У кінець `src/storage/beers.test.ts`:

```ts
// --- #614: аліаси в каталозі матчера ------------------------------------------------------------
import { loadAliasCatalog } from './beers';

describe('loadAliasCatalog (#614)', () => {
  test('returns each alias as a catalog row of its canonical beer: shop text, canonical facts', () => {
    const db = fresh();
    const canonicalId = seedBeer(db, {
      untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
      style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
       VALUES (?, 'VARVAR', 'BLACK BEAN IS', ?, ?, '2026-09-14T07:13:20Z')`,
    ).run(canonicalId, normalizeBrewery('VARVAR'), normalizeName('BLACK BEAN IS'));

    // ABV канонічного рядка: точна стадія спершу обирає за ABV, і аліас без ABV програв би
    // іншому точному кандидату з ABV.
    expect(loadAliasCatalog(db)).toEqual([{
      id: canonicalId, brewery: 'VARVAR', name: 'BLACK BEAN IS',
      abv: 11, rating_global: 4.14, untappd_id: 3548624,
    }]);
  });

  test('skips an alias whose canonical row has lost its untappd_id', () => {
    const db = fresh();
    const unlinkedId = seedBeer(db, {
      name: 'Black Bean', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
       VALUES (?, 'VARVAR', 'BLACK BEAN IS', ?, ?, '2026-09-14T07:13:20Z')`,
    ).run(unlinkedId, normalizeBrewery('VARVAR'), normalizeName('BLACK BEAN IS'));

    expect(loadAliasCatalog(db)).toEqual([]);
  });
});
```

**(b)** У `src/domain/catalog-cache.test.ts` заміни хелпер `make`:

```ts
// Minimal cache under test with injected seams. `db` is never touched (load and loadAliases are
// injected); a test may still override loadAliases through opts.
function make(opts: Parameters<typeof createCatalogCache>[1]): CatalogCache {
  return createCatalogCache({} as DB, { loadAliases: () => [], ...opts });
}
```

У кінець `describe('createCatalogCache', …)` (перед його закриваючою `});`) додай:

```ts
  it('#614 matches aliases but keeps byId to the real rows, so the answer shows the canonical name', async () => {
    const aliases: CatalogBeerWithRating[] = [
      { id: 1, brewery: 'PINTA', name: 'Atak Chmielu IPA', abv: 6.1, rating_global: 3.7, untappd_id: 111 },
    ];
    const cache = make({ getVersion: () => 0, load: () => rows, loadAliases: () => aliases });
    const { prepared, byId } = await cache.get();
    expect(prepared.beers.map((b) => `${b.id} ${b.name}`)).toEqual([
      '1 Atak Chmielu', '2 Buty Skejta', '1 Atak Chmielu IPA',
    ]);
    expect(byId.size).toBe(2);
    expect(byId.get(1)?.name).toBe('Atak Chmielu');
  });
```

**(c)** Інтеграційний тест у кінець `src/domain/catalog-cache.test.ts`. Імпорти дописати до
наявних угорі файлу:

```ts
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { seedBeer } from '../storage/seed-beer.testing';
import { mergeIntoCanonical } from '../storage/beers';
import { normalizeBrewery, normalizeName } from './normalize';
import { matchBeerList } from './match-list';
```

```ts
describe('#614 merge memory reaches /match', () => {
  it('after a merge the same shop card matches the canonical row exactly, with the drinker\'s status', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const canonicalId = seedBeer(db, {
      untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
      style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const orphanId = seedBeer(db, {
      name: 'BLACK BEAN IS', brewery: 'VARVAR', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('BLACK BEAN IS'), normalized_brewery: normalizeBrewery('VARVAR'),
    });
    mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T07:13:20Z');

    const card = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
    const drunk = new Set([canonicalId]);
    const ratings = new Map([[canonicalId, 4.5]]);
    const noYield = { yield: async () => {} };

    // Контроль на тій самій БД без аліасів: картка НЕ дає точного збігу — інакше тест нічого б
    // не доводив (прод-реплей 2026-09-14: null).
    const blind = await createCatalogCache(db, { loadAliases: () => [] }).get();
    const { results: [control] } = await matchBeerList(blind.prepared, blind.byId, drunk, ratings, [card], noYield);
    expect(control.source).not.toBe('exact');
    expect(control.is_drunk).toBe(false);

    const { prepared, byId } = await createCatalogCache(db).get();
    const { results: [r] } = await matchBeerList(prepared, byId, drunk, ratings, [card], noYield);
    expect(r.matched_beer).toEqual({
      id: canonicalId, name: 'Black Bean', brewery: 'Varvar Brew', rating_global: 4.14, untappd_id: 3548624,
    });
    expect(r.source).toBe('exact');
    expect(r.is_drunk).toBe(true);
    expect(r.user_rating).toBe(4.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/beers.test.ts src/domain/catalog-cache.test.ts`
Expected: FAIL.
- **Typecheck/імпорт:** `loadAliasCatalog` не експортується (vitest впаде на імпорті або дасть
  `loadAliasCatalog is not a function`).
- **Опція кешу:** `loadAliases` ігнорується, тож у `prepared.beers` 2 рядки замість 3.
- **Інтеграційний тест:** `r.matched_beer` не канонічний `exact`.

- [ ] **Step 3: Implement**

**(a)** `src/storage/beers.ts`, одразу після функції `loadCatalog`:

```ts
// #614: кожен аліас — ще один запис каталогу матчера з id канонічного рядка. Текст — з картки
// крамниці (саме його надішле /match), факти — канонічного рядка: ABV потрібен точній стадії, яка
// спершу обирає за ABV. Аліас на рядок без untappd_id не читається — та сама жива перевірка, що й
// isRememberedMerge (#366): пам'ять про злиття має сенс лише поки ціль справді злінкована.
export function loadAliasCatalog(db: DB): CatalogRow[] {
  return db
    .prepare(
      `SELECT a.beer_id AS id, a.brewery, a.name, b.abv, b.rating_global, b.untappd_id
         FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
        WHERE b.untappd_id IS NOT NULL
        ORDER BY a.id`,
    )
    .all() as CatalogRow[];
}
```

**(b)** `src/domain/catalog-cache.ts`:

Імпорт у рядку 2:

```ts
import { loadAliasCatalog, loadCatalog } from '../storage/beers';
```

В `interface CatalogCacheOptions` після рядка `load?: …`:

```ts
  loadAliases?: () => CatalogBeerWithRating[];                      // default: loadAliasCatalog(db) (#614)
```

У `createCatalogCache` після `const load = …`:

```ts
  const loadAliases = opts.loadAliases ?? (() => loadAliasCatalog(db));
```

У `rebuild` заміни три рядки

```ts
      const rows = load();
      const prepared = await prepare(rows);
      const byId = new Map(rows.map((r) => [r.id, r]));
```

на

```ts
      const rows = load();
      // #614: аліаси матчаться як звичайні записи з id канонічного рядка, але byId будується лише
      // з рядків beers — інакше аліас з тим самим id переписав би канонічну назву й рейтинг у
      // відповіді /match назвою з картки крамниці.
      const aliases = loadAliases();
      const prepared = await prepare([...rows, ...aliases]);
      const byId = new Map(rows.map((r) => [r.id, r]));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/beers.test.ts src/domain/catalog-cache.test.ts src/api/routes/match.test.ts src/api/routes/mcp.test.ts`
Expected: PASS. `match`/`mcp` створюють кеш на справжній БД через дефолтний `loadAliases`.

- [ ] **Step 5: Mutations**

Кожну поверни після перевірки.

1. **Прибери `WHERE b.untappd_id IS NOT NULL`.** Має впасти `skips an alias whose canonical row
   has lost its untappd_id`.
2. **Заміни `b.abv` на `NULL AS abv`.** Має впасти `returns each alias as a catalog row…`.
3. **Заміни `prepare([...rows, ...aliases])` на `prepare(rows)`.** Мають упасти юніт `#614
   matches aliases…` (2 рядки замість 3) та інтеграційний тест.
4. **Заміни `new Map(rows.map(…))` на `new Map([...rows, ...aliases].map(…))`.** Має впасти юніт
   `#614 matches aliases…` і інтеграційний тест. Розмір `byId` лишиться 2, бо ключ 1 просто
   перезапишеться. Але `byId.get(1)?.name` стане `Atak Chmielu IPA`, а `matched_beer.name` в
   інтеграційному тесті — `BLACK BEAN IS`.
5. **У Task 2 прибери `INSERT … ON CONFLICT`.** Має впасти інтеграційний тест. Це доказ, що він
   ловить петлю наскрізно.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: усі тести PASS, typecheck без помилок.

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/catalog-cache.ts src/domain/catalog-cache.test.ts
git commit -m "feat(#614): load merge aliases into the /match catalog"
```

---

## Після ядра

1. **Наскрізне рев'ю ядра**, окремий диспатч. Назвати всі три інлайнові задачі. Попросити
   перевірити проти спеки:
   - запис аліасу в транзакції злиття, його порядок відносно `DELETE`, правило близнюків;
   - `byId` без аліасів;
   - чи немає іншого місця, де сирота зникає повз `mergeIntoCanonical`
     (`grep -rn "DELETE FROM beers" src`).
2. **Лише після рев'ю** — план периферії:
   - аліасне влучання в `ensureBeerRow`;
   - репарація #384 через аліас;
   - наскрізний API-тест;
   - `spec.md`.

## Самоперевірка плану проти спеки

| Розділ спеки | Де в плані |
|---|---|
| Дані: таблиця, унікальна пара, каскад, без бекфілу | Task 1 |
| Запис: перенесення аліасів сироти | Task 2, тест 2 |
| Запис: правило «пару тримає інший рядок» | Task 2, тест 3 |
| Запис: `ON CONFLICT` → найсвіжіше злиття | Task 2, тест 4 |
| Читання: жива перевірка `untappd_id`, ABV канонічного рядка | Task 3 (a) |
| Читання: `byId` лише з рядків `beers` | Task 3 (b), мутація 4 |
| Результат: `exact`, `is_drunk`, `user_rating` через аліас | Task 3 (c) |
| `ensureBeerRow`, `/enrich/*`, репарація #384, API-тест, `spec.md` | **периферія** (свідомо поза ядром) |
| Спостереження після деплою | після мерджу обох стадій |
