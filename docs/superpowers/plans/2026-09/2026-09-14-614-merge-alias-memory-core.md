# Пам'ять злиття для карток крамниць — план ядра (#614), раунд 5: ключ = текст + ABV картки

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ключ аліасу пам'яті злиття — **уся картка**, яку надсилає розширення: `cardText(brewery)`,
`cardText(name)` і `cardAbv(abv)`. ABV картки доходить до злиття на всіх трьох шляхах (`/enrich/result`
bid і пошук, крон). Плюс закриття решти знахідок четвертого рев'ю: тест підключення правила «рядок
важить більше» на рівні кешу, поступки циклу подій у `buildAliasIndex`, `IS NOT` у
`dropAliasesOnRelink`, застарілі формулювання.

**Architecture:** **ядро** стадійної зміни. Четверте рев'ю показало, що текст картки без ABV — не вся
ідентичність: Flasker обрізає назву на маркері ABV, тож 0%- і алкогольна версія дають однаковий текст,
і аліас 0% віддавав ✅ алкогольній картці (реплей на прод-каталозі: Leffe, Guinness, Super Bock —
спека, «Рев'ю ядра»). Межа, узгоджена з користувачем: аліас точний настільки, наскільки точна картка;
втрати адаптера — #637. Міграція v32 ще ніде не застосована (прод — версія 31), тож змінюється на місці.

**Периферія йде окремим планом після п'ятого наскрізного рев'ю:** аліас в `ensureBeerRow`; репарація
#384 через аліас; наскрізний API-тест; `spec.md`.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською**, як у решті репо.
- **Повний гейт після КОЖНОЇ задачі** (`npm test` і `npm run typecheck`), ніколи не звужений.
- **Кожен тест мутаційно доведений.** Фільтр `-t` перевіряй за рядком `Tests N failed | M skipped`:
  фільтр, що не збігся з назвою, мовчки не запускає нічого.
- **Сіди з видимими значеннями**, не `null`.
- **Ключ аліасу ніколи не проходить через `normalizeName`/`normalizeBrewery`/`numericNameTokens`.**
- **Ніяких `as unknown as` кастів.**
- **Поза ядром:** `ensureBeerRow` (його аліасна гілка), решта `/enrich/*`, `refresh-ontap`,
  `ensureOrphan`, матчер, `spec.md`.
- **Код важить більше за цей план.** Розбіжність сигнатури чи назви — іди за кодом і назви її.
- **Розмір задач (CLAUDE.md):** Task 14 зачіпає вісім файлів коду — **диспатч імплементера**, лише в
  worktree `/home/ysi/warsaw-beer-bot/.claude/worktrees/614-merge-alias-memory`, коміт лише там
  (пам'ять `feedback_subagent_worktree_commit_guard`). Task 15 — дрібна, **інлайн**. Усі задачі 2–15
  називаються в диспатчі п'ятого наскрізного рев'ю.
- **Інструменти запису перетворюють `\uXXXX` на символи** — у цьому раунді escape-послідовності не
  потрібні; перевіряти змінені файли на NUL-байти.

---

### Задачі 1–13 — ✅ ЗРОБЛЕНО (перелік у спеці, «Рев'ю ядра»)

Останні коміти раунду 4: `b5ba3a5` (`cardText`), `d197412` (ключ = точний текст), `5600826` (без
`nameDigits`, тести порожньої назви). Лишаються без змін: `pinMatch` (`cc798e4`), `/match` і MCP
передають `aliases` (`0285628`), `applyLookupOutcome` передає `input` (`9fa0ed8`).

---

### Task 14: ABV картки в ключі аліасу; кеш передає каталог під тестом; поступки циклу (ДИСПАТЧ)

**Files:**
- Modify: `src/domain/card-text.ts` — нова `cardAbv`
- Modify: `src/storage/schema.ts` — SQL v32
- Modify: `src/storage/beers.ts` — `mergeIntoCanonical`, `AliasRow`, `loadAliases`
- Modify: `src/domain/match-list.ts` — `AliasSource`, ключі, `buildAliasIndex` (async), `aliasTarget`
- Modify: `src/domain/catalog-cache.ts` — `await buildAliasIndex(...)`
- Modify: `src/domain/lookup-outcome.ts` — тип `input` отримує `abv`
- Modify: `src/api/routes/enrich.ts` — два виклики `applyLookupOutcome` передають `abv`
- Modify: `src/jobs/untappd-enrich.ts` — виклик `applyLookupOutcome` передає `abv` сироти
- Test: `card-text.test.ts`, `schema.test.ts`, `beers.test.ts`, `pin-match.test.ts`, `match-list.test.ts`,
  `catalog-cache.test.ts`, `lookup-outcome.test.ts`, `src/api/routes/enrich.test.ts`, `src/jobs/untappd-enrich.test.ts`

**Interfaces (Produces):**
- `export function cardAbv(abv: number | null | undefined): string` — `''` для `null`/`undefined`/не скінченного; інакше `String(Math.round(abv * 100) / 100)`.
- `beer_aliases`: колонки `id, beer_id, brewery, name, brewery_text, name_text, abv_key, created_at`; `UNIQUE (brewery_text, name_text, abv_key)`.
- `mergeIntoCanonical(db, orphanId, canonicalId, at, aliasSource?: { brewery: string; name: string; abv?: number | null })`.
- `applyLookupOutcome(..., input: { brewery: string; name: string; abv?: number | null; sourceUrl?: string })`.
- `AliasRow = { beer_id: number; brewery_text: string; name_text: string; abv_key: string }`.
- `AliasSource` (у `match-list.ts`) — ті самі чотири поля.
- `export async function buildAliasIndex(aliases: readonly AliasSource[], catalog: readonly { id: number; brewery: string; name: string }[], yield_?: () => Promise<void>): Promise<AliasIndex>`; `AliasIndex = ReadonlyMap<string, number>`.

- [ ] **Step 1: Write the failing tests**

**(a) `card-text.test.ts`** — імпорт `import { cardAbv, cardText } from './card-text';`; у кінець:

```ts
describe('cardAbv (#614)', () => {
  test('keeps the card ABV to hundredths; 0 is a real ABV', () => {
    expect(cardAbv(6.6)).toBe('6.6');
    expect(cardAbv(0)).toBe('0');
    expect(cardAbv(4.25)).toBe('4.25');
    expect(cardAbv(6.6000000001)).toBe('6.6');
  });

  test('a card without an ABV has its own empty key', () => {
    expect(cardAbv(null)).toBe('');
    expect(cardAbv(undefined)).toBe('');
    expect(cardAbv(Number.NaN)).toBe('');
  });
});
```

**(b) `schema.test.ts`, `describe('v32 beer_aliases (#614)')`:**
- очікувані колонки: `['id', 'beer_id', 'brewery', 'name', 'brewery_text', 'name_text', 'abv_key', 'created_at']`;
- перший тест: `insert` з колонкою `abv_key`; вставити `(8, 'LEFFE', 'BLONDE', 'leffe', 'blonde', '6.6')`, потім `(10, 'LEFFE', 'BLONDE', 'leffe', 'blonde', '0')` (той самий текст, інший ABV — дозволено), потім знову `'leffe', 'blonde', '6.6'` → `toThrow(/UNIQUE constraint failed/)`; рядки `beers` 8 і 10 — з назвами Leffe Blonde і Leffe Blonde 0,0%;
- другий тест (каскад): вставка з `abv_key` `''`.

**(c) `beers.test.ts`:**
1. Імпорт: `import { cardAbv, cardText } from '../domain/card-text';` (замість імпорту лише `cardText`).
2. `type AliasRow` і SELECT в `aliasesOf` отримують `abv_key` після `name_text`.
3. **Кожен** сирий `INSERT INTO beer_aliases` у файлі — колонка `abv_key` зі значенням `''` (ці аліаси без ABV).
4. `remembers the orphan's shop pair as an alias…` — сирота сіється з `abv: 11`; очікування доповнити `abv_key: '11'`.
5. `writes the alias from the searched text…` — очікування через `map((a) => [a.brewery, a.name, a.brewery_text, a.name_text, a.abv_key])` → `[['Ґвара', 'Ґвара #7', 'ґвара', 'ґвара #7', '']]` (у `aliasSource` ABV немає).
6. Після тесту `twin cards of one shop keep one alias each` додати:

```ts
test('#614 ABV twins of one shop text keep one alias each: the 0% card never shares a key with the alcoholic one', () => {
  const db = fresh();
  const zeroId = seedBeer(db, {
    untappd_id: 2948556, name: 'Leffe Blonde / Blond 0,0%', brewery: 'Abbaye de Leffe',
    style: 'Non-Alcoholic Beer', abv: 0, rating_global: 3.2,
    normalized_name: normalizeName('Leffe Blonde / Blond 0,0%'), normalized_brewery: normalizeBrewery('Abbaye de Leffe'),
  });
  const alcId = seedBeer(db, {
    untappd_id: 5940, name: 'Leffe Blonde / Blond', brewery: 'Abbaye de Leffe',
    style: 'Belgian Blonde', abv: 6.6, rating_global: 3.5,
    normalized_name: normalizeName('Leffe Blonde / Blond'), normalized_brewery: normalizeBrewery('Abbaye de Leffe'),
  });
  // Flasker обрізає назву на маркері ABV: обидва товари приходять як LEFFE / BLONDE.
  const card0 = seedBeer(db, {
    name: 'BLONDE', brewery: 'LEFFE', style: null, abv: 0, rating_global: null,
    normalized_name: normalizeName('BLONDE'), normalized_brewery: normalizeBrewery('LEFFE'),
  });
  mergeIntoCanonical(db, card0, zeroId, '2026-09-14T10:00:00Z', { brewery: 'LEFFE', name: 'BLONDE', abv: 0 });
  const card66 = seedBeer(db, {
    name: 'BLONDE', brewery: 'LEFFE', style: null, abv: 6.6, rating_global: null,
    normalized_name: normalizeName('BLONDE'), normalized_brewery: normalizeBrewery('LEFFE'),
  });
  mergeIntoCanonical(db, card66, alcId, '2026-09-14T10:01:00Z', { brewery: 'LEFFE', name: 'BLONDE', abv: 6.6 });

  const rows = db.prepare('SELECT beer_id, abv_key FROM beer_aliases ORDER BY abv_key').all();
  expect(rows).toEqual([{ beer_id: zeroId, abv_key: '0' }, { beer_id: alcId, abv_key: '6.6' }]);
});
```

7. `describe('loadAliases (#614)')`, перший тест — очікування доповнити `abv_key: ''`.

**(d) `pin-match.test.ts`** — сирий `INSERT` тесту `#614`: колонка `abv_key`, значення `''`.

**(e) `match-list.test.ts`, блок `matchBeerList aliases (#614)`:**
- імпорт: `import { cardAbv, cardText } from './card-text';`;
- хелпер: `const alias = (beerId: number, brewery: string, name: string, abv?: number | null) => ({ beer_id: beerId, brewery_text: cardText(brewery), name_text: cardText(name), abv_key: cardAbv(abv) });`
- хелпер `run`: `const aliases = await buildAliasIndex(aliasRows, catalog);`
- у тесті `a merged card text matches…` аліас `alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)` (картка має `abv: 9.2`);
- тест `buildAliasIndex drops an alias…`: обидва виклики `await buildAliasIndex(...)`, тест `async`;
- у кінець блоку:

```ts
  it('an ABV twin never rides the alias of the other ABV', async () => {
    const leffe: CatalogBeerWithRating[] = [
      { id: 5940, brewery: 'Abbaye de Leffe', name: 'Leffe Blonde / Blond', abv: 6.6, rating_global: 3.5, untappd_id: 5940 },
      { id: 3658, brewery: 'Abbaye de Leffe', name: 'Leffe Blonde / Blond 0,0%', abv: 0, rating_global: 3.2, untappd_id: 2948556 },
    ];
    const [r] = (await run(leffe, [alias(3658, 'LEFFE', 'BLONDE', 0)], { brewery: 'LEFFE', name: 'BLONDE', abv: 6.6 }, 3658)).results;
    expect(r.is_drunk).toBe(false);
    expect(r.source === 'exact' && r.matched_beer?.id === 3658).toBe(false);
  });

  it('a card without an ABV never rides an alias recorded with one', async () => {
    const [r] = (await run(rochefort, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8' }, 8)).results;
    expect(r.source === 'exact' && r.matched_beer?.id === 8 && r.is_drunk).toBe(false);
  });

  it('buildAliasIndex yields to the event loop once per 2000 catalog rows', async () => {
    const big = Array.from({ length: 2001 }, (_, i) => ({ id: i + 1, brewery: `Brew ${i}`, name: `Beer ${i}` }));
    const yieldSpy = vi.fn(() => Promise.resolve());
    await buildAliasIndex([], big, yieldSpy);
    expect(yieldSpy.mock.calls.length).toBe(2);
  });
```

**(f) `catalog-cache.test.ts`:**
- юніт `#614 builds the alias index…`: `aliasRows = [{ beer_id: 1, brewery_text: 'pinta', name_text: 'atak chmielu ipa', abv_key: '' }]`;
- після нього:

```ts
  it('#614 hands the catalog to buildAliasIndex: a row with the same exact text switches the alias off', async () => {
    const withSameText: CatalogBeerWithRating[] = [
      ...rows,
      { id: 3, brewery: 'PINTA', name: 'Atak Chmielu IPA', abv: 6.1, rating_global: null, untappd_id: null },
    ];
    const aliasRows = [{ beer_id: 1, brewery_text: 'pinta', name_text: 'atak chmielu ipa', abv_key: '' }];
    const cache = make({ getVersion: () => 0, load: () => withSameText, loadAliases: () => aliasRows });
    const { aliases } = await cache.get();
    expect(aliases.size).toBe(0);
  });
```

**(g) `lookup-outcome.test.ts`** — у тесті `#614 records the alias from the text the caller searched…`
вхід `{ brewery: 'Ґвара', name: 'Ґвара #7', abv: 7 }`; SELECT `beer_id, name, name_text, abv_key`;
очікування `[{ beer_id: g7, name: 'Ґвара #7', name_text: 'ґвара #7', abv_key: '7' }]`.

**(h) `enrich.test.ts`:**
- `reports matched with the canonical bid when the relay result merges a duplicate`: у тіло запиту додати
  `abv: 5.7`; наприкінці тесту
  `expect(db.prepare('SELECT brewery_text, name_text, abv_key FROM beer_aliases').all()).toEqual([{ brewery_text: 'pinta barrel brewing', name_text: 'after hours: rose wild ale', abv_key: '5.7' }]);`
- `overrides a machine-derived link and merges into the canonical row` (тіло вже має `abv: 3.8`): наприкінці
  `expect(db.prepare('SELECT beer_id, name_text, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: canonical, name_text: 'tomatol bulgogi', abv_key: '3.8' }]);`

**(i) `untappd-enrich.test.ts`** — у тесті `duplicate untappd_id: merges orphan into canonical, returns merged`
сирота сіється з `abv: 5.1`; наприкінці
`expect(db.prepare('SELECT beer_id, name_text, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: canonicalId, name_text: 'marine', abv_key: '5.1' }]);`

- [ ] **Step 2:** запусти дев'ять тестових файлів → FAIL (немає `cardAbv`, колонки `abv_key`; `buildAliasIndex` синхронна; ABV не доходить до злиття). Запиши назви тестів, що впали.

- [ ] **Step 3: Implement**

**(a) `card-text.ts`** — після `cardText`:

```ts
// #614: ABV картки — друга половина її ідентичності: крамниця може надрукувати однаковий текст для 0%- і
// алкогольної версії (Flasker обрізає назву на маркері ABV). До сотих, щоб похибка float не давала
// різних ключів; відсутній ABV — окреме порожнє значення (NULL у UNIQUE SQLite не рівний сам собі).
// 0 — справжній ABV (#322), не «відсутній».
export function cardAbv(abv: number | null | undefined): string {
  return abv == null || !Number.isFinite(abv) ? '' : String(Math.round(abv * 100) / 100);
}
```

**(b) `schema.ts`, v32** — у SQL після `name_text    TEXT NOT NULL,` додати `abv_key      TEXT NOT NULL,`;
`UNIQUE (brewery_text, name_text)` → `UNIQUE (brewery_text, name_text, abv_key)`. У коментар міграції
додати речення: «abv_key — cardAbv картки: крамниця друкує однаковий текст для 0%- і алкогольної версії».

**(c) `beers.ts`:**
- імпорт: `import { cardAbv, cardText } from '../domain/card-text';`
- тип `aliasSource?: { brewery: string; name: string; abv?: number | null }`;
- SELECT сироти: `'SELECT brewery, name, abv FROM beers WHERE id = ?'`, тип `{ brewery: string; name: string; abv: number | null }`;
- після `const nameText = cardText(source.name);` — `const abvKey = cardAbv(source.abv);`;
- `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, abv_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(brewery_text, name_text, abv_key) DO UPDATE SET …` (той самий `SET`), `.run(canonicalId, source.brewery, source.name, breweryText, nameText, abvKey, at)`;
- `AliasRow` отримує `abv_key: string`; SELECT `loadAliases`: `a.beer_id, a.brewery_text, a.name_text, a.abv_key`.

**(d) `match-list.ts`:**
- імпорт: `import { cardAbv, cardText } from './card-text';`
- `AliasSource` отримує `abv_key: string`;
- ключі:

```ts
// Роздільник `|`: cardText зберігає пробіли, тож пробіл склеїв би «a b» + «c» і «a» + «b c».
const textKey = (breweryText: string, nameText: string): string => `${breweryText}|${nameText}`;
const aliasKey = (breweryText: string, nameText: string, abvKey: string): string =>
  `${textKey(breweryText, nameText)}|${abvKey}`;

const ALIAS_CATALOG_CHUNK = 2000;
```

- `buildAliasIndex`:

```ts
// #614: рядок каталогу з тим самим точним текстом важить більше за аліас (пізніша сирота кранів;
// сирота, яку репарація #384 зробила рядком нового bid) — картку тоді відповідає матчер з його вибором
// за ABV. ABV тут не порівнюється: зайве вимкнення дає лише промах, не хибний ✅. Той самий текст у
// самій цілі аліас не вимикає. cardText на ~33.6k рядках одним шматком блокував цикл подій на
// 74–113 мс (рев'ю 4), тож поступаємося циклу кожні 2000 рядків, як prepareCatalogChunked.
export async function buildAliasIndex(
  aliases: readonly AliasSource[],
  catalog: readonly { id: number; brewery: string; name: string }[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<AliasIndex> {
  const holders = new Map<string, Set<number>>();
  for (let i = 0; i < catalog.length; i += ALIAS_CATALOG_CHUNK) {
    const end = Math.min(i + ALIAS_CATALOG_CHUNK, catalog.length);
    for (let j = i; j < end; j++) {
      const row = catalog[j];
      const key = textKey(cardText(row.brewery), cardText(row.name));
      (holders.get(key) ?? holders.set(key, new Set()).get(key)!).add(row.id);
    }
    await yield_();
  }
  const index = new Map<string, number>();
  for (const a of aliases) {
    const held = holders.get(textKey(a.brewery_text, a.name_text));
    if (held && [...held].some((id) => id !== a.beer_id)) continue;
    index.set(aliasKey(a.brewery_text, a.name_text, a.abv_key), a.beer_id);
  }
  return index;
}
```

- `aliasTarget`: `const beerId = aliases.get(aliasKey(breweryText, nameText, cardAbv(item.abv)));` і коментар
  доповнити: «ABV картки — частина ключа: 0%-аліас не дістається алкогольній картці з тим самим текстом».
- `yieldToEventLoop` визначено нижче в тому самому модулі; дефолтний параметр обчислюється під час виклику, тож порядок оголошення не заважає.

**(e) `catalog-cache.ts`** — `const aliases = await buildAliasIndex(loadAliasRows(), rows);`

**(f) `lookup-outcome.ts`** — тип входу: `input: { brewery: string; name: string; abv?: number | null; sourceUrl?: string }`.

**(g) `enrich.ts`** — обидва виклики `applyLookupOutcome` передають `abv`:
`{ brewery, name, abv, sourceUrl: pageUrl }` (шлях bid, рядок ~252 і пошуковий, рядок ~297).

**(h) `untappd-enrich.ts`** — `{ brewery: beer.brewery, name: beer.name, abv: beer.abv }`.

- [ ] **Step 4:** дев'ять тестових файлів + `match.test.ts`, `mcp.test.ts`, `match-tool.test.ts` → PASS.

- [ ] **Step 5: Mutations** (кожну поверни, звіти вивід):
1. `cardAbv`: `abv == null || …` → `!Number.isFinite(abv ?? 0)` з `String(Math.round((abv ?? 0) * 100) / 100)` → падає `a card without an ABV has its own empty key`.
2. `UNIQUE (brewery_text, name_text, abv_key)` → без `abv_key` → падає перший тест v32.
3. `const abvKey = cardAbv(source.abv);` → `''` → падає `ABV twins of one shop text…`.
4. `aliasTarget`: `cardAbv(item.abv)` → `''` → падають `a merged card text matches…` і `a card without an ABV never rides…`? (перший має впасти; назви, які впали).
5. `enrich.ts` пошуковий виклик без `abv` → падає `reports matched with the canonical bid when the relay result merges a duplicate`.
6. `enrich.ts` виклик шляху bid без `abv` → падає `overrides a machine-derived link…`.
7. `untappd-enrich.ts` без `abv` → падає `duplicate untappd_id: merges orphan into canonical…`.
8. `catalog-cache.ts`: `buildAliasIndex(loadAliasRows(), rows)` → `buildAliasIndex(loadAliasRows(), [])` → падає `#614 hands the catalog to buildAliasIndex…`.
9. `buildAliasIndex`: прибрати `await yield_();` → падає `buildAliasIndex yields to the event loop…`.

- [ ] **Step 6: Full gate.** Перевір усі змінені файли на NUL-байти.
- [ ] **Step 7: Commit** — прості команди `git -C <worktree> add …` і
  `git -C <worktree> commit -m "fix(#614): the card ABV is part of a merge alias key"`.

---

### Task 15: `IS NOT` у `dropAliasesOnRelink`; застарілі формулювання (інлайн)

**Files:** Modify `src/storage/beers.ts`, `src/storage/beers.test.ts`.

- [ ] **Step 1: Write the failing test** — після тесту `#614 recordLookupSuccess keeps aliases when the same bid is confirmed`:

```ts
test('#614 recordLookupSuccess drops the aliases of a row whose bid was cleared by hand', () => {
  const db = fresh();
  const rowId = linkedRowWithAlias(db);
  // Ручний SQL обнулив bid; жоден записувач у коді цього не робить, але аліаси вже не мають доказу.
  db.prepare('UPDATE beers SET untappd_id = NULL WHERE id = ?').run(rowId);

  recordLookupSuccess(db, rowId, { bid: 5120103, style: 'Gose', abv: 5, global_rating: 3.72 }, '2026-09-14T07:11:40Z');

  expect(aliasesOf(db, rowId)).toEqual([]);
});
```

- [ ] **Step 2:** `npx vitest run src/storage/beers.test.ts -t "bid was cleared by hand"` → FAIL (аліас лишився; перевір, що запустився 1 тест).
- [ ] **Step 3: Implement** — у `dropAliasesOnRelink` `AND untappd_id <> ?` → `AND untappd_id IS NOT ?`; коментар:
  «Коли в рядка змінюється untappd_id — зокрема з NULL, обнуленого вручну, — його аліаси втрачають доказ і
  видаляються. Для того самого bid умова `IS NOT ?` не виконується». Застарілі формулювання:
  - `beers.ts` коментар над `dropAliasesOnRelink`: «пара = пиво» → «картка = пиво»;
  - `beers.ts` коментар у `mergeIntoCanonical`: «пара броварня + назва цієї сироти» → «картка, яку перевірив пошук»;
  - `beers.test.ts`: назви `remembers the orphan's shop pair…` → `remembers the searched card as an alias…`,
    `re-points an existing alias of the same pair…` → `re-points an existing alias of the same card…`;
    змінна `pairName`/`pairBrewery` → `twinName`/`twinBrewery`; заголовок секції «аліаси в каталозі матчера» →
    «аліаси для /match».
- [ ] **Step 4:** `npx vitest run src/storage/beers.test.ts` → PASS.
- [ ] **Step 5: Mutation** — `IS NOT ?` → `<> ?` → падає новий тест. Поверни.
- [ ] **Step 6: Full gate.**
- [ ] **Step 7: Commit** — `git add src/storage/beers.ts src/storage/beers.test.ts`, потім
  `git commit -m "fix(#614): drop aliases of a row whose bid was cleared, refresh alias wording"`.

---

## Після ядра

1. **Реплей** `scratchpad/replay-round4.mts`, доповнений карткою ABV-близнюка (Leffe 0% / 6.6% через
   `applyLookupOutcome` з `abv`) і пробою `scratchpad/r4rev-abvalias.mts`, переписаною під аліас з
   `abv_key`: жодного хибного `exact`; `exact` ✅ лише для тієї самої картки (текст + ABV).
2. **П'яте наскрізне рев'ю ядра**, окремий диспатч; назвати задачі 2–15 і коміти.
3. **Лише після рев'ю** — план периферії.

## Самоперевірка плану проти спеки

| Розділ спеки | Де в плані |
|---|---|
| `cardAbv` | Task 14 (a) |
| v32: `abv_key` в унікальності | Task 14 (b) |
| Запис: картка запиту з ABV; ABV сироти без `aliasSource` | Task 14 (c) |
| ABV на всіх трьох шляхах `applyLookupOutcome` | Task 14 (f)(g)(h), тести (h)(i) |
| Пошук: ключ з ABV; ABV-близнюк і картка без ABV не влучають | Task 14 (d), тести (e) |
| «Рядок важить більше» лише за текстом; кеш передає каталог під тестом | Task 14 (d)(e), тест (f) |
| Поступки циклу подій | Task 14 (d), тест (e) |
| `dropAliasesOnRelink` з `IS NOT` | Task 15 |
| Межа: втрати адаптера | спека; #637 |
| `ensureBeerRow`, `/enrich/*` з аліасом, репарація #384, API-тест, `spec.md` | **периферія** |
