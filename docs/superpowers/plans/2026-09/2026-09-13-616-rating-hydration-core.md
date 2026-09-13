# Гідратація рейтингів через Algolia за bid — план ядра (#616)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** додати механізм звірки рейтингів злінкованого пива з Untappd: колонку
`rating_checked_at` (v31), чергу й запис у сховищі, джобу `hydrateRatings` (один
`getObjects` на ≤1000 bid) і правило «0 = немає рейтингу, 2 знаки» на межі п'яти парсерів Untappd.

**Architecture:** це **ядро** стадійної зміни (CLAUDE.md: план на ядро → рев'ю → окремий план на
обв'язку). Ядро **додає** функції з тестами і змінює лише парсери; джоба ні до чого не
підключена. Крон-слот, видалення `refreshTapRatings`/`beer-page.ts`/`recordRating*`/
`listRatingRefreshCandidates`, `refreshAllUntappd` (три стани блоку, штамп, провенанс), дайджест і
`spec.md` — окремий план після наскрізного рев'ю ядра.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Vitest 4 (`globals: true`), cheerio.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-616-rating-hydration-design.md`

## Global Constraints

- **Коментарі українською, ідентифікатори англійською** — як у решті репо.
- **Повний гейт після КОЖНОЇ задачі**, ніколи не звужений: `npm test && npm run typecheck`.
  Розширення (`extension/`) зміна не зачіпає.
- **Кожен тест мутаційно доведений**: крок «мутація» прибирає/змінює названий рядок реалізації —
  має впасти саме названий тест; рядок повертається. Тест, зелений без реалізації, у мердж не йде.
- **Сіди з видимими значеннями**, не `null`, коли тест перевіряє «не чіпає»
  (пам'ять `feedback_stub_defaults_hide_mutations`).
- **Ніяких `as unknown as` кастів** у новому коді (наявні тести `algolia.test.ts` їх мають — не
  переписувати).
- **Старий `refreshTapRatings`, `beer-page.ts`, `recordRating*`, `listRatingRefreshCandidates` у ядрі
  не змінюються і не видаляються** — вони ще підключені.
- **Код важить більше за цей план**: якщо сигнатура, імпорт чи назва в репо розходиться з текстом
  плану — іди за кодом і назви розбіжність у звіті задачі.
- Робота йде у worktree `616-rating-hydration` (гілка від `origin/main`, спека вже закомічена в ній).
- Задачі 1–3 дрібні за правилом CLAUDE.md (повний код, ≤2 файли + тести, без нових рішень) →
  контролер виконує **інлайн**. Задача 4 зачіпає шість файлів → **диспатч** імплементеру; його
  review-пакет включає задачі 1–3, і всі чотири називаються в диспатчі наскрізного рев'ю ядра.
- Порядок виконання 1 → 2 → 3 → 4: імплементер задачі 4 комітить сам, тож інлайнові задачі мають
  бути закомічені до диспатчу.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `src/storage/schema.ts` (зміна) | міграція v31 `beers.rating_checked_at` |
| `src/storage/beers.ts` (зміна) | `BeerRow.rating_checked_at`; `listRatingHydrationCandidates`, `applyHydratedRatings`, `RATING_RECHECK_DAYS` |
| `src/jobs/hydrate-ratings.ts` (новий) | джоба: гейти → черга → один `hydrateByBid` → запис; breaker |
| `src/sources/untappd/rating.ts` (новий) | `untappdRating` — «0/нечислове → null, 2 знаки» |
| `src/sources/untappd/algolia.ts`, `search.ts`, `scraper.ts`, `export.ts` (зміна) | глобальний рейтинг лише через `untappdRating` |

---

### Task 1: міграція v31 `rating_checked_at`

**Files:**
- Modify: `src/storage/schema.ts` (масив `MIGRATIONS`, після `version: 30`)
- Modify: `src/storage/beers.ts` (`interface BeerRow`)
- Test: `src/storage/schema.test.ts`

**Interfaces:**
- Produces: колонка `beers.rating_checked_at TEXT` (nullable); `BeerRow.rating_checked_at: string | null`.

- [ ] **Step 1: тест на колонку і голову міграцій**

У `src/storage/schema.test.ts` оновити обидва ассерти голови `toBe(30)` → `toBe(31)` (рядки ~532 і
~581) і дописати в їхні коментарі `, 30 -> 31 by #616`. Додати в кінець файлу:

```ts
describe('v31 rating_checked_at (#616)', () => {
  it('adds a nullable beers.rating_checked_at with no backfill', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(beers)').all() as { name: string; notnull: number; dflt_value: unknown }[];
    const col = cols.find((c) => c.name === 'rating_checked_at');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.prepare(`INSERT INTO beers (untappd_id, name, brewery, rating_global, normalized_name, normalized_brewery)
                VALUES (4473, 'Guinness Draught', 'Guinness', 3.77, 'guinness draught', 'guinness')`).run();
    const row = db.prepare('SELECT rating_checked_at FROM beers WHERE untappd_id = 4473').get() as { rating_checked_at: string | null };
    expect(row.rating_checked_at).toBeNull();
  });
});
```

Якщо `openDb`/`migrate` у файлі імпортовані під іншими іменами — іди за файлом.

- [ ] **Step 2: запустити — має впасти**

Run: `npx vitest run src/storage/schema.test.ts`
Expected: FAIL — `expected undefined to be defined` і `expected 30 to be 31`.

- [ ] **Step 3: міграція і тип**

У `src/storage/schema.ts` після об'єкта `version: 30`:

```ts
  {
    version: 31,
    // #616: «рейтинг звірено з Untappd у момент T». Без бекфілу: доказу звірки немає ні в кого —
    // стара джоба рейтингів не штампувала, а синк чекінів до #617 рейтинги стирав.
    sql: `
      ALTER TABLE beers ADD COLUMN rating_checked_at TEXT;
    `,
  },
```

У `src/storage/beers.ts`, `interface BeerRow`, після `rating_refresh_count: number;`:

```ts
  rating_checked_at: string | null;
```

- [ ] **Step 4: повний гейт**

Run: `npm test && npm run typecheck`
Expected: усе зелене. Якщо впав інший тест, що фіксує голову міграцій (`toBe(30)`), — оновити так
само і назвати у звіті.

- [ ] **Step 5: мутація**

Закоментувати `ALTER TABLE beers ADD COLUMN rating_checked_at TEXT;` → `npx vitest run src/storage/schema.test.ts`
→ падає `v31 rating_checked_at (#616)`. Повернути.

- [ ] **Step 6: коміт**

```bash
git add src/storage/schema.ts src/storage/beers.ts src/storage/schema.test.ts
git commit -m "feat(#616): v31 — beers.rating_checked_at, штамп звірки рейтингу з Untappd"
```

---

### Task 2: черга й запис гідратації у сховищі

**Files:**
- Modify: `src/storage/beers.ts` (нові функції поруч із `listRatingRefreshCandidates`)
- Test: `src/storage/beers.test.ts` (нові `describe` у кінці файлу)

**Interfaces:**
- Consumes: `beers.rating_checked_at` (Task 1); `isEligible(now, at, count)` з `src/domain/lookup-backoff.ts`
  (уже імпортований у `beers.ts`); `bumpCatalogVersion()`.
- Produces:
  ```ts
  export const RATING_RECHECK_DAYS = 30;
  export interface RatingHydrationCandidate { id: number; untappd_id: number; rating_refresh_at: string | null; rating_refresh_count: number }
  export function listRatingHydrationCandidates(db: DB, limit: number, now: Date): RatingHydrationCandidate[];
  export interface HydratedRatingFacts { global_rating: number | null; style: string | null; abv: number | null }
  export interface RatingHydrationOutcome { updated: number; changed: number; unknown: number }
  export function applyHydratedRatings(db: DB, hits: Map<number, HydratedRatingFacts>, bids: number[], nowIso: string): RatingHydrationOutcome;
  ```
  `HydratedBeer` із `src/sources/untappd/search.ts` структурно сумісний з `HydratedRatingFacts` —
  сховище не імпортує тип із `sources/`. Спека називає третій параметр `candidates`; план передає
  `bids` (лише їх запис і потребує).

- [ ] **Step 1: тести**

У кінець `src/storage/beers.test.ts`:

```ts
// ---------------------------------------------------------------------------
// #616 — гідратація рейтингів
// ---------------------------------------------------------------------------

import { listRatingHydrationCandidates, applyHydratedRatings, RATING_RECHECK_DAYS } from './beers';
import { catalogVersion } from './catalog-version';

describe('listRatingHydrationCandidates (#616)', () => {
  const NOW = new Date('2026-09-13T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  function seed(
    db: ReturnType<typeof fresh>,
    o: { bid: number | null; name: string; rating: number | null; checkedAt?: string | null; refreshAt?: string | null; refreshCount?: number },
  ): number {
    const id = seedBeer(db, {
      untappd_id: o.bid, name: o.name, brewery: 'Browar Test', style: 'IPA', abv: 6.2,
      rating_global: o.rating, normalized_name: o.name.toLowerCase(), normalized_brewery: 'browar test',
    });
    db.prepare('UPDATE beers SET rating_checked_at = ?, rating_refresh_at = ?, rating_refresh_count = ? WHERE id = ?')
      .run(o.checkedAt ?? null, o.refreshAt ?? null, o.refreshCount ?? 0, id);
    return id;
  }

  test('takes linked rows never checked or checked more than 30 days ago; skips orphans and fresh stamps', () => {
    const db = fresh();
    const never = seed(db, { bid: 101, name: 'Never', rating: 3.9 });
    const stale = seed(db, { bid: 102, name: 'Stale', rating: 3.9, checkedAt: daysAgo(RATING_RECHECK_DAYS + 1) });
    seed(db, { bid: 103, name: 'Fresh', rating: 3.9, checkedAt: daysAgo(RATING_RECHECK_DAYS - 1) });
    seed(db, { bid: null, name: 'Orphan', rating: null });
    expect(listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id).sort()).toEqual([never, stale].sort());
  });

  test('order: missing or zero rating → never checked → oldest checked → id', () => {
    const db = fresh();
    const oldChecked = seed(db, { bid: 201, name: 'Old checked', rating: 4.1, checkedAt: daysAgo(90) });
    const newerChecked = seed(db, { bid: 202, name: 'Newer checked', rating: 4.1, checkedAt: daysAgo(40) });
    const neverChecked = seed(db, { bid: 203, name: 'Never checked', rating: 4.1 });
    const zero = seed(db, { bid: 204, name: 'Zero', rating: 0, checkedAt: daysAgo(40) });
    const missing = seed(db, { bid: 205, name: 'Missing', rating: null });
    // missing (штампа немає) іде перед zero (штамп 40 днів) усередині першої групи — NULL перший при ASC.
    expect(listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id))
      .toEqual([missing, zero, neverChecked, oldChecked, newerChecked]);
  });

  test('a bid Algolia did not know waits out its backoff; exhausted schedule is excluded', () => {
    const db = fresh();
    const waiting = seed(db, { bid: 301, name: 'Waiting', rating: null, refreshAt: daysAgo(1), refreshCount: 1 });
    const due = seed(db, { bid: 302, name: 'Due', rating: null, refreshAt: daysAgo(4), refreshCount: 1 });
    const exhausted = seed(db, { bid: 303, name: 'Exhausted', rating: null, refreshAt: daysAgo(400), refreshCount: 4 });
    const ids = listRatingHydrationCandidates(db, 10, NOW).map((c) => c.id);
    expect(ids).toContain(due);
    expect(ids).not.toContain(waiting);
    expect(ids).not.toContain(exhausted);
  });

  test('respects the limit', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) seed(db, { bid: 400 + i, name: `Beer ${i}`, rating: null });
    expect(listRatingHydrationCandidates(db, 3, NOW)).toHaveLength(3);
  });
});

describe('applyHydratedRatings (#616)', () => {
  const NOW_ISO = '2026-09-13T12:00:00.000Z';

  function seedLinked(db: ReturnType<typeof fresh>, bid: number, o: { rating: number | null; style: string | null; abv: number | null }): number {
    const id = seedBeer(db, {
      untappd_id: bid, name: `Beer ${bid}`, brewery: 'Browar Test', style: o.style, abv: o.abv,
      rating_global: o.rating, normalized_name: `beer ${bid}`, normalized_brewery: 'browar test',
    });
    db.prepare("UPDATE beers SET rating_refresh_at = '2026-09-01T00:00:00.000Z', rating_refresh_count = 2 WHERE id = ?").run(id);
    return id;
  }

  test('overwrites the rating, fills only empty style/abv, stamps and clears the backoff', () => {
    const db = fresh();
    const rated = seedLinked(db, 501, { rating: 3.5, style: 'Pils', abv: 5.0 });
    const bare = seedLinked(db, 502, { rating: null, style: null, abv: null });
    const out = applyHydratedRatings(db, new Map([
      [501, { global_rating: 4.06, style: 'Gose', abv: 4.2 }],
      [502, { global_rating: 3.77, style: 'Stout - Irish Dry', abv: 4.2 }],
    ]), [501, 502], NOW_ISO);
    expect(out).toEqual({ updated: 2, changed: 2, unknown: 0 });
    expect(getBeer(db, rated)).toMatchObject({
      rating_global: 4.06, style: 'Pils', abv: 5.0,
      rating_checked_at: NOW_ISO, rating_refresh_at: null, rating_refresh_count: 0,
    });
    expect(getBeer(db, bare)).toMatchObject({ rating_global: 3.77, style: 'Stout - Irish Dry', abv: 4.2, rating_checked_at: NOW_ISO });
  });

  test('Untappd without a rating (<10 ratings) overwrites a stale number with NULL and stamps', () => {
    const db = fresh();
    const id = seedLinked(db, 601, { rating: 3.64, style: 'IPA', abv: 6.0 });
    applyHydratedRatings(db, new Map([[601, { global_rating: null, style: 'IPA', abv: 6.0 }]]), [601], NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: null, rating_checked_at: NOW_ISO });
  });

  test('a bid missing from the response only advances the backoff', () => {
    const db = fresh();
    const id = seedLinked(db, 701, { rating: 3.9, style: 'IPA', abv: 6.0 });
    const out = applyHydratedRatings(db, new Map(), [701], NOW_ISO);
    expect(out).toEqual({ updated: 0, changed: 0, unknown: 1 });
    expect(getBeer(db, id)).toMatchObject({
      rating_global: 3.9, rating_checked_at: null, rating_refresh_at: NOW_ISO, rating_refresh_count: 3,
    });
  });

  test('bumps the catalog version once when something changed, never when nothing did', () => {
    const db = fresh();
    seedLinked(db, 801, { rating: 3.5, style: 'IPA', abv: 6.0 });
    seedLinked(db, 802, { rating: 3.6, style: 'IPA', abv: 6.0 });
    const hits = new Map([
      [801, { global_rating: 4.0, style: 'IPA', abv: 6.0 }],
      [802, { global_rating: 4.1, style: 'IPA', abv: 6.0 }],
    ]);
    const v0 = catalogVersion();
    applyHydratedRatings(db, hits, [801, 802], NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 1);
    const again = applyHydratedRatings(db, hits, [801, 802], '2026-10-14T12:00:00.000Z');
    expect(again).toEqual({ updated: 2, changed: 0, unknown: 0 });
    expect(catalogVersion()).toBe(v0 + 1);
  });

  test('a bid whose row vanished between selection and write touches nothing', () => {
    const db = fresh();
    const other = seedLinked(db, 901, { rating: 3.9, style: 'IPA', abv: 6.0 });
    const out = applyHydratedRatings(db, new Map([[999, { global_rating: 4.2, style: 'Lager', abv: 5.0 }]]), [999], NOW_ISO);
    expect(out).toEqual({ updated: 0, changed: 0, unknown: 0 });
    expect(getBeer(db, other)).toMatchObject({ rating_global: 3.9, rating_checked_at: null });
  });
});
```

`fresh`, `seedBeer`, `getBeer` уже є у файлі (перевір імена; якщо `getBeer` не імпортований —
додай його в наявний імпорт з `./beers`).

- [ ] **Step 2: запустити — має впасти**

Run: `npx vitest run src/storage/beers.test.ts`
Expected: FAIL — `listRatingHydrationCandidates is not a function` (або помилка імпорту).

- [ ] **Step 3: реалізація**

У `src/storage/beers.ts` після `listRatingRefreshCandidates`:

```ts
// #616: звірка рейтингу злінкованого пива з Untappd (Algolia getObjects за bid). На відміну від
// listRatingRefreshCandidates — без гейту «на крані» і з повторною звіркою наявних рейтингів.
export const RATING_RECHECK_DAYS = 30;

export interface RatingHydrationCandidate {
  id: number;
  untappd_id: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
}

export function listRatingHydrationCandidates(
  db: DB,
  limit: number,
  now: Date,
): RatingHydrationCandidate[] {
  const cutoff = new Date(now.getTime() - RATING_RECHECK_DAYS * 86_400_000).toISOString();
  // Порядок: спершу рядки без рейтингу (0 — наслідок старих записів до межі парсерів, #616),
  // далі ніколи не звірені, далі найдавніше звірені. «Ніколи не звірені» окремого ключа не мають:
  // у SQLite NULL при ASC іде першим. Штампи пишуться toISOString(), тож лексикографічне
  // порівняння рядків = хронологічне.
  const rows = db
    .prepare(
      `SELECT id, untappd_id, rating_refresh_at, rating_refresh_count
       FROM beers
       WHERE untappd_id IS NOT NULL
         AND (rating_checked_at IS NULL OR rating_checked_at < ?)
       ORDER BY (rating_global IS NULL OR rating_global = 0) DESC,
                rating_checked_at ASC,
                id ASC`,
    )
    .all(cutoff) as RatingHydrationCandidate[];
  // rating_refresh_* тепер — бекоф лише для bid, якого Algolia не знає; після успішної звірки
  // count = 0 і at = NULL, тож на решту рядків фільтр не діє.
  return rows
    .filter((r) => isEligible(now, r.rating_refresh_at, r.rating_refresh_count))
    .slice(0, limit);
}

export interface HydratedRatingFacts {
  global_rating: number | null;
  style: string | null;
  abv: number | null;
}

export interface RatingHydrationOutcome {
  updated: number;
  changed: number;
  unknown: number;
}

export function applyHydratedRatings(
  db: DB,
  hits: Map<number, HydratedRatingFacts>,
  bids: number[],
  nowIso: string,
): RatingHydrationOutcome {
  const read = db.prepare('SELECT rating_global, style, abv FROM beers WHERE untappd_id = ?');
  // Рейтинг — перезапис (зокрема NULL: Untappd не показує рейтинг до 10 оцінок); стиль і ABV лише
  // заповнюють порожнє. Пошук за untappd_id (UNIQUE), а не за id вибірки: рядок, злитий між
  // вибіркою й записом, дає 0 змінених рядків, а не запис у чужий рядок.
  const write = db.prepare(
    `UPDATE beers SET
       rating_global = ?,
       style = COALESCE(style, ?),
       abv = COALESCE(abv, ?),
       rating_checked_at = ?,
       rating_refresh_at = NULL,
       rating_refresh_count = 0
     WHERE untappd_id = ?`,
  );
  const backoff = db.prepare(
    `UPDATE beers SET
       rating_refresh_at = ?,
       rating_refresh_count = rating_refresh_count + 1
     WHERE untappd_id = ?`,
  );
  const out: RatingHydrationOutcome = { updated: 0, changed: 0, unknown: 0 };
  db.transaction(() => {
    for (const bid of bids) {
      const before = read.get(bid) as { rating_global: number | null; style: string | null; abv: number | null } | undefined;
      if (!before) continue;
      const hit = hits.get(bid);
      if (!hit) {
        backoff.run(nowIso, bid);
        out.unknown++;
        continue;
      }
      write.run(hit.global_rating, hit.style, hit.abv, nowIso, bid);
      out.updated++;
      const style = before.style ?? hit.style;
      const abv = before.abv ?? hit.abv;
      if (before.rating_global !== hit.global_rating || style !== before.style || abv !== before.abv) {
        out.changed++;
      }
    }
  })();
  // Кеш /match залежить від рейтингу/стилю/ABV, не від штампа: без змін — без перебудови.
  if (out.changed > 0) bumpCatalogVersion();
  return out;
}
```

- [ ] **Step 4: повний гейт**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 5: мутації** (кожна окремо, після кожної — `npx vitest run src/storage/beers.test.ts`, потім повернути)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | прибрати `OR rating_checked_at < ?` (лишити `rating_checked_at IS NULL`) | `takes linked rows never checked…` |
| 2 | прибрати `AND (rating_checked_at IS NULL OR rating_checked_at < ?)` цілком | `takes linked rows never checked…` |
| 3 | прибрати `WHERE untappd_id IS NOT NULL AND` (лишити умову штампа) | `takes linked rows never checked…` |
| 4 | прибрати `OR rating_global = 0` з ORDER BY | `order: missing or zero rating…` |
| 5 | прибрати `(rating_global IS NULL OR rating_global = 0) DESC,` цілком | `order: missing or zero rating…` |
| 6 | `rating_checked_at ASC` → `DESC` | `order: missing or zero rating…` |
| 7 | прибрати `.filter(isEligible…)` | `a bid Algolia did not know waits out its backoff…` |
| 8 | прибрати `.slice(0, limit)` | `respects the limit` |
| 9 | `style = COALESCE(style, ?)` → `style = ?` | `overwrites the rating, fills only empty style/abv…` |
| 10 | `abv = COALESCE(abv, ?)` → `abv = ?` | `overwrites the rating, fills only empty style/abv…` |
| 11 | `rating_global = ?` → `rating_global = COALESCE(?, rating_global)` | `Untappd without a rating…` |
| 12 | прибрати `rating_refresh_count = 0` | `overwrites the rating…` |
| 13 | прибрати `rating_refresh_at = NULL,` | `overwrites the rating…` |
| 14 | прибрати `rating_checked_at = ?,` (і відповідний аргумент) | `overwrites the rating…` та `Untappd without a rating…` |
| 15 | прибрати `backoff.run(nowIso, bid);` | `a bid missing from the response…` |
| 16 | `if (out.changed > 0) bumpCatalogVersion()` → `bumpCatalogVersion()` | `bumps the catalog version once…` |
| 17 | прибрати `bumpCatalogVersion()` | `bumps the catalog version once…` |
| 18 | прибрати `if (!before) continue;` | `a bid whose row vanished…` (лічильник `updated`) |
| 19 | у порівнянні `changed` прибрати `before.rating_global !== hit.global_rating \|\|` | `bumps the catalog version once…` (перший прогін міняє лише рейтинг) |

Мутація, після якої названий тест лишився зеленим, — дефект тесту: дописати тест, повторити.

- [ ] **Step 6: коміт**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#616): черга й запис гідратації рейтингів — перезапис рейтингу, заповнення стилю/ABV, штамп, бекоф невідомого bid"
```

---

### Task 3: джоба `hydrateRatings` (без підключення)

**Files:**
- Create: `src/jobs/hydrate-ratings.ts`
- Test: `src/jobs/hydrate-ratings.test.ts`

**Interfaces:**
- Consumes: `listRatingHydrationCandidates`, `applyHydratedRatings` (Task 2); `HydratedBeer` з
  `src/sources/untappd/search.ts`; `HttpError` з `src/sources/http.ts`; `isBlockStatus` з
  `src/sources/untappd/block.ts`; `CircuitBreaker`, `noopBreaker` з `src/domain/untappd-circuit.ts`.
- Produces:
  ```ts
  export const RATING_HYDRATION_BATCH = 1000;
  export interface HydrateRatingsResult { candidates: number; updated: number; changed: number; unknown: number; blocked: boolean; failed: boolean }
  export interface HydrateRatingsDeps {
    db: DB; log: pino.Logger;
    hydrateByBid: (bids: number[]) => Promise<Map<number, HydratedBeer>>;
    lookupEnabled?: boolean; limit?: number; now?: () => Date; breaker?: CircuitBreaker;
  }
  export function hydrateRatings(deps: HydrateRatingsDeps): Promise<HydrateRatingsResult>;
  ```
  Обв'язка передасть `hydrateByBid: (bids) => algoliaSearch.hydrateByBid(bids)` і `breaker: algoliaBreaker`.

- [ ] **Step 1: тести**

`src/jobs/hydrate-ratings.test.ts`:

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { getBeer } from '../storage/beers';
import { seedBeer } from '../storage/seed-beer.testing';
import { HttpError } from '../sources/http';
import type { HydratedBeer } from '../sources/untappd/search';
import type { CircuitBreaker } from '../domain/untappd-circuit';
import { hydrateRatings, RATING_HYDRATION_BATCH } from './hydrate-ratings';

const silentLog = pino({ level: 'silent' });
const NOW = new Date('2026-09-13T12:00:00.000Z');

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seedLinked(db: ReturnType<typeof fresh>, bid: number, rating: number | null): number {
  return seedBeer(db, {
    untappd_id: bid, name: `Beer ${bid}`, brewery: 'Browar Test', style: 'IPA', abv: 6.2,
    rating_global: rating, normalized_name: `beer ${bid}`, normalized_brewery: 'browar test',
  });
}

function hydrated(bid: number, rating: number | null): HydratedBeer {
  return {
    bid, beer_name: `Beer ${bid}`, brewery_name: 'Browar Test', style: 'IPA', abv: 6.2,
    global_rating: rating, beer_slug: null, brewery_alias: [],
  };
}

function spyBreaker(canAttempt = true) {
  const results: boolean[] = [];
  const breaker: CircuitBreaker = {
    canAttempt: () => canAttempt,
    onResult: (blocked) => { results.push(blocked); },
    state: canAttempt ? 'closed' : 'open',
  };
  return { breaker, results };
}

describe('hydrateRatings (#616)', () => {
  test('writes hydrated ratings, backs off unknown bids and reports a closed breaker', async () => {
    const db = fresh();
    const known = seedLinked(db, 6648348, null);
    const unknown = seedLinked(db, 999999999, 3.9);
    const calls: number[][] = [];
    const { breaker, results } = spyBreaker();
    const res = await hydrateRatings({
      db, log: silentLog, breaker, now: () => NOW,
      hydrateByBid: async (bids) => { calls.push(bids); return new Map([[6648348, hydrated(6648348, 4.06)]]); },
    });
    expect(calls).toHaveLength(1);
    expect([...calls[0]].sort()).toEqual([6648348, 999999999]);
    expect(res).toEqual({ candidates: 2, updated: 1, changed: 1, unknown: 1, blocked: false, failed: false });
    expect(results).toEqual([false]);
    expect(getBeer(db, known)).toMatchObject({ rating_global: 4.06, rating_checked_at: NOW.toISOString() });
    expect(getBeer(db, unknown)).toMatchObject({ rating_global: 3.9, rating_checked_at: null, rating_refresh_count: 1 });
  });

  test('a block trips the breaker and writes nothing', async () => {
    const db = fresh();
    const id = seedLinked(db, 101, 3.5);
    const { breaker, results } = spyBreaker();
    const res = await hydrateRatings({
      db, log: silentLog, breaker, now: () => NOW,
      hydrateByBid: async () => { throw new HttpError(403, 'https://x-dsn.algolia.net/1/indexes/*/objects'); },
    });
    expect(res.blocked).toBe(true);
    expect(results).toEqual([true]);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 3.5, rating_checked_at: null, rating_refresh_at: null, rating_refresh_count: 0 });
  });

  test('a transient failure writes nothing and does not touch the breaker', async () => {
    const db = fresh();
    const id = seedLinked(db, 102, 3.5);
    const { breaker, results } = spyBreaker();
    const res = await hydrateRatings({
      db, log: silentLog, breaker, now: () => NOW,
      hydrateByBid: async () => { throw new Error('socket hang up'); },
    });
    expect(res).toMatchObject({ failed: true, blocked: false, updated: 0 });
    expect(results).toEqual([]);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 3.5, rating_checked_at: null, rating_refresh_count: 0 });
  });

  test('disabled lookup, an open breaker and an empty queue never call Algolia', async () => {
    let called = 0;
    const hydrateByBid = async () => { called++; return new Map<number, HydratedBeer>(); };

    const withRow = fresh();
    seedLinked(withRow, 103, null);
    await hydrateRatings({ db: withRow, log: silentLog, hydrateByBid, lookupEnabled: false, now: () => NOW });
    await hydrateRatings({ db: withRow, log: silentLog, hydrateByBid, breaker: spyBreaker(false).breaker, now: () => NOW });

    const empty = fresh();
    const { breaker, results } = spyBreaker();
    await hydrateRatings({ db: empty, log: silentLog, hydrateByBid, breaker, now: () => NOW });

    expect(called).toBe(0);
    expect(results).toEqual([]);
  });

  test('one request carries at most RATING_HYDRATION_BATCH bids, even with a larger limit', async () => {
    const db = fresh();
    for (let i = 0; i < RATING_HYDRATION_BATCH + 1; i++) seedLinked(db, 10_000 + i, null);
    const sizes: number[] = [];
    await hydrateRatings({
      db, log: silentLog, now: () => NOW, limit: 5000,
      hydrateByBid: async (bids) => { sizes.push(bids.length); return new Map(); },
    });
    expect(sizes).toEqual([RATING_HYDRATION_BATCH]);
  });

  test('passes the limit through when it is below the batch', async () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) seedLinked(db, 20_000 + i, null);
    const sizes: number[] = [];
    await hydrateRatings({
      db, log: silentLog, now: () => NOW, limit: 2,
      hydrateByBid: async (bids) => { sizes.push(bids.length); return new Map(); },
    });
    expect(sizes).toEqual([2]);
  });
});
```

Якщо конструктор `HttpError` у `src/sources/http.ts` має іншу сигнатуру — іди за кодом.
`isBlockStatus(403)` має бути `true` (перевір у `src/sources/untappd/block.ts`; якщо ні — візьми
статус, для якого `true`, і назви в звіті).

- [ ] **Step 2: запустити — має впасти**

Run: `npx vitest run src/jobs/hydrate-ratings.test.ts`
Expected: FAIL — `Cannot find module './hydrate-ratings'`.

- [ ] **Step 3: реалізація**

`src/jobs/hydrate-ratings.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { HydratedBeer } from '../sources/untappd/search';
import { listRatingHydrationCandidates, applyHydratedRatings } from '../storage/beers';
import { HttpError } from '../sources/http';
import { isBlockStatus } from '../sources/untappd/block';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

// #616: звірка рейтингів злінкованого пива з Untappd через Algolia getObjects за bid. Замінює
// refreshTapRatings (HTML-сторінки пива лише для пива на кранах). Межа Algolia — 1000 objectID на
// запит, тож запуск — рівно один запит.
export const RATING_HYDRATION_BATCH = 1000;

export interface HydrateRatingsResult {
  candidates: number;
  updated: number;
  changed: number;
  unknown: number;
  blocked: boolean;
  failed: boolean;
}

export interface HydrateRatingsDeps {
  db: DB;
  log: pino.Logger;
  hydrateByBid: (bids: number[]) => Promise<Map<number, HydratedBeer>>;
  lookupEnabled?: boolean;      // default true
  limit?: number;               // default RATING_HYDRATION_BATCH, ніколи не більше
  now?: () => Date;             // for tests
  breaker?: CircuitBreaker;     // default noopBreaker; обв'язка передає algoliaBreaker
}

const EMPTY: HydrateRatingsResult = {
  candidates: 0, updated: 0, changed: 0, unknown: 0, blocked: false, failed: false,
};

export async function hydrateRatings(deps: HydrateRatingsDeps): Promise<HydrateRatingsResult> {
  if (deps.lookupEnabled === false) {
    deps.log.info('untappd-lookup disabled (UNTAPPD_LOOKUP_ENABLED=false), skipping hydrate-ratings');
    return { ...EMPTY };
  }
  const now = deps.now ?? (() => new Date());
  const breaker = deps.breaker ?? noopBreaker;
  const tickNow = now();
  if (!breaker.canAttempt(tickNow)) {
    deps.log.info('hydrate-ratings skipped (algolia circuit open)');
    return { ...EMPTY };
  }

  const limit = Math.min(deps.limit ?? RATING_HYDRATION_BATCH, RATING_HYDRATION_BATCH);
  const candidates = listRatingHydrationCandidates(deps.db, limit, tickNow);
  if (candidates.length === 0) {
    deps.log.info({ ...EMPTY }, 'hydrate-ratings done');
    return { ...EMPTY };
  }
  const bids = candidates.map((c) => c.untappd_id);

  let hits: Map<number, HydratedBeer>;
  try {
    hits = await deps.hydrateByBid(bids);
  } catch (err) {
    // Блок (після оновлення ключа й проксі в withRecovery) — сигнал breaker'у; інше (5xx, мережа)
    // нічого не каже про блокування. В обох випадках рядки не чіпаються: ні штампа, ні бекофу —
    // наступний запуск просто повторить.
    if (err instanceof HttpError && isBlockStatus(err.status)) {
      breaker.onResult(true, tickNow);
      const res = { ...EMPTY, candidates: candidates.length, blocked: true };
      deps.log.warn({ err, ...res }, 'hydrate-ratings blocked');
      return res;
    }
    const res = { ...EMPTY, candidates: candidates.length, failed: true };
    deps.log.warn({ err, ...res }, 'hydrate-ratings transient failure');
    return res;
  }
  breaker.onResult(false, tickNow);

  const outcome = applyHydratedRatings(deps.db, hits, bids, now().toISOString());
  const res: HydrateRatingsResult = { ...EMPTY, candidates: candidates.length, ...outcome };
  deps.log.info(res, 'hydrate-ratings done');
  return res;
}
```

- [ ] **Step 4: повний гейт**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 5: мутації** (кожна окремо → `npx vitest run src/jobs/hydrate-ratings.test.ts` → повернути)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | прибрати гілку `lookupEnabled === false` | `disabled lookup, an open breaker…` |
| 2 | прибрати гілку `!breaker.canAttempt` | `disabled lookup, an open breaker…` |
| 3 | прибрати ранній вихід `candidates.length === 0` | `disabled lookup, an open breaker…` |
| 4 | `Math.min(…, RATING_HYDRATION_BATCH)` → `deps.limit ?? RATING_HYDRATION_BATCH` | `one request carries at most…` |
| 5 | `Math.min(deps.limit ?? …)` → `RATING_HYDRATION_BATCH` | `passes the limit through…` |
| 6 | прибрати `breaker.onResult(true, tickNow)` | `a block trips the breaker…` |
| 7 | у блок-гілці замість `return res` — провалитися далі (переставити в `hits = new Map()`) | `a block trips the breaker…` (штамп/бекоф) |
| 8 | прибрати `breaker.onResult(false, tickNow)` | `writes hydrated ratings…` |
| 9 | у транзієнт-гілці викликати `breaker.onResult(false, tickNow)` | `a transient failure…` |
| 10 | прибрати `applyHydratedRatings(...)` (outcome = нулі) | `writes hydrated ratings…` |

- [ ] **Step 6: коміт**

```bash
git add src/jobs/hydrate-ratings.ts src/jobs/hydrate-ratings.test.ts
git commit -m "feat(#616): джоба hydrateRatings — один getObjects на ≤1000 bid, Algolia-breaker, без підключення"
```

---

### Task 4: межа парсерів Untappd — «0 = немає рейтингу», 2 знаки (ДИСПАТЧ)

**Files:**
- Create: `src/sources/untappd/rating.ts`, `src/sources/untappd/rating.test.ts`
- Modify: `src/sources/untappd/algolia.ts` (`parseAlgoliaResponse`, `parseHydratedBeer`)
- Modify: `src/sources/untappd/search.ts` (`global_rating` у `parseSearchPage`)
- Modify: `src/sources/untappd/scraper.ts` (`Global Rating` у `parseUserBeersPage`)
- Modify: `src/sources/untappd/export.ts` (`mapCsv`, `mapJson`)
- Test: `algolia.test.ts`, `search.test.ts`, `scraper.test.ts`, `export.test.ts` (у тій самій теці)

**Interfaces:**
- Produces: `export function untappdRating(v: unknown): number | null` у `src/sources/untappd/rating.ts`.
- Не змінює: типи `SearchResult`, `HydratedBeer`, `ScrapedBeer`, `Checkin`; `their_rating` у
  `scraper.ts`; `rating_score` (особиста оцінка) в `export.ts`; `beer-page.ts` (видаляється в
  обв'язці).

- [ ] **Step 1: тест хелпера**

`src/sources/untappd/rating.test.ts`:

```ts
import { untappdRating } from './rating';

describe('untappdRating (#616)', () => {
  test.each([
    [0, null], ['0', null], [-1, null], ['N/A', null], ['', null], [undefined, null], [null, null], [Number.NaN, null], [{}, null],
    [3.29971, 3.3], ['4.26404', 4.26], [4.06, 4.06], [3, 3], [4.995, 5],
  ])('%p → %p', (input, expected) => {
    expect(untappdRating(input)).toBe(expected);
  });
});
```

Якщо `4.995` через двійкову похибку округлюється в `4.99` — заміни пару на `[4.996, 5]` і назви в звіті.

- [ ] **Step 2: тести парсерів**

`algolia.test.ts`, у кінець файлу:

```ts
describe('rating boundary (#616)', () => {
  it('parseAlgoliaResponse: rating_score 0 (<10 ratings) is no rating; others round to 2 decimals', () => {
    const out = parseAlgoliaResponse({
      hits: [
        { bid: 6869890, beer_name: 'Prototype', brewery_name: 'Funky Fluid', type_name: 'IPA', beer_abv: 6, rating_score: 0, rating_count: 4 },
        { bid: 39819, beer_name: 'X', brewery_name: 'Y', type_name: 'IPA', beer_abv: 5, rating_score: 3.29971, rating_count: 71802 },
      ],
    });
    expect(out[0].global_rating).toBeNull();
    expect(out[1].global_rating).toBe(3.3);
  });

  it('parseHydratedBeer: rating_score 0 is no rating', () => {
    const out = parseHydratedBeer({
      bid: 6869890, beer_name: 'Prototype', brewery_name: 'Funky Fluid', type_name: 'IPA', beer_abv: 6, rating_score: 0, rating_count: 4,
    });
    expect(out?.global_rating).toBeNull();
  });
});
```

`search.test.ts`, усередині `describe` з тестом `'global_rating is null when data-rating is "N/A" or unparseable'`, одразу після нього:

```ts
  test('global_rating is null when data-rating is "0" (<10 ratings, #616)', () => {
    const html = `
      <div class="beer-item">
        <div class="beer-details">
          <p class="name"><a href="/b/x/6869890">Prototype</a></p>
          <p class="brewery"><a>Funky Fluid</a></p>
          <p class="style">IPA</p>
        </div>
        <div class="details beer">
          <p class="abv">6% ABV</p>
          <div class="rating">
            <div class="caps" data-rating="0"></div>
          </div>
        </div>
      </div>`;
    const [it] = parseSearchPage(html);
    expect(it.bid).toBe(6869890);
    expect(it.global_rating).toBeNull();
  });
```

`scraper.test.ts` — у тому самому `describe`, одразу після тесту
`'global_rating is null when data-rating is "N/A"'`. Розмітка — як на реальній сторінці `/beers`
для пива з <10 оцінками (знімок профілю 2026-09-13: `<p>Global Rating (N/A)</p>` +
`data-rating="0"`):

```ts
  function userBeerCard(globalLabel: string, globalRating: string): string {
    return `
      <div class="beer-item" data-bid="6869890">
        <div class="beer-details">
          <p class="name"><a href="/b/funky-fluid-prototype/6869890">Prototype</a></p>
          <p class="brewery"><a href="/FunkyFluid">Funky Fluid</a></p>
          <p class="style">IPA - New England / Hazy</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4.5)</p>
              <div class="caps" data-rating="4.5"></div>
            </div>
            <div class="you">
              <p>Global Rating (${globalLabel})</p>
              <div class="caps" data-rating="${globalRating}"></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  test('Global Rating (N/A) rendered as data-rating="0" is no rating; Their Rating is untouched (#616)', () => {
    const [it] = parseUserBeersPage(userBeerCard('N/A', '0'));
    expect(it.bid).toBe(6869890);
    expect(it.global_rating).toBeNull();
    expect(it.their_rating).toBe(4.5);
  });

  test('Global Rating keeps 2 decimals like Algolia (#616)', () => {
    const [it] = parseUserBeersPage(userBeerCard('3.30', '3.29971'));
    expect(it.global_rating).toBe(3.3);
  });
```

`export.test.ts`, у кінець файлу:

```ts
test('global_weighted_rating_score 0 is no rating, others round to 2 decimals — CSV (#616)', async () => {
  const header = 'beer_name,brewery_name,beer_type,beer_abv,rating_score,created_at,venue_name,checkin_id,bid,global_weighted_rating_score';
  const rows = await collectBuffer('csv', Buffer.from(
    `${header}\nPrototype,Funky Fluid,IPA,6,4.25,2026-09-01,,1,6869890,0\nAtak Chmielu,Pinta,AIPA,6.1,4.25,2024-01-01,Cuda,2,567,3.84713\n`,
    'utf8',
  ));
  expect(rows[0].global_rating).toBeNull();
  expect(rows[0].rating_score).toBe(4.25);
  expect(rows[1].global_rating).toBe(3.85);
});

test('global_weighted_rating_score 0 is no rating — JSON (#616)', async () => {
  const json = JSON.stringify([
    { checkin_id: '1', bid: 6869890, beer_name: 'Prototype', brewery_name: 'Funky Fluid', beer_type: 'IPA', beer_abv: 6,
      rating_score: 4.25, global_weighted_rating_score: 0, created_at: '2026-09-01', venue_name: null },
  ]);
  const out = [];
  for await (const r of iterExport(Readable.from(Buffer.from(json, 'utf8')), 'json')) out.push(r);
  expect(out[0].global_rating).toBeNull();
  expect(out[0].rating_score).toBe(4.25);
});
```

- [ ] **Step 3: запустити — має впасти**

Run: `npx vitest run src/sources/untappd`
Expected: FAIL — модуль `./rating` не знайдено; нові тести парсерів дають `0` замість `null` і
`3.29971` замість `3.3`.

- [ ] **Step 4: хелпер**

`src/sources/untappd/rating.ts`:

```ts
// #616: межа, через яку глобальний рейтинг Untappd входить у систему. Untappd не показує рейтинг
// пива з менш ніж 10 оцінками: Algolia віддає `rating_score: 0`, сторінка — «Global Rating (N/A)» з
// `data-rating="0"`. Це «рейтингу немає», а не нуль (виміряно: 257/257 нулів мають rating_count ≤ 9).
// Два знаки: Algolia віддає 2, сторінка — 5; без округлення гідратор і refreshAllUntappd по черзі
// перезаписували б рейтинг різницею в тисячні й скидали кеш /match.
export function untappdRating(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 5: парсери**

`algolia.ts` — додати `import { untappdRating } from './rating';`; у `parseAlgoliaResponse` і
`parseHydratedBeer`: `global_rating: num(h.rating_score),` → `global_rating: untappdRating(h.rating_score),`.

`search.ts` — додати імпорт; у `parseSearchPage`:

```ts
    const global_rating = untappdRating(
      detailsBeer.find('.rating .caps[data-rating]').first().attr('data-rating'),
    );
```

Якщо локальний `parseRating` у `search.ts` після цього не використовується — видалити його (typecheck
з `noUnusedLocals` це покаже; якщо ні — перевір `grep -n parseRating src/sources/untappd/search.ts`).

`scraper.ts` — додати імпорт; цикл `.ratings .you`:

```ts
    details.find('.ratings .you').each((_, you) => {
      const label = $(you).find('p').first().text().trim();
      const raw = $(you).find('.caps[data-rating]').first().attr('data-rating');
      if (/^Their Rating/i.test(label)) their_rating = parseRating(raw);
      else if (/^Global Rating/i.test(label)) global_rating = untappdRating(raw);
    });
```

`export.ts` — додати імпорт; у `mapCsv` і `mapJson`:
`global_rating: numOrNull(r['global_weighted_rating_score']),` → `global_rating: untappdRating(r['global_weighted_rating_score']),`.

- [ ] **Step 6: повний гейт**

Run: `npm test && npm run typecheck`
Expected: усе зелене. Очікувано незмінні: `search.test.ts` `toBeCloseTo(3.984, 2)` (3.98 у межах
допуску); `untappd-lookup.test.ts` з `global_rating: 0` / `4.29273` (готові об'єкти, парсер не
бере участі). Якщо впав інший тест, що фіксує ненульовий рейтинг із >2 знаками через парсер, —
оновити очікування до 2 знаків і назвати у звіті.

- [ ] **Step 7: мутації** (кожна окремо → `npx vitest run src/sources/untappd` → повернути)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | у хелпері `n <= 0` → `n < 0` | `rating.test.ts` (`0 → null`, `'0' → null`) |
| 2 | у хелпері прибрати округлення (`return n`) | `rating.test.ts` (`3.29971 → 3.3`) |
| 3 | `parseAlgoliaResponse` повернути `num(h.rating_score)` | `parseAlgoliaResponse: rating_score 0…` |
| 4 | `parseHydratedBeer` повернути `num(h.rating_score)` | `parseHydratedBeer: rating_score 0…` |
| 5 | `search.ts` повернути `parseRating(...)` | `global_rating is null when data-rating is "0"…` |
| 6 | `scraper.ts` Global Rating → `parseRating(raw)` | `Global Rating (N/A) rendered as data-rating="0"…` і `keeps 2 decimals` |
| 7 | `scraper.ts` прибрати гілку `if (/^Their Rating/i…) their_rating = parseRating(raw);` (лишити `if` лише для Global) | `…Their Rating is untouched` |
| 8 | `mapCsv` повернути `numOrNull(...)` | `…— CSV (#616)` |
| 9 | `mapJson` повернути `numOrNull(...)` | `…— JSON (#616)` |

- [ ] **Step 8: коміт**

```bash
git add src/sources/untappd/rating.ts src/sources/untappd/rating.test.ts \
  src/sources/untappd/algolia.ts src/sources/untappd/algolia.test.ts \
  src/sources/untappd/search.ts src/sources/untappd/search.test.ts \
  src/sources/untappd/scraper.ts src/sources/untappd/scraper.test.ts \
  src/sources/untappd/export.ts src/sources/untappd/export.test.ts
git commit -m "feat(#616): межа парсерів Untappd — рейтинг 0 (<10 оцінок) = немає рейтингу, 2 знаки"
```

---

## Після ядра

Наскрізне рев'ю ядра (задачі 1–4, повний diff від `origin/main`) → лише потім план обв'язки:
крон-слот `hydrateRatings` замість `refreshTapRatings` з `algoliaBreaker`; видалення
`refresh-tap-ratings.ts`, `beer-page.ts`, `recordRating*`, `listRatingRefreshCandidates` і їхніх
тестів; `refreshAllUntappd` (три стани блоку `Global Rating` з `global_rating_shown`, штамп,
`strongerSource` → `checkin`, фікстура `user-beers-na.html` зі знімка профілю); дайджест
`ratingsChecked30d`; `spec.md`.
