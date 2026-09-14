# Пам'ять злиття для карток крамниць — план периферії (#614)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** картка крамниці з аліасом більше ніколи не стає сиротою: `/enrich/*` знаходять її канонічний рядок
тим самим ключем, що `/match`; сирота з текстом картки аліас не вимикає; суперечливий bid на аліасі
репарує лише аліас; уся петля закрита наскрізним тестом через роути; `spec.md` описує аліаси.

**Architecture:** **периферія** стадійної зміни, після ядра (`d5f39d4`). Проби засновків через справжні роути
(`scratchpad/periph-premise.mts`, `periph-abvtwin.mts`, `periph-e2e.mts`) спростували примітку спеки «ядро
безпечне для деплою окремо»: `/enrich/candidates` створює сироту з текстом картки (повторний раунд після
SWR-`null` кешу, суперечливий bid, ABV-близнюк), правило «рядок важить більше» вимикає нею аліас, і `/match`
віддає сироту `exact` без ✅. Дві незалежні зміни закривають це: правило рахує лише злінковані рядки (Task 17)
і `ensureBeerRow` перевіряє аліас до `ensureOrphan` (Task 18). Ядро й периферія — один PR.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Hono, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md` — розділи «Читання»,
«`/enrich/*` (периферія)», «Заявка → доказ», «Документи», «Рев'ю ядра» п. 8.

## Global Constraints

- **Коментарі українською, ідентифікатори англійською**, як у решті репо.
- **Повний гейт після КОЖНОЇ задачі** (`npm test` і `npm run typecheck`), ніколи не звужений.
- **Кожен тест мутаційно доведений.** Фільтр `-t` перевіряй за рядком `Tests N failed | M passed`: фільтр, що
  не збігся з назвою, мовчки не запускає нічого. Дужки в `-t` — групи регулярного виразу.
- **Сіди з видимими значеннями**, не `null` там, де значення щось доводить.
- **Ключ аліасу ніколи не проходить через `normalizeName`/`normalizeBrewery`.** Ключ = `cardText(brewery)`,
  `cardText(name)`, `cardAbv(abv)` сирого ABV картки — рівно як у `/match` (`aliasTarget` у `match-list.ts`).
- **Канонічний рядок репарація аліасу не змінює ніколи.**
- **Ніяких `as unknown as` кастів.**
- **Код важить більше за цей план.** Розбіжність сигнатури чи назви — іди за кодом і назви її у звіті.
- **Розмір задач (CLAUDE.md):** кожна задача містить повний код і зачіпає щонайбільше два файли коду плюс тести —
  **інлайн**. Усі задачі 17–21 і коміт ядра `d5f39d4` (теж інлайн) називаються в диспатчі наскрізного рев'ю.
- **Інструменти запису перетворюють `\uXXXX` на символи** — escape-послідовності тут не потрібні; після запису
  перевіряти змінені файли на NUL-байти.
- **Розширення не змінюється.**

---

### Задачі 1–16 — ✅ ЗРОБЛЕНО (план ядра, `2026-09-14-614-merge-alias-memory-core.md`)

Після плану ядра: `d5f39d4` — аліас лише коли злита сирота і є цією карткою (сфокусоване рев'ю, веб-фолбек).

---

### Task 17: правило «рядок важить більше» рахує лише злінковані рядки (інлайн)

**Files:**
- Modify: `src/domain/match-list.ts` — `buildAliasIndex` і коментар над ним
- Test: `src/domain/match-list.test.ts`, `src/domain/catalog-cache.test.ts`

**Interfaces:**
- Consumes: `CatalogBeerWithRating.untappd_id?: number | null` (є), `loadCatalog` вже вибирає `untappd_id`.
- Produces: `buildAliasIndex(aliases, catalog: readonly { id; brewery; name; untappd_id?: number | null }[], yield_?)`
  — сигнатура сумісна з наявними викликами.

- [ ] **Step 1: Переписати тест «row wins» і додати тест сироти** у `src/domain/match-list.test.ts`, блок
  `describe('matchBeerList aliases (#614)')`. Наявний тест
  `'buildAliasIndex drops an alias whose exact text another catalog row holds — the row wins'` замінити цілком на:

```ts
  it('buildAliasIndex drops an alias whose exact text another LINKED catalog row holds — the row wins', async () => {
    const catalog = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.1, untappd_id: 7777 }];
    expect((await buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')], catalog)).size).toBe(0);
    // Той самий текст лише в самій цілі — аліас лишається.
    const selfHeld = [{ id: 8, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.95, untappd_id: 1001 }];
    expect([...(await buildAliasIndex([alias(8, 'ROCH', 'Trappistes Rochefort 8')], selfHeld)).values()]).toEqual([8]);
  });

  it('#614 an orphan with the same exact text does not switch the alias off', async () => {
    // Сирота з текстом картки — наш плейсхолдер (/enrich/candidates для ABV-близнюка), а не доказ: без аліасу
    // /match віддав би на неї exact без untappd_id і без статусу «пив» (проба periph-abvtwin).
    const withOrphan = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: null, untappd_id: null }];
    const [r] = (await run(withOrphan, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
  });
```

- [ ] **Step 2: Переписати тест кешу** у `src/domain/catalog-cache.test.ts`. Тест
  `'#614 hands the catalog to buildAliasIndex: a row with the same exact text switches the alias off'` замінити цілком на:

```ts
  it('#614 hands the catalog to buildAliasIndex: a linked row with the same exact text switches the alias off, an orphan does not', async () => {
    const aliasRows = [{ beer_id: 1, brewery_text: 'pinta', name_text: 'atak chmielu ipa', abv_key: '' }];
    const linkedSameText: CatalogBeerWithRating[] = [
      ...rows,
      { id: 3, brewery: 'PINTA', name: 'Atak Chmielu IPA', abv: 6.1, rating_global: 3.6, untappd_id: 3003 },
    ];
    const orphanSameText: CatalogBeerWithRating[] = [
      ...rows,
      { id: 3, brewery: 'PINTA', name: 'Atak Chmielu IPA', abv: 6.1, rating_global: null, untappd_id: null },
    ];
    const linked = await make({ getVersion: () => 0, load: () => linkedSameText, loadAliases: () => aliasRows }).get();
    expect(linked.aliases.size).toBe(0);
    const orphan = await make({ getVersion: () => 0, load: () => orphanSameText, loadAliases: () => aliasRows }).get();
    expect([...orphan.aliases.values()]).toEqual([1]);
  });
```

- [ ] **Step 3: Прогнати — нові очікування падають**

Run: `npx vitest run src/domain/match-list.test.ts src/domain/catalog-cache.test.ts -t "#614"`
Expected: FAIL — `an orphan with the same exact text does not switch the alias off` (source не `exact`) і тест кешу
(`orphan.aliases` порожній).

- [ ] **Step 4: Реалізація** у `src/domain/match-list.ts`. Коментар над `buildAliasIndex` замінити на:

```ts
// #614: ЗЛІНКОВАНИЙ рядок каталогу з тим самим точним текстом важить більше за аліас (сирота, яку репарація
// #384 зробила рядком нового bid; кран з тим самим текстом) — картку тоді відповідає матчер з його вибором
// за ABV. Сирота з тим самим текстом аліас НЕ вимикає: це наш незакритий плейсхолдер (/enrich/candidates для
// ABV-близнюка), і /match віддав би на неї exact без untappd_id і без статусу «пив» (проби periph-*). ABV тут
// не порівнюється: зайве вимкнення дає лише промах, не хибний ✅. Той самий текст у самій цілі аліас не
// вимикає. cardText на ~33.6k рядках одним шматком блокував цикл подій на 74–113 мс (рев'ю 4), тож
// поступаємося циклу кожні 2000 рядків, як prepareCatalogChunked.
```

  Сигнатура й цикл:

```ts
export async function buildAliasIndex(
  aliases: readonly AliasSource[],
  catalog: readonly { id: number; brewery: string; name: string; untappd_id?: number | null }[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<AliasIndex> {
  const holders = new Map<string, Set<number>>();
  for (let i = 0; i < catalog.length; i += ALIAS_CATALOG_CHUNK) {
    const end = Math.min(i + ALIAS_CATALOG_CHUNK, catalog.length);
    for (let j = i; j < end; j++) {
      const row = catalog[j];
      if (row.untappd_id == null) continue;
      const key = textKey(cardText(row.brewery), cardText(row.name));
      (holders.get(key) ?? holders.set(key, new Set()).get(key)!).add(row.id);
    }
    await yield_();
  }
```

  (решта функції без змін; тест поступок циклу з рядками без `untappd_id` лишається зеленим — поступки рахуються
  шматками, не рядками).

- [ ] **Step 5: Прогнати — зелене**

Run: `npx vitest run src/domain/match-list.test.ts src/domain/catalog-cache.test.ts`
Expected: PASS.

- [ ] **Step 6: Мутації**
  - видалити рядок `if (row.untappd_id == null) continue;` → падають `an orphan with the same exact text…` і тест кешу;
  - замінити на `if (row.untappd_id != null) continue;` → падають `…LINKED catalog row holds — the row wins` і тест кешу.
  Після кожної — відновити, перевірити `git diff` лише з реалізацією.

- [ ] **Step 7: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts src/domain/catalog-cache.test.ts
git commit -m "fix(#614): only a linked row switches a merge alias off, never an orphan"
```

---

### Task 18: `ensureBeerRow` знаходить картку через аліас; допустимість `/enrich/candidates` (інлайн)

**Files:**
- Modify: `src/storage/beers.ts` — нові `findAliasTarget`, `deleteAlias` (одразу після `loadAliases`)
- Modify: `src/api/routes/enrich.ts` — `ensureBeerRow`, `eligible` у `/enrich/candidates`
- Test: `src/storage/beers.test.ts`, `src/api/routes/enrich.test.ts`

**Interfaces:**
- Consumes: `cardText`, `cardAbv` (імпортовані в `beers.ts`), `bumpCatalogVersion`, `mergeIntoCanonical`.
- Produces:
  - `findAliasTarget(db: DB, brewery: string, name: string, abv: number | null | undefined): BeerRow | null`
  - `deleteAlias(db: DB, brewery: string, name: string, abv: number | null | undefined): void`
  - `ensureBeerRow(...)`: `BeerRow & { viaAlias: boolean }` (Task 19 читає `row.viaAlias`).

- [ ] **Step 1: Тести сховища** у `src/storage/beers.test.ts`. До імпорту `import { getBeer, recordLookupSuccess, … mergeIntoCanonical } from './beers';`
  додати `findAliasTarget, deleteAlias`. Наприкінці файлу:

```ts
describe('#614 findAliasTarget / deleteAlias', () => {
  const CARD = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
  function aliased(db: ReturnType<typeof fresh>) {
    const canonicalId = seedBeer(db, {
      untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.14,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const orphanId = seedBeer(db, {
      name: CARD.name, brewery: CARD.brewery, style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName(CARD.name), normalized_brewery: normalizeBrewery(CARD.brewery),
    });
    mergeIntoCanonical(db, orphanId, canonicalId, '2026-09-14T12:00:00Z', CARD);
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 1 });
    return canonicalId;
  }

  test('finds the canonical row by the exact card key, whitespace and case aside', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    expect(findAliasTarget(db, ' varvar ', 'Black  Bean IS', 11)?.id).toBe(canonicalId);
  });

  test('misses another ABV, a card without ABV, other text and empty text', () => {
    const db = fresh();
    aliased(db);
    expect(findAliasTarget(db, 'VARVAR', 'BLACK BEAN IS', 9.5)).toBeNull();
    expect(findAliasTarget(db, 'VARVAR', 'BLACK BEAN IS', undefined)).toBeNull();
    expect(findAliasTarget(db, 'VARVAR', 'BLACK BEAN', 11)).toBeNull();
    expect(findAliasTarget(db, '  ', 'BLACK BEAN IS', 11)).toBeNull();
  });

  test('never returns a target whose untappd_id was cleared', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    db.prepare('UPDATE beers SET untappd_id = NULL WHERE id = ?').run(canonicalId);
    expect(findAliasTarget(db, 'VARVAR', 'BLACK BEAN IS', 11)).toBeNull();
  });

  test('deleteAlias removes only the key of that card', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    const twin = seedBeer(db, {
      name: CARD.name, brewery: CARD.brewery, style: null, abv: 9.5, rating_global: null,
      normalized_name: normalizeName(CARD.name), normalized_brewery: normalizeBrewery(CARD.brewery),
    });
    mergeIntoCanonical(db, twin, canonicalId, '2026-09-14T12:01:00Z', { ...CARD, abv: 9.5 });
    deleteAlias(db, 'varvar', 'black bean is', 11);
    expect(db.prepare('SELECT abv_key FROM beer_aliases').all()).toEqual([{ abv_key: '9.5' }]);
  });
});
```

- [ ] **Step 2: Тести `/enrich/candidates`** у `src/api/routes/enrich.test.ts`. Імпорт рядка 5 →
  `import { findBeerByNormalized, getBeer, mergeIntoCanonical } from '../../storage/beers';`. Одразу після функції
  `post` (модульний рівень — Task 19 теж ними користується):

```ts
// #614: картка Flasker з аліасом на канонічний рядок — стан після першого злиття петлі.
const BLACK_BEAN_CARD = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
const FLASKER_PAGE = 'https://flasker.pl/pl/p/VARVAR-BLACK-BEAN-IS-11-0.33l/1234';

function aliasedBlackBean(db: ReturnType<typeof setup>['db'], source: 'search' | 'checkin' = 'checkin') {
  const canonical = seedBeer(db, {
    untappd_id: 3548624, untappd_id_source: source, name: 'Black Bean', brewery: 'Varvar Brew',
    style: 'Stout', abv: 11, rating_global: 4.14,
    normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
  });
  const orphan = seedBeer(db, {
    name: BLACK_BEAN_CARD.name, brewery: BLACK_BEAN_CARD.brewery, style: null, abv: 11, rating_global: null,
    normalized_name: normalizeName(BLACK_BEAN_CARD.name), normalized_brewery: normalizeBrewery(BLACK_BEAN_CARD.brewery),
  });
  mergeIntoCanonical(db, orphan, canonical, '2026-09-14T12:00:00Z', BLACK_BEAN_CARD);
  // Передумова: аліас записано — інакше тести нижче нічого не доводять.
  expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 1 });
  return canonical;
}

const beerCount = (db: ReturnType<typeof setup>['db']) =>
  (db.prepare('SELECT COUNT(*) AS n FROM beers').get() as { n: number }).n;
```

  У `describe('POST /enrich/candidates')`, одразу після тесту `'is not eligible for a linked row when the shop publishes no bid'`:

```ts
  it('#614 answers a card with an alias with its canonical row and mints no orphan', async () => {
    const { db, app } = setup();
    aliasedBlackBean(db);
    const body = await (await post(app, '/enrich/candidates', { beers: [BLACK_BEAN_CARD] })).json();
    expect(body.candidates[0].eligible).toBe(false);
    // Сирота з текстом картки підмінила б аліас у /match (проба periph-e2e, кроки 5–6).
    expect(beerCount(db)).toBe(1);
  });

  it('#614 a card whose ABV differs from the alias key still gets its own orphan', async () => {
    const { db, app } = setup();
    aliasedBlackBean(db);
    const body = await (await post(app, '/enrich/candidates', { beers: [{ ...BLACK_BEAN_CARD, abv: 9.5 }] })).json();
    expect(body.candidates[0].eligible).toBe(true);
    expect(beerCount(db)).toBe(2);
  });

  it('#614 a contradicting bid on an alias is eligible even when the canonical link is a check-in', async () => {
    const { db, app } = setup();
    aliasedBlackBean(db, 'checkin');
    const body = await (await post(app, '/enrich/candidates', { beers: [{ ...BLACK_BEAN_CARD, bid: 5555 }] })).json();
    // Суперечність стосується аліасу, а не провенансу канонічного рядка; сироти все одно немає.
    expect(body.candidates[0].eligible).toBe(true);
    expect(beerCount(db)).toBe(1);
  });
```

- [ ] **Step 3: Прогнати — падають**

Run: `npx vitest run src/storage/beers.test.ts src/api/routes/enrich.test.ts -t "#614"`
Expected: FAIL — `findAliasTarget is not a function` / typecheck-помилка імпорту; `answers a card with an alias…`
(eligible `true`, 2 рядки); `contradicting bid on an alias…` (2 рядки).

- [ ] **Step 4: Реалізація сховища** у `src/storage/beers.ts`, одразу після `loadAliases`:

```ts
// #614: ключ аліасу картки — той самий, що в /match (aliasTarget): cardText броварні й назви і cardAbv
// СИРОГО ABV картки. Порожній текст ключа не має.
function cardAliasKey(brewery: string, name: string, abv: number | null | undefined) {
  const breweryText = cardText(brewery);
  const nameText = cardText(name);
  if (breweryText === '' || nameText === '') return null;
  return { breweryText, nameText, abvKey: cardAbv(abv) };
}

// #614: рядок, який довело злиття для цієї картки. Лише злінкований — та сама жива перевірка, що в loadAliases.
export function findAliasTarget(
  db: DB, brewery: string, name: string, abv: number | null | undefined,
): BeerRow | null {
  const key = cardAliasKey(brewery, name, abv);
  if (!key) return null;
  const row = db
    .prepare(
      `SELECT b.* FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
        WHERE a.brewery_text = ? AND a.name_text = ? AND a.abv_key = ? AND b.untappd_id IS NOT NULL`,
    )
    .get(key.breweryText, key.nameText, key.abvKey) as BeerRow | undefined;
  return row ?? null;
}

// #614: прийнятий суперечливий bid спростовує аліас саме цієї картки; інші ключі того самого рядка лишаються.
export function deleteAlias(db: DB, brewery: string, name: string, abv: number | null | undefined): void {
  const key = cardAliasKey(brewery, name, abv);
  if (!key) return;
  db.prepare('DELETE FROM beer_aliases WHERE brewery_text = ? AND name_text = ? AND abv_key = ?')
    .run(key.breweryText, key.nameText, key.abvKey);
  bumpCatalogVersion();
}
```

- [ ] **Step 5: Реалізація роуту** у `src/api/routes/enrich.ts`. До імпорту з `'../../storage/beers'` додати
  `findAliasTarget`, `type BeerRow`. `ensureBeerRow` цілком:

```ts
// Ensures a beer row exists for (brewery, name) and returns it.
// May return a pre-existing matched row, not only a freshly created orphan.
// #369: `facts` are shop-published abv/style relayed by the extension. On insert
// they seed the row; on an existing orphan they fill NULL columns only. A newly
// gained ABV re-arms the lookup backoff, because the previous attempt ran blind.
// #614: між рядком з нормалізованою парою і новою сиротою — аліас картки (той самий ключ, що в /match,
// з СИРИМ ABV). Без цього кроку картка, яку /match уже відповідає через аліас, на повторному раунді
// (SWR-null кешу, суперечливий bid) отримувала сироту зі своїм текстом, і /match віддавав її exact без ✅.
// viaAlias каже викликачеві, що рядок — канонічний, а не рядок цієї картки.
function ensureBeerRow(
  db: ApiDeps['db'], brewery: string, name: string, facts: OrphanFacts = {},
): BeerRow & { viaAlias: boolean } {
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  const existing = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (existing) {
    const { abvGained, changed } = fillOrphanFacts(db, existing.id, facts);
    if (abvGained) rearmLookup(db, existing.id);
    return { ...(abvGained || changed ? getBeer(db, existing.id)! : existing), viaAlias: false };
  }
  const aliased = findAliasTarget(db, brewery, name, facts.abv);
  if (aliased) return { ...aliased, viaAlias: true };
  // #617: сюди доходимо, лише коли рядка з цією нормалізованою парою немає зовсім — вставка сироти.
  const id = ensureOrphan(db, {
    name, brewery,
    style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
    rating_global: null, normalized_name, normalized_brewery,
  });
  return { ...getBeer(db, id)!, viaAlias: false };
}
```

  У `/enrich/candidates` вираз `eligible`:

```ts
        // #614: суперечливий bid на картці з аліасом стосується лише аліасу, а не провенансу канонічного
        // рядка (канонічний рядок випитого пива зазвичай 'checkin'), тож refusesBidOverride його не блокує.
        // Вето not_a_beer і бекоф канонічного рядка діють, як для репарації злінкованого рядка.
        const eligible =
          (row.untappd_id == null ||
            (contradicts && (row.viaAlias || !refusesBidOverride(row.untappd_id_source)))) &&
          !isNotABeer(deps.db, row.id) &&
          isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count,
            RECURRING_CLASSES.includes(reviewClassOf(deps.db, row.id) ?? ''));
```

- [ ] **Step 6: Прогнати — зелене**

Run: `npx vitest run src/storage/beers.test.ts src/api/routes/enrich.test.ts`
Expected: PASS.

- [ ] **Step 7: Мутації** (після кожної — відновити)
  - у `ensureBeerRow` видалити рядок `if (aliased) return { ...aliased, viaAlias: true };` → падають
    `answers a card with an alias…` і `contradicting bid on an alias…`;
  - у `eligible` прибрати `row.viaAlias ||` → падає `contradicting bid on an alias…`;
  - у `findAliasTarget` прибрати `AND b.untappd_id IS NOT NULL` → падає `never returns a target whose untappd_id was cleared`;
  - у `cardAliasKey` замінити `cardAbv(abv)` на `''` → падають `misses another ABV…` і `deleteAlias removes only…`;
  - у `deleteAlias` прибрати `AND abv_key = ?` (і третій аргумент `run`) → падає `deleteAlias removes only…`.

- [ ] **Step 8: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "fix(#614): /enrich/* find a card through its merge alias instead of minting an orphan"
```

---

### Task 19: репарація #384 через аліас у `/enrich/result` (інлайн)

**Files:**
- Modify: `src/api/routes/enrich.ts` — `mayOverride` і гілка `accepted` шляху bid
- Test: `src/api/routes/enrich.test.ts`

**Interfaces:**
- Consumes: `ensureBeerRow(...).viaAlias` (Task 18), `deleteAlias` (Task 18), `ensureOrphan`, `sanitizeAbv`,
  `applyLookupOutcome(deps, beerId, outcome, nowIso, input)`, хелпери тестів `aliasedBlackBean`, `BLACK_BEAN_CARD`,
  `FLASKER_PAGE`, `beerCount` (Task 18), `sourceOf` (є в `enrich.test.ts`).
- Produces: нічого нового для інших задач.

- [ ] **Step 1: Тести** у `describe('POST /enrich/result — published bid (#384)')`, наприкінці блоку:

```ts
  it('#614 an accepted contradicting bid on an alias moves the card, not the canonical row', async () => {
    const { db, app } = setup({ hydrateByBid: vi.fn(async () => new Map()) });
    const blackBean = aliasedBlackBean(db, 'checkin');
    const coffee = seedBeer(db, {
      untappd_id: 5555, name: 'Black Bean Coffee', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.0,
      normalized_name: normalizeName('Black Bean Coffee'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });

    const res = await post(app, '/enrich/result', {
      ...BLACK_BEAN_CARD, bid: 5555, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 5555 });
    // Канонічний рядок і його лінк не змінились; картка тепер пам'ятає власника опублікованого bid.
    expect(sourceOf(db, blackBean)!.untappd_id).toBe(3548624);
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: coffee, abv_key: '11' }]);
    expect(beerCount(db)).toBe(2);
  });

  it('#614 an accepted bid nobody owns links a fresh row for the card and drops the alias', async () => {
    const hydrated = {
      bid: 7777, beer_name: 'Black Bean IS', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-is', style: 'Stout', abv: 11, global_rating: 4.2,
    };
    const { db, app } = setup({ hydrateByBid: vi.fn(async () => new Map([[hydrated.bid, hydrated]])) });
    const blackBean = aliasedBlackBean(db);

    const res = await post(app, '/enrich/result', {
      ...BLACK_BEAN_CARD, bid: 7777, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 7777 });
    expect(sourceOf(db, blackBean)!.untappd_id).toBe(3548624);
    expect(db.prepare('SELECT untappd_id, brewery, name FROM beers WHERE id != ?').all(blackBean))
      .toEqual([{ untappd_id: 7777, brewery: 'VARVAR', name: 'BLACK BEAN IS' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 0 });
  });

  it('#614 a rejected contradicting bid on an alias keeps the alias and mints no orphan', async () => {
    const { db, app } = setup({ hydrateByBid: vi.fn(async () => new Map()) });
    const blackBean = aliasedBlackBean(db);

    const res = await post(app, '/enrich/result', {
      ...BLACK_BEAN_CARD, bid: 9999, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    expect(beerCount(db)).toBe(1);
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: blackBean, abv_key: '11' }]);
  });
```

- [ ] **Step 2: Прогнати — падають**

Run: `npx vitest run src/api/routes/enrich.test.ts -t "#614 an accepted"`
Expected: FAIL — обидва тести: канонічний рядок `aliasedBlackBean` має провенанс `checkin`, тож
`refusesBidOverride` дає ранню відповідь `matched 3548624` замість нового bid. (Без `viaAlias`-гілки в
транзакції, але з виправленим `mayOverride`, падіння інше: `applyLookupOutcome(row.id)` зливає канонічний рядок у
`coffee` або перелінковує його на 7777 — це ловить перша мутація Step 5.)
Тест `rejected…` уже зелений (Task 18 не створює сироти) — він охороняє порядок у Step 3.

- [ ] **Step 3: Реалізація** у `src/api/routes/enrich.ts`. До імпорту з `'../../storage/beers'` додати `deleteAlias`.
  `mayOverride`:

```ts
    // #614: на картці з аліасом суперечливий bid стосується лише аліасу — refusesBidOverride канонічного
    // рядка його не блокує (див. /enrich/candidates).
    const mayOverride =
      bid !== undefined && stored !== bid && (row.viaAlias || !refusesBidOverride(row.untappd_id_source));
```

  У гілці `if (resolved.kind === 'accepted')` виклик `applyLookupOutcome` замінити на:

```ts
        // Reuses the shared writer: UNIQUE clash → merge into the canonical row.
        // #614: на картці з аліасом прийнятий bid спростовує аліас, а не канонічний рядок: аліас видаляється, bid
        // пишеться на нову сироту цієї картки (злиття у власника bid або новий лінк). Рядка з нормалізованою парою
        // картки немає — інакше ensureBeerRow не дійшов би до аліасу. Одна транзакція: без проміжного стану
        // «аліасу вже немає, сироти ще немає». Відхилений bid сюди не доходить і нічого не змінює.
        const outcome = { kind: 'matched' as const, result: resolved.result };
        const input = { brewery, name, abv, sourceUrl: pageUrl };
        const kind = row.viaAlias
          ? deps.db.transaction(() => {
              deleteAlias(deps.db, brewery, name, abv);
              const cardRowId = ensureOrphan(deps.db, {
                name, brewery,
                style: style ?? null, abv: sanitizeAbv(abv ?? undefined) ?? null,
                rating_global: null,
                normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
              });
              return applyLookupOutcome({ db: deps.db, log: deps.log }, cardRowId, outcome, nowIso, input);
            })()
          : applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso, input);
```

  (Решта гілки — `stampBidProvenance` і відповідь `matched` — без змін.)

- [ ] **Step 4: Прогнати — зелене**

Run: `npx vitest run src/api/routes/enrich.test.ts`
Expected: PASS.

- [ ] **Step 5: Мутації** (після кожної — відновити)
  - `const kind = row.viaAlias ? … : …` → завжди гілка `row.id` → падають обидва `accepted`-тести (канонічний рядок
    злито в `coffee` / перелінковано на 7777);
  - видалити рядок `deleteAlias(deps.db, brewery, name, abv);` → падає `…nobody owns…` (аліас лишився);
  - у `mayOverride` прибрати `row.viaAlias ||` → падає `…moves the card, not the canonical row`;
  - перенести створення сироти перед `resolveByBid` (імітація «сирота до доказу») → падає `rejected…` (2 рядки).

- [ ] **Step 6: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "fix(#614): a contradicting bid on a merge alias repairs the alias, never the canonical row"
```

---

### Task 20: наскрізний тест петлі через роути й спільний кеш (інлайн)

**Files:**
- Create: `src/api/routes/merge-alias-loop.test.ts`

**Interfaces:**
- Consumes: `enrichRoute`, `matchRoute(app, deps, cache)`, `createCatalogCache(db)` з `get()`/`idle()`,
  `ApiEnv = { Variables: { telegramId: number | null } }`, `mergeCheckin`, `ensureProfile`.
- Produces: нічого.

Чому не `createApiApp`: кеш — stale-while-revalidate, а застосунок не віддає `idle()`. Без очікування перебудови
твердження «після» читало б знімок «до» і проходило б вакуумно (проба `periph-e2e`: перший `/match` після
злиття — `null`). Спільність кешу для `/match` і MCP уже охороняє source-guard у `src/api/index.test.ts`.

- [ ] **Step 1: Тест** — `src/api/routes/merge-alias-loop.test.ts` цілком:

```ts
import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { seedBeer } from '../../storage/seed-beer.testing';
import { ensureProfile } from '../../storage/user_profiles';
import { mergeCheckin } from '../../storage/checkins';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { createCatalogCache } from '../../domain/catalog-cache';
import { enrichRoute } from './enrich';
import { matchRoute } from './match';
import type { ApiDeps, ApiEnv } from '../types';

// #614: уся петля розширення через справжні роути й спільний кеш каталогу, на даних випадку користувача
// (Flasker, VARVAR BLACK BEAN IS 11%, 4 чекіни Varvar Brew / Black Bean). Кеш — stale-while-revalidate,
// тож перед кожним /match тест чекає перебудови: інакше «після» читав би знімок «до».
const CARD = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
const FLASKER_PAGE = 'https://flasker.pl/pl/p/VARVAR-BLACK-BEAN-IS-11-0.33l/1234';
const RESULT = { ...CARD, bid: 3548624, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } };

function loop() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  const blackBean = seedBeer(db, {
    untappd_id: 3548624, name: 'Black Bean', brewery: 'Varvar Brew',
    style: 'Stout - Imperial / Double Pastry', abv: 11, rating_global: 4.14,
    normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
  });
  mergeCheckin(db, {
    checkin_id: 'c1', telegram_id: 555, beer_id: blackBean, user_rating: 4.5,
    checkin_at: '2026-01-01T00:00:00Z', venue: null,
  });
  const deps = { db, env: {} as never, log: pino({ level: 'silent' }), hydrateByBid: async () => new Map() } satisfies ApiDeps;
  const app = new Hono<ApiEnv>();
  app.use('/match', async (c, next) => { c.set('telegramId', 555); await next(); });
  const cache = createCatalogCache(db);
  matchRoute(app, deps, cache);
  enrichRoute(app, deps);
  const post = async (path: string, body: unknown) => (await app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const match = async (card: typeof CARD) => {
    await cache.get();
    await cache.idle();
    return (await post('/match', { beers: [card] })).results[0];
  };
  const beerCount = () => (db.prepare('SELECT COUNT(*) AS n FROM beers').get() as { n: number }).n;
  return { blackBean, post, match, beerCount };
}

describe('#614 merge memory closes the extension loop', () => {
  it('the card is searched once: /match then answers exactly with the drinker status, and a repeat round mints no orphan', async () => {
    const { blackBean, post, match, beerCount } = loop();

    // Прод-реплей 2026-09-14: без пам'яті злиття картка — null.
    expect((await match(CARD)).matched_beer).toBeNull();
    expect((await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] })).candidates[0].eligible).toBe(true);
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    expect(beerCount()).toBe(1);

    expect(await match(CARD)).toMatchObject({
      matched_beer: { id: blackBean }, source: 'exact', is_drunk: true, user_rating: 4.5,
    });

    // Повторний раунд тієї самої картки (перший /match після злиття — застарілий null, друга вкладка):
    // пошуку немає, сирота не створюється, /match і далі точний.
    expect((await post('/enrich/candidates', { beers: [CARD] })).candidates[0].eligible).toBe(false);
    expect(beerCount()).toBe(1);
    expect(await match(CARD)).toMatchObject({ matched_beer: { id: blackBean }, source: 'exact', is_drunk: true });
  });

  it('an ABV twin of the card gets its own orphan without switching the alias off', async () => {
    const { blackBean, post, match, beerCount } = loop();
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });

    const twin = { ...CARD, abv: 9.5 };
    expect((await match(twin)).matched_beer).toBeNull();
    expect((await post('/enrich/candidates', { beers: [twin] })).candidates[0].eligible).toBe(true);
    expect(beerCount()).toBe(2);

    expect(await match(CARD)).toMatchObject({ matched_beer: { id: blackBean }, source: 'exact', is_drunk: true });
  });
});
```

- [ ] **Step 2: Прогнати — зелене** (задачі 17–19 уже в гілці)

Run: `npx vitest run src/api/routes/merge-alias-loop.test.ts`
Expected: PASS, `Tests 2 passed`.

- [ ] **Step 3: Мутації** (після кожної — відновити)
  - `src/api/routes/enrich.ts`: видалити `if (aliased) return { ...aliased, viaAlias: true };` → падає перший тест
    (`eligible` повторного раунду, 2 рядки);
  - `src/domain/match-list.ts`: видалити `if (row.untappd_id == null) continue;` → падає другий тест (`/match` картки
    11% віддає сироту близнюка);
  - `src/storage/beers.ts`, `mergeIntoCanonical`: замінити умову запису аліасу на `if (false)` → падають обидва
    (після злиття немає `exact`).

- [ ] **Step 4: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add src/api/routes/merge-alias-loop.test.ts
git commit -m "test(#614): the extension loop searches a shop card once and stays exact"
```

---

### Task 21: `spec.md` (інлайн)

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: §3.6.1** — одразу після абзацу, що закінчується рядком
  `інвентар і черга підтвердження — у #361.`, вставити:

````markdown

### 3.6.1 `beer_aliases` — пам'ять злиття для карток крамниць (v32, #614)

| Колонка | Тип | Обмеження | Опис |
|---|---|---|---|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `beer_id` | INTEGER | NOT NULL → `beers(id)` ON DELETE CASCADE | канонічний рядок, який довело злиття |
| `brewery`, `name` | TEXT | NOT NULL | сирий текст картки крамниці (аудит) |
| `brewery_text`, `name_text` | TEXT | NOT NULL | `cardText(…)` (`src/domain/card-text.ts`): NFC, пробіли, регістр — і нічого більше |
| `abv_key` | TEXT | NOT NULL | `cardAbv(abv)`: ABV картки до сотих; `''`, коли ABV немає |
| `created_at` | TEXT | NOT NULL | час злиття |

`UNIQUE (brewery_text, name_text, abv_key)`, індекс `idx_beer_aliases_beer`.

**Навіщо.** Картка крамниці, чия назва не збігається з рядком каталогу, на кожному завантаженні сторінки
проходила петлю: `/match` null → `/enrich/candidates` створює сироту → пошук → bid уже має власника →
`mergeIntoCanonical` видаляє сироту — і нічого не пам'ятала (`merged_at` живе лише на `match_links`, #366).
Аліас запам'ятовує **усю картку**, яку перевірив пошук.

**Запис** — лише `mergeIntoCanonical`, у транзакції до `DELETE`. Картка — вхід `applyLookupOutcome`: шлях bid —
картка з тіла запиту; шлях пошуку — текст картки й ABV, з яким ішов пошук (`row.abv`); крон — сама сирота.
Аліас пишеться, **лише коли злита сирота і є цією карткою** (той самий `cardText` броварні й назви), і не
пишеться для порожнього тексту. `ON CONFLICT` переводить ключ на новий рядок. Зміна `untappd_id` рядка
(`recordLookupSuccess`, `pinMatch`) видаляє його аліаси: вони доводили старий bid.

**Читання.** `/match` і MCP перевіряють аліас **перед** матчером (див. `POST /match`). Аліас не діє, коли
інший **злінкований** рядок каталогу має той самий текст; сирота з тим самим текстом його не вимикає.
`/enrich/*` — див. `POST /enrich/candidates` / `POST /enrich/result`.

**Межа.** Аліас точний настільки, наскільки точна картка від адаптера: те, що адаптер обрізав до надсилання
(вінтаж після ABV, самотнє `IS` у Flasker), на сервері нерозрізненне — #637.

**Скасування хибного аліасу:**
`DELETE FROM beer_aliases WHERE brewery_text = '<…>' AND name_text = '<…>' AND abv_key = '<…>'` — картка один раз
знову пройде петлю; повторний той самий аліас означає дефект доказу (bid крамниці чи пошук).
````

- [ ] **Step 2: §3.19** — після рядка таблиці `| 31 | …` додати:

```markdown
| 32 | `beer_aliases` (#614) — пам'ять злиття для карток крамниць; ключ `(brewery_text, name_text, abv_key)` = точна картка, яку надсилає розширення (§3.6.1). Без бекфілу: таблиця заповнюється першим злиттям |
```

- [ ] **Step 3: `POST /match`** — у абзаці «Кеш каталогу» замінити
  `` `recordLookupSuccess`, `mergeIntoCanonical`, `` на `` `recordLookupSuccess`, `mergeIntoCanonical`, `deleteAlias`, ``;
  після рядка `запит); є й 5-хв TTL-бекстоп. Контракт запиту/відповіді незмінний.` вставити:

```markdown

**Пам'ять злиття (#614).** Перед матчером картка шукається серед аліасів (§3.6.1) за точним ключем —
`cardText(brewery)`, `cardText(name)`, `cardAbv(abv)`; влучання на рядок з `untappd_id` дає `source: "exact"` з
`is_drunk`/`user_rating`, матчер і бюджет фолбеку не чіпаються. Картка з іншими цифрами, роком, ABV чи без ABV
аліасу не дістає. Аліаси входять у той самий знімок кешу, що й каталог.
```

- [ ] **Step 4: `POST /enrich/result`** — після рядка `контракт розширення незмінний.` (абзац про злиття, #351) вставити:

```markdown

**Картка з аліасом (#614).** `/enrich/candidates` і `/enrich/result` шукають рядок так: нормалізована пара →
аліас картки (той самий ключ, що в `/match`) → нова сирота. Влучання в аліас повертає канонічний рядок і
**не** створює сироти: сирота з текстом картки підмінила б аліас у `/match`. Такий рядок злінкований, тож без
bid він не `eligible`. Суперечливий опублікований bid на ньому стосується лише аліасу: `eligible` незалежно від
провенансу канонічного рядка (вето `not_a_beer` і бекоф діють), а в `/enrich/result` прийнятий bid видаляє аліас
і записується на нову сироту картки (`ensureOrphan` → `applyLookupOutcome`: злиття у власника bid або новий
лінк) однією транзакцією; відхилений нічого не змінює. Канонічний рядок репарація аліасу не чіпає ніколи.
```

- [ ] **Step 5: §5.2** — після пункту, що закінчується `` CASCADE при `foreign_keys=ON`). ``, додати:

```markdown
- **Ідентичність, здобута злиттям, переживає повторну ту саму картку крамниці (#614).** Ключ аліасу — усе, що
  надсилає розширення (`cardText` броварні й назви, `cardAbv`), і НІКОЛИ не проходить через нормалізатор
  кандидатів (`normalizeName`/`normalizeBrewery` гублять цифри, дужки, стиль — це ключ пошуку, не
  ідентичність). Аліас доводить лише той bid, під яким записаний, і лише картку, яка і є злитою сиротою.
  Сирота з текстом картки аліас не вимикає; `/enrich/*` для картки з аліасом сироти не створюють.
```

- [ ] **Step 6: Перевірка** — `grep -n "3.6.1\|beer_aliases\|#614" spec.md` показує §3.6.1, рядок v32, абзаци
  `/match` і `/enrich/result`, пункт §5.2; `git diff --stat` — лише `spec.md`.

- [ ] **Step 7: Повний гейт і коміт**

Run: `npm test && npm run typecheck`

```bash
git add spec.md
git commit -m "docs(#614): spec.md — merge aliases for shop cards"
```

---

## Після периферії

1. **Реплей проб засновків** (`scratchpad/`), очікування після задач 17–19:
   - `periph-premise.mts` — крок 2 `eligible: [true]` **без** нового рядка; кроки 3 і 5 — `/match` `id 1` `exact`;
     крок 4 — `matched 3548624`;
   - `periph-abvtwin.mts` — крок 4 `/match` картки 11% — `id 1` `exact`;
   - `periph-e2e.mts` — крок 5 `eligible: [false]` без нового рядка; крок 6 — `id 1` `exact` ✅ 4.5;
   - `r6fix-variants.mts` — без змін (S4 `aliases []`).
2. **Наскрізне рев'ю периферії й ядра**, окремий диспатч: назвати задачі 17–21 і `d5f39d4` (усі інлайн), спеку
   (розділи «`/enrich/*` (периферія)», «Заявка → доказ», «Рев'ю ядра» п. 7–8) і проби `periph-*`. Знахідки —
   у спеку («Рев'ю ядра»), фікси — з мутаційним доведенням.
3. **Перед PR:** `git fetch origin main` (за #583 — з заголовком `gh auth token`), `git rebase origin/main`, повний
   гейт наново, `git push --force-with-lease`. PR закриває #614; тіло називає виділені #632, #633, #636, #637 і
   чекпойнт після деплою зі спеки. Цикл AI-рев'ю; мерджить користувач.
4. **Після деплою** — чекпойнт зі спеки (журнал злиттів на bid, `count(*) FROM beer_aliases`, реплей Black Bean).
5. **Очистити `./tmp`** (скріншоти Flasker).

## Самоперевірка плану проти спеки

| Розділ спеки | Де в плані |
|---|---|
| Читання: лише злінкований рядок важить більше; сирота не вимикає | Task 17 |
| `ensureBeerRow`: пара → аліас (ключ `/match`, сирий ABV) → сирота; `viaAlias` | Task 18 |
| `/enrich/candidates`: `viaAlias` без bid не eligible; суперечливий bid eligible попри `refusesBidOverride`; бекоф і вето діють | Task 18 (тести без bid і `checkin`; наявні тести бекофу/вета злінкованого рядка) |
| Репарація: прийнято — `deleteAlias` → `ensureOrphan` → `applyLookupOutcome` однією транзакцією; відхилено — без змін; канонічний рядок не змінюється | Task 19 |
| Заявка → доказ: сирота не вимикає; картка з аліасом без сироти; bid на аліасі не переписує канонічний | Task 17, 18, 19; наскрізно — Task 20 |
| Тести периферії, наскрізний тест петлі | Task 17–20 |
| Документи: §3 таблиця, §3.19 v32, `/match`, `/enrich/*`, рецепт скасування, §5.2 | Task 21 |
| Ядро й периферія одним PR | «Після периферії», п. 3 |
