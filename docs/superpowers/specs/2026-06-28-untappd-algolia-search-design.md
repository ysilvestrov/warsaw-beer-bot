# Untappd Algolia Search — Phase 1 (серверний шлях)

- **Дата:** 2026-06-28
- **Статус:** дизайн (до плану)
- **Спрямування:** полагодити серверний enrich-lookup, який Untappd зламав, перейшовши на клієнтський Algolia-пошук.

## 1. Проблема (root cause, доказано)

Untappd переніс пошук пива на **клієнтський Algolia-віджет** (~22–24 червня 2026). Серверний HTML сторінки `untappd.com/search?q=…&type=beer` тепер містить лише порожній контейнер:

```html
<div class="results-container" id="algolia-hits"></div>
```

Результати підвантажує JS уже в браузері. Наш cheerio-парсер `parseSearchPage` шукає `.beer-item` у статичному HTML — їх там більше немає → **будь-який** запит повертає 0 кандидатів → кожен lookup стає `not_found`.

Доказ (перевірено з VPS через той самий проксі+парсер): усі варіанти запиту (з двокрапкою, без, lowercase, зі словом `brewery`) дали 67 КБ сторінку «Untappd Search» з `block=false` і `candidates=0`. Прямий запит до Algolia API тими ж публічними ключами зі сторінки повернув коректний JSON з повним пивом.

**Часова шкала:** до 21 червня enrich матчив 10–17/прогін; 25–28 червня — 0. Збіглося з окремим IP-блоком VPS (мітигованим #200 через Webshare-проксі), що замаскувало справжню причину: проксі прибрав 403, але парсер лишився зламаним, тож job «зеленів» (HTTP 200, breaker закритий), а матчів не було.

## 2. Рішення (огляд)

Замінити «зібрати URL → fetch HTML → парсити `.beer-item`» на запит до **Algolia JSON API**. Матчинг-пайплайн (`lookupBeer`: brewery-parts, strict/relaxed/brand stages, fuzzy, ABV) **не змінюється** — міняється лише джерело кандидатів під ним.

**Архітектурні рішення (узгоджено):**
- **B + проксі-фолбек.** Серверний Algolia — основний шлях; клієнтський relay (#89) зберігаємо як запасний (на Phase 2 він шле Algolia-JSON, не HTML); `WEBSHARE_PROXY` — фолбек на випадок IP-бану Algolia.
- **Цей spec = Phase 1 (серверний шлях).** Клієнтський relay лишаємо як є (зараз постить порожній HTML → no-op, backoff не псує). Phase 2 (relay→Algolia-JSON, з оновленням розширення/доки/broadcast) — окремий spec.

## 3. Шов (seam)

`lookupBeer` зараз тісно зшитий з HTTP (сам кличе `buildSearchUrl` → `fetch(url)` → `parseSearchPage`). Виносимо пошук за інтерфейс:

```ts
// src/sources/untappd/search.ts — переписуємо нутрощі, лишаємо тип SearchResult
export interface BeerSearch {
  search(query: string): Promise<SearchResult[]>;
}
```

`lookupBeer` приймає `search: BeerSearch` замість `fetch`. Усередині циклу по `brewerySearchParts` замість `fetch(buildSearchUrl(...))`+`parseSearchPage` → `search.search(cleanSearchQuery(part, name))`. Пайплайн стає незалежним від джерела кандидатів і тривіально тестується фейковим `BeerSearch`.

Реалізації:
- `algoliaSearch` — серверна (Phase 1).
- (Phase 2) клієнтський relay стане другою реалізацією.

**Видаляємо:** `parseSearchPage` (`.beer-item` cheerio) з пошукового шляху.
**Лишаємо:** `buildSearchUrl` — ще потрібен для людино-читабельного `search_url` у `enrich_failures` (дебаг) і для Phase 2.

## 4. Algolia-клієнт

**Запит** (підтверджено робочим):
```
POST https://{appId}-dsn.algolia.net/1/indexes/beer/query
Headers: X-Algolia-Application-Id: {appId}
         X-Algolia-API-Key: {searchKey}
         Content-Type: application/json
Body:    {"query": "<cleanSearchQuery>", "hitsPerPage": 5}
```
`hitsPerPage: 5` = поточний `MAX_ITEMS`. Жодних додаткових фільтрів (YAGNI).

**Мапінг hit → `SearchResult`:**

| SearchResult | Algolia hit |
|---|---|
| `bid` | `bid` |
| `beer_name` | `beer_name` |
| `brewery_name` | `brewery_name` |
| `style` | `type_name` |
| `abv` | `beer_abv` |
| `global_rating` | `rating_score` |

Поля ідентичні тим, що давав HTML-парсер, тож пайплайн нижче нічого не помічає.

**Проксі-фолбек.** На відміну від HTML-шляху (завжди через проксі), Algolia:
- **основне — прямий запит** з VPS (швидше, не їсть трафік проксі);
- **на сигнал бану (401/403/мережева відмова) — один ретрай через `WEBSHARE_PROXY`**.

Окремий маленький клієнт (бо `Http.get` лише GET-text, а тут POST+JSON+заголовки): приймає `fetchImpl` + `proxyUrl`, тримає прямий і проксі dispatcher'и, вирішує коли фолбекнути. Politeness-затримка помірна.

## 5. Стійкість

### 5.1 Класифікація відповіді

| Відповідь Algolia | Outcome | Backoff |
|---|---|---|
| 200 + `hits:[…]`, `nbHits>0` | кандидати → пайплайн | — |
| 200 + `hits:[]`, `nbHits:0` | **not_found** (genuine для запиту) | мутує (правильно) |
| 401/403 + error-envelope | **blocked** (ключ протух / IP-бан) | **НЕ мутує** |
| 5xx / network / timeout | **transient** | НЕ мутує |

Старі семантики `not_found`/`blocked`/`transient` лягають один-в-один; системна поломка більше не маскується під `not_found`.

### 5.2 Авто-рефреш ключів (на 401/403)

1. Дістати свіжі ключі: fetch HTML `untappd.com/search?q=beer&type=beer`, regex'ом вийняти `applicationID` + `apiKey`.
2. Нові ключі ≠ кешованим → оновити кеш, **ретрай прямий** запит.
3. Ключі ті самі / рефреш не вдався → **ретрай через проксі** (можливо IP-бан).
4. І проксі дає 403 → outcome `blocked`.

Кеш ключів: у памʼяті + персист у рядок `config`/`job_state` (`algolia_keys`), щоб рестарт не губив свіжий ключ. Хардкод-дефолти (`appId=9WBO4RQ3HO`, `searchKey=1d347324d67ec472bb7132c66aead485`) — лише сід; перекриваються опційними env.

### 5.3 Канарка (heartbeat)

Раз на enrich-прогін, **перед обробкою orphans**: один пошук завідомо-наявного популярного пива (константа, напр. `Guinness Draught`), перевірка `nbHits>0`.
- **ОК** → крутимо прогін.
- **Провал** (0 hits або error) — це **системна** поломка, не per-beer:
  - **негайно перериваємо прогін** — жоден orphan не чіпається (щоб не псувати backoff фейковими `not_found`);
  - рахуємо як `block` у спільний `untappdBreaker` (N поспіль → breaker відкривається на cooldown);
  - **алерт адміну** (`notifyAdmin`), один раз;
  - зберігаємо результат канарки в `job_state` (для daily-status, §6).

Канарка — захист саме від сценарію, що нас вкусив: «200 + порожньо для всього» (протух ключ / перейменували індекс / м'який бан) одразу кричить, замість тижня тихого нуля.

## 6. Enrich/matching у щоденному статусі

`StatusMetrics` (`src/storage/stats.ts`) + `buildStatusMessage` (`src/jobs/daily-status.ts`) дістають блок «Enrich» — людино-видимий компаньйон канарки:
- `enrichMatched24h` — orphan'ів зматчено за 24 год (`beers` з `untappd_id` та `untappd_lookup_at` за добу);
- `enrichFailures24h` — нових провалів за добу (`enrich_failures.last_at`);
- `untappdSearchHealthy` — стан пошуку: ✅ breaker закритий і остання канарка ОК; ⚠️ breaker відкритий / канарка впала (з `untappd_circuit_open_until` + збереженого результату канарки).

Рядок у дайджесті, напр.:
`• Enrich: +{enrichMatched24h} зматчено / {enrichFailures24h} провалів за 24 год · пошук {✅|⚠️}`

## 7. Тестування (Vitest)

- `algoliaSearch`: мапінг hit→`SearchResult` (фікстура з реальної відповіді); класифікація (403→`blocked`, 5xx/мережа→`transient`, 200-порожньо→`[]`); проксі-фолбек (mock: прямий 403 → проксі ОК); рефреш ключів (mock: 403 → скрейп нових ключів → ретрай прямий).
- `lookupBeer`: **міграція існуючих тестів** з інжекту фейкового `fetch`(HTML) на інжект фейкового `BeerSearch`(`SearchResult[]`); логіка стадій незмінна.
- `enrich-orphans` канарка: провал → прогін перервано, `block` у breaker, `notifyAdmin` викликано, жоден orphan не зачеплено; ОК → обробка йде.
- Екстрактор ключів: фікстура сторінки → `appId`/`apiKey`.
- `buildStatusMessage`: рядок Enrich за відомих метрик (✅ і ⚠️ кейси).

## 8. Зміни в конфігу

- Нові опційні env: `UNTAPPD_ALGOLIA_APP_ID`, `UNTAPPD_ALGOLIA_SEARCH_KEY` (з хардкод-дефолтами в коді; це публічні клієнтські ключі, не секрети, але env дає override й узгоджується з конвенцією).
- `WEBSHARE_PROXY` — переюзаємо (тепер як фолбек, а не основний шлях для пошуку).
- Канарковий запит — константа в коді.
- Оновити warn про відсутні очікувані env-ключі (per #216), якщо додаємо нові expected-ключі.

## 9. Зміни в spec.md (синхрон обов'язковий)

- Дерево (§архітектура): опис `search.ts` → «пошук пива через Algolia API».
- Розділ enrich-lookup (~631+): запит будується для Algolia, а не HTML.
- Новий підрозділ «джерело Algolia»: ключі/індекс, авто-рефреш, канарка, проксі-фолбек, класифікація відповіді.
- `enrich_failures.search_url` (§3.13): уточнити, що це людино-читабельний debug-URL (`buildSearchUrl`), а реальний fetch — Algolia.
- Client-relay (~702): позначити Phase-2 (Phase 1 лишає як є).
- daily-status / `StatusMetrics`: додати блок Enrich (§6).

## 10. Межі (що НЕ чіпаємо)

- Профільні/checkin-скрейпери (`refresh-untappd`, `refresh-tap-ratings`, `checkins`) — інші сторінки, досі HTML, працюють.
- Матчинг-пайплайн (strict/relaxed/brand/fuzzy/ABV), схема `enrich_failures`, backoff, персист breaker'а — переюзаємо без змін.
- Код розширення (`extension/**`) + `docs/extension-install-uk.md` — Phase 1 розширення не зачіпає, тож докментацію не чіпаємо (це Phase 2).

## 11. Відкриті дрібниці (вирішити в плані)

- Точний канарковий beer/query + чи звіряти конкретний `bid`, чи достатньо `nbHits>0`.
- Де персистити `algolia_keys` і результат канарки — `job_state` (KV) проти окремого рядка `config`.
- Politeness-затримка/таймаут Algolia-клієнта.
