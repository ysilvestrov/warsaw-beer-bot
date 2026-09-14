# Пам'ять злиття для текстів карток — план ядра (#614), раунд 4: ключ = точний текст картки

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ключ аліасу пам'яті злиття — канонізований **точний текст картки** (`cardText`: NFC,
пробіли, регістр) замість нормалізованої пари з цифрами. `/match` і MCP перевіряють аліас перед
матчером за точною рівністю тексту; рядок каталогу з тим самим текстом вимикає аліас; порожній текст
броварні чи назви аліасу не має.

**Architecture:** **ядро** стадійної зміни. Три раунди рев'ю знаходили хибний ✅ через нормалізатор у
ключі (спека, «Рев'ю ядра»); брейншторм виніс правило ідентичності в #636. Цей раунд переводить ключ
на текст і прибирає `nameDigits`. Лишається з попередніх раундів: аліас пише текст запиту
(`aliasSource`, Task 10), зміна bid відкидає аліаси (Tasks 2–3), `/match` і MCP передають `aliases`
(Task 6), каталог матчера без аліасів (Task 5). Міграція v32 ще ніде не застосована (прод —
версія 31), тож змінюється на місці.

**Периферія йде окремим планом після четвертого наскрізного рев'ю:** аліасне влучання в
`ensureBeerRow`; репарація #384 через аліас; наскрізний API-тест; `spec.md`.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською**, як у решті репо.
- **Повний гейт після КОЖНОЇ задачі** (`npm test` і `npm run typecheck`), ніколи не звужений.
- **Кожен тест мутаційно доведений.** Прибери або зміни названий рядок реалізації — тест має впасти.
- **Сіди з видимими значеннями**, не `null`.
- **Ключ аліасу ніколи не проходить через `normalizeName`/`normalizeBrewery`/`numericNameTokens`.**
  Лише `cardText`.
- **Ніяких `as unknown as` кастів.**
- **Поза ядром:** `ensureBeerRow`, `/enrich/*`, `refresh-ontap`, `ensureOrphan`, матчер, `spec.md`.
- **Код важить більше за цей план.** Розбіжність сигнатури чи назви — іди за кодом і назви її.
- **Розмір задач (CLAUDE.md):** Task 11 і Task 13 — дрібні, **інлайн**. Task 12 зачіпає чотири файли
  коду (спільний тип аліасу не має проміжного стану, що проходить typecheck) — **диспатч
  імплементера**. Імплементер працює **лише** у worktree
  `/home/ysi/warsaw-beer-bot/.claude/worktrees/614-merge-alias-memory` і комітить лише там
  (пам'ять `feedback_subagent_worktree_commit_guard`). Усі задачі 2–13 називаються в диспатчі
  четвертого наскрізного рев'ю.
- **Git в ізольованій сесії worktree** — прості окремі команди. Перевіряти змінені файли на NUL-байти.

---

### Задачі 1–10 — ✅ ЗРОБЛЕНО (перелік у спеці, «Рев'ю ядра»)

Останній коміт перед раундом 4: `9fa0ed8`. З попередніх раундів у коді лишаються й **не
змінюються** в цьому раунді: `dropAliasesOnRelink` + `recordLookupSuccess` у транзакції (`7301421`),
`pinMatch` (`cc798e4`), `/match` і MCP передають `aliases` (`0285628`), `applyLookupOutcome` передає
`input` (`9fa0ed8`).

---

### Task 11: `cardText` — канонізація тексту картки (інлайн)

**Files:**
- Create: `src/domain/card-text.ts`
- Test: `src/domain/card-text.test.ts`

**Interfaces:**
- Produces: `export function cardText(s: string): string`.

- [ ] **Step 1: Write the failing test** — `src/domain/card-text.test.ts`:

```ts
import { cardText } from './card-text';

describe('cardText (#614)', () => {
  test('equal representations of the same text are equal: NFC, whitespace, case', () => {
    // «é» складена (U+00E9) і розкладена (E + U+0301) — один текст.
    expect(cardText('Caf\u00e9 Noir')).toBe(cardText('CAFE\u0301  NOIR'));
    expect(cardText('  VARVAR\n BLACK\tBEAN IS ')).toBe('varvar black bean is');
  });

  test('keeps every piece of content the candidate normalizer drops', () => {
    expect(cardText('Trappistes Rochefort 10')).not.toBe(cardText('Trappistes Rochefort 8'));
    expect(cardText('BQE Nitro (2024 Extra Vanilla)')).not.toBe(cardText('BQE Nitro (2023 Banana Pudding)'));
    expect(cardText('MJØD IS 2023')).not.toBe(cardText('MJØD IS'));
    expect(cardText('Leffe Blonde 0,0%')).not.toBe(cardText('Leffe Blonde'));
    expect(cardText('Browar')).toBe('browar');
  });
});
```

- [ ] **Step 2:** `npx vitest run src/domain/card-text.test.ts` → FAIL (модуля немає).

- [ ] **Step 3: Implement** — `src/domain/card-text.ts`:

```ts
// #614: канонізація тексту картки крамниці для ключа аліасу пам'яті злиття. Змінює лише
// представлення — Unicode NFC, пробіли, регістр — і нічого зі змісту: цифри, дужки, стиль, шум
// броварні лишаються. Навмисно не в normalize.ts: той нормалізатор будує ключ ПОШУКУ кандидатів і за
// побудовою зводить різні пива (#636); ключ, що стверджує «цей текст — це пиво», не сміє нічого губити.
export function cardText(s: string): string {
  return s.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}
```

- [ ] **Step 4:** той самий запуск → PASS.
- [ ] **Step 5: Mutations** (кожну поверни): прибери `.normalize('NFC')` → перший тест падає; прибери
  `.replace(/\s+/gu, ' ')` → перший тест падає.
- [ ] **Step 6: Full gate.**
- [ ] **Step 7: Commit** — `git add src/domain/card-text.ts src/domain/card-text.test.ts`, потім
  `git commit -m "feat(#614): cardText, the exact-text key of a merge alias"`.

---

### Task 12: ключ аліасу — точний текст картки (ДИСПАТЧ імплементера)

**Files:**
- Modify: `src/storage/schema.ts` — SQL v32
- Modify: `src/storage/beers.ts` — `mergeIntoCanonical` (блок аліасу), `AliasRow`, `loadAliases`, імпорти
- Modify: `src/domain/match-list.ts` — `AliasSource`, `AliasIndex`, `aliasKey`, `buildAliasIndex`, `aliasTarget`, імпорти
- Modify: `src/domain/catalog-cache.ts` — виклик `buildAliasIndex(aliasRows, rows)`
- Test: `src/storage/schema.test.ts`, `src/storage/beers.test.ts`, `src/domain/pin-match.test.ts`,
  `src/domain/match-list.test.ts`, `src/domain/catalog-cache.test.ts`, `src/domain/lookup-outcome.test.ts`

**Interfaces:**
- Consumes: `cardText` (Task 11).
- Produces:
  - таблиця `beer_aliases(id, beer_id, brewery, name, brewery_text, name_text, created_at)`,
    `UNIQUE (brewery_text, name_text)`, індекс `idx_beer_aliases_beer`;
  - `mergeIntoCanonical(db, orphanId, canonicalId, at, aliasSource?: { brewery: string; name: string })` (сигнатура та сама);
  - `AliasRow = { beer_id: number; brewery_text: string; name_text: string }`, `loadAliases(db): AliasRow[]`;
  - `AliasSource = AliasRow`-сумісний тип у `match-list.ts`; `AliasIndex = ReadonlyMap<string, number>`;
  - `buildAliasIndex(aliases: readonly AliasSource[], catalog: readonly { id: number; brewery: string; name: string }[]): AliasIndex`.

- [ ] **Step 1: Write the failing tests**

**(a) `schema.test.ts`, `describe('v32 beer_aliases (#614)')`** — обидва тести переписати під колонки
`['id', 'beer_id', 'brewery', 'name', 'brewery_text', 'name_text', 'created_at']`:
- перший: вставити аліас `(8, 'ROCH', 'Rochefort 8 IS', 'roch', 'rochefort 8 is')`, потім
  `(10, 'ROCH', 'Rochefort 10 IS', 'roch', 'rochefort 10 is')` (інший текст — дозволено), потім знову
  `'roch', 'rochefort 8 is'` → `toThrow(/UNIQUE constraint failed/)`;
- другий (каскад): вставка з `brewery_text`/`name_text`, `DELETE FROM beers` → 0 аліасів.

**(b) `beers.test.ts`, блоки `#614`:**
1. Імпорт: `import { cardText } from '../domain/card-text';` (і прибрати `nameDigits` з імпорту нормалізації).
2. `type AliasRow` і SELECT в `aliasesOf`: колонки `beer_id, brewery, name, brewery_text, name_text, created_at`.
3. Кожен сирий `INSERT INTO beer_aliases` у цьому файлі — колонки `(beer_id, brewery, name, brewery_text, name_text, created_at)`,
   значення тексту через `cardText(...)` від сирих `brewery`/`name` того самого рядка.
4. `remembers the orphan's shop pair as an alias…` — очікування:
   `{ beer_id: canonicalId, brewery: 'VARVAR', name: 'BLACK BEAN IS', brewery_text: 'varvar', name_text: 'black bean is', created_at: '2026-09-14T07:13:20Z' }`.
5. **Видалити** тести `writes no alias for a key another beers row already holds — same pair AND same digits`
   і `is not blocked by a twin that differs only in digits` (перевірки під час запису більше немає).
6. `writes the alias from the searched text…` — очікування
   `[['Ґвара', 'Ґвара #7', 'ґвара', 'ґвара #7']]` через `map((a) => [a.brewery, a.name, a.brewery_text, a.name_text])`.
7. `twin cards of one shop keep one alias each` — очікування
   `[{ beer_id: 8, name_text: 'rochefort 8 is' }, { beer_id: 10, name_text: 'rochefort 10 is' }]`
   (SELECT `beer_id, name_text`).
8. Додати після нього:

```ts
test('#614 mergeIntoCanonical writes no alias for a card whose brewery text is empty', () => {
  const db = fresh();
  const canonicalId = seedBeer(db, {
    untappd_id: 6810840, name: 'Amigo Mate Bananowe', brewery: 'Amigo Mate',
    style: 'Mate', abv: 0, rating_global: 3.4,
    normalized_name: normalizeName('Amigo Mate Bananowe'), normalized_brewery: normalizeBrewery('Amigo Mate'),
  });
  const orphanId = seedBeer(db, {
    name: 'AMIGO MATE BANANOWE', brewery: '  ', style: null, abv: 0, rating_global: null,
    normalized_name: normalizeName('AMIGO MATE BANANOWE'), normalized_brewery: normalizeBrewery('  '),
  });

  mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T10:00:00Z', { brewery: '  ', name: 'AMIGO MATE BANANOWE' });

  const n = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
  expect(n.n).toBe(0);
});
```

9. `describe('loadAliases (#614)')`: перший тест — очікування
   `[{ beer_id: canonicalId, brewery_text: 'varvar', name_text: 'black bean is' }]`; тест
   `skips an alias whose canonical row has no untappd_id` — лишається; **видалити** тести
   `skips an alias whose pair a beers row now holds — the row wins` і
   `keeps an alias when the pair holder is a twin with different digits` (правило переходить у
   `buildAliasIndex`).

**(c) `pin-match.test.ts`** — сирий `INSERT` тесту `#614`: колонки `brewery_text, name_text`, значення `'copper head', 'red mexican tomato gose'`.

**(d) `match-list.test.ts`, блок `matchBeerList aliases (#614)`** — **замінити цілком**:

```ts
describe('matchBeerList aliases (#614)', () => {
  const rochefort: CatalogBeerWithRating[] = [
    { id: 8, brewery: 'Brasserie de Rochefort', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.95, untappd_id: 1001 },
    { id: 10, brewery: 'Brasserie de Rochefort', name: 'Trappistes Rochefort 10', abv: 11.3, rating_global: 4.2, untappd_id: 2002 },
  ];
  const alias = (beerId: number, brewery: string, name: string) => ({
    beer_id: beerId, brewery_text: cardText(brewery), name_text: cardText(name),
  });
  const noYield = { yield: async () => {} };
  const run = async (catalog: CatalogBeerWithRating[], aliasRows: ReturnType<typeof alias>[], card: { brewery: string; name: string; abv?: number }, drunkId: number) => {
    const { prepared, byId } = prep(catalog);
    const aliases = buildAliasIndex(aliasRows, catalog);
    return matchBeerList(prepared, byId, new Set([drunkId]), new Map([[drunkId, 4.0]]), [card], { ...noYield, aliases });
  };

  it('a merged card text matches its canonical row exactly, with drunk status and rating, without the fallback', async () => {
    const res = await run(rochefort, [alias(8, 'ROCH', 'Trappistes Rochefort 8')], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8);
    expect(res.results).toEqual([{
      raw: { brewery: 'ROCH', name: 'Trappistes Rochefort 8' },
      matched_beer: { id: 8, name: 'Trappistes Rochefort 8', brewery: 'Brasserie de Rochefort', rating_global: 3.95, untappd_id: 1001 },
      is_drunk: true, drunk_uncertain: false, user_rating: 4.0, source: 'exact', searched: true,
    }]);
    expect(res.fallback.attempts).toBe(0);
  });

  it('case and whitespace of the same text still hit the alias', async () => {
    const [r] = (await run(rochefort, [alias(8, 'ROCH', 'Trappistes Rochefort 8')], { brewery: ' roch ', name: 'trappistes  ROCHEFORT 8' }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
  });

  // Сценарії трьох рев'ю: жоден інший зміст не дістає аліасу.
  it.each([
    ['other digits', { brewery: 'ROCH', name: 'Trappistes Rochefort 10', abv: 11.3 }, alias(8, 'ROCH', 'Trappistes Rochefort 8')],
    ['a year only on the card', { brewery: 'ROCH', name: 'Trappistes Rochefort 8 2023' }, alias(8, 'ROCH', 'Trappistes Rochefort 8')],
    ['another year inside parentheses', { brewery: 'ROCH', name: 'Rochefort (2024 Extra Vanilla)' }, alias(8, 'ROCH', 'Rochefort (2023 Banana Pudding)')],
  ])('%s never rides the alias', async (_label, card, aliasRow) => {
    const [r] = (await run(rochefort, [aliasRow], card, 8)).results;
    expect(r.is_drunk).toBe(false);
    expect(r.source === 'exact' && r.matched_beer?.id === 8).toBe(false);
  });

  it('a card with an empty brewery text never looks up an alias', async () => {
    const [r] = (await run(rochefort, [alias(8, '', 'Trappistes Rochefort 8')], { brewery: '  ', name: 'Trappistes Rochefort 8' }, 8)).results;
    expect(r.source === 'exact' && r.matched_beer?.id === 8 && r.is_drunk).toBe(false);
  });

  it('buildAliasIndex drops an alias whose exact text another catalog row holds — the row wins', () => {
    const catalog = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: null, untappd_id: null }];
    expect(buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')], catalog).size).toBe(0);
    // Той самий текст лише в самій цілі — аліас лишається.
    const selfHeld = [{ id: 8, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.95, untappd_id: 1001 }];
    expect([...buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')], selfHeld).values()]).toEqual([8]);
  });
});
```

Імпорти `match-list.test.ts`: `import { cardText } from './card-text';`, прибрати `nameDigits` з імпорту
нормалізації (решту `normalize` залиш, якщо ще вживається у файлі; інакше прибери імпорт).

**(e) `catalog-cache.test.ts`** — у `make` залиш `loadAliases: () => []`; юніт `#614 builds the alias index…`:
`aliasRows = [{ beer_id: 1, brewery_text: 'pinta', name_text: 'atak chmielu ipa' }]`, очікування
`[...aliases.values()]` → `[1]`, `prepared.beers` — два рядки. Інтеграційний тест лишається.

**(f) `lookup-outcome.test.ts`** — тест `#614 records the alias from the text the caller searched…`:
SELECT `beer_id, name, name_text`, очікування `[{ beer_id: g7, name: 'Ґвара #7', name_text: 'ґвара #7' }]`.

- [ ] **Step 2:** `npx vitest run` для шести тестових файлів → FAIL (немає колонок `brewery_text`/`name_text`; `buildAliasIndex` з одним аргументом).

- [ ] **Step 3: Implement**

**(a) `schema.ts`, v32** — SQL таблиці:

```sql
      CREATE TABLE IF NOT EXISTS beer_aliases (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        beer_id      INTEGER NOT NULL REFERENCES beers(id) ON DELETE CASCADE,
        brewery      TEXT NOT NULL,
        name         TEXT NOT NULL,
        brewery_text TEXT NOT NULL,
        name_text    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (brewery_text, name_text)
      );
      CREATE INDEX IF NOT EXISTS idx_beer_aliases_beer ON beer_aliases(beer_id);
```

Коментар міграції: замінити речення про сиру/нормалізовану пару й `name_digits` на
«ключ — `cardText` броварні й назви картки (#614): лише представлення тексту, без нормалізатора
кандидатів, який зводить різні пива (#636)».

**(b) `beers.ts`:**
- імпорти: `import { cardText } from '../domain/card-text';`; з `../domain/normalize` лишити лише
  те, що ще вживається у файлі (`numericTokensCompatible`).
- у `mergeIntoCanonical` блок від `const source = aliasSource ?? orphan;` до кінця `if (source) { … }`:

```ts
    const source = aliasSource ?? orphan;
    if (source) {
      const breweryText = cardText(source.brewery);
      const nameText = cardText(source.name);
      // Порожній текст не прив'язаний ні до крамниці, ні до пива: доказ злиття на ньому ділився б між
      // картками (рев'ю 3: «Browar», «2085 Brewery» і '' зводились в один ключ нормалізатора).
      if (breweryText !== '' && nameText !== '') {
        // Той самий текст уже вказує на інший рядок → переходить на новий: найсвіжіше злиття має
        // найсвіжіший доказ. Рядок каталогу з тим самим текстом вимикає аліас під час читання
        // (buildAliasIndex), тож перевірки власника під час запису немає.
        db.prepare(
          `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(brewery_text, name_text) DO UPDATE SET
             beer_id = excluded.beer_id,
             brewery = excluded.brewery,
             name = excluded.name,
             created_at = excluded.created_at`,
        ).run(canonicalId, source.brewery, source.name, breweryText, nameText, at);
      }
    }
```

  (коментар над `const source` про `aliasSource` лишається).
- `AliasRow` і `loadAliases`:

```ts
// #614: аліаси пам'яті злиття для перевірки перед матчером. Аліас рядка без untappd_id не читається —
// та сама жива перевірка, що й isRememberedMerge (#366). Правило «рядок каталогу з тим самим текстом
// важить більше» застосовує buildAliasIndex, бо кеш і так має весь каталог.
export interface AliasRow {
  beer_id: number;
  brewery_text: string;
  name_text: string;
}

export function loadAliases(db: DB): AliasRow[] {
  return db
    .prepare(
      `SELECT a.beer_id, a.brewery_text, a.name_text
         FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
        WHERE b.untappd_id IS NOT NULL
        ORDER BY a.id`,
    )
    .all() as AliasRow[];
}
```

**(c) `match-list.ts`** — імпорт `import { cardText } from './card-text';` (прибрати імпорт з
`./normalize`, якщо більше не вживається). Блок від `/** #614: аліас із пам'яті злиття …` до кінця
`aliasTarget`:

```ts
/** #614: аліас із пам'яті злиття — точний текст картки крамниці → канонічний рядок. */
export interface AliasSource {
  beer_id: number;
  brewery_text: string;
  name_text: string;
}

export type AliasIndex = ReadonlyMap<string, number>;

// Роздільник `|`: cardText зберігає пробіли, тож пробіл склеїв би «a b» + «c» і «a» + «b c».
const aliasKey = (breweryText: string, nameText: string): string => `${breweryText}|${nameText}`;

// #614: рядок каталогу з тим самим точним текстом важить більше за аліас (пізніша сирота кранів;
// сирота, яку репарація #384 зробила рядком нового bid) — картку тоді відповідає матчер. Той самий
// текст у самій цілі аліас не вимикає.
export function buildAliasIndex(
  aliases: readonly AliasSource[],
  catalog: readonly { id: number; brewery: string; name: string }[],
): AliasIndex {
  const holders = new Map<string, Set<number>>();
  for (const row of catalog) {
    const key = aliasKey(cardText(row.brewery), cardText(row.name));
    (holders.get(key) ?? holders.set(key, new Set()).get(key)!).add(row.id);
  }
  const index = new Map<string, number>();
  for (const a of aliases) {
    const key = aliasKey(a.brewery_text, a.name_text);
    const held = holders.get(key);
    if (held && [...held].some((id) => id !== a.beer_id)) continue;
    index.set(key, a.beer_id);
  }
  return index;
}

// #614: ключ — точний текст картки (cardText): нічого зі змісту не губиться, тож картка з іншими
// цифрами, роком у дужках чи іншою броварнею аліасу не дістає. Порожній текст аліасу не має.
// Рядок, якого немає в цьому знімку каталогу, — не влучання.
function aliasTarget(
  aliases: AliasIndex | undefined,
  item: MatchInput,
  byId: Map<number, CatalogBeerWithRating>,
): CatalogBeerWithRating | null {
  if (!aliases || aliases.size === 0) return null;
  const breweryText = cardText(item.brewery);
  const nameText = cardText(item.name);
  if (breweryText === '' || nameText === '') return null;
  const beerId = aliases.get(aliasKey(breweryText, nameText));
  return beerId === undefined ? null : (byId.get(beerId) ?? null);
}
```

**(d) `catalog-cache.ts`** — у `rebuild` рядок
`const aliases = buildAliasIndex(loadAliasRows());` → `const aliases = buildAliasIndex(loadAliasRows(), rows);`
і коментар над ним допиши: «рядки каталогу потрібні для правила “рядок з тим самим текстом важить більше”».

- [ ] **Step 4:** шість тестових файлів + `match.test.ts`, `mcp.test.ts`, `match-tool.test.ts`, `enrich.test.ts` → PASS.

- [ ] **Step 5: Mutations** (кожну поверни; імплементер звітує вивід):
1. `UNIQUE (brewery_text, name_text)` → прибрати рядок → падає перший тест v32.
2. `if (breweryText !== '' && nameText !== '')` → `if (true)` → падає `writes no alias for a card whose brewery text is empty`.
3. `DO UPDATE SET …` → `DO NOTHING` → падає `re-points an existing alias…`.
4. У `buildAliasIndex` прибрати `if (held && …) continue;` → падає `buildAliasIndex drops an alias…` (перша перевірка).
5. У `buildAliasIndex` `id !== a.beer_id` → `true` → падає та сама (друга перевірка, `selfHeld`).
6. У `aliasTarget` прибрати `if (breweryText === '' || nameText === '') return null;` і в тесті
   порожньої броварні аліас `alias(8, '', …)` → має влучити, тест падає.
7. `cardText(item.name)` → `item.name` → падає `case and whitespace of the same text still hit the alias`.

- [ ] **Step 6: Full gate.** Перевір усі змінені файли на NUL-байти.
- [ ] **Step 7: Commit** — прості команди `git add` (усі змінені файли) і
  `git commit -m "fix(#614): key merge aliases by the exact card text, not the candidate normalizer"`.

---

### Task 13: прибрати `nameDigits` (інлайн)

**Files:** Modify `src/domain/normalize.ts`, `src/domain/normalize.test.ts`.

- [ ] **Step 1:** переконайся, що `nameDigits` більше ніде не вживається: `grep -rn "nameDigits" src scripts` → лише `normalize.ts` і `normalize.test.ts`.
- [ ] **Step 2:** видали функцію `nameDigits` з коментарем у `normalize.ts`, блок `describe('nameDigits (#614)')` і `nameDigits` з імпорту в `normalize.test.ts`.
- [ ] **Step 3: Full gate.**
- [ ] **Step 4: Commit** — `git add src/domain/normalize.ts src/domain/normalize.test.ts`, потім
  `git commit -m "refactor(#614): drop nameDigits, the alias key no longer uses the normalizer"`.

---

## Після ядра

1. **Реплей сценаріїв трьох рев'ю** на справжньому шляху (`applyLookupOutcome` → кеш → `matchBeerList`):
   Rochefort 8/10 (близнюки однієї крамниці), `MJØD IS 2023`, «Ґвара #6/#7», `BQE Nitro (2023/2024 …)`,
   порожня броварня `Amigo Mate Bananowe`, картка Black Bean. Очікування: жодного хибного `exact`;
   `exact` ✅ лише для того самого тексту.
2. **Четверте наскрізне рев'ю ядра**, окремий диспатч; назвати задачі 2–13 і коміти.
3. **Лише після рев'ю** — план периферії.

## Самоперевірка плану проти спеки

| Розділ спеки | Де в плані |
|---|---|
| `cardText` — лише NFC, пробіли, регістр | Task 11 |
| v32: `brewery_text`, `name_text`, унікальність, каскад | Task 12 (a) |
| Запис з `aliasSource`, `cardText`; порожній текст без аліасу; `ON CONFLICT` | Task 12 (b) |
| `loadAliases` — жива перевірка лінку | Task 12 (b) |
| «Рядок з тим самим текстом важить більше» (читання) | Task 12 (c), `buildAliasIndex` |
| Аліас перед матчером за точним текстом; порожній текст не шукається | Task 12 (c), `aliasTarget` |
| Сценарії трьох рев'ю не влучають | Task 12 (d), `it.each` + порожня броварня |
| Текст запиту в злитті; зміна bid відкидає аліаси; `/match` і MCP | задачі 2, 3, 6, 10 (без змін) |
| Прибрати залишки ключа з цифрами | Task 13 |
| `ensureBeerRow`, `/enrich/*`, репарація #384, API-тест, `spec.md` | **периферія** |
