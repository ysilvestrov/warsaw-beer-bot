# MCP `/match` — план ядра

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дати власникам per-user токена тулу `match_beers` через MCP-роут `/mcp` у наявному Hono-застосунку бота — з відповіддю, яка розрізняє «не знайшли», «не шукали» і «не знаємо про людину нічого».

**Architecture:** Ядро — три шари без HTTP: домен (`match-list.ts` починає віддавати `source` і `searched`), композиційний корінь (єдиний кеш каталогу на процес), чиста функція тули (`runMatchTool`). Поверх них — SDK-транспорт на Fetch API у stateless-режимі, змонтований одним `app.all('/mcp')`.

**Tech Stack:** Node.js, TypeScript (CommonJS, `module: nodenext`), Hono 4, `@modelcontextprotocol/sdk` 1.30, zod 4, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-10-mcp-match-api-design.md`

## Global Constraints

- **Це стадія ЯДРА.** План на обв'язку (міграція 30, `channel` в обліку, рядок дайджесту, `docs/mcp-uk.md`, `pages.yml`, рядок у `/extension`, `spec.md`) пишеться **після** наскрізного рев'ю цієї стадії, проти коду, який уже існуватиме. Не забігати вперед: у цій стадії **не** чіпати `src/storage/api_usage.ts`, `src/storage/stats.ts`, `src/jobs/daily-status.ts`, `spec.md`, `docs/`.
- **Повний гейт на КОЖНІЙ задачі:** `npm test && npm run typecheck`. Ніколи не звужений прогін (`vitest run <file>` — лише для швидкої перевірки всередині кроку, але задача не вважається завершеною без повного).
- **TDD:** тест пишеться першим і **запускається, щоб побачити падіння**, до реалізації. Кожен тест мутаційно доведений: прибери рядок реалізації — тест має впасти. Якщо не падає — тест порожній, переписати.
- **Сиди з видимими значеннями.** Не сідати `null`/`0` там, де тест перевіряє, чи значення взагалі використали: `null`-дефолт робить «проігноровано» й «використано» нерозрізнимими.
- **Комміти** — українською, називають механізм, а не «fix». Хвіст кожного коміту:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
  ```
- **Ліміти, скопійовані зі спеки дослівно:** `beers` — від 1 до 200 елементів; `brewery`/`name` — до `BEER_TEXT_LIMIT_CHARS` символів; тіло `/mcp` — `MATCH_BODY_LIMIT_BYTES` (256 KiB); `FULL_FALLBACK_BUDGET = 20` на запит.
- **Транспорт:** `sessionIdGenerator: undefined` (stateless) і `enableJsonResponse: true`. Обидва — вимоги спеки, не смак: сесія в пам'яті не переживає деплой, а другий довгоживий шлях крізь cloudflared — це #124.
- **Ніяких нових тул.** Рівно одна: `match_beers`.

## Структура файлів

| Файл | Відповідальність |
|------|------------------|
| `src/domain/match-list.ts` (M) | до результату додаються `source` і `searched` — усе, що знає матчер, але досі не виходило назовні |
| `src/api/index.ts` (M) | композиційний корінь: створює **єдиний** кеш каталогу і роздає його роутам; монтує `/mcp` |
| `src/api/routes/match.ts` (M) | перестає створювати кеш — приймає його аргументом |
| `src/api/mcp/match-tool.ts` (C) | чиста логіка тули: домен → статуси → `profile`; HTTP і MCP не знає |
| `src/api/mcp/server.ts` (C) | збирання `McpServer`, реєстрація `match_beers`, логування |
| `src/api/routes/mcp.ts` (C) | `app.all('/mcp')`: транспорт, `connect`, `handleRequest` |

---

### Task 1: `source` і `searched` у `matchBeerList`

Матчер уже знає обидві речі — `MatchResult.source` і `budget.budgetSkipped` — але жодна не доходить до відповіді. Через це fuzzy-збіг невідрізнимий від exact, а «бюджет вичерпано» — від «не знайдено».

**Розмір:** дрібна (повний код нижче, зміна механічна, нових рішень нема) → контролер робить **інлайн**. Свіжі очі зберігаються: задача **обов'язково** входить у review-пакет Task 2 і називається в диспатчі наскрізного рев'ю.

**Files:**
- Modify: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts`
- Modify (падаючі асерти): `src/api/routes/match.test.ts`

**Interfaces:**
- Produces: `MatchListResult.source: 'exact' | 'fuzzy' | null`, `MatchListResult.searched: boolean` — обидва читає `runMatchTool` (Task 3).

- [ ] **Step 1: Написати падаючі тести**

Додати в `src/domain/match-list.test.ts`, всередину `describe('matchBeerList', …)`:

```ts
  it('reports how the catalog row was reached', async () => {
    const { prepared, byId } = prep(catalog);
    const exact = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(exact.results[0].source).toBe('exact');

    // "Atak Chmiel" (typo) reaches catalog 200 only through the fuzzy stage.
    const fuzzy = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmiel' },
    ]);
    expect(fuzzy.results[0].matched_beer?.id).toBe(200);
    expect(fuzzy.results[0].source).toBe('fuzzy');

    const miss = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'Trzech Kumpli', name: 'Nothing Like This' },
    ]);
    expect(miss.results[0].matched_beer).toBeNull();
    expect(miss.results[0].source).toBeNull();
  });

  it('separates "searched and missed" from "never searched" (fallback budget)', async () => {
    // One-beer catalog; every input has an unknown brewery, so all of them fall to the
    // budgeted full-catalog path. The surplus past the budget is never searched at all.
    const { prepared, byId } = prep([
      { id: 1, brewery: 'Pinta', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
    ]);
    const n = FULL_FALLBACK_BUDGET + 3;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), items);

    expect(res.results.slice(0, FULL_FALLBACK_BUDGET).every((r) => r.searched)).toBe(true);
    expect(res.results.slice(FULL_FALLBACK_BUDGET).map((r) => r.searched)).toEqual([false, false, false]);
    // Both halves look identical on matched_beer — that is exactly the ambiguity being removed.
    expect(res.results.every((r) => r.matched_beer === null)).toBe(true);
  });

  it('an item that matched was, by definition, searched', async () => {
    const { prepared, byId } = prep(catalog);
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
    ]);
    expect(res.results[0].searched).toBe(true);
  });
```

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: FAIL — `source`/`searched` не існують на типі, тести падають на `undefined`.

- [ ] **Step 3: Реалізація**

У `src/domain/match-list.ts` — розширити інтерфейс:

```ts
export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  drunk_uncertain: boolean;
  user_rating: number | null;
  /** How the catalog row was reached; null when nothing matched. */
  source: 'exact' | 'fuzzy' | null;
  /**
   * False when the per-request full-catalog fallback budget (#279) denied this item a
   * search. `matched_beer: null` with `searched: false` means "never looked at", NOT
   * "absent from the catalog" — collapsing the two lets a caller assert what we never checked.
   */
  searched: boolean;
}
```

І тіло циклу в `matchBeerList` — замінити на:

```ts
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    // The budget is shared across the batch, so per-item "was it searched" is read as a
    // delta on the shared counter — no change to matcher.ts is needed.
    const skippedBefore = budget.budgetSkipped;
    const m = matchPrepared(item, prepared, budget);
    const searched = budget.budgetSkipped === skippedBefore;
    if (!m) {
      out.push({
        raw, matched_beer: null, is_drunk: false, drunk_uncertain: false,
        user_rating: null, source: null, searched,
      });
    } else {
      const beer = byId.get(m.id)!;
      out.push({
        raw,
        matched_beer: {
          id: beer.id,
          name: beer.name,
          brewery: beer.brewery,
          rating_global: beer.rating_global,
          untappd_id: beer.untappd_id ?? null,
        },
        is_drunk: m.source === 'exact' && drunkSet.has(m.id),
        drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
        user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
        source: m.source,
        searched,
      });
    }
    await yield_();
  }
```

- [ ] **Step 4: Полагодити асерти, що впали на повному об'єкті**

Поля адитивні, тож падають лише `toEqual` на цілому результаті. Знайти їх:

Run: `grep -rn "drunk_uncertain" src --include=*.test.ts`

У кожному `toEqual`, що перелічує весь об'єкт результату (є в `src/domain/match-list.test.ts` і в `src/api/routes/match.test.ts`), додати `source: 'exact'` (або відповідне значення) і `searched: true`. Асерти на окремі поля (`res.results[0].is_drunk`) не чіпати.

- [ ] **Step 5: Мутаційна перевірка**

Тимчасово замінити `const searched = budget.budgetSkipped === skippedBefore;` на `const searched = true;`.
Run: `npx vitest run src/domain/match-list.test.ts`
Expected: FAIL у тесті `separates "searched and missed" from "never searched"`. Якщо він проходить — тест порожній. Повернути рядок назад.

Те саме для `source: m.source` → `source: 'exact'`: має впасти `reports how the catalog row was reached`.

- [ ] **Step 6: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: PASS обидва.

- [ ] **Step 7: Коміт**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts src/api/routes/match.test.ts
git commit -m "$(cat <<'EOF'
feat(match): вивести назовні source збігу і факт того, що пошук відбувся

matchPrepared уже розрізняє exact і fuzzy, а спільний бюджет уже рахує
пропущені айтеми — але жодне з двох не доходило до відповіді. Через це
fuzzy-збіг був невідрізнимий від exact, а "бюджет вичерпано" — від
"у каталозі нема". Обидва поля адитивні; matcher.ts не змінюється.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 2: Єдиний кеш каталогу в композиційному корені

`createCatalogCache` зараз створюється **всередині** `matchRoute`. Щойно з'явиться другий споживач, у процесі житимуть два незалежні кеші на ~30k підготовлених пив: подвійна пам'ять і подвійна перезбірка на кожен бамп `catalog-version`. Кеш підіймається в `createApiApp` і роздається явним аргументом.

**Розмір:** диспатч (зачіпає композиційний корінь і два тестові файли, і від правильності залежить Task 4).

**Files:**
- Modify: `src/api/routes/match.ts:33-40`
- Modify: `src/api/index.ts`
- Test: `src/api/routes/match.test.ts`, `src/api/index.test.ts`

**Interfaces:**
- Produces: `matchRoute(app: Hono<ApiEnv>, deps: ApiDeps, catalog: CatalogCache): void` — третій аргумент обов'язковий. Task 4 монтує `mcpRoute` з тим самим інстансом.
- Consumes: `CatalogCache` з `src/domain/catalog-cache.ts` (`get(): Promise<CachedCatalog>`, `idle(): Promise<void>`).

- [ ] **Step 1: Написати падаючий тест на ін'єкцію**

Додати в `src/api/routes/match.test.ts` (імпорти `prepareCatalog` з `../../domain/matcher` і `type CatalogCache` з `../../domain/catalog-cache` — додати до наявних):

```ts
  it('matches against the INJECTED catalog cache, never one of its own', async () => {
    // The ghost beer exists only inside the stub cache — it is not in the database at all.
    // If the route built its own cache from `db`, this input could not match anything.
    const db = openDb(':memory:');
    migrate(db);
    ensureProfile(db, 1);
    const ghost = {
      id: 777, brewery: 'Ghost Brewing', name: 'Phantom Ale',
      abv: 5.0, rating_global: 4.2, untappd_id: 4242,
    };
    const stub: CatalogCache = {
      get: async () => ({ prepared: prepareCatalog([ghost]), byId: new Map([[777, ghost]]) }),
      idle: async () => {},
    };
    const app = new Hono<ApiEnv>();
    app.use('/match', async (c, next) => { c.set('telegramId', 1); await next(); });
    matchRoute(app, { db, env: {} as never, log: pino({ level: 'silent' }) }, stub);

    const res = await post(app, { beers: [{ brewery: 'Ghost Brewing', name: 'Phantom Ale' }] });
    expect(res.status).toBe(200);
    const body = await res.json() as { results: { matched_beer: { id: number; rating_global: number } | null }[] };
    expect(body.results[0].matched_beer?.id).toBe(777);
    expect(body.results[0].matched_beer?.rating_global).toBe(4.2);
  });
```

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run src/api/routes/match.test.ts`
Expected: FAIL — `matchRoute` приймає два аргументи, третій не типізовано; після компіляції результат `matched_beer` буде `null`, бо роут матчить по власному кешу з порожньої БД.

- [ ] **Step 3: Реалізація в роуті**

У `src/api/routes/match.ts` — прибрати створення кеша й прийняти його аргументом:

```ts
import type { CatalogCache } from '../../domain/catalog-cache';
```

(рядок `import { createCatalogCache } from '../../domain/catalog-cache';` видалити)

```ts
// Registers POST /match on the given app. Auth is optional here: a missing
// token yields telegramId===null (anonymous, global-only results); a valid
// token yields personal drunk/rating data (see optionalAuthMiddleware).
// The prepared-catalog cache is created ONCE at the composition root and passed in:
// a second instance would double both the memory and the rebuild CPU (~30k rows).
export function matchRoute(app: Hono<ApiEnv>, deps: ApiDeps, cache: CatalogCache): void {
  app.post(
```

Тіло роуту не змінюється — воно вже викликає `cache.get()`.

- [ ] **Step 4: Реалізація в композиційному корені**

У `src/api/index.ts`, у `createApiApp`, **перед** `app.get('/health', …)`:

```ts
  // Single prepared-catalog cache per process, shared by every route that matches.
  // #277 stale-while-revalidate; a second instance would double memory and rebuild CPU.
  const catalog = createCatalogCache(deps.db, {
    onError: (err) => deps.log.error({ err }, 'catalog cache rebuild failed'),
  });
```

Додати імпорт `import { createCatalogCache } from '../domain/catalog-cache';` і змінити виклик:

```ts
  matchRoute(app, deps, catalog);
```

- [ ] **Step 5: Полагодити решту викликів `matchRoute` у тестах**

Run: `grep -rn "matchRoute(" src --include=*.ts`

У `src/api/routes/match.test.ts` наявні хелпери `appAs`/`appAnon` мають передавати справжній кеш над тією ж БД:

```ts
  const catalog = createCatalogCache(db);
```

(створити **один** інстанс у `setup()` і передавати його в обидва хелпери — так тест заразом відображає продакшн-топологію).

- [ ] **Step 6: Сторож композиційного кореня**

Додати в `src/api/index.test.ts` (імпорт `readFileSync` з `node:fs`):

```ts
  it('creates the catalog cache exactly once, and only at the composition root', () => {
    // A route that builds its own cache compiles, passes its own tests, and silently
    // doubles memory + rebuild CPU in production. Only the source can prove it did not.
    const index = readFileSync('src/api/index.ts', 'utf8');
    const match = readFileSync('src/api/routes/match.ts', 'utf8');
    expect(index.match(/createCatalogCache\(/g)).toHaveLength(1);
    expect(match).not.toContain('createCatalogCache');
  });
```

- [ ] **Step 7: Мутаційна перевірка**

Тимчасово повернути `const cache = createCatalogCache(deps.db)` всередину `matchRoute` (і проігнорувати аргумент).
Run: `npx vitest run src/api/routes/match.test.ts src/api/index.test.ts`
Expected: FAIL обидва — і тест ін'єкції, і сторож. Повернути назад.

- [ ] **Step 8: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: PASS обидва.

- [ ] **Step 9: Коміт**

```bash
git add src/api/index.ts src/api/routes/match.ts src/api/routes/match.test.ts src/api/index.test.ts
git commit -m "$(cat <<'EOF'
refactor(api): підняти кеш каталогу в композиційний корінь

matchRoute створював кеш сам, тож будь-який другий споживач каталогу
отримав би власний інстанс: два незалежні кеші на ~30k підготовлених пив,
подвійна пам'ять і подвійна перезбірка на кожен бамп catalog-version.
Кеш тепер створюється один раз у createApiApp і передається аргументом;
сторож у index.test.ts тримає це правило в силі.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 3: `runMatchTool` — статуси, профіль, текстовий рендер

Чиста функція між доменом і MCP. Тут живуть усі три заявки зі спеки: `confidence`, `not_searched` і порожній профіль. Про HTTP і про MCP вона не знає нічого — і тестується без обох.

**Розмір:** диспатч (нових понять багато: п'ять статусів, блок `profile`, правило порожнього профілю).

**Files:**
- Create: `src/api/mcp/match-tool.ts`
- Test: `src/api/mcp/match-tool.test.ts`

**Interfaces:**
- Consumes: `matchBeerList`, `MatchListResult.source`/`.searched` (Task 1); `CatalogCache` (Task 2); `triedBeerIds`/`hadBeerIds` (`src/storage/untappd_had.ts`), `latestRatingsByBeer`/`countCheckins`/`latestCheckinAt` (`src/storage/checkins.ts`).
- Produces: `runMatchTool(db, catalog, telegramId, beers): Promise<MatchToolRun>` і `renderMatchToolText(output): string` — обидва викликає Task 4.

- [ ] **Step 1: Написати падаючі тести**

Створити `src/api/mcp/match-tool.test.ts`:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { mergeCheckin } from '../../storage/checkins';
import { markHad } from '../../storage/untappd_had';
import { prepareCatalog, FULL_FALLBACK_BUDGET } from '../../domain/matcher';
import type { CatalogCache } from '../../domain/catalog-cache';
import type { CatalogBeerWithRating } from '../../domain/match-list';
import { runMatchTool, renderMatchToolText } from './match-tool';

const CATALOG: CatalogBeerWithRating[] = [
  { id: 105, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85, untappd_id: 9001 },
  { id: 200, brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7, untappd_id: 9002 },
];

function cacheOf(rows: CatalogBeerWithRating[]): CatalogCache {
  return {
    get: async () => ({ prepared: prepareCatalog(rows), byId: new Map(rows.map((r) => [r.id, r])) }),
    idle: async () => {},
  };
}

function db0() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  return db;
}

describe('runMatchTool', () => {
  it('an exact match on a beer the user rated is claimed as drunk, with the rating', async () => {
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 105,
      user_rating: 4.0, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.results[0]).toEqual({
      input: { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
      status: 'drunk',
      confidence: 'exact',
      beer: {
        name: 'Pan IPAni', brewery: 'Trzech Kumpli',
        rating_global: 3.85, untappd_url: 'https://untappd.com/beer/9001',
      },
      your_rating: 4.0,
    });
  });

  it('a fuzzy match on a beer in the drunk set is only PROBABLY drunk, and carries no rating', async () => {
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 200,
      user_rating: 4.5, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'PINTA', name: 'Atak Chmiel' },   // typo → fuzzy stage only
    ]);
    expect(output.results[0].status).toBe('probably_drunk');
    expect(output.results[0].confidence).toBe('fuzzy');
    expect(output.results[0].your_rating).toBeNull();
  });

  it('a fuzzy match on a beer the user has NOT drunk still says so — the confidence is the caveat', async () => {
    // This is the case the whole `confidence` field exists for: without it, this row is
    // indistinguishable from an exact "you have not drunk this".
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 105,
      user_rating: 3.0, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'PINTA', name: 'Atak Chmiel' },
    ]);
    expect(output.results[0].status).toBe('not_drunk');
    expect(output.results[0].confidence).toBe('fuzzy');
    expect(output.results[0].beer?.rating_global).toBe(3.7);
  });

  it('an item the fallback budget never searched is not_searched, not not_in_catalog', async () => {
    const db = db0();
    markHad(db, 1, 105, '2026-01-05T18:00:00Z');   // non-empty drunk set, so `unknown` is not in play
    const n = FULL_FALLBACK_BUDGET + 2;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, items);
    expect(output.results.slice(0, FULL_FALLBACK_BUDGET).every((r) => r.status === 'not_in_catalog')).toBe(true);
    expect(output.results.slice(FULL_FALLBACK_BUDGET).map((r) => r.status)).toEqual(['not_searched', 'not_searched']);
  });

  it('an empty drunk set downgrades not_drunk to unknown, and leaves the catalogue answer intact', async () => {
    // A user who installed the MCP but never ran the extension has nothing in
    // checkins ∪ untappd_had. "not_drunk" would be a claim about the person; we only
    // have a claim about our database.
    const db = db0();
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.results[0].status).toBe('unknown');
    expect(output.results[0].confidence).toBe('exact');
    expect(output.results[0].beer?.rating_global).toBe(3.85);
    expect(output.profile).toEqual({ checkins_known: 0, untappd_had_known: 0, latest_checkin_at: null });
  });

  it('reports the profile that "not_drunk" rests on', async () => {
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 105,
      user_rating: 4.0, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    markHad(db, 1, 200, '2026-02-01T10:00:00Z');
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.profile.checkins_known).toBe(1);
    expect(output.profile.untappd_had_known).toBe(1);
    expect(output.profile.latest_checkin_at).toBe('2026-01-05T18:00:00Z');
  });

  it('a beer with no untappd id gets no link rather than a broken one', async () => {
    const db = db0();
    markHad(db, 1, 200, '2026-02-01T10:00:00Z');
    const noLink: CatalogBeerWithRating[] = [
      { id: 300, brewery: 'Nepomucen', name: 'Cytra', abv: 5.2, rating_global: 3.6, untappd_id: null },
    ];
    const { output } = await runMatchTool(db, cacheOf(noLink), 1, [
      { brewery: 'Nepomucen', name: 'Cytra' },
    ]);
    expect(output.results[0].beer?.untappd_url).toBeNull();
  });

  it('the text rendering says out loud that not_searched is not an absence', async () => {
    const db = db0();
    markHad(db, 1, 105, '2026-01-05T18:00:00Z');
    const n = FULL_FALLBACK_BUDGET + 1;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, items);
    const text = renderMatchToolText(output);
    expect(text).toContain('not_searched');
    expect(text).toContain('search budget');
  });
});
```

- [ ] **Step 2: Запустити й побачити падіння**

Run: `npx vitest run src/api/mcp/match-tool.test.ts`
Expected: FAIL — `Cannot find module './match-tool'`.

- [ ] **Step 3: Реалізація**

Створити `src/api/mcp/match-tool.ts`:

```ts
import type { DB } from '../../storage/db';
import type { CatalogCache } from '../../domain/catalog-cache';
import type { FallbackBudget } from '../../domain/matcher';
import { matchBeerList, type MatchInput, type MatchListResult } from '../../domain/match-list';
import { triedBeerIds, hadBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer, countCheckins, latestCheckinAt } from '../../storage/checkins';

/**
 * What we are willing to assert about one submitted beer.
 *
 * `not_in_catalog` and `not_searched` are deliberately separate: the budgeted
 * full-catalog fallback (#279) leaves items unexamined, and reporting those as absent
 * would be an assertion about data we never looked at.
 *
 * `unknown` replaces `not_drunk` when we hold nothing at all about this user's drinking:
 * "you have not drunk this" is a claim about the person, and an empty drunk set does not
 * support it. The catalogue half of the answer is unaffected.
 */
export type MatchStatus =
  | 'drunk' | 'probably_drunk' | 'not_drunk' | 'unknown' | 'not_in_catalog' | 'not_searched';

export interface MatchToolBeer {
  name: string;
  brewery: string;
  rating_global: number | null;
  untappd_url: string | null;
}

export interface MatchToolItem {
  input: { brewery: string; name: string };
  status: MatchStatus;
  /** How sure the match itself is; null when nothing matched. */
  confidence: 'exact' | 'fuzzy' | null;
  beer: MatchToolBeer | null;
  your_rating: number | null;
}

/** The evidence every personal claim above rests on. */
export interface MatchToolProfile {
  checkins_known: number;
  untappd_had_known: number;
  latest_checkin_at: string | null;
}

export interface MatchToolOutput {
  profile: MatchToolProfile;
  results: MatchToolItem[];
}

export interface MatchToolRun {
  output: MatchToolOutput;
  fallback: FallbackBudget;
}

function statusFor(r: MatchListResult, drunkSetEmpty: boolean): MatchStatus {
  if (r.matched_beer === null) return r.searched ? 'not_in_catalog' : 'not_searched';
  if (r.is_drunk) return 'drunk';
  if (r.drunk_uncertain) return 'probably_drunk';
  return drunkSetEmpty ? 'unknown' : 'not_drunk';
}

export async function runMatchTool(
  db: DB,
  catalog: CatalogCache,
  telegramId: number,
  beers: MatchInput[],
): Promise<MatchToolRun> {
  const { prepared, byId } = await catalog.get();
  const drunkSet = triedBeerIds(db, telegramId);       // two-source model: checkins ∪ untappd_had
  const ratings = latestRatingsByBeer(db, telegramId);
  const { results, fallback } = await matchBeerList(prepared, byId, drunkSet, ratings, beers);
  const drunkSetEmpty = drunkSet.size === 0;

  return {
    fallback,
    output: {
      profile: {
        checkins_known: countCheckins(db, telegramId),
        untappd_had_known: hadBeerIds(db, telegramId).size,
        latest_checkin_at: latestCheckinAt(db, telegramId),
      },
      results: results.map((r) => ({
        input: r.raw,
        status: statusFor(r, drunkSetEmpty),
        confidence: r.source,
        beer: r.matched_beer === null ? null : {
          name: r.matched_beer.name,
          brewery: r.matched_beer.brewery,
          rating_global: r.matched_beer.rating_global,
          // beers.untappd_id is the real Untappd id; match_links.untappd_beer_id is a
          // LOCAL beers.id and must never be used to build a link (§5.2).
          untappd_url: r.matched_beer.untappd_id === null
            ? null
            : `https://untappd.com/beer/${r.matched_beer.untappd_id}`,
        },
        your_rating: r.user_rating,
      })),
    },
  };
}

/** Plain-text mirror of the structured output, for clients that only show text. */
export function renderMatchToolText(o: MatchToolOutput): string {
  const lines: string[] = [
    `profile: ${o.profile.checkins_known} check-ins, ${o.profile.untappd_had_known} marked had`
    + `, latest check-in ${o.profile.latest_checkin_at ?? 'none'}`,
  ];
  if (o.profile.checkins_known === 0 && o.profile.untappd_had_known === 0) {
    lines.push('NOTE: nothing is known about this user\'s drinking, so no beer can be reported as undrunk.');
  }
  for (const r of o.results) {
    const beer = r.beer === null
      ? '—'
      : `${r.beer.brewery} / ${r.beer.name}, global ${r.beer.rating_global ?? 'n/a'}`
        + `${r.beer.untappd_url === null ? '' : `, ${r.beer.untappd_url}`}`;
    const rating = r.your_rating === null ? '' : `, your rating ${r.your_rating}`;
    const conf = r.confidence === null ? '' : ` [${r.confidence}]`;
    const caveat = r.status === 'not_searched'
      ? ' (full-catalog search budget exhausted — this beer was never looked up, which is NOT the same as absent)'
      : '';
    lines.push(`- ${r.input.brewery} / ${r.input.name} → ${r.status}${conf}${rating} · ${beer}${caveat}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Запустити тести**

Run: `npx vitest run src/api/mcp/match-tool.test.ts`
Expected: PASS усі вісім.

- [ ] **Step 5: Мутаційна перевірка**

Замінити `return drunkSetEmpty ? 'unknown' : 'not_drunk';` на `return 'not_drunk';`.
Run: `npx vitest run src/api/mcp/match-tool.test.ts`
Expected: FAIL у `an empty drunk set downgrades not_drunk to unknown`. Повернути.

Замінити `r.searched ? 'not_in_catalog' : 'not_searched'` на `'not_in_catalog'`.
Expected: FAIL у `an item the fallback budget never searched…`. Повернути.

- [ ] **Step 6: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: PASS обидва.

- [ ] **Step 7: Коміт**

```bash
git add src/api/mcp/match-tool.ts src/api/mcp/match-tool.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): логіка тули match_beers зі статусами, що не стверджують зайвого

П'ять статусів замість пари булевих полів розширення: not_in_catalog і
not_searched розведені (бюджет fallback лишає айтеми непереглянутими), а
not_drunk вироджується в unknown, коли drunk-set порожній — у користувача,
який ніколи не вмикав розширення, "ти цього не пив" є твердженням про
людину, якого порожня БД не доводить. Блок profile віддає рівно ті
лічильники, на яких ця заявка стоїть.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 4: SDK, MCP-сервер і роут `/mcp`

**Розмір:** диспатч.

**Files:**
- Modify: `package.json` (нова залежність)
- Create: `src/api/mcp/server.ts`
- Create: `src/api/routes/mcp.ts`
- Modify: `src/api/index.ts`
- Test: `src/api/routes/mcp.test.ts`, `src/api/index.test.ts`

**Interfaces:**
- Consumes: `runMatchTool`, `renderMatchToolText`, `MatchToolOutput` (Task 3); `CatalogCache` (Task 2); `authMiddleware` (`src/api/middleware/auth.ts`); `BEER_TEXT_LIMIT_CHARS`, `MATCH_BODY_LIMIT_BYTES` (`src/api/middleware/payload-limit.ts`).
- Produces: `createMcpServer(deps: ApiDeps, catalog: CatalogCache, telegramId: number): McpServer`, `mcpRoute(app: Hono<ApiEnv>, deps: ApiDeps, catalog: CatalogCache): void`.

- [ ] **Step 1: Поставити SDK**

```bash
npm install @modelcontextprotocol/sdk@^1.30.0
```

Перевірити, що це `dependencies`, а не `devDependencies` (сервер потрібен у продакшні):
Run: `node -e "console.log(require('./package.json').dependencies['@modelcontextprotocol/sdk'])"`
Expected: рядок версії, не `undefined`.

- [ ] **Step 2: Написати падаючий тест роуту**

Створити `src/api/routes/mcp.test.ts`:

```ts
import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { markHad } from '../../storage/untappd_had';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { createCatalogCache } from '../../domain/catalog-cache';
import { authMiddleware } from '../middleware/auth';
import { mcpRoute } from './mcp';
import type { ApiEnv } from '../types';
// Never hardcode the protocol version: the SDK rejects an unsupported one, and that
// failure would look like a bug in the route rather than a stale constant in the test.
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  const panIpani = upsertBeer(db, {
    untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
    style: 'IPA', abv: 6.0, rating_global: 3.85,
    normalized_name: normalizeName('Pan IPAni'),
    normalized_brewery: normalizeBrewery('Trzech Kumpli'),
  });
  markHad(db, 1, panIpani, '2026-01-05T18:00:00Z');
  rotateToken(db, 1, hashToken('good-token'), '2026-01-01T00:00:00Z');

  const app = new Hono<ApiEnv>();
  app.use('/mcp', authMiddleware(db));
  mcpRoute(app, { db, env: {} as never, log: pino({ level: 'silent' }) }, createCatalogCache(db));
  return { app, db, panIpani };
}

function rpc(app: Hono<ApiEnv>, body: unknown, token: string | null = 'good-token') {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

describe('POST /mcp', () => {
  it('completes the initialize handshake', async () => {
    const { app } = setup();
    const res = await rpc(app, INIT);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('warsaw-beer');
  });

  it('lists exactly one tool, match_beers', async () => {
    const { app } = setup();
    await rpc(app, INIT);
    const res = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const body = await res.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['match_beers']);
  });

  it('calls match_beers and returns structured results', async () => {
    const { app } = setup();
    await rpc(app, INIT);
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'match_beers', arguments: { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] } },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      result: { structuredContent: { results: { status: string; confidence: string }[] };
                content: { type: string; text: string }[] };
    };
    expect(body.result.structuredContent.results[0].status).toBe('drunk');
    expect(body.result.structuredContent.results[0].confidence).toBe('exact');
    // A text mirror must be present for clients that render only text.
    expect(body.result.content[0].text).toContain('Pan IPAni');
  });

  it('rejects a request with no token', async () => {
    const { app } = setup();
    const res = await rpc(app, INIT, null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a request with an unknown token', async () => {
    const { app } = setup();
    const res = await rpc(app, INIT, 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('serves two consecutive calls on the same app (the per-request server is not shared state)', async () => {
    const { app } = setup();
    await rpc(app, INIT);
    const first = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
    const second = await rpc(app, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const b2 = await second.json() as { result: { tools: { name: string }[] } };
    expect(b2.result.tools).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Запустити й побачити падіння**

Run: `npx vitest run src/api/routes/mcp.test.ts`
Expected: FAIL — `Cannot find module './mcp'`.

- [ ] **Step 4: Реалізувати MCP-сервер**

Створити `src/api/mcp/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiDeps } from '../types';
import type { CatalogCache } from '../../domain/catalog-cache';
import { BEER_TEXT_LIMIT_CHARS } from '../middleware/payload-limit';
import { runMatchTool, renderMatchToolText } from './match-tool';

const TOOL_DESCRIPTION = [
  'Match a list of beers against the Warsaw beer catalog and report, for each one, whether',
  'this user has already drunk it (and how they rated it) plus the beer\'s global rating.',
  '',
  'Split each beer into `brewery` and `name` yourself; both are required. Do not put the',
  'whole title into `name` with an empty `brewery` — a missing brewery pushes the item into',
  'a per-request full-catalog search budget of 20, past which items are returned as',
  '`not_searched` rather than being looked up at all.',
  '',
  'Statuses: `drunk` (certain), `probably_drunk` (the beer matched only approximately),',
  '`not_drunk` (we hold check-in data for this user and this beer is not in it),',
  '`unknown` (we hold NO drinking data for this user — never report these as undrunk),',
  '`not_in_catalog` (searched, not found), `not_searched` (never looked up — do NOT report',
  'these as missing from the catalog). `confidence: fuzzy` means the matched beer may not',
  'be the same beer; say so rather than reporting its rating as fact.',
].join('\n');

export const MCP_SERVER_NAME = 'warsaw-beer';
export const MCP_SERVER_VERSION = '1.0.0';

export function createMcpServer(
  deps: ApiDeps,
  catalog: CatalogCache,
  telegramId: number,
): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    'match_beers',
    {
      title: 'Match beers against the Warsaw beer catalog',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        beers: z
          .array(
            z.object({
              brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
              name: z.string().max(BEER_TEXT_LIMIT_CHARS),
              abv: z.number().optional(),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async ({ beers }) => {
      const { output, fallback } = await runMatchTool(deps.db, catalog, telegramId, beers);
      deps.log.info(
        {
          channel: 'mcp',
          telegramId,
          items: beers.length,
          fullFallback: {
            attempts: fallback.attempts,
            hits: fallback.hits,
            budgetSkipped: fallback.budgetSkipped,
          },
        },
        'match fallback stats',
      );
      return {
        content: [{ type: 'text' as const, text: renderMatchToolText(output) }],
        structuredContent: output as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
```

- [ ] **Step 5: Реалізувати роут**

Створити `src/api/routes/mcp.ts`:

```ts
import type { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ApiDeps, ApiEnv } from '../types';
import type { CatalogCache } from '../../domain/catalog-cache';
import { createMcpServer } from '../mcp/server';

// Registers the MCP endpoint. Unlike /match, auth is mandatory (authMiddleware runs in
// createApiApp): an anonymous answer would report is_drunk=false on every beer, and an
// agent retells that as "you have not drunk any of these" — plausible and wrong.
export function mcpRoute(app: Hono<ApiEnv>, deps: ApiDeps, catalog: CatalogCache): void {
  app.all('/mcp', async (c) => {
    // Same read as /match (`?? null`): a variable no middleware set reads as undefined
    // at runtime even though the type says `number | null`.
    const telegramId = c.get('telegramId') ?? null;
    // Defensive: authMiddleware already 401s. Keeps the route honest if it is ever
    // mounted without it.
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);

    // Stateless: a session lives in process memory, and this process restarts on every
    // deploy — a client holding a session id would get 404 on its next call instead of a
    // transparent reconnect. enableJsonResponse keeps this off SSE: a second long-lived
    // path through cloudflared is exactly what caused the 502s in #124.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(deps, catalog, telegramId);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
```

- [ ] **Step 6: Змонтувати в композиційному корені**

У `src/api/index.ts`, після блоку `/match` і перед `/enrich/*`:

```ts
  // MCP is token-only (no anonymous path) — see routes/mcp.ts for why.
  app.use('/mcp', postPayloadBodyLimit(deps, MATCH_BODY_LIMIT_BYTES));
  app.use('/mcp', authMiddleware(deps.db));
  mcpRoute(app, deps, catalog);
```

Додати імпорт `import { mcpRoute } from './routes/mcp';`.

- [ ] **Step 7: Запустити тести роуту**

Run: `npx vitest run src/api/routes/mcp.test.ts`
Expected: PASS усі шість.

**Якщо тест `calls match_beers` повертає порожнє або обірване тіло** — це означає, що відповідь не буферизується так, як припускає `enableJsonResponse`. Тоді і тільки тоді: не додавати `close()`, а перевірити, що `Accept` у тесті містить обидва типи (`application/json, text/event-stream`) — SDK відмовляє запитам без цього. Записати в повідомленні коміту, що саме довелося змінити.

- [ ] **Step 8: Розширити сторожа композиційного кореня**

У `src/api/index.test.ts` дописати до тесту з Task 2:

```ts
    const mcp = readFileSync('src/api/routes/mcp.ts', 'utf8');
    expect(mcp).not.toContain('createCatalogCache');
```

І додати окремий тест — порядок мідлварів на `/mcp` (композиційний інваріант: ліміт тіла має стояти **перед** автентифікацією, інакше величезне тіло резолвить токен до того, як його відкинули):

```ts
  it('mounts the body limit before auth on /mcp', () => {
    const index = readFileSync('src/api/index.ts', 'utf8');
    const limitAt = index.indexOf("app.use('/mcp', postPayloadBodyLimit");
    const authAt = index.indexOf("app.use('/mcp', authMiddleware");
    expect(limitAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(-1);
    expect(limitAt).toBeLessThan(authAt);
  });
```

- [ ] **Step 9: Мутаційна перевірка**

Видалити рядок `app.use('/mcp', authMiddleware(deps.db));` з `index.ts`.
Run: `npx vitest run src/api/index.test.ts`
Expected: FAIL у тесті порядку мідлварів. Повернути.

У `mcpRoute` замінити `sessionIdGenerator: undefined` на `sessionIdGenerator: () => 'fixed-session-id'`.
Run: `npx vitest run src/api/routes/mcp.test.ts`
Expected: FAIL — другий запит без заголовка сесії відхиляється (`400`/`404`). Це і є доказ, що stateless-режим справді ввімкнено. Повернути.

- [ ] **Step 10: Повний гейт**

Run: `npm test && npm run typecheck`
Expected: PASS обидва.

- [ ] **Step 11: Коміт**

```bash
git add package.json package-lock.json src/api/mcp/server.ts src/api/routes/mcp.ts src/api/index.ts src/api/routes/mcp.test.ts src/api/index.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): роут /mcp з тулою match_beers на stateless-транспорті

app.all('/mcp') над WebStandardStreamableHTTPServerTransport: свіжий
McpServer на запит, нуль стану в пам'яті. sessionIdGenerator: undefined —
бо сесія не переживає деплою і клієнт дістав би 404 замість переконнекту;
enableJsonResponse — щоб не заводити другий довгоживий шлях крізь
cloudflared після #124. Авторизація — наявний authMiddleware, без
анонімного шляху: анонімна відповідь стверджує "ти цього не пив" на
кожній позиції.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

### Task 5: Жива проба — як реальні клієнти показують 401 і чи працює тула

Ця задача **не пише продакшн-коду наперед**. Вона з'ясовує факт про чужі клієнти, який спека залишила відкритим: чи прочитає клієнт голий `401` як «немає токена», чи піде шукати OAuth-метадані й покаже користувачеві помилку не про те. Наперед це не вгадується — тільки підключенням.

**Розмір:** виконує контролер (потрібен реальний термінал і реальні клієнти, не підагент).

**Files:**
- Create: `docs/pr-evidence/<дата>-mcp-client-probe.md` (вивід проби — слід, який не помирає з сесією)
- Modify (лише якщо проба цього вимагатиме): `src/api/routes/mcp.ts`

- [ ] **Step 1: Підняти локально**

```bash
npm run build && node dist/index.js
```

Ендпоінт слухає `127.0.0.1:${API_PORT}` (дефолт 3000).

- [ ] **Step 2: Перевірити прийнятний шлях у Claude Code**

Токен узяти командою `/extension` у боті (або з `api_tokens` тестової БД).

```bash
claude mcp add --transport http warsaw-beer http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <токен>"
```

Далі в сесії Claude Code попросити тулу зматчити три пива й **записати** вивід у файл доказів: чи з'явилася тула в `/mcp`, чи повернулися статуси, чи видно `profile`.

- [ ] **Step 3: Перевірити прийнятний шлях у Codex CLI**

```toml
[mcp_servers.warsaw_beer]
url = "http://127.0.0.1:3000/mcp"
bearer_token_env_var = "WARSAW_BEER_TOKEN"
```

Запустити з `WARSAW_BEER_TOKEN=<токен>` і повторити той самий запит. Записати вивід.

- [ ] **Step 4: Проба 401 — обидва клієнти без токена**

Перепідключити обидва **без** заголовка/токена і записати **дослівно**, що бачить користувач.

Три можливі результати й що робити з кожним:

1. Клієнт каже щось на кшталт «unauthorized / 401» → **нічого не міняємо**, голий 401 достатній.
2. Клієнт іде по `/.well-known/oauth-authorization-server` і показує помилку про OAuth → додати в `mcpRoute` (або в `authMiddleware`-обгортку саме для `/mcp`) заголовок `WWW-Authenticate: Bearer realm="warsaw-beer", error="invalid_token"`, повторити пробу й записати, чи змінилося повідомлення. Тест на присутність заголовка додати в `src/api/routes/mcp.test.ts`.
3. Клієнт мовчки висне або показує порожнечу → записати як є; це вхідні дані для стадії обв'язки (сторінка `docs/mcp-uk.md` має тоді прямо казати, як виглядає забутий токен).

- [ ] **Step 5: Записати докази**

Створити `docs/pr-evidence/<YYYY-MM-DD>-mcp-client-probe.md`: версії обох клієнтів, точні команди, дослівний вивід для прийнятного шляху й для 401, і **обраний висновок з трьох вище**. Це той самий принцип, що й `adjudicate`: вивід живої проби лягає у файл, а не помирає з сесією.

- [ ] **Step 6: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add docs/pr-evidence/ src/api/routes/mcp.ts src/api/routes/mcp.test.ts
git commit -m "$(cat <<'EOF'
docs(mcp): жива проба Claude Code і Codex — прийнятний шлях і поведінка на 401

Спека лишала відкритим, чи прочитає клієнт голий 401 як "немає токена",
чи піде шукати OAuth-метадані. Перевірено підключенням обох клієнтів;
вивід — у docs/pr-evidence, щоб не помер із сесією.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017j2cAZfbxWeSVRKGtGkJS6
EOF
)"
```

---

## Наскрізне рев'ю стадії ядра

Після Task 5 — **одне рев'ю на всю стадію**, свіжими очима, перед тим як писати план на обв'язку. У пакет рев'ю **обов'язково** входить Task 1, зроблена інлайн (вона не мала власного рев'ю).

Питання, які рев'ю має поставити прямо:

1. Чи існує вхід, на якому `status` стверджує більше, ніж доводить `profile`?
2. Чи справді `searched: false` можливий лише через бюджет — чи є інший шлях до `matched_beer: null`, який ми позначаємо як «шукали»?
3. Чи зникає `McpServer`/транспорт після запиту, чи вони накопичуються? (перевірити на 200 послідовних викликах — RSS не має рости монотонно)
4. Чи не з'явився другий `createCatalogCache` де-небудь поза `index.ts`?
5. Чи всі нові тести мутаційно доведені — прибери рядок, впаде тест?

Лише після цього пишеться план стадії обв'язки.
