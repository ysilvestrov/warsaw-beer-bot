# Пам'ять злиття для назв з крамниць — план ядра (#614), переглянутий після рев'ю

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** злиття сироти в канонічний рядок запам'ятовує пару «броварня + назва» сироти як аліас.
`/match` і MCP перевіряють аліас **перед** матчером, з правилом цифр, і дають `exact` з особистим
статусом «пив» і оцінкою. Аліаси відкидаються, коли bid їхнього рядка змінюється.

**Architecture:** **ядро** стадійної зміни. Перша версія ядра (коміти `9325d68`, `67bacfe`)
додавала аліаси в каталог матчера і переносила аліаси рядка, що зливається. Наскрізне рев'ю
знайшло хибний ✅ для числових близнюків і аліаси, що йдуть за переписаним bid (спека, розділ
«Рев'ю ядра»). Цей план переробляє ядро **новими комітами поверх** гілки. Задача 1 (міграція v32,
`111828b`) лишається як є.

**Периферія йде окремим планом після повторного наскрізного рев'ю ядра:**
- аліасне влучання в `ensureBeerRow`;
- репарація #384 через аліас;
- наскрізний API-тест `/enrich/*` → `/match`;
- `spec.md`.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською**, як у решті репо.
- **Повний гейт після КОЖНОЇ задачі** (`npm test && npm run typecheck`), ніколи не звужений до
  своїх файлів. Розширення (`extension/`) ця зміна не зачіпає.
- **Кожен тест мутаційно доведений.** У кроці «мутація» прибери або зміни названий рядок
  реалізації: тест має впасти. Потім поверни рядок. Тест, що лишається зеленим без реалізації, у
  мердж не йде.
- **Сіди з видимими значеннями**, не `null` (пам'ять `feedback_stub_defaults_hide_mutations`).
- **Два рядки з однаковою нормалізованою парою сідуються лише сирим `INSERT`**: `seedBeer` шукає
  наявний рядок за парою і переписав би перший рядок другим.
- **Ніяких `as unknown as` кастів.**
- **Поза ядром:** `ensureBeerRow`, `/enrich/*`, `refresh-ontap`, `ensureOrphan` і `spec.md`.
- **Код важить більше за цей план.** Якщо сигнатура, імпорт чи назва в репо розходиться з текстом
  плану, іди за кодом і назви розбіжність у звіті задачі.
- **Виконання інлайн.** Задачі 2–6 дрібні за правилом CLAUDE.md (повний код у тексті, ≤2 файли +
  тести, без нових рішень). Контролер виконує їх інлайн; усі називаються в диспатчі повторного
  наскрізного рев'ю.
- **Git в ізольованій сесії worktree** — лише прості окремі команди (`git add …`, `git commit …`),
  без ланцюжків з npm і без змінних.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `src/storage/beers.ts` | запис аліасу в `mergeIntoCanonical` без перенесення; `dropAliasesOnRelink`; `recordLookupSuccess` відкидає аліаси при зміні bid; `loadAliases` замість `loadAliasCatalog` |
| `src/domain/pin-match.ts` | пін на інший bid відкидає аліаси рядка |
| `src/domain/match-list.ts` | `AliasIndex`, `buildAliasIndex`, аліас перед матчером з правилом цифр |
| `src/domain/catalog-cache.ts` | індекс аліасів у `CachedCatalog`; каталог матчера без аліасів |
| `src/api/routes/match.ts`, `src/api/mcp/match-tool.ts` | передати `aliases` у `matchBeerList` |
| тести поруч з кожним файлом | див. задачі |

---

### Task 1: міграція v32 — таблиця `beer_aliases` — ✅ ЗРОБЛЕНО (`111828b`)

---

### Task 2: злиття не переносить аліаси; зміна bid їх відкидає

**Files:**
- Modify: `src/storage/beers.ts` — `mergeIntoCanonical` (блок `#614` перед `DELETE`), нова
  `dropAliasesOnRelink` одразу перед `recordLookupSuccess`, тіло `recordLookupSuccess`
- Test: `src/storage/beers.test.ts` — блок `#614: пам'ять злиття для назв з крамниць`

**Interfaces:**
- Consumes: таблиця `beer_aliases` (Task 1).
- Produces: `export function dropAliasesOnRelink(db: DB, beerId: number, newBid: number): void` —
  видаляє аліаси `beerId`, лише якщо його поточний `untappd_id` не `NULL` і не дорівнює `newBid`.
  Task 3 викликає її з `pinMatch`.

- [ ] **Step 1: Write the failing tests**

У `src/storage/beers.test.ts` **заміни цілком** тест
`#614 mergeIntoCanonical carries a merged row's own aliases over instead of cascading them away` на:

```ts
test('#614 mergeIntoCanonical lets a merged linked row\'s aliases go instead of moving them to the new bid\'s owner', () => {
  const db = fresh();
  // Злінкований рядок з хибним bid (пошук угадав Spicy Edition) і аліас, записаний під цим bid.
  const wrongId = seedBeer(db, {
    untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5.4, rating_global: 3.61,
    normalized_name: normalizeName('Red Mexican Spicy Edition'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  const ownerId = seedBeer(db, {
    untappd_id: 5120103, name: 'Red Mexican', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5, rating_global: 3.72,
    normalized_name: normalizeName('Red Mexican'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
     VALUES (?, 'Copper Head', 'RED MEXICAN Tomato Gose', ?, ?, '2026-09-02T10:00:00Z')`,
  ).run(wrongId, normalizeBrewery('Copper Head'), normalizeName('RED MEXICAN Tomato Gose'));

  // Репарація #384: крамниця опублікувала bid 5120103 для рядка wrongId, власник уже є → злиття.
  mergeIntoCanonical(db, wrongId, ownerId, '2026-09-14T07:11:40Z');

  // Пара самого рядка доведена прийнятим bid і стає аліасом; «Tomato Gose» доводив 6037305 і зникає.
  expect(aliasesOf(db, ownerId).map((a) => a.name)).toEqual(['Red Mexican Spicy Edition']);
});
```

Одразу після тесту
`#614 mergeIntoCanonical re-points an existing alias of the same pair to the newest merge target`
додай:

```ts
function linkedRowWithAlias(db: ReturnType<typeof fresh>) {
  const rowId = seedBeer(db, {
    untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5.4, rating_global: 3.61,
    normalized_name: normalizeName('Red Mexican Spicy Edition'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });
  db.prepare(
    `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
     VALUES (?, 'Copper Head', 'RED MEXICAN Tomato Gose', ?, ?, '2026-09-02T10:00:00Z')`,
  ).run(rowId, normalizeBrewery('Copper Head'), normalizeName('RED MEXICAN Tomato Gose'));
  return rowId;
}

test('#614 recordLookupSuccess drops a linked row\'s aliases when its bid is rewritten', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);

  recordLookupSuccess(db, rowId, { bid: 5120103, style: 'Gose', abv: 5, global_rating: 3.72 }, '2026-09-14T07:11:40Z');

  expect(getBeer(db, rowId)?.untappd_id).toBe(5120103);
  expect(aliasesOf(db, rowId)).toEqual([]);
});

test('#614 recordLookupSuccess keeps aliases when the same bid is confirmed', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);

  recordLookupSuccess(db, rowId, { bid: 6037305, style: 'Gose', abv: 5.4, global_rating: 3.61 }, '2026-09-14T07:11:40Z');

  expect(aliasesOf(db, rowId).map((a) => a.name)).toEqual(['RED MEXICAN Tomato Gose']);
});

test('#614 recordLookupSuccess leaves aliases alone when the rewrite hits UNIQUE — the merge that follows decides', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);
  seedBeer(db, {
    untappd_id: 5120103, name: 'Red Mexican', brewery: 'Copper Head. Beer Workshop',
    style: 'Gose', abv: 5, rating_global: 3.72,
    normalized_name: normalizeName('Red Mexican'),
    normalized_brewery: normalizeBrewery('Copper Head. Beer Workshop'),
  });

  expect(() => recordLookupSuccess(
    db, rowId, { bid: 5120103, style: 'Gose', abv: 5, global_rating: 3.72 }, '2026-09-14T07:11:40Z',
  )).toThrow(/UNIQUE/);

  // Відкат транзакції: частковий стан (аліаси стерто, bid ні) не лишається.
  expect(aliasesOf(db, rowId).map((a) => a.name)).toEqual(['RED MEXICAN Tomato Gose']);
  expect(getBeer(db, rowId)?.untappd_id).toBe(6037305);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/beers.test.ts -t "#614"`
Expected: FAIL — `lets a merged linked row's aliases go…` (зайвий `RED MEXICAN Tomato Gose`, бо
аліаси ще переносяться) і `drops a linked row's aliases when its bid is rewritten` (аліас лишився).
Два інші нові тести проходять уже зараз; їх доводять мутації 3 і 4.

- [ ] **Step 3: Implement**

У `mergeIntoCanonical` заміни блок

```ts
    // #614: злиття — єдиний момент, коли відомо «пара броварня + назва цієї сироти = канонічний
    // рядок». DELETE нижче знищив би це знання, і /match на кожне завантаження сторінки знову не
    // впізнавав би ту саму картку крамниці. Спершу аліаси самої сироти переходять на канонічний
    // рядок, інакше ON DELETE CASCADE забрав би пам'ять давніших злиттів.
    db.prepare('UPDATE beer_aliases SET beer_id = ? WHERE beer_id = ?').run(canonicalId, orphanId);
```

на

```ts
    // #614: злиття — єдиний момент, коли відомо «пара броварня + назва цієї сироти = канонічний
    // рядок». DELETE нижче знищив би це знання, і /match на кожне завантаження сторінки знову не
    // впізнавав би ту саму картку крамниці. Власні аліаси рядка, що зливається, НЕ переносяться —
    // їх забирає ON DELETE CASCADE. Крон і пошуковий шлях /enrich/result збагачують лише сироти, а
    // сирота аліасів не має; рядок з аліасами доходить сюди лише через репарацію #384, тобто коли
    // його bid виявився хибним — а аліаси доводили саме той bid.
```

Одразу **перед** `export function recordLookupSuccess(` додай:

```ts
// #614: аліас доводить «пара = пиво з цим bid». Коли в рядка змінюється untappd_id, його аліаси
// втрачають доказ і видаляються. Для сироти (untappd_id IS NULL) і для того самого bid умова
// `untappd_id <> ?` не виконується, тож нічого не відбувається.
export function dropAliasesOnRelink(db: DB, beerId: number, newBid: number): void {
  db.prepare(
    `DELETE FROM beer_aliases
      WHERE beer_id = ?
        AND EXISTS (SELECT 1 FROM beers WHERE id = ? AND untappd_id <> ?)`,
  ).run(beerId, beerId, newBid);
}
```

У `recordLookupSuccess` заміни виклик `db.prepare(\`UPDATE beers SET …\`).run(…);` на ту саму
інструкцію, загорнуту в транзакцію разом з видаленням аліасів (текст `UPDATE` і аргументи
`.run(...)` не змінюються):

```ts
  // #614: транзакція — якщо UPDATE впаде на UNIQUE (bid уже має власника), аліаси не стираються
  // наполовину: applyLookupOutcome далі зливає рядок, і їх забирає каскад.
  db.transaction(() => {
    dropAliasesOnRelink(db, beerId, r.bid);
    db.prepare(
      `UPDATE beers SET
         untappd_id = ?,
         untappd_id_source = 'search',
         style = COALESCE(?, style),
         abv = COALESCE(?, abv),
         rating_global = COALESCE(?, rating_global),
         untappd_lookup_at = ?
       WHERE id = ?`,
    ).run(r.bid, r.style, r.abv, r.global_rating, at, beerId);
  })();
  bumpCatalogVersion();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/storage/beers.test.ts src/domain/lookup-outcome.test.ts src/api/routes/enrich.test.ts`
Expected: PASS (зокрема наявні тести UNIQUE-злиття в `lookup-outcome` і `enrich`: помилка з
`code: 'SQLITE_CONSTRAINT_UNIQUE'` пробивається крізь транзакцію без змін).

- [ ] **Step 5: Mutations** (кожну поверни)

1. Поверни рядок `UPDATE beer_aliases SET beer_id = ? WHERE beer_id = ?` у `mergeIntoCanonical`
   → має впасти `lets a merged linked row's aliases go…`.
2. Прибери виклик `dropAliasesOnRelink(db, beerId, r.bid);` → має впасти `drops a linked row's
   aliases when its bid is rewritten`.
3. У `dropAliasesOnRelink` прибери `AND untappd_id <> ?` і третій аргумент `.run` → має впасти
   `keeps aliases when the same bid is confirmed`.
4. Прибери обгортку `db.transaction(() => {` … `})();` (лиши обидві інструкції) → має впасти
   `leaves aliases alone when the rewrite hits UNIQUE`.

- [ ] **Step 6: Full gate** — `npm test` і `npm run typecheck`, обидва зелені.

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "fix(#614): drop aliases when their row's bid changes instead of moving them"
```

---

### Task 3: пін на інший bid відкидає аліаси

**Files:**
- Modify: `src/domain/pin-match.ts` — гілка «новий bid» (перед `UPDATE beers SET untappd_id = ?,
  untappd_id_source = 'curated'…`)
- Test: `src/domain/pin-match.test.ts` — у `describe('pinMatch', …)`

**Interfaces:**
- Consumes: `dropAliasesOnRelink` (Task 2).
- Produces: нічого нового.

- [ ] **Step 1: Write the failing test**

Додай у кінець `describe('pinMatch', …)`:

```ts
  test('#614: pinning a linked row to a different bid drops the aliases proven for the old one', () => {
    const db = newDb();
    const rowId = seedBeer(db, {
      untappd_id: 6037305, name: 'Red Mexican Spicy Edition', brewery: 'Copper Head. Beer Workshop',
      style: 'Gose', abv: 5.4, rating_global: 3.61,
      normalized_name: 'red mexican spicy edition', normalized_brewery: 'copper head beer workshop',
    });
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
       VALUES (?, 'Copper Head', 'RED MEXICAN Tomato Gose', 'copper head', 'red mexican tomato gose', ?)`,
    ).run(rowId, AT);

    const res = pinMatch(db, rowId, 5120103, AT);

    expect(res).toEqual({ kind: 'set', beerId: rowId });
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 0 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/pin-match.test.ts -t "#614"`
Expected: FAIL — `expected { n: 1 } to deeply equal { n: 0 }`.

- [ ] **Step 3: Implement**

У `src/domain/pin-match.ts` додай `dropAliasesOnRelink` до імпорту з `'../storage/beers'` (якщо
такого імпорту немає — новий рядок `import { dropAliasesOnRelink } from '../storage/beers';`).
У гілці «новий bid» одразу **перед**
`db.prepare(\`UPDATE beers SET untappd_id = ?, untappd_id_source = 'curated', untappd_lookup_at = ? WHERE id = ?\`)`
додай:

```ts
    // #614: людина пінить рядок на інший bid — аліаси, записані під старим bid, втрачають доказ.
    dropAliasesOnRelink(db, beerId, untappdId);
```

- [ ] **Step 4: Run tests** — `npx vitest run src/domain/pin-match.test.ts` → PASS.

- [ ] **Step 5: Mutation** — прибери доданий виклик → тест `#614` падає. Поверни.

- [ ] **Step 6: Full gate** — `npm test` і `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/pin-match.ts src/domain/pin-match.test.ts
git commit -m "fix(#614): drop a row's aliases when a pin moves it to another bid"
```

---

### Task 4: аліас перед матчером у `matchBeerList`

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts` (імпорти в рядках 1–3; новий `describe` у кінці)

**Interfaces:**
- Consumes: `normalizeBrewery`, `normalizeName`, `numericTokensCompatible` з `./normalize`.
- Produces (Task 5 і 6 спираються на ці назви):
  - `export interface AliasSource { beer_id: number; name: string; normalized_brewery: string; normalized_name: string }`
  - `export type AliasIndex = ReadonlyMap<string, { beerId: number; name: string }>`
  - `export function buildAliasIndex(rows: readonly AliasSource[]): AliasIndex`
  - `MatchListOptions.aliases?: AliasIndex`

- [ ] **Step 1: Write the failing tests**

У `src/domain/match-list.test.ts` заміни рядок імпорту `match-list` і додай імпорт нормалізації:

```ts
import { matchBeerList, buildAliasIndex, type CatalogBeerWithRating } from './match-list';
import { normalizeBrewery, normalizeName } from './normalize';
```

У кінець файлу:

```ts
describe('matchBeerList aliases (#614)', () => {
  const rochefort: CatalogBeerWithRating[] = [
    { id: 8, brewery: 'Brasserie de Rochefort', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.95, untappd_id: 1001 },
    { id: 10, brewery: 'Brasserie de Rochefort', name: 'Trappistes Rochefort 10', abv: 11.3, rating_global: 4.2, untappd_id: 2002 },
  ];
  const alias = (beerId: number, brewery: string, name: string) => ({
    beer_id: beerId, name, normalized_brewery: normalizeBrewery(brewery), normalized_name: normalizeName(name),
  });
  const noYield = { yield: async () => {} };

  it('a merged shop pair matches its canonical row exactly, with drunk status and rating, without the fallback', async () => {
    const { prepared, byId } = prep(rochefort);
    const aliases = buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')]);
    const res = await matchBeerList(
      prepared, byId, new Set([8]), new Map([[8, 4.0]]),
      [{ brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }],
      { ...noYield, aliases },
    );
    expect(res.results).toEqual([{
      raw: { brewery: 'ROCH', name: 'Trappistes Rochefort 8' },
      matched_beer: { id: 8, name: 'Trappistes Rochefort 8', brewery: 'Brasserie de Rochefort', rating_global: 3.95, untappd_id: 1001 },
      is_drunk: true,
      drunk_uncertain: false,
      user_rating: 4.0,
      source: 'exact',
      searched: true,
    }]);
    expect(res.fallback.attempts).toBe(0);
  });

  it('a card with different digits never rides another vintage\'s alias', async () => {
    // Без цієї передумови тест нічого б не доводив: ключ аліасу рівний для обох вінтажів.
    expect(normalizeName('Trappistes Rochefort 10')).toBe(normalizeName('Trappistes Rochefort 8'));
    const { prepared, byId } = prep(rochefort);
    const aliases = buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')]);
    const [r] = (await matchBeerList(
      prepared, byId, new Set([8]), new Map([[8, 4.0]]),
      [{ brewery: 'ROCH', name: 'Trappistes Rochefort 10', abv: 11.3 }],
      { ...noYield, aliases },
    )).results;
    expect(r.is_drunk).toBe(false);
    expect(r.user_rating).toBeNull();
  });

  it('an alias without digits never claims a numbered card', async () => {
    const { prepared, byId } = prep(rochefort);
    const aliases = buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort')]);
    const [r] = (await matchBeerList(
      prepared, byId, new Set([8]), new Map([[8, 4.0]]),
      [{ brewery: 'ROCH', name: 'Trappistes Rochefort 10', abv: 11.3 }],
      { ...noYield, aliases },
    )).results;
    expect(r.is_drunk).toBe(false);
    expect(r.user_rating).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/domain/match-list.test.ts -t "#614"`
Expected: FAIL на імпорті (`buildAliasIndex` не експортується / `is not a function`).

- [ ] **Step 3: Implement**

У `src/domain/match-list.ts` після імпорту з `./matcher`:

```ts
import { normalizeBrewery, normalizeName, numericTokensCompatible } from './normalize';
```

Після `interface MatchedBeer` додай:

```ts
/** #614: аліас із пам'яті злиття — нормалізована пара картки крамниці → канонічний рядок. */
export interface AliasSource {
  beer_id: number;
  /** Сира назва картки: числові токени, які normalizeName відкидає, порівнюються лише з неї. */
  name: string;
  normalized_brewery: string;
  normalized_name: string;
}

export type AliasIndex = ReadonlyMap<string, { beerId: number; name: string }>;

// Роздільник `|`, а не пробіл: нормалізовані рядки складаються з літер, цифр і пробілів, тож
// пробіл склеїв би «a b» + «c» і «a» + «b c» в один ключ.
const aliasKey = (normalizedBrewery: string, normalizedName: string): string =>
  `${normalizedBrewery}|${normalizedName}`;

export function buildAliasIndex(rows: readonly AliasSource[]): AliasIndex {
  return new Map(rows.map((r) => [
    aliasKey(r.normalized_brewery, r.normalized_name),
    { beerId: r.beer_id, name: r.name },
  ]));
}

// #614: ключ — ті самі normalizeBrewery/normalizeName, якими ensureBeerRow рахував пару сироти з
// того самого сирого тексту картки. Цифри нормалізація відкидає, тож аліас картки «…8» мав би той
// самий ключ, що й картка «…10»; numericTokensCompatible (#617) не пускає таку картку на чужий
// аліас. Рядок, якого немає в цьому знімку каталогу, — не влучання.
function aliasTarget(
  aliases: AliasIndex | undefined,
  item: MatchInput,
  byId: Map<number, CatalogBeerWithRating>,
): CatalogBeerWithRating | null {
  if (!aliases || aliases.size === 0) return null;
  const hit = aliases.get(aliasKey(normalizeBrewery(item.brewery), normalizeName(item.name)));
  if (!hit || !numericTokensCompatible(item.name, hit.name)) return null;
  return byId.get(hit.beerId) ?? null;
}

const toMatchedBeer = (beer: CatalogBeerWithRating): MatchedBeer => ({
  id: beer.id,
  name: beer.name,
  brewery: beer.brewery,
  rating_global: beer.rating_global,
  untappd_id: beer.untappd_id ?? null,
});
```

У `interface MatchListOptions` додай:

```ts
  // #614: пам'ять злиття. Перевіряється до матчера; без неї — поведінка як до #614.
  aliases?: AliasIndex;
```

У циклі `matchBeerList` одразу після `const raw = { brewery: item.brewery, name: item.name };`:

```ts
    const viaAlias = aliasTarget(opts.aliases, item, byId);
    if (viaAlias) {
      out.push({
        raw,
        matched_beer: toMatchedBeer(viaAlias),
        is_drunk: drunkSet.has(viaAlias.id),
        drunk_uncertain: false,
        user_rating: ratingByBeerId.get(viaAlias.id) ?? null,
        source: 'exact',
        searched: true,
      });
      await yield_();
      continue;
    }
```

І в наявній гілці збігу заміни об'єкт `matched_beer: { id: beer.id, … }` на
`matched_beer: toMatchedBeer(beer),`.

- [ ] **Step 4: Run tests** — `npx vitest run src/domain/match-list.test.ts` → PASS.

- [ ] **Step 5: Mutations** (кожну поверни)

1. Прибери блок `if (viaAlias) { … }` → має впасти `a merged shop pair matches…` (матчер дає
   `fuzzy`, без ✅).
2. Прибери `|| !numericTokensCompatible(item.name, hit.name)` → мають упасти обидва тести цифр.

- [ ] **Step 6: Full gate** — `npm test` і `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "feat(#614): check merge aliases before the matcher, digits must agree"
```

---

### Task 5: кеш каталогу будує індекс аліасів; каталог матчера без аліасів

**Files:**
- Modify: `src/storage/beers.ts` — заміни `loadAliasCatalog` на `AliasRow` + `loadAliases`
- Modify: `src/domain/catalog-cache.ts`
- Test: `src/storage/beers.test.ts` (блок `loadAliasCatalog (#614)`), `src/domain/catalog-cache.test.ts`
- Test stubs: `src/api/routes/match.test.ts:68`, `src/api/mcp/match-tool.test.ts:18`

**Interfaces:**
- Consumes: `buildAliasIndex`, `AliasIndex` (Task 4).
- Produces:
  - `export interface AliasRow { beer_id: number; name: string; normalized_brewery: string; normalized_name: string }` (структурно = `AliasSource`)
  - `export function loadAliases(db: DB): AliasRow[]`
  - `CachedCatalog.aliases: AliasIndex` (обов'язкове поле)
  - `CatalogCacheOptions.loadAliases?: () => AliasRow[]`

- [ ] **Step 1: Write the failing tests**

**(a)** У `src/storage/beers.test.ts` заміни рядок `import { loadAliasCatalog } from './beers';` на
`import { loadAliases } from './beers';` і **цілком** заміни `describe('loadAliasCatalog (#614)', …)`:

```ts
describe('loadAliases (#614)', () => {
  function canonicalWithAlias(db: ReturnType<typeof fresh>, untappdId: number | null) {
    const canonicalId = seedBeer(db, {
      untappd_id: untappdId, name: 'Black Bean', brewery: 'Varvar Brew',
      style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, created_at)
       VALUES (?, 'VARVAR', 'BLACK BEAN IS', ?, ?, '2026-09-14T07:13:20Z')`,
    ).run(canonicalId, normalizeBrewery('VARVAR'), normalizeName('BLACK BEAN IS'));
    return canonicalId;
  }

  test('returns each alias of a linked row with its raw name and normalized pair', () => {
    const db = fresh();
    const canonicalId = canonicalWithAlias(db, 3548624);
    expect(loadAliases(db)).toEqual([{
      beer_id: canonicalId, name: 'BLACK BEAN IS',
      normalized_brewery: normalizeBrewery('VARVAR'), normalized_name: normalizeName('BLACK BEAN IS'),
    }]);
  });

  test('skips an alias whose canonical row has no untappd_id', () => {
    const db = fresh();
    canonicalWithAlias(db, null);
    expect(loadAliases(db)).toEqual([]);
  });

  test('skips an alias whose pair a beers row now holds — the row wins', () => {
    const db = fresh();
    canonicalWithAlias(db, 3548624);
    // Пізніша сирота з тією самою парою (кран; сирота, яку репарація #384 зробила рядком нового bid).
    seedBeer(db, {
      name: 'BLACK BEAN IS', brewery: 'VARVAR', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('BLACK BEAN IS'), normalized_brewery: normalizeBrewery('VARVAR'),
    });
    expect(loadAliases(db)).toEqual([]);
  });
});
```

**(b)** У `src/domain/catalog-cache.test.ts` **цілком** заміни тест
`#614 matches aliases but keeps byId to the real rows, so the answer shows the canonical name` на:

```ts
  it('#614 builds the alias index from loadAliases and keeps aliases out of the matcher catalog', async () => {
    const aliasRows = [
      { beer_id: 1, name: 'Atak Chmielu IPA', normalized_brewery: 'pinta', normalized_name: 'atak chmielu ipa' },
    ];
    const cache = make({ getVersion: () => 0, load: () => rows, loadAliases: () => aliasRows });
    const { prepared, byId, aliases } = await cache.get();
    expect(prepared.beers.map((b) => `${b.id} ${b.name}`)).toEqual(['1 Atak Chmielu', '2 Buty Skejta']);
    expect(byId.size).toBe(2);
    expect([...aliases.values()]).toEqual([{ beerId: 1, name: 'Atak Chmielu IPA' }]);
  });
```

У тому самому файлі в інтеграційному тесті `after a merge the same shop card matches the canonical
row exactly, with the drinker's status` заміни все від рядка `// Контроль на тій самій БД без
аліасів…` до кінця тесту на:

```ts
    const { prepared, byId, aliases } = await createCatalogCache(db).get();

    // Контроль: без аліасів картка НЕ дає точного збігу — інакше тест нічого б не доводив
    // (прод-реплей 2026-09-14: null).
    const { results: [control] } = await matchBeerList(prepared, byId, drunk, ratings, [card], noYield);
    expect(control.source).not.toBe('exact');
    expect(control.is_drunk).toBe(false);

    const { results: [r] } = await matchBeerList(prepared, byId, drunk, ratings, [card], { ...noYield, aliases });
    expect(r.matched_beer).toEqual({
      id: canonicalId, name: 'Black Bean', brewery: 'Varvar Brew', rating_global: 4.14, untappd_id: 3548624,
    });
    expect(r.source).toBe('exact');
    expect(r.is_drunk).toBe(true);
    expect(r.user_rating).toBe(4.5);
  });
```

**(c)** Заглушки кешу отримують обов'язкове поле:
- `src/api/routes/match.test.ts:68` —
  `get: async () => ({ prepared: prepareCatalog([ghost]), byId: new Map([[777, ghost]]), aliases: new Map() }),`
- `src/api/mcp/match-tool.test.ts:18` —
  `get: async () => ({ prepared: prepareCatalog(rows), byId: new Map(rows.map((r) => [r.id, r])), aliases: new Map() }),`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/beers.test.ts src/domain/catalog-cache.test.ts`
Expected: FAIL — `loadAliases is not a function`; `aliases` undefined у кеші; інтеграційний тест
(у `prepared` ще є аліаси, тож контроль дає `exact`).

- [ ] **Step 3: Implement**

**(a)** `src/storage/beers.ts` — заміни функцію `loadAliasCatalog` разом з її коментарем на:

```ts
// #614: аліаси пам'яті злиття для перевірки перед матчером (matchBeerList). Не читаються:
// - аліас рядка без untappd_id — та сама жива перевірка, що й isRememberedMerge (#366);
// - аліас, чию нормалізовану пару тепер тримає рядок beers (пізніша сирота кранів, сирота, яку
//   репарація #384 зробила рядком нового bid) — рядок важить більше, картку відповідає матчер.
export interface AliasRow {
  beer_id: number;
  name: string;
  normalized_brewery: string;
  normalized_name: string;
}

export function loadAliases(db: DB): AliasRow[] {
  return db
    .prepare(
      `SELECT a.beer_id, a.name, a.normalized_brewery, a.normalized_name
         FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
        WHERE b.untappd_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM beers x
             WHERE x.normalized_brewery = a.normalized_brewery
               AND x.normalized_name = a.normalized_name
               AND x.id <> a.beer_id)
        ORDER BY a.id`,
    )
    .all() as AliasRow[];
}
```

**(b)** `src/domain/catalog-cache.ts`:
- імпорт з `'../storage/beers'`: `import { loadAliases, loadCatalog, type AliasRow } from '../storage/beers';`
- імпорт з `'./match-list'`: `import { buildAliasIndex, yieldToEventLoop, type AliasIndex, type CatalogBeerWithRating } from './match-list';`
- `interface CachedCatalog` — додай поле:

  ```ts
    // #614: пам'ять злиття; matchBeerList перевіряє її до матчера.
    aliases: AliasIndex;
  ```
- у `CatalogCacheOptions` рядок `loadAliases?: …` заміни на
  `loadAliases?: () => AliasRow[];                                  // default: loadAliases(db) (#614)`
- у `createCatalogCache` рядок `const loadAliases = opts.loadAliases ?? (() => loadAliasCatalog(db));`
  заміни на `const loadAliasRows = opts.loadAliases ?? (() => loadAliases(db));`
- у `rebuild` заміни блок від `const rows = load();` до `const value: CachedCatalog = { prepared, byId };` на:

  ```ts
      const rows = load();
      const prepared = await prepare(rows);
      const byId = new Map(rows.map((r) => [r.id, r]));
      // #614: аліаси — окремий індекс, а не записи каталогу матчера: matchBeerList перевіряє їх до
      // матчера з правилом цифр, тож матчер не бачить дублікатів id і не звужує пул броварні.
      const aliases = buildAliasIndex(loadAliasRows());
      const value: CachedCatalog = { prepared, byId, aliases };
  ```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/storage/beers.test.ts src/domain/catalog-cache.test.ts src/api/routes/match.test.ts src/api/mcp/match-tool.test.ts src/api/routes/mcp.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutations** (кожну поверни)

1. Прибери `WHERE b.untappd_id IS NOT NULL` (лиши `AND NOT EXISTS` як `WHERE NOT EXISTS`) → має
   впасти `skips an alias whose canonical row has no untappd_id`.
2. Прибери блок `AND NOT EXISTS (…)` → має впасти `skips an alias whose pair a beers row now holds`.
3. `buildAliasIndex(loadAliasRows())` → `buildAliasIndex([])` → мають упасти `#614 builds the alias
   index…` та інтеграційний тест.

- [ ] **Step 6: Full gate** — `npm test` і `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/catalog-cache.ts src/domain/catalog-cache.test.ts src/api/routes/match.test.ts src/api/mcp/match-tool.test.ts
git commit -m "fix(#614): keep merge aliases out of the matcher catalog, a beers row outranks an alias"
```

---

### Task 6: `/match` і MCP передають аліаси

**Files:**
- Modify: `src/api/routes/match.ts` (рядки ~46, ~53), `src/api/mcp/match-tool.ts` (рядки ~79, ~82)
- Test: `src/api/routes/match.test.ts`, `src/api/routes/mcp.test.ts`

**Interfaces:**
- Consumes: `CachedCatalog.aliases` (Task 5), `MatchListOptions.aliases` (Task 4).
- Produces: нічого нового.

- [ ] **Step 1: Write the failing tests**

**(a)** `src/api/routes/match.test.ts`:
- додай імпорт `import { mergeIntoCanonical } from '../../storage/beers';`
- у `setup` заміни `return { appAs, appAnon, panIpani, warn };` на
  `return { appAs, appAnon, panIpani, warn, db };`
- після тесту `isolates users — user 2 has not drunk the beer` додай:

```ts
  it('#614 answers a merged shop card exactly, with the caller\'s drunk status and rating', async () => {
    const { appAs, panIpani, db } = setup();
    const orphanId = seedBeer(db, {
      name: 'PAN IPANI Tropical Edition', brewery: 'Browar Trzech Kumpli',
      style: 'IPA', abv: 6.0, rating_global: null,
      normalized_name: normalizeName('PAN IPANI Tropical Edition'),
      normalized_brewery: normalizeBrewery('Browar Trzech Kumpli'),
    });
    mergeIntoCanonical(db, orphanId, panIpani, '2026-09-14T07:13:20Z');
    // Передумова: злиття справді записало аліас — інакше тест нічого не доводить.
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 1 });

    const res = await post(appAs(1), {
      beers: [{ brewery: 'Browar Trzech Kumpli', name: 'PAN IPANI Tropical Edition' }],
    });
    const body = await res.json();
    expect(body.results[0]).toMatchObject({
      matched_beer: { id: panIpani, name: 'Pan IPAni', rating_global: 3.85 },
      source: 'exact',
      is_drunk: true,
      user_rating: 4.0,
    });
  });
```

**(b)** `src/api/routes/mcp.test.ts`:
- додай імпорт `import { mergeIntoCanonical } from '../../storage/beers';`
- після тесту `calls match_beers and returns structured results` додай:

```ts
  it('#614 match_beers answers a merged shop card exactly', async () => {
    const { app, db, panIpani } = setup();
    const orphanId = seedBeer(db, {
      name: 'PAN IPANI Tropical Edition', brewery: 'Browar Trzech Kumpli',
      style: 'IPA', abv: 6.0, rating_global: null,
      normalized_name: normalizeName('PAN IPANI Tropical Edition'),
      normalized_brewery: normalizeBrewery('Browar Trzech Kumpli'),
    });
    mergeIntoCanonical(db, orphanId, panIpani, '2026-09-14T07:13:20Z');
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 1 });

    await rpc(app, INIT);
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'match_beers', arguments: { beers: [
        { brewery: 'Browar Trzech Kumpli', name: 'PAN IPANI Tropical Edition' },
      ] } },
    });
    const body = await res.json() as {
      result: { structuredContent: { results: { status: string; confidence: string }[] } };
    };
    expect(body.result.structuredContent.results[0]).toMatchObject({ status: 'drunk', confidence: 'exact' });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/api/routes/match.test.ts src/api/routes/mcp.test.ts -t "#614"`
Expected: FAIL в обох — без передачі `aliases` матчер не дає `exact` зі статусом «пив». Якщо
передумова `{ n: 1 }` падає (нормалізація зробила пару рівною канонічній), заміни назву картки на
іншу, чия нормалізована пара відрізняється від `Trzech Kumpli / Pan IPAni`, і назви заміну у звіті.

- [ ] **Step 3: Implement**

`src/api/routes/match.ts`:

```ts
    const { prepared, byId, aliases } = await cache.get();
```

```ts
    const { results, fallback } = await matchBeerList(prepared, byId, drunkSet, ratings, beers, { aliases });
```

`src/api/mcp/match-tool.ts`:

```ts
  const { prepared, byId, aliases } = await catalog.get();
```

```ts
  const { results, fallback } = await matchBeerList(prepared, byId, drunkSet, ratings, beers, { aliases });
```

- [ ] **Step 4: Run tests** — `npx vitest run src/api/routes/match.test.ts src/api/routes/mcp.test.ts src/api/mcp/match-tool.test.ts` → PASS.

- [ ] **Step 5: Mutations** (кожну поверни)

1. У `match.ts` прибери `, { aliases }` → має впасти тест `#614` у `match.test.ts`.
2. У `match-tool.ts` прибери `, { aliases }` → має впасти тест `#614` у `mcp.test.ts`.

- [ ] **Step 6: Full gate** — `npm test` і `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/match.ts src/api/mcp/match-tool.ts src/api/routes/match.test.ts src/api/routes/mcp.test.ts
git commit -m "feat(#614): pass merge aliases to /match and the MCP match tool"
```

---

## Після ядра

1. **Повторне наскрізне рев'ю ядра**, окремий диспатч. Назвати всі інлайнові задачі 2–6 і коміти.
   Попросити перевірити, що закриті знахідки першого рев'ю:
   - числові близнюки (реплей `ROCH / Trappistes Rochefort 10` після злиття «…8» — не `exact`);
   - аліаси після зміни bid (злиття злінкованого рядка, `recordLookupSuccess`, `pinMatch`);
   - «мертвий» аліас поруч зі свіжим рядком тієї самої пари;
   - матчер більше не бачить аліасів.
2. **Лише після рев'ю** — план периферії.

## Самоперевірка плану проти спеки

| Розділ спеки | Де в плані |
|---|---|
| Дані: таблиця, унікальна пара, каскад, без бекфілу | Task 1 (зроблено) |
| Запис: пара сироти → аліас; правило близнюків; `ON CONFLICT` | коміт `9325d68` (тести лишаються) |
| Запис: аліаси рядка, що зливається, не переносяться | Task 2, тест 1 |
| Зміна `untappd_id` відкидає аліаси: `recordLookupSuccess` | Task 2, тести 2–4 |
| Зміна `untappd_id` відкидає аліаси: `pinMatch` | Task 3 |
| Читання: жива перевірка лінку; рядок важить більше за аліас | Task 5 (a) |
| Індекс у кеші; каталог матчера без аліасів | Task 5 (b) |
| Аліас перед матчером; правило цифр; бюджет фолбеку не чіпається | Task 4 |
| `/match` і MCP передають аліаси | Task 6 |
| `ensureBeerRow`, `/enrich/*`, репарація #384, API-тест петлі, `spec.md` | **периферія** |
