# Пам'ять злиття для назв з крамниць — план ядра (#614), третій раунд після двох рев'ю

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** злиття сироти в канонічний рядок запам'ятовує **текст, який перевірив пошук**, як аліас з
ключем «нормалізована броварня | нормалізована назва | числові токени назви». `/match` і MCP
перевіряють аліас перед матчером за **точною** рівністю ключа й дають `exact` з особистим статусом
«пив» і оцінкою. Аліаси відкидаються, коли bid їхнього рядка змінюється.

**Architecture:** **ядро** стадійної зміни. Задачі 1–6 уже в гілці. Друге наскрізне рев'ю знайшло,
що ключ аліасу без цифр і текст сироти замість тексту запиту все ще дають хибний ✅ (сценарії B і
C) і петлю для близнюків (A) — спека, «Рев'ю ядра → Друге рев'ю». Задачі 7–10 виправляють **ключ і
джерело**, а не порівняння. Міграція v32 ще ніде не застосована, тож змінюється на місці.

**Периферія йде окремим планом після третього наскрізного рев'ю ядра:**
- `ensureBeerRow`: сирота лише з сумісними цифрами; аліасне влучання;
- репарація #384 через аліас;
- наскрізний API-тест `/enrich/*` → `/match`;
- `spec.md`.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською**, як у решті репо.
- **Повний гейт після КОЖНОЇ задачі** (`npm test` і `npm run typecheck`), ніколи не звужений до
  своїх файлів. Розширення (`extension/`) ця зміна не зачіпає.
- **Кожен тест мутаційно доведений.** Прибери або зміни названий рядок реалізації — тест має
  впасти; поверни рядок.
- **Сіди з видимими значеннями**, не `null` (пам'ять `feedback_stub_defaults_hide_mutations`).
- **Два рядки з однаковою нормалізованою парою сідуються лише сирим `INSERT`** (`seedBeer`
  переписав би перший рядок другим).
- **Ніяких `as unknown as` кастів.**
- **Поза ядром:** `ensureBeerRow`, `/enrich/*`, `refresh-ontap`, `ensureOrphan`, `spec.md`.
- **Код важить більше за цей план.** Розбіжність сигнатури чи назви — іди за кодом і назви її.
- **Виконання інлайн** (кожна задача: повний код у тексті, ≤2 файли коду + тести, без нових
  рішень). Усі задачі 2–10 називаються в диспатчі третього наскрізного рев'ю.
- **Git в ізольованій сесії worktree** — лише прості окремі команди. Шаблонні рядки з `|` писати
  звичайним символом; перевіряти файли на NUL-байти (одного разу `Write` поклав `\x00`).

---

### Задачі 1–6 — ✅ ЗРОБЛЕНО

| Задача | Коміт | Що |
|---|---|---|
| 1 | `111828b` | міграція v32 `beer_aliases` (змінюється в задачі 8) |
| — | `9325d68` | запис аліасу в `mergeIntoCanonical` (переписується в задачі 8) |
| — | `67bacfe` | аліаси в каталозі матчера (скасовано задачею 5) |
| 2 | `7301421` | злиття не переносить аліаси; `dropAliasesOnRelink` у `recordLookupSuccess` |
| 3 | `cc798e4` | `pinMatch` на новий bid відкидає аліаси |
| 4 | `c6f149e` | аліас перед матчером у `matchBeerList` (правило цифр змінюється в задачі 9) |
| 5 | `44f7916` | `loadAliases`, індекс у кеші, каталог матчера без аліасів (змінюється в задачі 8) |
| 6 | `0285628` | `/match` і MCP передають `aliases` |

---

### Task 7: `nameDigits` — цифрова частина ключа

**Files:**
- Modify: `src/domain/normalize.ts` (одразу після `numericTokensCompatible`)
- Test: `src/domain/normalize.test.ts` (імпорт у рядку 1; новий `describe` у кінці)

**Interfaces:**
- Produces: `export function nameDigits(s: string): string` — `numericNameTokens(s)`, відсортовані
  й склеєні пробілом; `''` без цифр. Задачі 8 і 9 будують з неї ключ.

- [ ] **Step 1: Write the failing test**

У рядку 1 `normalize.test.ts` додай `nameDigits` до імпорту з `./normalize`. У кінець файлу:

```ts
describe('nameDigits (#614)', () => {
  test('keeps the numeric tokens normalizeName drops, sorted so word order does not matter', () => {
    expect(nameDigits('Ґвара #6')).toBe('6');
    expect(nameDigits('MJØD IS 2023')).toBe('2023');
    expect(nameDigits('Batch 12 Vol 3')).toBe('12 3');
    expect(nameDigits('Vol 3 Batch 12')).toBe('12 3');
  });

  test('is empty without digits, and a pack spec is not a digit of the name', () => {
    expect(nameDigits('MJØD IS')).toBe('');
    expect(nameDigits('Pils 0,5 L 12°')).toBe('');
  });
});
```

- [ ] **Step 2:** `npx vitest run src/domain/normalize.test.ts -t "nameDigits"` → FAIL (`nameDigits is not a function`).

- [ ] **Step 3: Implement** — після `numericTokensCompatible` у `normalize.ts`:

```ts
// #614: цифрова частина ключа аліасу пам'яті злиття — рівно те, що normalizeName відкидає. Токени
// відсортовані, тож порядок слів не важить; ключ порівнюється на точну рівність, без «сумісних» цифр.
export function nameDigits(s: string): string {
  return numericNameTokens(s).sort().join(' ');
}
```

- [ ] **Step 4:** той самий запуск → PASS.
- [ ] **Step 5: Mutation** — прибери `.sort()` → має впасти перший тест (`Vol 3 Batch 12` → `3 12`). Поверни.
- [ ] **Step 6: Full gate.**
- [ ] **Step 7: Commit** — `git add src/domain/normalize.ts src/domain/normalize.test.ts`, потім
  `git commit -m "feat(#614): nameDigits, the digit part of a merge alias key"`.

---

### Task 8: цифри в ключі аліасу; аліас пише текст запиту

**Files:**
- Modify: `src/storage/schema.ts` — SQL міграції v32
- Modify: `src/storage/beers.ts` — імпорт з `../domain/normalize`; `mergeIntoCanonical`; `AliasRow` і `loadAliases`
- Test: `src/storage/schema.test.ts` (`describe('v32 beer_aliases (#614)')`)
- Test: `src/storage/beers.test.ts` (блоки `#614`)
- Test (сирі `INSERT` отримують нову колонку): `src/domain/pin-match.test.ts` (тест `#614`),
  `src/domain/catalog-cache.test.ts` (юніт `#614 builds the alias index…` — літерал `aliasRows`)

**Interfaces:**
- Consumes: `nameDigits` (Task 7).
- Produces:
  - колонка `beer_aliases.name_digits TEXT NOT NULL`, `UNIQUE (normalized_brewery, normalized_name, name_digits)`;
  - `mergeIntoCanonical(db, orphanId, canonicalId, at, aliasSource?: { brewery: string; name: string })`;
  - `AliasRow = { beer_id; name; normalized_brewery; normalized_name; name_digits }` (Task 9 читає `name_digits`).

- [ ] **Step 1: Write the failing tests**

**(a) `schema.test.ts`**, `describe('v32 beer_aliases (#614)')` — заміни обидва тести:

```ts
  it('creates beer_aliases keyed by the normalized pair plus the name digits', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(beer_aliases)').all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toEqual([
      'id', 'beer_id', 'brewery', 'name', 'normalized_brewery', 'normalized_name', 'name_digits', 'created_at',
    ]);
    db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
                VALUES (8, 1001, 'Trappistes Rochefort 8', 'Brasserie de Rochefort', 'trappistes rochefort', 'rochefort'),
                       (10, 2002, 'Trappistes Rochefort 10', 'Brasserie de Rochefort', 'trappistes rochefort', 'rochefort')`).run();
    const insert = db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, name_digits, created_at)
       VALUES (?, 'ROCH', ?, 'roch', 'rochefort', ?, '2026-09-14T07:13:20Z')`,
    );
    insert.run(8, 'Rochefort 8 IS', '8');
    // Та сама пара з іншими цифрами — інший ключ: близнюки однієї крамниці живуть поруч.
    insert.run(10, 'Rochefort 10 IS', '10');
    // Той самий ключ удруге відмовляється.
    expect(() => insert.run(10, 'Rochefort 8 IS', '8')).toThrow(/UNIQUE constraint failed/);
  });

  it('drops a beer row\'s aliases together with the row', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO beers (id, untappd_id, name, brewery, normalized_name, normalized_brewery)
                VALUES (2815, 3548624, 'Black Bean', 'Varvar Brew', 'black bean', 'varvar brew')`).run();
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, name_digits, created_at)
       VALUES (2815, 'VARVAR', 'BLACK BEAN IS', 'varvar', 'black bean is', '', '2026-09-14T07:13:20Z')`,
    ).run();
    db.prepare('DELETE FROM beers WHERE id = 2815').run();
    const left = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
    expect(left.n).toBe(0);
  });
```

**(b) `beers.test.ts`:**
1. Імпорт нормалізації (рядок 5) доповни: `import { normalizeName, normalizeBrewery, nameDigits } from '../domain/normalize';`
2. `type AliasRow` у блоці `#614` отримує поле `name_digits: string`; SELECT в `aliasesOf` — колонку `name_digits` після `normalized_name`.
3. Тест `#614 mergeIntoCanonical remembers the orphan's shop pair as an alias of the canonical row` — в очікуваний об'єкт додай `name_digits: ''` після `normalized_name`.
4. У **кожному** сирому `INSERT INTO beer_aliases` цього файлу (тести `lets a merged linked row's aliases go…`, `re-points an existing alias…`, хелпер `linkedRowWithAlias`, хелпер `canonicalWithAlias` у `loadAliases (#614)`) додай колонку `name_digits` зі значенням `''` (у цих назвах цифр немає).
5. Тест `#614 mergeIntoCanonical writes no alias for a pair another beer row already holds (vintage twin)` **заміни цілком** на два:

```ts
test('#614 mergeIntoCanonical writes no alias for a key another beers row already holds — same pair AND same digits', () => {
  const db = fresh();
  const pairName = normalizeName('Trappistes Rochefort 10');
  const pairBrewery = normalizeBrewery('Abbaye de Rochefort');
  // Сирий INSERT: seedBeer злив би рядки з однаковою парою в один.
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, abv, normalized_name, normalized_brewery)
     VALUES (10, 2002, 'Rochefort 10', 'Brasserie Rochefort', 11.3, ?, ?),
            (11, 2010, 'Trappistes Rochefort 10', 'Abbaye de Rochefort', 11.3, ?, ?),
            (77, NULL, 'Trappistes Rochefort 10', 'Abbaye de Rochefort', 11.3, ?, ?)`,
  ).run(
    normalizeName('Rochefort 10'), normalizeBrewery('Brasserie Rochefort'),
    pairName, pairBrewery,
    pairName, pairBrewery,
  );

  mergeIntoCanonical(db, 77, 10, '2026-09-14T00:03:58Z');

  // Рядок 11 сам відповідає картці з цим ключем; аліас дав би /match другу відповідь.
  const n = db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get() as { n: number };
  expect(n.n).toBe(0);
});

test('#614 mergeIntoCanonical is not blocked by a twin that differs only in digits', () => {
  const db = fresh();
  // Без цієї передумови тест нічого б не доводив: пара близнюків однакова.
  expect(normalizeName('Trappistes Rochefort 10')).toBe(normalizeName('Trappistes Rochefort 8'));
  const pairName = normalizeName('Trappistes Rochefort 10');
  const pairBrewery = normalizeBrewery('Abbaye de Rochefort');
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

  expect(aliasesOf(db, 10).map((a) => [a.name, a.name_digits])).toEqual([['Trappistes Rochefort 10', '10']]);
});
```

6. Після тесту `#614 mergeIntoCanonical re-points an existing alias of the same pair to the newest merge target` додай:

```ts
test('#614 mergeIntoCanonical writes the alias from the searched text, not from an orphan another card created', () => {
  const db = fresh();
  const g7 = seedBeer(db, {
    untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
    style: 'Stout', abv: 7, rating_global: 3.9,
    normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
  });
  // Сирота картки «#6»; ensureBeerRow цифр не бачить і віддає її картці «#7», чий пошук знайшов bid 4007.
  const orphanId = seedBeer(db, {
    name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
    normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
  });

  mergeIntoCanonical(db, orphanId, g7, '2026-09-14T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7' });

  expect(aliasesOf(db, g7).map((a) => [a.brewery, a.name, a.name_digits])).toEqual([['Ґвара', 'Ґвара #7', '7']]);
});

test('#614 twin cards of one shop keep one alias each', () => {
  const db = fresh();
  const pairName = normalizeName('Trappistes Rochefort 8');
  const pairBrewery = normalizeBrewery('Brasserie de Rochefort');
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, abv, normalized_name, normalized_brewery)
     VALUES (8, 1001, 'Trappistes Rochefort 8', 'Brasserie de Rochefort', 9.2, ?, ?),
            (10, 2002, 'Trappistes Rochefort 10', 'Brasserie de Rochefort', 11.3, ?, ?)`,
  ).run(pairName, pairBrewery, pairName, pairBrewery);
  const card8 = seedBeer(db, {
    name: 'Rochefort 8 IS', brewery: 'ROCH', style: null, abv: 9.2, rating_global: null,
    normalized_name: normalizeName('Rochefort 8 IS'), normalized_brewery: normalizeBrewery('ROCH'),
  });
  mergeIntoCanonical(db, card8, 8, '2026-09-14T07:10:00Z');
  const card10 = seedBeer(db, {
    name: 'Rochefort 10 IS', brewery: 'ROCH', style: null, abv: 11.3, rating_global: null,
    normalized_name: normalizeName('Rochefort 10 IS'), normalized_brewery: normalizeBrewery('ROCH'),
  });
  mergeIntoCanonical(db, card10, 10, '2026-09-14T07:11:00Z');

  const rows = db.prepare('SELECT beer_id, name_digits FROM beer_aliases ORDER BY beer_id').all();
  expect(rows).toEqual([{ beer_id: 8, name_digits: '8' }, { beer_id: 10, name_digits: '10' }]);
});
```

7. У `describe('loadAliases (#614)')`: очікуваний об'єкт першого тесту доповни `name_digits: ''` після
   `normalized_name`. Після тесту `skips an alias whose pair a beers row now holds — the row wins` додай:

```ts
  test('keeps an alias when the pair holder is a twin with different digits', () => {
    const db = fresh();
    const canonicalId = seedBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: 'Brasserie de Rochefort',
      style: 'Quadrupel', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery('Brasserie de Rochefort'),
    });
    db.prepare(
      `INSERT INTO beer_aliases (beer_id, brewery, name, normalized_brewery, normalized_name, name_digits, created_at)
       VALUES (?, 'ROCH', 'Rochefort 8 IS', ?, ?, ?, '2026-09-14T07:10:00Z')`,
    ).run(canonicalId, normalizeBrewery('ROCH'), normalizeName('Rochefort 8 IS'), nameDigits('Rochefort 8 IS'));
    // Сирота картки-близнюка «10» з тією самою парою.
    seedBeer(db, {
      name: 'Rochefort 10 IS', brewery: 'ROCH', style: null, abv: 11.3, rating_global: null,
      normalized_name: normalizeName('Rochefort 10 IS'), normalized_brewery: normalizeBrewery('ROCH'),
    });

    expect(loadAliases(db).map((a) => [a.beer_id, a.name_digits])).toEqual([[canonicalId, '8']]);
  });
```

**(c) `pin-match.test.ts`** — у тесті `#614` сирий `INSERT` отримує колонку `name_digits` зі значенням `''`.

**(d) `catalog-cache.test.ts`** — у юніті `#614 builds the alias index…` літерал `aliasRows` отримує `name_digits: ''`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/storage/schema.test.ts src/storage/beers.test.ts src/domain/pin-match.test.ts src/domain/catalog-cache.test.ts`
Expected: FAIL — `table beer_aliases has no column named name_digits`; колонки v32 без `name_digits`.

- [ ] **Step 3: Implement**

**(a) `schema.ts`, v32** — у SQL після рядка `normalized_name    TEXT NOT NULL,` додай
`        name_digits        TEXT NOT NULL,`; рядок `UNIQUE (normalized_brewery, normalized_name)`
заміни на `UNIQUE (normalized_brewery, normalized_name, name_digits)`. Останній рядок коментаря
міграції допиши:

```ts
    // name_digits — числові токени назви (nameDigits): normalizeName їх відкидає, а «Rochefort 8» і
    // «Rochefort 10» — різні пива, тож без них у ключі аліас однієї картки відповідав би за іншу.
```

**(b) `beers.ts`** — імпорт у рядку 3:

```ts
import { nameDigits, normalizeBrewery, normalizeName, numericTokensCompatible } from '../domain/normalize';
```

Сигнатура: `export function mergeIntoCanonical(db: DB, orphanId: number, canonicalId: number, at: string, aliasSource?: { brewery: string; name: string }): void {`

Усередині транзакції заміни блок від `const orphan = db` до закриваючої `}` блоку `if (orphan) { … }` на:

```ts
    const orphan = db
      .prepare('SELECT brewery, name FROM beers WHERE id = ?')
      .get(orphanId) as { brewery: string; name: string } | undefined;
    // #614: текст аліасу — той, який шукав виклик (applyLookupOutcome передає свій input). ensureBeerRow
    // цифр не бачить, тож сирота могла прийти від іншої картки («Ґвара #6» для запиту «Ґвара #7»), і її
    // текст записав би аліас на пиво, якого пошук для неї не доводив.
    const source = aliasSource ?? orphan;
    if (source) {
      const normalizedBrewery = normalizeBrewery(source.brewery);
      const normalizedName = normalizeName(source.name);
      const digits = nameDigits(source.name);
      // Ключ, який уже тримає інший рядок beers (та сама пара і ті самі цифри), аліасом не робимо: той
      // рядок сам відповідає цій картці. Близнюк з іншими цифрами («Rochefort 8» для «Rochefort 10»)
      // запис не блокує — ключ аліасу від нього відрізняється.
      const holders = db
        .prepare('SELECT name FROM beers WHERE normalized_brewery = ? AND normalized_name = ? AND id <> ?')
        .all(normalizedBrewery, normalizedName, orphanId) as { name: string }[];
      if (!holders.some((h) => nameDigits(h.name) === digits)) {
        // Той самий ключ уже вказує на інший рядок → переходить на новий: найсвіжіше злиття має
        // найсвіжіший доказ.
        db.prepare(
          `INSERT INTO beer_aliases
             (beer_id, brewery, name, normalized_brewery, normalized_name, name_digits, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(normalized_brewery, normalized_name, name_digits) DO UPDATE SET
             beer_id = excluded.beer_id,
             brewery = excluded.brewery,
             name = excluded.name,
             created_at = excluded.created_at`,
        ).run(canonicalId, source.brewery, source.name, normalizedBrewery, normalizedName, digits, at);
      }
    }
```

`AliasRow` і `loadAliases` заміни на:

```ts
// #614: аліаси пам'яті злиття для перевірки перед матчером (matchBeerList). Не читаються:
// - аліас рядка без untappd_id — та сама жива перевірка, що й isRememberedMerge (#366);
// - аліас, чий ключ тримає рядок beers — та сама нормалізована пара І ті самі цифри назви (пізніша
//   сирота кранів; сирота, яку репарація #384 зробила рядком нового bid): рядок важить більше.
//   SQL цифр не рахує, тож назви таких рядків приходять LEFT JOIN, а порівнює nameDigits.
export interface AliasRow {
  beer_id: number;
  name: string;
  normalized_brewery: string;
  normalized_name: string;
  name_digits: string;
}

export function loadAliases(db: DB): AliasRow[] {
  const rows = db
    .prepare(
      `SELECT a.id AS alias_id, a.beer_id, a.name, a.normalized_brewery, a.normalized_name, a.name_digits,
              x.name AS holder_name
         FROM beer_aliases a
         JOIN beers b ON b.id = a.beer_id
         LEFT JOIN beers x
           ON x.normalized_brewery = a.normalized_brewery
          AND x.normalized_name = a.normalized_name
          AND x.id <> a.beer_id
        WHERE b.untappd_id IS NOT NULL
        ORDER BY a.id`,
    )
    .all() as (AliasRow & { alias_id: number; holder_name: string | null })[];
  const held = new Set(
    rows
      .filter((r) => r.holder_name !== null && nameDigits(r.holder_name) === r.name_digits)
      .map((r) => r.alias_id),
  );
  const out = new Map<number, AliasRow>();
  for (const r of rows) {
    if (held.has(r.alias_id) || out.has(r.alias_id)) continue;
    out.set(r.alias_id, {
      beer_id: r.beer_id, name: r.name,
      normalized_brewery: r.normalized_brewery, normalized_name: r.normalized_name, name_digits: r.name_digits,
    });
  }
  return [...out.values()];
}
```

- [ ] **Step 4:** `npx vitest run src/storage/schema.test.ts src/storage/beers.test.ts src/domain/pin-match.test.ts src/domain/catalog-cache.test.ts src/domain/lookup-outcome.test.ts src/api/routes/match.test.ts src/api/routes/mcp.test.ts` → PASS.

- [ ] **Step 5: Mutations** (кожну поверни)
1. `UNIQUE (…, name_digits)` → `UNIQUE (normalized_brewery, normalized_name)` у v32 → має впасти `creates beer_aliases keyed by…` (другий `insert` відмовить) і `twin cards of one shop keep one alias each` (ON CONFLICT не знайде обмеження).
2. `const source = aliasSource ?? orphan;` → `const source = orphan;` → має впасти `writes the alias from the searched text…`.
3. `nameDigits(h.name) === digits` → `true` → має впасти `is not blocked by a twin that differs only in digits`.
4. Прибери `if (!holders.some(…))` (лиши сам `INSERT`) → має впасти `writes no alias for a key another beers row already holds…`.
5. У `loadAliases` фільтр `held` → `r.holder_name !== null` (без порівняння цифр) → має впасти `keeps an alias when the pair holder is a twin with different digits`.

- [ ] **Step 6: Full gate.** Перевір файли на NUL-байти.
- [ ] **Step 7: Commit** — прості команди `git add` (усі шість файлів) і
  `git commit -m "fix(#614): key merge aliases by digits too and record the searched text"`.

---

### Task 9: ключ аліасу з цифрами в `matchBeerList`, рівність точна

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts` (блок `matchBeerList aliases (#614)`), `src/domain/catalog-cache.test.ts` (очікування юніта `#614 builds the alias index…`)

**Interfaces:**
- Consumes: `nameDigits` (Task 7), `AliasRow.name_digits` (Task 8).
- Produces: `AliasSource = { beer_id; normalized_brewery; normalized_name; name_digits }`,
  `AliasIndex = ReadonlyMap<string, number>` (ключ → `beerId`).

- [ ] **Step 1: Write the failing tests**

У `match-list.test.ts` імпорт нормалізації: `import { nameDigits, normalizeBrewery, normalizeName } from './normalize';`

У блоці `matchBeerList aliases (#614)` хелпер `alias` заміни на:

```ts
  const alias = (beerId: number, brewery: string, name: string) => ({
    beer_id: beerId,
    normalized_brewery: normalizeBrewery(brewery),
    normalized_name: normalizeName(name),
    name_digits: nameDigits(name),
  });
```

У двох тестах цифр (`a card with different digits never rides…`, `an alias without digits never
claims…`) після `expect(r.user_rating).toBeNull();` додай
`expect(r.source === 'exact' && r.matched_beer?.id === 8).toBe(false);`. У кінець блоку додай:

```ts
  it('a card with a year never rides an alias without one onto another vintage', async () => {
    const mjod: CatalogBeerWithRating[] = [
      { id: 21, brewery: 'Varvar Brew', name: 'Mjød (2021)', abv: 13, rating_global: 4.1, untappd_id: 3001 },
      { id: 23, brewery: 'Varvar Brew', name: 'Mjød (2023)', abv: 13, rating_global: 4.2, untappd_id: 3003 },
    ];
    const { prepared, byId } = prep(mjod);
    const aliases = buildAliasIndex([alias(21, 'VARVAR', 'MJØD IS')]);
    const [r] = (await matchBeerList(
      prepared, byId, new Set([21]), new Map([[21, 4.0]]),
      [{ brewery: 'VARVAR', name: 'MJØD IS 2023' }],
      { ...noYield, aliases },
    )).results;
    expect(r.is_drunk).toBe(false);
    expect(r.source === 'exact' && r.matched_beer?.id === 21).toBe(false);
  });
```

У `catalog-cache.test.ts`, юніт `#614 builds the alias index…`: очікування
`expect([...aliases.values()]).toEqual([{ beerId: 1, name: 'Atak Chmielu IPA' }]);` заміни на
`expect([...aliases.values()]).toEqual([1]);`.

- [ ] **Step 2:** `npx vitest run src/domain/match-list.test.ts src/domain/catalog-cache.test.ts` → FAIL: новий тест року (`is_drunk: true` на 21) і юніт кешу (значення індексу — об'єкт, не число).

- [ ] **Step 3: Implement** — у `match-list.ts`:

Імпорт: `import { nameDigits, normalizeBrewery, normalizeName } from './normalize';`

Блок від `/** #614: аліас із пам'яті злиття …` до кінця функції `aliasTarget` заміни на:

```ts
/** #614: аліас із пам'яті злиття — ключ картки крамниці → канонічний рядок. */
export interface AliasSource {
  beer_id: number;
  normalized_brewery: string;
  normalized_name: string;
  /** nameDigits(назва): числові токени, які normalizeName відкидає. */
  name_digits: string;
}

export type AliasIndex = ReadonlyMap<string, number>;

// Роздільник `|`, а не пробіл: нормалізовані рядки складаються з літер, цифр і пробілів, тож
// пробіл склеїв би «a b» + «c» і «a» + «b c» в один ключ.
const aliasKey = (normalizedBrewery: string, normalizedName: string, digits: string): string =>
  `${normalizedBrewery}|${normalizedName}|${digits}`;

export function buildAliasIndex(rows: readonly AliasSource[]): AliasIndex {
  return new Map(rows.map((r) => [aliasKey(r.normalized_brewery, r.normalized_name, r.name_digits), r.beer_id]));
}

// #614: ключ — ті самі normalizeBrewery/normalizeName, якими ensureBeerRow рахує пару з сирого тексту
// картки, плюс nameDigits: нормалізація відкидає цифри, а «…8» і «…10», «Mjød» і «Mjød 2023» — різні
// пива. Рівність ключа точна, жодних «сумісних» цифр. Рядок, якого немає в цьому знімку каталогу, —
// не влучання.
function aliasTarget(
  aliases: AliasIndex | undefined,
  item: MatchInput,
  byId: Map<number, CatalogBeerWithRating>,
): CatalogBeerWithRating | null {
  if (!aliases || aliases.size === 0) return null;
  const beerId = aliases.get(aliasKey(normalizeBrewery(item.brewery), normalizeName(item.name), nameDigits(item.name)));
  return beerId === undefined ? null : (byId.get(beerId) ?? null);
}
```

- [ ] **Step 4:** `npx vitest run src/domain/match-list.test.ts src/domain/catalog-cache.test.ts src/api/routes/match.test.ts src/api/routes/mcp.test.ts` → PASS.
- [ ] **Step 5: Mutations** (кожну поверни)
1. `nameDigits(item.name)` → `''` в `aliasTarget` → мають упасти тести цифр і року.
2. Прибери блок `if (viaAlias) { … }` → має впасти `a merged shop pair matches…`.
- [ ] **Step 6: Full gate.** Перевір `match-list.ts` на NUL-байти.
- [ ] **Step 7: Commit** — `git add src/domain/match-list.ts src/domain/match-list.test.ts src/domain/catalog-cache.test.ts`, потім
  `git commit -m "fix(#614): match an alias only on an exact key that includes the name digits"`.

---

### Task 10: `applyLookupOutcome` передає текст запиту в злиття

**Files:**
- Modify: `src/domain/lookup-outcome.ts` (виклик `mergeIntoCanonical`)
- Test: `src/domain/lookup-outcome.test.ts` (`describe('applyLookupOutcome merge')`)

- [ ] **Step 1: Write the failing test** — у кінець `describe('applyLookupOutcome merge', …)`:

```ts
  test('#614 records the alias from the text the caller searched, not from an orphan another card created', () => {
    const { db, log } = fresh();
    const g7 = seedBeer(db, {
      untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
      style: 'Stout', abv: 7, rating_global: 3.9,
      normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
    });
    // Сирота картки «#6»; ensureBeerRow цифр не бачить і віддає її запиту картки «#7».
    const orphanId = seedBeer(db, {
      name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
      normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
    });

    const kind = applyLookupOutcome(
      { db, log }, orphanId,
      { kind: 'matched', result: cand({ bid: 4007 }) },
      '2026-09-14T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7' },
    );

    expect(kind).toBe('merged');
    expect(db.prepare('SELECT beer_id, name, name_digits FROM beer_aliases').all())
      .toEqual([{ beer_id: g7, name: 'Ґвара #7', name_digits: '7' }]);
    db.close();
  });
```

- [ ] **Step 2:** `npx vitest run src/domain/lookup-outcome.test.ts -t "#614"` → FAIL (аліас `Ґвара #6`, digits `6`).
- [ ] **Step 3: Implement** — у `lookup-outcome.ts`
  `mergeIntoCanonical(deps.db, beerId, canonical.id, nowIso);` →
  `mergeIntoCanonical(deps.db, beerId, canonical.id, nowIso, input);` і над ним коментар:

```ts
          // #614: input — текст, який шукав цей виклик; аліас пам'яті злиття пишеться з нього, а не з
          // рядка-сироти, який могла створити інша картка з тією самою парою без цифр.
```

- [ ] **Step 4:** `npx vitest run src/domain/lookup-outcome.test.ts src/api/routes/enrich.test.ts` → PASS.
- [ ] **Step 5: Mutation** — прибери `, input` → тест `#614` падає. Поверни.
- [ ] **Step 6: Full gate.**
- [ ] **Step 7: Commit** — `git add src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts`, потім
  `git commit -m "fix(#614): merge aliases record the text the lookup searched"`.

---

## Після ядра

1. **Реплей сценаріїв A–C** рецензента (`scratchpad/probe.mts`, оновлений під нові сигнатури: у C
   злиття з `aliasSource` картки «#7») — очікування: A — аліаси «8» і «10» поруч, картка 8 ✅ після
   злиття 10; B — `MJØD IS 2023` не `exact`; C — «#6» не `exact`, «#7» `exact` ✅.
2. **Третє наскрізне рев'ю ядра**, окремий диспатч; назвати задачі 2–10 і коміти; попросити спробувати
   зламати ключ і джерело аліасу.
3. **Лише після рев'ю** — план периферії.

## Самоперевірка плану проти спеки

| Розділ спеки | Де в плані |
|---|---|
| `name_digits` у ключі й унікальності | Task 7, Task 8 (a) |
| Текст аліасу = `aliasSource` / текст сироти | Task 8 (b), Task 10 |
| «Ключ тримає інший рядок» — пара й цифри (запис) | Task 8, тести 5 |
| «Рядок важить більше» з цифрами (читання) | Task 8, `loadAliases` |
| Близнюки однієї крамниці — окремі аліаси | Task 8, `twin cards of one shop…` |
| Точна рівність ключа з цифрами в `/match` | Task 9 |
| Злиття без перенесення; відкидання при зміні bid; `pinMatch`; `/match` і MCP | задачі 2, 3, 6 (зроблено) |
| `ensureBeerRow` з цифрами, `/enrich/*`, репарація #384, API-тест, `spec.md` | **периферія** |
