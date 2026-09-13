# Ідентичність пива за bid — план ядра (#617)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** додати дві функції сховища — `upsertBeerByBid` (ідентичність за Untappd bid, лише
заповнення фактів, провенанс лише вгору, резолвлення сироти за парою + числовими токенами) і
`ensureOrphan` (рядок без bid, ніколи не чіпає злінкований рядок) — разом із предикатом
сумісності числових токенів назви.

**Architecture:** це **ядро** стадійної зміни (правило CLAUDE.md «план на ядро → рев'ю → окремий
план на обв'язку»). Ядро лише **додає** функції з тестами; жоден викликач не змінюється, старий
`upsertBeer` лишається як є. Переведення викликачів (синк чекінів, `/import`, `refresh-untappd`,
`refresh-ontap`, `ensureBeerRow`), тестовий хелпер `seedBeer`, страж імпорту і `spec.md` —
окремий план, який пишеться **після** наскрізного рев'ю ядра.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest 4 (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-617-upsert-by-bid-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською** — як у решті репо.
- **Повний гейт після КОЖНОЇ задачі**, ніколи не звужений до своїх файлів:
  `npm test && npm run typecheck`. Розширення (`extension/`) ця зміна не зачіпає.
- **Кожен тест мутаційно доведений**: у кроці «мутація» прибери/зміни названий рядок реалізації —
  тест має впасти; поверни рядок. Тест, що лишається зеленим без реалізації, у мердж не йде.
- **Сіди з видимими значеннями**, не `null`: `null`-сід робить «проігноровано» і «використано»
  однаковими (пам'ять `feedback_stub_defaults_hide_mutations`).
- **Ніяких `as unknown as` кастів.**
- **Старий `upsertBeer` і всі його викликачі в ядрі не змінюються.**
- **Код важить більше за цей план**: якщо сигнатура, імпорт чи назва в репо розходиться з текстом
  плану — іди за кодом і назви розбіжність у звіті задачі.
- Робота йде у worktree від `origin/main`; спершу `git cherry-pick` коміту спеки та цього плану з
  локального `main` (пам'ять `reference_worktree_docs_cherrypick`).
- Обидві задачі дрібні за правилом CLAUDE.md (повний код у тексті, ≤2 файли + тести, без нових
  рішень) → контролер виконує їх **інлайн**; обидві обов'язково називаються в диспатчі
  наскрізного рев'ю ядра.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `src/domain/normalize.ts` (зміна) | `numericNameTokens`, `numericTokensCompatible` — цифрові токени, які `normalizeName` відкидає як шум, і правило їх рівності |
| `src/domain/normalize.test.ts` (зміна) | юніт-тести на виміряні випадки зі спеки |
| `src/storage/beers.ts` (зміна) | `upsertBeerByBid`, `ensureOrphan`, приватні `strongerSource`, `resolvableOrphan` |
| `src/storage/beers.test.ts` (зміна) | тести обох функцій |

---

### Task 1: сумісність числових токенів назви

**Files:**
- Modify: `src/domain/normalize.ts` (додати після `normalizeName`)
- Test: `src/domain/normalize.test.ts` (додати в кінець; розширити імпорт у рядку 1)

**Interfaces:**
- Consumes: приватні `baseNormalize`, `preserveDecimalIdentifiers`, експортований `stripSearchNoise` з того самого модуля.
- Produces:
  - `export function numericNameTokens(s: string): string[]`
  - `export function numericTokensCompatible(a: string, b: string): boolean`

- [ ] **Step 1: Написати тести, що падають**

Додати в імпорт рядка 1 `src/domain/normalize.test.ts` імена `numericNameTokens, numericTokensCompatible`, а в кінець файлу:

```ts
describe('numericNameTokens (#617)', () => {
  test('keeps pure-digit tokens that normalizeName drops as noise', () => {
    expect(numericNameTokens('Juicy Trap #19 18°')).toEqual(['19']);
    expect(numericNameTokens('Trappistes Rochefort 10 (2015)')).toEqual(['10', '2015']);
  });

  test('spec strings are not tokens: degrees and ABV are stripped first', () => {
    expect(numericNameTokens('Kronenbourg 1664 Blanc 12,5°')).toEqual(['1664']);
    expect(numericNameTokens('La Chouffe 0.4%')).toEqual([]);
  });

  test('a decimal identifier is one non-digit token, not two digit tokens', () => {
    expect(numericNameTokens('Ambrosia 10.0 18°')).toEqual([]);
  });
});

describe('numericTokensCompatible (#617)', () => {
  test.each([
    // виміряні хибні пари зі спеки — мусять розрізнятися
    ['Juicy Trap #19 18°', 'Juicy Trap #20', false],
    ['Trappistes Rochefort 8', 'Trappistes Rochefort 10', false],
    ['Grodziskie Piwobraniowe 2024', 'Piwobranie 2026: Suska sechlońska i cascara', false],
    ['Trappistes Rochefort 10 (2015)', 'Trappistes Rochefort 10 (2017)', false],
    ['Svijanský Máz 11', 'Svijanský Máz', false],
    // однакові пива — мусять збігатися
    ['Kronenbourg 1664 Blanc 12,5°', '1664 Blanc', true],
    ['AMBROSIA 10.0 18°', 'Ambrosia 10.0', true],
    ['Juicy Trap #20 18°', 'Juicy Trap #20', true],
    // рік лише в одній назві — сумісно, як у матчері (extractYear)
    ['Krzyż Południa 13°', 'Krzyż Południa (2026)', true],
    ['ROTATION 12°', 'Rotation (2026)', true],
    // відоме обмеження зі спеки: різниця лише в ABV не видима, бо stripSearchNoise прибирає ABV
    ['La Chouffe 16°', 'La Chouffe 0.4%', true],
  ])('%s ↔ %s → %s', (a, b, expected) => {
    expect(numericTokensCompatible(a, b)).toBe(expected);
    expect(numericTokensCompatible(b, a)).toBe(expected);
  });
});
```

- [ ] **Step 2: Переконатися, що тести падають**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: FAIL — `numericNameTokens is not a function` / не експортовано.

- [ ] **Step 3: Реалізація**

У `src/domain/normalize.ts` одразу після функції `normalizeName` додати:

```ts
// #617: цифрові токени, які normalizeName відкидає як шум. Дві назви з рівною нормалізованою
// формою можуть бути різними пивами (Rochefort 8 / 10, Juicy Trap #19 / #20) — і різняться
// вони саме тут. Той самий конвеєр, що в normalizeName, тож специфікація (12,5°, 0,5%) уже
// прибрана stripSearchNoise, а десятковий ідентифікатор (10.0) лишається одним нецифровим токеном.
export function numericNameTokens(s: string): string[] {
  return baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))
    .split(' ')
    .filter((t) => /^\d+$/.test(t));
}

const YEAR_TOKEN = /^(?:19|20)\d{2}$/;

// #617: чи можуть дві назви з рівною нормалізованою формою бути одним пивом. Роки порівнюються
// лише коли рік є в обох — те саме правило, що в матчері (кандидат без року сумісний з будь-яким
// роком). Решта цифрових токенів мусить збігатися як мультимножина.
export function numericTokensCompatible(a: string, b: string): boolean {
  const ta = numericNameTokens(a);
  const tb = numericNameTokens(b);
  const years = (ts: string[]) => ts.filter((t) => YEAR_TOKEN.test(t)).sort().join(' ');
  const rest = (ts: string[]) => ts.filter((t) => !YEAR_TOKEN.test(t)).sort().join(' ');
  const ya = years(ta);
  const yb = years(tb);
  if (ya !== '' && yb !== '' && ya !== yb) return false;
  return rest(ta) === rest(tb);
}
```

- [ ] **Step 4: Переконатися, що тести проходять**

Run: `npx vitest run src/domain/normalize.test.ts`
Expected: PASS. Якщо котрийсь очікуваний масив токенів у Step 1 розходиться з фактичним виводом
(наприклад, порядок), — спершу перевір, чи розбіжність не змінює висновку `numericTokensCompatible`
для виміряних пар; змінюй **тест**, лише якщо вивід пояснюється конвеєром, і назви це у звіті.

- [ ] **Step 5: Мутації**

1. У `numericTokensCompatible` заміни `if (ya !== '' && yb !== '' && ya !== yb)` на `if (ya !== yb)` → мусять впасти випадки `Krzyż Południa` і `ROTATION`. Поверни.
2. Прибери рядок `if (ya !== '' && yb !== '' && ya !== yb) return false;` → мусять впасти `2024/2026` і `(2015)/(2017)`. Поверни.
3. У `numericNameTokens` прибери `stripSearchNoise(` … `)` (лиши `baseNormalize(preserveDecimalIdentifiers(s))`) → мусять впасти `Kronenbourg` і `Juicy Trap #20 18°`. Поверни.

Run після кожної: `npx vitest run src/domain/normalize.test.ts`

- [ ] **Step 6: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 7: Commit**

```bash
git add src/domain/normalize.ts src/domain/normalize.test.ts
git commit -m "feat(#617): numericTokensCompatible — цифрові токени, які normalizeName відкидає

Rochefort 8/10 і Juicy Trap #19/#20 мають рівну нормалізовану назву; різняться
вони лише цифрами. Рік порівнюється, коли він є в обох назвах (як у матчері)."
```

---

### Task 2: `upsertBeerByBid` і `ensureOrphan`

**Files:**
- Modify: `src/storage/beers.ts` (додати після `upsertBeer`; імпорт `numericTokensCompatible`)
- Test: `src/storage/beers.test.ts` (новий `describe` у кінці; розширити імпорти)

**Interfaces:**
- Consumes: `numericTokensCompatible(a: string, b: string): boolean` з Task 1 (`src/domain/normalize.ts`); наявні `bumpCatalogVersion`, `UntappdIdSource`.
- Produces:
  - `export interface BidBeerInput { untappd_id: number; name: string; brewery: string; style?: string | null; abv?: number | null; rating_global?: number | null; normalized_name: string; normalized_brewery: string; untappd_id_source: UntappdIdSource }`
  - `export function upsertBeerByBid(db: DB, b: BidBeerInput): number` — повертає `beers.id`
  - `export interface OrphanBeerInput { name: string; brewery: string; style?: string | null; abv?: number | null; rating_global?: number | null; normalized_name: string; normalized_brewery: string }`
  - `export function ensureOrphan(db: DB, b: OrphanBeerInput): number` — повертає `beers.id`

- [ ] **Step 1: Написати тести, що падають**

У `src/storage/beers.test.ts` додати до імпорту з `'./beers'` імена `upsertBeerByBid, ensureOrphan, getBeer` (ті, яких там ще немає — `getBeer` може вже імпортуватися нижче у файлі; дубль імпорту не додавати), а також `import { catalogVersion } from './catalog-version';` якщо його немає. У кінець файлу:

```ts
describe('upsertBeerByBid (#617)', () => {
  const ROCHEFORT = 'Abbaye Notre-Dame de Saint-Rémy';
  const PP = 'Piwne Podziemie';

  function bidInput(
    bid: number, name: string, brewery: string,
    extra: Partial<Parameters<typeof upsertBeerByBid>[1]> = {},
  ) {
    return {
      untappd_id: bid, name, brewery,
      normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
      untappd_id_source: 'checkin' as const,
      ...extra,
    };
  }

  // Сирота напряму, в обхід upsertBeer: той зливає дві сироти з однаковою нормалізованою парою.
  function insertOrphanRaw(db: ReturnType<typeof fresh>, name: string, brewery: string, abv: number): number {
    const res = db.prepare(
      `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global, normalized_name, normalized_brewery)
       VALUES (NULL, ?, ?, 'Sour', ?, NULL, ?, ?)`,
    ).run(name, brewery, abv, normalizeName(name), normalizeBrewery(brewery));
    return Number(res.lastInsertRowid);
  }

  test('fills only empty facts on the row found by bid', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: null, abv: 9.2, rating_global: null,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    const got = upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, {
      style: 'Belgian Quadrupel', abv: 5.0, rating_global: 3.95,
    }));
    expect(got).toBe(id);
    const row = getBeer(db, id)!;
    expect(row.style).toBe('Belgian Quadrupel');   // було порожнє → заповнено
    expect(row.abv).toBeCloseTo(9.2);               // було 9.2 → не перезаписано
    expect(row.rating_global).toBeCloseTo(3.95);    // було порожнє → заповнено
  });

  test('empty input never wipes stored facts (the sync wipe)', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Belgian Strong Dark Ale', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, {
      style: null, abv: null, rating_global: null,
    }));
    const row = getBeer(db, id)!;
    expect(row.style).toBe('Belgian Strong Dark Ale');
    expect(row.abv).toBeCloseTo(9.2);
    expect(row.rating_global).toBeCloseTo(3.95);
  });

  test('never renames the row found by bid (#618 owns Untappd names)', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 6700001, name: "Don't Shoot", brewery: 'Inne Beczki Brewery',
      style: 'IPA', abv: 5.8, rating_global: 3.8,
      normalized_name: normalizeName("Don't Shoot"), normalized_brewery: normalizeBrewery('Inne Beczki Brewery'),
      untappd_id_source: 'search',
    });
    upsertBeerByBid(db, bidInput(6700001, "HopGang: Don't Shoot", 'Inne Beczki'));
    const row = getBeer(db, id)!;
    expect(row.name).toBe("Don't Shoot");
    expect(row.brewery).toBe('Inne Beczki Brewery');
    expect(row.normalized_name).toBe(normalizeName("Don't Shoot"));
  });

  test.each([
    ['search', 'checkin', 'checkin'],
    ['bid', 'checkin', 'checkin'],
    ['checkin', 'bid', 'checkin'],
    ['curated', 'checkin', 'curated'],
    ['curated', 'bid', 'curated'],
  ] as const)('provenance only strengthens: stored %s + incoming %s → %s', (stored, incoming, expected) => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Quad', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: stored,
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, { untappd_id_source: incoming }));
    expect(getBeer(db, id)!.untappd_id_source).toBe(expected);
  });

  test('a row with no provenance takes the incoming one', () => {
    const db = fresh();
    const id = upsertBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Quad', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
    });
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, { untappd_id_source: 'bid' }));
    expect(getBeer(db, id)!.untappd_id_source).toBe('bid');
  });

  test('a vintage twin with another bid is never touched: a new row is inserted', () => {
    const db = fresh();
    const eight = upsertBeer(db, {
      untappd_id: 1001, name: 'Trappistes Rochefort 8', brewery: ROCHEFORT,
      style: 'Belgian Strong Dark Ale', abv: 9.2, rating_global: 3.95,
      normalized_name: normalizeName('Trappistes Rochefort 8'), normalized_brewery: normalizeBrewery(ROCHEFORT),
      untappd_id_source: 'search',
    });
    const ten = upsertBeerByBid(db, bidInput(2002, 'Trappistes Rochefort 10', ROCHEFORT));
    expect(ten).not.toBe(eight);
    const e = getBeer(db, eight)!;
    expect(e.untappd_id).toBe(1001);
    expect(e.name).toBe('Trappistes Rochefort 8');
    expect(e.abv).toBeCloseTo(9.2);
    expect(e.rating_global).toBeCloseTo(3.95);
    expect(e.untappd_id_source).toBe('search');
    const t = getBeer(db, ten)!;
    expect(t.untappd_id).toBe(2002);
    expect(t.name).toBe('Trappistes Rochefort 10');
    expect(t.untappd_id_source).toBe('checkin');
  });

  // Числа тут однакові, тож numericTokensCompatible злінкований рядок не відсіє — від перехоплення
  // його береже лише умова `untappd_id IS NULL` у resolvableOrphan. Тест «vintage twin» вище цю
  // умову не ловить: там 8 ≠ 10 і фільтр чисел відсіює рядок сам.
  test('a linked row with the same name and numbers but another bid is never taken over', () => {
    const db = fresh();
    const linked = upsertBeer(db, {
      untappd_id: 111, name: 'Juicy Trap #20', brewery: PP,
      style: 'Sour', abv: 6.5, rating_global: 3.9,
      normalized_name: normalizeName('Juicy Trap #20'), normalized_brewery: normalizeBrewery(PP),
      untappd_id_source: 'search',
    });
    const got = upsertBeerByBid(db, bidInput(222, 'Juicy Trap #20', PP));
    expect(got).not.toBe(linked);
    expect(getBeer(db, linked)!.untappd_id).toBe(111);
    expect(getBeer(db, got)!.untappd_id).toBe(222);
  });

  test('resolves the one orphan with the same pair and compatible numeric tokens', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Juicy Trap #20', PP, 6.5);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP, { rating_global: 4.1 }));
    expect(got).toBe(orphan);
    const row = getBeer(db, orphan)!;
    expect(row.untappd_id).toBe(6625206);
    expect(row.untappd_id_source).toBe('checkin');
    expect(row.abv).toBeCloseTo(6.5);
    expect(row.rating_global).toBeCloseTo(4.1);
  });

  test('an orphan whose numbers differ is not resolved', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Juicy Trap #19', PP, 6.5);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP));
    expect(got).not.toBe(orphan);
    expect(getBeer(db, orphan)!.untappd_id).toBeNull();
  });

  test('a year on one side only still resolves the orphan', () => {
    const db = fresh();
    const orphan = insertOrphanRaw(db, 'Krzyż Południa', 'Ziemia Obiecana', 5.5);
    const got = upsertBeerByBid(db, bidInput(6800001, 'Krzyż Południa (2026)', 'Ziemia Obiecana'));
    expect(got).toBe(orphan);
    expect(getBeer(db, orphan)!.untappd_id).toBe(6800001);
  });

  test('two compatible orphans are ambiguous: neither is resolved, a new row is inserted', () => {
    const db = fresh();
    const a = insertOrphanRaw(db, 'Juicy Trap #20', PP, 6.5);
    const b = insertOrphanRaw(db, 'Juicy Trap #20 18°', PP, 6.6);
    const got = upsertBeerByBid(db, bidInput(6625206, 'Juicy Trap #20', PP));
    expect(got).not.toBe(a);
    expect(got).not.toBe(b);
    expect(getBeer(db, a)!.untappd_id).toBeNull();
    expect(getBeer(db, b)!.untappd_id).toBeNull();
    expect(getBeer(db, got)!.untappd_id).toBe(6625206);
  });

  test('bumps the catalog version on insert and on update', () => {
    const db = fresh();
    let v = catalogVersion();
    const id = upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT));
    expect(catalogVersion()).toBeGreaterThan(v);
    v = catalogVersion();
    upsertBeerByBid(db, bidInput(1001, 'Trappistes Rochefort 8', ROCHEFORT, { abv: 9.2 }));
    expect(catalogVersion()).toBeGreaterThan(v);
    expect(getBeer(db, id)!.abv).toBeCloseTo(9.2);
  });
});

describe('ensureOrphan (#617)', () => {
  const MONSTERS = 'Monsters Brewery';

  test('inserts a new orphan beside a linked vintage with the same normalized name', () => {
    const db = fresh();
    const linked = upsertBeer(db, {
      untappd_id: 6300175, name: 'O Tiole Mio! 2026 15°', brewery: MONSTERS,
      style: 'Pastry Sour', abv: 6.0, rating_global: 3.7,
      normalized_name: normalizeName('O Tiole Mio! 2026 15°'), normalized_brewery: normalizeBrewery(MONSTERS),
      untappd_id_source: 'search',
    });
    const got = ensureOrphan(db, {
      name: 'O tiole mio! 2025', brewery: MONSTERS, style: null, abv: 6.5, rating_global: null,
      normalized_name: normalizeName('O tiole mio! 2025'), normalized_brewery: normalizeBrewery(MONSTERS),
    });
    expect(got).not.toBe(linked);
    const l = getBeer(db, linked)!;
    expect(l.name).toBe('O Tiole Mio! 2026 15°');
    expect(l.untappd_id).toBe(6300175);
    expect(l.style).toBe('Pastry Sour');
    expect(l.rating_global).toBeCloseTo(3.7);
    const o = getBeer(db, got)!;
    expect(o.untappd_id).toBeNull();
    expect(o.untappd_id_source).toBeNull();
    expect(o.abv).toBeCloseTo(6.5);
  });

  test('returns an existing orphan with the same pair without overwriting it', () => {
    const db = fresh();
    const first = ensureOrphan(db, {
      name: 'Łan', brewery: 'Sadyba Brewery', style: 'Pszeniczne', abv: 4.8, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    });
    const again = ensureOrphan(db, {
      name: 'Łan 12°', brewery: 'Sadyba Brewery', style: null, abv: 5.5, rating_global: null,
      normalized_name: normalizeName('Łan 12°'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    });
    expect(again).toBe(first);
    const row = getBeer(db, first)!;
    expect(row.name).toBe('Łan');
    expect(row.style).toBe('Pszeniczne');
    expect(row.abv).toBeCloseTo(4.8);
  });

  test('bumps the catalog version only when it inserts', () => {
    const db = fresh();
    const input = {
      name: 'Łan', brewery: 'Sadyba Brewery', style: 'Pszeniczne', abv: 4.8, rating_global: null,
      normalized_name: normalizeName('Łan'), normalized_brewery: normalizeBrewery('Sadyba Brewery'),
    };
    let v = catalogVersion();
    ensureOrphan(db, input);
    expect(catalogVersion()).toBeGreaterThan(v);
    v = catalogVersion();
    ensureOrphan(db, input);
    expect(catalogVersion()).toBe(v);
  });
});
```

- [ ] **Step 2: Переконатися, що тести падають**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: FAIL — `upsertBeerByBid` / `ensureOrphan` не експортовано.

- [ ] **Step 3: Реалізація**

У `src/storage/beers.ts` додати до імпортів на початку файлу:

```ts
import { numericTokensCompatible } from '../domain/normalize';
```

і одразу після функції `upsertBeer` додати:

```ts
// #617: провенанс лінка лише посилюється. 'curated' — рішення людини, 'checkin' — власний запис
// Untappd, 'bid' — опублікований крамницею, 'search' — наше вгадування. Поточний upsertBeer робив
// COALESCE(нове, старе) і так понижував пін до 'checkin'.
const SOURCE_RANK: Record<UntappdIdSource, number> = { search: 1, bid: 2, checkin: 3, curated: 4 };

function strongerSource(stored: UntappdIdSource | null, incoming: UntappdIdSource): UntappdIdSource {
  if (stored === null) return incoming;
  return SOURCE_RANK[incoming] > SOURCE_RANK[stored] ? incoming : stored;
}

export interface BidBeerInput {
  untappd_id: number;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
  untappd_id_source: UntappdIdSource;
}

// #617: сирота, яку можна резолвити цим bid — рівно одна з тією самою нормалізованою парою і
// сумісними цифровими токенами назви. normalizeName викидає цифри, тож без другої умови чекін
// «Rochefort 10» віддав би bid сироті «Rochefort 8». Двозначність не вирішується вгадуванням.
function resolvableOrphan(db: DB, b: BidBeerInput): { id: number; untappd_id_source: UntappdIdSource | null } | null {
  const orphans = db
    .prepare(
      `SELECT id, name, untappd_id_source FROM beers
        WHERE untappd_id IS NULL AND normalized_brewery = ? AND normalized_name = ?`,
    )
    .all(b.normalized_brewery, b.normalized_name) as {
      id: number; name: string; untappd_id_source: UntappdIdSource | null;
    }[];
  const compatible = orphans.filter((o) => numericTokensCompatible(o.name, b.name));
  return compatible.length === 1 ? compatible[0] : null;
}

// #617: ідентичність за Untappd bid — для синку чекінів, /import і refresh-untappd.
// Рядок шукається за bid; не знайдено — серед сиріт (resolvableOrphan); інакше новий рядок.
// Злінкованого рядка з іншим bid не торкається ніколи. Факти лише заповнюють порожнє, назва й
// броварня не змінюються (#618), провенанс лише посилюється.
export function upsertBeerByBid(db: DB, b: BidBeerInput): number {
  const byBid = db
    .prepare('SELECT id, untappd_id_source FROM beers WHERE untappd_id = ?')
    .get(b.untappd_id) as { id: number; untappd_id_source: UntappdIdSource | null } | undefined;
  const target = byBid ?? resolvableOrphan(db, b);

  if (target) {
    db.prepare(
      `UPDATE beers SET
         untappd_id = ?,
         style = COALESCE(style, ?),
         abv = COALESCE(abv, ?),
         rating_global = COALESCE(rating_global, ?),
         untappd_id_source = ?
       WHERE id = ?`,
    ).run(
      b.untappd_id, b.style ?? null, b.abv ?? null, b.rating_global ?? null,
      strongerSource(target.untappd_id_source, b.untappd_id_source), target.id,
    );
    bumpCatalogVersion();
    return target.id;
  }

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery, untappd_id_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.untappd_id, b.name, b.brewery, b.style ?? null, b.abv ?? null, b.rating_global ?? null,
    b.normalized_name, b.normalized_brewery, b.untappd_id_source,
  );
  bumpCatalogVersion();
  return Number(res.lastInsertRowid);
}

export interface OrphanBeerInput {
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
}

// #617: рядок без bid — для гілки сироти refresh-ontap і рядків /import без bid. Шукає лише серед
// сиріт; знайдену повертає без перезапису. Злінкованого рядка не торкається ніколи: сирота поряд
// зі злінкованим вінтажем тієї ж назви — нормальний стан (UNIQUE лише на untappd_id).
// Відоме обмеження: сироти з однаковою нормалізованою назвою злипаються — як і до #617.
export function ensureOrphan(db: DB, b: OrphanBeerInput): number {
  const existing = db
    .prepare(
      `SELECT id FROM beers
        WHERE untappd_id IS NULL AND normalized_brewery = ? AND normalized_name = ?
        ORDER BY id LIMIT 1`,
    )
    .get(b.normalized_brewery, b.normalized_name) as { id: number } | undefined;
  if (existing) return existing.id;

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.name, b.brewery, b.style ?? null, b.abv ?? null, b.rating_global ?? null,
    b.normalized_name, b.normalized_brewery,
  );
  bumpCatalogVersion();
  return Number(res.lastInsertRowid);
}
```

- [ ] **Step 4: Переконатися, що тести проходять**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: PASS.

- [ ] **Step 5: Мутації** (після кожної — `npx vitest run src/storage/beers.test.ts`, тест мусить впасти; потім поверни)

1. `style = COALESCE(style, ?)` → `style = COALESCE(?, style)` (те саме для `abv`) → падає «fills only empty facts» (abv стає 5.0).
2. `abv = COALESCE(abv, ?)` → `abv = ?` → падає «empty input never wipes stored facts».
3. `const target = byBid ?? resolvableOrphan(db, b);` → `const target = byBid;` → падають «resolves the one orphan…» і «a year on one side…».
4. У `resolvableOrphan` прибери `.filter((o) => numericTokensCompatible(o.name, b.name))` (лиши `orphans`) → падає «an orphan whose numbers differ…».
5. `compatible.length === 1 ? compatible[0] : null` → `compatible[0] ?? null` → падає «two compatible orphans are ambiguous…».
6. У `resolvableOrphan` прибери `untappd_id IS NULL AND` → падає «a linked row with the same name and numbers but another bid is never taken over» (**не** «vintage twin»: там 8 ≠ 10, і рядок відсіює фільтр чисел, тож той тест цю мутацію не ловить).
7. `strongerSource`: заміни тіло на `return incoming;` → падають рядки таблиці провенансу з `curated` і `checkin → bid`.
8. В `ensureOrphan` прибери `untappd_id IS NULL AND` → падає «inserts a new orphan beside a linked vintage…».
9. В `ensureOrphan` прибери перший `bumpCatalogVersion();` (на вставці) → падає «bumps the catalog version only when it inserts».

- [ ] **Step 6: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: усе зелене (старий `upsertBeer` і його тести не змінювались).

- [ ] **Step 7: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#617): upsertBeerByBid і ensureOrphan — ідентичність за bid без фолбеку на злінковані рядки

upsertBeer шукав рядок за нормалізованою назвою й перезаписував bid вінтаж-близнюка
та стирав рейтинг/стиль/ABV. Нові функції: за bid лише заповнюють факти, не
перейменовують, провенанс лише вгору; сирота резолвиться лише коли вона одна й
цифрові токени назви сумісні; ensureOrphan злінкованих рядків не торкається."
```

---

## Результат наскрізного рев'ю ядра (2026-09-13)

Ядро виконано інлайн (коміти Task 1 і Task 2), обидві задачі передано рецензенту. Блокерів немає;
знахідки, перевірені по коду, і що з ними зроблено:

- **Резолвлена сирота навічно лишала ABV/стиль крана** — `COALESCE(старе, нове)` у гілці сироти
  суперечив `spec.md` §`/newbeers` («авторитетний Untappd-ABV переважає») і `recordLookupSuccess`.
  Виправлено: гілка сироти — `COALESCE(нове, старе)`; гілка за bid лишилась «лише заповнення».
- **Резолвлена сирота лишала `enrich_failures`** — `listUntriagedFailures`/`listLockedRows` не
  фільтрують `untappd_id IS NULL`, тож тріажили б злінковане пиво. Виправлено: `DELETE` у гілці
  сироти, як `pin-match`/`clearEnrichFailure`; пошук і запис — одна транзакція.
- **13 мутацій, що виживали** (порядок COALESCE для style/rating — мутація 1 цього плану зв'язувала
  дві колонки, і ловилась лише abv; фільтр броварні в обох функціях; факти й `normalized_*` вставки;
  ранг `search`/`bid`; `YEAR_TOKEN`; обидва `.sort()`; `ORDER BY id`) — додано тести, кожна мутація
  прогнана й падає рівно на своєму тесті.
- **Формулювання спеки** — роки порівнюються набором (не першим роком, як `extractYear`); цифри в
  некомпактних дужках невидимі; число, схоже на рік, — рік. Дописано як відомі обмеження й закріплено
  тестами.
- **Відкрите для обв'язки** — чи заповнює `ensureOrphan` порожні факти наявної сироти з крана (старий
  `refresh-ontap` переписував їх на кожному інжесті); записано в спеку.

## Після ядра

1. Наскрізне рев'ю ядра (обидві задачі названі в диспатчі, бо виконані інлайн): спека ↔ код,
   мутації, чи не з'явилося речення, яке спека не покриває.
2. **Лише після рев'ю** — окремий план обв'язки `docs/superpowers/plans/2026-09/2026-09-13-617-upsert-by-bid-wiring.md`:
   переведення синку чекінів, `/import`, `refresh-untappd` (пошук за bid), `refresh-ontap` (гілка
   сироти → `ensureOrphan`), `ensureBeerRow` (пряма вставка); `seedBeer` + страж імпорту
   `upsertBeer`; переписування тестів, що закріплюють стару поведінку; `spec.md`.
