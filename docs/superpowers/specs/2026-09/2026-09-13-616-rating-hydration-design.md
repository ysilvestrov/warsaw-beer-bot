# Дизайн — гідратація рейтингів злінкованого пива через Algolia за bid (закриває #616)

Статус: узгоджено в обговоренні 2026-09-13. Передумова #617 (PR #620) задеплоєна: синк чекінів
більше не стирає `rating_global`/`style`/`abv`, тож гідратор і синк не воюють.

## Проблема (доведена)

Виміри на прод-БД 2026-09-13, після деплою #617:

- **Злінковане пиво масово без рейтингу.** 32 759 рядків з `untappd_id`, з них 2272 з
  `rating_global IS NULL` і ще 327 з `rating_global = 0`. 933 рядки без рейтингу стоять у чиїхось
  `untappd_had` — користувач бачить своє випите пиво без рейтингу.
- **Джоба рейтингів фактично мертва.** `refreshTapRatings` бере лише рядки без рейтингу, **які зараз
  на крані** ontap (`onLatestTapPredicate`), і скрейпить HTML сторінки пива через breaker HTML-скрейпу.
  За добу 12–13.09 вісім запусків обробили разом 6 рядків; `rating_refresh_at` мають 6 з 32 759 рядків.
  Наявні рейтинги не оновлюються ніколи.
- **Нулі пишуть кілька шляхів.** Серед 327 нульових рядків провенанс: `search` 112 (enrich через
  Algolia-пошук), без провенансу 199, `checkin` 15, `curated` 1. Сторінка `/beers` профілю для
  пива з малою кількістю оцінок має `<p>Global Rating (N/A)</p>` і `data-rating="0"`, а
  `parseUserBeersPage` читає це як `0`, тож `refreshAllUntappd` теж пише нулі (знімок профілю
  2026-09-13: Funky Fluid «Prototype», bid 6869890).

## Спайк: Algolia `getObjects` за bid

- Усі 2599 рядків без рейтингу / з нулем — 3 запити по ≤1000 objectID, 1,4 с сумарно.
  Результат: **2336 мають справжній рейтинг** (з них 909 у чиїхось `untappd_had`), 257 мають
  `rating_score = 0`, 6 bid Algolia не знає.
- **`rating_score = 0` ⇔ менше 10 оцінок:** у всіх 257 `rating_count ≤ 9` (медіана 5). Сторінка
  «Global Rating (N/A)» для bid 6869890 ↔ Algolia `rating_score: 0, rating_count: 4`.
- **Algolia = сторінка Untappd:** 25 пив зі знімка `/beers` порівняно з `rating_score` тих самих bid —
  25/25 збігаються в межах округлення до 2 знаків (макс. різниця 0,0049), зокрема пиво з 29 оцінками.
  Сторінка віддає 5 знаків (`3.29971`), Algolia — 2 (`3.3`).
- Ключ пошуку без rate limit на цьому обсязі; повний цикл по каталогу — ~33 запити.
- Раніший вимір (обговорення #616): у вибірці 1000 найстаріших рейтингованих медіанний дрейф 0,02,
  p90 0,17, p99 0,48; текст бейджа змінився б у 39%.

## Рішення

### 1. Межа парсерів Untappd: «0 = немає рейтингу», 2 знаки

Один хелпер `untappdRating(v: unknown): number | null` (у `src/sources/untappd/`): нечислове, `≤ 0`
→ `null`; інакше округлення до 2 знаків. Його використовують **усі** місця, де глобальний рейтинг
Untappd входить у систему:

| Парсер | Файл | Поле-джерело |
|---|---|---|
| `parseAlgoliaResponse` (enrich-пошук) | `algolia.ts` | `rating_score` |
| `parseHydratedBeer` (`getObjects`) | `algolia.ts` | `rating_score` |
| relay HTML-пошук | `search.ts` | `.rating .caps[data-rating]` |
| CSV/JSON експорт (`/import`) | `export.ts` | `global_weighted_rating_score` |
| сторінка `/beers` профілю | `scraper.ts` | `Global Rating` → `.caps[data-rating]` |

Рейтинг не бере участі в рішеннях матчера (`global_rating` читають лише запис і показ; #487
використовує `rating_count`, його хелпер не чіпає). `taps.u_rating` з ontap — не Untappd-парсер і
в межу не входить: в останніх снапшотах 0 нулів (1151 NULL, 544 додатних).

**Правило для всіх даних:** жоден шлях не пише `rating_global = 0`. Наявні 327 нулів прибирає
гідратор (п. 3), міграція їх не переписує.

### 2. Схема v31

`ALTER TABLE beers ADD COLUMN rating_checked_at TEXT;` — «рейтинг звірено з Untappd у момент T».
Без бекфілу: наявних доказів звірки немає ні в кого.

`rating_refresh_at` / `rating_refresh_count` лишаються й міняють зміст: **бекоф для bid, якого
Algolia не знає** (їх читає й пише лише стара джоба, яка видаляється).

### 3. Сховище (`src/storage/beers.ts`)

**`listRatingHydrationCandidates(db, limit, now)`** — злінковані рядки, які пора звірити:

- `untappd_id IS NOT NULL`;
- `rating_checked_at IS NULL OR rating_checked_at < now − 30 днів`;
- JS-фільтр бекофу `isEligible(now, rating_refresh_at, rating_refresh_count)` — той самий модуль,
  що й у пулах enrich (рядок зі свіжим штампом має count 0 і `rating_refresh_at` NULL, тож фільтр
  на нього не діє);
- порядок: спершу `rating_global IS NULL OR rating_global = 0`, далі ніколи не звірені
  (`rating_checked_at IS NULL`), далі найдавніше звірені, далі `id`;
- `slice(0, limit)`.

**`applyHydratedRatings(db, hits: Map<bid, HydratedBeer>, candidates, nowIso): { updated, changed, unknown }`**
— одна транзакція на пачку:

- bid є в `hits` → `rating_global = hit.global_rating` (**перезапис**, зокрема `NULL`),
  `style = COALESCE(style, hit.style)`, `abv = COALESCE(abv, hit.abv)`, `rating_checked_at = nowIso`,
  `rating_refresh_at = NULL`, `rating_refresh_count = 0`. Рядок шукається за `untappd_id` (не за `id`
  із вибірки), тож злиття/видалення між вибіркою й записом дає 0 змінених рядків, а не чужий запис;
- bid відсутній у `hits` → лише `rating_refresh_at = nowIso`, `rating_refresh_count + 1`; рейтинг і
  штамп не чіпаються;
- `bumpCatalogVersion()` **один раз і лише якщо** хоч в одного рядка змінився `rating_global`,
  `style` або `abv` (порівняння старого з новим після округлення з п. 1). Сам штамп кешу `/match` не
  стосується.

Провенанс (`untappd_id_source`) гідратор не змінює: існування запису за bid не доводить, що локальний
рядок — це саме це пиво.

`recordRatingSuccess` / `recordRatingNotFound` / `recordRatingTransient` / `listRatingRefreshCandidates`
видаляються.

### 4. Джоба `hydrateRatings` (`src/jobs/hydrate-ratings.ts`)

Замінює `refreshTapRatings` у тому ж крон-слоті `30 1,4,7,10,13,16,19,22 * * *`.

- Гейти: `UNTAPPD_LOOKUP_ENABLED === false` → пропуск; `algoliaBreaker.canAttempt(now)` хибне → пропуск.
  (Breaker HTML-скрейпу її більше не гейтить: транспорт — Algolia, як у enrich.)
- `limit = 1000` bid на запуск → **один** виклик `search.hydrateByBid(bids)` (межа Algolia — 1000
  objectID на запит). 8 запусків/добу: бекфіл каталогу за ~4–5 днів, 2336 відновлюваних рейтингів —
  у перших трьох запусках; далі штампи рівномірні, щодня звіряється ~1/30 каталогу.
- Помилки:
  - `HttpError` з блок-статусом після `withRecovery` (оновлення ключа, проксі) → `breaker.onResult(true)`,
    нічого не пишеться;
  - інша помилка (5xx, мережа, парсинг) → лог `warn`, нічого не пишеться, наступний запуск повторить;
  - успіх → `breaker.onResult(false)`, `applyHydratedRatings`.
- Лог підсумку: `{ candidates, updated, changed, unknown }`.

`src/jobs/refresh-tap-ratings.ts`, `src/sources/untappd/beer-page.ts` і їхні тести видаляються.

### 5. `refreshAllUntappd`, гілка «рядок знайдено за bid»

`parseUserBeersPage` розрізняє три стани глобального рейтингу: `ScrapedBeer` отримує
`global_rating_shown: boolean` (блок `Global Rating` знайдено) поруч із `global_rating` (після п. 1).

| Сторінка | Запис |
|---|---|
| блок з числом | `rating_global = число`, `rating_checked_at = now` |
| блок з «N/A» (`data-rating="0"`) | `rating_global = NULL`, `rating_checked_at = now` |
| блоку немає | рейтинг і штамп не чіпаються |

`abv = COALESCE(?, abv)` — як і було. Провенанс рядка посилюється до `checkin` через `strongerSource`
(доповнення з AI-рев'ю PR #620): сторінка `/beers` — власний запис Untappd про цей bid. Гілка
«рядка за bid немає» (`upsertBeerByBid`) не змінюється і штампа не ставить — новий рядок підхопить
гідратор у черзі «ніколи не звірені».

Enrich (`recordLookupSuccess`) і `/import` штампа не ставлять.

### 6. Дайджест

Рядок «Рейтинги» отримує друге число — покриття циклу:
`• Рейтинги: {ratingsMissing} зматчених пив без рейтингу · {ratingsChecked30d} звірено за 30 днів`,
де `ratingsChecked30d = COUNT(*) WHERE untappd_id IS NOT NULL AND rating_checked_at >= now − 30 днів`.
`ratingsMissing` після гідратації включає й законні `NULL` (<10 оцінок) — друге число показує, чи
вони звірені, а не забуті.

## Заявка → доказ

| Заявка (що система записує як факт) | Що це доводить / доказ |
|---|---|
| `rating_checked_at = T` (гідратор) | `rating_global` дорівнює рейтингу Untappd на момент T. Запис отримано за `untappd_id` рядка в тому ж прогоні; Algolia = сторінка 25/25 у межах 2 знаків (спайк). |
| `rating_global IS NULL` + штамп | Untappd рейтингу не показує. 257/257 `score 0` мають `rating_count ≤ 9`; «N/A» на сторінці ↔ `rating_count 4`. |
| `rating_checked_at = T` (`refreshAllUntappd`) | Блок `Global Rating` на сторінці `/beers` у момент T знайдено (число або «N/A»). Відсутній блок штампа не дає. |
| бекоф `rating_refresh_*` | Algolia на запит 200 повернула `null` на позиції цього bid. Транзієнт і блок бекофу не пишуть. |
| `rating_global` ніколи не `0` | Правило межі парсерів (п. 1): усі п'ять входів Untappd-рейтингу через один хелпер; ontap `u_rating` нулів не має (виміряно). |
| `untappd_id_source` → `checkin` у `refreshAllUntappd` | Untappd власною сторінкою профілю показав цей bid як випите користувачем пиво; рядок знайдено за bid (#617). |
| бамп версії каталогу лише при зміні | Порівнюються старі й нові `rating_global`/`style`/`abv` після округлення; кеш `/match` залежить лише від них. |
| «звірено за 30 днів» у дайджесті | Лічильник штампів — покриття за побудовою, без припущень. |

## Зміни в `spec.md`

- Дерево файлів: `beer-page.ts` прибрати; `refresh-tap-ratings.ts` → `hydrate-ratings.ts`.
- Таблиця `beers`: рядок `rating_global` — межа «0/N/A → NULL, 2 знаки»; гідратор перезаписує,
  `refreshAllUntappd` перезаписує лише за знайденого блоку; новий рядок `rating_checked_at` (v31);
  `rating_refresh_at/count` — бекоф невідомого Algolia bid.
- Таблиця міграцій: v31.
- Таблиця фонових джоб: `refreshTapRatings` → `hydrateRatings` (зміст, квота, гейт).
- Розділ про два breaker'и: `refreshTapRatings` прибрати з HTML-скрейпу, `hydrateRatings` — під
  Algolia-breaker.
- Опис `refreshAllUntappd` (#617-абзац): штамп, три стани блоку, посилення провенансу.
- Дайджест: друге число рядка «Рейтинги».

## Тести

- **Хелпер** `untappdRating`: `0`, `"0"`, `-1`, `NaN`, `undefined` → `null`; `3.29971` → `3.3`;
  `4.26404` → `4.26`. Кожен з п'яти парсерів — тест на `0 → null` (мутація: прибрати хелпер з парсера
  → падає тест саме цього парсера).
- **Фікстура** `tests/fixtures/untappd/user-beers-na.html` — картка «Global Rating (N/A)» і картка з
  числом, дослівно вирізані зі знімка профілю 2026-09-13, плюс **синтетична** картка без блоку
  (у знімку такої немає — стан захищає від зміни розмітки, а не спостерігався); `parseUserBeersPage`
  дає `shown/rating` для всіх трьох.
- **Черга:** порядок (NULL/0 → не звірені → старі), виключення звірених <30 днів, бекоф, ліміт.
- **Запис:** перезапис рейтингу, зокрема на `NULL`; `style`/`abv` лише заповнюють; штамп і скидання
  бекофу; невідомий bid → лише бекоф; бамп лише при зміні (два прогони поспіль з тими ж даними —
  другий не бампає); злитий рядок (bid зник між вибіркою й записом) — нічого не пише.
- **Джоба:** `lookupEnabled=false`; breaker відкритий; блок → `onResult(true)` і нуль записів;
  транзієнт → нуль записів; успіх → один виклик `hydrateByBid` з ≤1000 bid.
- **`refreshAllUntappd`:** три стани блоку на рядку, знайденому за bid; провенанс `search → checkin`,
  `curated` лишається `curated`.
- **Міграція v31** і рядок дайджесту.

## Стадії

1. **Ядро:** п. 1 (хелпер + п'ять парсерів), п. 2 (v31), п. 3 (сховище), п. 4 (джоба без підключення).
   Наскрізне рев'ю ядра.
2. **Обв'язка** (окремий план після рев'ю): крон-слот і видалення `refreshTapRatings`/`beer-page.ts`,
   п. 5, п. 6, `spec.md`.

## Поза межами

- Рейтинги сиріт (`untappd_id IS NULL`) — у них немає bid.
- `taps.u_rating` з ontap.
- Перепризначення bid Untappd (злиття пив) — рядок зі старим bid отримає бекоф «невідомий bid»;
  окремий дефект, на проді не спостерігався.
- Показ кількості оцінок (`rating_count`) у бейджах.
