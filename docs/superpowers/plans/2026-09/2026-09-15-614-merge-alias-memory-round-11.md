# Пам'ять злиття для карток крамниць — раунд 11: доказ bid без тексту рядка, аліас раніше за пару (#614)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** прийнятий опублікований bid переносить і пише аліас картки, хоч би яке написання мав рядок пари, на який
він ліг (R1); `ensureBeerRow` перевіряє аліас раніше за нормалізовану пару, тож суперечливий bid картки ніколи не
перелінковує рядок близнюка (R3).

**Architecture:** повторне рев'ю раунду 10 (проба `scratchpad/review10/writetime.mts`). R1 (PA): умова «рядок =
картка» в `moveCardAlias` і `mergeIntoCanonical` потрібна лише пошуку (веб-фолбек шукає текстом рядка, рев'ю 6), але
стояла й на шляху bid, де `resolveByBid` читає лише поля тіла запиту: bid 2002 лягав на сироту «Browar Varvar / Black
Bean IS» тієї самої пари, аліас «VARVAR / BLACK BEAN IS» лишався на 1001 — назавжди хибний ✅. Фікс — позначка
`byBid` у картці доказу, яку ставить лише шлях bid `/enrich/result`. R3 (PD): пара раніше за аліас віддавала картці
рядок злінкованого ABV-близнюка → пінг-понг 777↔8888. Фікс — аліас першим; репарація лінкує лише сироту
(`ensureOrphan`). R2 — обмеження в спеці й окремий issue. Порядок задач: сховище (26) → роут передає `byBid` (27) →
аліас раніше за пару (28); тест задачі 27 зелений і до, і після 28 (різні шляхи до того самого запису).

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Hono, Vitest (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-14-614-merge-alias-memory-design.md` — «Запис» (виняток доказу
bid), «`ensureBeerRow`» (порядок), «Репарація #384 через аліас», «Заявка → доказ», «Обмеження» (R2, новий рядок на
кожну зміну bid), «Рев'ю ядра» п. 11, «Стадії» п. 4.

## Global Constraints

- **Коментарі українською, ідентифікатори англійською.**
- **Повний гейт після КОЖНОЇ задачі** (`npm test` і `npm run typecheck`).
- **Кожен тест мутаційно доведений** (`scratchpad/mutate.py <spec.json>`). `seedBeer` зливає сід з наявним рядком тієї
  самої нормалізованої пари — «Browar Varvar / Black Bean IS» і «VARVAR / BLACK BEAN IS» дають одну пару
  `varvar|black bean is`, тож сід іншого написання робиться, лише коли рядка цієї пари ще немає (після злиття сироти
  картки), і тест перевіряє `not.toBe` явно.
- **`byBid` ставить лише шлях bid `/enrich/result`.** Крон і шлях пошуку передають поля рядка — там умова «рядок =
  картка» лишається.
- **Ключ аліасу ніколи не проходить через нормалізатор.**
- **Код важить більше за цей план.**
- **Розмір задач:** кожна — повний код, щонайбільше два файли коду плюс тести — **інлайн**. Нового кола рев'ю немає
  (рішення користувача 2026-09-15): після задач — реплей проб, рібейс, PR з AI-рев'ю.

---

### Task 26: картка доказу `byBid` у сховищі (інлайн)

**Files:**
- Modify: `src/storage/beers.ts` — тип `AliasCard`, `recordLookupSuccess`, `moveCardAlias`, `mergeIntoCanonical`
- Modify: `src/domain/lookup-outcome.ts` — тип `input`
- Test: `src/storage/beers.test.ts`, `src/domain/lookup-outcome.test.ts`

**Interfaces:**
- Produces: `export interface AliasCard { brewery: string; name: string; abv?: number | null; byBid?: boolean }`;
  `recordLookupSuccess(db, beerId, r, at, aliasSource?: AliasCard)`;
  `mergeIntoCanonical(db, orphanId, canonicalId, at, aliasSource?: AliasCard)`;
  `applyLookupOutcome(deps, beerId, outcome, nowIso, input: AliasCard & { sourceUrl?: string })`.

- [ ] **Step 1: Тести сховища.** `src/storage/beers.test.ts`, одразу після тесту
  `'#614 mergeIntoCanonical writes no alias when the merged orphan was created by another card'`:

```ts
test('#614 mergeIntoCanonical writes the alias of a card proved by its published bid, whatever text the merged orphan has', () => {
  const db = fresh();
  const g7 = seedBeer(db, {
    untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
    style: 'Stout', abv: 7, rating_global: 3.9,
    normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
  });
  const orphanId = seedBeer(db, {
    name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
    normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
  });

  mergeIntoCanonical(db, orphanId, g7, '2026-09-15T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7', abv: 7, byBid: true });

  // Рев'ю 11, R1: доказ bid узято лише з полів картки «#7» (resolveByBid), текст сироти в нього не входить.
  expect(db.prepare('SELECT beer_id, brewery_text, name_text, abv_key FROM beer_aliases').all())
    .toEqual([{ beer_id: g7, brewery_text: 'ґвара', name_text: 'ґвара #7', abv_key: '7' }]);
});
```

  У `describe('#614 findAliasTarget / card alias move')`, наприкінці:

```ts
  // Та сама нормалізована пара, що в CARD, інше написання (кран чи інша крамниця); рядка пари після злиття немає,
  // тож seedBeer вставляє новий.
  function spelledOrphan(db: ReturnType<typeof fresh>) {
    return seedBeer(db, {
      name: 'Black Bean IS', brewery: 'Browar Varvar', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('Black Bean IS'), normalized_brewery: normalizeBrewery('Browar Varvar'),
    });
  }

  test('recordLookupSuccess moves the alias onto a row spelled differently when the card proved it by bid', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    const spelled = spelledOrphan(db);
    expect(spelled).not.toBe(canonicalId);
    recordLookupSuccess(db, spelled, { bid: 2002, style: 'Stout', abv: 10.8, global_rating: 4.3 }, '2026-09-15T12:05:00Z', { ...CARD, byBid: true });
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: spelled, abv_key: '11' }]);
  });

  test('recordLookupSuccess keeps the alias off a row spelled differently when the proof was a search', () => {
    const db = fresh();
    const canonicalId = aliased(db);
    const spelled = spelledOrphan(db);
    recordLookupSuccess(db, spelled, { bid: 2002, style: 'Stout', abv: 10.8, global_rating: 4.3 }, '2026-09-15T12:05:00Z', CARD);
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: canonicalId, abv_key: '11' }]);
  });
```

- [ ] **Step 2: Тести `applyLookupOutcome`.** `src/domain/lookup-outcome.test.ts`, одразу після
  `'#614 records no alias when the merged orphan was created by another card'`:

```ts
  test('#614 a card proved by its published bid keeps its alias through the merge, whatever the orphan text', () => {
    const { db, log } = fresh();
    const g7 = seedBeer(db, {
      untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
      style: 'Stout', abv: 7, rating_global: 3.9,
      normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
    });
    const orphanId = seedBeer(db, {
      name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
      normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
    });

    const kind = applyLookupOutcome(
      { db, log }, orphanId,
      { kind: 'matched', result: cand({ bid: 4007 }) },
      '2026-09-15T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7', abv: 7, byBid: true },
    );

    expect(kind).toBe('merged');
    expect(db.prepare('SELECT beer_id, name_text FROM beer_aliases').all()).toEqual([{ beer_id: g7, name_text: 'ґвара #7' }]);
    db.close();
  });
```

  І наприкінці блоку, після `'#614 a link of the card\'s own row moves the card key alias onto it'`:

```ts
  test('#614 a bid-proved card moves its alias onto a same-pair row spelled differently', () => {
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
    mergeIntoCanonical(db, first, old, '2026-09-15T12:00:00Z', card);
    const spelled = seedBeer(db, {
      name: 'Black Bean IS', brewery: 'Browar Varvar', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('Black Bean IS'), normalized_brewery: normalizeBrewery('Browar Varvar'),
    });

    const kind = applyLookupOutcome(
      { db, log }, spelled, { kind: 'matched', result: cand({ bid: 2002, abv: 10.8 }) }, '2026-09-15T12:05:00Z',
      { ...card, byBid: true },
    );

    expect(kind).toBe('matched');
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: spelled, abv_key: '11' }]);
    db.close();
  });
```

- [ ] **Step 3: Прогнати — FAIL.** `npx vitest run src/storage/beers.test.ts src/domain/lookup-outcome.test.ts` — чотири
  нові «bid»-тести падають (аліасу немає / лишається на старому рядку); typecheck скаржиться на `byBid`.

- [ ] **Step 4: Реалізація.** `src/storage/beers.ts`, над `recordLookupSuccess`:

```ts
// #614: картка, для якої записано доказ ідентичності. byBid — доказ дав опублікований bid крамниці, а resolveByBid
// читає лише поля цієї картки з тіла запиту: текст рядка, що лінкується чи зливається, у доказ не входить (рев'ю 11,
// R1). Ставить його лише шлях bid /enrich/result; крон і шлях пошуку шукають полями рядка.
export interface AliasCard {
  brewery: string;
  name: string;
  abv?: number | null;
  byBid?: boolean;
}
```

  `recordLookupSuccess`: `aliasSource?: { brewery: string; name: string; abv?: number | null },` → `aliasSource?: AliasCard,`.
  `moveCardAlias`: сигнатура `card: { brewery: string; name: string; abv?: number | null }` → `card: AliasCard`;
  рядок перевірки

```ts
  if (!row || cardText(row.brewery) !== key.breweryText || cardText(row.name) !== key.nameText) return;
```

  →

```ts
  if (!row) return;
  // Доказ bid узято з полів самої картки — написання рядка тоді не важить (рев'ю 11, R1).
  if (!card.byBid && (cardText(row.brewery) !== key.breweryText || cardText(row.name) !== key.nameText)) return;
```

  коментар над `moveCardAlias`: `Лише коли рядок і є цією карткою (той самий cardText броварні й назви): інакше доказ
  міг стосуватися іншої картки з тією самою нормалізованою парою (рев'ю 6).` → `Лише коли рядок і є цією карткою (той
  самий cardText броварні й назви): інакше доказ пошуку міг стосуватися іншої картки з тією самою нормалізованою парою
  (рев'ю 6). Доказ bid (byBid) цієї умови не має.`

  `mergeIntoCanonical`: `aliasSource?: { brewery: string; name: string; abv?: number | null },` → `aliasSource?: AliasCard,`;

```ts
    const sameCard = source !== undefined && orphan !== undefined
      && cardText(source.brewery) === cardText(orphan.brewery) && cardText(source.name) === cardText(orphan.name);
```

  →

```ts
    const sameCard = source !== undefined && orphan !== undefined
      && (aliasSource?.byBid === true
        || (cardText(source.brewery) === cardText(orphan.brewery) && cardText(source.name) === cardText(orphan.name)));
```

  і в коментарі над ним після `…промах безпечніший за аліас.` дописати: `Виняток — доказ bid (byBid): resolveByBid бере
  лише поля картки з тіла запиту, тож текст сироти в доказ не входить (рев'ю 11, R1).`

  `src/domain/lookup-outcome.ts`: `import { …, type AliasCard } from '../storage/beers';` (у наявний імпорт
  `mergeIntoCanonical, recordLookupNotFound, …`), параметр
  `input: { brewery: string; name: string; abv?: number | null; sourceUrl?: string },` →
  `input: AliasCard & { sourceUrl?: string },`.

- [ ] **Step 5: Зелене:** `npx vitest run src/storage/beers.test.ts src/domain/lookup-outcome.test.ts`

- [ ] **Step 6: Мутації** (`scratchpad/mut-task26.json`):
  - m1 злиття без винятку: `(aliasSource?.byBid === true\n        || (` → `(false\n        || (` → падають обидва
    «Ґвара #7 byBid» тести;
  - m2 перенесення без винятку: `if (!card.byBid && (` → `if ((` → падають обидва «spelled… by bid» тести;
  - m3 перенесення завжди без умови: `if (!card.byBid && (` → `if (false && (` → падають `keeps the alias off a row
    spelled differently…` і наявний `leaves the alias when the linked row is another card`;
  - m4 `applyLookupOutcome` губить позначку: `recordLookupSuccess(deps.db, beerId, outcome.result, nowIso, input);` →
    `recordLookupSuccess(deps.db, beerId, outcome.result, nowIso, { brewery: input.brewery, name: input.name, abv: input.abv });`
    → падає `a bid-proved card moves its alias…`.

- [ ] **Step 7: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add src/storage/beers.ts src/storage/beers.test.ts src/domain/lookup-outcome.ts src/domain/lookup-outcome.test.ts
git commit -m "fix(#614): a card proved by its published bid carries its alias whatever the row's spelling"
```

---

### Task 27: шлях bid `/enrich/result` ставить `byBid` (інлайн)

**Files:**
- Modify: `src/api/routes/enrich.ts` — `const input` у гілці `accepted`
- Test: `src/api/routes/enrich.test.ts`

**Interfaces:**
- Consumes: `AliasCard.byBid` (Task 26).

- [ ] **Step 1: Тести.** `src/api/routes/enrich.test.ts`, одразу після
  `'#614 an accepted bid nobody owns links a fresh row for the card and moves the alias onto it'`:

```ts
  // Рев'ю 11, R1: сирота тієї самої нормалізованої пари з іншим написанням (кран чи інша крамниця).
  const spelledOrphan = (db: ReturnType<typeof setup>['db']) => seedBeer(db, {
    name: 'Black Bean IS', brewery: 'Browar Varvar', style: null, abv: 11, rating_global: null,
    normalized_name: normalizeName('Black Bean IS'), normalized_brewery: normalizeBrewery('Browar Varvar'),
  });

  it('#614 an accepted bid nobody owns moves the card alias onto a same-pair orphan spelled differently', async () => {
    const hydrated = {
      bid: 2002, beer_name: 'Black Bean IS', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-is', style: 'Stout', abv: 10.8, global_rating: 4.3,
    };
    const { db, app } = setup({ hydrateByBid: vi.fn(async () => new Map([[hydrated.bid, hydrated]])) });
    const blackBean = aliasedBlackBean(db);
    const spelled = spelledOrphan(db);
    expect(spelled).not.toBe(blackBean);

    const res = await post(app, '/enrich/result', {
      ...BLACK_BEAN_CARD, bid: 2002, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 2002 });
    expect(sourceOf(db, spelled)!.untappd_id).toBe(2002);
    expect(sourceOf(db, blackBean)!.untappd_id).toBe(3548624);
    // Без перенесення аліас лишався на 3548624, а bid картки — на сироті: назавжди хибний ✅.
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: spelled, abv_key: '11' }]);
  });

  it('#614 an accepted bid someone owns, landing on a same-pair orphan spelled differently, moves the alias to the owner', async () => {
    const { db, app } = setup({ hydrateByBid: vi.fn(async () => new Map()) });
    aliasedBlackBean(db);
    const coffee = seedBeer(db, {
      untappd_id: 5555, name: 'Black Bean Coffee', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.0,
      normalized_name: normalizeName('Black Bean Coffee'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const spelled = spelledOrphan(db);

    const res = await post(app, '/enrich/result', {
      ...BLACK_BEAN_CARD, bid: 5555, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 5555 });
    expect(getBeer(db, spelled)).toBeNull();
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: coffee, abv_key: '11' }]);
  });
```

- [ ] **Step 2: Прогнати — FAIL.** `npx vitest run src/api/routes/enrich.test.ts` — обидва нові тести: аліас на
  `blackBean`.

- [ ] **Step 3: Реалізація.** `src/api/routes/enrich.ts`, гілка `accepted`:

```ts
        const input = { brewery, name, abv, sourceUrl: pageUrl };
```

  →

```ts
        // #614 (рев'ю 11, R1): byBid — доказ узято лише з полів цієї картки (resolveByBid), тож аліас переходить і
        // пишеться, хоч би яке написання мав рядок пари, на який ліг bid. Шлях пошуку нижче byBid не ставить.
        const input = { brewery, name, abv, sourceUrl: pageUrl, byBid: true };
```

- [ ] **Step 4: Зелене:** `npx vitest run src/api/routes/enrich.test.ts`

- [ ] **Step 5: Мутації** (`scratchpad/mut-task27.json`): `sourceUrl: pageUrl, byBid: true };` → `sourceUrl: pageUrl };`
  → падають обидва нові тести. Пошуковий шлях з `byBid: true` (`abv: row.abv, sourceUrl: pageUrl }` →
  `abv: row.abv, sourceUrl: pageUrl, byBid: true }`) → падає наявний
  `'#614 writes no alias when the web fallback searched with the text of an orphan another card created'`.

- [ ] **Step 6: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts
git commit -m "fix(#614): the shop-bid path marks its proof, so a same-pair row's spelling no longer strands the alias"
```

---

### Task 28: аліас раніше за пару в `ensureBeerRow`; `spec.md` (інлайн)

**Files:**
- Modify: `src/api/routes/enrich.ts` — `ensureBeerRow`, коментар репарації
- Modify: `spec.md` — §3.6.1, «Картка з аліасом (#614)», §5.2
- Test: `src/api/routes/enrich.test.ts`, `src/api/routes/merge-alias-loop.test.ts`

- [ ] **Step 1: Тести роуту.** `src/api/routes/enrich.test.ts`, у `describe('POST /enrich/candidates')` після
  `'#614 a card whose ABV differs from the alias key still gets its own orphan'`:

```ts
  it('#614 a card with an alias is answered by the alias even when an orphan of its pair is spelled differently', async () => {
    const { db, app } = setup();
    aliasedBlackBean(db);
    seedBeer(db, {
      name: 'Black Bean IS', brewery: 'Browar Varvar', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('Black Bean IS'), normalized_brewery: normalizeBrewery('Browar Varvar'),
    });
    const body = await (await post(app, '/enrich/candidates', { beers: [BLACK_BEAN_CARD] })).json();
    // Рев'ю 11, R3: /match відповідає аліасом першим, тож і /enrich/* бере аліас раніше за пару; сирота пари — крону.
    expect(body.candidates[0].eligible).toBe(false);
    expect(beerCount(db)).toBe(2);
  });
```

  Після `'#614 an accepted bid someone owns, landing on a same-pair orphan spelled differently, moves the alias to the owner'`
  (Task 27):

```ts
  it('#614 an accepted contradicting bid on an alias never relinks a linked ABV twin of the card pair', async () => {
    const hydrated = {
      bid: 7777, beer_name: 'Black Bean IS', brewery_name: 'Varvar Brew', brewery_alias: ['varvar'],
      beer_slug: 'varvar-black-bean-is', style: 'Stout', abv: 10.8, global_rating: 4.2,
    };
    const { db, app } = setup({ hydrateByBid: vi.fn(async () => new Map([[hydrated.bid, hydrated]])) });
    aliasedBlackBean(db);
    const twin = seedBeer(db, {
      untappd_id: 777, untappd_id_source: 'bid', name: BLACK_BEAN_CARD.name, brewery: BLACK_BEAN_CARD.brewery,
      style: 'Stout', abv: 9.5, rating_global: 4.0,
      normalized_name: normalizeName(BLACK_BEAN_CARD.name), normalized_brewery: normalizeBrewery(BLACK_BEAN_CARD.brewery),
    });

    const res = await post(app, '/enrich/result', {
      ...BLACK_BEAN_CARD, bid: 7777, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [] },
    });

    expect(await res.json()).toMatchObject({ status: 'matched', untappd_id: 7777 });
    // Рев'ю 11, R3: пара раніше за аліас віддавала картці рядок близнюка, і bid картки його перелінковував.
    expect(sourceOf(db, twin)!.untappd_id).toBe(777);
    const cardRow = (db.prepare('SELECT id FROM beers WHERE untappd_id = 7777').get() as { id: number }).id;
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: cardRow, abv_key: '11' }]);
  });
```

- [ ] **Step 2: Наскрізний тест.** `src/api/routes/merge-alias-loop.test.ts`, наприкінці `describe`:

```ts
  it('a shop bid changing twice on the card never relinks the linked ABV twin of its pair — no bid ping-pong', async () => {
    // Рев'ю 11, R3 (проба review10/writetime, PD): ensureBeerRow брав пару раніше за аліас — рядок близнюка з тим
    // самим текстом. Суперечливий bid картки перелінковував його, bid близнюка — назад, на кожному завантаженні.
    const beer = (bid: number, beer_name: string, abv: number) => ({
      bid, beer_name, brewery_name: 'Varvar Brew', brewery_alias: ['varvar'], beer_slug: null, style: 'Stout', abv, global_rating: 4.0,
    });
    const hydrated = new Map([
      [777, beer(777, 'Black Bean Light', 9.5)], [7777, beer(7777, 'Black Bean IS', 10.8)], [8888, beer(8888, 'Black Bean IS v2', 10.8)],
    ]);
    const { db, post, match } = loop(async () => hydrated);
    const page = (card: typeof CARD, bid: number) => ({ ...card, bid, brand: 'VARVAR', pageUrl: FLASKER_PAGE, algolia: { hits: [], nbHits: 0 } });
    const bidOf = (id: number) => (db.prepare('SELECT untappd_id FROM beers WHERE id = ?').get(id) as { untappd_id: number }).untappd_id;

    await post('/enrich/candidates', { beers: [{ ...CARD, bid: 3548624 }] });
    expect(await post('/enrich/result', RESULT)).toMatchObject({ status: 'matched', untappd_id: 3548624 });
    const twin = { ...CARD, abv: 9.5 };
    await post('/enrich/candidates', { beers: [{ ...twin, bid: 777 }] });
    expect(await post('/enrich/result', page(twin, 777))).toMatchObject({ status: 'matched', untappd_id: 777 });
    const twinRow = (db.prepare('SELECT id FROM beers WHERE untappd_id = 777').get() as { id: number }).id;

    for (const bid of [7777, 8888, 8888]) {
      await post('/enrich/candidates', { beers: [{ ...CARD, bid }, { ...twin, bid: 777 }] });
      expect(await post('/enrich/result', page(CARD, bid))).toMatchObject({ status: 'matched', untappd_id: bid });
      expect(await post('/enrich/result', page(twin, 777))).toMatchObject({ status: 'matched', untappd_id: 777 });
      expect(bidOf(twinRow)).toBe(777);
    }
    expect(await match(CARD)).toMatchObject({ matched_beer: { untappd_id: 8888 }, source: 'exact' });
  });
```

  У тесті N1 (`'a shop bid accepted on the card\'s own row moves the card off an older alias…'`) коментар
  `// Раунд 3: картка з ABV і правильним bid крамниці — ensureBeerRow знаходить власну сироту за парою.` →
  `// Раунд 3: картка з ABV і правильним bid крамниці — аліас → репарація; ensureOrphan повертає власну сироту картки.`

- [ ] **Step 3: Прогнати — FAIL.** `npx vitest run src/api/routes/enrich.test.ts src/api/routes/merge-alias-loop.test.ts`
  — три нові тести падають (eligible `true`; bid близнюка 7777).

- [ ] **Step 4: Реалізація.** `src/api/routes/enrich.ts`, `ensureBeerRow` і коментар над ним:

```ts
// Ensures a beer row exists for (brewery, name) and returns it.
// May return a pre-existing matched row, not only a freshly created orphan.
// #369: `facts` are shop-published abv/style relayed by the extension. On insert
// they seed the row; on an existing orphan they fill NULL columns only. A newly
// gained ABV re-arms the lookup backoff, because the previous attempt ran blind.
// #614: першим — аліас картки (той самий ключ, що в /match, з СИРИМ ABV). Без нього перед сиротою картка, яку /match
// уже відповідає через аліас, на повторному раунді (SWR-null кешу, суперечливий bid) отримувала сироту зі своїм
// текстом, і /match віддавав її exact без ✅. Без нього перед парою картка отримувала рядок близнюка тієї самої пари
// (інше написання чи ABV-близнюк), і її суперечливий bid перелінковував рядок близнюка — пінг-понг (рев'ю 11, R3).
// viaAlias каже викликачеві, що рядок — канонічний, а не рядок цієї картки.
function ensureBeerRow(
  db: ApiDeps['db'], brewery: string, name: string, facts: OrphanFacts = {},
): BeerRow & { viaAlias: boolean } {
  const aliased = findAliasTarget(db, brewery, name, facts.abv);
  if (aliased) return { ...aliased, viaAlias: true };
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  const existing = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (existing) {
    const { abvGained, changed } = fillOrphanFacts(db, existing.id, facts);
    if (abvGained) rearmLookup(db, existing.id);
    return { ...(abvGained || changed ? getBeer(db, existing.id)! : existing), viaAlias: false };
  }
  // #617: сюди доходимо, лише коли рядка з цією нормалізованою парою немає зовсім — вставка сироти.
  const id = ensureOrphan(db, {
    name, brewery,
    style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
    rating_global: null, normalized_name, normalized_brewery,
  });
  return { ...getBeer(db, id)!, viaAlias: false };
}
```

  Коментар репарації: `bid пишеться на нову\n        // сироту цієї картки` → `bid пишеться на\n        // сироту цієї картки`;
  `Рядка з нормалізованою парою картки немає — інакше\n        // ensureBeerRow не дійшов би до аліасу.` →
  `ensureOrphan повертає лише сироту пари\n        // картки (з іншим написанням — bid ляже на неї, #636) або нову: злінкований рядок пари, як-от ABV-близнюк, не\n        // переписується ніколи (рев'ю 11, R3).`

- [ ] **Step 5: Зелене:** `npx vitest run src/api/routes/enrich.test.ts src/api/routes/merge-alias-loop.test.ts`

- [ ] **Step 6: Мутації** (`scratchpad/mut-task28.json`): повернути пару першою — перенести
  `  const aliased = findAliasTarget(db, brewery, name, facts.abv);\n  if (aliased) return { ...aliased, viaAlias: true };\n`
  з початку функції перед коментар `// #617:` → падають три нові тести; тести задачі 27 лишаються зеленими (PA
  проходить і шляхом пари).

- [ ] **Step 7: `spec.md`.**
  - §3.6.1, `beer_id`: `канонічний рядок, який довело злиття` → `рядок, який довів найновіший доказ для цієї картки
    (злиття чи лінк)`.
  - §3.6.1, «**Запис**»: `**Запис** — лише \`mergeIntoCanonical\`, у транзакції до \`DELETE\`.` → `**Запис** — новий
    аліас створює лише \`mergeIntoCanonical\`, у транзакції до \`DELETE\`; наявний переносять \`ON CONFLICT\` злиття і
    \`recordLookupSuccess\`.`; `Аліас пишеться, **лише коли злита сирота і є цією карткою** (той самий \`cardText\`
    броварні й назви), і не\nпишеться для порожнього тексту.` → `Аліас пишеться, **лише коли злита сирота і є цією
    карткою** (той самий \`cardText\`\nброварні й назви), — крім доказу опублікованим bid: він узятий лише з полів
    картки, тож написання сироти не важить; для порожнього тексту не пишеться.`; `переносить\nнаявний аліас її ключа на
    цей рядок;` → `переносить\nнаявний аліас її ключа на цей рядок (на шляху bid — на будь-який рядок, на який ліг bid
    картки);`.
  - «Картка з аліасом (#614)»: `шукають рядок так: нормалізована пара →\nаліас картки (той самий ключ, що в \`/match\`)
    → нова сирота.` → `шукають рядок так: аліас картки (той самий\nключ, що в \`/match\`) → нормалізована пара → нова
    сирота; аліас першим, бо рядок пари може бути близнюком (інше написання чи ABV), і суперечливий bid картки
    перелінковував би його.`; `записується на нову сироту картки` → `записується на сироту картки (\`ensureOrphan\`:
    наявна сирота пари або нова; злінкований рядок пари — ніколи)`.
  - §5.2, інваріант #614: `Аліас доводить лише той bid, під яким записаний, і лише картку, яка і є злитою сиротою.` →
    `Аліас доводить лише той bid, під яким записаний, і лише картку, яка і є злитою сиротою, — або картку, чий
    опублікований bid прийнято (доказ узято з її полів).`; `\`/enrich/*\` для картки з аліасом сироти не створюють.` →
    `\`/enrich/*\` для картки з аліасом сироти не створюють і рядка близнюка її пари не перелінковують.`

- [ ] **Step 8: Повний гейт і коміт**

```bash
npm test && npm run typecheck
git add src/api/routes/enrich.ts src/api/routes/enrich.test.ts src/api/routes/merge-alias-loop.test.ts spec.md
git commit -m "fix(#614): a card's alias is checked before its normalized pair, so a twin row is never relinked"
```

---

## Після раунду

1. Реплеї: `review10/writetime.mts` (PA/PA2 — картка на 2002; PD — рядок близнюка тримає 777; PB — обмеження R2),
   `review9/abvrow.mts`, `review7/twin-pingpong.mts`, `review7/plan-and-revive.mts`, `periph-e2e.mts`.
2. Issue на R2 (колонка джерела доказу в аліасі).
3. Рібейс на `origin/main`, повний гейт, PR (ядро + периферія + раунди 10–11), цикл AI-рев'ю; мерджить користувач.

## Самоперевірка плану проти спеки

| Розділ спеки | Де |
|---|---|
| Виняток доказу bid у `mergeIntoCanonical` і `recordLookupSuccess` | Task 26 |
| `byBid` ставить лише шлях bid `/enrich/result` | Task 27 (мутація пошукового шляху) |
| Порядок `ensureBeerRow`: аліас → пара → сирота | Task 28 |
| Репарація лінкує лише сироту; злінкований близнюк не переписується | Task 28 (тест роуту й наскрізний) |
| Заявка → доказ: два нові рядки | Task 26–28 |
| Обмеження R2 і «новий рядок на кожну зміну bid» | спека; тестом не охороняються (свідома поведінка) |
| `spec.md` | Task 28 |
