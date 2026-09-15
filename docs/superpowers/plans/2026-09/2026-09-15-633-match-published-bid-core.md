# #633 ядро: `/match` відповідає за опублікованим крамницею bid — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/match` відповідає рядком опублікованого крамницею Untappd bid: збіг броварні або назви дає `exact`, суперечність броварні — `fuzzy`.

**Architecture:** Перевірка броварні виноситься з `bid-identity.ts` в одну чисту функцію, яку викликають і `resolveByBid`, і `/match`. Кеш каталогу віддає індекс `untappd_id → рядок` з того самого знімка, що `byId`. Правило живе в `matchBeerList` (bid → аліас → матчер), роут лише передає індекс, розширює zod-схему й логує лічильники. Записів у БД зміна не робить.

**Tech Stack:** TypeScript, Node 24, Hono, zod 4, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-15-633-match-published-bid-design.md`

## Global Constraints

- **Ядро — лише сервер.** Розширення (`extension/**`), `spec.md`, чейнджлог і реліз 0.19.0 — окремий план після наскрізного рев'ю ядра.
- **`/match` нічого не пише в БД** і не бампає версію каталогу.
- **Повний гейт після кожної задачі:** `npm test && npm run typecheck` у корені worktree (не звужений до одного файлу). У головному checkout перед цим потрібен `npm install` (там застарілий vitest і немає `@modelcontextprotocol/sdk`).
- **Кожен тест доводиться мутацією:** видали рядок реалізації, який тест має ловити, — тест мусить упасти. Стаби сідай **видимими** значеннями, ніколи `null`, інакше «проігноровано» і «використано» не відрізнити.
- **MCP `match_beers` не змінюється:** `matchBeersArraySchema` лишається без `bid`/`brand`; нові поля живуть лише в тілі `/match`.
- **Заглушка Flasker** — точний рядок `'Імпортне пиво'`, уже є в `src/domain/bid-identity.ts` як `FLASKER_IMPORTED_BEER_PLACEHOLDER`.
- **Коміти:** один на задачу, повідомлення називає механізм, а не файл; наприкінці рядок `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

### Task 1: Спільна перевірка броварні для bid

Гейт броварні сьогодні захований у `breweryAgrees` всередині `bid-identity.ts` і приймає `Candidate`. `/match` має застосовувати **те саме** рішення до рядка каталогу, тому перевірка виноситься в експортовану чисту функцію, а `breweryAgrees` стає її викликом. Заглушка Flasker теж експортується — `/match` мусить розпізнавати її, щоб узяти броварню картки.

**Files:**
- Modify: `src/domain/bid-identity.ts:84-91` (`breweryAgrees`), `:93` (константа заглушки)
- Test: `src/domain/bid-identity.test.ts`

**Interfaces:**
- Consumes: `breweryAliases`, `breweryAliasesMatch` з `./matcher` (уже імпортовані).
- Produces:
  - `export function bidBreweryAgrees(shopBrewery: string, recordBrewery: string, recordAliases?: readonly string[]): boolean`
  - `export const FLASKER_IMPORTED_BEER_PLACEHOLDER = 'Імпортне пиво'`

- [ ] **Step 1: Write the failing test**

Додати в `src/domain/bid-identity.test.ts` (імпорт дописати до наявного рядка `import { resolveByBid } from './bid-identity';`):

```ts
import { resolveByBid, bidBreweryAgrees, FLASKER_IMPORTED_BEER_PLACEHOLDER } from './bid-identity';

describe('bidBreweryAgrees', () => {
  it('agrees on the same brewery and on a record alias', () => {
    expect(bidBreweryAgrees('Mad Brew', 'Mad Brew')).toBe(true);
    expect(bidBreweryAgrees('madbrew', 'Mad Brew', ['madbrew'])).toBe(true);
  });

  it('disagrees when the shop names another brewery', () => {
    expect(bidBreweryAgrees('Mad Brew', 'pHormula')).toBe(false);
  });

  it('disagrees when either side normalizes to nothing (digit-only brewery, #636)', () => {
    // normalizeBrewery('1952') === '' — the gate must not treat two empty keys as a match.
    expect(bidBreweryAgrees('1952', '1952')).toBe(false);
    expect(bidBreweryAgrees('', 'Mad Brew')).toBe(false);
  });

  it('exports the Flasker placeholder brand as a shared constant', () => {
    expect(FLASKER_IMPORTED_BEER_PLACEHOLDER).toBe('Імпортне пиво');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/bid-identity.test.ts`
Expected: FAIL — `bidBreweryAgrees is not a function` / немає експорту `FLASKER_IMPORTED_BEER_PLACEHOLDER`.

- [ ] **Step 3: Write minimal implementation**

У `src/domain/bid-identity.ts` замінити тіло `breweryAgrees` і зробити константу експортованою:

```ts
// The normal veto. The shop can link someone else's beer; it cannot plausibly link a
// beer by a different brewery than the one it names on the same page. Flasker's known
// imported-beer placeholder is handled separately below because it names no brewery.
//
// #633: exported as a pure function because /match applies the SAME decision to a catalog
// row (no DB, no hydration). One definition, so the read path and the write path can never
// drift apart.
export function bidBreweryAgrees(
  shopBrewery: string,
  recordBrewery: string,
  recordAliases: readonly string[] = [],
): boolean {
  const shop = breweryAliases(shopBrewery);
  const record = [
    ...breweryAliases(recordBrewery),
    ...recordAliases.flatMap((a) => breweryAliases(a)),
  ];
  return breweryAliasesMatch(shop, record);
}

function breweryAgrees(brand: string, c: Candidate): boolean {
  return bidBreweryAgrees(brand, c.result.brewery_name, c.aliases);
}

export const FLASKER_IMPORTED_BEER_PLACEHOLDER = 'Імпортне пиво';
```

(Рядок `const FLASKER_IMPORTED_BEER_PLACEHOLDER = 'Імпортне пиво';` на місці 93 видалити — константа тепер оголошена один раз як експорт.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/bid-identity.test.ts`
Expected: PASS, зокрема всі наявні тести `resolveByBid` (вони й доводять, що винесення нічого не змінило).

- [ ] **Step 5: Prove the tests by mutation**

У `bidBreweryAgrees` тимчасово замінити `return breweryAliasesMatch(shop, record);` на `return true;` → мають упасти «disagrees when the shop names another brewery», «digit-only brewery» і наявний `vetoes when the brand names a different brewery`. Повернути код.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: усе зелене.

- [ ] **Step 7: Commit**

```bash
git add src/domain/bid-identity.ts src/domain/bid-identity.test.ts
git commit -m "refactor(#633): the bid brewery gate is one pure function for both the write and the read path"
```

---

### Task 2: Індекс `untappd_id → рядок` у знімку каталогу

`/match` має знайти рядок за bid **у тому самому знімку**, що й решта відповіді: рядок, якого в знімку немає, не можна віддавати як відповідь (його немає і в `byId`, тож `matched_beer` був би зібраний з іншого джерела). Індекс будується там само, де `byId`.

**Files:**
- Modify: `src/domain/catalog-cache.ts:11-16` (`CachedCatalog`), `:79-83` (побудова знімка)
- Modify: `src/api/routes/match.test.ts:69`, `src/api/mcp/match-tool.test.ts:18` — рукописні знімки кешу в тестах
- Test: `src/domain/catalog-cache.test.ts`

**Interfaces:**
- Consumes: `CatalogBeerWithRating` з `./match-list` (уже імпортований тип).
- Produces: `CachedCatalog.byUntappdId: ReadonlyMap<number, CatalogBeerWithRating>` — лише рядки з `untappd_id != null`; ключ — `untappd_id`.

- [ ] **Step 1: Write the failing test**

Додати в `src/domain/catalog-cache.test.ts` у `describe('createCatalogCache', ...)`:

```ts
  it('byUntappdId indexes only linked rows, from the same snapshot as byId (#633)', async () => {
    const cache = make({ getVersion: () => 0, load: () => rows });
    const { byId, byUntappdId } = await cache.get();
    // row 1 is linked (untappd_id 111), row 2 is an orphan (untappd_id null)
    expect(byUntappdId.get(111)).toBe(byId.get(1));
    expect(byUntappdId.size).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/catalog-cache.test.ts`
Expected: FAIL — `byUntappdId` is undefined.

- [ ] **Step 3: Write minimal implementation**

`src/domain/catalog-cache.ts`, інтерфейс:

```ts
export interface CachedCatalog {
  prepared: PreparedCatalog;
  byId: Map<number, CatalogBeerWithRating>;
  // #633: untappd_id → рядок, з ТОГО САМОГО знімка, що byId: відповідь за опублікованим bid
  // не має права вказувати на рядок, якого в цьому знімку немає.
  byUntappdId: ReadonlyMap<number, CatalogBeerWithRating>;
  // #614: пам'ять злиття; matchBeerList перевіряє її до матчера.
  aliases: AliasIndex;
}
```

і в `rebuild`, поруч із `byId`:

```ts
      const byId = new Map(rows.map((r) => [r.id, r]));
      const byUntappdId = new Map<number, CatalogBeerWithRating>();
      for (const r of rows) if (r.untappd_id != null) byUntappdId.set(r.untappd_id, r);
      // #614: аліаси — окремий індекс, а не записи каталогу матчера: matchBeerList перевіряє їх до
      // матчера за точним текстом картки, тож матчер не бачить дублікатів id і не звужує пул броварні.
      const aliases = buildAliasIndex(aliasRows);
      const value: CachedCatalog = { prepared, byId, byUntappdId, aliases };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/catalog-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the test by mutation**

Прибрати умову `if (r.untappd_id != null)` → `byUntappdId.size` стане 2 (ключ `null`), тест упаде на `expect(byUntappdId.size).toBe(1)`. Повернути код.

- [ ] **Step 6: Fix the hand-built snapshots in tests**

Два тести конструюють `CachedCatalog` вручну, тож новий обов'язковий ключ ламає типи. `src/api/routes/match.test.ts:69`:

```ts
      get: async () => ({
        prepared: prepareCatalog([ghost]),
        byId: new Map([[777, ghost]]),
        byUntappdId: new Map(),
        aliases: new Map(),
      }),
```

`src/api/mcp/match-tool.test.ts:18`:

```ts
    get: async () => ({
      prepared: prepareCatalog(rows),
      byId: new Map(rows.map((r) => [r.id, r])),
      byUntappdId: new Map(rows.filter((r) => r.untappd_id != null).map((r) => [r.untappd_id!, r])),
      aliases: new Map(),
    }),
```

(`src/domain/match-list.test.ts:9` НЕ чіпати: він будує аргументи `matchBeerList`, а не знімок кешу.)

- [ ] **Step 7: Full gate**

Run: `npm test && npm run typecheck`
Expected: зелене. Якщо typecheck показує ще одне місце, що будує `CachedCatalog`, — дописати поле там само.

- [ ] **Step 8: Commit**

```bash
git add src/domain/catalog-cache.ts src/domain/catalog-cache.test.ts src/api/routes/match.test.ts src/api/mcp/match-tool.test.ts
git commit -m "feat(#633): the catalog snapshot carries an untappd_id index beside byId"
```

---

### Task 3: Правило відповіді за bid у `matchBeerList`

Серце зміни. Порядок: bid → аліас #614 → матчер. Кроки з дизайну:

1. доказ броварні — `brand`, а для порожнього `brand` чи заглушки — броварня картки;
2. збіг → `exact` на рядку bid, аліас і матчер не запускаються (бюджет фолбеку не витрачається);
3. розбіжність, але аліас/матчер дали **той самий** рядок → `exact` на рядку bid;
4. інакше → рядок bid як `fuzzy` (`is_drunk: false`, `user_rating: null`, `drunk_uncertain` — чи рядок у drunk-множині).

**Files:**
- Modify: `src/domain/match-list.ts` (типи `MatchInput`, `MatchListOptions`, `MatchListOutcome`; тіло `matchBeerList`)
- Test: `src/domain/match-list.test.ts`

**Interfaces:**
- Consumes: `bidBreweryAgrees`, `FLASKER_IMPORTED_BEER_PLACEHOLDER` (Task 1); `byUntappdId` (Task 2).
- Produces:
  - `MatchInput` дістає `bid?: number` і `brand?: string`;
  - `MatchListOptions` дістає `byUntappdId?: ReadonlyMap<number, CatalogBeerWithRating>`;
  - `MatchListOutcome` дістає `bid: { sent: number; exact: number; conflict: number }`.

- [ ] **Step 1: Write the failing test**

Додати в `src/domain/match-list.test.ts`. Каталог тестів — окремий, з двома злінкованими рядками й «чужим» рядком, який виграє за назвою:

```ts
const bidCatalog: CatalogBeerWithRating[] = [
  { id: 300, brewery: 'pHormula', name: 'Bosbes', abv: 6.0, rating_global: 4.1, untappd_id: 4333527 },
  { id: 301, brewery: 'Mad Brew', name: 'Bosbes', abv: 6.0, rating_global: 3.2, untappd_id: 999001 },
  { id: 302, brewery: 'Mad Brew', name: 'Harissa', abv: 5.0, rating_global: 3.9, untappd_id: 999002 },
];

function prepBid() {
  const byId = new Map(bidCatalog.map((c) => [c.id, c]));
  const byUntappdId = new Map(bidCatalog.filter((c) => c.untappd_id != null).map((c) => [c.untappd_id!, c]));
  return { prepared: prepareCatalog(bidCatalog), byId, byUntappdId };
}

describe('matchBeerList — published bid (#633)', () => {
  it('a bid whose brewery agrees wins over an exact name match on another row', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set([300]), new Map([[300, 4.5]]),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 4333527, brand: 'pHormula' }],
      { byUntappdId },
    );
    // name alone would give 301 (Mad Brew / Bosbes); the bid names 300 and its brand agrees.
    expect(res.results[0].matched_beer?.id).toBe(300);
    expect(res.results[0].source).toBe('exact');
    expect(res.results[0].is_drunk).toBe(true);
    expect(res.results[0].user_rating).toBe(4.5);
    expect(res.bid).toEqual({ sent: 1, exact: 1, conflict: 0 });
  });

  it('a placeholder brand falls back to the card brewery as evidence', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'pHormula', name: 'Something Else', bid: 4333527, brand: 'Імпортне пиво' }],
      { byUntappdId },
    );
    expect(res.results[0].matched_beer?.id).toBe(300);
    expect(res.results[0].source).toBe('exact');
  });

  it('a conflicting brewery still gives exact when the name landed on the bid row', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set([301]), new Map([[301, 3.0]]),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 999001, brand: 'VibrantPour' }],
      { byUntappdId },
    );
    // brand VibrantPour disagrees with Mad Brew, but the name route reached row 301 itself.
    expect(res.results[0].matched_beer?.id).toBe(301);
    expect(res.results[0].source).toBe('exact');
    expect(res.results[0].is_drunk).toBe(true);
    expect(res.results[0].user_rating).toBe(3.0);
    expect(res.bid).toEqual({ sent: 1, exact: 1, conflict: 0 });
  });

  it('a conflicting brewery with a different name match reads as fuzzy on the bid row', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const res = await matchBeerList(
      prepared, byId, new Set([302]), new Map([[302, 4.2]]),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 999002, brand: 'Pastry Mastery' }],
      { byUntappdId },
    );
    expect(res.results[0].matched_beer?.id).toBe(302);
    expect(res.results[0].source).toBe('fuzzy');
    expect(res.results[0].is_drunk).toBe(false);
    expect(res.results[0].user_rating).toBeNull();
    expect(res.results[0].drunk_uncertain).toBe(true); // 302 is in the drunk set
    expect(res.bid).toEqual({ sent: 1, exact: 0, conflict: 1 });
  });

  it('a bid outside the snapshot changes nothing', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const withBid = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'Mad Brew', name: 'Bosbes', bid: 123456, brand: 'Mad Brew' }],
      { byUntappdId },
    );
    const without = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'Mad Brew', name: 'Bosbes' }],
      { byUntappdId },
    );
    expect(withBid.results).toEqual(without.results);
    expect(withBid.bid).toEqual({ sent: 1, exact: 0, conflict: 0 });
  });

  it('an agreeing bid beats the #614 alias for the same card', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const aliases = buildAliasIndex([
      { beer_id: 302, brewery_text: cardText('Mad Brew'), name_text: cardText('Bosbes'), abv_key: cardAbv(6) },
    ]);
    const res = await matchBeerList(
      prepared, byId, new Set(), new Map(),
      [{ brewery: 'Mad Brew', name: 'Bosbes', abv: 6, bid: 999001, brand: 'Mad Brew' }],
      { byUntappdId, aliases },
    );
    expect(res.results[0].matched_beer?.id).toBe(301); // the bid row, not the alias target 302
    expect(res.results[0].source).toBe('exact');
  });

  it('an agreeing bid spends no full-catalog fallback budget', async () => {
    const { prepared, byId, byUntappdId } = prepBid();
    const items = Array.from({ length: FULL_FALLBACK_BUDGET + 5 }, () => ({
      brewery: 'pHormula', name: 'Bosbes', bid: 4333527, brand: 'pHormula',
    }));
    const res = await matchBeerList(prepared, byId, new Set(), new Map(), items, { byUntappdId });
    expect(res.fallback.attempts).toBe(0);
    expect(res.fallback.budgetSkipped).toBe(0);
    expect(res.results.every((r) => r.matched_beer?.id === 300)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: FAIL — `res.bid` is undefined, `byUntappdId` не приймається типом опцій.

- [ ] **Step 3: Write minimal implementation**

`src/domain/match-list.ts`. Імпорт:

```ts
import { bidBreweryAgrees, FLASKER_IMPORTED_BEER_PLACEHOLDER } from './bid-identity';
```

Типи:

```ts
export interface MatchInput {
  brewery: string;
  name: string;
  abv?: number | null;
  /** #633: Untappd id, який крамниця публікує на сторінці товару. */
  bid?: number;
  /** #633: brand зі сторінки товару — доказ броварні, проти якого перевіряється bid. */
  brand?: string;
}

/** #633: скільки карток несли bid і чим це скінчилося. Для лічильників у лозі роуту. */
export interface BidStats {
  sent: number;
  exact: number;
  conflict: number;
}

export interface MatchListOptions {
  // DI seam so tests can count yields deterministically; production uses the default.
  yield?: () => Promise<void>;
  // #614: пам'ять злиття. Перевіряється до матчера; без неї — поведінка як до #614.
  aliases?: AliasIndex;
  // #633: untappd_id → рядок того самого знімка каталогу. Без нього bid ігнорується.
  byUntappdId?: ReadonlyMap<number, CatalogBeerWithRating>;
}

export interface MatchListOutcome {
  results: MatchListResult[];
  fallback: FallbackBudget;
  bid: BidStats;
}
```

Доказ броварні:

```ts
// #633: доказ броварні для опублікованого bid — brand зі сторінки товару. Заглушка Flasker
// «Імпортне пиво» — не броварня, а розділ вітрини, тож для неї (і для порожнього brand) доказом
// стає броварня самої картки, яку клієнт і так надсилає.
function bidEvidenceBrewery(item: MatchInput): string {
  const brand = (item.brand ?? '').trim();
  return brand === '' || brand === FLASKER_IMPORTED_BEER_PLACEHOLDER ? item.brewery : brand;
}
```

Тіло `matchBeerList` — замінити цілком:

```ts
export async function matchBeerList(
  prepared: PreparedCatalog,
  byId: Map<number, CatalogBeerWithRating>,
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
  opts: MatchListOptions = {},
): Promise<MatchListOutcome> {
  const yield_ = opts.yield ?? yieldToEventLoop;
  const budget = createFallbackBudget();
  const bid: BidStats = { sent: 0, exact: 0, conflict: 0 };
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const exactOn = (beer: CatalogBeerWithRating): MatchListResult => ({
      raw,
      matched_beer: toMatchedBeer(beer),
      is_drunk: drunkSet.has(beer.id),
      drunk_uncertain: false,
      user_rating: ratingByBeerId.get(beer.id) ?? null,
      source: 'exact',
      searched: true,
    });

    // #633: рядок опублікованого bid — лише з цього знімка каталогу.
    const bidRow = item.bid === undefined ? null : (opts.byUntappdId?.get(item.bid) ?? null);
    if (item.bid !== undefined) bid.sent++;

    // Крок 2: броварня картки підтверджує bid — відповідь готова, матчер не потрібен,
    // бюджет фолбеку не витрачається.
    if (bidRow && bidBreweryAgrees(bidEvidenceBrewery(item), bidRow.brewery)) {
      bid.exact++;
      out.push(exactOn(bidRow));
      await yield_();
      continue;
    }

    const viaAlias = aliasTarget(opts.aliases, item, byId);
    let result: MatchListResult;
    if (viaAlias) {
      result = exactOn(viaAlias);
    } else {
      // The budget is shared across the batch, so per-item "was it searched" is read as a
      // delta on the shared counter — no change to matcher.ts is needed.
      const skippedBefore = budget.budgetSkipped;
      const m = matchPrepared(item, prepared, budget);
      const searched = budget.budgetSkipped === skippedBefore;
      if (!m) {
        result = {
          raw, matched_beer: null, is_drunk: false, drunk_uncertain: false,
          user_rating: null, source: null, searched,
        };
      } else {
        const beer = byId.get(m.id)!;
        result = {
          raw,
          matched_beer: toMatchedBeer(beer),
          is_drunk: m.source === 'exact' && drunkSet.has(m.id),
          drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
          user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
          source: m.source,
          searched,
        };
      }
    }

    if (bidRow) {
      if (result.matched_beer?.id === bidRow.id) {
        // Крок 3: bid і назва вказали на один рядок — два незалежні докази, тож exact
        // (назва могла дійти туди fuzzy: броварня з самих цифр, заглушка).
        bid.exact++;
        result = exactOn(bidRow);
      } else {
        // Крок 4: броварня суперечить bid, і назва повела в інший бік. Пиво ми знайшли, але
        // впевненості немає: рядок bid віддається як fuzzy — ✅ не ставиться ніколи, а ❓
        // з'являється рівно за наявним правилом (fuzzy + випите).
        bid.conflict++;
        result = {
          raw,
          matched_beer: toMatchedBeer(bidRow),
          is_drunk: false,
          drunk_uncertain: drunkSet.has(bidRow.id),
          user_rating: null,
          source: 'fuzzy',
          searched: true,
        };
      }
    }

    out.push(result);
    await yield_();
  }
  return { results: out, fallback: budget, bid };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/match-list.test.ts`
Expected: PASS, включно з усіма наявними тестами (картка без `bid` іде тим самим шляхом, що раніше).

- [ ] **Step 5: Prove each rule by mutation**

По черзі, повертаючи код після кожної:
- у кроці 2 замінити умову на `if (false)` → падає «a bid whose brewery agrees wins over an exact name match» і «spends no full-catalog fallback budget»;
- у `bidEvidenceBrewery` повернути завжди `item.brand ?? ''` → падає «placeholder brand falls back to the card brewery»;
- у кроці 3 замінити `result = exactOn(bidRow);` на `/* нічого */` → падає «conflicting brewery still gives exact when the name landed on the bid row» (лишиться fuzzy);
- у кроці 4 поставити `drunk_uncertain: false` → падає «reads as fuzzy on the bid row»;
- прибрати `if (item.bid !== undefined) bid.sent++;` → падає «a bid outside the snapshot changes nothing».

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: зелене. Очікувана поломка типів — виклик `matchBeerList` у `src/api/mcp/match-tool.ts` і `src/api/routes/match.ts` деструктурує `{ results, fallback }`: це й далі валідно, нового поля вони не читають.

- [ ] **Step 7: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "feat(#633): a published bid answers /match — agreeing brewery or name gives exact, a conflict reads as fuzzy"
```

---

### Task 4: Роут `/match` приймає `bid` і `brand` і логує лічильники

Схема однієї картки виноситься окремо, щоб `/match` міг її розширити, а MCP лишився на вузькій. Роут передає `byUntappdId` у домен і додає `bid` у наявний рядок логу `match fallback stats` — це єдиний спосіб перевірити ефект після релізу.

**Files:**
- Modify: `src/api/match-input.ts`, `src/api/routes/match.ts:18` (схема тіла), `:46` (знімок кешу), `:53-65` (виклик і лог)
- Test: `src/api/routes/match.test.ts`; Create: `src/api/match-input.test.ts` (перевірка, що спільна схема не дістала полів — у репо немає `src/api/mcp/server.test.ts`)

**Interfaces:**
- Consumes: `MatchListOutcome.bid` (Task 3), `CachedCatalog.byUntappdId` (Task 2).
- Produces: `matchBeerItemSchema` (експорт із `src/api/match-input.ts`) — базова схема картки; `matchBeersArraySchema` лишається масивом **базових** карток для MCP.

- [ ] **Step 1: Write the failing test**

Додати в `src/api/routes/match.test.ts` (у наявному `describe`; `setup()` уже сідає `panIpani` з `untappd_id: 9001` і чекіном користувача 1):

```ts
  it('answers by the shop-published bid when the brand agrees (#633)', async () => {
    const { appAs, db } = setup();
    // A second, wrong row that wins on name alone: same name, different brewery, no link.
    seedBeer(db, {
      untappd_id: null, name: 'Pan IPAni', brewery: 'Inny Browar',
      style: 'IPA', abv: 6.0, rating_global: null,
      normalized_name: normalizeName('Pan IPAni'),
      normalized_brewery: normalizeBrewery('Inny Browar'),
    });
    const res = await post(appAs(1), {
      beers: [{ brewery: 'Inny Browar', name: 'Pan IPAni', bid: 9001, brand: 'Trzech Kumpli' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0].matched_beer.untappd_id).toBe(9001);
    expect(body.results[0].source).toBe('exact');
    expect(body.results[0].is_drunk).toBe(true);
  });

  it('logs bid counters on the fallback stats line (#633)', async () => {
    const info = vi.fn();
    const log = { ...pino({ level: 'silent' }), info, warn: vi.fn() } as never;
    const { appAs } = setup(log);
    await post(appAs(1), {
      beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni', bid: 9001, brand: 'Trzech Kumpli' }],
    });
    const stats = info.mock.calls.find(([, msg]) => msg === 'match fallback stats');
    expect(stats?.[0].bid).toEqual({ sent: 1, exact: 1, conflict: 0 });
  });

  it('rejects a malformed bid but keeps brand optional (#633)', async () => {
    const { appAs } = setup();
    expect((await post(appAs(1), {
      beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni', bid: -5 }],
    })).status).toBe(400);
    expect((await post(appAs(1), {
      beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni', bid: 9001 }],
    })).status).toBe(200);
  });
```

І новий файл `src/api/match-input.test.ts` — схема, яку MCP-тула віддає як `inputSchema`
(`src/api/mcp/server.ts:44`), не має приймати опубліковані крамницею поля:

```ts
import { matchBeersArraySchema } from './match-input';

describe('matchBeersArraySchema (shared with the MCP match_beers tool)', () => {
  it('does not accept a published bid or brand (#633)', () => {
    const parsed = matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', bid: 9001, brand: 'X' }]);
    expect(parsed[0]).toEqual({ brewery: 'B', name: 'N' });
  });

  it('still takes the fields the MCP tool sends', () => {
    expect(matchBeersArraySchema.parse([{ brewery: 'B', name: 'N', abv: 5 }])[0].abv).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/api/routes/match.test.ts src/api/match-input.test.ts`
Expected: FAIL — `bid` відкидається схемою, тож відповідь приходить за назвою (`matched_beer.untappd_id` буде `null`), а `stats.bid` — `undefined`.

- [ ] **Step 3: Write minimal implementation**

`src/api/match-input.ts`:

```ts
import { z } from 'zod';
import { BEER_TEXT_LIMIT_CHARS } from './middleware/payload-limit';

// Shared by POST /match (routes/match.ts, wrapped in z.object({ beers: ... }) for
// zValidator) and the MCP match_beers tool (mcp/server.ts, used directly as the raw
// shape registerTool expects). One definition of the per-item text cap and the batch
// bounds, so a limit change reaches both call sites instead of silently diverging.
//
// #633: /match extends the ITEM (bid + brand) in its own module; the MCP tool keeps the
// base item — an AI agent has no shop page and therefore no published bid.
export const matchBeerItemSchema = z.object({
  brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
  name: z.string().max(BEER_TEXT_LIMIT_CHARS),
  abv: z.number().optional(),
});

export const matchBeersArraySchema = z.array(matchBeerItemSchema).min(1).max(200);
```

`src/api/routes/match.ts`:

```ts
import { matchBeerItemSchema } from '../match-input';

// #633: опубліковані крамницею поля живуть лише тут. `bid` — строго ціле додатне (машинно
// витягнуте з URL, як в /enrich/*); `brand` — доказ броварні, проти якого його перевіряють.
const MatchBody = z.object({
  beers: z
    .array(
      matchBeerItemSchema.extend({
        bid: z.number().int().positive().optional(),
        brand: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
      }),
    )
    .min(1)
    .max(200),
});
```

(Дописати `BEER_TEXT_LIMIT_CHARS` до наявного імпорту з `../middleware/payload-limit`.)

У хендлері:

```ts
    const { prepared, byId, byUntappdId, aliases } = await cache.get();
```

```ts
    const { results, fallback, bid } = await matchBeerList(prepared, byId, drunkSet, ratings, beers, {
      aliases,
      byUntappdId,
    });
    deps.log.info(
      {
        channel: 'extension',
        items: beers.length,
        fullFallback: {
          attempts: fallback.attempts,
          hits: fallback.hits,
          budgetSkipped: fallback.budgetSkipped,
        },
        // #633: скільки карток несли опублікований bid, скільки з них дали exact і скільки —
        // суперечність броварні. Єдиний спосіб побачити ефект зміни на проді.
        bid,
      },
      'match fallback stats',
    );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/api/routes/match.test.ts src/api/match-input.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the tests by mutation**

- прибрати `.extend({ ... })` у `MatchBody` → падає «answers by the shop-published bid»;
- прибрати `bid,` з об'єкта логу → падає «logs bid counters»;
- додати `bid`/`brand` у `matchBeerItemSchema` → падає тест MCP-схеми.

- [ ] **Step 6: Full gate**

Run: `npm test && npm run typecheck`
Expected: зелене.

- [ ] **Step 7: Commit**

```bash
git add src/api/match-input.ts src/api/match-input.test.ts src/api/routes/match.ts src/api/routes/match.test.ts
git commit -m "feat(#633): /match takes the shop-published bid and brand, and logs what they answered"
```

---

## Після задач: наскрізне рев'ю ядра

Рев'ю всієї гілки свіжими очима (окремий агент), пакет: задачі 1–4 разом зі спекою. Питання, які рев'ю має закрити:

1. Чи може відповідь за bid вказати на рядок, якого немає в `byId` цього знімка?
2. Чи лишилася поведінка картки **без** `bid` побітово тією самою (аліас, матчер, бюджет, `searched`)?
3. Чи не може крок 4 віддати `is_drunk: true` або особисту оцінку?
4. Чи узгоджені два виклики гейту (`resolveByBid` і `/match`) на тих самих парах броварень?
5. Чи не витікає `bid`/`brand` у MCP-схему або в `/enrich/*`?

Після рев'ю — реплей `~/warsaw-beer-probes/633/probe633.mts` і `conflict-replay.mts` проти коду гілки: розподіл кроків 2/3/4 має збігатися з доказами 2–3 у спеці.

Далі — окремий план на обв'язку: розширення (`RawBeer`, `content/index.ts`), `spec.md`, `extension/CHANGELOG.md`, перевірка інструкцій, деплой і реліз 0.19.0.
