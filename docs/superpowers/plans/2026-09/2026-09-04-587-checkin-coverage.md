# Покриття чекінів як об'єднання доведених діапазонів — план імплементації (#587)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** замінити скалярний `deepest_max_id` на покриття у вигляді об'єднання діапазонів,
які доводить сама сторінка фіду, щоб діра всередині історії не могла вижити.

**Architecture:** сервер тримає `checkin_coverage(telegram_id, from_id, to_id)` і на кожну
прийняту сторінку зливає її доведений діапазон у це об'єднання; він же рахує, куди клієнту
йти далі (`nextCursor`), стрибаючи через покриту територію. Клієнт згортається з двох фаз в
один цикл «фетч → POST → іди за `nextCursor`». Галочку «повністю синхронізовано» дає
порівняння лічильників, бо дно стрічки недоказове.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Hono, Vitest 4 (корінь і
`extension/` — дві окремі збірки й два окремі прогони), Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-04-587-checkin-coverage-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською** — як у решті репо.
- **Повний гейт після КОЖНОЇ задачі**, обидві збірки, ніколи не звужений до своїх файлів:
  `npm test && npm run typecheck` **і** `npm --prefix extension test && npm --prefix extension run typecheck`.
- **Кожен тест мутаційно доведений**: прибери рядок реалізації, який він нібито покриває, —
  тест має впасти. Тест, що лишається зеленим без реалізації, у мердж не йде.
- **`checkin_id` порівнюються як INTEGER** (`CAST(checkin_id AS INTEGER)`), бо в `checkins`
  колонка TEXT, а порядок нам потрібен числовий.
- **`complete` більше не пишеться нікуди.** Колонка лишається в схемі, читається лише як
  застаріла. Ніяка нова логіка на неї не спирається.
- **Ніяких `as unknown as` кастів** — вони ховають рівно ті розбіжності типів, які ми ловимо.
- `/status` не чіпати: він рахує за лічильниками ще з #190.
- Номер міграції — **29**, якщо на момент старту він вільний (`src/storage/schema.ts`,
  остання наявна — 28); якщо ні, брати наступний вільний і виправити номер у всіх згадках.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `src/storage/checkin_coverage.ts` (новий) | арифметика покриття: злиття діапазону, пошук діапазону, що містить id, найглибший id |
| `src/storage/schema.ts` (зміна) | міграція 29: таблиця + сидування |
| `src/storage/checkins.ts` (зміна) | `oldestCheckinId` — межа, за якою порожня відповідь стає доказом зламаної сесії |
| `src/storage/checkin_sync_state.ts` (зміна) | лишається носієм `profile_total`; `deepest_max_id` стає похідним від покриття |
| `src/api/routes/checkins.ts` (зміна) | запис діапазону сторінки, `nextCursor`, `422 no_session` |
| `src/bot/commands/import.ts` (зміна) | імпорт сидує свій діапазон |
| `extension/src/background/handle-checkin-sync.ts` (зміна) | дві фази → один цикл за `nextCursor` |
| `extension/src/api/{types,client}.ts` (зміна) | `nextCursor` у відповіді, код помилки `no_session` |
| `extension/src/popup/popup.ts` (зміна) | галочка за лічильниками, текст для `no_session` |

---

### Task 1: `checkin_coverage` — таблиця, міграція, арифметика злиття

**Files:**
- Create: `src/storage/checkin_coverage.ts`
- Create: `src/storage/checkin_coverage.test.ts`
- Modify: `src/storage/schema.ts` (додати запис міграції 29 у кінець масиву, після `version: 28`)
- Modify: `src/storage/checkins.ts` (додати `oldestCheckinId`)
- Modify: `src/storage/checkins.test.ts` (тест на `oldestCheckinId`)

**Interfaces:**
- Consumes: `DB` з `./db`, `migrate` з `./schema`.
- Produces:
  - `interface CoverageRange { from_id: number; to_id: number }`
  - `coverageFor(db: DB, telegramId: number): CoverageRange[]` — за спаданням `from_id`
  - `addCoverage(db: DB, telegramId: number, from: number, to: number): void`
  - `rangeContaining(db: DB, telegramId: number, id: number): CoverageRange | null`
  - `deepestCoveredId(db: DB, telegramId: number): number | null`
  - `oldestCheckinId(db: DB, telegramId: number): number | null` (у `checkins.ts`)

- [ ] **Крок 1: написати падаючий тест на арифметику злиття**

Створи `src/storage/checkin_coverage.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { addCoverage, coverageFor, rangeContaining, deepestCoveredId } from './checkin_coverage';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
});

describe('addCoverage', () => {
  it('keeps disjoint ranges apart', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 500, 600);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 500, to_id: 600 }, { from_id: 100, to_id: 200 }]);
  });

  it('merges an overlapping range', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 150, 300);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  it('merges ranges that only touch at one id (consecutive feed pages)', () => {
    addCoverage(db, 1, 200, 300);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  it('merges ranges separated by no integer at all', () => {
    addCoverage(db, 1, 201, 300);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 300 }]);
  });

  // Розрив у ОДИН id — це чекін, якого ми не бачили. Зливати не можна.
  it('does not merge across a one-id gap', () => {
    addCoverage(db, 1, 202, 300);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 202, to_id: 300 }, { from_id: 100, to_id: 200 }]);
  });

  it('collapses several ranges when one bridges them', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 500, 600);
    addCoverage(db, 1, 900, 1000);
    addCoverage(db, 1, 150, 950);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 1000 }]);
  });

  it('is idempotent for the same page submitted twice', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it('keeps users apart', () => {
    ensureProfile(db, 2);
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 2, 100, 200);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 200 }]);
    expect(coverageFor(db, 2)).toEqual([{ from_id: 100, to_id: 200 }]);
  });

  it('rejects an inverted range instead of writing it', () => {
    expect(() => addCoverage(db, 1, 300, 100)).toThrow();
    expect(coverageFor(db, 1)).toEqual([]);
  });
});

describe('rangeContaining / deepestCoveredId', () => {
  it('finds the range holding an id, and nothing for a hole', () => {
    addCoverage(db, 1, 100, 200);
    addCoverage(db, 1, 500, 600);
    expect(rangeContaining(db, 1, 150)).toEqual({ from_id: 100, to_id: 200 });
    expect(rangeContaining(db, 1, 100)).toEqual({ from_id: 100, to_id: 200 });
    expect(rangeContaining(db, 1, 300)).toBeNull();
  });

  it('reports the deepest covered id, and null with no coverage', () => {
    expect(deepestCoveredId(db, 1)).toBeNull();
    addCoverage(db, 1, 500, 600);
    addCoverage(db, 1, 100, 200);
    expect(deepestCoveredId(db, 1)).toBe(100);
  });
});
```

- [ ] **Крок 2: прогнати — має впасти**

Run: `npx vitest run src/storage/checkin_coverage.test.ts`
Expected: FAIL — `Cannot find module './checkin_coverage'`.

- [ ] **Крок 3: додати міграцію 29**

У `src/storage/schema.ts`, у кінець масиву міграцій (після запису `version: 28`), додай:

```ts
  {
    version: 29,
    // #587: скаляр `deepest_max_id` брався як мінімум із двох обходів, не суцільних між
    // собою, і цим СТВЕРДЖУВАВ покриття, якого ніхто не встановлював — 41 чекін лишився
    // недосяжним обома фазами. Тут покриття стає тим, що сторінка фіду доводить сама:
    // діапазоном [найстарший_на_сторінці, курсор]. Об'єднання таких діапазонів збрехати
    // не може, а обірваний прогін просто перестає їх додавати.
    //
    // Сидуємо лише тих, кому число це підтверджує: `synced >= profile_total` — свідчення
    // для запису діапазону, а не гейт для чогось іншого. Межі беремо рівно MIN/MAX наявних
    // чекінів: сид не додає від себе нічого ні згори, ні знизу.
    sql: `
      CREATE TABLE IF NOT EXISTS checkin_coverage (
        telegram_id INTEGER NOT NULL
                      REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        from_id     INTEGER NOT NULL,
        to_id       INTEGER NOT NULL,
        PRIMARY KEY (telegram_id, from_id)
      );

      INSERT INTO checkin_coverage (telegram_id, from_id, to_id)
      SELECT s.telegram_id,
             MIN(CAST(c.checkin_id AS INTEGER)),
             MAX(CAST(c.checkin_id AS INTEGER))
        FROM checkin_sync_state s
        JOIN checkins c ON c.telegram_id = s.telegram_id
       WHERE s.profile_total IS NOT NULL
       GROUP BY s.telegram_id
      HAVING COUNT(*) >= s.profile_total;
    `,
  },
```

- [ ] **Крок 4: написати модуль покриття**

Створи `src/storage/checkin_coverage.ts`:

```ts
import type { DB } from './db';

export interface CoverageRange {
  from_id: number;
  to_id: number;
}

// #587: покриття чекінів — це об'єднання діапазонів, кожен з яких доводить сама сторінка
// фіду: фрагмент, запитаний із курсором M, повертає ВСЕ, що лежить нижче M до найстарішого
// свого елемента. Тому діапазон не залежить ні від того, з якого прогону сторінка прийшла,
// ні від того, чи той прогін обірвався.
export function coverageFor(db: DB, telegramId: number): CoverageRange[] {
  return db
    .prepare('SELECT from_id, to_id FROM checkin_coverage WHERE telegram_id = ? ORDER BY from_id DESC')
    .all(telegramId) as CoverageRange[];
}

// Зливає діапазон у покриття. Дотик рахується злиттям (`from - 1` / `to + 1`): між 200 і 201
// немає жодного id, тож жоден чекін не міг би туди сховатися. А от розрив у один id — це вже
// чекін, якого ми не бачили, і такі діапазони лишаються окремими.
export function addCoverage(db: DB, telegramId: number, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
    throw new Error(`invalid coverage range: ${from}..${to}`);
  }
  const low = from - 1;
  const high = to + 1;
  const touching = db
    .prepare('SELECT from_id, to_id FROM checkin_coverage WHERE telegram_id = ? AND to_id >= ? AND from_id <= ?')
    .all(telegramId, low, high) as CoverageRange[];

  let lo = from;
  let hi = to;
  for (const r of touching) {
    if (r.from_id < lo) lo = r.from_id;
    if (r.to_id > hi) hi = r.to_id;
  }

  db.prepare('DELETE FROM checkin_coverage WHERE telegram_id = ? AND to_id >= ? AND from_id <= ?')
    .run(telegramId, low, high);
  db.prepare('INSERT INTO checkin_coverage (telegram_id, from_id, to_id) VALUES (?, ?, ?)')
    .run(telegramId, lo, hi);
}

export function rangeContaining(db: DB, telegramId: number, id: number): CoverageRange | null {
  const row = db
    .prepare('SELECT from_id, to_id FROM checkin_coverage WHERE telegram_id = ? AND from_id <= ? AND to_id >= ? LIMIT 1')
    .get(telegramId, id, id) as CoverageRange | undefined;
  return row ?? null;
}

export function deepestCoveredId(db: DB, telegramId: number): number | null {
  const row = db
    .prepare('SELECT MIN(from_id) AS m FROM checkin_coverage WHERE telegram_id = ?')
    .get(telegramId) as { m: number | null };
  return row.m;
}
```

- [ ] **Крок 5: додати `oldestCheckinId`**

У `src/storage/checkins.ts`, поруч із `latestCheckinAt`:

```ts
// #587: межа, нижче якої порожня відповідь фіду законна. Вище неї порожньо бути не може —
// принаймні цей наш власний чекін мав би повернутися, — тож порожнеча там доводить зламану
// сесію, а не дно стрічки.
export function oldestCheckinId(db: DB, telegramId: number): number | null {
  const row = db
    .prepare('SELECT MIN(CAST(checkin_id AS INTEGER)) AS m FROM checkins WHERE telegram_id = ?')
    .get(telegramId) as { m: number | null };
  return row.m;
}
```

Додай тест у `src/storage/checkins.test.ts` (стиль наявних тестів у файлі — подивись, як там
готується БД і як створюються чекіни, і повтори його):

```ts
  it('reports the oldest checkin id numerically, not lexicographically', () => {
    // '900' > '1000' як рядки — саме тому потрібен CAST.
    mergeCheckin(db, { checkin_id: '900', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-01 00:00:00', venue: null });
    mergeCheckin(db, { checkin_id: '1000', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2026-01-02 00:00:00', venue: null });
    expect(oldestCheckinId(db, 1)).toBe(900);
  });

  it('returns null when the user has no checkins', () => {
    expect(oldestCheckinId(db, 999)).toBeNull();
  });
```

- [ ] **Крок 6: тест сидування міграції**

Додай у `src/storage/checkin_coverage.test.ts`:

```ts
describe('migration 29 seeding', () => {
  function seedUser(d: DB, id: number, ids: number[], profileTotal: number | null): void {
    ensureProfile(d, id);
    for (const cid of ids) {
      d.prepare('INSERT INTO checkins (checkin_id, telegram_id, beer_id, user_rating, checkin_at, venue) VALUES (?, ?, NULL, NULL, ?, NULL)')
        .run(String(cid), id, '2026-01-01 00:00:00');
    }
    d.prepare('INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, profile_total) VALUES (?, NULL, 0, ?)')
      .run(id, profileTotal);
  }

  it('seeds only the users whose counts back the claim', () => {
    const fresh = openDb(':memory:');
    migrate(fresh);
    fresh.exec('DELETE FROM checkin_coverage');
    seedUser(fresh, 10, [100, 500, 900], 3);    // synced == total → сид
    seedUser(fresh, 11, [100, 500], 9);         // synced < total  → без сиду
    seedUser(fresh, 12, [100, 500], null);      // total невідомий → без сиду
    fresh.prepare('DELETE FROM schema_version WHERE version = 29').run();
    migrate(fresh);

    expect(coverageFor(fresh, 10)).toEqual([{ from_id: 100, to_id: 900 }]);
    expect(coverageFor(fresh, 11)).toEqual([]);
    expect(coverageFor(fresh, 12)).toEqual([]);
  });
});
```

Зауваж: `migrate` іде до кінця, тож таблиця вже існує й порожня; тест видаляє запис версії 29
і ганяє міграцію вдруге вже по засіяних даних. `CREATE TABLE IF NOT EXISTS` це витримує —
переконайся, що витримує і `INSERT` (він має бути безпечним при повторі, бо перед ним
таблиця очищена рядком `DELETE FROM checkin_coverage`).

- [ ] **Крок 7: прогнати повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене.

- [ ] **Крок 8: мутаційна перевірка**

Тимчасово заміни в `addCoverage` рядок `if (r.from_id < lo) lo = r.from_id;` на порожній —
тест `collapses several ranges when one bridges them` має впасти. Поверни рядок.
Тимчасово заміни `const low = from - 1;` на `const low = from;` — має впасти
`merges ranges separated by no integer at all`. Поверни.

- [ ] **Крок 9: коміт**

```bash
git add src/storage/checkin_coverage.ts src/storage/checkin_coverage.test.ts src/storage/schema.ts src/storage/checkins.ts src/storage/checkins.test.ts
git commit -m "feat(#587): покриття чекінів як об'єднання доведених діапазонів"
```

---

### Task 2: `checkin_sync_state` — лише `profile_total`, курсор стає похідним

**Files:**
- Modify: `src/storage/checkin_sync_state.ts`
- Modify: `src/storage/checkin_sync_state.test.ts` (переписати під новий контракт)

**Interfaces:**
- Consumes: `deepestCoveredId` з `./checkin_coverage` (Task 1).
- Produces:
  - `getSyncState(db: DB, telegramId: number): SyncState`, де
    `SyncState = { deepest_max_id: string | null; complete: boolean; profile_total: number | null }`
    і `deepest_max_id` тепер = `String(deepestCoveredId(...))` або `null`
  - `recordProfileTotal(db: DB, telegramId: number, profileTotal: number | null): void`
  - `advanceSyncState` **видаляється** разом із `deeper()`

- [ ] **Крок 1: переписати тест під новий контракт**

Заміни весь вміст `src/storage/checkin_sync_state.test.ts` на:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { addCoverage } from './checkin_coverage';
import { getSyncState, recordProfileTotal } from './checkin_sync_state';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
});

describe('getSyncState', () => {
  it('returns an empty state for a user with no rows', () => {
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false, profile_total: null });
  });

  // #587: курсор більше не зберігається — він ПОХІДНИЙ від покриття, тож збрехати не може.
  it('derives deepest_max_id from the coverage floor', () => {
    addCoverage(db, 1, 500, 600);
    addCoverage(db, 1, 100, 200);
    expect(getSyncState(db, 1).deepest_max_id).toBe('100');
  });

  it('keeps profile_total when a later page parses none', () => {
    recordProfileTotal(db, 1, 11287);
    expect(getSyncState(db, 1).profile_total).toBe(11287);
    recordProfileTotal(db, 1, null);
    expect(getSyncState(db, 1).profile_total).toBe(11287);
    recordProfileTotal(db, 1, 11290);
    expect(getSyncState(db, 1).profile_total).toBe(11290);
  });

  it('never writes complete', () => {
    recordProfileTotal(db, 1, 10);
    addCoverage(db, 1, 100, 200);
    expect(getSyncState(db, 1).complete).toBe(false);
  });
});
```

- [ ] **Крок 2: прогнати — має впасти**

Run: `npx vitest run src/storage/checkin_sync_state.test.ts`
Expected: FAIL — `recordProfileTotal` не експортується.

- [ ] **Крок 3: переписати модуль**

Заміни вміст `src/storage/checkin_sync_state.ts` на:

```ts
import type { DB } from './db';
import { deepestCoveredId } from './checkin_coverage';

export interface SyncState {
  deepest_max_id: string | null;
  /** #587: застаріле. Ніхто більше не пише — дно стрічки недоказове (див. спеку). */
  complete: boolean;
  profile_total: number | null;
}

// #587: курсор більше не зберігається окремо. Він ПОХІДНИЙ від покриття — найглибший
// доведений id, — тож не існує місця, де можна було б ствердити глибину, якої не досягли.
export function getSyncState(db: DB, telegramId: number): SyncState {
  const row = db
    .prepare('SELECT complete, profile_total FROM checkin_sync_state WHERE telegram_id = ?')
    .get(telegramId) as { complete: number; profile_total: number | null } | undefined;
  const deepest = deepestCoveredId(db, telegramId);
  return {
    deepest_max_id: deepest === null ? null : String(deepest),
    complete: row?.complete === 1,
    profile_total: row?.profile_total ?? null,
  };
}

// Єдине, що ще пишеться в цю таблицю: останній відомий лік чекінів у профілі Untappd.
// COALESCE — щоб сторінка-фрагмент (у якої статистики немає) не стирала значення.
export function recordProfileTotal(db: DB, telegramId: number, profileTotal: number | null): void {
  db.prepare(
    `INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, profile_total, updated_at)
       VALUES (?, NULL, 0, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id) DO UPDATE SET
       profile_total = COALESCE(excluded.profile_total, checkin_sync_state.profile_total),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, profileTotal);
}
```

- [ ] **Крок 4: полагодити виклик у маршруті, щоб збірка типів пройшла**

`src/api/routes/checkins.ts` зараз кличе `advanceSyncState`. Тимчасово заміни цей виклик на
`recordProfileTotal(deps.db, telegramId, page.profileTotal);` і виправ імпорт — повноцінно
маршрут переписує Task 3.

- [ ] **Крок 5: прогнати повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене. Якщо `src/api/routes/checkins.test.ts` тепер очікує старий
`deepest_max_id`, поправ його очікування під похідне значення — і **не чіпай** те, що
стосується `nextCursor` (його ще немає).

- [ ] **Крок 6: коміт**

```bash
git add src/storage/checkin_sync_state.ts src/storage/checkin_sync_state.test.ts src/api/routes/checkins.ts src/api/routes/checkins.test.ts
git commit -m "refactor(#587): курсор синхронізації стає похідним від покриття"
```

---

### Task 3: маршрут — запис діапазону, `nextCursor`, `422 no_session`

**Files:**
- Modify: `src/api/routes/checkins.ts`
- Modify: `src/api/routes/checkins.test.ts`

**Interfaces:**
- Consumes: `addCoverage`, `rangeContaining` (Task 1); `recordProfileTotal`, `getSyncState` (Task 2);
  `oldestCheckinId` (Task 1).
- Produces: відповідь `POST /checkins/sync` з новим полем `nextCursor: string | null`
  (решта полів без змін); нова відповідь `422 { error: 'no_session' }`.

- [ ] **Крок 1: написати падаючі тести**

Додай у `src/api/routes/checkins.test.ts`. Синтетичні сторінки будуй за зразком наявного
`PAGE_ONE` у цьому ж файлі (селектори справжні — `div.item[data-checkin-id]`, `p.text`,
`a.time`); зроби хелпер, який штампує сторінку з переліку id:

```ts
// Сторінка фіду з довільних id, newest→oldest, за тими самими селекторами, що й PAGE_ONE.
function pageOf(ids: number[]): string {
  const items = ids.map((id) => `
    <div class="item" data-checkin-id="${id}">
      <p class="text">
        <a href="/user/bob" class="user">Bob</a> is drinking an <a href="/b/ipa-${id}/${id}">Beer ${id}</a>
        by <a href="/SomeBrewery">Some Brewery</a>
      </p>
      <a href="/user/bob/checkin/${id}" class="time timezoner">Mon, 15 Jun 2026 18:00:00 +0000</a>
    </div>`).join('');
  return `<html><body>${items}</body></html>`;
}

describe('POST /checkins/sync — покриття і nextCursor (#587)', () => {
  it('records the page range and steps down when nothing is covered yet', async () => {
    const { app, db } = setup();
    const res = await post(app, '/checkins/sync', { html: pageOf([600, 590, 580]), maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBe('580');
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 580, to_id: 600 }]);
  });

  it('uses the request cursor as the upper bound of the proven range', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    await post(app, '/checkins/sync', { html: pageOf([570, 560]), maxId: '580' }, RAW_TOKEN);
    // Друга сторінка доводить [560, 580], і 580 склеює її з першою.
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 560, to_id: 600 }]);
  });

  it('jumps below covered territory instead of walking through it', async () => {
    const { app, db } = setup();
    addCoverage(db, TELEGRAM_ID, 100, 500);
    const res = await post(app, '/checkins/sync', { html: pageOf([600, 550, 500]), maxId: null }, RAW_TOKEN);
    // Сторінка дотягнулася до 500 — це вже покрите, тож стрибаємо під увесь блок.
    expect((await res.json()).nextCursor).toBe('100');
  });

  // Регресія #587: діра ПІД верхньою сторінкою і НАД старим покриттям.
  it('does not jump over a hole that lies below the page', async () => {
    const { app, db } = setup();
    addCoverage(db, TELEGRAM_ID, 100, 200);
    const res = await post(app, '/checkins/sync', { html: pageOf([600, 590, 580]), maxId: null }, RAW_TOKEN);
    // 580 не дотикається до [100,200]: між ними діра, і йти треба в неї, а не під неї.
    expect((await res.json()).nextCursor).toBe('580');
    const res2 = await post(app, '/checkins/sync', { html: pageOf([300, 200]), maxId: '580' }, RAW_TOKEN);
    // Ця сторінка закрила діру й склеїла все: тепер стрибок аж під низ.
    expect((await res2.json()).nextCursor).toBe('100');
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 100, to_id: 600 }]);
  });

  it('stops the walk when the counts already agree', async () => {
    const { app } = setup();
    // profileTotal = 3 приходить зі сторінки профілю, і рівно 3 чекіни на ній.
    const html = pageOf([600, 590, 580]).replace(
      '<body>',
      '<body><div class="stats"><a><span class="stat">3</span><span class="title">Total</span></a></div>',
    );
    const res = await post(app, '/checkins/sync', { html, maxId: null }, RAW_TOKEN);
    expect((await res.json()).nextCursor).toBeNull();
  });

  it('accepts an empty page at or below the oldest known checkin as the end of the walk', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    const res = await post(app, '/checkins/sync', { html: '<html><body></body></html>', maxId: '580' }, RAW_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.pageSize).toBe(0);
    // Нічого про дно не записано: покриття лишилось тим, що довели сторінки.
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 580, to_id: 600 }]);
  });

  // Порожньо там, де наш власний чекін мав би повернутися → сесія зламана, не дно.
  it('rejects an empty page above the oldest known checkin as a dead session', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    const res = await post(app, '/checkins/sync', { html: '<html><body></body></html>', maxId: '900' }, RAW_TOKEN);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'no_session' });
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([{ from_id: 580, to_id: 600 }]);
  });

  it('treats an empty profile page as an empty account, not a dead session', async () => {
    const { app } = setup();
    const res = await post(app, '/checkins/sync', { html: '<html><body></body></html>', maxId: null }, RAW_TOKEN);
    expect(res.status).toBe(200);
    expect((await res.json()).nextCursor).toBeNull();
  });

  it('rejects a non-numeric cursor instead of failing inside the transaction', async () => {
    const { app } = setup();
    const res = await post(app, '/checkins/sync', { html: pageOf([600]), maxId: 'abc' }, RAW_TOKEN);
    expect(res.status).toBe(400);
  });

  // Стара версія розширення ігнорує `nextCursor` і шле сторінки за власною логікою,
  // обриваючись на першій повністю відомій. Сервер від цього не мусить нічого ствердити:
  // кожна сторінка доводить лише СВІЙ діапазон, і діра лишається видимою.
  it('records only what each page proves, even when the pages do not form a chain', async () => {
    const { app, db } = setup();
    await post(app, '/checkins/sync', { html: pageOf([600, 580]), maxId: null }, RAW_TOKEN);
    await post(app, '/checkins/sync', { html: pageOf([300, 200]), maxId: '310' }, RAW_TOKEN);
    expect(coverageFor(db, TELEGRAM_ID)).toEqual([
      { from_id: 580, to_id: 600 },
      { from_id: 200, to_id: 310 },
    ]);
  });
});
```

Додай імпорти `addCoverage, coverageFor` з `../../storage/checkin_coverage` у шапку тесту.

- [ ] **Крок 2: прогнати — має впасти**

Run: `npx vitest run src/api/routes/checkins.test.ts`
Expected: FAIL — `nextCursor` відсутній у відповіді (`undefined`).

- [ ] **Крок 3: переписати обробник `POST /checkins/sync`**

У `src/api/routes/checkins.ts` заміни тіло обробника (від `const { html } = c.req.valid('json');`
до `return c.json({...})`) на:

```ts
    const { html, maxId } = c.req.valid('json');
    if (isBlockPage(html)) return c.json({ error: 'blocked' }, 502);

    const page = parseCheckinFeedPage(html);
    // Курсор — числовий id. Нечислове сюди прийти не мало б, але без явної перевірки
    // воно перетворилося б на NaN і впало б уже всередині транзакції, віддавши 500.
    let cursor: number | null = null;
    if (maxId !== undefined && maxId !== null) {
      const n = Number(maxId);
      if (!Number.isInteger(n) || n <= 0) return c.json({ error: 'bad_cursor' }, 400);
      cursor = n;
    }

    // #587: порожня сторінка нічого не доводить. Нижче нашого найстарішого чекіна вона
    // законна (там і справді може нічого не бути), вище — суперечить нашим власним даним,
    // бо принаймні той чекін мав би повернутися. Отже вище — це мертва сесія або блок.
    if (page.checkins.length === 0) {
      const oldestKnown = oldestCheckinId(deps.db, telegramId);
      if (cursor !== null && oldestKnown !== null && cursor > oldestKnown) {
        return c.json({ error: 'no_session' }, 422);
      }
      return c.json({
        merged: 0,
        alreadyKnown: 0,
        pageSize: 0,
        nextMaxId: null,
        nextCursor: null,
        profileTotal: page.profileTotal ?? getSyncState(deps.db, telegramId).profile_total,
        serverCount: countCheckins(deps.db, telegramId),
        complete: false,
      });
    }

    let merged = 0;
    let alreadyKnown = 0;

    deps.db.transaction(() => {
      const ids: number[] = [];
      for (const ci of page.checkins) {
        const existed = checkinExists(deps.db, telegramId, ci.checkin_id);
        const beerId = upsertBeer(deps.db, {
          untappd_id: ci.bid,
          name: ci.beer_name,
          brewery: ci.brewery_name,
          style: null,
          abv: null,
          rating_global: null,
          normalized_name: normalizeName(ci.beer_name),
          normalized_brewery: normalizeBrewery(ci.brewery_name),
          untappd_id_source: 'checkin',
        });
        mergeCheckin(deps.db, {
          checkin_id: ci.checkin_id,
          telegram_id: telegramId,
          beer_id: beerId,
          user_rating: ci.user_rating,
          checkin_at: ci.checkin_at,
          venue: ci.venue,
        });
        ids.push(Number(ci.checkin_id));
        if (existed) alreadyKnown++;
        else merged++;
      }

      // Верхня межа доведеного — курсор, що породив сторінку; для сторінки профілю
      // (курсора немає) вище найновішого елемента не доведено нічого.
      const oldest = Math.min(...ids);
      const newest = Math.max(...ids);
      addCoverage(deps.db, telegramId, oldest, cursor ?? newest);
      recordProfileTotal(deps.db, telegramId, page.profileTotal);
    })();

    const serverCount = countCheckins(deps.db, telegramId);
    const state = getSyncState(deps.db, telegramId);
    const oldestOnPage = Math.min(...page.checkins.map((ci) => Number(ci.checkin_id)));
    const covering = rangeContaining(deps.db, telegramId, oldestOnPage);

    // Лічильники зійшлися — шукати нижче нічого. Це не твердження про дно стрічки
    // (його довести не можна), а констатація «роботи немає».
    const caughtUp = state.profile_total !== null && serverCount >= state.profile_total;
    const nextCursor = caughtUp ? null : String(covering?.from_id ?? oldestOnPage);

    return c.json({
      merged,
      alreadyKnown,
      pageSize: page.checkins.length,
      nextMaxId: page.nextMaxId,
      nextCursor,
      profileTotal: page.profileTotal,
      serverCount,
      complete: false,
    });
```

Імпорти у шапці файлу: додай `addCoverage, rangeContaining` з `../../storage/checkin_coverage`,
`oldestCheckinId` до наявного імпорту з `../../storage/checkins`, і заміни
`getSyncState, advanceSyncState` на `getSyncState, recordProfileTotal`.

- [ ] **Крок 4: прогнати тести маршруту**

Run: `npx vitest run src/api/routes/checkins.test.ts`
Expected: PASS. Наявні тести файлу, що очікували `complete: true` на дні або старий
`deepest_max_id`, треба привести до нового контракту: `complete` більше не виставляється,
`deepest_max_id` дорівнює низу покриття.

- [ ] **Крок 5: повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене.

- [ ] **Крок 6: мутаційна перевірка регресії #587**

Тимчасово заміни `const nextCursor = caughtUp ? null : String(covering?.from_id ?? oldestOnPage);`
на стару поведінку «стрибай завжди на найглибший»:
`const nextCursor = caughtUp ? null : (state.deepest_max_id ?? String(oldestOnPage));`
— тест `does not jump over a hole that lies below the page` має впасти. Поверни правильний рядок.

- [ ] **Крок 7: коміт**

```bash
git add src/api/routes/checkins.ts src/api/routes/checkins.test.ts
git commit -m "feat(#587): сервер веде покриття і сам каже, куди йти далі"
```

---

### Task 4: `/import` сидує свій діапазон

**Files:**
- Create: `src/bot/commands/import-checkins.ts`
- Create: `src/bot/commands/import-checkins.test.ts`
- Modify: `src/bot/commands/import.ts` (хендлер стає тонкою обгорткою навколо нового модуля)

**Interfaces:**
- Consumes: `addCoverage` (Task 1); `Checkin` з `../../sources/untappd/export`.
- Produces: `importCheckins(db: DB, telegramId: number, rows: Checkin[]): void` — зливає
  партію чекінів і розширює покриття на `[MIN, MAX]` їхніх id.

Тестів у `import.ts` немає, і тестувати його як є неможливо: уся логіка сидить усередині
Telegraf-хендлера з завантаженням файлу. Тому логіка виноситься в окремий модуль — це той
самий прийом, що вже вживаний у репо (`status-build.ts`, `beers-build.ts`).

- [ ] **Крок 1: написати падаючий тест**

Створи `src/bot/commands/import-checkins.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { countCheckins } from '../../storage/checkins';
import { coverageFor } from '../../storage/checkin_coverage';
import { importCheckins } from './import-checkins';
import type { Checkin } from '../../sources/untappd/export';

function row(over: Partial<Checkin>): Checkin {
  return {
    checkin_id: '100',
    beer_name: 'Some IPA',
    brewery_name: 'Some Brewery',
    beer_type: null,
    beer_abv: null,
    global_rating: null,
    rating_score: null,
    created_at: '2026-01-01 00:00:00',
    venue_name: null,
    bid: 42,
    ...over,
  };
}

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
});

describe('importCheckins', () => {
  it('merges the rows', () => {
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(countCheckins(db, 1)).toBe(2);
  });

  // #587: експорт Untappd — повна історія до своєї дати, тобто рівно доведений діапазон.
  // Саме цього свідчення бракувало: дані імпорт давав, покриття — ні, і синхронізація
  // потім змушена була вгадувати, що вже покрито.
  it('seeds the coverage range the export proves', () => {
    importCheckins(db, 1, [row({ checkin_id: '100' }), row({ checkin_id: '900' })]);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 900 }]);
  });

  it('extends coverage across batches', () => {
    importCheckins(db, 1, [row({ checkin_id: '500' })]);
    importCheckins(db, 1, [row({ checkin_id: '100' })]);
    // Дві партії одного експорту; між 100 і 500 експорт теж усе віддав, тож діапазон один.
    expect(coverageFor(db, 1)).toEqual([{ from_id: 100, to_id: 500 }]);
  });

  it('ignores a non-numeric checkin id when computing the range', () => {
    importCheckins(db, 1, [row({ checkin_id: 'abc' }), row({ checkin_id: '300' })]);
    expect(coverageFor(db, 1)).toEqual([{ from_id: 300, to_id: 300 }]);
  });

  it('writes no coverage for an empty batch', () => {
    importCheckins(db, 1, []);
    expect(coverageFor(db, 1)).toEqual([]);
  });
});
```

Хелпер `row` покриває тип `Checkin` цілком (`src/sources/untappd/export.ts`: `checkin_id`,
`bid`, `beer_name`, `brewery_name`, `beer_type`, `beer_abv`, `rating_score`, `global_rating`,
`created_at`, `venue_name`), тож жодного касту не потрібно.

- [ ] **Крок 2: прогнати — має впасти**

Run: `npx vitest run src/bot/commands/import-checkins.test.ts`
Expected: FAIL — `Cannot find module './import-checkins'`.

- [ ] **Крок 3: винести логіку в модуль**

Створи `src/bot/commands/import-checkins.ts`, перенісши в нього тіло наявного `flushBatch` з
`import.ts` без змін у логіці злиття:

```ts
import type { DB } from '../../storage/db';
import type { Checkin } from '../../sources/untappd/export';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { addCoverage } from '../../storage/checkin_coverage';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';

// #587: експорт доводить суцільність своєї історії — записуємо це як покриття. Без цього
// свідчення синхронізація потім не має звідки знати, що вже покрито, і починає вгадувати.
export function importCheckins(db: DB, telegramId: number, rows: Checkin[]): void {
  let minId: number | null = null;
  let maxId: number | null = null;

  db.transaction(() => {
    for (const r of rows) {
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
      mergeCheckin(db, {
        checkin_id: r.checkin_id,
        telegram_id: telegramId,
        beer_id: beerId,
        user_rating: r.rating_score,
        checkin_at: r.created_at,
        venue: r.venue_name,
      });
      const n = Number(r.checkin_id);
      if (Number.isInteger(n) && n > 0) {
        if (minId === null || n < minId) minId = n;
        if (maxId === null || n > maxId) maxId = n;
      }
    }
    if (minId !== null && maxId !== null) addCoverage(db, telegramId, minId, maxId);
  })();
}
```

- [ ] **Крок 4: звести `import.ts` до обгортки**

У `src/bot/commands/import.ts` видали локальний `flushBatch` разом із його імпортами
(`upsertBeer`, `mergeCheckin`, `normalizeBrewery`, `normalizeName`) і клич новий модуль:

```ts
        await withBusyRetry(() => importCheckins(db, telegramId, batch));
```

у обох місцях, де раніше стояло `withBusyRetry(() => flushBatch(batch))`. Додай імпорт
`import { importCheckins } from './import-checkins';`.

- [ ] **Крок 5: прогнати тест**

Run: `npx vitest run src/bot/commands/import-checkins.test.ts`
Expected: PASS.

- [ ] **Крок 6: повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене.

- [ ] **Крок 7: мутаційна перевірка**

Тимчасово прибери рядок `if (minId !== null && maxId !== null) addCoverage(...)` — тест
`seeds the coverage range the export proves` має впасти. Поверни.

- [ ] **Крок 8: коміт**

```bash
git add src/bot/commands/import-checkins.ts src/bot/commands/import-checkins.test.ts src/bot/commands/import.ts
git commit -m "feat(#587): імпорт сидує покриття, яке доводить експорт"
```

---

### Task 5: розширення — дві фази згортаються в один цикл

**Files:**
- Modify: `extension/src/api/types.ts` (`CheckinSyncPageResult.nextCursor`)
- Modify: `extension/src/api/client.ts` (`ApiErrorCode` + мапінг 422)
- Modify: `extension/src/background/handle-checkin-sync.ts`
- Modify: `extension/src/background/handle-checkin-sync.test.ts`
- Modify: `extension/src/background/index.ts` (тип статусу; `complete` в терміналі)
- Modify: `extension/src/background/index.test.ts` (якщо зачепить)

**Interfaces:**
- Consumes: поле `nextCursor: string | null` у відповіді `POST /checkins/sync` (Task 3);
  `422 { error: 'no_session' }`.
- Produces: `SyncStatus = 'done' | 'capped' | 'cancelled' | 'not_linked' | 'blocked' | 'no_session' | 'error'`;
  `SyncOutcome.complete` тепер похідне (`profileTotal !== null && serverCount >= profileTotal`).

- [ ] **Крок 1: переписати тести обходу**

У `extension/src/background/handle-checkin-sync.test.ts` заміни хелпер `page` і три тести
про фази на новий контракт:

```ts
function page(over: Partial<CheckinSyncPageResult>): CheckinSyncPageResult {
  return { merged: 25, alreadyKnown: 0, pageSize: 25, nextMaxId: '1', nextCursor: '1', profileTotal: 100, serverCount: 0, complete: false, ...over };
}
```

```ts
  it('follows nextCursor and stops when the server says there is nothing below', async () => {
    const cursors: (string | null)[] = [];
    const submitPage = vi.fn(async (_html: string, cursor: string | null) => {
      cursors.push(cursor);
      return cursors.length === 1 ? page({ nextCursor: '500' }) : page({ nextCursor: null });
    });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(cursors).toEqual([null, '500']);
    expect(out.status).toBe('done');
  });

  // #587: сервер стрибає під покриту територію — клієнт просто йде, куди сказано,
  // і більше не має власної евристики «усі відомі → стоп».
  it('does not stop on a fully-known page when the server hands back a cursor', async () => {
    let n = 0;
    const submitPage = vi.fn(async () => (++n < 3
      ? page({ merged: 0, alreadyKnown: 25, nextCursor: String(100 - n) })
      : page({ nextCursor: null })));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(submitPage).toHaveBeenCalledTimes(3);
    expect(out.status).toBe('done');
  });

  it('reports complete from the counts, not from the feed bottom', async () => {
    const submitPage = vi.fn(async () => page({ nextCursor: null, serverCount: 100, profileTotal: 100 }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.complete).toBe(true);
  });

  it('does not claim complete when the counts still disagree', async () => {
    const submitPage = vi.fn(async () => page({ nextCursor: null, serverCount: 90, profileTotal: 100 }));
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.complete).toBe(false);
  });

  it('surfaces a dead Untappd session as its own status', async () => {
    const submitPage = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'no_session' }); });
    const out = await runCheckinSync(baseDeps({ submitPage }));
    expect(out.status).toBe('no_session');
  });
```

Тест `halts and reports the page cap` лишається, але його `submitPage` має повертати
`page({ nextCursor: '1' })` (обхід, що ніколи не закінчується). Тести на скасування —
без змін.

- [ ] **Крок 2: прогнати — має впасти**

Run: `npx vitest run --root extension src/background/handle-checkin-sync.test.ts`
Expected: FAIL — `nextCursor` немає в типі, статусу `no_session` немає.

- [ ] **Крок 3: типи й клієнт**

`extension/src/api/types.ts` — у `CheckinSyncPageResult` додай:

```ts
  /** #587: куди йти далі. Рахує сервер, стрибаючи через покриту територію. `null` = роботи немає. */
  nextCursor: string | null;
```

`extension/src/api/client.ts`:

```ts
export type ApiErrorCode = 'unauthorized' | 'server' | 'network' | 'not_linked' | 'blocked' | 'no_session';
```

і в `postCheckinSyncPage`, поруч із наявними мапінгами статусів:

```ts
  if (res.status === 422) throw new ApiError('no_session');
```

- [ ] **Крок 4: переписати цикл**

У `extension/src/background/handle-checkin-sync.ts`:

```ts
export type SyncStatus = 'done' | 'capped' | 'cancelled' | 'not_linked' | 'blocked' | 'no_session' | 'error';
```

Заміни все від `// Phase 0 starts at "now"` до `return finish('done', false);` на:

```ts
  // #587: одна прогулянка згори вниз. Куди ступати далі — каже сервер (`nextCursor`):
  // він знає покриття і стрибає під уже покриту територію. Двох фаз і евристики
  // «усі 25 відомі → стоп» більше немає: саме вони лишали діру недосяжною.
  let cursor: string | null = null;
  while (pages < deps.pageCap) {
    if (deps.signal?.aborted) return finish('cancelled');
    let html: string;
    try {
      html = await deps.fetchFeed(state.username, cursor);
    } catch (e) {
      if (deps.signal?.aborted) return finish('cancelled');
      return finish(errCode(e) === 'blocked' ? 'blocked' : 'error');
    }
    if (deps.signal?.aborted) return finish('cancelled');
    let res: CheckinSyncPageResult;
    try {
      res = await deps.submitPage(html, cursor);
    } catch (e) {
      if (deps.signal?.aborted) return finish('cancelled');
      const code = errCode(e);
      if (code === 'blocked') return finish('blocked');
      if (code === 'not_linked') return finish('not_linked');
      if (code === 'no_session') return finish('no_session');
      return finish('error');
    }
    pages++;
    mergedThisRun += res.merged;
    serverCount = res.serverCount;
    if (res.profileTotal !== null) profileTotal = res.profileTotal;
    deps.onProgress({ serverCount, profileTotal, mergedThisRun });
    if (deps.signal?.aborted) return finish('cancelled');

    if (res.nextCursor === null) return finish('done');
    cursor = res.nextCursor;
    if (pages < deps.pageCap) await deps.sleep(delayMs);
  }
  return finish('capped');

  function finish(status: SyncStatus): SyncOutcome {
    // #587: «повністю» — це збіг лічильників, а не дно стрічки: дно недоказове, бо
    // порожню відповідь віддає і воно, і мертва сесія.
    const complete = profileTotal !== null && serverCount >= profileTotal;
    return { status, complete, serverCount, profileTotal, mergedThisRun };
  }
```

Прибери тепер непотрібне `state.deepest_max_id` / `state.complete` з тіла функції (сам
`getState` лишається — з нього беруться `username`, `serverCount`, `profileTotal`), а також
поле `complete` з параметрів `finish` у ранніх поверненнях (`finish('cancelled')`,
`finish('not_linked')`, `finish('error')` вище по коду).

- [ ] **Крок 5: `index.ts`**

У `extension/src/background/index.ts` тип `StoredSyncStatus.outcome` успадковує
`SyncOutcome['status']`, тож `no_session` під'їде сам. Перевір, що `beginCheckinSync` нічого
не робить із `outcome.complete` окрім передачі далі — і лиши як є.

- [ ] **Крок 6: прогнати тести розширення**

Run: `npm --prefix extension test`
Expected: PASS.

- [ ] **Крок 7: повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене.

- [ ] **Крок 8: мутаційна перевірка**

Тимчасово заміни `if (res.nextCursor === null) return finish('done');` на стару евристику
`if (res.alreadyKnown === res.pageSize) return finish('done');` — тест
`does not stop on a fully-known page when the server hands back a cursor` має впасти. Поверни.

- [ ] **Крок 9: коміт**

```bash
git add extension/src/api/types.ts extension/src/api/client.ts extension/src/background/handle-checkin-sync.ts extension/src/background/handle-checkin-sync.test.ts extension/src/background/index.ts
git commit -m "feat(#587): обхід чекінів іде за курсором сервера замість двох фаз"
```

---

### Task 6: popup — галочка за лічильниками й текст про мертву сесію

**Files:**
- Modify: `extension/src/popup/popup.ts`
- Modify: `extension/src/popup/popup.test.ts`

**Interfaces:**
- Consumes: `SyncStatusView.outcome` тепер може бути `'no_session'`; `complete` приходить
  порахованим із лічильників (Task 5).
- Produces: рядок статусу для `no_session`.

- [ ] **Крок 1: тести**

У `extension/src/popup/popup.test.ts` додай:

```ts
  it('shows the tick when the counts agree', () => {
    expect(formatSyncStatus({ running: false, serverCount: 12634, profileTotal: 12634, mergedThisRun: 41, outcome: 'done', complete: true }))
      .toBe('✓ Fully synced (12634).');
  });

  it('tells the user to sign in to Untappd when the session is dead', () => {
    expect(formatSyncStatus({ running: false, serverCount: 10, profileTotal: 8200, mergedThisRun: 0, outcome: 'no_session', complete: false }))
      .toBe('Untappd session expired — open untappd.com, sign in, then sync again.');
  });
```

- [ ] **Крок 2: прогнати — має впасти**

Run: `npx vitest run --root extension src/popup/popup.test.ts`
Expected: FAIL — для `no_session` повертається порожній рядок.

- [ ] **Крок 3: реалізувати**

У `extension/src/popup/popup.ts`, у `SyncStatusView.outcome` додай `'no_session'`, і в
`formatSyncStatus` — гілку поруч із `blocked`:

```ts
    case 'no_session': return 'Untappd session expired — open untappd.com, sign in, then sync again.';
```

Гілка `done` лишається як є: вона вже дивиться на `complete`, а `complete` тепер рахується з
лічильників (Task 5), тож галочка з'являється саме тоді, коли числа зійшлися.

- [ ] **Крок 4: прогнати повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене.

- [ ] **Крок 5: коміт**

```bash
git add extension/src/popup/popup.ts extension/src/popup/popup.test.ts
git commit -m "feat(#587): галочка за лічильниками і чесний текст про мертву сесію"
```

---

### Task 7: документи й перевірка міграції на копії прод-БД

**Files:**
- Modify: `spec.md` (§3.14, нова §3.15, §3.18 таблиця міграцій, §4 `POST /checkins/sync`)
- Modify: `extension/CHANGELOG.md`
- Modify: `docs/extension-install-uk.md`

**Interfaces:**
- Consumes: усе попереднє.
- Produces: документація, узгоджена з кодом; доказ, що міграція на реальних даних сидує
  рівно тих, кого має.

- [ ] **Крок 1: прогнати міграцію на байтовій копії прод-БД**

```bash
sudo -n -u warsaw-beer-bot bash -lc "sqlite3 /var/lib/warsaw-beer-bot/bot.db \".backup '/tmp/bot-587-copy.db'\"" \
  && sudo -n -u warsaw-beer-bot bash -lc "chmod 644 /tmp/bot-587-copy.db" \
  && cp /tmp/bot-587-copy.db ./tmp/bot-587-copy.db
npx tsx -e "
  const { openDb } = require('./src/storage/db');
  const { migrate } = require('./src/storage/schema');
  const db = openDb('./tmp/bot-587-copy.db');
  migrate(db);
  console.log(db.prepare('SELECT MAX(version) v FROM schema_version').get());
  console.log(db.prepare('SELECT telegram_id, from_id, to_id FROM checkin_coverage').all());
  console.log(db.prepare('SELECT s.telegram_id, (SELECT COUNT(*) FROM checkins c WHERE c.telegram_id=s.telegram_id) synced, s.profile_total FROM checkin_sync_state s').all());
"
```

Очікується: версія 29; по рядку покриття на кожного користувача, у якого
`synced >= profile_total`, з межами, що дорівнюють MIN/MAX його `checkin_id`; і **жодного**
рядка для тих, у кого числа не зійшлися. Наведи цей вивід у звіті задачі.

- [ ] **Крок 2: `spec.md`**

- §3.14: `checkin_sync_state` більше не носій курсора — лишається `profile_total`;
  `deepest_max_id` віддається як `MIN(from_id)` з покриття; `complete` позначити застарілою
  («не пишеться з #587; дно стрічки недоказове»).
- Нова §3.15 `checkin_coverage` — таблиця з колонками, інваріантом (діапазони не
  перетинаються й не дотикаються) і одним реченням про те, що діапазон доводить сама
  сторінка фіду. Наступні секції перенумерувати (3.15→3.16 і далі до 3.19).
- §3.18 (історія міграцій): рядок `| 29 | \`checkin_coverage\` — покриття чекінів
  діапазонами + сид для користувачів із \`synced >= profile_total\` (#587) |`.
- §4 `POST /checkins/sync`: додати `nextCursor` у перелік полів відповіді; переписати блок
  «Stop-логіка (клієнт)» — двох фаз більше немає, обхід іде за `nextCursor`, зупинки: `null`
  від сервера або cap; додати `422 { error: "no_session" }` і правило позиції для порожньої
  сторінки.

- [ ] **Крок 3: `extension/CHANGELOG.md`**

Один рядок під `## [Unreleased]`, користувацькою мовою — симптом, який людина бачила, і що
тепер. Жодних курсорів, фаз і діапазонів. Наприклад:

```markdown
- Fixed check-in sync stopping short: it now finds and fills gaps left in the middle of your
  history, and shows a tick once everything is in. If your Untappd session has expired it now
  says so instead of quietly reporting success.
```

- [ ] **Крок 4: `docs/extension-install-uk.md`**

Знайди розділ про синхронізацію чекінів і приведи його до нової поведінки: прогін іде, доки
сервер не скаже, що роботи немає (або доки не спрацює ліміт сторінок); повідомлення про
повну синхронізацію з'являється, коли зійшлися числа; окреме повідомлення про протерміновану
сесію Untappd. Якщо розділу немає — додати короткий, у стилі сусідніх.

- [ ] **Крок 5: повний гейт**

Run: `npm test && npm run typecheck && npm --prefix extension test && npm --prefix extension run typecheck`
Expected: усе зелене.

- [ ] **Крок 6: коміт**

```bash
git add spec.md extension/CHANGELOG.md docs/extension-install-uk.md
git commit -m "docs(#587): спека, чейнджлог і інструкція під покриття діапазонами"
```

---

## Після мерджу

1. Задеплоїти (`bash deploy/deploy.sh`) і перевірити, що `schema_version` = 29, а
   `checkin_coverage` має рядок на кожного з трьох користувачів.
2. Натиснути «Sync my check-ins» у розширенні: очікується один запит і `✓ Fully synced`.
3. Зрізати реліз розширення за `docs/extension-release.md` — без нього фікс не доїде до
   користувачів, бо весь обхід живе в їхніх браузерах.
