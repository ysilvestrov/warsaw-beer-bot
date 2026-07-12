# Untappd lookup for orphans — `/search` + `/beer/{id}` refresh

**Date:** 2026-05-26
**Branch sequence:** `feat/untappd-search` (PR-D1) → `feat/untappd-enrich-orphans` (PR-D2) → `feat/untappd-rating-refresh` (PR-D3)

## Background

Real-world bug (2026-05-26): юзер бачить у `/newbeers` рядок

```
6. Magic Road Brewery Fifty/Fifty Clementine & Passionfruit  ⭐ —  ·  4,6%
     · Jabeerwocky Warszawa
```

Untappd для цього пива має `untappd_id=5...` і `rating_global=3.98`, але в нашій БД лежить orphan-рядок (`id=486`, `untappd_id=NULL`, `rating_global=NULL`). Каталог має 11 інших `Magic Road Fifty/Fifty`-варіантів з рейтингами, але саме Clementine & Passionfruit там немає, бо:

1. `refreshOntap` створив orphan-рядок коли побачив тап (matcher не знайшов match у каталозі).
2. `refreshAllUntappd` ходить по `/user/<X>/beers` сторінкам — заповнює rating тільки якщо хтось має це пиво у публічному top-25. Для цього варіанту цього не сталось.
3. Бот не вміє йти в Untappd за глобальною інформацією для нового пива.

**Аудит проді** (`/var/lib/warsaw-beer-bot/bot.db`): 673 beers без `untappd_id` (з 12,065 → 5.6%). З них **286 — на поточних кранах прямо зараз**.

## Goals

- **PR-D1 (capability)**: інфраструктура для запиту Untappd за orphan-ами без поведінкових змін:
  - HTML-парсер для `/search?q=...&type=beer`
  - Двостадійний матч (broварня hard-gate + name fuzzy 0.85)
  - Exponential backoff на повторні спроби
  - Storage helpers + міграція v5 (`untappd_lookup_at`, `untappd_lookup_count`)

- **PR-D2 (wire-up): запит у `/search` для orphan-ів без `untappd_id`**:
  - Inline у `refreshOntap`: відразу після upsert/match orphan-а — lookup і fill.
  - Cron `enrich-orphans` (12h, LIMIT 20): backfill для orphan-ів, які refresh-integrated path не зачепив (HTTP-помилки, або pre-PR-D backlog).

- **PR-D3 (rating refresh): запит у `/beer/{id}` для beers з `untappd_id`, але `rating_global IS NULL`**:
  - Окремий cron `refresh-tap-ratings` (12h offset від D2). Парсить HTML beer-сторінки.
  - Окремий backoff infrastructure (міграція v6: `rating_refresh_at`, `rating_refresh_count`).
  - Untappd показує rating тільки коли набралось ≥10 оцінок, тому це періодична robust retry-задача.

## Non-goals

- **Lookup для beers НЕ на поточних кранах.** Старі історичні orphan-и не наповнюються — їх ніде показувати, втрачаємо запити дарма.
- **Untappd Official API** (з app-credentials). Без оплачуваного акаунту лімітів немає; HTML-скрейпинг — те, що вже використовуємо.
- **Permanent give-up** для not-found пив. Завжди ретраїмо з cap-нутим backoff (30 днів), бо нові пива у Untappd з'являються довільно.
- **Force-refresh командою користувача** (`/lookup <beer-id>`). YAGNI; cron + refresh-integrated покривають usecase автоматично.
- **Rate-фільтрація через `min_rating`**: orphan-и без rating НЕ виключаються з `/newbeers`. Це по-замовчуванню (`min_rating=NULL`), без зміни в PR-D.
- **Single-PR feature merge**. Свідомо розділено на три PR з ізольованими дотиками.

## Architecture

### Загальна модель: «active orphan» — beer на крані без повної інформації

Бот тримає два списки «активних orphan-ів»:

1. **No-bid orphans** (PR-D2): `WHERE untappd_id IS NULL AND beer_id ∈ current_tap_set`. Цикл: Untappd `/search` → 2-stage match → fill `untappd_id+style+abv+rating_global?` або incremental backoff.
2. **No-rating orphans** (PR-D3): `WHERE untappd_id IS NOT NULL AND rating_global IS NULL AND beer_id ∈ current_tap_set`. Цикл: Untappd `/beer/{id}` → parse `global_rating` → fill або incremental backoff.

`current_tap_set` SQL-обчислюється однаково для обох:

```sql
SELECT ml.untappd_beer_id FROM match_links ml
JOIN taps t ON t.beer_ref = ml.ontap_ref
JOIN tap_snapshots ts ON ts.id = t.snapshot_id
JOIN (SELECT pub_id, MAX(snapshot_at) m FROM tap_snapshots GROUP BY pub_id) latest
  ON latest.pub_id = ts.pub_id AND latest.m = ts.snapshot_at
```

Обидва шляхи дотримуються `current_tap_set` — це гарантує, що ми не витрачаємо запити на пиво, яке вже зникло з кранів.

### Backoff policy (спільна логіка, окремі дані)

Pure-функція `backoff(count) → Duration`:

| count | next attempt |
|---|---|
| 0 | immediately |
| 1 | 24h |
| 2 | 3d (72h) |
| 3 | 7d (168h) |
| 4 | 14d (336h) |
| 5+ | 30d (720h) — назавжди cap |

Eligibility check: `lookup_at IS NULL OR lookup_at + backoff(count) <= now()`.

«Confirmed not-found» (інкрементує count): Untappd повернув 0 результатів, або всі N результатів НЕ пройшли 2-stage filter.
«Transient» (НЕ інкрементує count, оновлює тільки `lookup_at` щоб не довбати кожні 30s): HTTP timeout/5xx/network. Backoff на transient — той самий, як на confirmed-not-found (іт's a try, just no penalty on count).

Обидві задачі (PR-D2 і PR-D3) використовують **той самий** `backoff()`-модуль, але ЗА окремими колонками: PR-D2 на `untappd_lookup_at/_count`, PR-D3 на `rating_refresh_at/_count`. Це чітко розв'язує retry-стани двох задач.

---

## PR-D1 — Untappd search capability

### Міграція v5

```sql
ALTER TABLE beers ADD COLUMN untappd_lookup_at TEXT;       -- ISO8601 or NULL
ALTER TABLE beers ADD COLUMN untappd_lookup_count INTEGER NOT NULL DEFAULT 0;
```

Колонки актуальні поки `untappd_id IS NULL`. Після успіху просто ігноруються (read-side не дивиться).

### `src/sources/untappd/search.ts` — HTML scraper для `/search`

```ts
export interface SearchResult {
  bid: number;
  beer_name: string;
  brewery_name: string;
  style: string | null;
  abv: number | null;
  global_rating: number | null;
}

export function buildSearchUrl(query: string): string;
   // returns https://untappd.com/search?q=<urlencoded>&type=beer

export function parseSearchPage(html: string): SearchResult[];
   // parses top-5 results; cheerio-based, fixture tests
```

Запит формуємо як `"<raw_brewery> <raw_beer_name>"` (НЕ нормалізована — Untappd shows the original).

**HTML-структура buy curl-fixture.** Перед написанням parser-а сделаємо `curl -sS 'https://untappd.com/search?q=Magic+Road+Fifty/Fifty+Clementine&type=beer' > tests/fixtures/untappd-search-magic-road.html` і пишемо tests проти зафіксованого HTML. Якщо Untappd колись зміне шаблон, fixture-тест моментально це покаже.

### `src/domain/untappd-lookup.ts` — оркестратор + 2-stage match

```ts
export type LookupOutcome =
  | { kind: 'matched'; result: SearchResult }
  | { kind: 'not_found' }
  | { kind: 'transient'; error: unknown };

export async function lookupBeer(args: {
  brewery: string;
  name: string;
  fetch: (url: string) => Promise<string>;
}): Promise<LookupOutcome>;
```

Логіка:
1. `await fetch(buildSearchUrl(`${brewery} ${name}`))`. Помилка → `transient`.
2. `parseSearchPage(html)` → масив до 5 results.
3. **Stage 1 (brewery hard gate):** залишаємо лише ті, де `breweryAliases(brewery) ∩ breweryAliases(result.brewery_name) ≠ ∅`.
4. **Stage 2 (name fuzzy):** на прохідних робимо `new Searcher(passed, { keySelector: r => normalizeName(r.beer_name), threshold: 0.85 })` і шукаємо `normalizeName(name)`. Беремо best.
5. Якщо є → `matched`; інакше → `not_found`.

### `src/domain/lookup-backoff.ts` — pure backoff

```ts
const BACKOFF_HOURS = [0, 24, 72, 168, 336, 720];

export function nextDelayHours(count: number): number {
  return BACKOFF_HOURS[Math.min(count, BACKOFF_HOURS.length - 1)];
}

export function isEligible(now: Date, lookupAt: string | null, count: number): boolean {
  if (lookupAt === null) return true;
  const dueAt = new Date(lookupAt).getTime() + nextDelayHours(count) * 3600_000;
  return now.getTime() >= dueAt;
}
```

### Storage helpers — додаємо до `src/storage/beers.ts`

Перш ніж helpers — розширити `BeerRow` interface (`untappd_lookup_at: string | null`, `untappd_lookup_count: number`) і додати трюіальний `getBeer(db, id): BeerRow | null` (`SELECT * FROM beers WHERE id = ?`). `getBeer` потрібен для inline-шляху PR-D2 щоб після upsert/match прочитати lookup-стан beer-а без додаткового JOIN-у в matcher catalog.

```ts
export function getBeer(db: DB, beerId: number): BeerRow | null;

export function recordLookupSuccess(
  db: DB, beerId: number, r: SearchResult,
): void {
  db.prepare(
    `UPDATE beers SET
       untappd_id = ?, style = ?, abv = COALESCE(?, abv),
       rating_global = COALESCE(?, rating_global)
     WHERE id = ?`,
  ).run(r.bid, r.style, r.abv, r.global_rating, beerId);
}

export function recordLookupNotFound(db: DB, beerId: number, at: string): void {
  db.prepare(
    `UPDATE beers SET
       untappd_lookup_at = ?,
       untappd_lookup_count = untappd_lookup_count + 1
     WHERE id = ?`,
  ).run(at, beerId);
}

export function recordLookupTransient(db: DB, beerId: number, at: string): void {
  db.prepare(
    'UPDATE beers SET untappd_lookup_at = ? WHERE id = ?',
  ).run(at, beerId);
}

export function listLookupCandidates(db: DB, limit: number, now: Date): Array<{
  id: number; brewery: string; name: string;
  untappd_lookup_at: string | null; untappd_lookup_count: number;
}>;
```

`listLookupCandidates` — JOIN з `match_links` + latest snapshots для on-tap фільтра, плюс backoff-eligibility check у SQL (рахуємо `dueAt` через `julianday()` арифметику або фільтруємо в JS після читання — простіше JS).

### PR-D1 поведінка

**Жодних змін у runtime поведінці.** Міграція додає колонки, нові модулі живуть без caller-ів. Це делiveryable, ревьюваний crisp PR — суто capability landing.

---

## PR-D2 — wire-up `/search` lookup

### Inline в `refreshOntap`

Після `matchBeer`, **тільки якщо `matchBeer === null`** (тобто `upsertBeer` створив новий рядок у цьому sweep-і), викликаємо `enrichOneOrphan(beerId)`. Існуючі orphan-и (matchBeer повернув existing рядок без `untappd_id`) інлайн НЕ обробляє — вони чекають cron. Це критично, бо інакше один sweep пробує всі on-tap orphan-и (287 у проді), кожен з HTTP+sleep ≈2.5s → sweep уповільнюється на +12 хв.

```ts
const m = matchBeer({ brewery, name: t.beer_ref, abv: t.abv }, catalog);
let beerId: number;
let isFreshOrphan = false;
if (m) {
  upsertMatch(db, t.beer_ref, m.id, m.confidence);
  beerId = m.id;
} else {
  beerId = upsertBeer(db, {...});
  upsertMatch(db, t.beer_ref, beerId, 1.0);
  isFreshOrphan = true;
}

if (lookupEnabled && isFreshOrphan) {
  const outcome = await enrichOneOrphan({ db, log, http, now }, beerId);
  // sleep тільки якщо HTTP реально був (defense in depth: outcome може
  // повернутись 'skipped' через backoff або race condition)
  if (lookupSleepMs > 0 && outcome !== 'skipped') {
    await new Promise<void>((r) => setTimeout(r, lookupSleepMs));
  }
}
```

**Overhead в типовому sweep-і:** 0–3 нових orphan-ів за день — 1.5s оверхеду max. Backlog (287 рядків у проді) обробляється cron-ом, по 20×2/добу = ~7 днів до 0.

### Cron `enrich-orphans` — backfill

`src/jobs/enrich-orphans.ts` — новий job:

```ts
export async function enrichOrphans(deps: Deps): Promise<EnrichResult> {
  const candidates = listLookupCandidates(deps.db, 20, new Date());
  for (const c of candidates) {
    const outcome = await lookupBeer({ brewery: c.brewery, name: c.name, fetch: deps.http.get });
    await sleep(500);
    // ... same switch as inline path ...
  }
  return { processed: candidates.length, matched: <count>, notFound: <count>, transient: <count> };
}
```

`src/index.ts` — додати:

```ts
cron.schedule('0 6,18 * * *', () => {
  enrichOrphans({ db, log, http }).catch((e) => log.error({ err: e }, 'enrich-orphans cron'));
}),
```

(xx:30 кожні 3 години — offset від on-the-hour cron-ів: refreshOntap 00:00/12:00, refreshAllUntappd 03:00.)

LIMIT 20 × 8 разів/добу = 160 запитів/день. Backlog ~287 закривається за ~1.8 днів. Бамп з 12h до 3h частоти виконано в PR-D-throughput-bump (2026-05-29) після виявлення, що 7-денний backfill не покриває реальний user-pain (orphan-и з spurious not_found чекали тиждень на retry).

### PR-D2 поведінка

Юзер бачить, що нові пива в `/newbeers` після першого ж `/refresh` приходять із rating (там, де Untappd його має). Через тиждень — і бекфіл (286 → ~0 для тих, що Untappd знає).

---

## PR-D3 — rating refresh через `/beer/{id}`

### Міграція v6

```sql
ALTER TABLE beers ADD COLUMN rating_refresh_at TEXT;
ALTER TABLE beers ADD COLUMN rating_refresh_count INTEGER NOT NULL DEFAULT 0;
```

### `src/sources/untappd/beer-page.ts`

```ts
export interface BeerPageData {
  global_rating: number | null;  // null коли Untappd ще не показує
}

export function buildBeerPageUrl(bid: number): string;
   // returns https://untappd.com/beer/<bid>

export function parseBeerPage(html: string): BeerPageData;
   // cheerio, fixture tests (curl-first), парсить ".rating .num" або data-rating атрибут
```

Curl-first так само: `curl 'https://untappd.com/beer/5755227' > tests/fixtures/untappd-beer-page-magic-road.html`.

### Cron `refresh-tap-ratings`

`src/jobs/refresh-tap-ratings.ts`:

```ts
export async function refreshTapRatings(deps: Deps): Promise<RefreshResult> {
  const candidates = listRatingRefreshCandidates(deps.db, 20, new Date());
  // similar shape: candidate.untappd_id, .rating_refresh_at, .rating_refresh_count
  for (const c of candidates) {
    try {
      const html = await deps.http.get(buildBeerPageUrl(c.untappd_id));
      const data = parseBeerPage(html);
      if (data.global_rating !== null) {
        recordRatingSuccess(deps.db, c.id, data.global_rating);
      } else {
        recordRatingNotFound(deps.db, c.id, now.toISOString());
      }
    } catch (e) {
      recordRatingTransient(deps.db, c.id, now.toISOString());
    }
    await sleep(500);
  }
}
```

`recordRatingSuccess`: `UPDATE beers SET rating_global = ? WHERE id = ?` (count колонки не чіпає — beer вийшов з пулу автоматично, бо `rating_global IS NOT NULL`).
`recordRatingNotFound`/`recordRatingTransient`: ті ж патерни, що в D2, але на `rating_refresh_*` колонках.

`listRatingRefreshCandidates`: SQL `WHERE untappd_id IS NOT NULL AND rating_global IS NULL AND beer_id ∈ current_tap_set AND backoff-eligible`.

`src/index.ts`:

```ts
cron.schedule('0 9,21 * * *', () => {
  refreshTapRatings({ db, log, http }).catch((e) => log.error({ err: e }, 'refresh-tap-ratings cron'));
}),
```

xx:30 кожні 3 години на годинах 1, 4, 7, 10, 13, 16, 19, 22 UTC — offset 1h від enrich-orphans (хх:30 на 0/3/6/9/12/15/18/21) і ніколи не одночасно. Frequency bumped from 12h to 3h together with enrich-orphans (PR-D-throughput-bump 2026-05-29).

### PR-D3 поведінка

Beers, що PR-D2 знайшов з `untappd_id` але `rating_global=NULL` (бо в Untappd ще ≤9 оцінок), будуть періодично перевірятись. Коли поріг наберется — rating з'явиться у `/newbeers` без додаткових дій.

---

## Тести

### PR-D1

- **`schema.test.ts`** — assert обидві нові колонки на `beers`.
- **`src/sources/untappd/search.test.ts`** — fixture-based parser test: завантажуємо зафіксований HTML (curl-snapshot), парсимо, перевіряємо що ≥1 result з очікуваним bid/brewery/name/rating. Тест на пустий HTML → `[]`. Тест на html без `.beer-item` → `[]`.
- **`src/domain/untappd-lookup.test.ts`** — stub fetch, 4 case-и: (1) matched (brewery overlap + name >= 0.85), (2) not_found (брюварня НЕ overlap), (3) not_found (name fuzzy нижче порогу), (4) transient (fetch кидає).
- **`src/domain/lookup-backoff.test.ts`** — табличка count→delay; eligibility (NULL = true; recent = false; old = true).
- **`src/storage/beers.test.ts`** (новий або extend існуючого) — три recorder-и плюс `listLookupCandidates` з фіксурою (orphan на крані + orphan НЕ на крані + matched beer; перевіряємо що повертається тільки on-tap orphan).

### PR-D2

- **`refresh-ontap.test.ts`** — розширити: фікстура з тапом, який створює orphan; стаб fetch що повертає search-HTML з матчем; перевіряємо що по завершенню sweep-у `beers` рядок має `untappd_id` set.
- **`enrich-orphans.test.ts`** — стаб fetch + in-memory DB з orphan-ом на крані; перевіряємо processed/matched counts і resulting row state.

### PR-D3

- **`schema.test.ts`** — assert міграція v6 додала обидві колонки.
- **`beer-page.test.ts`** — fixture-based parser для `/beer/{id}` HTML.
- **`refresh-tap-ratings.test.ts`** — analogous to enrich-orphans test, but for rating.

---

## File-level зміни

### PR-D1

| Файл | Тип |
|---|---|
| `src/storage/schema.ts` | модифікація: міграція v5 |
| `src/storage/schema.test.ts` | extend |
| `src/sources/untappd/search.ts` | новий |
| `src/sources/untappd/search.test.ts` | новий (+ fixture) |
| `src/domain/untappd-lookup.ts` | новий |
| `src/domain/untappd-lookup.test.ts` | новий |
| `src/domain/lookup-backoff.ts` | новий |
| `src/domain/lookup-backoff.test.ts` | новий |
| `src/storage/beers.ts` | модифікація: 3 recorders + listLookupCandidates |
| `src/storage/beers.test.ts` | extend |
| `tests/fixtures/untappd-search-*.html` | новий (curl-snapshot) |

### PR-D2

| Файл | Тип |
|---|---|
| `src/jobs/refresh-ontap.ts` | модифікація: inline lookup після upsert |
| `src/jobs/refresh-ontap.test.ts` | extend |
| `src/jobs/enrich-orphans.ts` | новий |
| `src/jobs/enrich-orphans.test.ts` | новий |
| `src/index.ts` | модифікація: реєстрація cron |
| `src/config/env.ts` | модифікація: optional `UNTAPPD_LOOKUP_ENABLED` (default true) |

### PR-D3

| Файл | Тип |
|---|---|
| `src/storage/schema.ts` | модифікація: міграція v6 |
| `src/storage/schema.test.ts` | extend |
| `src/sources/untappd/beer-page.ts` | новий |
| `src/sources/untappd/beer-page.test.ts` | новий (+ fixture) |
| `src/storage/beers.ts` | модифікація: rating recorders + listRatingRefreshCandidates |
| `src/storage/beers.test.ts` | extend |
| `src/jobs/refresh-tap-ratings.ts` | новий |
| `src/jobs/refresh-tap-ratings.test.ts` | новий |
| `src/index.ts` | модифікація: реєстрація cron |
| `tests/fixtures/untappd-beer-page-*.html` | новий (curl-snapshot) |

## Risks / Footguns

- **Untappd HTML schema drift.** Fixture-based тести моментально провалюються, якщо парсер ламається. Curl-fixture треба регенерувати на боці developer-а, не CI (CI має stable snapshot). Якщо drift — окремий small PR оновити fixture + parser.
- **False positive matches.** 2-stage filter (broварня hard-gate + name fuzzy 0.85) це страхує, але не нуль. Якщо такий випадок з'явиться — orphan вже не orphan, але рейтинг на чужому пиві. Лікування: знайти, побачити в БД, ручний UPDATE або `dedupeBreweryAliases` race-conditions. PR-D ловить це через rating перевірки (Untappd-rating не повинен різко змінюватись між sweep-ами).
- **Rate-limit / IP-ban з боку Untappd.** Кожен cron — LIMIT 20 × ~500ms sleep = ~10s burst, 2 рази на день. Якщо побачимо 403/429 — env-var `UNTAPPD_LOOKUP_ENABLED=false` (kill switch) і ретреат.
- **Catalog growth.** PR-D2 знаходить нові untappd_id-и → нові варіанти стилів і ABV у `beers`. Це normal. Якщо BR-побори через дуже шумний search → false-positives ростуть → PR-A/B/C dedupe може видалити неправильні мерджі. Це тестується в `enrich-orphans.test.ts` на дуплікат-сценарії.
- **`rating_refresh_*` колонки на існуючих рядках.** Default 0 → з'являються в пулі PR-D3 одразу. Усі beers з `untappd_id` set + `rating_global=NULL` (зараз 0 таких в проді — всі мають rating якщо мають bid) на момент деплою PR-D3 пройдуть один lookup кожен. Реал-кейс це невелика кількість (≤10), не вибух.
- **Curl-first на dev-стороні.** PR-D1 і PR-D3 включають кроки в плані «curl URL, save fixture». CI цього НЕ робить. Це разова дія перед написанням parser-у — план фіксує конкретні URL і fixture-шляхи.
- **Inline must NOT process backlog.** PR-D2.1 hotfix (2026-05-26): початковий PR-D2 inline-шлях не розрізняв fresh orphan-ів від існуючого backlog-у. На першому post-deploy sweep-і inline проходив всі 287 on-tap orphan-ів з HTTP+sleep ≈2.5s кожен → sweep уповільнився з ~5 хв до 10+ хв на 28 пабах. Fix: `isFreshOrphan` guard (`matchBeer === null` → upsertBeer create) + conditional sleep on `outcome !== 'skipped'`. Урок: "harmless guard skipped 95% of the time" у hot loop-і — не harmless, коли N=350 тапів × 500ms = 3 хв пустого sleep-у, плюс backlog-multiplier.
- **Throughput-tuning lesson** (PR-D-throughput-bump 2026-05-29). Initial PR-D2 plan хардкодив `LIMIT=20` × 12h cron «з рукава», без розрахунку backlog-часу. На реальному 287-orphan backlog це дало 7-денний фікс — неприйнятно для one-off bug-trace user-flow (`/newbeers Piw Paw` пропускав Bleat без rating). Бамп до 3h cron-частоти (LIMIT незмінний) дає 1.8-денний backfill і зберігає burst-сигнатуру (10s × 20 calls), яку Untappd толерує. Якщо `transient`-метрика в логах почне рости — dial-back до 6h або 12h (one-line revert). Урок: коли LIMIT × cron-frequency визначає user-facing latency, рахуй backlog-time перед коммітом плану.
