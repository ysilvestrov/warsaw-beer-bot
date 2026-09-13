# Гідратація рейтингів через Algolia за bid — план обв'язки (#616)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** підключити ядро #616 до продакшну: `refreshAllUntappd` штампує звірку за трьома станами блоку
«Global Rating» і посилює провенанс; дайджест показує покриття циклу; крон-слот переходить на
`hydrateRatings`, а стара HTML-джоба рейтингів, парсер сторінки пива і їхні функції сховища
видаляються; `spec.md` описує нову поведінку.

**Architecture:** друга стадія (CLAUDE.md: план на ядро → рев'ю → окремий план на обв'язку). Ядро
вже в гілці і пройшло наскрізне рев'ю (`2ae2a2f`, `454b3fd`). **Ядро й обв'язка деплояться одним PR**:
поки `refreshTapRatings` підключений, `beer-page.ts` пише `0` для «N/A», а `recordRatingNotFound`
інкрементує `rating_refresh_count`, який відтепер означає «Algolia не знає bid» (рев'ю ядра, I1).

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, node-cron, cheerio, Vitest 4 (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-13-616-rating-hydration-design.md`
(ядро: `docs/superpowers/plans/2026-09/2026-09-13-616-rating-hydration-core.md`, розділ «Результат наскрізного рев'ю ядра»)

## Global Constraints

- **Коментарі українською, ідентифікатори англійською.**
- **Повний гейт після КОЖНОЇ задачі**: `npm test && npm run typecheck`. Відомий флейк:
  `src/sources/websearch/resolver.test.ts` «serializes concurrent calls» — один перезапуск; будь-що інше червоне — зупинка.
- **Кожен новий тест мутаційно доведений** (таблиця мутацій у задачі; мутація, після якої названий
  тест зелений, — дефект тесту). Гарнес: `node <scratchpad>/mutate616.mjs <spec.json>`, де scratchpad —
  `/tmp/claude-1000/-home-ysi-warsaw-beer-bot/2e504947-7a48-4fd0-8936-b87a8d4c8c12/scratchpad`;
  spec: `{ "file", "test": [..], "mutations": [{ "id", "from" (рівно одне входження), "to", "expect": [..] }] }`.
- **Сіди з видимими значеннями** там, де тест перевіряє «не чіпає».
- **Ніяких `as unknown as`** у новому не-тестовому коді.
- **Код важить більше за план** — розбіжність сигнатури/імпорту/назви: іди за кодом, назви у звіті.
- **Розширення (`extension/**`) не зачіпається** → `docs/extension-install-uk.md` і `extension/CHANGELOG.md` не змінюються.
- Задачі 1–5 дрібні (повний код, ≤2 файли + тести/фікстура, без нових рішень) → **інлайн**. Задача 6
  (≥6 файлів, видалення) → **диспатч** імплементеру, **останньою**: він комітить сам.
- Наприкінці: наскрізне рев'ю всієї гілки (ядро + обв'язка) → `git fetch origin main` + рібейс, якщо зрушив →
  повний гейт → PR.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `src/sources/untappd/scraper.ts` (зміна) | `ScrapedBeer.global_rating_shown` — блок «Global Rating» знайдено |
| `tests/fixtures/untappd/user-beers-na.html` (новий) | дві картки зі знімка профілю (N/A і число) + синтетична без блоку |
| `src/storage/beers.ts` (зміна) | `recordProfileBeer`; видалення `recordRating*`, `listRatingRefreshCandidates` |
| `src/jobs/refresh-untappd.ts` (зміна) | гілка «рядок за bid» → `recordProfileBeer` |
| `src/storage/stats.ts`, `src/jobs/daily-status.ts` (зміна) | `ratingsChecked30d` і друге число рядка «Рейтинги» |
| `spec.md` (зміна) | нова поведінка рейтингів |
| `src/index.ts` (зміна) | крон-слот → `hydrateRatings` з `algoliaBreaker` |
| `src/jobs/hydrate-ratings.wiring.test.ts` (новий) | страж композиційного кореня |
| `src/jobs/refresh-tap-ratings.ts` + тест, `tests/fixtures/untappd/beer-page-magic-road.html` (видалення) | стара HTML-джоба |
| `src/sources/untappd/beer-page.ts` (зміна) | лишається лише `buildBeerPageUrl` (його імпортує `src/bot/commands/beer-link.ts`) |

---

### Task 1: `parseUserBeersPage` розрізняє «блоку немає» і «N/A»

**Files:**
- Modify: `src/sources/untappd/scraper.ts`
- Create: `tests/fixtures/untappd/user-beers-na.html`
- Test: `src/sources/untappd/scraper.test.ts`

**Interfaces:**
- Produces: `ScrapedBeer.global_rating_shown: boolean`.

- [ ] **Step 1: фікстура**

`tests/fixtures/untappd/user-beers-na.html` — перші дві картки дослівно зі знімка профілю
2026-09-13 (кодування назв Budvar відновлене до UTF-8), третя синтетична:

```html
<div class="distinct-list-list">
<div class="beer-item" data-bid="6869890">
		<a class="label" data-track="distinctbeers" data-href=":view/image" href="https://untappd.com/b/funky-fluid-prototype/6869890">
			<img src="https://assets.untappd.com/site/beer_logos/beer-6869890_04dec_sm.jpeg" alt="Prototype label" loading="lazy">
		</a><div class="beer-details">
			<p class="name"><a class="track-click" data-track="distinctbeers" data-href=":view/name" href="https://untappd.com/b/funky-fluid-prototype/6869890">Prototype</a></p>
			<p class="brewery"><a class="track-click" data-track="distinctbeers" data-href=":view/brewery" href="https://untappd.com/FunkyFluid">Funky Fluid</a></p>
			<p class="style">IPA - New England / Hazy</p>
			<div class="ratings">
								<div class="you">
					<p>Global Rating (N/A)</p>
					<div class="rating_bar_awesome">
						<div class="caps" data-rating="0">
		<div class="cap"></div>
		<div class="cap"></div>
		<div class="cap"></div>
		<div class="cap"></div>
		<div class="cap"></div>
	</div>					</div>
				</div>
			</div>
		</div>

		<div class="details">
			<p class="abv">
				6.3% ABV			</p><p class="ibu">
				N/A IBU			</p>
		</div>
	</div>
<div class="beer-item" data-bid="39819">
		<a class="label" data-track="distinctbeers" data-href=":view/image" href="https://untappd.com/b/budejovicky-budvar-budweiser-budvar-czechvar-dark/39819">
			<img src="https://assets.untappd.com/site/beer_logos/beer-39819_60ed2_sm.jpeg" alt="Budweiser Budvar / Czechvar DARK label" loading="lazy">
		</a><div class="beer-details">
			<p class="name"><a class="track-click" data-track="distinctbeers" data-href=":view/name" href="https://untappd.com/b/budejovicky-budvar-budweiser-budvar-czechvar-dark/39819">Budweiser Budvar / Czechvar DARK</a></p>
			<p class="brewery"><a class="track-click" data-track="distinctbeers" data-href=":view/brewery" href="https://untappd.com/BudjovickBudvar">Budějovický Budvar</a></p>
			<p class="style">Lager - Tmavý (Czech Dark)</p>
			<div class="ratings">
									<div class="you">
						<p>Your Rating (3.8)</p>
						<div class="rating_bar_awesome">
							<div class="caps" data-rating="3.8">
		<div class="cap cap-100"></div>
		<div class="cap cap-100"></div>
		<div class="cap cap-100"></div>
		<div class="cap cap-80"></div>
		<div class="cap"></div>
	</div>						</div>
					</div>
									<div class="you">
					<p>Global Rating (3.3)</p>
					<div class="rating_bar_awesome">
						<div class="caps" data-rating="3.29971">
		<div class="cap cap-100"></div>
		<div class="cap cap-100"></div>
		<div class="cap cap-100"></div>
		<div class="cap cap-30"></div>
		<div class="cap"></div>
	</div>					</div>
				</div>
			</div>
		</div>

		<div class="details">
			<p class="abv">
				4.7% ABV			</p><p class="ibu">
				24 IBU			</p>
		</div>
	</div>
<!-- Синтетична картка (#616): блоку «Global Rating» немає. У знімку такої не було — стан захищає від зміни розмітки. -->
<div class="beer-item" data-bid="100001">
		<div class="beer-details">
			<p class="name"><a href="https://untappd.com/b/synthetic/100001">Synthetic No Global Block</a></p>
			<p class="brewery"><a href="https://untappd.com/Synthetic">Synthetic Brewery</a></p>
			<p class="style">Lager - Pale</p>
			<div class="ratings">
				<div class="you">
					<p>Their Rating (4)</p>
					<div class="rating_bar_awesome"><div class="caps" data-rating="4"></div></div>
				</div>
			</div>
		</div>
		<div class="details"><p class="abv">5% ABV</p></div>
	</div>
</div>
```

- [ ] **Step 2: тести**

У кінець `src/sources/untappd/scraper.test.ts` (якщо `fs`/`path` у файлі не імпортовані — додати
`import fs from 'node:fs';` і `import path from 'node:path';`, як у сусідніх тестах із фікстурами):

```ts
describe('parseUserBeersPage — Global Rating block (#616)', () => {
  const fixture = (name: string) =>
    fs.readFileSync(path.join(__dirname, '../../../tests/fixtures/untappd', name), 'utf8');

  test('a number, «N/A» and a missing block are three different states', () => {
    const items = parseUserBeersPage(fixture('user-beers-na.html'));
    expect(items.map((b) => ({ bid: b.bid, shown: b.global_rating_shown, rating: b.global_rating }))).toEqual([
      { bid: 6869890, shown: true, rating: null },
      { bid: 39819, shown: true, rating: 3.3 },
      { bid: 100001, shown: false, rating: null },
    ]);
  });

  test('the captured profile page shows the block on every card', () => {
    const items = parseUserBeersPage(fixture('user-beers.html'));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((b) => b.global_rating_shown)).toBe(true);
  });
});
```

- [ ] **Step 3: червоний крок**

Run: `npx vitest run src/sources/untappd/scraper.test.ts`
Expected: FAIL — `shown: undefined` замість `true`/`false` (і typecheck-помилка поля, яку vitest не показує).

- [ ] **Step 4: реалізація**

`src/sources/untappd/scraper.ts`, `interface ScrapedBeer`, після `global_rating: number | null;`:

```ts
  /** #616: блок «Global Rating» на картці знайдено — з числом або «N/A». Без блоку сторінка про рейтинг нічого не каже. */
  global_rating_shown: boolean;
```

У `parseUserBeersPage` цикл `.ratings .you` і `push`:

```ts
    let their_rating: number | null = null;
    let global_rating: number | null = null;
    let global_rating_shown = false;
    details.find('.ratings .you').each((_, you) => {
      const label = $(you).find('p').first().text().trim();
      const raw = $(you).find('.caps[data-rating]').first().attr('data-rating');
      if (/^Their Rating/i.test(label)) their_rating = parseRating(raw);
      // #616: глобальний рейтинг Untappd — «0/N/A = менш ніж 10 оцінок», округлення до 2 знаків.
      else if (/^Global Rating/i.test(label)) {
        global_rating = untappdRating(raw);
        global_rating_shown = true;
      }
    });

    out.push({ bid, beer_name, brewery_name, style, abv, their_rating, global_rating, global_rating_shown });
```

(Рядки `let their_rating`/`let global_rating` уже є — додати лише `global_rating_shown`.)

- [ ] **Step 5: повний гейт** — `npm test && npm run typecheck`.

- [ ] **Step 6: мутації** (`test: ["src/sources/untappd/scraper.test.ts"]`)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | прибрати `global_rating_shown = true;` | `a number, «N/A» and a missing block…`, `the captured profile page…` |
| 2 | `let global_rating_shown = false;` → `= true;` | `a number, «N/A» and a missing block…` |

- [ ] **Step 7: коміт**

```bash
git add src/sources/untappd/scraper.ts src/sources/untappd/scraper.test.ts tests/fixtures/untappd/user-beers-na.html
git commit -m "feat(#616): parseUserBeersPage розрізняє блок «Global Rating» з числом, «N/A» і відсутній"
```

---

### Task 2: `recordProfileBeer` у сховищі

**Files:**
- Modify: `src/storage/beers.ts` (після `applyHydratedRatings`)
- Test: `src/storage/beers.test.ts` (у кінець)

**Interfaces:**
- Consumes: `strongerSource`, `UntappdIdSource` (уже в `beers.ts`); `beers.rating_checked_at` (ядро).
- Produces:
  ```ts
  export interface ProfileBeerFacts { global_rating: number | null; global_rating_shown: boolean; abv: number | null }
  export function recordProfileBeer(db: DB, beerId: number, facts: ProfileBeerFacts, nowIso: string): void;
  ```
  `ScrapedBeer` (Task 1) структурно сумісний з `ProfileBeerFacts`.

- [ ] **Step 1: тести**

```ts
// ---------------------------------------------------------------------------
// #616 — рядок, знайдений за bid зі сторінки /beers профілю
// ---------------------------------------------------------------------------

import { recordProfileBeer } from './beers';

describe('recordProfileBeer (#616)', () => {
  const NOW_ISO = '2026-09-13T03:00:00.000Z';
  type Source = 'search' | 'bid' | 'checkin' | 'curated' | null;

  function seedRow(db: ReturnType<typeof fresh>, o: { rating: number | null; abv: number | null; source?: Source; checkedAt?: string | null }): number {
    const id = seedBeer(db, {
      untappd_id: 6869890, name: 'Prototype', brewery: 'Funky Fluid', style: 'IPA', abv: o.abv,
      rating_global: o.rating, normalized_name: 'prototype', normalized_brewery: 'funky fluid',
    });
    // `source: null` — справжній кейс «провенансу немає», тож дефолт лише для відсутнього ключа.
    db.prepare('UPDATE beers SET untappd_id_source = ?, rating_checked_at = ? WHERE id = ?')
      .run(o.source === undefined ? 'search' : o.source, o.checkedAt ?? null, id);
    return id;
  }

  test('a Global Rating number overwrites the rating and stamps; page ABV wins when present', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 3.5, abv: 5.0 });
    recordProfileBeer(db, id, { global_rating: 4.05, global_rating_shown: true, abv: 6.3 }, NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 4.05, abv: 6.3, rating_checked_at: NOW_ISO });
  });

  test('Global Rating (N/A) writes NULL and stamps; an absent page ABV keeps the stored one', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 3.64, abv: 6.0 });
    recordProfileBeer(db, id, { global_rating: null, global_rating_shown: true, abv: null }, NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: null, abv: 6.0, rating_checked_at: NOW_ISO });
  });

  test('a card without the block leaves rating and stamp alone but still takes the page ABV', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 3.9, abv: 5.0, checkedAt: '2026-09-01T00:00:00.000Z' });
    recordProfileBeer(db, id, { global_rating: null, global_rating_shown: false, abv: 6.3 }, NOW_ISO);
    expect(getBeer(db, id)).toMatchObject({ rating_global: 3.9, abv: 6.3, rating_checked_at: '2026-09-01T00:00:00.000Z' });
  });

  test.each([
    [null, 'checkin'], ['search', 'checkin'], ['bid', 'checkin'], ['checkin', 'checkin'], ['curated', 'curated'],
  ] as [Source, Source][])('provenance %s → %s, with and without the block', (stored, expected) => {
    for (const shown of [true, false]) {
      const db = fresh();
      const id = seedRow(db, { rating: 3.9, abv: 5.0, source: stored });
      recordProfileBeer(db, id, { global_rating: 3.9, global_rating_shown: shown, abv: 5.0 }, NOW_ISO);
      expect(getBeer(db, id)?.untappd_id_source).toBe(expected);
    }
  });

  test('bumps the catalog only when the rating or the ABV actually changed', () => {
    const db = fresh();
    const id = seedRow(db, { rating: 4.05, abv: 6.3 });
    const v0 = catalogVersion();
    recordProfileBeer(db, id, { global_rating: 4.05, global_rating_shown: true, abv: 6.3 }, NOW_ISO);
    expect(catalogVersion()).toBe(v0);                     // нічого не змінилось
    recordProfileBeer(db, id, { global_rating: 4.1, global_rating_shown: true, abv: 6.3 }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 1);                 // рейтинг
    recordProfileBeer(db, id, { global_rating: 4.1, global_rating_shown: false, abv: 7.0 }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);                 // лише ABV
    recordProfileBeer(db, id, { global_rating: 4.1, global_rating_shown: false, abv: null }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);                 // ABV сторінки порожній — не зміна
    recordProfileBeer(db, id, { global_rating: null, global_rating_shown: false, abv: null }, NOW_ISO);
    expect(catalogVersion()).toBe(v0 + 2);                 // без блоку рейтинг не змінюється
  });

  test('an unknown beer id is a no-op', () => {
    const db = fresh();
    const v0 = catalogVersion();
    expect(() => recordProfileBeer(db, 99_999, { global_rating: 4.0, global_rating_shown: true, abv: 5.0 }, NOW_ISO)).not.toThrow();
    expect(catalogVersion()).toBe(v0);
  });
});
```

- [ ] **Step 2: червоний крок** — `npx vitest run src/storage/beers.test.ts` → FAIL (`recordProfileBeer is not a function`).

- [ ] **Step 3: реалізація** (`src/storage/beers.ts`, після `applyHydratedRatings`)

```ts
export interface ProfileBeerFacts {
  global_rating: number | null;
  global_rating_shown: boolean;
  abv: number | null;
}

// #616: рядок, знайдений за bid зі сторінки `/beers` профілю (refreshAllUntappd). Блок «Global Rating»
// (число або «N/A») — пряма відповідь Untappd про рейтинг: перезапис і штамп звірки. Без блоку
// сторінка про рейтинг нічого не каже — рейтинг і штамп не чіпаються. ABV сторінки перемагає, коли
// він є (як і до #616). Сторінка — власний запис Untappd про те, що користувач пив цей bid, тож
// провенанс лінка посилюється до 'checkin' ('curated' лишається).
export function recordProfileBeer(
  db: DB,
  beerId: number,
  facts: ProfileBeerFacts,
  nowIso: string,
): void {
  const before = db
    .prepare('SELECT rating_global, abv, untappd_id_source FROM beers WHERE id = ?')
    .get(beerId) as
    | { rating_global: number | null; abv: number | null; untappd_id_source: UntappdIdSource | null }
    | undefined;
  if (!before) return;
  const source = strongerSource(before.untappd_id_source, 'checkin');
  if (facts.global_rating_shown) {
    db.prepare(
      `UPDATE beers SET
         rating_global = ?,
         abv = COALESCE(?, abv),
         rating_checked_at = ?,
         untappd_id_source = ?
       WHERE id = ?`,
    ).run(facts.global_rating, facts.abv, nowIso, source, beerId);
  } else {
    db.prepare('UPDATE beers SET abv = COALESCE(?, abv), untappd_id_source = ? WHERE id = ?')
      .run(facts.abv, source, beerId);
  }
  const abvChanged = facts.abv !== null && facts.abv !== before.abv;
  const ratingChanged = facts.global_rating_shown && facts.global_rating !== before.rating_global;
  // Кеш /match залежить від рейтингу й ABV, не від штампа чи провенансу.
  if (abvChanged || ratingChanged) bumpCatalogVersion();
}
```

- [ ] **Step 4: повний гейт.**

- [ ] **Step 5: мутації** (`file: src/storage/beers.ts`, `test: ["src/storage/beers.test.ts"]`)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | `if (facts.global_rating_shown) {` → `if (true) {` | `a card without the block…` |
| 2 | `if (facts.global_rating_shown) {` → `if (false) {` | `a Global Rating number overwrites…` |
| 3 | `rating_global = ?,\n         abv = COALESCE(?, abv),` → `rating_global = COALESCE(?, rating_global),\n         abv = COALESCE(?, abv),` | `Global Rating (N/A) writes NULL…` |
| 4 | `rating_checked_at = ?,\n         untappd_id_source = ?` → `rating_checked_at = CASE WHEN ? IS NULL THEN rating_checked_at ELSE rating_checked_at END,\n         untappd_id_source = ?` | `a Global Rating number overwrites…` |
| 5 | `strongerSource(before.untappd_id_source, 'checkin')` → `before.untappd_id_source ?? 'checkin'` | `provenance search → checkin…` |
| 6 | у гілці без блоку `untappd_id_source = ? WHERE id = ?').run(facts.abv, source, beerId)` → `untappd_id_source = untappd_id_source WHERE id = ? AND ? IS NOT NULL').run(facts.abv, beerId, source)` | `provenance … → checkin` (кейс `shown=false`) |
| 7 | `rating_global = ?,\n         abv = COALESCE(?, abv),` → `rating_global = ?,\n         abv = ?,` | `Global Rating (N/A) writes NULL…` (ABV 6.0 стерто) |
| 8 | `if (abvChanged \|\| ratingChanged)` → `if (ratingChanged)` | `bumps the catalog only when…` |
| 9 | `if (abvChanged \|\| ratingChanged)` → `if (abvChanged)` | `bumps the catalog only when…` |
| 10 | `if (abvChanged \|\| ratingChanged) bumpCatalogVersion();` → `bumpCatalogVersion();` | `bumps the catalog only when…` |
| 11 | `facts.abv !== null && facts.abv !== before.abv` → `facts.abv !== before.abv` | `bumps the catalog only when…` |
| 12 | `facts.global_rating_shown && facts.global_rating !== before.rating_global` → `facts.global_rating !== before.rating_global` | `bumps the catalog only when…` |
| 13 | прибрати `if (!before) return;` | `an unknown beer id is a no-op` |

- [ ] **Step 6: коміт**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts
git commit -m "feat(#616): recordProfileBeer — штамп звірки за блоком «Global Rating», провенанс до checkin, бамп лише при зміні"
```

---

### Task 3: `refreshAllUntappd` — гілка «рядок за bid» через `recordProfileBeer`

**Files:**
- Modify: `src/jobs/refresh-untappd.ts`
- Test: `src/jobs/refresh-untappd.test.ts`

**Interfaces:**
- Consumes: `recordProfileBeer(db, beerId, facts, nowIso)` (Task 2); `ScrapedBeer.global_rating_shown` (Task 1).

- [ ] **Step 1: тести**

У `src/jobs/refresh-untappd.test.ts`:

(а) у наявному тесті `'global_rating null on /beers → rating_global of the row found by bid set to NULL (idempotent re-read)'`
перейменувати на `'Global Rating (N/A) on /beers → rating_global of the row found by bid set to NULL and stamped (#616)'`,
у виклик додати `now: () => new Date('2026-09-13T03:00:00.000Z')` і в кінець:

```ts
    expect(row.rating_checked_at).toBe('2026-09-13T03:00:00.000Z');
```

(б) у тесті `'#617: updates and marks the row with the scraped bid, not a same-name vintage twin'` у кінець:

```ts
    const stamp = (id: number) =>
      (db.prepare('SELECT rating_checked_at FROM beers WHERE id = ?').get(id) as { rating_checked_at: string | null }).rating_checked_at;
    expect(stamp(ten)).not.toBeNull();
    expect(stamp(eight)).toBeNull();
```

(в) нові тести в кінець `describe('refreshAllUntappd', …)`:

```ts
  test('#616: a card without the Global Rating block leaves the rating and the stamp of the row found by bid', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');
    const id = insertBeer(db, 777, 'Quiet Page', 'Silent Brewery', 3.9);
    db.prepare("UPDATE beers SET rating_checked_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(id);
    const html = `
      <div class="beer-item" data-bid="777">
        <div class="beer-details">
          <p class="name"><a href="/b/x/777">Quiet Page</a></p>
          <p class="brewery"><a href="/x">Silent Brewery</a></p>
          <p class="style">Lager</p>
          <div class="ratings">
            <div class="you">
              <p>Their Rating (4)</p>
              <div class="caps" data-rating="4"></div>
            </div>
          </div>
        </div>
      </div>`;
    await refreshAllUntappd({
      db, log: silentLog, http: fakeHttp({ 'https://untappd.com/user/someone/beers': html }),
      now: () => new Date('2026-09-13T03:00:00.000Z'),
    });
    const row = db.prepare('SELECT rating_global, rating_checked_at FROM beers WHERE id = ?').get(id) as { rating_global: number | null; rating_checked_at: string | null };
    expect(row).toEqual({ rating_global: 3.9, rating_checked_at: '2026-09-01T00:00:00.000Z' });
  });

  test('#616: the profile page strengthens a searched link to checkin', async () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUntappdUsername(db, 1, 'someone');
    const id = insertBeer(db, 888, 'Guessed Beer', 'Some Brewery', 3.7);
    db.prepare("UPDATE beers SET untappd_id_source = 'search' WHERE id = ?").run(id);
    await refreshAllUntappd({
      db, log: silentLog,
      http: fakeHttp({ 'https://untappd.com/user/someone/beers': PAGE_ONE_BEER(888, 'Guessed Beer', 'Some Brewery', '3.72') }),
    });
    const row = db.prepare('SELECT untappd_id_source, rating_global FROM beers WHERE id = ?').get(id) as { untappd_id_source: string; rating_global: number };
    expect(row).toEqual({ untappd_id_source: 'checkin', rating_global: 3.72 });
  });
```

Назви `Quiet Page`/`Guessed Beer` не містять стильових токенів (коментар у файлі на рядку ~80).

- [ ] **Step 2: червоний крок** — `npx vitest run src/jobs/refresh-untappd.test.ts` → FAIL: штамп `null`,
  рейтинг без блоку стає `null`, провенанс лишається `search`.

- [ ] **Step 3: реалізація** (`src/jobs/refresh-untappd.ts`)

Імпорт: `import { upsertBeerByBid } from '../storage/beers';` → `import { upsertBeerByBid, recordProfileBeer } from '../storage/beers';`.

Видалити блок:

```ts
  // Refresh the rating and backfill abv when Untappd has it; COALESCE keeps an
  // existing abv if this scrape didn't surface one (don't wipe known values).
  const updateRatingAndAbv = db.prepare(
    'UPDATE beers SET rating_global = ?, abv = COALESCE(?, abv) WHERE id = ?',
  );
```

Гілку `if (existing) { … }` замінити на:

```ts
        if (existing) {
          // #616: рейтинг зі сторінки — лише коли блок «Global Rating» знайдено (число або «N/A»);
          // штамп звірки, провенанс 'checkin' і бамп кешу лише при зміні — у recordProfileBeer.
          recordProfileBeer(db, existing.id, it, tickNow.toISOString());
          beerId = existing.id;
        }
```

Якщо `bumpCatalogVersion` у файлі більше не використовується — прибрати його імпорт (typecheck/lint покаже).

- [ ] **Step 4: повний гейт.**

- [ ] **Step 5: мутації** (`file: src/jobs/refresh-untappd.ts`, `test: ["src/jobs/refresh-untappd.test.ts"]`)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | `recordProfileBeer(db, existing.id, it, tickNow.toISOString());` → `db.prepare('UPDATE beers SET rating_global = ?, abv = COALESCE(?, abv) WHERE id = ?').run(it.global_rating, it.abv, existing.id);` | `…without the Global Rating block…`, `…set to NULL and stamped…`, `…strengthens a searched link…` |
| 2 | `tickNow.toISOString()` → `new Date(0).toISOString()` | `…set to NULL and stamped…` |

- [ ] **Step 6: коміт**

```bash
git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts
git commit -m "feat(#616): refreshAllUntappd штампує звірку рейтингу за блоком «Global Rating» і посилює провенанс до checkin"
```

---

### Task 4: дайджест — покриття циклу звірки

**Files:**
- Modify: `src/storage/stats.ts`, `src/jobs/daily-status.ts`
- Test: `src/storage/stats.test.ts`, `src/jobs/daily-status.test.ts`

**Interfaces:**
- Produces: `StatusMetrics.ratingsChecked30d: number`.

- [ ] **Step 1: тести**

`src/storage/stats.test.ts`, у `function seed()` після трьох `seedBeer(...)`:

```ts
  // #616: штампи звірки рейтингу — свіжий (3 дні), застарілий (34 дні) і на сироті (не рахується).
  db.prepare("UPDATE beers SET rating_checked_at = '2026-06-01T00:00:00.000Z' WHERE untappd_id = 100").run();
  db.prepare("UPDATE beers SET rating_checked_at = '2026-05-01T00:00:00.000Z' WHERE untappd_id = 101").run();
  db.prepare("UPDATE beers SET rating_checked_at = '2026-06-03T00:00:00.000Z' WHERE name = 'C'").run();
```

У `expect(m).toEqual({…})` тесту `'collectStatus computes all metrics'` після `ratingsMissing: 1,`:

```ts
    ratingsChecked30d: 1,   // #616: лише злінкований рядок зі штампом, свіжішим за 30 днів
```

`src/jobs/daily-status.test.ts`: у `const base: StatusMetrics` після `ratingsMissing: 134,` додати
`ratingsChecked30d: 30120,`; в очікуваному рядку дайджесту
`'• Рейтинги: 134 зматчених пив без рейтингу',` → `'• Рейтинги: 134 зматчених пив без рейтингу · 30 120 звірено за 30 днів',`
(роздільник тисяч скопіювати з наявного `12 840` у тому ж тесті — це вивід `group()`).

Якщо інші тести конструюють `StatusMetrics` — typecheck покаже; додати поле так само.

- [ ] **Step 2: червоний крок** — `npx vitest run src/storage/stats.test.ts src/jobs/daily-status.test.ts` → FAIL.

- [ ] **Step 3: реалізація**

`src/storage/stats.ts`, `interface StatusMetrics`, після `ratingsMissing: number;`:

```ts
  /** #616: злінковані рядки зі штампом звірки рейтингу, свіжішим за 30 днів — покриття циклу гідратора. */
  ratingsChecked30d: number;
```

Після `const cutoff7d = …;`:

```ts
  const cutoff30d = new Date(nowMs - 30 * 24 * 3600 * 1000).toISOString();
```

Після рядка `ratingsMissing: count(…),`:

```ts
    ratingsChecked30d: count(
      'SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL AND rating_checked_at >= ?',
      [cutoff30d],
    ),
```

`src/jobs/daily-status.ts`:

```ts
    `• Рейтинги: ${group(m.ratingsMissing)} зматчених пив без рейтингу · ${group(m.ratingsChecked30d)} звірено за 30 днів`,
```

- [ ] **Step 4: повний гейт.**

- [ ] **Step 5: мутації**

| # | Файл | Мутація | Має впасти |
|---|---|---|---|
| 1 | stats.ts | `WHERE untappd_id IS NOT NULL AND rating_checked_at >= ?` → `WHERE rating_checked_at >= ?` | `collectStatus computes all metrics` |
| 2 | stats.ts | `AND rating_checked_at >= ?` → `AND rating_checked_at IS NOT NULL AND ? IS NOT NULL` | `collectStatus computes all metrics` |
| 3 | daily-status.ts | прибрати ` · ${group(m.ratingsChecked30d)} звірено за 30 днів` | `buildStatusMessage: full message exact string` |

- [ ] **Step 6: коміт**

```bash
git add src/storage/stats.ts src/storage/stats.test.ts src/jobs/daily-status.ts src/jobs/daily-status.test.ts
git commit -m "feat(#616): дайджест — скільки злінкованих пив звірено з Untappd за 30 днів"
```

---

### Task 5: `spec.md`

**Files:** Modify: `spec.md`

- [ ] **Step 1: дерево файлів**

`│       └── beer-page.ts    # парсер сторінки конкретного пива` →

```
│       ├── rating.ts       # untappdRating — межа глобального рейтингу Untappd: 0/N/A → NULL, 2 знаки (#616)
│       └── beer-page.ts    # URL сторінки пива (buildBeerPageUrl)
```

`│   ├── refresh-tap-ratings.ts  # дотягування рейтингів на кранах` →
`│   ├── hydrate-ratings.ts  # звірка рейтингів злінкованого пива через Algolia за bid (#616)`

- [ ] **Step 2: таблиця `beers`**

Рядок `rating_global` замінити на:

```
| `rating_global` | REAL | nullable | публічний рейтинг Untappd, округлений до 2 знаків. **Ніколи не `0`** (#616): Untappd не показує рейтинг пива з менш ніж 10 оцінками (Algolia `rating_score: 0`, сторінка «Global Rating (N/A)»), тож усі входи рейтингу Untappd (Algolia-пошук і `getObjects`, relay HTML-пошук, експорт `/import`, сторінка `/beers`) проходять через `untappdRating` і дають `NULL`; наявні нулі перевела в `NULL` міграція 31. Синк чекінів і `/import` на рядку, знайденому за bid, лише заповнюють порожнє (#617). Гідратор `hydrateRatings` перезаписує рейтинг значенням Algolia (зокрема `NULL`); `refreshAllUntappd` на рядку, знайденому за bid, перезаписує його лише коли блок «Global Rating» на картці знайдено (число або «N/A») |
```

Рядки `rating_refresh_at` / `rating_refresh_count` замінити на:

```
| `rating_refresh_at` | TEXT | nullable (v6) | бекоф гідратора (#616): час останньої відповіді Algolia, у якій цього bid не було (`null` на його позиції). Старі значення HTML-джоби скинуто міграцією 31 |
| `rating_refresh_count` | INTEGER | NOT NULL DEFAULT 0 (v6) | скільки разів поспіль Algolia не знала bid; розклад `lookup-backoff` (0/72/168/728 год), після вичерпання рядок не звіряється. Успішна звірка скидає обидва поля |
| `rating_checked_at` | TEXT | nullable (міграція 31) | «рейтинг звірено з Untappd у момент T» (#616): ставить гідратор за записом Algolia і `refreshAllUntappd`, коли блок «Global Rating» знайдено. Без бекфілу |
```

У рядку `abv` після `orphan-lookup — теж).` додати ` Гідратор (#616) лише заповнює порожнє.`

- [ ] **Step 3: таблиця міграцій** — після рядка `| 30 | …`:

```
| 31 | `beers.rating_checked_at` (#616) + скидання `rating_refresh_at/count` (їх зміст став «Algolia не знає bid») + `rating_global = 0 → NULL` (правило «0 = менш ніж 10 оцінок»). Dry-run на байтовій копії прод-БД: нулів 327 → 0, додатні рейтинги й їхня сума незмінні |
```

- [ ] **Step 4: кеш каталогу (§ `/match`)**

`storage-мутатори (\`upsertBeerByBid\`, \`ensureOrphan\`, \`recordLookupSuccess\`, \`mergeIntoCanonical\`,
\`recordRatingSuccess\`), і raw-SQL записи в cron/maintenance-джобах
(\`refresh-untappd\`, \`cleanup-polluted-ontap\`, \`dedupe-brewery-aliases\`)` →

`storage-мутатори (\`upsertBeerByBid\`, \`ensureOrphan\`, \`recordLookupSuccess\`, \`mergeIntoCanonical\`,
\`applyHydratedRatings\`, \`recordProfileBeer\` — останні два лише коли рейтинг/стиль/ABV справді змінились), і raw-SQL записи в cron/maintenance-джобах
(\`cleanup-polluted-ontap\`, \`dedupe-brewery-aliases\`)`

(Перш ніж видалити `refresh-untappd` зі списку raw-SQL — перевір `grep -n bumpCatalogVersion src/jobs/refresh-untappd.ts`: після Task 3 там не має бути жодного виклику.)

- [ ] **Step 5: фонові джоби**

Рядок `| \`refreshTapRatings\` | \`30 1,4,7,10,13,16,19,22 * * *\` | дотягування рейтингів кранів (offset 1 год від enrich) |` →

```
| `hydrateRatings` | `30 1,4,7,10,13,16,19,22 * * *` | звірка рейтингів злінкованого пива з Untappd через Algolia `getObjects` за bid (#616): до 1000 bid одним запитом; черга — без рейтингу → ніколи не звірені → найдавніше звірені, повторно не частіше ніж раз на 30 днів; гейт — Algolia-breaker; offset 1 год від enrich |
```

У рядку `dailyStatus` перед `Рядок «Розширення /match (вчора)»` вставити:
`Рядок **«Рейтинги»**: зматчених пив без рейтингу і скільки злінкованих пив звірено з Untappd за 30 днів (\`rating_checked_at\`, #616) — друге число показує, чи законні \`NULL\` (менш ніж 10 оцінок) звірені, а не забуті. `

- [ ] **Step 6: абзац про гідратацію** — перед `**Untappd circuit breakers (persistent via \`job_state\`).**`:

```
**Гідратація рейтингів (#616).** Рейтинги злінкованого пива звіряє `hydrateRatings` через Algolia
`getObjects` за bid: запис перезаписує `rating_global` (зокрема `NULL`), стиль і ABV лише заповнює,
ставить `rating_checked_at`; bid, якого немає у відповіді (`null` на його позиції), отримує лише бекоф.
Відповідь, де позиції не сходяться з запитом (немає `results`, інша кількість, запис іншого bid), —
транзієнт: нічого не пишеться. Провенанс гідратор не змінює. `refreshAllUntappd` на рядку, знайденому
за bid, розрізняє три стани картки: блок «Global Rating» з числом — перезапис і штамп; «N/A» — `NULL` і
штамп; блоку немає — рейтинг і штамп не чіпаються. Там само провенанс лінка посилюється до `checkin`
(`curated` лишається). Повторна звірка йде піками, а не рівномірно: бекфіл ставить штампи всього
каталогу за кілька днів, і через 30 днів той самий блок знову стає до черги.
```

- [ ] **Step 7: breaker'и**

```
- **Algolia-пошук** (ключ `job_state.untappd_circuit_open_until`) гейтить
  `refreshOntap` inline enrich та `enrichOrphans` — шлях Untappd beer-search через
  Algolia. `stats.untappdSearchHealthy` читає саме цей ключ.
- **HTML-скрейп** (ключ `job_state.untappd_profile_http_open_until`) гейтить
  `refreshTapRatings` (сторінки пива) та `refreshAllUntappd` (had-list профілю) —
  HTML через WebShare/cookie'd-сесію.
```
→
```
- **Algolia-пошук** (ключ `job_state.untappd_circuit_open_until`) гейтить
  `refreshOntap` inline enrich, `enrichOrphans` і `hydrateRatings` (#616) — шлях Untappd
  через Algolia. `stats.untappdSearchHealthy` читає саме цей ключ.
- **HTML-скрейп** (ключ `job_state.untappd_profile_http_open_until`) гейтить
  `refreshAllUntappd` (had-list профілю) — HTML через WebShare/cookie'd-сесію.
```

- [ ] **Step 8: перевірка** — `grep -n "refreshTapRatings\|refresh-tap-ratings\|recordRatingSuccess\|parseBeerPage" spec.md`:
  лишитись можуть лише історичні згадки (журнал інцидентів, напр. рядок про безкукового клієнта `refresh-tap-ratings`);
  кожну таку — переглянути й лишити як історію. Гейт: `npm test && npm run typecheck`.

- [ ] **Step 9: коміт**

```bash
git add spec.md
git commit -m "docs(#616): spec.md — гідратація рейтингів через Algolia, «0 = немає рейтингу», rating_checked_at, штамп refreshAllUntappd"
```

---

### Task 6: крон на `hydrateRatings`, видалення старої джоби (ДИСПАТЧ)

**Files:**
- Modify: `src/index.ts`
- Create: `src/jobs/hydrate-ratings.wiring.test.ts`
- Delete: `src/jobs/refresh-tap-ratings.ts`, `src/jobs/refresh-tap-ratings.test.ts`, `tests/fixtures/untappd/beer-page-magic-road.html`
- Modify: `src/sources/untappd/beer-page.ts`, `src/sources/untappd/beer-page.test.ts`
- Modify: `src/storage/beers.ts`, `src/storage/beers.test.ts`, `src/storage/catalog-version.test.ts`

**Interfaces:**
- Consumes: `hydrateRatings`, `HydrateRatingsDeps` (`src/jobs/hydrate-ratings.ts`); `applyHydratedRatings` (`src/storage/beers.ts`);
  `algoliaSearch` (має `hydrateByBid`, див. `src/index.ts` ~375) і `algoliaBreaker` у `src/index.ts`.

- [ ] **Step 1: страж композиційного кореня (червоний)**

`src/jobs/hydrate-ratings.wiring.test.ts`:

```ts
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// #616. Композиційний корінь невидимий для решти тестів: src/index.ts ніхто не імпортує, тож гілка
// може бути зеленою, поки гідратор не запускається зовсім або запускається під чужим breaker'ом.
// Той самий страж, що й src/jobs/unlock-fixed-orphans.wiring.test.ts.
const src = (): string => readFileSync(path.join(__dirname, '../index.ts'), 'utf8');

test('src/index.ts schedules hydrateRatings on a cron tick, gated by the Algolia breaker', () => {
  const block = src().match(/cron\.schedule\([^)]*\)[\s\S]{0,400}?hydrateRatings\(\{([\s\S]*?)\}\)/);
  expect(block).not.toBeNull();
  expect(block![1]).toMatch(/breaker:\s*algoliaBreaker/);
  expect(block![1]).toMatch(/hydrateByBid:\s*\(bids\)\s*=>\s*algoliaSearch\.hydrateByBid\(bids\)/);
  expect(block![1]).toMatch(/lookupEnabled:\s*env\.UNTAPPD_LOOKUP_ENABLED/);
});

test('the legacy HTML rating job is gone (#616, review I1)', () => {
  expect(src()).not.toMatch(/refreshTapRatings|refresh-tap-ratings/);
  expect(existsSync(path.join(__dirname, 'refresh-tap-ratings.ts'))).toBe(false);
});
```

Run: `npx vitest run src/jobs/hydrate-ratings.wiring.test.ts` → FAIL (обидва тести).

- [ ] **Step 2: `src/index.ts`**

Імпорт `import { refreshTapRatings } from './jobs/refresh-tap-ratings';` → `import { hydrateRatings } from './jobs/hydrate-ratings';`.

Блок крону (коментар + `cron.schedule('30 1,4,7,10,13,16,19,22 * * *', () => { refreshTapRatings({…}) … })`) замінити на:

```ts
    // #616: hydrate-ratings — звірка рейтингів злінкованого пива через Algolia getObjects (≤1000 bid
    // одним запитом). Слот колишнього refresh-tap-ratings: xx:30 на годинах 1/4/7/10/13/16/19/22,
    // зсув на 1 год від enrich-orphans, тож два Algolia-клієнти не б'ють одночасно. Гейт — Algolia-breaker.
    cron.schedule('30 1,4,7,10,13,16,19,22 * * *', () => {
      hydrateRatings({
        db, log,
        hydrateByBid: (bids) => algoliaSearch.hydrateByBid(bids),
        lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        breaker: algoliaBreaker,
      }).catch((e) => log.error({ err: e }, 'hydrate-ratings cron'));
    }),
```

Якщо `untappdSearchHttp` або `profileHttpBreaker` після цього більше ніде не використовуються — **не видаляти**
без перевірки (`grep -n` в `src/index.ts`): `profileHttpBreaker` гейтить `refreshAllUntappd`.

- [ ] **Step 3: видалення старої джоби**

```bash
git rm src/jobs/refresh-tap-ratings.ts src/jobs/refresh-tap-ratings.test.ts tests/fixtures/untappd/beer-page-magic-road.html
```

(Перед видаленням фікстури — `grep -rn "beer-page-magic-road" src scripts tests`: має знаходитись лише `beer-page.test.ts`.)

- [ ] **Step 4: `beer-page.ts` — лишається тільки URL**

`src/sources/untappd/beer-page.ts` повністю:

```ts
// Сторінка пива на Untappd. Парсер рейтингу зі сторінки видалено в #616: рейтинги звіряє
// hydrateRatings через Algolia; URL лишається для посилань у повідомленнях бота (beer-link.ts).
export function buildBeerPageUrl(bid: number): string {
  return `https://untappd.com/beer/${bid}`;
}
```

`src/sources/untappd/beer-page.test.ts`: видалити `describe('parseBeerPage', …)` цілком, імпорт
`parseBeerPage`, а також `fs`/`path`/`fixturePath`/`html`, якщо вони лишилися невикористаними;
`describe('buildBeerPageUrl', …)` лишити без змін.

- [ ] **Step 5: `beers.ts` — стара черга рейтингів**

Видалити з `src/storage/beers.ts`: `recordRatingSuccess`, `recordRatingNotFound`, `recordRatingTransient`,
`interface RatingRefreshCandidate`, `listRatingRefreshCandidates` (разом із коментарями над ними). У
коментарі над `RATING_RECHECK_DAYS` рядок
`// listRatingRefreshCandidates — без гейту «на крані» і з повторною звіркою наявних рейтингів.` замінити на
`// колишньої HTML-джоби — без гейту «на крані» і з повторною звіркою наявних рейтингів.`

`src/storage/beers.test.ts`: видалити блок від коментаря `// PR-D3 helpers — rating-refresh` (разом із
рамкою `// ---…`) до кінця `describe('listRatingRefreshCandidates', …)` включно — тобто імпорт
`recordRating*`/`listRatingRefreshCandidates` і чотири `describe`. `describe('loadCatalog', …)` лишається.

- [ ] **Step 6: `catalog-version.test.ts`**

Імпорт: прибрати `recordRatingSuccess`, `recordRatingNotFound`, додати `applyHydratedRatings`.

У `'bumps on matchable-field mutators'` блок

```ts
    v = catalogVersion();
    recordRatingSuccess(db, id, 4.1);
    expect(catalogVersion()).toBeGreaterThan(v);
```
→
```ts
    // #616: гідратор рейтингів (рядок уже має bid 111 після recordLookupSuccess вище).
    v = catalogVersion();
    applyHydratedRatings(db, new Map([[111, { global_rating: 4.1, style: 'IPA', abv: 6.1 }]]), [111], '2026-01-02T00:00:00Z');
    expect(catalogVersion()).toBeGreaterThan(v);
```

У `'does NOT bump on timestamp/counter-only mutators'`:

```ts
    const v = catalogVersion();
    recordLookupNotFound(db, id, '2026-01-01T00:00:00Z');
    recordRatingNotFound(db, id, '2026-01-01T00:00:00Z');
    expect(catalogVersion()).toBe(v);
```
→
```ts
    // #616: невідомий Algolia bid пише лише бекоф; повторна звірка без змін — лише штамп.
    const linked = seedBeer(db, {
      untappd_id: 333, name: 'Linked', brewery: 'Pinta', style: 'IPA', abv: 6.1, rating_global: 3.9,
      normalized_name: normalizeName('Linked'), normalized_brewery: normalizeBrewery('Pinta'),
    });
    expect(linked).toBeGreaterThan(0);
    const v = catalogVersion();
    recordLookupNotFound(db, id, '2026-01-01T00:00:00Z');
    applyHydratedRatings(db, new Map(), [333], '2026-01-01T00:00:00Z');
    applyHydratedRatings(db, new Map([[333, { global_rating: 3.9, style: 'IPA', abv: 6.1 }]]), [333], '2026-01-02T00:00:00Z');
    expect(catalogVersion()).toBe(v);
```

- [ ] **Step 7: повний гейт** — `npm test && npm run typecheck` зелені; страж зі Step 1 зелений.
  `grep -rn "refreshTapRatings\|refresh-tap-ratings\|parseBeerPage\|recordRating\(Success\|NotFound\|Transient\)\|listRatingRefreshCandidates" src scripts`
  → лише коментар у `src/jobs/hydrate-ratings.ts` («Замінює refreshTapRatings») і стражі; більше нічого.

- [ ] **Step 8: мутації** (`file: src/index.ts`, `test: ["src/jobs/hydrate-ratings.wiring.test.ts"]`)

| # | Мутація | Має впасти |
|---|---|---|
| 1 | у блоці `hydrateRatings({` `breaker: algoliaBreaker,` → `breaker: profileHttpBreaker,` | `…gated by the Algolia breaker` |
| 2 | прибрати рядок `hydrateByBid: (bids) => algoliaSearch.hydrateByBid(bids),` | `…gated by the Algolia breaker` |
| 3 | прибрати `lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,` у цьому блоці | `…gated by the Algolia breaker` |
| 4 | додати рядок `// refreshTapRatings` над блоком | `the legacy HTML rating job is gone` |

(Мутації 2–3 зламають typecheck — це очікувано; гарнес запускає лише vitest.)

- [ ] **Step 9: коміт** — перед комітом `git rev-parse --show-toplevel` має бути
  `/home/ysi/warsaw-beer-bot/.claude/worktrees/616-rating-hydration`; `git add` лише перелічених шляхів (видалення вже в індексі через `git rm`):

```bash
git add src/index.ts src/jobs/hydrate-ratings.wiring.test.ts src/sources/untappd/beer-page.ts \
  src/sources/untappd/beer-page.test.ts src/storage/beers.ts src/storage/beers.test.ts src/storage/catalog-version.test.ts
git commit -m "feat(#616): крон рейтингів → hydrateRatings під Algolia-breaker; стара HTML-джоба, парсер сторінки пива й черга recordRating* видалені"
```

---

## Результат наскрізного рев'ю гілки (2026-09-13)

Виконання: задачі 1–5 інлайн (`dabd8d9`, `10540d6`, `2ed7593`, `6b34d57`, `3e26ca4` до рібейсу), задача 6 —
імплементер (`8b3a66d`; єдиний відступ — коментар крон-блоку в плані містив `refresh-tap-ratings`, який
забороняє страж того ж плану). Рібейс на `origin/main` `08ac1da` (#353) — без конфліктів, гейт 2759.
Рев'ю (свіжий рецензент, увесь diff від `origin/main`, жива проба Algolia по всіх 32 759 злінкованих bid):
Critical — 0, Important — 0, Minor — 3.

| # | Знахідка | Рішення |
|---|---|---|
| M1 | один нерозбірний запис або запис чужого bid валить усю пачку з 1000 bid; черга має сталий порядок, тож кожен наступний запуск бере ті самі bid — гідратор тихо зупиняється. Проба: 33 пачки, 0 розбіжних/нерозбірних записів, 47 `null` | **відкрите питання до користувача** — варіант: явний `null` у мапі `hydrateByBid` = «Algolia не знає» (бекоф), відсутній ключ = «доказу немає» (пропуск без записів) |
| M2 | страж проводки не фіксував розклад і `.catch`; сід дайджесту (3/34 дні) пропускав вікно 7 чи 33 дні | регекс стража фіксує дослівний розклад і `.catch`; сід A — 20 днів. Мутації: розклад → слот enrich, без `.catch`, вікно 7 і 40 днів — усі 4 впали |
| M3 | `spec.md` «ніколи не 0 / усі входи через хелпер / округлений» — хибно для `u_rating` з ontap (сирота, `COALESCE` при лінкуванні) і для значень до #616; «6 невідомих bid» — лише серед рядків без рейтингу | `spec.md` уточнено (виняток ontap, округлення від #616); дизайн-спека: 47 по каталогу, 6 серед рядків без рейтингу |

## Після обв'язки

1. Наскрізне рев'ю **всієї гілки** (ядро + обв'язка, diff від `origin/main`), з назвами інлайн-задач 1–5.
2. `git fetch origin main` → `git rebase origin/main`, якщо зрушив → повний гейт.
3. `git push --force-with-lease`, PR з `Closes #616`; тіло — що було не так (мертва джоба на кранах, нулі,
   стерті #617 рейтинги), що змінено, докази (спайк Algolia, dry-run міграції), «ядро й обв'язка одним деплоєм».
4. Після мерджу — деплой (є міграція 31): `bash deploy/deploy.sh` з основного checkout. Перша доба —
   перевірити в дайджесті друге число «Рейтинги» і лог `hydrate-ratings done` (очікувано ~2336 відновлених
   рейтингів у перших трьох запусках).
