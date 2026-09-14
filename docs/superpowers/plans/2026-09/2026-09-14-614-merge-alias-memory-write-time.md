# Пам'ять злиття для карток крамниць — раунд 10: конфлікт доказів розв'язує запис (#614)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** аліас відповідає за свій точний ключ картки завжди; новіший доказ саме цієї картки
(`recordLookupSuccess` на рядку, який і є карткою) переносить наявний аліас ключа на свій рядок; правило читання
«рядок каталогу важить більше» і `deleteAlias` зникають.

**Architecture:** рев'ю 10 (сфокусоване, фікси рев'ю 9) показало, що третя версія правила читання порівнює поля
різного походження: ABV злінкованого рядка — з Untappd (`COALESCE(r.abv, abv)`), ключ аліасу — з картки крамниці.
N1: правильний bid крамниці на власному рядку картки з Untappd-ABV 10.8 лишав давній аліас → назавжди хибний ✅.
N2: пінг-понг репарацій повертався, коли Untappd-ABV близнюка дорівнював ABV іншої картки. Рішення з користувачем:
перенести розв'язання конфлікту в запис. Порядок задач: спершу запис (Task 22), потім зняти правило читання (Task
23) — навпаки проміжний коміт мав би N1 без жодного захисту.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Hono, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md` — «Запис»
(`recordLookupSuccess` переносить аліас), «Індекс у кеші каталогу», «Репарація #384 через аліас», «Заявка →
доказ», «Обмеження» (N3), «Рев'ю ядра» п. 10.

## Global Constraints

- **Коментарі українською, ідентифікатори англійською.**
- **Повний гейт після КОЖНОЇ задачі** (`npm test` і `npm run typecheck`).
- **Кожен тест мутаційно доведений** (`scratchpad/mutate.py <spec.json>`; bash-цикли зі змінними ізольована сесія
  відхиляє). `seedBeer` зливає сіди з однаковою нормалізованою парою — рядок «іншої картки» мусить мати іншу пару,
  а передумову (аліас записано) тест перевіряє явно.
- **Ключ аліасу ніколи не проходить через нормалізатор.**
- **Аліас переноситься лише на рядок, який і є карткою** (той самий `cardText` броварні й назви), і лише
  наявний — новий аліас створює тільки злиття.
- **Код важить більше за цей план.**
- **Розмір задач:** кожна — повний код, щонайбільше два файли коду плюс тести — **інлайн**. Задачі 22–25 і
  `a409099` називаються в диспатчі повторного рев'ю.

---

### Task 22: `recordLookupSuccess` переносить аліас ключа картки (інлайн)

**Files:**
- Modify: `src/storage/beers.ts` — `recordLookupSuccess(…, aliasSource?)`, нова приватна `moveCardAlias`
- Modify: `src/domain/lookup-outcome.ts` — `applyLookupOutcome` передає `input`
- Test: `src/storage/beers.test.ts`, `src/domain/lookup-outcome.test.ts`

**Interfaces:**
- Consumes: `cardAliasKey(brewery, name, abv)` (приватна в `beers.ts`, Task 18), `cardText`.
- Produces: `recordLookupSuccess(db, beerId, r, at, aliasSource?: { brewery: string; name: string; abv?: number | null })`.

- [ ] **Step 1: Тести сховища** у `src/storage/beers.test.ts`, блок `describe('#614 findAliasTarget / deleteAlias')`.
  Тест `'deleteAlias removes only the key of that card'` **лишити до Task 24**; наприкінці блоку додати:

```ts
  test('recordLookupSuccess moves the card key alias onto the card\'s own row it links', () => {
    const db = fresh();
    aliased(db);
    // Власний рядок картки (сирота раунду без ABV): доказ новішого bid саме для цієї картки.
    const own = seedBeer(db, {
      name: CARD.name, brewery: CARD.brewery, style: null, abv: null, rating_global: null,
      normalized_name: normalizeName(CARD.name), normalized_brewery: normalizeBrewery(CARD.brewery),
    });
    recordLookupSuccess(db, own, { bid: 2002, style: 'Stout', abv: 10.8, global_rating: 4.3 }, '2026-09-14T12:05:00Z', CARD);
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: own, abv_key: '11' }]);
  });

  test('recordLookupSuccess leaves the alias when the linked row is another card', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    // Інша нормалізована пара, ніж у CARD, — інакше seedBeer повернув би той самий рядок.
    const other = seedBeer(db, {
      name: 'BLACK BEAN IS COFFEE', brewery: CARD.brewery, style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('BLACK BEAN IS COFFEE'), normalized_brewery: normalizeBrewery(CARD.brewery),
    });
    recordLookupSuccess(db, other, { bid: 2002, style: 'Stout', abv: 11, global_rating: 4.3 }, '2026-09-14T12:05:00Z', CARD);
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: canonicalId, abv_key: '11' }]);
  });

  test('recordLookupSuccess moves only the key with the card ABV and never creates an alias', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    const own = seedBeer(db, {
      name: CARD.name, brewery: CARD.brewery, style: null, abv: null, rating_global: null,
      normalized_name: normalizeName(CARD.name), normalized_brewery: normalizeBrewery(CARD.brewery),
    });
    recordLookupSuccess(db, own, { bid: 2002, style: 'Stout', abv: 9.5, global_rating: 4.3 }, '2026-09-14T12:05:00Z', { ...CARD, abv: 9.5 });
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: canonicalId, abv_key: '11' }]);
  });
```

- [ ] **Step 2: Тест `applyLookupOutcome`** у `src/domain/lookup-outcome.test.ts`. Імпорт рядка 4 →
  `import { getBeer, mergeIntoCanonical } from '../storage/beers';`. У `describe` з тестом
  `'#614 records no alias when the merged orphan was created by another card'`, одразу після нього:

```ts
  test('#614 a link of the card\'s own row moves the card key alias onto it', () => {
    const { db, log } = fresh();
    const card = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
    const old = seedBeer(db, {
      untappd_id: 1001, name: 'Black Bean', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.1,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const first = seedBeer(db, {
      name: card.name, brewery: card.brewery, style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName(card.name), normalized_brewery: normalizeBrewery(card.brewery),
    });
    mergeIntoCanonical(db, first, old, '2026-09-14T12:00:00Z', card);
    const own = seedBeer(db, {
      name: card.name, brewery: card.brewery, style: null, abv: null, rating_global: null,
      normalized_name: normalizeName(card.name), normalized_brewery: normalizeBrewery(card.brewery),
    });

    const kind = applyLookupOutcome(
      { db, log }, own, { kind: 'matched', result: cand({ bid: 2002, abv: 10.8 }) }, '2026-09-14T12:05:00Z', card,
    );

    expect(kind).toBe('matched');
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: own, abv_key: '11' }]);
    db.close();
  });
```

- [ ] **Step 3: Прогнати — падають**

Run: `npx vitest run src/storage/beers.test.ts src/domain/lookup-outcome.test.ts -t "moves the card key alias|a link of the card"`
Expected: FAIL — аліас лишається на старому рядку (`beer_id` канонічного замість `own`); два інші тести Step 1
зелені вже зараз (охоронці).

- [ ] **Step 4: Реалізація** у `src/storage/beers.ts`. `recordLookupSuccess` цілком:

```ts
export function recordLookupSuccess(
  db: DB,
  beerId: number,
  r: {
    bid: number;
    style: string | null;
    abv: number | null;
    global_rating: number | null;
  },
  at: string,
  aliasSource?: { brewery: string; name: string; abv?: number | null },
): void {
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
    if (aliasSource) moveCardAlias(db, beerId, aliasSource, at);
  })();
  bumpCatalogVersion();
}

// #614 (рев'ю 10): лінк рядка самої картки — новіший доказ для її ключа, ніж давнє злиття: наявний аліас ключа
// переходить на цей рядок, як ON CONFLICT у mergeIntoCanonical. Так конфлікт доказів розв'язує запис, а не
// вгадування під час читання (три версії правила «рядок важить більше» порівнювали поля різного походження —
// ABV злінкованого рядка з Untappd проти ABV картки). Лише коли рядок і є цією карткою (той самий cardText
// броварні й назви): інакше доказ міг стосуватися іншої картки з тією самою нормалізованою парою (рев'ю 6). Нового
// аліасу не створює: без давнього злиття картку й так відповідає рядок з її текстом.
function moveCardAlias(
  db: DB, rowId: number, card: { brewery: string; name: string; abv?: number | null }, at: string,
): void {
  const key = cardAliasKey(card.brewery, card.name, card.abv);
  if (!key) return;
  const row = db.prepare('SELECT brewery, name FROM beers WHERE id = ?').get(rowId) as
    | { brewery: string; name: string }
    | undefined;
  if (!row || cardText(row.brewery) !== key.breweryText || cardText(row.name) !== key.nameText) return;
  db.prepare(
    `UPDATE beer_aliases SET beer_id = ?, brewery = ?, name = ?, created_at = ?
      WHERE brewery_text = ? AND name_text = ? AND abv_key = ? AND beer_id != ?`,
  ).run(rowId, card.brewery, card.name, at, key.breweryText, key.nameText, key.abvKey, rowId);
}
```

  У `src/domain/lookup-outcome.ts`, гілка `'matched'`:

```ts
        // #614 (рев'ю 10): input — картка цього доказу; лінк рядка самої картки переносить наявний аліас її ключа.
        recordLookupSuccess(deps.db, beerId, outcome.result, nowIso, input);
```

- [ ] **Step 5: Прогнати — зелене:** `npx vitest run src/storage/beers.test.ts src/domain/lookup-outcome.test.ts`

- [ ] **Step 6: Мутації** (`scratchpad/mut-task22.json`)
  - `if (aliasSource) moveCardAlias(db, beerId, aliasSource, at);` → `` → падають обидва тести перенесення;
  - у `moveCardAlias` прибрати перевірку тексту рядка (`|| cardText(row.brewery) !== key.breweryText || cardText(row.name) !== key.nameText`) → падає `leaves the alias when the linked row is another card`;
  - `abvKey: cardAbv(abv) };` у `cardAliasKey` → `abvKey: '' };` → падає `moves only the key with the card ABV…`
    (і тести, що шукають `'11'`);
  - у `lookup-outcome.ts` прибрати `, input` з виклику → падає `a link of the card's own row…`.

- [ ] **Step 7: Повний гейт і коміт**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts
git commit -m "fix(#614): a link of the card's own row moves its alias — the writer resolves the conflict"
```

---

### Task 23: індекс аліасів без правила «рядок каталогу важить більше» (інлайн)

**Files:**
- Modify: `src/domain/match-list.ts` — `buildAliasIndex(aliases)`, без каталогу й поступок
- Modify: `src/domain/catalog-cache.ts` — виклик і коментарі
- Test: `src/domain/match-list.test.ts`, `src/domain/catalog-cache.test.ts`

- [ ] **Step 1: Тести.** `src/domain/match-list.test.ts`:
  - у `run`: `const aliases = await buildAliasIndex(aliasRows, catalog);` → `const aliases = buildAliasIndex(aliasRows);`;
  - тест `'buildAliasIndex drops an alias whose exact key (text and ABV) another LINKED catalog row holds — the row wins'`
    замінити на:

```ts
  it('#614 the alias answers its exact key even when a linked catalog row holds the same text and ABV', async () => {
    // Рев'ю 10: конфлікт доказів для тієї самої картки розв'язує запис (новіший доказ переносить аліас), не читання.
    const withSameKey = [...rochefort, { id: 77, brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2, rating_global: 3.1, untappd_id: 7777 }];
    const [r] = (await run(withSameKey, [alias(8, 'ROCH', 'Trappistes Rochefort 8', 9.2)], { brewery: 'ROCH', name: 'Trappistes Rochefort 8', abv: 9.2 }, 8)).results;
    expect([r.source, r.matched_beer?.id, r.is_drunk]).toEqual(['exact', 8, true]);
  });
```

  - тест `'buildAliasIndex yields to the event loop once per 2000 catalog rows'` видалити.
  `src/domain/catalog-cache.test.ts`: тест
  `'#614 hands the catalog to buildAliasIndex: a linked row with the same exact text switches the alias off, an orphan does not'` видалити.

- [ ] **Step 2: Прогнати — падає** `#614 the alias answers its exact key even when…` (правило ще вимикає аліас); typecheck
  падає на новій сигнатурі виклику.

- [ ] **Step 3: Реалізація.** `src/domain/match-list.ts`: константу `ALIAS_CATALOG_CHUNK`, коментар над
  `buildAliasIndex` і саму функцію замінити на:

```ts
// #614: індекс пам'яті злиття — «ключ картки → рядок». Аліас відповідає за свій точний ключ завжди; конфлікт
// доказів для тієї самої картки розв'язує запис (ON CONFLICT у mergeIntoCanonical, recordLookupSuccess переносить
// аліас ключа на рядок самої картки), а не вгадування під час читання. Три версії правила «рядок каталогу важить
// більше» (за текстом; лише злінковані; з ABV рядка) кожна давала хибну ідентичність, бо порівнювали поля різного
// походження: ABV злінкованого рядка — з Untappd, ключ аліасу — з картки крамниці (рев'ю 8–10).
export function buildAliasIndex(aliases: readonly AliasSource[]): AliasIndex {
  return new Map(aliases.map((a) => [aliasKey(a.brewery_text, a.name_text, a.abv_key), a.beer_id]));
}
```

  `src/domain/catalog-cache.ts`: коментар `// #614: аліаси читаються одразу за рядками каталогу — один знімок для правила «рядок важить більше».`
  → `// #614: аліаси читаються одразу за рядками каталогу — один знімок: ціль аліасу є в byId.`; блок

```ts
      // #614: аліаси — окремий індекс, а не записи каталогу матчера: matchBeerList перевіряє їх до
      // матчера за точним текстом картки, тож матчер не бачить дублікатів id і не звужує пул броварні. Рядки
      // каталогу потрібні для правила «рядок з тим самим текстом важить більше».
      const aliases = await buildAliasIndex(aliasRows, rows);
```

  → 

```ts
      // #614: аліаси — окремий індекс, а не записи каталогу матчера: matchBeerList перевіряє їх до
      // матчера за точним текстом картки, тож матчер не бачить дублікатів id і не звужує пул броварні.
      const aliases = buildAliasIndex(aliasRows);
```

  `src/storage/beers.ts`: коментар над `AliasRow` — речення `Правило «рядок каталогу з тим самим текстом важить
  більше» застосовує buildAliasIndex, бо кеш і так має весь каталог.` видалити; у `mergeIntoCanonical` речення
  `Рядок каталогу з тим самим текстом вимикає аліас під час читання (buildAliasIndex), тож перевірки власника під
  час запису немає.` → `Новіший лінк рядка самої картки переносить аліас так само (recordLookupSuccess).`

- [ ] **Step 4: Прогнати — зелене:** `npx vitest run src/domain/match-list.test.ts src/domain/catalog-cache.test.ts src/api/routes/merge-alias-loop.test.ts`

- [ ] **Step 5: Мутація** — повернути правило «рядок важить більше» за текстом злінкованого рядка (у
  `buildAliasIndex` пропускати аліас, коли будь-який інший рядок каталогу з `untappd_id` має той самий текст; каталог
  передати тестовим викликом) неможливо однією заміною — замість цього: `aliases.map((a) => [aliasKey(…), a.beer_id])`
  → `aliases.filter(() => false).map(…)` → падають усі тести влучання аліасу (доводить, що індекс читається), а
  поведінку «рядок не вимикає» доводять наскрізні тести Task 25.

- [ ] **Step 6: Повний гейт і коміт**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts src/domain/catalog-cache.ts src/domain/catalog-cache.test.ts src/storage/beers.ts
git commit -m "fix(#614): the alias index reads no catalog; only writers resolve evidence conflicts"
```

---

### Task 24: репарація без `deleteAlias` (інлайн)

**Files:**
- Modify: `src/api/routes/enrich.ts` — гілка `row.viaAlias` у `accepted`, імпорт
- Modify: `src/storage/beers.ts` — видалити `deleteAlias`
- Test: `src/api/routes/enrich.test.ts`, `src/storage/beers.test.ts`

- [ ] **Step 1: Тести.** `src/api/routes/enrich.test.ts`: тест
  `'#614 an accepted bid nobody owns links a fresh row for the card and drops the alias'` → назва
  `'#614 an accepted bid nobody owns links a fresh row for the card and moves the alias onto it'`, останнє твердження
  `expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 0 });` →

```ts
    const cardRow = (db.prepare('SELECT id FROM beers WHERE untappd_id = 7777').get() as { id: number }).id;
    // Аліас переходить разом із прийнятим доказом: картку відповідає новий рядок, а не матчер з exacts[0].
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: cardRow, abv_key: '11' }]);
```

  Тест транзакції: назва `'#614 the alias repair is one transaction: a failure after ensureOrphan keeps the alias and leaves no orphan'`,
  коментар `// Збій уже після ensureOrphan: запис лінка на сироту картки падає не-UNIQUE помилкою.`
  `src/storage/beers.test.ts`: тест `'deleteAlias removes only the key of that card'` видалити, `deleteAlias` з імпорту
  прибрати, назва блоку `'#614 findAliasTarget / card alias move'`.

- [ ] **Step 2: Прогнати** — `…moves the alias onto it` зелений уже після Task 22, якщо `deleteAlias` ще викликається?
  Ні: `deleteAlias` видаляє аліас до лінка, переносити нічого → FAIL (`[]`). Це доводить, що переносить саме запис.

- [ ] **Step 3: Реалізація.** `src/api/routes/enrich.ts`: з імпорту прибрати `deleteAlias,`; у гілці `row.viaAlias`
  видалити рядок `              deleteAlias(deps.db, brewery, name, abv);`; коментар над `const outcome` →

```ts
        // #614: на картці з аліасом прийнятий bid стосується картки, а не канонічного рядка: bid пишеться на нову
        // сироту цієї картки, і аліас ключа переходить туди разом із доказом (злиття — ON CONFLICT у
        // mergeIntoCanonical; новий лінк — recordLookupSuccess). Рядка з нормалізованою парою картки немає — інакше
        // ensureBeerRow не дійшов би до аліасу. Одна транзакція: збій запису лінка не лишає сироти з текстом картки.
        // Відхилений bid сюди не доходить і нічого не змінює.
```

  `src/storage/beers.ts`: функцію `deleteAlias` з коментарем над нею видалити.

- [ ] **Step 4: Зелене:** `npx vitest run src/api/routes/enrich.test.ts src/storage/beers.test.ts`

- [ ] **Step 5: Мутації** — у `moveCardAlias` (Task 22) замінити тіло `UPDATE` на no-op (`WHERE 0`) → падає
  `…moves the alias onto it`; транзакцію репарації на звичайний виклик → падає тест транзакції.

- [ ] **Step 6: Повний гейт і коміт**

```bash
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts src/storage/beers.ts src/storage/beers.test.ts
git commit -m "refactor(#614): the alias repair moves the alias with the accepted bid, no deleteAlias"
```

---

### Task 25: наскрізні N1 і N2; `spec.md` (інлайн)

**Files:**
- Test: `src/api/routes/merge-alias-loop.test.ts`
- Modify: `spec.md`

- [ ] **Step 1: N2** — у тесті `'a twin linked by its own bid does not switch the alias off, so the card never contradicts its bid'`
  `abv: 9.5, global_rating: 4.0,` у `twinBeer` → `abv: 11, global_rating: 4.0,` і коментар над ним доповнити:
  `// Рев'ю 10, N2: Untappd-ABV близнюка (11) дорівнює ABV іншої картки — правило читання з ABV рядка знову вимикало аліас.`

- [ ] **Step 2: N1** — наприкінці `describe`:

```ts
  it('a shop bid accepted on the card\'s own row moves the card off an older alias, even when Untappd\'s ABV differs', async () => {
    // Рев'ю 10, N1: ABV рядка після лінка — з Untappd (10.8), ключ аліасу — з картки (11). Правило читання з ABV
    // рядка лишало давній аліас, і картка назавжди показувала ✅ на пиві, яке суперечить bid крамниці.
    const corrected = {
      bid: 2002, beer_name: 'Black Bean IS', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-is', style: 'Stout', abv: 10.8, global_rating: 4.3,
    };
    const { db, blackBean, post, match } = loop(async () => new Map([[corrected.bid, corrected]]));
    // Раунд 1: картка злита в Black Bean за bid крамниці — аліас (текст, 11) → Black Bean.
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    // Раунд 2: та сама картка без ABV (деталі товару не завантажились) — власна сирота з текстом картки.
    const noAbv = { brewery: CARD.brewery, name: CARD.name };
    expect((await post('/enrich/candidates', { beers: [noAbv] })).candidates[0].eligible).toBe(true);
    // Раунд 3: картка з ABV і правильним bid крамниці — ensureBeerRow знаходить власну сироту за парою.
    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 2002 }] });
    expect(await post('/enrich/result', { ...CARD, bid: 2002, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } }))
      .toMatchObject({ status: 'matched', untappd_id: 2002 });
    const own = (db.prepare('SELECT id FROM beers WHERE untappd_id = 2002').get() as { id: number }).id;

    expect(await match(CARD)).toMatchObject({ matched_beer: { id: own, untappd_id: 2002 }, source: 'exact', is_drunk: false });
    expect(own).not.toBe(blackBean);
  });
```

  (`match` приймає `typeof CARD`; для `noAbv` тест не викликає `match`.)

- [ ] **Step 3: Прогнати** — обидва зелені після Task 22–24.

- [ ] **Step 4: Мутації** (`scratchpad/mut-task25.json`): прибрати `if (aliasSource) moveCardAlias(…)` → падає N1;
  повернути в `buildAliasIndex` фільтр «рядок важить більше» неможливо без каталогу — натомість реплей
  `scratchpad/review9/abvrow.mts` (P1 з ABV 10.8 → `[[own,2002,…]]`, P6 без пінг-понгу) і
  `scratchpad/review7/twin-pingpong.mts` після задач.

- [ ] **Step 5: `spec.md`** §3.6.1:
  - речення `Зміна \`untappd_id\` рядка (\`recordLookupSuccess\`, \`pinMatch\`, \`upsertBeerByBid\` для рядка без bid) видаляє його аліаси: вони доводили старий
bid.` доповнити: `Лінк рядка самої картки новішим доказом (`recordLookupSuccess` з карткою: `/enrich/result`, крон)
    переносить наявний аліас її ключа на цей рядок; синк чекінів, `/import` і пін аліас не переносять.`
  - абзац «**Читання.**»: речення `Аліас не діє, коли інший **злінкований** рядок каталогу має той самий текст **і той
    самий ABV ключа**; сирота з тим самим текстом і злінкований близнюк з іншим ABV його не вимикають.` →
    `Аліас відповідає за свій точний ключ завжди: конфлікт доказів розв'язує запис, а не читання.`
  - абзац `/enrich/result` («Картка з аліасом (#614)»): `прийнятий bid видаляє аліас і записується на нову сироту
    картки` → `прийнятий bid записується на нову сироту картки, і аліас переходить туди разом із доказом`;
  - у списку мутаторів кешу прибрати `` `deleteAlias`, ``.

- [ ] **Step 6: Повний гейт і коміт**

```bash
git add src/api/routes/merge-alias-loop.test.ts spec.md
git commit -m "test(#614): a corrected shop bid moves the card's alias; Untappd ABV never decides identity"
```

---

## Після раунду

1. Реплеї: `review9/abvrow.mts` (P1 обидва ABV → власний рядок з 2002; P6 без пінг-понгу; P3 — аліас лишається,
   обмеження N3), `review7/twin-pingpong.mts`, `review7/plan-and-revive.mts`, `periph-*.mts`, `r6fix-variants.mts`.
2. Повторне рев'ю тим самим рецензентом: задачі 22–25 і `a409099`.
3. Рібейс на `origin/main`, повний гейт, PR (ядро + периферія + раунд 10), цикл AI-рев'ю; мерджить користувач.

## Самоперевірка плану проти спеки

| Розділ спеки | Де |
|---|---|
| `recordLookupSuccess` переносить наявний аліас ключа, лише рядок = картка, без створення | Task 22 |
| Індекс без каталогу | Task 23 |
| Репарація без `deleteAlias`, транзакція лишається | Task 24 |
| Заявка → доказ: N1/N2 наскрізно | Task 25 |
| Обмеження N3 | спека; тестом не охороняється (свідома поведінка) |
| `spec.md` | Task 25 |
