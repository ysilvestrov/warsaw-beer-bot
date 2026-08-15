# Warsaw Beer Crawler Bot — spec.md

> **Стандарт:** OpenSpec (spec-driven development).
> **Статус:** `LIVE` — реверс-інжиніринг з прод-кодової бази (v1.0, на Hetzner CX33 під systemd).
> **Призначення:** єдине джерело істини для фреймворку Superpowers. Усі майбутні
> зміни проходять цикл brainstorming → spec → plan → worktree і звіряються з цим документом.
> **Дата зведення:** 2026-06-02.
> **Похідні джерела:** `ARCHITECTURE.md`, `docs/USER-GUIDE.md`,
> `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`, `src/**`.

> ⚠️ **Корекція стеку.** Постановка задачі згадувала Python — це неточність.
> Фактична реалізація — **Node.js + TypeScript**. Нижче описано реальний код.

---

## 1. Core Concept

### Що робить бот
Telegram-бот для пивних краулів у Варшаві. Він допомагає користувачу знайти
**цікаве непите пиво**, яке *прямо зараз* налите на кранах у місцевих пабах,
і побудувати **оптимальний пішохідний маршрут** через паби, де це пиво є.

### Яку проблему вирішує
Любитель крафту хоче пити **нове для себе** пиво, а не повторювати вже спробуване.
Інформація розкидана між двома непоєднаними джерелами:

- **ontap.pl/warszawa** — що зараз на крані (живий стан міста);
- **Untappd-профіль користувача** — що він уже пив (особиста історія).

Бот автоматично перетинає ці джерела, ранжує результат за рейтингом Untappd
і приземляє його в конкретний маршрут пішки.

### Ключове визначення
> **«Цікаве непите пиво»** = пиво, яке (а) є на крані прямо зараз
> (останній snapshot ontap.pl), (б) **відсутнє** в історії користувача
> (об'єднання `checkins` ∪ `untappd_had`), і (в) проходить активні фільтри
> стилю / мінімального рейтингу / ABV.

### Межі MVP (свідомо поза скоупом)
- Години роботи пабів (ontap.pl їх не віддає).
- Ціна / об'єм порції / прямий untappd-id з крана (відсутні в HTML).
- Жорсткі ліміти маршруту (макс. дистанція / макс. кількість пабів).

---

## 2. System Architecture

### 2.1 Технологічний стек

| Шар | Технологія | Призначення |
|-----|-----------|-------------|
| Runtime | **Node.js ≥ 20** | базова платформа |
| Мова | **TypeScript** (strict) | уся кодова база |
| Telegram | **Telegraf 4.x** | бот-фреймворк, long polling |
| База даних | **better-sqlite3** (SQLite, WAL) | увесь персистентний стан |
| Парсинг HTML | **cheerio** | ontap.pl + сторінки пива Untappd |
| Імпорт історії | **csv-parse**, **stream-json**, **yauzl** | streaming-парсинг CSV / JSON / ZIP |
| Fuzzy-матчинг | **fast-fuzzy** | зіставлення назв пива (token-set) |
| Планувальник | **node-cron** | періодичні джоби в процесі |
| HTTP-throttling | **p-queue** | єдина черга до зовнішніх джерел |
| Валідація конфігу | **zod** | парсинг і типізація `.env` |
| Логування | **pino** | структуровані JSON-логи |
| Тести | **Vitest** | unit + контрактні тести |

**Зовнішні API / джерела:**
- `ontap.pl/warszawa` та сабдомени `<slug>.ontap.pl` — HTML-скрейп (без API).
- `untappd.com/user/<username>/beers` — HTML-скрейп публічного профілю
  (опційно з session-cookie для більшого охоплення).
- Untappd file export (CSV / JSON / ZIP) — завантажується користувачем у `/import`.
- **OSRM** (`router.project-osrm.org` або self-host) — пішохідні дистанції.
- **Nominatim** (OSM) — геокодинг-fallback, коли ontap.pl не дав координат.

### 2.2 Структура директорій

```
src/
├── index.ts                # composition root: env → db → migrate → bot → cron → http → shutdown
├── shutdown.ts             # graceful teardown (cron → bot → http → db → exit)
│
├── config/
│   └── env.ts              # zod-валідація .env, читається ОДИН раз
│
├── sources/                # збір даних (pure I/O, без бізнес-логіки)
│   ├── http.ts             # фабрика fetch-клієнта (UA, cookie, throttle)
│   ├── geocoder.ts         # адреса → координати (Nominatim fallback)
│   ├── ontap/
│   │   ├── index.ts        # парсер індексу /warszawa (список пабів)
│   │   ├── identity.ts     # очистка tap-ідентичності (spec/градус/броварня) — #306
│   │   ├── non-beer.ts     # gate: не-пиво + плейсхолдери «нема в наливі»
│   │   └── pub.ts          # парсер сторінки паба (лише DOM)
│   └── untappd/
│       ├── export.ts       # streaming-парсер експорту (CSV/JSON/ZIP)
│       ├── scraper.ts      # свіжі чекіни з /user/<u>/beers
│       ├── search.ts       # BeerSearch інтерфейс + htmlSearch (relay-адаптер); раніше — єдиний скрейпер
│       ├── algolia.ts      # createAlgoliaSearch — пошук через Algolia JSON API (індекс beer)
│       └── beer-page.ts    # парсер сторінки конкретного пива
│
├── domain/                 # бізнес-логіка (чисті функції, без I/O)
│   ├── normalize.ts        # нормалізація назв (діакритика, стоп-слова, цифри; BREWERY_NOISE — мультимовні дескриптори пивоварень)
│   ├── matcher.ts          # ontap-пиво ↔ untappd-пиво (+ brewery aliases)
│   ├── filters.ts          # «нове для мене», ранжування, стиль/ABV
│   ├── router.ts           # set-cover ≥ N → локальна оптимізація → open-TSP
│   ├── lookup-backoff.ts   # експоненційний backoff для Untappd-lookup
│   └── untappd-lookup.ts   # координація enrich-lookup проти каталогу
│
├── storage/                # репозиторії SQLite (один модуль на таблицю)
│   ├── db.ts               # відкриття БД (WAL, FK on)
│   ├── schema.ts           # DDL + версіоновані міграції (v1..v8)
│   ├── beers.ts            # каталог пива (upsert, lookup-state)
│   ├── checkins.ts         # чекіни користувача (batched insert)
│   ├── pubs.ts             # паби (upsert, setPubCoords)
│   ├── snapshots.ts        # tap_snapshots + taps; tapsForSnapshotWithBeer
│   ├── match_links.ts      # ontap_ref → beers.id, confidence
│   ├── pub_distances.ts    # кеш OSRM-дистанцій (pub_id_a < pub_id_b)
│   ├── untappd_had.ts      # per-user trailing-25 «вже пив»; triedBeerIds
│   ├── user_profiles.ts    # telegram_id, untappd_username, language
│   └── user_filters.ts     # стилі, min_rating, ABV, default_route_n
│
├── bot/                    # Telegram-шар (Telegraf)
│   ├── index.ts            # createBot: deps middleware + i18n + bot.catch
│   ├── keyboards.ts        # інлайн-клавіатури (/filters, /lang)
│   ├── middleware/
│   │   └── i18n.ts         # ставить ctx.locale + ctx.t на кожен апдейт
│   └── commands/           # один файл на команду + чисті *-build/*-format
│       ├── start.ts  link.ts  import.ts
│       ├── newbeers.ts  newbeers-build.ts  newbeers-format.ts
│       ├── beers.ts  beers-build.ts
│       ├── pubs.ts  pubs-build.ts
│       ├── route.ts  route-format.ts
│       ├── filters.ts  lang.ts  refresh.ts  extension.ts
│
├── api/                    # вбудований read-only HTTP API (Hono)
│   ├── index.ts            # createApiApp (cors/health/auth/onError) + createApiServer
│   ├── types.ts            # ApiDeps, ApiEnv (Hono Variables)
│   ├── middleware/auth.ts  # Bearer → sha256 → api_tokens → c.set('telegramId')
│   └── routes/match.ts     # POST /match (скоуп по власнику токена)
│
├── jobs/                   # фонові джоби (node-cron + startup)
│   ├── progress.ts         # спільний ProgressFn (throttled editMessageText)
│   ├── refresh-ontap.ts    # обхід ontap.pl → snapshots → match
│   ├── refresh-untappd.ts  # скрейп профілів → checkins/untappd_had
│   ├── refresh-tap-ratings.ts  # дотягування рейтингів на кранах
│   ├── enrich-orphans.ts   # lookup незматчених beers у Untappd
│   ├── untappd-enrich.ts   # ядро enrich-логіки
│   ├── dedupe-brewery-aliases.ts  # startup: злиття дублів каталогу
│   └── cleanup-polluted-ontap.ts  # startup: чистка «брудних» назв
│
└── i18n/                   # локалізація (uk / pl / en)
    ├── index.ts  types.ts  translator.ts
    ├── detect-locale.ts    # from.language_code → Locale (ru/be → en)
    ├── format.ts           # locale-aware fmtAbv / fmtKm
    └── locales/{uk,pl,en}.ts
```

### 2.3 Архітектурні принципи (інваріанти)
1. **I/O відокремлено від чистої логіки.** `sources/`, `storage/`, `bot/`
   роблять I/O; `domain/` — лише чисті функції, повністю unit-тестовані.
2. **Увесь стан — у SQLite.** In-memory кеш живе лише в межах одного запиту.
3. **`.env` читається один раз** у `config/env.ts` і передається як залежність
   (`AppDeps = { db, env, log }`). Жодних `process.env` глибше composition root.
4. **Composition root — `src/index.ts`.** Усі залежності збираються там і
   ін'єктуються вниз; модулі не створюють власних з'єднань.
5. **Handler — тонка обгортка.** Уся форматувальна / групувальна логіка винесена
   в чисті `*-build.ts` / `*-format.ts`, покриті тестами; команда лише склеює.
6. **Дані з джерел версіонуються snapshot'ами**, а не перезаписуються —
   `tap_snapshots` дають історію «що коли лилось».

---

## 3. Data Models

> SQLite, режим WAL, `FOREIGN KEYS = ON`. DDL і міграції — `src/storage/schema.ts`.
> Схема версіонується таблицею `schema_version`; міграції застосовуються
> по зростанню версії в одній транзакції кожна. Нижче — **фінальний стан**
> після міграцій **v1–v8**.

### 3.1 `beers` — каталог пива (Untappd-канон + ontap-сторона)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `id` | INTEGER | PK AUTOINCREMENT | локальний ідентифікатор |
| `untappd_id` | INTEGER | UNIQUE, nullable | реальний Untappd-id; `NULL` = orphan (ще не зматчено) |
| `name` | TEXT | NOT NULL | канонічна назва пива |
| `brewery` | TEXT | NOT NULL | пивоварня |
| `style` | TEXT | nullable | стиль |
| `abv` | REAL | nullable | міцність, %; заповнюється з Untappd (`refreshAllUntappd` парсить `.abv`, backfill через `COALESCE`; orphan-lookup — теж) |
| `rating_global` | REAL | nullable | публічний рейтинг Untappd (`global_weighted_rating_score`) |
| `normalized_name` | TEXT | NOT NULL | для матчингу |
| `normalized_brewery` | TEXT | NOT NULL | для матчингу |
| `untappd_lookup_at` | TEXT | nullable (v5) | час останньої спроби lookup |
| `untappd_lookup_count` | INTEGER | NOT NULL DEFAULT 0 (v5) | лічильник спроб (backoff) |
| `rating_refresh_at` | TEXT | nullable (v6) | час останнього оновлення рейтингу |
| `rating_refresh_count` | INTEGER | NOT NULL DEFAULT 0 (v6) | лічильник оновлень рейтингу |
| `web_tried_at` | TEXT | nullable (v19, перейменована у v20) | час останньої спроби web-фолбеку (#139); per-beer кулдаун 30 днів захищає квоту від дормантних orphan'ів |

Індекс: `idx_beers_norm (normalized_brewery, normalized_name)`.
**Інваріант:** реальний статус матчингу визначає `untappd_id IS NOT NULL`,
а **не** наявність match-link (див. §3.6).

### 3.2 `pubs` — паби з ontap.pl
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `slug` | TEXT | NOT NULL UNIQUE | сабдомен на ontap.pl (=`id_ontap`) |
| `name` | TEXT | NOT NULL | назва паба |
| `address` | TEXT | nullable | адреса |
| `lat` | REAL | nullable | широта |
| `lon` | REAL | nullable | довгота |
| `city` | TEXT | NOT NULL DEFAULT 'warszawa' (v14) | slug міста з `CITIES` (`src/domain/cities.ts`) |

Зміна `lat`/`lon` інвалідує кеш у `pub_distances`.

### 3.3 `tap_snapshots` — знімок стану кранів паба
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `pub_id` | INTEGER | NOT NULL → `pubs(id)` | |
| `snapshot_at` | TEXT | NOT NULL | час зняття (ISO) |

Індекс: `idx_snapshot_pub_time (pub_id, snapshot_at DESC)`.
«Поточні крани» = крани з останнього snapshot кожного паба.

**Retention:** `cleanupOldSnapshots` (startup + щодня 05:00) видаляє snapshot'и
старші за `SNAPSHOT_RETENTION_DAYS` (default 14), **окрім** останнього snapshot
кожного паба (`MAX(id)` по `pub_id`). `taps` чистяться каскадом
(§3.4 `ON DELETE CASCADE`). Лише `DELETE`, без `VACUUM` — файл БД виходить на
плато, а не зростає нескінченно (Litestream-friendly).

### 3.4 `taps` — окремий кран у межах snapshot
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `snapshot_id` | INTEGER | NOT NULL → `tap_snapshots(id)` **ON DELETE CASCADE** | |
| `tap_number` | INTEGER | nullable | номер крана (вкл. «N Pompa») |
| `beer_ref` | TEXT | NOT NULL | сира назва пива з ontap.pl |
| `brewery_ref` | TEXT | nullable | сира пивоварня |
| `abv` | REAL | nullable | |
| `ibu` | REAL | nullable | |
| `style` | TEXT | nullable | |
| `u_rating` | REAL | nullable | рейтинг на момент скрейпу (часто NULL) |

Індекс: `idx_taps_snapshot (snapshot_id)`.

### 3.5 `checkins` — історія користувача (масовий канал)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `checkin_id` | TEXT | NOT NULL | merge-ключ з Untappd |
| `telegram_id` | INTEGER | NOT NULL | власник |
| `beer_id` | INTEGER | → `beers(id)`, nullable | |
| `user_rating` | REAL | nullable | особиста оцінка |
| `checkin_at` | TEXT | NOT NULL | |
| `venue` | TEXT | nullable | |
| | | **UNIQUE(telegram_id, checkin_id)** | ідемпотентність імпорту |

Індекс: `idx_checkins_user_beer (telegram_id, beer_id)`.

### 3.6 `match_links` — ontap-пиво ↔ каталог
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `id` | INTEGER | PK AUTOINCREMENT | |
| `ontap_ref` | TEXT | NOT NULL UNIQUE | сире посилання з крана |
| `untappd_beer_id` | INTEGER | → `beers(id)`, nullable | **локальний `beers.id`** (історична назва) |
| `confidence` | REAL | NOT NULL | 1.0 = exact/parser-choice, <1 = fuzzy score |
| `reviewed_by_user` | INTEGER | NOT NULL DEFAULT 0 | `1` = **курований пін** (ручний матч, який ingest ніколи не переобраховує) |
| `merged_at` | TEXT | nullable | штамп `mergeIntoCanonical`: посилання встановив **merge**, а не матчер (#366) |

> ⚠️ **Gotcha:** `untappd_beer_id` — це **локальний `beers.id`**, а не Untappd-id;
> він заповнений навіть для orphan-рядків. Реальний статус матчингу читати з
> `beers.untappd_id`, не з наявності match-link.

**Куровані піни (`reviewed_by_user = 1`).** Для пива, чия назва в магазині розходиться
з Untappd так, що жоден алгоритм не наведе місток (напр. магазинне `Urodzinowe`, яке в
Untappd — `Banany Na Rauszu 2026`), людина фіксує матч вручну. Ingest (`refresh-ontap`)
**ніколи не переобраховує** кран із пінованим лінком, а enrich-крон його не чіпає (пінований
рядок уже не orphan). Піни створюються/знімаються/переглядаються тулою `npm run pin-match`
(`--beer/--untappd` для піна, `--unpin --ref/--beer`, `--list`). Два випадки на рівні даних:
якщо цільовий Untappd-bid уже належить канонічному рядку — лінк(и) orphan'а
**перенаправляються** на канонічний рядок і orphan видаляється (merge); якщо bid новий —
`untappd_id` виставляється на власному рядку orphan'а. Пін ключується на сирому рядку назви
крана (`ontap_ref`): якщо магазин згодом перевикористає **той самий** рядок для **іншого**
пива, пін треба зняти вручну — він не самокоригується.

**Пам'ять про merge (`merged_at`).** Коли enrich знаходить bid, який уже належить іншому
рядку, `mergeIntoCanonical` переспрямовує посилання на канонічний рядок і **штампує
`merged_at`**. Порядок пріоритетів в ingest (`refresh-ontap`), від найсильнішого:

1. пін (`reviewed_by_user = 1`) — кран не переобраховується взагалі;
2. влучання матчера — посилання перезаписується, `merged_at` скидається в NULL
   (це робить сам `upsertMatch`, тож матчер завжди головний);
3. промах матчера + `merged_at IS NOT NULL` + жива ціль із `beers.untappd_id` — посилання
   перевикористовується: ні нової сироти, ні inline-enrich (лічильник
   `ontap merged links reused`);
4. інакше — нова сирота + посилання + inline-enrich.

Штампуються **лише посилання з `confidence >= 1.0`** (exact/parser-choice): саме їхній текст крана
енрич і шукав. Fuzzy-сателіти (`<1.0`) merge переспрямовує, як і раніше, але **не** робить
довговічними — вони й далі стають сиротами і шукаються за власним текстом.

Без п.3 кожен інжест створював сироту заново, знову її збагачував і знову зливав: ~65 зайвих
запитів до Untappd на добу і повторні платні виклики web-fallback на той самий кран (#366).
Скасувати хибну пам'ять = `UPDATE match_links SET merged_at = NULL WHERE ontap_ref = …`;
інвентар і черга підтвердження — у #361.

### 3.7 `untappd_had` — per-user trailing-25 «вже пив» (v4)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `telegram_id` | INTEGER | NOT NULL | |
| `beer_id` | INTEGER | NOT NULL → `beers(id)` **ON DELETE CASCADE** | |
| `last_seen_at` | TEXT | NOT NULL | |
| | | **PK (telegram_id, beer_id)** | |

Індекс: `idx_untappd_had_telegram (telegram_id)`.
Заповнюється скрейпером (`markHad`). Об'єднання з `checkins` дає повний
«drunk-set» — див. §5.2.

### 3.8 `user_profiles` — профіль користувача
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `telegram_id` | INTEGER | PK | ключ ідентичності |
| `untappd_username` | TEXT | nullable | прив'язаний профіль |
| `created_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | |
| `language` | TEXT | nullable (v3) | `uk`/`pl`/`en`; авто-детект, override через `/lang` |
| `city` | TEXT | nullable (v14) | обране місто; `NULL` або невідомий slug → `OUTSIDE_CITY` (`'outside-pl'`, #399) |

### 3.9 `user_filters` — фільтри користувача
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `telegram_id` | INTEGER | PK → `user_profiles(telegram_id)` **ON DELETE CASCADE** | |
| `styles` | TEXT | nullable | список стилів (серіалізований) |
| `min_rating` | REAL | nullable | мінімальний Untappd-рейтинг |
| `abv_min` | REAL | nullable | мінімальний ABV (відкриті ABV-пороги в /filters) |
| `abv_max` | REAL | nullable | максимальний ABV (відкриті ABV-пороги в /filters) |
| `default_route_n` | INTEGER | nullable | дефолт для `/route` |

### 3.10 `pub_distances` — кеш пішохідних дистанцій (v2)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `pub_id_a` | INTEGER | NOT NULL → `pubs(id)` CASCADE | |
| `pub_id_b` | INTEGER | NOT NULL → `pubs(id)` CASCADE | |
| `meters` | REAL | NOT NULL | дистанція |
| `source` | TEXT | NOT NULL CHECK IN (`osrm`,`haversine`) | джерело значення |
| `updated_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | |
| | | **PK (pub_id_a, pub_id_b)**, **CHECK (pub_id_a < pub_id_b)** | канонічний порядок пари |

### 3.11 `api_tokens` — токени браузерного розширення (v8)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `token_hash` | TEXT | NOT NULL PRIMARY KEY | sha256-хеш сирого токена (hex) |
| `telegram_id` | INTEGER | NOT NULL → `user_profiles(telegram_id)` **ON DELETE CASCADE** | власник токена |
| `created_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | час видачі |

Індекс: `idx_api_tokens_telegram (telegram_id)`.
**1:1 ротація:** при виклику `/extension` старий токен видаляється (`DELETE WHERE telegram_id`),
вставляється новий — усе в одній транзакції (`rotateToken`). Сирий токен ніколи не
зберігається — лише sha256-хеш.
Для `/match` авторизація **опційна** — див. §4 (анонімний global-only match без токена).

### 3.12 `extension_releases` — релізи браузерного розширення (v9)
> ⚠️ **RETIRED (#267, 2026-08-08).** Канал off-store дистрибуції прибрано; таблиця
> лишається в схемі разом з історичними рядками, але код у неї більше не пише й не читає.

| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `version` | TEXT | NOT NULL PRIMARY KEY | semver релізу (напр. `0.2.0`) |
| `sha256` | TEXT | NOT NULL | hex-дайджест zip (пишеться збіркою) |
| `notes` | TEXT | NOT NULL | тіло секції CHANGELOG (пишеться збіркою) |
| `file_id` | TEXT | nullable | Telegram `file_id` для перешилання; NULL поки адмін не завантажить |
| `published_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | час запису рядка |
| `attached_by` | INTEGER | nullable | telegram_id адміна, що прикріпив `file_id` |

**Хто що писав (історично, до #267):** `version`/`sha256`/`notes` — релізна збірка;
`file_id`/`attached_by` — бот, коли адмін надсилав zip і його sha256 збігався з
останнім рядком. «Остання» версія — за semver (числове порівняння, не лексичне).

### 3.13 `enrich_failures` — лог провалів енричу (v10)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `beer_id` | INTEGER | PK → `beers(id)` **ON DELETE CASCADE** | один рядок на пиво |
| `brewery` | TEXT | NOT NULL | сирий вхід (як прийшов) |
| `name` | TEXT | NOT NULL | сирий вхід |
| `search_url` | TEXT | NOT NULL | людиночитний debug-URL, побудований `buildSearchUrl` (перша brewery-частина) — зручно відкрити для ручної перевірки; **реальний запит йде через Algolia API**, а не цю HTML-сторінку |
| `outcome` | TEXT | NOT NULL CHECK IN (`not_found`,`blocked`) | результат провалу. `blocked` — окреме правило (#425, див. нижче): він ніколи не перезаписує вже наявний рядок |
| `candidates_count` | INTEGER | NOT NULL | скільки кандидатів повернув пошук (0 = зашумлений запит) |
| `candidates_summary` | TEXT | NOT NULL | топ-3 `"<brewery> — <name>"`, `;`-joined (порожньо для blocked) |
| `fail_count` | INTEGER | NOT NULL DEFAULT 1 | скільки разів провалився (++ на upsert) |
| `last_at` | TEXT | NOT NULL | час останнього провалу (ISO) |
| `source_url` | TEXT | NOT NULL DEFAULT '' | URL сторінки магазину, з якої прийшла ця пара brewery/name; заповнюється лише client-relay (`/enrich/result` з `pageUrl`); серверний крон пише `''` (URL невідомий) |
| `review_class` | TEXT | nullable, два CHECK (міграція 24): `IN (parser_bug, matcher_bug, not_on_untappd, unidentifiable, not_a_beer)` **і** `review_class IS NULL OR outcome = 'not_found'` | клас тріажу; `NULL` = ще не розмічено. Значення — гілки «ні» одного дерева рішень (див. нижче) |
| `review_note` | TEXT | nullable | довільна нотатка тріажу (агент або адмін) |
| `reviewed_at` | TEXT | nullable | час розмітки (ISO); виставляється ендпоінтом `POST /admin/enrich-failures/review` |
| `issue_number` | INTEGER | nullable (міграція 23) | GitHub-issue, до якої тріаж прив'язав цей рядок. **Авторитетне** джерело зв'язку: суфікс `→ #N` у `review_note` пишеться далі, але лише для людського ока. Читає гейт насичення (#408) через `countRowsForIssue(db, issue, sinceIso)`, який рахує рядки, дописані **після** створення issue |
| `retired_at` | TEXT | nullable (міграція 18) | термінальний стан для класифікованого провалу, чия причина вже усунена (відповідний фікс задеплоєно). Виставляється ops-тулою `retire-resolved-orphans`. Рядок **зберігає** початковий `review_class` (для аудиту); `review_note` доповнюється причиною |

**Словник тріажу (#377, міграція 24).** Класи — це гілки «ні» одного впорядкованого дерева, тож набір повний і взаємовиключний за побудовою. Тріаж іде по ньому згори й зупиняється на першому «ні»:

| # | питання | «ні» ⇒ клас | доказ | чий фікс | виключає з пулів | зворотний |
|---|---|---|---|---|---|---|
| 1 | Це взагалі позиція пива? | `not_a_beer` | сам товар (мерч, скло, вино/сидр/коктейль/їжа, комбуча, бандли/мультипаки/подарункові набори — набір не є пивом, навіть якщо кожна пляшка в ньому пиво) | фільтр інжесту | **так — єдиний клас, що виключає** | ні, і це правильно |
| 2 | Наш рядок вірний сторінці крамниці? | `parser_bug` | сторінка крамниці проти наших полів | наш адаптер | ні | так |
| 3 | Чи можна сказати, ЯКЕ це пиво? | `unidentifiable` | кілька кандидатів без підстави обрати; або жодного, і лістинг вказує на вигадане пиво / неіснуючу броварню / гарбл | ніхто сьогодні | ні | так, за побудовою |
| 4 | Воно є на Untappd? | `not_on_untappd` | проба, що **відпрацювала** й повернула порожньо | ніхто | ні | так — Untappd росте |
| 5 | усе вище «так», а ми не знайшли | `matcher_bug` | кандидати поруч, alias-геп | матчер/аліаси/нормалізація | ні | так |

Поза деревом: рядок, на якому дерево **не можна запустити** (`outcome != 'not_found'` — Untappd не відповів, доказів не існує), не отримує класу взагалі. Це тримається табличним `CHECK`, тобто діє й на сирий SQL, а не лише на застосунок.

Два правила, які випливають із таблиці і які легко порушити:
- **`unidentifiable` — твердження про нашу здатність розрізняти СЬОГОДНІ**, а не про світ: «кілька кандидатів, не вибрати» усувається тай-брейком (#409), «вигадана броварня» — новим аліасом (#347/#327). Тому він **не** виключає рядок із пулів: інакше наявний авто-розпечатувач (`recordEnrichFailure` скидає клас, коли `candidates_count` перетинає межу `0 ↔ >0`) не може спрацювати ніколи — печатка тримає рядок подалі від лукапу, який її ж і зняв би. Складність фіксу ніколи не є входом класифікації: «я знаю, що це Guinness, але наші правила його не дістають» — це `matcher_bug`.
- **`not_a_beer` — actionable**: іде в GitHub, бо має власника фіксу (футболка не мала потрапити в `beers`). Він звільнений від гейту фальсифікованої причини (#358) — його твердження про товар, а не про запит, тож вимагати `proposed_query` означало б змушувати модель вигадати його. Від scope-гейту (#408) він **не** звільнений.

Єдиний write-site вердикту — `setEnrichFailureReview`; через нього йдуть і LLM-джоба, і `POST /admin/enrich-failures/review`. Він повертає `written | no_row | refused_unaskable | refused_unproved_absence`, і `not_on_untappd` вимагає явного доказу відсутності (`absenceProvedBy(probe)`), що за замовчуванням хибний — тож адмінський роут відсутність ствердити не може взагалі (`422`).

**Retirement (`retired_at`).** Класифіковані рядки провалів залишаються в БД назавжди (видаляються лише на `matched`), тож уже вирішені кластери (вино/спирт тепер фільтруються, brewery=name #238 тощо) продовжують виглядати «активними» й роздувати лічильник orphan'ів. `retire-resolved-orphans` (npm-скрипт, dry-run за замовчуванням, `--apply`) переводить **доказово вирішені** рядки в `retired_at`. Вибір — лише верифікований, ніколи за віком чи класом: **авто-шлях** бере класифікованих orphan'ів, яких поточний `isOntapNonBeerTap` тепер відкидає (доказ вирішення); **escape-hatch `--ids <csv> --reason "<text>"`** — явно задані оператором `beer_id` (для фіксів, яких предикат не ловить — напр. `VINO KARPATIA` italian-`vino`, або parse-split кластери після шипу фіксу). Retired-рядки виключені з обох enrich-пулів (`listLookupCandidates` і `listRelayLookupCandidates`, поряд із `not_a_beer`) та з лічильника `orphansPending` у щоденному дайджесті.

**Хто що пише:** `applyLookupOutcome` (спільний для серверного крона і client-relay)
upsert'ить рядок на `not_found`/`blocked` і **видаляє** його на `matched`. Один рядок на
пиво (upsert по `beer_id`), розмір обмежений поточним набором orphan'ів. Untappd-пошук
відтворюваний без кукі; `search_url` — людиночитний debug-URL (HTML-сторінка Untappd-пошуку), реальний запит — Algolia API, але обидва дають ті ж кандидати. `source_url` (URL
сторінки магазину) дозволяє відкрити першоджерело і перевірити, чи parser-баг
(адаптер прочитав назву/пивоварню криво) чи matcher-баг; заповнюється лише
client-relay (`/enrich/result`), серверний крон пише `''`. Запит:
`SELECT … FROM enrich_failures WHERE review_class IS NULL ORDER BY last_at DESC` — «0 кандидатів» = зашумлений запит;
«N, але not_found» = brewery-gate / name-fuzzy відсік (видно по `candidates_summary`).
**Важливо:** повторний провал того самого пива (`recordEnrichFailure`) скидає
`review_class`/`review_note`/`reviewed_at` до `NULL` **лише коли `candidates_count`
перетинає межу `0 ↔ >0`** (результат пошуку суттєво змінився — варто перетріажити); за
незмінного боку класифікація зберігається і рядок НЕ повертається в тріаж (щоб прибрати
щоденний шум повторних однакових провалів).

**`blocked` ніколи не понижує вже наявний рядок (#425).** Спроба, що закінчилась
`outcome='blocked'`, нічого не дізналась про саме пиво — це факт про нас (кинутий IP,
відкритий circuit breaker), а не про Untappd-присутність цього пива. Тому `recordEnrichFailure`
дозволяє їй **створити** рядок для пива, в якого його ще немає (щоб провал не загубився
безслідно), але для пива, яке вже має рядок, лише інкрементує `fail_count`/`last_at` — `outcome`,
діагностика (`candidates_count`/`candidates_summary`) і тріажний вердикт останньої реальної
спроби лишаються недоторканими. Це тримає вікно блокування від двох речей одразу: (1) від
витіснення нетріажених рядків із черги тріажу — `listUntriagedFailures` виключає `blocked`, тож
якби блок перезаписував `outcome`, рядок на мить зникав би з черги без жодної нової інформації;
і (2) від порушення `CHECK` міграції 24 (`review_class IS NULL OR outcome = 'not_found'`) —
понижуючий `UPDATE` міг би лишити ненульовий `review_class` на рядку з `outcome='blocked'`.

**Провал одного пива не зупиняє прогін (#425).** `enrichOrphans` обгортає виклик
`enrichOneOrphan` для кожного кандидата в `try/catch`: виняток зі сховища чи з web-fallback
логується, рахується в `errors` результату джоби, і цикл переходить до наступного кандидата
замість того, щоб обірвати весь прогін (~20 мережевих і БД-операцій) на першому-ліпшому. Такий
виняток **свідомо не** репортується в Untappd circuit breaker: `breaker.onResult(true, …)`
означає «Untappd нас заблокував», а локальний збій сховища чи fallback — це не доказ про
Untappd; пропустити його туди означало б дозволити локальному багу відкрити circuit і спинити
весь енрич на вікно backoff.

Покроковий дебаг-ранбук: `docs/debug-orphan-matching.md`.

### 3.14 `checkin_sync_state` — resume-курсор extension-синхронізації чекінів (v13)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `telegram_id` | INTEGER | PK → `user_profiles(telegram_id)` **ON DELETE CASCADE** | власник |
| `deepest_max_id` | TEXT | nullable | найглибший (найменший) Untappd-курсор `max_id`, до якого дійшла синхронізація; `NULL` доки жодного прогону |
| `complete` | INTEGER | NOT NULL DEFAULT 0 | `1` коли досягнуто дна стрічки (вся історія покрита) |
| `updated_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | |
| `profile_total` | INTEGER | nullable | останній відомий загальний лік чекінів у профілі Untappd (парситься з кожної сторінки extension-синхронізації; *latest non-null wins*). Використовується `/status` для показу `synced / profile_total`. NULL для користувачів, що не користуються розширенням (import-only / link-only). |

Per-user стан для **extension check-in sync** (див. §4, `POST /checkins/sync`): браузерне
розширення гортає стрічку чекінів користувача newest→older і релеїть сторінки на сервер,
а сервер тримає тут курсор, щоб повторні прогони **продовжували** глибше, а не перечитували
верхівку. `deepest_max_id` оновлюється до мінімуму (курсор лише поглиблюється; Phase-1
top-up з високим `max_id` не відкочує його); `complete` латчиться в `1` і назад не вертається.
Це робить бекфіл великої історії (5K+ чекінів) досяжним за кілька натискань «Sync».

### 3.15 `api_usage` — денний облік запитів розширення (v17)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `date` | TEXT | PRIMARY KEY | варшавська дата `YYYY-MM-DD` |
| `anon_requests` | INTEGER | NOT NULL DEFAULT 0 | `/match` без токена (анонім) за добу |
| `authed_requests` | INTEGER | NOT NULL DEFAULT 0 | `/match` з валідним токеном за добу |
| `beers` | INTEGER | NOT NULL DEFAULT 0 | сума `beers[]` у запитах за добу |

Інкрементується best-effort у `POST /match` (помилка запису не валить відповідь).
Один рядок на добу (обмежене зростання, без cleanup).

### 3.16 `schema_version` — версія міграцій
Єдине поле `version INTEGER PRIMARY KEY`; по рядку на застосовану міграцію.

### 3.17 Зв'язки (ER, текстом)
```
user_profiles 1───* checkins        (telegram_id)
user_profiles 1───1 user_filters    (telegram_id, CASCADE)
user_profiles 1───1 checkin_sync_state (telegram_id, CASCADE)
user_profiles 1───* untappd_had     (telegram_id)
user_profiles 1───* api_tokens      (telegram_id, CASCADE; ротація тримає 1 активний)
beers         1───* checkins         (beer_id)
beers         1───* untappd_had      (beer_id, CASCADE)
beers         1───* match_links      (untappd_beer_id = LOCAL beers.id)
beers         1───1 enrich_failures   (beer_id, CASCADE; один рядок на пиво, що провалило енрич)
pubs          1───* tap_snapshots    (pub_id)
tap_snapshots 1───* taps             (snapshot_id, CASCADE)
pubs          *───* pubs             via pub_distances (a<b)
```

### 3.18 Історія міграцій
| v | Зміст |
|---|-------|
| 1 | базова схема: beers, pubs, tap_snapshots, taps, checkins, match_links, user_profiles, user_filters |
| 2 | `pub_distances` (кеш OSRM) |
| 3 | `user_profiles.language` (i18n) |
| 4 | `untappd_had` (two-source drunk model) |
| 5 | `beers.untappd_lookup_at` + `untappd_lookup_count` (lookup backoff) |
| 6 | `beers.rating_refresh_at` + `rating_refresh_count` (rating refresh) |
| 7 | reset lookup-backoff для orphan'ів (`untappd_id IS NULL`) — переенрич |
| 8 | `api_tokens` (токен-авторизація браузерного розширення) |
| 9 | `extension_releases` (дистрибуція бета-версій розширення) |
| 10 | `enrich_failures` (лог провалів енричу для дебагу матчингу) |
| 11 | `enrich_failures.source_url` (URL сторінки магазину для дебагу orphan'ів) |
| 12 | `enrich_failures.review_class`/`review_note`/`reviewed_at` (тріаж провалів) |
| 13 | `checkin_sync_state` (resume-курсор extension check-in sync) |
| 14 | `pubs.city` (NOT NULL DEFAULT 'warszawa'), `user_profiles.city` (nullable), `idx_pubs_city`; багатомісто (#146) |
| 15 | `job_state(key, value)` — дрібний крос-рестарт стан джоб (`daily_status_last_sent`, `untappd_circuit_open_until`, `untappd_profile_http_open_until`) |
| 16 | `checkin_sync_state.profile_total` (INTEGER) — лік чекінів профілю Untappd для `/status` |
| 17 | `api_usage` (денний облік запитів розширення) |
| 18 | `enrich_failures.retired_at` (термінальний стан вирішених провалів; ops-тула `retire-resolved-orphans`) |
| 19 | `beers.google_tried_at` + `google_quota(day, count)` — фолбек на 0 кандидатів (#139): per-beer кулдаун + денний cap |
| 20 | перейменування під нейтрального провайдера: `google_quota` → `web_search_quota`, `beers.google_tried_at` → `beers.web_tried_at` (свап Google CSE → Brave Search) |
| 21 | `match_links.merged_at` — штамп посилання, встановленого merge-ом; ingest перевикористовує його замість створення сироти (#366) |
| 22 | `beers.untappd_id_source` (`search`/`bid`/`curated`/`checkin`) — провенанс лінка + бекфіл наявних пінів у `curated` (#384, див. §нижче) |
| 23 | `enrich_failures.issue_number` — зв'язок рядка з issue, який доти жив лише текстовим суфіксом `→ #N` у `review_note` (незапитуваним, і вже зіпсованим нотатками про перемаршрутизацію). Бекфіл із суфікса; потрібен гейту насичення (#408) |
| 24 | Словник тріажу (#377): перебудова `enrich_failures` — SQLite не змінює `CHECK` на місці. Новий клас `not_a_beer`, `wontfix` → `unidentifiable`, плюс `CHECK (review_class IS NULL OR outcome = 'not_found')`, щоб вердикт на рядку, який ми не змогли навіть запитати, був неможливий і для сирого SQL. Бекфіл під час копіювання (інакше новий `CHECK` відкинув би legacy-рядки): 29 перелічених `beer_id` (мерч/вино/бандли, прочитані поштучно) → `not_a_beer` зі збереженим вердиктом; решта `wontfix` → `NULL` із занулінням `reviewed_at`/`issue_number` і збереженою нотою для аудиту — вердикти, винесені за визначеннями, які ця ж міграція скасовує, не переносяться вперед, а перетріажуються |

---

## 4. User Flows / Commands

> Усі user-facing рядки йдуть через `ctx.t(...)` (i18n: uk/pl/en).
> Мова визначається з `from.language_code` (ru/be → en) і persist'иться у
> `user_profiles.language`; `/lang` дозволяє override.
> Усі команди наразі stateless (без Telegraf scenes).

### `/start` та `/help` — реєстрація + довідник команд
`/start` створює профіль (ключ — `telegram_id`; ідемпотентно) і друкує довідку.
`/help` друкує **той самий** текст — і теж викликає `ensureProfile` (щоб знати
активне місто користувача перед фільтрацією списку), тож більше не є
side-effect-free. Джерело тексту — `buildHelpText` з `src/bot/commands/catalog.ts`:
`COMMAND_CATALOG` (єдиний впорядкований список усіх команд, кожен запис може
нести прапор `cityScoped: true`) + i18n-описи `cmd.*` / `help.intro`. Для
користувача без активного польського міста (`isKnownCity(getUserCity(...))` =
`false`) `buildHelpText` приховує city-scoped команди (`/newbeers`, `/route`,
`/pubs`, `/beers`, `/refresh`) і додає рядок-підказку `help.city_hint` (#399).
Локалізовано (uk/pl/en).

Нативне меню Telegram («/») заповнюється на старті через
`registerCommandMenu` (`src/bot/register-command-menu.ts`): `setMyCommands` для
`uk`/`pl`/`en` + дефолтний англійський scope, з того ж каталогу (`buildCommandMenu`).
Збій `setMyCommands` лише логується (`warn`), старт не падає. На відміну від
`/help`, це меню реєструється глобально per-locale, а не per-user, тож воно
**не фільтрується** — завжди перелічує всі команди, навіть city-scoped, для
будь-якого користувача (#399).

### `/link <username>` — прив'язка Untappd
Приймає bare-username, `untappd.com/user/<u>`, з/без `www`. Валідація у
`parseLinkArgs`. Профіль **має бути публічним** (бот ходить без cookie за
замовчуванням) — інакше скрейпер бачить 0 чекінів. Зберігає
`user_profiles.untappd_username`.

### `/import` — масовий бекфіл історії
Приймає `.csv` / `.json` / `.zip` експорт Untappd (Supporter → Download History),
до **20 MB** (ліміт Telegram `getFile`; великий JSON → запакувати в ZIP).
**Під капотом:** streaming-парсер (`csv-parse` / `stream-json` / `yauzl`),
вставка батчами по **500** у `db.transaction`, живий лічильник прогресу.
Ідемпотентний за `UNIQUE(telegram_id, checkin_id)`. Зчитує
`rating_global` у `beers` (через `upsertBeer`).

### `/newbeers [частина назви паба]` — топ непитого
Топ-**15** цікавих непитих пив, **згруповано по пиву**.
**Під капотом:**
1. для кожного паба беремо latest snapshot → `tapsForSnapshotWithBeer`
   (COALESCE рейтингу: `tap.u_rating` → `beers.rating_global`; COALESCE ABV —
   **навпаки**: `beers.abv` → `tap.abv`, бо tap-ABV з ontap вводиться вручну й
   буває помилковим, тож авторитетний Untappd-ABV переважає);
2. `filterInteresting(taps, drunkSet, user_filters)` — відсів випитого
   (`checkins ∪ untappd_had`) і застосування фільтрів;
3. групування за `match_links.untappd_beer_id` (fallback —
   `(normalized_brewery, normalized_name)`);
4. ранжування: рейтинг ↓ → кількість пабів ↓ → назва ↑;
5. форматування HTML (`newbeers-format.ts`): жирна назва (для пива з реальним
   `untappd_id` — клікабельне посилання `https://untappd.com/beer/<id>`, що
   відкриває застосунок Untappd) + відомий стиль inline (невідомий пропускається)
   + ⭐ рейтинг + ABV-чіп, до 3 пабів + «+N інших».

Без активних style/rating/ABV-фільтрів `/newbeers` може показувати orphan-и без
`untappd_id` (із `⭐ —`), але завжди відкидає порожні ontap-слоти `N/A`. Якщо
активний хоча б один beer-фільтр, показуються лише пива з реальним
`untappd_id`. Маршрут завжди використовує лише пива з реальним `untappd_id`.
Vintage-логіка: збіг ABV із найсвіжішим роком → «пите». З аргументом обмежує
паби за підрядком назви (case-insensitive).

### `/pubs` — алфавітний список пабів
Усі відомі боту паби. Корисно, щоб дізнатися точне написання для аргументу
`/newbeers <назва>` / `/beers <назва>`.

### `/beers <паб>` — персональний стан кранів (аргумент обов'язковий)
Показує **всі** крани одного паба з останнього snapshot без beer-фільтрів і
без відсіву за had-списком. Had-список (`checkins ∪ untappd_had`) використовується
лише для персональної анотації користувача. Формат:
`{№} • {Пивоварня Назва} [• {стиль, якщо відомий}] • {ABV} • {глобальний рейтинг} • {статус}`.
Пріоритет статусу: випите з найсвіжішим не-NULL персональним рейтингом check-in —
`✅ {персональний рейтинг}`; випите без нього — `✅`; невипите з реальним
`beers.untappd_id` — `⭐`; невипитий orphan — `⚪`. Глобальний рейтинг лишається
окремим полем. Для реального `untappd_id` назва — клікабельне посилання
`https://untappd.com/beer/<id>`, що відкриває застосунок Untappd. `N/A`
лишається компактним (`{№} • N/A`) без рейтингів і статусу.
Дизамбіґуація паба: за назвою, потім за адресою; кілька кандидатів → перші 3,
без угадування.

### `/route [N]` — пішохідний маршрут
Будує маршрут, що покриває **≥ N** непитих пив, мінімізуючи сумарну дистанцію.
`N` ← аргумент → `user_filters.default_route_n` → `env.DEFAULT_ROUTE_N` (=5);
**клемпиться до `1..70`** (`clampRouteN`), бо більший N тягне десятки пабів.
**Під капотом (`domain/router.ts`):**
1. `interesting(p)` для кожного паба з останнього snapshot;
2. жадібний **set-cover** ≥ N → `S₀`;
3. **локальна оптимізація** заміною пабів під дистанцію;
4. **тур** (`solveTour`): точний **open-TSP** (Held-Karp за бітмасками) для
   `|S| ≤ 12`, інакше — поліноміальна евристика **nearest-neighbour + 2-opt**
   (Held-Karp `O(2^|S|)` без стелі раніше вибухав на великому N).

Дистанції: кеш `pub_distances` → один OSRM `/table` на пропуски → per-pair
`/route` / **haversine** fallback. Дистанція й кількість пабів завжди в хедері.
**Fire-and-forget** + throttled `editMessageText` (обхід `handlerTimeout` 90 c);
прогрес-повідомлення `/route` і `/refresh`, що були в польоті при graceful
shutdown, помічаються **«⚠️ перервано рестартом»** (реєстр `bot/active-progress.ts`),
а не лишаються застиглими назавжди.
У списку пив кожного паба відомий стиль показується inline після назви;
невідомий стиль пропускається без placeholder-а.
До результату додається inline-кнопка **🗺 Маршрут у Google Maps** —
deep-link пішохідного маршруту через паби в тому ж порядку (origin = перший
паб, destination = останній, проміжні — `waypoints`; для маршруту з одного
паба будується навігація від поточної локації користувача). Проміжних
waypoints не більше 9 (ліміт споживчого Google Maps URL). Тільки Google Maps:
Telegram Bot API не передає ОС клієнта, тож відрізнити iPhone для Apple Maps
неможливо (`domain/maps.ts`).

### `/filters` — інлайн-фільтри
Стейтфул інлайн-клавіатура; кожен тап перемальовує клавіатуру й
повідомлення-зведення (✓ на активних фільтрах).
- **Стилі:** топ-10 канонічних родин, що є на кранах прямо зараз, ∪ активні
  родини користувача (multi-select). Канонізація — `canonicalStyleFamily`
  (`domain/style-family.ts`): нормалізація стилю + упорядкована keyword-таблиця
  правил (IPA/Stout/Porter перед Sour; Gose→Sour; Pils→Lager), fallback — родина
  `Other` (єдина локалізована мітка). Замінила прежню `familyOf`
  (prefix-before-`" - "`), хибну для вільнотекстових мультимовних стилів ontap.pl.
- **ABV:** відкриті порогові пресети `≤3.5%`/`≤5%`/`5%+`/`7%+`/`9%+`
  (single-select, два ряди — кепи / флори); тап по активному очищає. Виставляють
  `user_filters.abv_min/abv_max`. Зведення показує реальний діапазон через
  `formatAbvRange` (вкл. stale-діапазони зі старих закритих смуг).
- **Рейтинг:** пресети `min 3.5`/`min 3.8` (тап по активному очищає).
- **♻️ Скинути все** — очищає всі фільтри.
Поточний стан показано в тілі повідомлення.

### `/lang` — мова інтерфейсу
Інлайн-вибір 🇺🇦/🇵🇱/🇬🇧. Підтвердження редагується вже **новою** мовою.
Persist у `user_profiles.language`.

### `/city` — вибір активного міста
**`/city`.** Inline-клавіатура (`cityKeyboard`, `src/bot/keyboards.ts`) курованих
міст + псевдо-місто «поза Польщею» завжди останньою кнопкою, з локалізованою
міткою (`cityDisplayLabel` → i18n-ключ `city.outside`). Вибір зберігається в
`user_profiles.city`; валідація вибору — `isSelectableCity` (справжнє куроване
місто **або** псевдо-місто `OUTSIDE_CITY` = `'outside-pl'`, #399). `OUTSIDE_CITY`
навмисно відсутній у `CITIES` (той самий масив — список для кроулу
`refreshOntap`), тож псевдо-місто ніколи не потрапляє в crawl і не отримує
власного `pubs.city`.

**Гейт city-scoped команд.** П'ять команд позначені в `COMMAND_CATALOG`
прапором `cityScoped: true`: `/newbeers`, `/route`, `/pubs`, `/beers`,
`/refresh`. Вони фільтрують паби за активним містом користувача (`getUserCity`
→ `listPubs(db, city)`), тож без справжнього польського міста немає що
фільтрувати. Composer `cityGate` (`src/bot/commands/city-gate.ts`), зареєстрований
**першим** у `bot.use(...)` (`src/index.ts`), перехоплює виклик будь-якої з цих
команд і, якщо `isKnownCity(getUserCity(...))` = `false` (користувач на
псевдо-місті або взагалі без вибору), відповідає рядком `city.blocked` замість
запуску обробника. Список city-scoped команд для гейту й фільтр `/help`
(`buildHelpText`) обчислюються з одного й того самого прапора `cityScoped` у
`COMMAND_CATALOG`, тож вони не можуть розійтися. Нативне меню Telegram
лишається глобальним і показує всі команди без фільтрації (див. §4 `/start` та
`/help`).

Усі, хто ніколи не обирав місто — включно з наявними користувачами (стара
`NULL`-семантика) і користувачами, що прийшли лише через розширення — тепер
бачать «поза Польщею» (`OUTSIDE_CITY`), а не Варшаву (#399): показ чужого міста
за замовчуванням був гіршим, ніж показ нічого. Каталог пива, рейтинги,
drunk-статус і розширення/`/match` лишаються глобальними (міста-незалежними).

### `/status` — статус і налаштування користувача

Особиста зведена картка (HTML, локалізована uk/pl/en). Дві секції:

**Налаштування (завжди):** активне місто (локалізована мітка через
`cityDisplayLabel`, `src/bot/city-label.ts` — може бути «поза Польщею», #399),
мова інтерфейсу, короткий однорядковий підсумок фільтрів (стилі / мін. рейтинг
/ ABV / N маршруту), з підказкою `/filters` для редагування.

**Untappd / синхронізація:**
- якщо не прив'язано — підказка `/link` (+ `/import`), без статистики;
- якщо прив'язано — username, `synced` чекінів (із `/ profile_total`, коли
  відомо; ✅ коли `synced ≥ profile_total`), к-сть унікального
  випитого пива, дата останнього чекіна (або підказка `/import` / розширення,
  якщо чекінів немає).

Свідомо НЕ показує жодного обчисленого «треба переімпортувати» — обидва числа
показуються, користувач робить висновок сам. Закриває #147 та #93.

### `/refresh [частина назви паба | me]` — примусове оновлення
Scope залежить від ролі, активного міста й аргументу:

| Виклик | Ontap | Untappd |
|---|---|---|
| admin `/refresh` | усі паби всіх курованих міст | усі профілі |
| admin `/refresh me` | усі паби активного міста | лише admin |
| admin `/refresh <query>` | збіги назви/адреси в усіх містах | усі профілі |
| user `/refresh` | усі паби активного міста | лише цей user |
| user `/refresh <query>` | збіги назви/адреси в активному місті | лише цей user |

`me` — зарезервований exact case-insensitive аргумент після trim лише для admin. Pub-query
використовує ту саму дизамбіґуацію назви й адреси, що `/newbeers`; кілька збігів
оновлюються всі, 0 збігів повертає `pub_not_found` без запуску jobs. Query-refresh
після завершення показує `/newbeers` для точного набору матчених пабів, включно з
cross-city admin-збігами. **Кулдаун:** 5 хв для будь-якого city-wide/global або
all-profile refresh; 30 с лише для non-admin query.
**Fire-and-forget** + throttled `editMessageText` (~раз на 2 c).

### `/extension` — генерація API-токена для браузерного розширення
Генерує per-user Bearer-токен (ротація 1:1: старий токен видаляється,
вставляється новий — усе в транзакції). Відповідає сирим токеном у
`<code>`-блоці (HTML-режим `replyWithHTML`). Зберігається лише sha256-хеш;
сирий токен більше недоступний — перевипустити можна повторним `/extension`.

### HTTP API (браузерне розширення) — Hono, `127.0.0.1:API_PORT`
Вбудований в процес бота read-only HTTP-сервер (`createApiApp` /
`createApiServer` у `src/api/index.ts`). Слухає `127.0.0.1:API_PORT`
(default 3000); доступний зовні через Cloudflare-тунель (§5.9).
CORS: `origin: '*'` (авторизація — Bearer-заголовок, не cookies).

#### Ліміти розміру запитів
Усі HTTP-запити мають глобальний transport-ліміт **4 MiB**. Для тіл окремих
endpoint'ів діють жорсткіші ліміти: `POST /checkins/sync` — **1 MiB**,
`POST /enrich/result` — **512 KiB**, `POST /match` і
`POST /enrich/candidates` — по **256 KiB**. Transport-ліміти рахуються в байтах;
вони застосовуються як до відомого `Content-Length`, так і до фактично прочитаного
потоку.

Окремо schema-валідація обмежує JavaScript-рядки в символах: `html` чекінів —
**768 Ki символів**, enrich-`html` — **384 Ki символів**, `brewery` і `name` —
по **512 символів**, `pageUrl` — **2048 символів**, `maxId` — **512 символів**.
Будь-яке перевищення transport- або character-ліміту повертає точну відповідь
`413 {"error":"payload_too_large"}`. Звичайні помилки схеми, не пов'язані з
розміром, як і раніше повертають `400`. Transport-відмова за оголошеним
`Content-Length` стається до JSON-парсингу. Після будь-якої size-відмови обробник
відповідного route, синхронний domain/HTML-парсинг, нормалізація та мутації бази
даних не запускаються.

Кожен `413` пише warning `api payload too large` з полями `method`, `path`,
`rejectionLayer` (`global`, `route` або `schema`), `limit`, `limitUnit` (`bytes`
або `characters`), `contentLength` (валідне оголошене значення або `null`), `auth`
(`anonymous`, `authenticated` або `invalid`), опційним `telegramId` лише для
автентифікованого запиту та `fieldPath` для schema-відмови. Логи ніколи не містять
сирі токени, Authorization-заголовки, тіло запиту, значення полів чи хеші. Для
глобальної відмови Bearer-токен резолвиться лише для логування: це не змінює
відповідь `413`, не розкриває стан токена клієнту й не додає lookup до звичайних
запитів.

Через тиждень після виходу в production слід переглянути warning-події: кількість
відмов за route, layer і auth-станом; розподіл `contentLength`; повтори за
`telegramId`; легітимні false positive. Для легітимних запитів коригується лише
зачеплений ліміт зі збереженням запасу; якщо false positive немає — ліміт
залишається без змін. Повторний abuse переходить в окремий rate-limit follow-up.

#### `GET /health` — перевірка стану
Відкритий endpoint без авторизації. Відповідь: `{ ok: true }`.

#### `POST /match` — матчинг пив
Авторизація: `Authorization: Bearer <token>` → sha256 → `api_tokens` →
`telegram_id` власника. Невалідний або відсутній токен → `401 { error: "unauthorized" }`.

**Запит** (`Content-Type: application/json`):
```json
{ "beers": [{ "brewery": "string", "name": "string", "abv": 0.0 }] }
```
Масив від 1 до 200 елементів; `abv` — опційний.
Невалідне тіло (порожній `beers`, або `beers` > 200, або відсутні поля) → `400` (zod-валідація через `@hono/zod-validator`).

**Відповідь** (`200 OK`):
```json
{
  "results": [
    {
      "raw": { "brewery": "string", "name": "string" },
      "matched_beer": { "id": 1, "name": "...", "brewery": "...", "rating_global": 4.1 },
      "is_drunk": false,
      "drunk_uncertain": false,
      "user_rating": null
    }
  ]
}
```
`matched_beer: null` — пиво не зматчено в каталозі. `is_drunk` — two-source
drunk-model (`checkins ∪ untappd_had`) для власника токена (§5.2); виставляється
**лише для exact-матчів**. `drunk_uncertain: true` — fuzzy-збіг І пиво в drunk-set
(ймовірно випите, без певності); у розширенні дає бейдж `❓` з глобальним рейтингом (якщо є) і
кліком на Untappd (якщо є). `user_rating` — особиста оцінка з `checkins` (або `null`); лише для
exact-матчів. Серверна помилка → `500 { error: "internal" }`.

**Кеш каталогу (eventual consistency, #277).** `/match` матчить по спільному
процес-рівневому кешу підготовленого каталогу (`catalog-cache.ts`), інвалідованому
монотонним лічильником (`catalog-version.ts`), який бампають записи в каталог — і
storage-мутатори (`upsertBeer`, `recordLookupSuccess`, `mergeIntoCanonical`,
`recordRatingSuccess`), і raw-SQL записи в cron/maintenance-джобах
(`refresh-untappd`, `cleanup-polluted-ontap`, `dedupe-brewery-aliases`). Стратегія —
stale-while-revalidate: після зміни каталогу перезбірка йде у фоні (single-flight),
тож щойно записане пиво може з'явитися в результатах із затримкою до ~2 с (плюс один
запит); є й 5-хв TTL-бекстоп. Контракт запиту/відповіді незмінний.

**Опційна авторизація (#245).** `/match` — єдиний ендпоінт, що приймає **анонімні**
запити. Без заголовка `Authorization` сервер матчить по каталогу й повертає лише
**глобальні** поля (`matched_beer.rating_global`, `matched_beer.untappd_id`); `is_drunk`,
`drunk_uncertain` та `user_rating` завжди false/null. Присутній, але **невалідний** токен
усе одно дає `401` (щоб зіпсований токен лишався діагностованим). Валідний токен повертає
персональний drunk-статус + оцінку, як раніше. Це дозволяє щойно встановленому розширенню
(напр. рев'юеру Chrome Web Store без токена бота) одразу показувати бейджі ⭐/⚪. `/enrich/*`
та `/checkins/*` лишаються тільки-за-токеном.

**Name-keys матчинг (order/collab-aware, #117).** Збіг назв — це перетин **множин
канонічних ключів** (`nameKeys`, `matcher.ts`): назва ріжеться на `COLLAB_SEP`-сторони
(`/`, ` x `, ` & `), кожна нормалізується, зрізається продубльована провідна пивоварня,
сторони з **< 2 токенів** відкидаються (слабкі ключі), решта — сортуються по токенах
(нечутливо до порядку). Це робить exact-стадію `matchPrepared` стійкою до перестановки
слів (`TAP04 Festweisse` ↔ `Festweisse (TAP04)`), колаб-партнера в назві
(`Fast Talking / North Park` ↔ `Fast Talking`) і двомовних назв Untappd
(`Free Tchyně / Free Mother In Law`) — лишаючись настільки ж FP-безпечною, як exact
(рівність множин, не підмножина). Однотокенні назви цілком (`Kanelbullar`) дають порожній
key-set і матчаться fuzzy. `lookupBeer` має ту саму key-стадію (2a) перед
fuzzy (2b); fuzzy-стадія пробує не лише повну нормалізовану назву, а й назву
після зрізу вбудованої пивоварні та кожну `COLLAB_SEP`-сторону після такого ж зрізу,
щоб слабкі однотокенні сторони (`Lièvre / Slake` → `Lièvre`) не губились.
Між exact-key та fuzzy `lookupBeer` має strict-only near-name стадію (#234): для кандидатів,
які вже пройшли **strict** brewery gate, назва може матчитися по токенах нечутливо до порядку,
з невеликою edit-distance похибкою на токен і кандидатними суфіксами (`Tropical Wave` ↔
`TropiCool Wave Oaza Garden`, `Cydr jabłkowy` ↔ `Jabłkowy cydr z Mazowsza`). Для одного
strict-кандидата дозволений останній шанс за спільним довгим токеном (`Lagerbier ...` ↔
`... Lagerbier`). Ця стадія **не застосовується до relaxed brewery pool**, тож relaxed-збіги
досі вимагають exact name.
Пошуковий запит enrich'у будується щаблями `searchQueryLadder` (#382, детальніше нижче) над
спільним конвеєром `buildSearchQuery`, вихід якого на широкому щаблі дорівнює `cleanSearchQuery`
(collab-aware: колапсує `COLLAB_SEP`-роздільники, стрипить `BREWERY_NOISE` incl.
`collab`/`collaboration`, дедуплікує — див. «Дедуп пошукового запиту» нижче); у `lookupBeer`
кожна колаб-частина пивоварні ще й розбивається `brewerySearchParts` ДО виклику, щоб не ANDити
обидві пивоварні.
Запит надсилається до Algolia JSON API (індекс `beer`) через `BeerSearch` — **не скрейпиться
HTML-сторінка Untappd-пошуку**. Webshare rotating proxy — fallback, а не первинний шлях:
Algolia-ключі спочатку використовуються напряму; при 401/403 відбувається авто-оновлення ключів
(`extractAlgoliaKeys` з живої сторінки Untappd) і повторна спроба, і лише якщо ключ не змінився —
ретрай через `WEBSHARE_PROXY`. Докладніше — у підсекції «Джерело Algolia» нижче.

Зрізання провідної пивоварні узагальнено (`stripBreweryFromName`): прибирає **суцільний токен-ран пивоварні
будь-де** в назві (не лише провідний префікс) + обрізає залишкові крайові `BREWERY_NOISE`, але ніколи не
зводить назву до порожньої. Застосовується на вхідній і (без змін) кандидатній сторонах `nameKeys`; спільне
для `/match` та enrich. Частково-префіксні випадки (назва несе повнішу фразу пивоварні, ніж поле — `Cydr
Chyliczki`, `Hoppy Hog Family Brewery`) лишаються незматченими (deferred).

**Split-invariant exact-друга-спроба (#169).** Коли звичайна exact-стадія `matchPrepared`
не дала кандидатів (`exacts.length === 0`), запускається друга спроба, що **не довіряє**
межі brewery/name з адаптера: будується об'єднаний нормалізований заголовок
`normalizeName(brewery + ' ' + name)`, кандидати беруться з first-token індексу за **провідним
токеном** заголовка (`candidatesByFirstToken`), і кандидат приймається як **exact**, коли
якийсь його alias пивоварні є **провідним токен-раном** заголовка (`leadingRun`) **і** залишок
після зрізу цієї пивоварні (`stripBreweryFromName`, сортовані токени) дорівнює канонічній назві
кандидата. Це робить exact-матч стійким до того, де адаптер розрізав пивоварню й назву (усі
розбиття `Pastry Mastery / SCHWARZBROT`, включно з порожнім полем пивоварні, сходяться в один
збіг). Гейт сильніший за звичайний (повна пивоварня присутня + рівність назви), тож тут безпечно
приймати **однотокенні** назви (`schwarzbrot`), які звичайний `nameKeys` відкидає. Спрацьовує
лише на промах — exact-кейси, що працюють зараз, не змінюються; заголовки без токенів пивоварні
взагалі (bare-name крамниці) лишаються fuzzy (окремо, #108). Анкорені рядки проходять ту саму
ABV/vintage-дизамбіґуацію й повертають `source: 'exact'`.

**Гейтинг сильних заяв.** Fuzzy-кандидат відхиляється, якщо нормалізована назва
розходиться з інпутом по контентних токенах (різні смакові варіанти одного базового
пива — fuzzy-покриття токенів, тож відмінки/опечатки лишаються матчем). `is_drunk` і
`user_rating` проставляються **лише для exact-матчів** (key-перетин рахується exact).
Fuzzy-матч дає `matched_beer` (глобальний рейтинг); якщо пиво при цьому є в drunk-set —
`drunk_uncertain: true` (бейдж `❓`, ймовірно випите, без певності); `is_drunk` і
`user_rating` залишаються `false`/`null`.

**Brewery-gate як first-token індекс (продуктивність).** Гейт по пивоварні
(`breweryAliasesMatch`) зводиться до `tokenPrefix` — коротший список токенів має бути
провідним префіксом довшого, отже два аліаси збігаються лише за рівних **перших токенів**.
Тому `PreparedCatalog` будує індекс `перший-токен-аліаса → рядки` (один прохід по каталогу)
і `breweryCandidates(inputAliases)` бере кандидатів з бакета замість лінійного скану всього
каталогу — результат множинно-рівний повному `filter(breweryAliasesMatch)`. `matchPrepared`
рахує цей набір **раз** на вхідне пиво й перевикористовує його для exact-стадії та fuzzy-пулу.
Без індексу батч 166 пив × каталог ~29k робив скан двічі на пиво (~10 с, впирався в таймаут);
з індексом — ~2 с.

Повнокаталожний fuzzy-fallback (порожній бакет пивоварні) обмежений **бюджетом на запит**
(`FULL_FALLBACK_BUDGET`, дефолт 20): кожен такий айтем коштує ~89 мс на ~30k рядків, тож без
ліміту одна «сміттєва» сторінка (200 пив) спалила б ~18 с CPU у спільному event-loop (#279).
Айтеми понад бюджет повертають `matched_beer: null` (лишаються ⚪); бакетований fuzzy не
лімітується. Статистика (`attempts`/`hits`/`budgetSkipped`) логується `info` на кожен `/match`.

**Curated brewery-aliases (#202).** Поверх токен-префіксного гейта `breweryAliases()`
розширює набір аліасів на **один хоп** зі скінченного, вручну-курованого списку пар
нормалізованих форм пивоварень (`src/domain/brewery-aliases.ts`): напр. `nepomucen`↔`nepo`,
`umanpivo`↔`уманьпиво`, `grimbergen`↔`alken maes`, `starkaft`↔`starkraft`. Пари **симетричні й
нетранзитивні**: розширення **hub-aware** — вузол-хаб (≥2 партнери, як `kasteel vanhonsebrouck`)
розкривається в усі свої спиці, але спиця НЕ додає хаб, тож дві спиці не успадковують спільний
аліас хаба й не матчаться між собою (`van honsebrouck` ≠ `bacchus`). Реальний матч завжди має
Untappd-канон (хаб) на одному боці, тож спиця магазину збігається з хабом за власним токеном.
Виняток — явно дозволені typo/rebrand family hubs (`nepo`): їхні спиці можуть спільно додавати
хаб, бо це форми того самого бренду (`nepomucen`, `napomucen`, `nepo`), а не різні бренди.
Розширення лише **ширшає пул кандидатів гейта** — стадія назви (key-перетин / fuzzy ≥0.85 із
`nameTokensDiverge`) усе одно має пройти, тож FP-ризик низький. Жодного загального/fuzzy-матчингу
пивоварень; список росте лише з підтверджених тріажем промахів (див. `docs/debug-orphan-matching.md`).
Обидва місця використання (`matchPrepared`, `lookupBeer`) успадковують розширення через `breweryAliases()`.

**Сила збігу пивоварні (enrich, `lookupBeer`).** Stage-1 розрізняє **strict** (провідний-префікс
`breweryAliasesMatch` — повний шлях назви, включно з fuzzy ≥0.85) та **relaxed** збіг пивоварні:
порожня вхідна пивоварня (#149, гейт оминається) або вхідний аліас як **непровідний** суцільний
токен-підсписок аліаса кандидата (#120, `breweryAliasContained`).  Relaxed-збіг матчиться **лише на
точну назву** — перетин name-keys АБО точна рівність нормалізованих назв — і **ніколи** на
наближений fuzzy (≥0.85, але <1.0). Strict-шлях незмінний. (`/match`-каталог поки не зачеплено.)

**Web-фолбек на 0 кандидатів (#139).** Коли Untappd/Algolia повертає **нуль** кандидатів (справжнє
занулення запиту, а не відхилення реальних кандидатів матчером) — після наявного #271 head-retry —
сервер може резолвити канонічну сторінку пива через **Brave Search API** (запит обмежений
`site:untappd.com`) і перепрогнати цього кандидата через строгий gate. Механізм суто **серверний**
(`lookupWithFallback` обгортає `lookupBeer` у двох точках: cron `enrichOneOrphan` і client-relay
`/enrich/result`), тож браузерне розширення **не змінюється**. Увімкнено лише за наявності
`BRAVE_API_KEY`; без нього — нуль змін поведінки.
- **Gate (refined B1):** strict-збіг пивоварні **обов'язковий завжди**; далі — АБО проходить звичайний
  name-gate (одномовні: переставлені/переспецифіковані назви), АБО є перекриття розрізняльних токенів
  (`hasLongSharedToken`, перевіряється в обох напрямках — fast-fuzzy напрямлений — щоб крос-мовні
  `cynamon`≈`cinnamon` корробурували) **І** ABV у толерансі. ABV сам по собі **ніколи** не достатній
  (інакше пиво тієї ж броварні з іншою назвою хибно лінкувалось би — кейс Artezan «Święty Spokój»).
- **Гідрація ABV:** Brave **не віддає ABV** у відповіді, тож єдине джерело — Algolia-by-name
  (`hydrateAbv`). Наслідок: крос-мовна гілка не спрацьовує для пив, у яких **наш** ABV невідомий.
- **Дедуплікація:** Brave повертає `/photos`-підсторінки з тим самим bid, що й канонічна сторінка →
  парсер лишає перше входження (канонічна сторінка ранжується вище).
- **Захист витрат:** денний cap (`WEB_SEARCH_DAILY_CAP`, дефолт 30) за **UTC-датою**
  (таблиця `web_search_quota(day, count)`, v20), плюс per-beer 30-денний кулдаун
  (`beers.web_tried_at`). Бюджет Brave Free — $5 кредитів на місяць за ціною $5.00/1000 запитів,
  тобто 1000 запитів/місяць; 30/добу обмежує будь-яке 31-денне вікно 930 запитами незалежно від дати
  скидання кредитів. Ліміт 1 req/s дотримується серіалізацією викликів усередині резолвера
  (спільний gate + 8-секундний таймаут запиту, щоб зависання не блокувало чергу).
- **Придатність (метровані виклики, #351):** пиво, чий рядок `enrich_failures` має
  `review_class` з `not_a_beer`/`unidentifiable`/`parser_bug`/`not_on_untappd` **або** непорожній `retired_at`,
  у web-фолбек **не потрапляє взагалі** (`isWebFallbackBlocked`). Перевірка виконується
  **першою** — до кулдауну і до квоти — і є безкоштовною: ані запиту, ані штампа
  `web_tried_at`, щоб після фікса парсера пиво поверталось у чергу наступним тіком крона,
  а не через 30 днів. Безкоштовний Algolia-ретрай для цих класів працює як раніше.
  Правило діє і на client-relay `/enrich/result`, який не проходить через
  `listLookupCandidates` і раніше не фільтрувався навіть за термінальними вердиктами.
- **Спостережуваність (#351):** кожен **витрачений** виклик пише один `info`-рядок
  `web-fallback call` (`beerId`, `brewery`, `name`, `results`, `verdict` =
  `matched`/`rejected`/`no-candidates`/`error`, `matchedBid`, `rejected[]` зі стадією гейта
  `reject:brewery`/`reject:name-token`/`reject:abv` та парою `inputAbv`/`candAbv`).
  Пропуски (`review-class`, `cooldown`, `quota`) — `debug`-рядок `web-fallback skipped`
  з полем `reason`. Логуються лише **оцінені** кандидати: цикл виходить на першому
  прийнятому. Виняток резолвера теж лишає рядок (`verdict: error`) і пробрасується далі —
  інваріант «одна витрачена одиниця = один рядок» тримається без дірок.

**Brand-as-beer-name (#138B).** Якщо кандидат провалює і strict, і relaxed гейт пивоварні, але вхідна
пивоварня (бренд на полиці) є суцільним токен-підсписком **назви пива** кандидата (Untappd веде пиво під
материнською компанією — `Murphy's` → `Heineken Ireland — Murphy's Irish Stout`), він матчиться **лише** на
точний перетин name-keys, порахованих із вхідної назви **без зрізання пивоварні** (`nameKeys(name, '')` — бренд
лишається в ключі). Бренд-в-назві гейт обовʼязковий: без нього дві неповʼязані пивоварні зі спільною назвою
пива матчились би лише за назвою. Ніколи fuzzy; оцінюється після strict/relaxed (реальний збіг пивоварні завжди виграє).

#### `POST /enrich/candidates` / `POST /enrich/result` — client-relay Untappd enrichment

Auth like `/match`. `/enrich/candidates` приймає `{beers:[{brewery,name}]}` (+ опційний
`bid` на кожному пиві, #384 — лише перевіряє суперечність зі збереженим лінком, гейт
далі верифікує), апсертить кожне нове пиво як orphan (`untappd_id` NULL) і повертає
`{candidates:[{brewery,name,eligible,algolia,algoliaNarrow?}]}`, де `eligible` = backoff-due
(`isEligible`) і **не** `not_a_beer`, та (пиво ще orphan **або** — #384 — воно вже лінковане,
але надісланий `bid` суперечить збереженому і той лінк не `curated`/`checkin` — нижче).
`algolia` містить публічні параметри `{appId,searchKey,indexName:"beer",query,hitsPerPage}`;
його `query` будується через `cleanSearchQuery(brewery,name)` і лишається серверним
контрактом. Додатково (#391) відповідь несе опційний `algoliaNarrow` — той самий об'єкт із
**вузькою** сходинкою драбини `searchQueryLadder` (#382); поле присутнє лише коли сходинки
різні (практично — лише для нелатинських назв). Розширення виконує `algoliaNarrow`
**першим** і падає на `algolia` лише коли вузька сходинка повернула **нуль** хітів; після
непорожньої сходинки воно не розширюється ніколи, навіть якщо сервер відповів `not_found`
(ширша сходинка дала б надмножину, яку ті самі стадії матчера щойно відхилили). Бюджет
сторінки (`MAX_SEARCHES_PER_PAGE`) рахує **пошуки**, а не пиво, і тролінг спить між
пошуками; якщо вузька сходинка дала нуль, а бюджету на широку вже немає, пиво не
сабмітиться взагалі — недобігнута драбина не є вердиктом, і порожній payload лише спалив би
слот backoff. Старі збірки поля не знають: вони виконують `algolia` й поводяться як раніше.
Розширення, якщо користувач увімкнув opt-in і дав runtime-дозвіл `untappd.com` + `*.algolia.net`, робить
браузерний `POST https://{appId}-dsn.algolia.net/1/indexes/beer/query` з цими параметрами
та публічними Algolia headers, а потім шле JSON hits у `/enrich/result`.
`/enrich/result` приймає `{brewery,name,algolia,query?,pageUrl?}` (`pageUrl` — опційна URL сторінки магазину,
зберігається як `source_url` в `enrich_failures`), проганяє `parseAlgoliaResponse(algolia)` через
наявний `lookupBeer` pipeline і застосовує спільний `applyLookupOutcome`.
`query` (#391) — сходинка, яку клієнт реально виконав. Сервер перераховує
`searchQueryLadder(brewery,name)` і приймає значення, лише якщо воно збігається з однією зі
сходинок; тоді воно замінює `searchUrls` у результаті `lookupBeer` і потрапляє в
`enrich_failures.search_url`. Будь-яке інше значення ігнорується. Це прибирає давню неправду
релейного шляху: інжектований `search` віддає той самий payload на будь-який запит, тож URL,
які будувала внутрішня драбина `lookupBeer`, описували пошуки, яких ніхто не виконував —
а саме цей стовпець читає orphan-triage як доказ. Legacy `{html}` payload
зберігається як сумісний fallback через `htmlSearch`, але основний relay-контракт — Algolia JSON.
Логіка `applyLookupOutcome`:
matched → `recordLookupSuccess` (bid+рейтинг; UNIQUE-клеш → merge у канонічний рядок),
not_found → `recordLookupNotFound` (backoff++), blocked → НІЧОГО не пише в backoff (блок
ніколи не мутує backoff). Той самий orphan-пул і backoff, що й у серверного enrich-крона —
клієнт лише дозбирює видиме й due.

**Ідентичність за опублікованим bid (#384).** Коли шоп публікує власний Untappd-лінк на
сторінці товару (наразі — лише `flasker`, §6 «Per-site адаптери»), `/enrich/candidates` і `/enrich/result`
додатково приймають `bid` (`/enrich/result` — ще й `bidSlug`+`brand`, потрібні лише
гейту). `/enrich/result` резолвить bid **до** пошукового пайплайна: спершу локальний
каталог (`beers.untappd_id`, UNIQUE-індекс, без Algolia-виклику), при промасі —
batched Algolia hydrate за `objectID` (нижче, `hydrateByBid`). **Єдине вето** гейта
(`resolveByBid`, `src/domain/bid-identity.ts`) — збіг пивоварні (`brand` ⟷
`brewery_name`/`brewery_alias` через `breweryAliases`); розбіжність назви, ABV чи slug
лише логується (`notes`), ніколи не ветує — для `Tomatol Bulgogi` шоп каже
`3,8%`/`Tomatol Bulgogi`, а зв'язаний Untappd-запис — `4,2%`/`Tomatøl:BULDAK BULGOGI`,
і bid все одно правильний.

Провенанс живе в `beers.untappd_id_source` (міграція **v22**: `search`/`bid`/`curated`/
`checkin`). Опублікований bid перезаписує `search`/`bid`/`NULL`, але ніколи `curated` чи
`checkin` (`stampBidProvenance`/`refusesBidOverride`, `src/storage/beers.ts`) — інакше
bid міг би **послабити** ручний пін (#343) чи check-in-based зв'язок. Бекфіл міграції
позначає всі наявні піни (`match_links.reviewed_by_user = 1`) як `curated`: без нього
кожен існуючий пін читався б як NULL = machine-derived = перезаписуваний. Обидва
ендпоінти гейтяться тим самим `refusesBidOverride`: `/enrich/candidates` виставляє
`eligible: true` для розбіжного bid лише коли збережений лінк **не** `curated`/`checkin`
— клієнт шукає тільки `eligible`-рядки (`MAX_SEARCHES_PER_PAGE`-зрізом), тож курований
лінк на практиці ніколи не йде в пошук чи в `/enrich/result`.

Відхилення bid (вето гейта, hydrate-фейл, невідомий bid) провалюється у звичайний
пошуковий пайплайн нижче; рядок, що вже має лінк, повертається з тим самим лінком —
консультація bid ніколи не гірша за її відсутність.

Якщо знайдений bid уже належить іншому рядку каталогу, сирота **зливається** в канонічний
(`mergeIntoCanonical`) і ендпоінт відповідає `{"status":"matched","untappd_id":<bid>}` —
раніше це був `not_found`, через що розширення не показувало бейдж на пиві, яке насправді
є в Untappd (#351). Внутрішній вид результату `merged` за межу API не виходить, тож
контракт розширення незмінний.

**Лог провалів (дебаг).** Обидва канали (крон + client-relay) через `applyLookupOutcome`
upsert'ять рядок у `enrich_failures` (§3.13) на `not_found`/`blocked` — вхід + `search_url`
+ summary кандидатів, self-cleared на `matched`. Це робить орфани дебажними без ручного
відтворення/прикладання HTML до ішьюзу (бо Untappd-пошук відтворюється без кукі — досить
`search_url`). Backoff це НЕ зачіпає: `blocked` пише лише debug-рядок, не `untappd_lookup_*`.

**Дедуп пошукового запиту (#126).** Запит Untappd-пошуку будується через `buildSearchQuery`
(спільний конвеєр обох щаблів драбини #382; `cleanSearchQuery(brewery, name)` — його широкий
щабель, і той самий шлях, яким продакшн будує запит для relay/probes):
зчищає об'єднаний рядок `brewery + name` — зрізає легальні форми пивоварні (`Sp. z o.o.`), викидає
`BREWERY_NOISE` і **дедуплікує** повторені токени (за згорткою: lowercase + зняття діакритики + не-alphanumeric),
лишаючи решту в оригінальній формі; очищений fallback описано нижче. Без цього назва, що
повторює пивоварню (`Track Brewing Company Taking Shape` + `Track Brewing Co.`), AND-шукала б
здубльовані терміни і не повертала кандидатів.

Крім дедупу, `cleanSearchQuery` спершу пропускає об'єднаний рядок через `stripSearchNoise`
(#236): викидає групи `[...]`, описові `(...)` (adjunct-списки, `(collab …)`,
batch/vintage), поодинокі «звисаючі» дужки та ABV/spec-рядки (`<0,5%`, `4.5%`,
`24°`, мітки `alc/abv/ibu`); компактні ідентифікатори без пробілів, що містять
хоча б одну цифру (`(TAP04)`), зберігає, а літерні групи (`(BBA)`) видаляє.
Причина — серверний пошук іде в Algolia, який AND-ить усі терміни: будь-який шумовий термін,
відсутній у записі пива, обнуляє видачу. Описовий хвіст ВИКИДАЄТЬСЯ, бо його терміни
текстово не збігаються з каталогом. Фолбек спершу бере очищену назву, потім очищену
броварню; сиру назву використовує лише як останній non-empty fallback, якщо очистка видалила
все і жодна очищена броварня не залишилася.
Поза обсягом (#236): «голий» комо/`#N` adjunct-хвіст без дужок (напр. `Owocowa Fantazja #1 - …, …`) —
ризик вкоротити легітимні назви, лишено як окремий follow-up.

**Токенне очищення запиту (#295).** Після `stripSearchNoise` `cleanSearchQuery` додатково
проганяє броварню й назву через `stripQueryTokenNoise` — **тільки для запиту**, не для
`normalizeName` (див. нижче #269): (1) видаляє крапку, якщо вона не між двома цифрами
(`Vol.` → `Vol`, `V.S.O.J.` → `VSOJ`, але `3.0` зберігається) — саме видалення, не заміна
пробілом, бо Algolia обнуляє `V S O J`, зате знаходить `VSOJ`, а «склеєний» запис Untappd
(`Vol.30`) матчиться лише коли запит скидає крапку; (2) зрізає «голий» рік-вінтаж (`19xx/20xx`),
бо Algolia AND-ить терміни, а Untappd тримає вінтажі в дужках — сам матчер уже трактує рік як
не-ідентичність (`isNumericNoise`/`extractYear`). Обидва правила **не** в `stripSearchNoise`
навмисно: інакше каталоговий `Vol.30` нормалізувався б у `vol30` замість `vol` і впав би нижче
fuzzy-порогу.

**Односимвольні токени в запиті (#350).** `cleanSearchQuery` викидає токени, чий fold має
довжину < 2 — і з броварні, і з назви (правило поглинає давніший дроп collab-конектора `x`).
Причина емпірична: Algolia **не матчить** односимвольний токен, тож він AND-ить увесь запит у
нуль, хоча решта слів індексована — `Elch Brau n Helles` → 0 хітів, тоді як
`Elch Brau Pork Helles` і `Elch Brau Roll Helles` обидва повертають ціль `Pork'N'Roll Helles`.
Name-стадія такі токени вже ігнорує (`nameTokens` у `untappd-lookup.ts` тримає лише `length >= 2`),
тож правило прибирає асиметрію «запит ↔ нормалізація назви» і може лише **розширити** пул
кандидатів, не звузити. Fallback на порожній запит лишається чинним.
Від #382 цей гейт **script-aware** на вузькому щаблі драбини (нижче): довжину рахує
unicode-згортка (`\p{L}\p{N}`), тож кириличний токен вимірює свою справжню довжину,
а не нуль.

**Ремонт гомогліфів (#382).** `repairHomoglyphs()` перед будь-якою нормалізацією
лагодить токени, у яких намішані **обидва** скрипти — латиниця й кирилиця. Два
правила з пріоритетом латиниці: якщо всі кириличні символи токена мають латинський
гомогліф — мапимо в латиницю (`NEІРА` → `NEIPA`, `Сhristmas` → `Christmas`,
`Companу` → `Company`); інакше, якщо всі латинські мають кириличний — мапимо в
кирилицю (`Свiтле` → `Світле`, `Проскурiвське`); інакше токен недоторканий
(`BeerЛога`, `Hellь`, `Mozaїка`). Латиниця йде першою не як tie-break: `NEІРА` має
кириличну більшість (3 проти 2), тож правило більшості дало б `НЕІРА`. Мапа тримає
лише візуально тотожні пари; малі `к м т в н` свідомо виключені — інакше `CowКава`
зіпсувалася б у `CowKaba`. Односкриптовий токен НІКОЛИ не транслітерується — це
окрема задача (#320). Ремонт застосовано у `baseNormalize` (тобто в `normalizeName`,
`normalizeBrewery`, ключах назви, fuzzy-цілях і brewery-гейті) і в будівнику запиту,
причому симетрично до входу й до кандидата. Без нього Algolia знаходить правильне
пиво, а матчер його відкидає: `Belgian Сhristmas Ale` ніколи не дорівнює
`Belgian Christmas Ale`.

**Драбина пошукового запиту (#382).** `searchQueryLadder(brewery, name)` повертає
щаблі від вузького до широкого. Обидва проходять той самий конвеєр
(`buildSearchQuery`) і різняться лише згорткою для утримання/дедупу/echo-strip:
вузький щабель бере unicode-згортку (`\p{L}\p{N}`) і тому **зберігає кириличні
токени**, широкий — це рівно `cleanSearchQuery` з ASCII-згорткою. Коли згортки
збігаються (будь-який суто латинський вхід), щабель один — латинська більшість
каталогу не платить нічого. `lookupBeer` іде щаблями і **розширюється лише при нулі
результатів**: щабель, що повернув кандидатів, ніколи не покидається. Це і є
гарантія відсутності регресій — множина термінів вузького щабля є надмножиною
широкого, отже його результати є підмножиною; при нулі ми бачимо рівно те, що
бачили б без драбини. Причина: ASCII-згортка `foldToken` перетворює будь-який
нелатинський токен на `''`, і гейт #350 його викидав, лишаючи голе стильове слово
(`Ципа / Сидр Грушевий PERRY` → `PERRY`). Вузький щабель заодно лікує сліпоту
`brandFolds` на кирилиці (дедуп і echo-strip #126/#155). Relay-шлях
(`/enrich/candidates`) драбини НЕ має — там сервер віддає один готовий запит;
винесено в #391.

**Спільне очищення структурного шуму (#269).** `normalizeName()` перед базовою
нормалізацією застосовує той самий `stripSearchNoise()`, що й
`cleanSearchQuery()`: прибирає `[...]`, описові `(...)`, випадкові дужки,
ABV/°/alc/abv/ibu, лапки та кінцеву пунктуацію. Компактні
ідентифікатори без пробілів, що містять хоча б одну цифру (наприклад,
`(TAP04)`), зберігаються; літерні групи на кшталт `(BBA)` видаляються.
Правило симетрично застосовується до вхідної й каталогової назви, тому кандидат,
знайдений очищеним Algolia-запитом, не відхиляється exact/name-key/fuzzy етапом
лише через цей шум.

#### Джерело Algolia (серверний пошук Untappd)

Після міграції (Phase 1) серверний enrich більше не скрейпить HTML-сторінку Untappd-пошуку.
Натомість використовується публічний Algolia JSON API.

**Endpoint:**
```
POST https://{appId}-dsn.algolia.net/1/indexes/beer/query
Headers: X-Algolia-Application-Id: {appId}
         X-Algolia-API-Key: {searchKey}
Body:    {"query": "<query>", "hitsPerPage": 5}
```
`appId` і `searchKey` — публічні клієнтські ключі (задокументовані дефолти в коді: `9WBO4RQ3HO` /
`1d347324…`), перевизначаються через опційні env-змінні `UNTAPPD_ALGOLIA_APP_ID` /
`UNTAPPD_ALGOLIA_SEARCH_KEY`.

**`hydrateByBid` (#384) — batched get-by-id.** Другий Algolia-запит, окремий від пошуку:
Untappd індексує `objectID === bid`, тож пряме отримання записів за bid — це один
batched-виклик до multi-get, а не N окремих пошуків.
```
POST https://{appId}-dsn.algolia.net/1/indexes/*/objects
Body: {"requests": [{"indexName": "beer", "objectID": "<bid>"}, …]}
```
Результати позиційно вирівняні із запитом; невідомий `objectID` повертається `null`.
Той самий `withRecovery` (key auto-refresh → proxy fallback), що й у `search`. Викликається
лише з `resolveByBid` на промасі в локальному каталозі (вище, `POST /enrich/result`).

**Класифікація відповіді:**
| Результат | Умова | Мутує backoff? |
|-----------|-------|---------------|
| Кандидати | HTTP 200 + непорожні `hits` | — |
| `not_found` | HTTP 200 + порожні `hits` | ✅ так (genuine) |
| `blocked` | HTTP 401 або 403 | ❌ ні |
| `transient` | 5xx або мережева помилка | ❌ ні |

**Авто-оновлення ключів (key auto-refresh).** При `blocked` (401/403) сервер завантажує живу
HTML-сторінку пошуку Untappd, витягує актуальні Algolia-ключі (`extractAlgoliaKeys`), і якщо
ключ змінився — повторює запит напряму. Лише якщо ключ не змінився — ретрай через
`WEBSHARE_PROXY` (проксі є fallback, а не первинний шлях).

**Canary-heartbeat в `enrich-orphans`.** Перед обробкою orphan'ів виконується один пошук
відомого пива (`Guinness Draught`). Якщо відповідь порожня або кидає виняток — запуск
**переривається** без торкання backoff будь-якого orphan'а, записує `{ok:false}` у
`job_state.untappd_search_canary`, трипить спільний circuit breaker (рахується як block) і
одноразово сповіщає адміна. При успіху записує `{ok:true}`.

**Інтерфейс `BeerSearch`:**
```ts
interface BeerSearch {
  search(query: string): Promise<SearchResult[]>;
  // #384: опційний — лише createAlgoliaSearch його реалізує; htmlSearch (relay) не має
  // batched get-by-id, тож local-catalog miss без hydrate одразу відхиляється.
  hydrateByBid?(bids: number[]): Promise<Map<number, HydratedBeer>>;
}
```
Реалізації: `createAlgoliaSearch` (серверний path, `src/sources/untappd/algolia.ts`) і
`htmlSearch` (relay-адаптер, `src/sources/untappd/search.ts`). `lookupBeer` приймає
`BeerSearch` ін'єктовано — транспорт відокремлено від matching-логіки.

#### `GET /checkins/sync/state` / `POST /checkins/sync` — client-relay extension check-in sync

Auth like `/match` (per-user Bearer-токен → `telegram_id`). Другий канал запису в `checkins`
(поряд з `/import`): браузерне розширення гортає стрічку чекінів **прив'язаного** користувача
(`user_profiles.untappd_username`) у його власній Untappd-сесії і релеїть HTML-сторінки на сервер.
**`/link` — жорстка передумова**; без прив'язаного username обидва ендпоінти повертають
`409 { error: "not_linked" }`. Скрейпиться завжди стрічка прив'язаного username (хто залогінений
у браузері — байдуже). Робиться у сесії користувача (а не серверним кукі), щоб **розподілити
навантаження** на його квоту й не наражатися на бан (пор. §3.7, #72/#89).

`GET /checkins/sync/state` повертає `{ username, deepest_max_id, complete, serverCount, profileTotal }`
(`profileTotal` — підказка прогресу, не жорсткий гейт), щоб клієнт знав, з якого курсора
відновлювати Phase 2 і яку стрічку гортати.

`POST /checkins/sync` приймає `{ html, maxId? }` (обрізана клієнтом сторінка стрічки + курсор,
що її породив). Сервер: детектить блок-сторінку (спільний `block.ts`) → `502 { error: "blocked" }`
(курсор не чіпає); парсить `parseCheckinFeedPage(html)`; на кожен чекін `upsertBeer` за **bid**
(канонічний `untappd_id` — без fuzzy, попутно резолвить orphan'и) → локальний `beers.id`, далі
`mergeCheckin` (ідемпотентно за `UNIQUE(telegram_id, checkin_id)`); просуває `checkin_sync_state`
(§3.14; `complete` при відсутності `nextMaxId`). Повертає `{ merged, alreadyKnown, pageSize,
nextMaxId, profileTotal, serverCount, complete }`.

**Пагінація (клієнт).** Сторінка 1 — повна сторінка профілю `untappd.com/user/<name>`; кожна
наступна (старіша) сторінка — XHR-фрагмент `GET /profile/more_feed/<name>/<offset>?v2=true`
(`offset` = найстаріший `checkin_id` попередньої сторінки), з заголовком `X-Requested-With:
XMLHttpRequest` (без нього Untappd 307-редіректить на `/home`). ⚠️ `?max_id=` на сторінці профілю
**ігнорується** (завжди віддає найновішу сторінку) — НЕ використовувати. `nextMaxId` = найстаріший
`checkin_id` сторінки (фрагмент не має кнопки Show More), тож дно = сторінка з 0 чекінів.

**Stop-логіка (клієнт).** Зупинка: повністю відома сторінка (`alreadyKnown === pageSize`), дно
стрічки (`nextMaxId === null` / 0 чекінів), або жорсткий cap (~200 сторінок/прогін). Two-phase:
Phase 1 (top-up) з «зараз», Phase 2 (deep extend) з збереженого `deepest_max_id` — повторні «Sync»
поглиблюють покриття. Деталі — §6 і `docs/extension-install-uk.md`.

#### `POST /admin/enrich-failures/review` — тріажна розмітка провалу

Авторизація: `Authorization: Bearer <ADMIN_API_TOKEN>` — окремий адмін-токен на
маршрутах `/admin/*` (не per-user токен з `api_tokens`); constant-time порівняння
(захист від timing-атак). Якщо `ADMIN_API_TOKEN` не задано в `.env` — ендпоінт
повертає `503 { error: "admin disabled" }`.

**Запит** (`Content-Type: application/json`):
```json
{ "beer_id": 123, "review_class": "parser_bug", "note": "optional note" }
```
`beer_id` — обов'язкове; `review_class` — один з: `parser_bug`, `matcher_bug`,
`not_on_untappd`, `unidentifiable`, `not_a_beer`; `note` — опційний рядок. `not_on_untappd` цей роут ствердити не може (`422 refused_unproved_absence`) — доказ відсутності дає лише проба.

**Відповіді:** `200 { status: "reviewed", beer_id, review_class }` — розмітка збережена; `400` — невалідний або
відсутній `review_class`; `401` — токен невалідний або відсутній;
`404` — `beer_id` не знайдено в `enrich_failures`; `503` — `ADMIN_API_TOKEN` не задано.

Повторний `recordEnrichFailure` на тому самому пиві скидає `review_class`/`review_note`/
`reviewed_at` до `NULL` **лише коли `candidates_count` перетинає межу `0 ↔ >0`** — тоді рядок
знову з'являється в тріажі; інакше класифікація зберігається (§3.13).

### Фонові джоби (node-cron, у процесі)
| Джоба | Розклад | Призначення |
|-------|---------|-------------|
| `refreshOntap` | `0 */12 * * *` | обхід ontap.pl → tap-exclusion gate → snapshots → match |
| `refreshAllUntappd` | `0 3 * * *` | скрейп профілів → checkins/untappd_had (лише якщо є cookie) |
| `enrichOrphans` | `30 */3 * * *` | lookup orphan-beers у Untappd (LIMIT 20/запуск, сумарно на on-tap + relay пули, див. «Два пули кандидатів, один бюджет (#368)» нижче) |
| `refreshTapRatings` | `30 1,4,7,10,13,16,19,22 * * *` | дотягування рейтингів кранів (offset 1 год від enrich) |
| `cleanupOldSnapshots` | `0 5 * * *` | видалення `tap_snapshots` старших за `SNAPSHOT_RETENTION_DAYS` (default 14); latest-per-pub завжди зберігається |
| `dailyStatus` | `*/15 * * * *` | health-дайджест адміну. UTC-тік; джоба сама шле раз на варшавську добу у вікні `[09:00, 12:00)` Europe/Warsaw, ідемпотентно за `job_state.daily_status_last_sent` (лише якщо є `ADMIN_TELEGRAM_ID`). Раніше `0 9 * * * {tz}` — timezone-тік node-cron виявився ненадійним. Дайджест включає секцію **Enrich**: `enrichMatched24h` зматчених orphan'ів, `enrichFailures24h` провалів, індикатор здоров'я Untappd-пошуку (`untappdSearchHealthy` = останній canary ok І breaker не відкритий). Рядок «Каталог» також несе `orphansOffCron` («N поза cron») — orphan'и без рядка в `match_links`, за винятком `not_a_beer`/`retired`, тобто розмір черги relay-дренажу (#368). Рядок «Розширення /match (вчора)»: усього запитів, з них анонімних, і сума пив за **останню повну варшавську добу** (з таблиці `api_usage`, §3.15). Нулі показуються, якщо трафіку не було. Рядок **«Печатки»** (#377, одразу після рядка тріажу — спершу сьогоднішній прогін, потім накопичений стан): `N unidentifiable (M переспостережено)` — `M` рахує рядки, у яких `beers.untappd_lookup_at > enrich_failures.reviewed_at`, тобто чи крон реально до них доходить; **`M = 0` означає, що механізм досяжності мертвий**, а високе `M` при незмінному `N` — що він крутиться намарно (порахувати *зняті* печатки неможливо: авто-розпечатувач занулює і `review_class`, і `reviewed_at`). Далі `P not_a_beer (+Q/7д)` — борг фільтра інжесту, і `R спростованих retire` — рядки з `retired_at`, чиє пиво досі orphan, тобто твердження «фікс це вирішив», спростоване самим існуванням рядка |

Командний запуск `refreshAllUntappd` може фільтрувати профілі за Telegram ID;
cron-запуск лишається нефільтрованим і оновлює всі прив'язані профілі.

**Startup-джоби** (`src/index.ts`, до launch): `dedupeBreweryAliases`
(злиття дублів каталогу), `cleanupPollutedOntap` (чистка «брудних» назв) і
`cleanupOldSnapshots` (прунінг старих snapshot'ів — той самий код, що й
щоденний крон) — усі ідемпотентні (no-op на чистій БД).
Додатково після `bot.launch()` один раз викликається `dailyStatus` (catch-up:
якщо бот був недоступний о 09:00, але піднявся в межах ранкового вікна — дайджест
виходить одразу; ідемпотентний за `job_state`).

**Два пули кандидатів, один бюджет (#368).** `enrichOrphans` добирає кандидатів із двох
диз'юнктних пулів. **On-tap пул** (`listLookupCandidates`) — orphan'и, чий `beer_id` є на
останньому снапшоті хоча б одного паба (`match_links → taps → tap_snapshots`). **Relay-пул**
(`listRelayLookupCandidates`) — orphan'и, у яких рядка в `match_links` немає взагалі: їх
намінтив `/enrich/candidates` (`ensureBeerRow` біжить по кожній картці сторінки крамниці),
а лінки пише лише on-tap ingest, тож on-tap join виключав їх **структурно**, а не через
схід із кранів (на 2026-08-08 це 846 із 1427 orphan'ів, 532 з них не шукані жодного разу).
Предикати взаємовиключні (`NOT EXISTS(ml)` ⇒ `¬EXISTS(ml→taps→latest)`), тож пули не
перетинаються і дедупу не потребують — але вони не покривають усіх orphan'ів: orphan із
рядком у `match_links`, чий кран зійшов з останнього снапшоту, не потрапляє в жоден пул
(387 рядків станом на 2026-08-08) і лишається cron-недосяжним, поки не повернеться на
кран. Це навмисне виключення — on-tap gate свідомо ігнорує пиво, яке зараз ніхто не
наливає, — а не дефект; `orphansOffCron` міряє саме чергу relay-дренажу, а не сумарну
cron-недосяжність. `LIMIT 20` — **сумарний** бюджет запуску: on-tap вичерпується першим і не може
бути витіснений, relay добирає лише невикористані слоти (до зміни простоювало ~89%
місткості: 17 lookup/добу зі 160). Обидва пули однаково виключають
`review_class = 'not_a_beer'` і `retired_at IS NOT NULL` і однаково фільтруються backoff'ом.
Спільна трьохклаузна умова живе в експортованій константі
`orphanWithoutMatchLinkPredicate` (`src/storage/beers.ts`) і переюзається лічильником
`orphansOffCron` у дайджесті — щоб пул і лічильник не розійшлись.

**Багатомісто (#146).** `refreshOntap` проходить по курованому списку міст
(`src/domain/cities.ts`, `CITIES`) — для кожного `GET https://ontap.pl/<slug>`,
парсить індекс (`parseOntapCityIndex`, спільний DOM) і проставляє паба `pubs.city =
<slug>`. Невдале завантаження індексу міста логується й пропускається (інші міста
скрейпляться далі). Псевдо-місто `OUTSIDE_CITY` (`'outside-pl'`, #399) навмисно
відсутнє в `CITIES`, тож `refreshOntap` ніколи його не бачить і не намагається
зробити для нього `GET https://ontap.pl/outside-pl`. Інлайн-енрич свіжих орфанів
обмежений **бюджетом на запуск** (`inlineEnrichBudget`, дефолт 20) — решта
добирається rate-limited `enrich-orphans` кроном (захист від Untappd-бану).
schema_version **14** додає `pubs.city` (`NOT NULL DEFAULT 'warszawa'`) та
`user_profiles.city` (nullable; `NULL` або невідомий slug → `OUTSIDE_CITY`, #399).

**Підготовка каталогу раз на запуск (#278).** `refreshOntap` готує prepared-каталог
**один раз на запуск** чанк-білдером із поступкою event-loop (`prepareCatalogChunked`),
а не заново на кожен паб. Свіжі orphan'и, створені під час запуску, інкрементально
додаються в пам'ять (`PreparedCatalog.add`), тож наступні паби матчаться на них
(exact/bucket-шлях) без дубль-вставки; memoized full-searcher при цьому НЕ перебудовується
(свіжий orphan завжди досяжний через власний бакет пивоварні). Прибирає ~114×1.3 с
синхронних блокувань event-loop на запуск. Startup-джоба `cleanupPollutedOntap` використовує
той самий чанк-білд (одноразовий, без інкрементального add).

**Untappd circuit breakers (persistent via `job_state`).** VPS-originated
Untappd-звернення гейтяться **двома незалежними** circuit breaker'ами за різними
транспортами (які блокуються з різних причин, #298), тож блок одного шляху не
спиняє інший:
- **Algolia-пошук** (ключ `job_state.untappd_circuit_open_until`) гейтить
  `refreshOntap` inline enrich та `enrichOrphans` — шлях Untappd beer-search через
  Algolia. `stats.untappdSearchHealthy` читає саме цей ключ.
- **HTML-скрейп** (ключ `job_state.untappd_profile_http_open_until`) гейтить
  `refreshTapRatings` (сторінки пива) та `refreshAllUntappd` (had-list профілю) —
  HTML через WebShare/cookie'd-сесію.

Сигнали блокування — HTTP 403/429 **або** captcha/login-сторінка (Cloudflare-маркери).
При блокуванні відповідний breaker відкривається на 6 год (потім half-open probe) і
пише absolute ISO timestamp у свій `*_open_until` ключ; його jobs у цей час
пропускаються навіть після restart/deploy, тоді як другий breaker працює далі. Ontap
scraping продовжується, але без inline enrich, коли відкритий Algolia-breaker. Алерти
адміну лише на переходах: trip (`closed→open`) і recovery (`open→closed`), з міткою
шляху («Untappd Algolia» / «Untappd профіль-скрейп»); restart під час активного
`open_until` не шле повторний trip alert. `CookieExpiredError` у `refreshAllUntappd`
лишається окремим session/cookie шляхом і сам по собі не є IP-ban сигналом.
Browser/extension relay не гейтиться цими breaker-ами: блок у браузері користувача не
впливає на VPS cooldown.

---

## 5. Constraints & Rules

> Жорсткі правила розробки. Порушення = блокер на ревʼю.

### 5.1 Процес (Superpowers, з CLAUDE.md)
- **Кожна фіча проходить повний цикл:** brainstorming → spec → plan → worktree.
  Жодних рішень по реалізації без письмового spec.
- **Workflow** автономний: brainstorming → writing-plans → worktrees.
- Артефакти spec/plan живуть у `docs/superpowers/{specs,plans}/<date>-<slug>.md`.

### 5.2 Бізнес-інваріанти (не порушувати)
- **Two-source drunk model.** Пиво «випите», якщо воно в **`checkins` АБО
  `untappd_had`**. Єдиний хелпер-об'єднання — `triedBeerIds`
  (`src/storage/untappd_had.ts`). Читати лише `checkins` — баг.
- **Реальний статус матчингу** = `beers.untappd_id IS NOT NULL`,
  **не** наявність `match_links`. `match_links.untappd_beer_id` — локальний
  `beers.id`, заповнений і для orphan'ів.
- **Ontap tap-exclusion gate.** `refreshOntap` ПОВИНЕН відкидати **до** створення
  snapshot/tap рядків: (а) очевидні не-пивні крани
  (wine/prosecco/frizzante/spritz/cocktails/nalewka/szprycer/kombucha, brewery_ref-сміття
  парсера — schedule/nav рядки на кшталт `-> … od 18.00`) і (б) крамничні плейсхолдери
  «нема в наливі» (`chwilowy brak`, `wypite`, `kran w serwisie`, `czeka na lepsze czasy`).
  Сигнали (а) — `taps.style` і `taps.brewery_ref`; сигнал (б) — **підрядок** у `beer_ref`
  АБО `brewery_ref` із курованого списку фраз (`Guinness Chwilowy brak:(` — це «Guinness
  закінчився», а не пиво). Курований список фраз — єдиний дозволений substring-фільтр;
  регексп-евристик і fuzzy тут немає, щоб не провокувати широкі Untappd-запити на кшталт
  `wino`/`merlot`. Cider, kvass/`Kwas chlebowy`/`квас` і mead/melomel лишаються eligible.
- **Ontap identity policy (#306).** Шар ontap-ідентичності (`sources/ontap/identity.ts`)
  НЕ МАЄ права викидати кран за формою рядка: єдина причина дропу — **порожня назва**
  після очистки. Назва, що дорівнює бренду броварні (`Guinness / Guinness`), проходить
  далі; сміттєве значення `brewery_ref` (локація, список інгредієнтів, лише пунктуація)
  **обнуляє поле броварні**, а не викидає пиво. Причина: дроп невидимий (нема ані рядка
  каталогу, ані orphan-а), orphan — видимий і пінований (#343/#361). Кожен відкинутий кран
  ПОВИНЕН потрапляти в лічильник за причиною (`ontap taps discarded`).
- **°Plato-градус — частина назви.** Трейлінг `12°` у CZ/PL-лістингах зберігається у
  `beers.name` (`Konrad 10°` ≠ `Konrad 12°`); ріжеться ABV-хвіст, а разом з ним — стильова
  мітка одразу після spec-блоку, якщо вона є (`Oxymel 14°·4,5% — Sour Ale` → `Oxymel 14°`,
  так само, як робив старий парсер). Пошук працює в обидві сторони:
  `cleanSearchQuery`/`normalizeName` градус прибирають, а стадія czech-grade (#321) читає
  його з сирої назви через `extractGrade`.
- **Ідентичність, здобута merge-ом, переживає повторний інжест, але поступається матчеру
  (#366).** `merged_at` ставить лише `mergeIntoCanonical`; будь-який запис матчера
  (`upsertMatch`) його скидає. Довіряти штампу лише поки ціль існує і має `beers.untappd_id` —
  інакше кран іде звичайним шляхом і стає сиротою. `mergeIntoCanonical` ПОВИНЕН перед
  видаленням сироти переспрямувати не лише `match_links`, а й `checkins` (немає ON DELETE
  CASCADE при `foreign_keys=ON`).
- **Голий бренд — тільки exact.** Якщо `normalizeName(name)` дорівнює нормалізованому
  бренду броварні, `matchPrepared` НЕ МАЄ права падати у fuzzy-fallback: краще orphan,
  ніж довільний продукт цієї броварні з чужим рейтингом і статусом «випите».
- `/newbeers` без beer-фільтрів може показувати orphan-и, але завжди відкидає
  порожні `N/A`; з активним style/rating/ABV-фільтром показує лише пива з
  реальним `untappd_id`. Маршрут завжди відкидає orphan-и.
- `/beers` — навпаки, показує **все сире** без фільтрів і ніколи не відсіює за
  had-списком, але використовує його для персональної анотації (діагностика).
- Маршрут — **open-TSP без жорстких лімітів**; дистанцію завжди показувати явно.
- **Блок ≠ not_found.** Виявлений блок Untappd (403/429/captcha) **ніколи** не
  записується як `not_found`/`transient` і не змінює backoff-стан beer'а — він
  лише трипить circuit breaker. Інакше captcha-вікно тихо «ховає» реальні пива.

### 5.3 Тестування (CLAUDE.md)
- **Кожен новий модуль логіки покривається базовими Vitest-тестами перед злиттям.**
- `domain/*` — повне unit-покриття (чисті функції).
- `sources/*` — **контрактні тести на фікстурах** (`tests/fixtures/**`,
  HTML/CSV-снепшоти), що падають при зміні верстки джерела.
- Handler-логіку виносити в чисті `*-build`/`*-format` і тестувати окремо.

### 5.4 Обробка помилок і стійкість
- Глобальний `bot.catch` логує `{ err, update }` під тегом `bot error`;
  жоден handler не повинен «ронити» процес.
- **Fire-and-forget** для будь-якого handler'а, що чекає на довгу зовнішню
  роботу (refresh, route): миттєва відповідь + захоплені `ctx.telegram`/`chatId`/
  `messageId` + throttled `editMessageText`. Обхід `handlerTimeout = 90 с`.
- Зовнішні падіння — **graceful fallback**, не краш: OSRM → haversine;
  приватний Untappd-профіль → повідомлення + файловий експорт; зміна HTML →
  ловлять контрактні тести.
- **Graceful shutdown** (`createShutdown`): SIGINT/SIGTERM → стоп cron → стоп бот
  → зупинка HTTP-сервера → закриття БД → `process.exit(0)`, щоб не SIGKILL'нутись
  на чистому WAL-flush. HTTP-крок пропускається, якщо `httpServer` не передано.

### 5.5 Логування
- Виключно **`pino`** (структуровані JSON-рядки → stdout → journald).
- Рівень з `env.LOG_LEVEL` (`trace|debug|info|warn|error`, default `info`).
- Помилки джоб логуються з тегом-контекстом (`'ontap cron'`, `'enrich-orphans cron'`…).
- На хості: `sudo journalctl -u warsaw-beer-bot -f`.

### 5.6 Конфігурація і секрети
- **Усі ключі доступу читаються з `.env`** (CLAUDE.md), валідація `zod` у
  `config/env.ts`, читання **один раз** у composition root.
- Обовʼязкові: `TELEGRAM_BOT_TOKEN`, `DATABASE_PATH`, `OSRM_BASE_URL`,
  `NOMINATIM_USER_AGENT`. Опційні: `LOG_LEVEL`, `DEFAULT_ROUTE_N` (=5),
  `API_PORT` (=3000), `UNTAPPD_LOOKUP_ENABLED` (=true), `UNTAPPD_SESSION_COOKIE`,
  `ADMIN_TELEGRAM_ID`, `ADMIN_API_TOKEN` (Bearer-токен для `/admin/*`; якщо не задано —
  адмін-ендпоінти повертають `503`), `WEBSHARE_PROXY` (рядок підключення
  `user:pass@host:port` Webshare rotating-residential proxy; маршрутизує серверний
  Untappd-трафік через проксі; якщо не задано — прямий доступ),
  `UNTAPPD_BLOCK_THRESHOLD` (кількість послідовних блоків до спрацювання circuit
  breaker; default 3).
- **Env-валідація і безпечне редагування.** Обовʼязкові ключі валить `zod` на
  старті, якщо відсутні. Опційні-але-очікувані-в-проді (`UNTAPPD_SESSION_COOKIE`,
  `WEBSHARE_PROXY`, `ADMIN_TELEGRAM_ID`, `ADMIN_API_TOKEN`) НЕ валять старт — бот
  лише пише `warn` на старті (`missingExpectedKeys` у `config/env.ts`), бо кожен лише
  вимикає фічу (інакше тихий збій — як 2026-06-27, коли загублений `ADMIN_TELEGRAM_ID`
  мовчки вимкнув daily-status). Прод-`.env` редагувати тільки **additively** через
  `scripts/set-env.sh KEY VALUE FILE` (бекап + upsert одного ключа, інші рядки
  зберігаються) — ніколи не переписувати файл вручну. `.env.example` — перелік ключів.
- `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN` — OAuth-креденшели Chrome
  Web Store API (#266), тільки для `npm run release:store`; видаються Desktop-клієнтом у
  Google Cloud, consent screen МУСИТЬ бути **In production** (у *Testing* refresh-токен
  живе 7 днів). Отримання: `npm run cws:auth`.
- `CWS_ITEM_ID` — id store-item (за замовчуванням `fdelmnhijeiojadcaihfdpecfcldbndg`).
- Секрети **ніколи** не хардкодяться і не потрапляють у логи. На проді `.env`
  у `/etc/warsaw-beer-bot/.env` (`chmod 600`). `.env.example` тримати в синку.

### 5.7 Стиль і структура коду (CLAUDE.md)
- **Функціональне програмування, модульна структура.** I/O відокремлено від
  чистої логіки.
- TypeScript **strict**; типізовані залежності (`AppDeps`).
- Один репозиторій-модуль на таблицю в `storage/`.
- Match-density / іменування / ідіоми — як у сусідньому коді.

### 5.8 Чемність до зовнішніх джерел
- Єдина черга **`p-queue`** на всі зовнішні HTTP + кеш; консервативний rate-limit
  (~1 req/2s до ontap; Nominatim ~1 rps).
- **User-Agent з контактом** (`NOMINATIM_USER_AGENT`).
- Untappd-enrich батчиться (LIMIT 20/запуск) з offset'ами cron, щоб два джоби
  не били Untappd одночасно; LIMIT 20 — бюджет на запуск, спільний для on-tap і
  relay пулів кандидатів (#368), тож стеля навантаження на Untappd лишається
  незмінною — 160/добу; lookup має експоненційний backoff
  (`domain/lookup-backoff.ts`, `BACKOFF_HOURS = [0, 72, 168, 728]`): 4 спроби,
  після чого orphan **термінально dormant** (`isEligible` → false назавжди,
  поки `untappd_lookup_count` не скинуто). Орфани з `enrich_failures.review_class
  = 'not_a_beer'` повністю виключені з обох пулів кандидатів (`listLookupCandidates` і
  `listRelayLookupCandidates`).
- Після matcher-виправлення оператор запускає
  `npm run rearm-matcher-bug-orphans` (dry-run), перевіряє список і повторює з
  `npm run rearm-matcher-bug-orphans -- --apply`. Команда скидає backoff лише для
  незматчених, уже випробуваних `enrich_failures` з `review_class='matcher_bug'` і
  `candidates_count > 0`; вона не робить Untappd-запитів, а лише повертає рядки у
  звичайну enrich-чергу. У проді команда запускається з `/opt/warsaw-beer-bot`
  від `warsaw-beer-bot`, автоматично читає `/etc/warsaw-beer-bot/.env`, а `tsx`
  лишається runtime-залежністю після `npm prune --omit=dev`. Escape-hatch
  **`--ids <csv>`**: явно задані `beer_id` re-arm-яться напряму, минаючи фільтри
  `review_class`/`candidates_count` (єдина умова — рядок ще orphan,
  `untappd_id IS NULL`) — для zero-candidate класів (напр. #326 query-noise), яких
  дефолтний фільтр `candidates_count > 0` не ловить; неіснуючі чи вже зматчені id
  пропускаються з попередженням.
  **Історична пастка (#368, виправлено).** `selectRearmTargets` не вимагає рядка в
  `match_links`, тож до появи relay-пулу ре-арм для cron-недосяжних рядків був no-op:
  `untappd_lookup_count` чесно скидався, але крон їх однаково не бачив (45 із 93
  ре-армлених `matcher_bug`-рядків станом на 2026-08-08). Відтворення цифри: `applyRearm`
  виставляє `untappd_lookup_count = 0`, тож **уже ре-армлені** рядки — це
  `untappd_lookup_count = 0 AND review_class = 'matcher_bug' AND candidates_count > 0`
  (дзеркало фільтра `selectRearmTargets`, який бере ще-не-ре-армлені, тобто `> 0`).
  Тепер relay-пул їх підбирає.
- **Ops-тули: конвенція аргументів.** Список `beer_id` передається через
  `--ids <csv>` (кома-розділений, пробіл після прапорця), запис вмикається
  `--apply` (dry-run за замовчуванням) — однаково для `rearm-matcher-bug-orphans`
  і `retire-resolved-orphans`.
- Серверний Untappd-трафік (search + had-list) йде через **Webshare rotating
  residential proxy** (`WEBSHARE_PROXY`, undici `ProxyAgent`); скрейп магазинів і
  Nominatim — напряму. Circuit breaker тригериться лише після
  `UNTAPPD_BLOCK_THRESHOLD` (default 3) **послідовних** блоків (rotation: один 403
  = один флагнутий exit-IP); будь-який успіх скидає лічильник.
- **Стратегія ротації exit-IP (#222).** `p.webshare.io` не ротує в межах однієї
  HTTPS CONNECT тунелі, тому довготривалий `ProxyAgent` фіксує 1–2 IP на весь
  процес. Виправлення: безкукова клієнт (`refresh-tap-ratings`, search-key fetch)
  використовує режим `per-request` — новий `ProxyAgent` на кожен запит, гарантована
  ротація; кукований клієнт (`refresh-untappd`) використовує режим `on-block` —
  sticky IP, ротація лише при блокуванні (швидка ротація cookie'd-сесії виглядає
  як захват акаунту). Обидва клієнти виконують **до `UNTAPPD_BLOCK_RETRIES` ротацій на свіжих IP** (дефолт 6, б'є Cloudflare Managed Challenge на `/b`/`/user`) до
  того, як блок досягне circuit breaker. Метрика `rotated` в результаті джоба
  рахує блоки, поглинуті ротацією; `blocked` — лише ті, що пережили ретрай і
  дійшли до breaker'а.
- Snapshot-модель замість перезапису — джерела не опитуються частіше, ніж треба.

### 5.9 Інфраструктура / деплой
- Runtime: **Node ≥ 20** під systemd (`warsaw-beer-bot.service`).
- SQLite у `/var/lib/warsaw-beer-bot/bot.db` (WAL).
- Деплой: rsync working tree → `/opt` → `npm ci` → `npm run build` →
  `npm prune --omit=dev` → `systemctl enable` + явний **`restart`**
  (`enable --now` на запущеному unit'і не перезапускає).
- Бекап: **Litestream** → Cloudflare R2 (стрім WAL), креденшели лише з env/конфіга.
- Cron — у процесі через `node-cron` (зміна частоти = окремий PR).
- **HTTP API** (Hono): слухає `127.0.0.1:API_PORT` (default 3000) — нових
  вхідних портів не відкриваємо. Доступний зовні через **наявний
  Cloudflare-тунель**; для публічного hostname додати роут
  `beer-api.ysilvestrov-ai.uk → http://localhost:3000` у Cloudflare Zero Trust
  дашборді (тунель token-managed → роути в дашборді, **не** в локальному файлі).

### 5.10 Автоматичне рев'ю PR (Adversarial Review)
Кожен Pull Request автоматично рев'юється AI-агентом через GitHub Actions —
доповнення до людського рев'ю, не заміна. Оригінальну заміну сторонньої дії
`anc95/ChatGPT-CodeReview` власним скриптом здійснено 2026-06-19 (#143 → PR #174);
той однопрохідний дизайн застарів і **переписаний на двоетапний пайплайн 2026-07-28
(#175)** через слабку якість зауважень `gpt-4o-mini` (5 зауважень на #174, 0 реальних
багів, включно з галюцинованим P0). Дизайн/план/вимір:
`docs/superpowers/specs/2026-07/2026-07-28-ai-review-quality-design.md`,
`docs/superpowers/plans/2026-07/2026-07-28-ai-review-quality.md`,
`docs/superpowers/specs/2026-07/2026-07-28-ai-review-measurement.md`.

- **Двоетапний пайплайн.** `scripts/ai-pr-review.ts` оркеструє чотири чисті
  кроки з `scripts/ai-review/`: `find` — жадібний прохід, що просить модель
  віддати **все** підозріле як structured JSON (кожне зауваження несе дослівну
  `quote` з коду, не переказ); `gate` — механічний фільтр без мережі; `verify` —
  окремий adversarial-прохід, що виносить вердикт по кожному зауваженню, яке
  пройшло gate, звіряючи його з повним вмістом файлу; `render` — формує тіло
  рев'ю. Публікуються **лише** зауваження зі статусом `confirmed`.
- **Режими рев'ю (з 2026-07-30, #364).** Кожен PR має рівно одне маркер-рев'ю бота,
  і в його тілі живе **прихований блок стану** `<!-- ai-pr-review-state {…} -->`:
  версія, SHA голови, на якій рахувалося минуле рев'ю, відкриті зауваження
  (`file`/`quote`≤400 симв./рядки/`claim`/`why_it_breaks`/`severity`/`evidence`) і
  накопичені витрати PR. Стан і текст пише один і той самий PUT, тож розійтися вони
  не можуть. Перед рев'ю скрипт читає це тіло (той самий list-виклик, який потім
  використає upsert) і вибирає режим:
  - немає рев'ю / блок не парситься / формат іншої версії → **full** (як раніше);
  - збереженої голови немає в клоні → **full** + `::notice` з причиною;
  - збережена голова **дорівнює** HEAD (перезапуск workflow) → **republish**:
    попереднє тіло публікується байт-у-байт, **нуль** викликів OpenAI;
  - збережена голова **не є предком** HEAD (rebase/force-push) → **full** + `::notice`;
  - інакше → **incremental**: діф і повні тіла файлів беруться з `<stored>..HEAD`,
    тобто модель судить лише те, що змінив цей push. `changedLineRanges` для gate
    рахується з того самого інкрементального діфу. Якщо push не зачепив жодного
    файлу в скоупі, find-прохід **пропускається** повністю.
  Будь-яка невпевненість розв'язується на користь **full** — це поведінка й ціна,
  які були до #364, тож найгірший наслідок хибного вибору — не зекономити.
- **Долі раніше опублікованих зауважень (`incremental.ts`).** Кожне зауваження зі
  стану переанкорюється в **поточному** вмісті файлу тим самим матчером, що й gate
  (`locateQuoteAll`, whitespace-normalised): цитата знайшлася → **carried** (рядки
  оновлюються, **0** викликів); файл зник/нечитний → **closed (obsolete)**; цитати
  немає, бо код правили → **re-adjudicate** (1 виклик на *файл*). Вердикт
  `refuted`/`out_of_scope` на переперевірці = **закрито, виправлено**; `confirmed` =
  лишається відкритим із поміткою «the fix did not close this». **Fail-семантика на
  переперевірці навмисно обернена**: помилка виклику **лишає** зауваження відкритим
  («unverified this run»), бо воно вже було опубліковане на доказах, — тоді як
  свіже зауваження з помилкою верифікації, навпаки, не публікується. Свіжі
  зауваження дедуплікуються проти carried за (файл + нормалізована цитата +
  нормалізований claim), тож інкрементальний прохід не друкує те саме двічі.
  **Відома межа (свідома ціна дешевого carry):** зауваження переоцінюється лише
  тоді, коли змінився **його власний** процитований код. Виправлення в **іншому**
  файлі лишає його відкритим (це видно на PR #365: правку зробили в `usage.ts`,
  а цитата жила в `ai-pr-review.ts`) — такі зауваження закриває або наступна
  правка тієї ділянки, або людина.
- **Verify батчиться по файлу.** Один виклик на **файл**, а не на зауваження: тіло
  файлу їде в промпті один раз, разом із усіма пронумерованими зауваженнями до
  нього, відповідь — масив `{index, verdict, evidence}`. Свіжі зауваження і
  переперевірки того самого файлу йдуть **одним** викликом (питання ідентичне,
  різна лише fail-семантика відповіді). Індекс поза діапазоном або відсутній
  вердикт = `error` **лише** для того зауваження; збій виклику = `error` для
  зауважень **того** файлу, ніколи не валить job.
- **Рев'ювер друкує власний рахунок.** `callStructured` повертає `usage` разом із
  контентом; `usage.ts` (чистий) накопичує `prompt`/`cached`/`completion`/
  `reasoning` токени по стадіях і переводить у долари через таблицю цін із **датою
  останньої перевірки** (`gpt-5.5` = $5 / $0.50 cached / $30 за 1M, перевірено
  2026-07-30). Модель без перевіреної ціни друкує токени **без** доларів, а сума PR
  позначається `+` (нижня межа) — вигадана цифра гірша за визнану прогалину.
  Стадія **без викликів** коштує $0 за будь-якої моделі (інакше пропущений
  find-прохід на неоціненій моделі знеціновував би весь запуск), а виклик, що
  завершився, але повернув непридатний контент, **однаково рахується в usage** —
  недорахований рахунок такий самий обман, як вигадана ціна.
  Виведення йде і в `::notice` лога, і в футер рев'ю; сума по PR накопичується в
  блоці стану. Токени — істина, долари — похідне: якщо футер розійдеться з
  дашбордом, помилкова **таблиця**, не пайплайн.
- **Кумулятивне тіло рев'ю.** Секції «Open findings» (carried + свіжо підтверджені,
  сортування P0→P1→P2, далі порядок публікації) і «Closed by this push» (по рядку:
  claim + чому закрито). Футер: `N raised → M gated → K confirmed · C carried ·
  F closed` + рядок вартості + прихований блок стану. Обмеження: ≤20 відкритих
  зауважень і ≤60 000 символів тіла; ріжеться **з кінця порядку показу** (спершу
  closed, потім найменш серйозні відкриті), і тіло **прямо каже**, скільки
  зауважень приховано. Без кумулятивності інкрементальний прогін стирав би ще
  відкриті зауваження минулого.
- **Контекст:** `scripts/ai-review/context.ts` шле моделі і діф, і повний HEAD-вміст
  змінених файлів, у порядку спадання churn (додані+видалені рядки), поки не
  вичерпається бюджет `CONTEXT_BUDGET` (240 000 символів). Бюджет рахує **все
  зібране повідомлення** — заголовки секцій, огорожі коду, обидва попередження і
  роздільники, — а не лише тіла файлів; єдина підлога, нижче якої не опускаємось,
  це самі попередження (модель, якій не сказали, чого вона не бачить, вигадує
  твердження про це). Сам діф теж
  обмежений бюджетом: він може зайняти щонайбільше `DIFF_BUDGET_SHARE` (75 %)
  бюджету, решта лишається під тіла файлів; завеликий діф ріжеться по межі рядка
  і повідомлення **явно** каже, що діф урізано (мовчазне урізання гірше за
  жодне). Файли, що не влізли, явно перелічуються під «Files where you see only
  the diff» з інструкцією не робити тверджень про непоказаний код.
- **Механічний gate (`gate.ts`, чистий, без мережі).** Відкидає зауваження, якщо:
  файл поза скоупом (`INCLUDE_PATTERNS`/`IGNORE_PATTERNS`, той самий
  `globToRegExp`, що й раніше); `quote` не знаходиться дослівно (whitespace-
  normalised) у HEAD-вмісті файлу (`quote_not_found`); **жодне** входження цитати
  не перетинається зі зміненими рядками діфу (`outside_changed_lines`, з
  урахуванням context-рядків хунка — цитата шукається у **всіх** позиціях, бо той
  самий фрагмент може траплятися і поза дифом); або воно дублює вже прийняте
  зауваження за файлом+нормалізованою цитатою+нормалізованим `claim`
  (`duplicate` — різні баги на одному рядку не зливаються). Gate також
  **виправляє** заявлений моделлю номер рядка на реальну позицію збігу (і початок,
  і кінець беруться з матчера, не з форматування цитати); якщо ту саму цитату
  видно в **кількох** змінених місцях, вибирається найближче до заявленого
  моделлю рядка (номер рядка не годиться як пошук, але годиться як тайбрейкер;
  без придатного номера лишається перше входження) — це його найнадійніший внесок
  (див. нижче про виміряну слабкість `quote_not_found`).
- **Лічильники.** Кожне рев'ю несе футер `N raised → M gated → K confirmed ·
  C carried · F closed` (форму задає «Кумулятивне тіло рев'ю» вище); якщо жодне
  зауваження не лишилося відкритим — явний текст
  «**No verified findings.**». Відкинуті (`gate`) і знявлені (`verify`) зауваження
  йдуть у `::notice::` логу workflow, не в PR.
- **Моделі:** `AI_REVIEW_MODEL` (find) і `AI_REVIEW_VERIFY_MODEL` (verify), обидва
  дефолтяться на **`gpt-5.5`** — вибір за виміром replay 2026-07-28
  (`gpt-5.5`-find дав 0 фабрикацій на precision-сеті; `gpt-5.4-mini` — 5 із 10;
  асиметрична пара verifier/find не показала кращого результату).
- **Форма запиту (`openai.ts`):** `max_completion_tokens` замість `max_tokens`
  (сучасні OpenAI-моделі відхиляють `max_tokens` як 400) і без `temperature`
  (`gpt-5.5` відхиляє `temperature: 0`); детермінізм іде від JSON-схеми та
  verify-проходу, не від sampling-параметрів.
- **Fail-семантика:** скрипт сам володіє exit-кодом. Червоно (exit 1): відсутні
  секрети/конфіг, збій find-проходу чи помилка постингу в GitHub. Збій
  **верифікації окремого** зауваження знімає лише його (`verdict: 'error'`) і
  ніколи не валить job. Зелено (exit 0): рев'ю опубліковано (зокрема «немає
  зауважень») або в діфі немає файлів у скоупі (skip із `::notice::`). Якщо
  review-run падає після читання конфігу, скрипт перед виходом best-effort
  створює окремий PR-коментар з маркером `<!-- ai-pr-review-failure -->`, SHA й
  причиною збою або оновлює наявний marker-коментар; незмінний повторний збій
  не створює дублікат. Пошук marker-коментаря проходить усі сторінки, але збій
  lookup не скасовує прямої спроби створення. Загальний 10-секундний бюджет
  fallback розділено на 2 секунди для lookup і зарезервовані 8 секунд для
  create/update; невдала публікація коментаря не маскує первинну помилку.
- **Offline replay:** `npm run ai-review-replay -- <pr> [base-sha]` ганяє весь пайплайн
  (з `base-sha` — саме той інкрементальний зріз, який побачив би CI на
  відповідному push, інакше — перше рев'ю від merge-base)
  проти вже існуючого PR (діф + HEAD-вміст через `git show`) без постингу — той
  самий інструмент, яким виміряно вибір моделей вище. Дефолти моделей —
  **ті самі константи** (`DEFAULT_FIND_MODEL`/`DEFAULT_VERIFY_MODEL` з
  `ai-pr-review.ts`), інакше replay міряв би конфігурацію, якої CI не запускає.
  Якщо head-коміта PR немає локально, replay сам робить
  `git fetch origin pull/<pr>/head` (і каже про це), замість падати на
  відсутньому об'єкті.

**Виміряний стан (чесно, не для оптимізму).** Precision зросла з 6% (1 реальне
зауваження з 18 на старому рев'ювері) до 50–67% на новому; частка фабрикацій
впала з 13-з-18 до ~1-з-47. Але **recall проти чотирьох відомих проґавлених
багів — 0 з 4** (в обох виміряних конфігураціях), і verify-прохід на вимірі
майже нічого не відхиляє (0 з 38 у base-конфігурації) — він кандидат на
видалення, якщо продакшн-лічильники `raised → gated → verified` підтвердять це
на реальному потоці PR. Це означає: рев'ювер довів, що **перестав брехати**, а
не що він ловить те, що проходить повз нас зараз.
Вартість (виміряно на прогонах #359–#363, 2026-07-30): **~$0.23 за запуск
workflow, ~$0.63 за PR**; кожен PR рев'ювався 2–3 рази повністю, verify відхиляв
8 із 29 (28%) — усі `out_of_scope`, **жодного** `refuted`, тобто це фільтр
design-шуму, а не фабрикацій. #364 (інкрементальний ре-рев'ю + батчений verify +
самозвітність) цілить у ~$0.30 за PR. **Важливо:** початкова гіпотеза «платимо
переважно за output» **не підтвердилась** — при $5/1M input виміряні ~390k
вхідних токенів дають ~$1.95 із $2.52, тобто домінує **input**, і найбільший
важіль — саме скорочення контексту через інкрементальність. Це ще одна причина,
чому інструментація йде **перед** ставками на якість.

**Відомі хибні спрацювання рев'ювера (контекст, якого діф не дає).** Рев'ювер
тепер отримує **весь діф одним промптом** (а не по файлу), тож бачить тест-файли
поряд із кодом — але все одно не знає рантайму/інваріантів проєкту. Це — навмисні
конвенції, НЕ зауваження до виправлення. **Більшість із них явно закодовані в
`AGENTS.md`** (§2 busy-baseline, §3.1 carve-out для in-memory working sets +
test-БД, §3.2 «no `await` ⇒ no race», §3.3 визначення «external I/O», §4
анти-фокус для test-БД і generated/lock-файлів), щоб рев'ювер узагалі їх не
піднімав:
- **`better-sqlite3` синхронний.** Джоби (`backfill-normalized-brewery`,
  `dedupeBreweryAliases`, `cleanupPollutedOntap`) — синхронні й викликаються
  синхронно в `main()`. Немає `await` → немає «race через await». Зауваження
  «ensure no async / race conditions» до цих джоб — неактуальне.
- **Тести відкривають `openDb(':memory:')` per-test** (через `fresh()`). Це
  навмисна **ізоляція**, а не «неправильне керування з'єднанням» — спільний
  файл/з'єднання дав би крос-тест-зв'язність. In-memory БД знищується з процесом
  тесту; саме так роблять усі job-тести в репо.
- **`breweryAliases` повертає `string[]`, не `Set`.** `breweryAliasesMatch(a:
  string[], b: string[])` ітерує аліаси й порівнює токен-списки (token-prefix);
  передавання `Set` зламає типізацію. «Change to `new Set(...)`» — некоректне.
- **SQLite busy-handling — багатошарове, не «скрізь обгортати».** Базовий рівень:
  `openDb` явно ставить `busy_timeout = 5000` (PRAGMA) → будь-який заблокований
  запис синхронно ретраїться до 5 с на рівні SQLite, покриваючи **всіх** писачів
  (startup-джоби, крони). (`better-sqlite3` має такий самий неявний дефолт, але ми
  закріплюємо явно — щоб майбутній апгрейд бібліотеки не зняв гарантію.) Другий
  рівень — `withBusyRetry` (експоненційний бекоф)
  **лише** для довгого `import`, який пише поки бот живий і може вичерпати 5-с
  вікно під checkpoint-контеншеном litestream. Startup/cron one-shots навмисно
  покладаються на базовий рівень: prod-логи показують **0** `SQLITE_BUSY` поза
  `import`. Тож «обгорнути backfill у `withBusyRetry`» — надлишково.
- **In-memory working sets — навмисні.** `loadCatalog`, `fast-fuzzy` `Searcher`,
  `triedBeerIds`, `latestRatingsByBeer` матеріалізують повний каталог / історію
  користувача в масив — це потрібно для матчингу (fast-fuzzy не їсть ітератор) і
  обмежено розміром каталогу/юзера. «Unbounded memory / use `.iterate()`» до них —
  неактуальне; правило стосується import/scrape-шляхів, де batched-шлях вже є.
- **«External I/O timeout» лише для outbound-мережі.** Вимога
  `AbortController`/таймауту стосується `fetch` до ontap/Untappd/OSRM/Nominatim.
  Внутрішні `await` (Hono `await next()`, синхронні better-sqlite3 виклики,
  `ctx.reply`) — НЕ external I/O; «add a timeout to `next()`» — некоректне.
- **Кожен модуль логіки має колоковані `*.test.ts`.** Оскільки рев'ювер тепер
  бачить увесь діф, «немає тестів для X» виникає рідше; якщо тест-файл присутній у
  діфі — таке зауваження некоректне.

### 5.11 Щоденний тріаж orphans (LLM-агент)

- Раз на день (варшавське вікно 06:00–09:00, UTC-тік + `job_state` ідемпотентність,
  як у daily-status) джоба `orphan-triage` бере **50 найновіших** рядків
  `enrich_failures` з `review_class IS NULL AND outcome='not_found'`
  (`blocked` — проблема проксі, не матчингу) і віддає їх LLM разом із відкритими
  GitHub-issues з міткою `orphan-triage`.
- LLM класифікує кожен orphan деревом рішень §3.7 (`not_a_beer` / `parser_bug` /
  `unidentifiable` / `not_on_untappd` / `matcher_bug`) і кластеризує actionable-класи
  (`parser_bug` / `matcher_bug` / `not_a_beer`) у патерни: коментар до наявної issue
  або нова issue (**≤3 нових за запуск**; мітки примусово `orphan-triage` +
  `parser-bug`/`matcher-bug`/`not-a-beer`).
- Межа parser/matcher: якщо brewery+name на сторінці крамниці по суті правильні,
  але матч не стався (alias-геп, розбіжність назв, шум у запиті — дужкові adjunct-
  списки, ABV/spec-рядки, collab-дужки, випалі/зайві токени) — це `matcher_bug`;
  якщо сам рядок є хибними даними нашого адаптера — `parser_bug`. Зіпсований лістинг
  самої крамниці (типоси в її даних) адаптер прочитав вірно → `matcher_bug` (якщо
  fuzzy-кандидат міг би врятувати) або `unidentifiable`, але не `parser_bug`.
- **Докази перед вердиктом.** Для кожного orphan з `candidates_count = 0` джоба спершу
  виконує два детерміновані пошуки — лише броварня і лише назва — і кладе їхні топ-3 у
  пейлоад (`probe_brewery` / `probe_name`). Рядки з кандидатами проб не отримують: доказ
  у них уже є. Зведення кандидатів містить `(bid, abv%, стиль)`, а сам orphan — власні
  `abv`/`style`, щоб модель порівнювала ABV замість здогаду. Бюджет спільний з
  верифікацією: `TRIAGE_PROBE_LIMIT` (дефолт 120) пошуків на запуск; вичерпання ліміту,
  збій пошуку, відкритий breaker чи відсутній `search` лише прибирають докази, але не
  валять запуск.
- **Причина публікується лише перевіреною.** Вердикт, що прив'язує orphan до issue,
  зобов'язаний нести `proposed_query` + `expected_target` («<броварня> — <назва>»); джоба
  перевиконує цей запит і публікує причину в GitHub, тільки якщо очікувана ціль
  повернулась. Інакше прив'язка знімається, нотатка отримує префікс `unverified:`, а сам
  клас **усе одно записується** (actionable-вердикт без посилання planTriageActions
  трактує як «тихий», а не `skipped` — інакше та сама недоведена гіпотеза генерувалася б
  щодня). Кількість таких — у рядку дайджесту (`N неперевірених`). Підстава: рев'ю
  2026-07-28 — з ~16 причинних гіпотез підтвердились 4, а дві реалізовані погіршили б
  матчинг (#340, #303).
- **Translation guard:** польська/чеська/українська назва з `candidates_count=0` сама
  по собі НЕ є доказом потреби перекладу — Untappd здебільшого тримає оригінальне
  написання (`Jasne`, `Niepasteryzowane`, `BezalkØ Pan IPAni`), тож «перекласти
  англійською» так само занулює запит. Діагноз «переклад» дозволений лише коли це
  доводять самі кандидати (англомовний кандидат тієї ж броварні, решта токенів
  збігається); інакше — патерн шуму в запиті або `not_on_untappd`. Підстава: рев'ю
  #340 від 2026-07-28 (усі 4 автотріажні приклади були хибно класифіковані).
- **Scope — структуроване поле, не текст (#408).** Кожна нова issue зобов'язана нести
  `scope` у тул-схемі: `beer_ids` (когорта, задля якої її заводять) та/або `where` —
  список термів `{col, op, value}`, з'єднаних `AND`. Дозволені колонки:
  `candidates_count`, `fail_count` (`= != < <= > >=`); `source_url`, `brewery`, `name`
  (`empty`, `non_empty`, `contains`); `abv`, `style` (`is_null`, `is_not_null`);
  `review_class` (`=`). Джоба **сама рендерить** це у блок ```` ```triage-scope ```` в тілі
  issue і наступного дня парсить **власний рендер**, а не прозу моделі; поруч
  рендериться людський рядок `Scope:`. Приклади — «з сьогоднішнього батчу», глобальний
  count НЕ вказується (агент бачить лише поточну вибірку 50 orphans).
- **Scope — необхідна умова, а не визначення.** Він відповідає лише на питання «чи
  рядок доказово *суперечить* issue?» і ніколи не стверджує належність: більшість
  реальних патернів (типоси крамниці, пакувальні токени) предикатом над колонками не
  виражається взагалі.
- **Чотири детерміновані гейти вердикту** в `planTriageActions` (чиста функція, без
  LLM); кожен веде лічильник, який потрапляє в лог `verdict shortfall` як `guardHits`:
  1. `where` лише з `review_class` **нелегальний** — це оголошує scope'ом цілий клас, і
     саме ця форма перетворила #347 на смітник (36 рядків / 7 механізмів / 0 фіксів за
     19 днів). Пропозиція відкидається **до** дедупу й ліміту, щоб не з'їдати слот.
  2. Вердикт приліплюється до відкритої issue, лише якщо рядок задовольняє її scope.
     Issue без блоку `triage-scope` — **безскоупна** і не приймає нічого. Перемаршрутизації
     НЕ робимо: вибір іншої issue — це рівно та сама схожість заголовків, що й породила
     купу.
  3. `not_on_untappd` приймається, лише якщо проба **бігала й повернула порожньо**
     (`''` ≠ `undefined`). Інакше — деградація до `matcher_bug` без посилання: рядок
     лишається в пулі збагачення (`orphanWithoutMatchLinkPredicate` виключає тільки
     `not_a_beer`/`retired_at`). Підстава — #377: із 14 слабко доведених вердиктів 7 хибні,
     а когорта «проба не бігала» хибна 3 з 3. Наслідок: `collectTriageProbes` за
     побудовою пропускає рядки з `candidates_count > 0`, тож усі такі `not_on_untappd`
     деградують — це навмисно (див. #357).
  4. **Насичення:** issue, що набрала `MAX_ROWS_PER_ISSUE` (12) рядків **після свого
     створення**, більше не приймає коментарів. Рахуються саме післястворені рядки:
     #405 народилася з 15 перелічених, тож підрахунок за весь час відкидав би саме ту
     вузьку форму, заради якої все й робиться.
- **LLM лише пропонує** — скрипт валідує (клас із CHECK-списку, номер issue з
  відкритого списку, beer_id лише з поточної вибірки, дублікати відкидаються) і
  виконує. Порядок на orphan: спочатку GitHub, потім запис
  `review_class`/`review_note` у БД; збій GitHub лишає orphan нетріаженим на завтра.
- Класи `not_on_untappd`/`unidentifiable` — тихі: лише запис у БД, без GitHub. Людське
  рішення відбувається на рівні GitHub-issues, не сирих помилок.
- **Порожні/неповні вердикти:** якщо LLM повертає **порожній** список вердиктів на
  непорожній батч — один негайний повтор `analyze`; якщо і він порожній (жоден
  orphan з батчу не покритий) — запуск завершується `error` у digest
  («Тріаж: помилка (LLM повернув 0 вердиктів …)»), orphans лишаються нетріаженими
  на завтра. Часткова нестача (покрито менше, ніж у батчі) — лише `warn`-лог, батч
  обробляється штатно.
- **Тимчасові збої не з'їдають день (#316):** помилка аналізу класифікується як
  transient (HTTP 5xx/429/408 або мережевий збій — від LLM-провайдера чи GitHub)
  або permanent (усе інше: невалідна схема відповіді, `max_tokens`, 0 вердиктів
  після повтору, невідомі помилки). Transient **не** виставляє
  `orphan_triage_last_run`, тож наступний 15-хвилинний тік у тому ж вікні
  `[06:00, 09:00)` повторює запуск; максимум **3 спроби на варшавський день**
  (лічильник `job_state.orphan_triage_attempts` = `<дата>:<n>`, який
  інвалідується зміною дати). Кожна спроба одразу пише рядок результату з
  сьогоднішньою датою, тож навіть день, який уперся в межу вікна з невичерпаними
  спробами, видно в дайджесті; невичерпані спроби на завтра не переносяться.
  Permanent-помилка закриває день на першій же спробі. Вартість повтору
  ненульова (повний бюджет проб + LLM-виклик), тому невідома помилка свідомо
  вважається permanent.
- Провайдер/модель конфігуруються: `TRIAGE_LLM_PROVIDER` (`anthropic`|`openai`),
  `TRIAGE_LLM_MODEL` (дефолт `claude-opus-4-8`), ключі `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`, `GITHUB_TOKEN` + `GITHUB_REPO`. Відсутній ключ = джоба
  вимкнена (не падає), що видно в digest. Опційний `TRIAGE_LOG_DIR` вмикає архів
  сирого LLM-I/O кожного запуску (`${TRIAGE_LOG_DIR}/<дата>.json`, ротація 30
  файлів, best-effort); не заданий ⇒ архів вимкнено.
- Результат запуску — рядок у daily-status digest (через `job_state`,
  ключ `orphan_triage_last_result`): «Тріаж: 7 нових → 2 до #228, 1 нова #232,
  3 not_on_untappd, 1 пропущено», або «помилка (…)» / «вимкнено (…)».
  Для транзієнтних збоїв — «тимчасова помилка (…), спроба 1/3» доки спроби
  лишились, і «помилка (…, 3 спроби)» після їх вичерпання.
- Мітки `orphan-triage`, `parser-bug`, `matcher-bug` мають існувати в репо
  (джоба їх не створює).

---

## 6. Browser Extension Client (`extension/`)

> Read-only MV3 розширення (monorepo-lite): Vite + Vanilla-TS + `@crxjs/vite-plugin`,
> тести — Vitest. Накладає особистий drunk-статус + рейтинг на сітки крафт-магазинів,
> споживаючи `POST /match` (§4). Дизайн: `docs/superpowers/specs/2026-06-07-browser-extension-client-design.md`.

- **Per-site адаптери** (`src/sites/`): кожен має стабільний `id` (= ім'я
  фікстури `tests/fixtures/<id>.html`). `beerrepublic` (Shopify SSR —
  `.product-item`/`__vendor`/`__title`, повна навігація `?page=N`), `onemorebeer`
  (Nuxt **SPA** — тайл `.one-product-list-view__tile`, brewery
  `[data-information-type="brand-name"]`, назва `a.product__title`; `°` у тайтлі це
  Плато, не ABV → `abv` опускається; має `waitForGrid`), `beerfreak` (Horoshop SSR —
  `.catalogCard`, brewery/name з embedded `products` metadata, домен
  `beerfreak.org`; локально відхиляє tasting sets, mix packs і numbered multi-beer
  series), `bierloods22` (Bierloods22 SSR — `.product-block`,
  пивоварня з **brand-префіксу** `a.title[title]` (`"{brand} {title}"` → `brand = attr − text`;
  кількість ` - `-сегментів brand'у задає межу пивоварні, тож пивоварні з внутрішнім ` - `
  типу `Kykao - Handcrafted` парсяться правильно; порожній brand → фолбек split по першому
  ` - `), домен `bierloods22.nl`), `winetime` (WineTime SSR — `a.product-micro`,
  brewery/name з `window.initialData.category.products` metadata keyed by
  `data-productkey`, fallback на видимий title/brewery, ABV опускається,
  домен `winetime.com.ua`), `hoptimaal` (Hoptimaal Shopify SSR — `.product-item`,
  назва з `.product-item__product-title`, brewery з vendor-фільтрів або агресивного
  title-prefix fallback, ABV із subtitle; Beer Club/Merch/Spirits/Bundles виключаються),
  домен `hoptimaal.com`), `flasker` (Flasker WooCommerce SSR — `li.product`/`h2.woocommerce-loop-product__title`
  (archive), `tr[data-title]` (Barn2 product table), `li.wc-block-grid__product` (block
  grid); brewery: спершу курований набір правил `BREWERY_RULES` (product-family
  slug overrides > tag > brewery slug; Mad Brew/VibrantPour/Copper Head/Flasker/Hoppy Hog),
  далі згенерований реєстр броварень сайту (`flasker-breweries.generated.ts` — з
  бренд-стрічки `mb-brand-tile`, звірений з каталогом Untappd для canonical-форми)
  за product-tag, потім за title-head (найдовший збіг), fallback — existing title
  parser (зазвичай перше слово, з відомою обробкою two-word/parenthetical cases);
  leading `ПРЕДРЕЛІЗ`/`ПРЕДРЕДІЗ`/`ПРОБНИК:` labels знімаються з head **до** всього
  ланцюга резолву — інакше fallback-split забирає банер як броварню (#376) — і той самий
  банер (`предреліз-`/`предредіз-`/`пробник-`) знімається зі **slug** перед звіркою
  префіксів, бо інакше pre-release listing ховає за банером і family-, і brewery-префікс (#385);
  product-family slug prefixes покривають серії, які магазин виставляє без назви броварні
  в title (`lost-philosopher-`, `de-zwarte-regel-`, `tomatol-` → Mad Brew; для
  `Tomatol Bulgogi` це свідомо прийнятий компроміс — відкритий brewery-gate веде
  name-stage до чужого запису (`Tomatol: Bulgogi Sriracha` замість опублікованого
  магазином `Tomatøl:BULDAK BULGOGI`) — #385; коли товар публікує bid, канал identity
  за published bid (#384, вище) виправляє це напряму по bid і обходить name-stage
  цілком; для товарів без bid компроміс і далі чинний);
  відомий display-prefix brewery видаляється з name;
  volume-gate: пиво завжди містить об'єм в ml/л/l, non-beer без об'єму
  відкидається; ABV із `%` у title; для кожної ще не кешованої картки `loadCardDetails`
  довантажує сторінку товару (#384: до `MAX_DETAIL_FETCHES_PER_PASS = 20` запитів за
  прохід, дедуп за URL, помилки проковтуються — картка лишається на даних із title).
  Звідти читаються два сигнали: JSON-LD `brand` (покриття **45/45**) — мапиться через
  `BREWERY_RULES`/реєстр (`canonicalizeBrand`) **до** заміни розпізнаної з title
  пивоварні, бо сирий `brand` це відображуване ім'я магазину, а `canonical` реєстру —
  вивірена Untappd-форма (без мапінгу override відкотив би реконсиляцію: `Правда`
  замість `Pravda`, `Volta` замість `Volta Brewery`, `MUZA` замість `MUZA BREWING CO`);
  і опублікований `untappd.com/b/<slug>/<bid>` (покриття **37/45**) — ретранслюється як
  `bid`/`bidSlug`/`brand` у `/enrich/candidates`/`/enrich/result` (identity-канал —
  вище, `POST /enrich/candidates` / `POST /enrich/result`)), домен `flasker.com.ua`), `piwnemosty`
  (Piwne Mosty IdoSell SSR — `.product`, brewery/title з GA
  `view_item_list` metadata keyed by `data-product_id`, fallback на visible title
  `"{brewery}: {name} - puszka/butelka N ml"`; категорії `/pol_m_PRZEKASKI*` і
  `/pol_m_SZKLO-I-MERCH*` є whole-page non-beer gate), домен `piwnemosty.pl`),
  `funkyshop` (Funkyshop PrestaShop SSR — `article.product-miniature`, назва з
  `.product-title`, brewery з `.manufacturer-product` або bounded detail-page fallback,
  ABV із `.product-description-short`, trailing package volume/format прибирається з name;
  glass/merch категорії `/pl/17-szklomerch` і `/en/17-glassmerch` є whole-page non-beer
  gate; локально відкидаються set/glassware/deposit products), домен `funkyshop.pl`.
  `registry.pickAdapter(url)`.
  Опційний `reRenderContainerSelector` —
  **звуження скоупу re-parse**, НЕ вмикач re-render (див. нижче). Як додати
  адаптер: `docs/adapter-authoring.md`.
  Кожен адаптер ПОВИНЕН виключати не-пива — детекція шоп-специфічна: назва через
  `non-beer.ts isNonBeerName` (паки/сети/сертифікати), шоп-локальні токени (мерч onemorebeer:
  `szklanka/pokal/kufel/koszulka/książka`, onemorebeer soft drinks:
  `kofola/kombucha/vita aloe`), спільний ABV-гейтований гейт содових родин
  (`non-beer.ts isNonAlcoholicSoftDrinkFamily`: `ginger beer`/`root beer` у парі
  brewery+name або в опублікованому шопом стилі **І** `abv === 0` ⇒ не пиво; без ABV
  лишаємо товар; опублікований не-родинний стиль ветує відкидання) плюс беззастережний
  `energy drink` у `isNonBeerName`, URL колекції (`hoptimaal`), або **гейт цілої
  категорії** через опційний `SiteAdapter.isNonBeerPage(url)` — overlay пропускає сторінку
  повністю тільки коли broad skip не може сховати eligible cider/mead/kvass. Kvass/`квас`/
  `Kwas chlebowy` є eligible категорією і не фільтрується ні shared helper'ом, ні
  шоп-локальними фільтрами, ні page-gate'ами. `abv === 0` саме по собі НІКОЛИ не є
  ознакою не-пива: безалкогольне пиво — пиво, і 0.0% — єдине, що відрізняє AleBrowar
  Kwas Chlebowy Bright від Light (#322/#369). Гейт содових родин спрацьовує виключно
  на перетині нуля з родиною `ginger beer`/`root beer`. FP-гарди: банка з заставою
  (`MAGIC ROAD … PUSZKA … KAUCJA`) і kvass лишаються пивом. Форситься конформанс-тестом
  (див. **Тести**).
- **Потік:** content script парсить видиму сітку → short-TTL кеш
  (`chrome.storage.local`) → промахи йдуть у background service worker, який
  тримає Bearer-токен (**ніколи** не в контексті сторінки) і б'є `POST /match` →
  бейдж ✅+оцінка на випитих. **Re-render однаковий для всіх адаптерів:** overlay
  позначає оброблені картки (`data-beerseen`), а спостерігач на `document.body`
  перезапускає `runOverlay` щойно серед розпарсених карток з'являється непозначена
  (навігація / SPA ре-маунт / infinite-scroll); кеш дедуплікує повторні матчі.
- **Auth:** токен з команди `/extension` зберігається в `chrome.storage.local`;
  base URL редагований (дефолт `https://beer-api.ysilvestrov-ai.uk`, §5.9);
  options-сторінка має Test connection (`GET /health` + 1-beer `/match`) і завжди
  показує посилання «Read the setup guide →» на хостований install-гайд
  (`docs/extension-install-en.md`/`-uk.md`).
- **Popup керування кешем** (toolbar `action`, дозвіл `activeTab`):
  «Refresh this page» — для активної вкладки підтримуваного магазину скидає бейджі
  видимих карток (видаляє їхні `mc2:`-записи кешу + ре-рендер живцем через
  повідомлення `refresh-page` контент-скрипту → `refreshCards` + `clearKeys` +
  `runOverlay`); «Clear all cache» — чистить усі `mc2:`-ключі (`clearAll`). Ключі
  кешу site-незалежні (`normalizeKey(brewery,name)`), тож «per-site» реалізовано як
  «оновити відкриту сторінку». Поки токен **не заданий**, popup, **окрім** цього
  меню (кнопки лишаються), додатково показує «Not connected», кнопку «Get a token»
  і те саме посилання «Read the setup guide →»; після збереження токена ці три
  додаткові елементи ховаються.
- **Read-only гарантія:** лише додає власні бейдж-ноди; будь-яка помилка
  парсингу/рендеру проковтується й не ламає сторінку магазину.
- **Тести:** контракт адаптера покрито **конформанс-тестом над реєстром**
  (`src/sites/conformance.test.ts`, параметризований по `ADAPTERS`) — наявність
  фікстури `tests/fixtures/<id>.html`, парс, валідність `reRenderContainerSelector`
  на фікстурі, і **re-render після заміни сітки** (синтез заміни з одного фікстура).
  Відсутня фікстура для зареєстрованого адаптера = червоний CI. Bespoke-тести
  адаптера лишають **лише квірки** магазину. Фікстури: `beerrepublic` — `curl`;
  `onemorebeer` — headless-Playwright рендер-дамп зі scroll. Плюс unit-тести
  кеша/normalize/client/worker/badge/grid-ready/re-render observer/startOverlay.
  Білд — `vite build`.
  Плюс **кейс фільтрації не-пива**: кожен адаптер має `tests/fixtures/<id>.nonbeer.html`
  (тільки не-пиво) і `parseCards` на ньому МУСИТЬ дати `[]`; або `<id>.nonbeer.json`
  `{none:true, reason}` (виняток із обовʼязковою причиною). `isNonBeerPage` і FP-гарди
  (MAGIC ROAD) — у bespoke-тестах адаптера. Відсутність фікстури/винятку = червоний CI.

### 6.1 Бейджі та збірка розширення
> Рунбук релізу: `docs/extension-release.md`. Дистрибуція — §6.4.

- **Бейджі.** Питі беври (exact-матч) — `✅` + особиста оцінка. Каталожні беври, які
  користувач ще не пив, але мають `untappd_id` і глобальний рейтинг — `⭐` + глобальна
  оцінка Untappd. Fuzzy-матч пива з drunk-set (`drunk_uncertain: true`) — `❓` +
  глобальний рейтинг (якщо є; «ймовірно випите, без певності»). Усі бейджі клікабельні: `✅`/`❓`/`⭐` ведуть на сторінку беври в Untappd
  (`https://untappd.com/beer/<untappd_id>`), а якщо `untappd_id` ще немає —
  на пошук Untappd із підставленою назвою (`brewery name`). Зматчені орфани
  (без `untappd_id`) показуються як `⚪` і ведуть на той самий пошук.
  Незматчені (`matched_beer` null) — без бейджа.
- **Збірка — єдине джерело метаданих.** Версія береться з `extension/package.json`
  (маніфест імпортує її). Реліз у стор: `npm run release:store` (§6.4). Дебажна збірка
  мейнтейнера: `npm run build` — хук `postbuild` кладе
  `extension/warsaw-beer-overlay-<v>.zip`, який власник качає з сервера й ставить через
  Load unpacked. Zip **детермінований** (сортовані записи, фіксований mtime), тож повторна
  збірка тієї ж версії байт-ідентична. Dev-збірка лишає `key` у маніфесті, що пінить
  extension ID, тож токен переживає переустановку.

### 6.2 Store/dev варіанти збірки (підготовка до Chrome Web Store)
> Серія `chrome-web-store` (#242–247). Дизайн: `docs/superpowers/specs/2026-07-08-cws-icons-store-manifest-design.md`.

- **Дві збірки з однієї кодової бази.** `manifest.config.ts` — фабрика
  `buildManifest({ store })`; `default export` читає `process.env.CWS_BUILD`.
  Dev (за замовч., `npm run build`) — дебажна збірка мейнтейнера (§6.1).
  Store (`npm run build:store`/`package:store`, `CWS_BUILD=1`) — пакет для CWS.
- **Різниця збірок:** dev несе `key` (фіксує ID unpacked-інсталяції → токен переживає
  переустановку) і широкий `optional_host_permissions: 'https://*/*'` (кастомний baseUrl
  для дебагу); store **обидва прибирає** — CWS відхиляє пакети з `key`, а «доступ до всіх
  сайтів» затягує рев'ю. `key: undefined` випадає при серіалізації маніфесту → у store-JSON
  поля `key` немає взагалі. Enrich-оріджини (`untappd.com`, `*.algolia.net`) лишаються в обох.
- **`tabs` → `activeTab`** в обох збірках: popup читає лише активну вкладку
  (`chrome.tabs.query`) і шле повідомлення її контент-скрипту (`chrome.tabs.sendMessage`) —
  `activeTab` це покриває, тож ширший `tabs` («read your browsing history») прибрано.
- **Кастомний baseUrl в options** ховається у store-збірці через compile-time прапорець
  `__CWS_BUILD__` (Vite `define`): без `https://*/*` поле все одно неробоче, тож у store
  його input+label приховані, а arbitrary-origin `permissions.request` пропускається.
  Dev-збірка — як раніше.
- **Іконки.** Джерело — один SVG `extension/icons/icon.svg`; `npm run render-icons`
  (Playwright) растеризує його в `public/icons/icon-{16,32,48,128}.png` (закомічені, щоб
  `build` не тягнув браузер). Маніфест декларує `icons` + `action.default_icon` усіх 4
  розмірів; 128px — також іконка листингу CWS.

### 6.3 Потоки даних розширення (privacy)
> Канонічний перелік для privacy policy (#244). Політика: https://ysilvestrov.github.io/warsaw-beer-bot/privacy/ (корінь `/` — лендінг-сторінка); чернетка CWS-дисклоужерів: `docs/cws-data-usage.md`; хостинг — GitHub Pages з `site/` через `.github/workflows/pages.yml`.

| Дані | Куди | Коли |
|---|---|---|
| Токен (`/extension`) | `chrome.storage.local`; `Authorization: Bearer` лише на beer-api | завжди |
| Назви пива/броварні (+ABV) з видимих карток | POST `beer-api/match` | на підтримуваній сторінці |
| Кеш матчів (`mc2:`) | локально | — |
| Enrichment (opt-in): назви orphan | beer-api `/enrich/candidates` → Algolia (сесія юзера) → beer-api `/enrich/result` | лише увімкнено, ≤20/стор. |
| Sync check-ins (opt-in): HTML власної стрічки Untappd | beer-api `/checkins/sync` (сервер парсить пиття+оцінки) | лише по кнопці Sync |

Немає аналітики/трекінгу/реклами/продажу даних. Інших мережевих призначень, окрім beer-api та
(за згодою) Untappd+Algolia, немає. Зміна цих потоків у коді МУСИТЬ оновити і політику, і цю таблицю.

### 6.4 Дистрибуція: Chrome Web Store (#247, #267)
> Рішення серії `chrome-web-store`. Дизайн: `docs/superpowers/specs/2026-07-10-cws-distribution-migration-design.md`. Ретайр off-store каналу → #267; автоматизація аплоаду → #266.

- **Єдиний канал — Chrome Web Store.** CWS **сам авто-оновлює** користувачів. Off-store
  bot-канал (zip у Telegram, рядок релізу в БД §3.12, привілейований applier)
  **ретайрнуто** в #267: бот більше не роздає zip і не має релізної команди.
- **Store extension ID:** `fdelmnhijeiojadcaihfdpecfcldbndg` (версія **0.13.0** опублікована
  й live). Store-збірка **без `key`**, тож CWS присвоює цей ID сам (див. §6.2).
- **Видимість листингу — Public, але 18+.** Айтем позначений **Mature Content** (пивна
  тематика), тож CWS **ховає його від незалогінених** відвідувачів і **не показує в пошуку
  стору**: анонім бачить «This item is not available. Please sign in to view this item».
  За **прямим посиланням** розширення доступне будь-кому залогіненому й ставиться нормально.
  Наслідок: органічного припливу зі стор-пошуку не буде — роздача йде посиланням.
- **`/extension`** повертає **токен + посилання на стор** (i18n-ключ `extension.store`);
  жодних файлів бот не надсилає.
- **Наслідок зміни ID.** Store-ID **відрізняється** від `key`-pinned ID unpacked-збірки, а
  `chrome.storage.local` прив'язаний до ID → у store-версії сховище **порожнє**: тестер має
  **вставити токен** в Options і видалити unpacked-версію.
- **Реліз.** Нова версія = `npm run release:store` (#266: `package:store` → upload у CWS →
  submit for review, локально, креденшели з `.env`). Store-збірка пишеться в окремий файл
  `warsaw-beer-overlay-<version>-store.zip`, щоб не затирати дебажний zip (§6.1). Ручний
  аплоад через dashboard лишається як фолбек.
- **Dev/maintainer.** Unpacked-збірка з `key` лишається як локальний dev-режим мейнтейнера
  (§6.1).

**Міграційне повідомлення тестерам (#267):**
> 🍺 «Warsaw Beer Overlay» тепер у Chrome Web Store
>
> Розширення опубліковано в офіційному сторі — раджу перейти на цю версію: вона
> оновлюватиметься сама, без zip-файлів від бота.
>
> Посилання: https://chromewebstore.google.com/detail/fdelmnhijeiojadcaihfdpecfcldbndg
>
> Якщо побачиш «Item not available» — просто залогінься в Google-акаунт у браузері й онови
> сторінку. Розширення позначене як 18+ через пивну тематику, тому незалогіненим стор його
> не показує.
>
> Як перейти (хвилин п'ять):
> 1. Встанови розширення за посиланням вище.
> 2. Знайди вище в нашому чаті повідомлення з твоїм токеном (довгий рядок у моноширинному
>    блоці) і скопіюй його — це той самий токен, він працює далі.
> 3. Відкрий Options розширення, встав туди токен, натисни Test connection.
> 4. Видали стару версію в chrome://extensions — ту, що ставилась розпакованою із zip.
>
> Чому токен треба вставляти вручну: у версії зі стору інший ID розширення, а Chrome
> прив'язує сховище до ID, тож налаштування зі старої версії не переносяться. Сам токен при
> цьому лишається чинним — його не треба міняти, і поки ти не видалив стару копію, обидві
> працюють одночасно.
>
> Якщо не можеш знайти те повідомлення — напиши /extension, і я видам новий. Тільки май на
> увазі: нова видача одразу вимикає старий токен, тож стара копія відразу перестане
> працювати. Тому цей шлях — лише якщо старий токен не знайшовся.
>
> Чому стару копію варто прибрати: якщо залишити обидві, на сторінках магазинів вони обидві
> малюватимуть бейджі й дублюватимуть одне одного.
>
> Що отримуєш: у сторі версія 0.13.0, а останнє, що приходило через бота — 0.10.0. За цей
> час додалося визначення пивоварень у Flasker, фікси BeerFreak і Funkyshop, глобальні ⭐ без
> токена, і матчинг з урахуванням міцності — тепер безалкогольна та 0,5% версії одного пива
> більше не плутаються.

- **Основний шлях — перевикористати наявний токен** із попереднього повідомлення бота:
  токен **не прив'язаний до ID розширення** (авторизація — `findTelegramIdByHash` по
  sha256-хешу), тож той самий рядок працює одночасно в обох копіях.
- **`/extension` — лише фолбек:** він робить **деструктивну ротацію 1:1** (`DELETE` потім
  `INSERT` в `api_tokens`, §3.11), яка миттєво вбиває стару копію. І стару копію в будь-якому
  разі треба видалити: дві встановлені копії малюють бейджі на одній і тій самій сторінці
  магазину.

---

## Appendix — Operational gotchas (чек-лист на новий деплой)
Зведено з post-MVP уроків (`docs/.../2026-04-22-...-design.md` §14):
- `enable --now` ≠ `restart` на запущеному unit'і.
- rsync `-a` зберігає власника-root → потрібен `chown -R` перед `npm ci`.
- TypeScript у devDependencies → білд: `npm ci` → build → `npm prune --omit=dev`.
- Telegraf `handlerTimeout = 90 с` → fire-and-forget для довгих handler'ів.
- `bot.stop()` не виходить з процесу → явний `createShutdown` + `TimeoutStopSec`.
- `stream-json@2` потребує явного `.js`-суфікса в require-шляху.
- Brewery-aliases: `"X / Y"` (білінгва + колаби, будь-який пробіл навколо `/`)
  і паренформа `"X (Y)"` — обидві сторони рахуються як валідна пивоварня;
  `dedupeBreweryAliases` зливає дублі на старті.
- Brewery hard-gate: **token-boundary prefix** (`matcher.ts breweryAliasesMatch`) —
  співпадіння, якщо токени одного аліаса є провідним префіксом токенів іншого
  (`[harpagan]` ⊑ `[harpagan, contracts]`), у будь-якому напрямку. Точна рівність —
  окремий випадок. Порівняння по цілих токенах: `harp` ≠ `harpagan`; спільний
  НЕ-провідний токен не рахується (`[project]` ⋢ `[side, project]`). Далі —
  name-fuzzy ≥ 0.85 як захист від хибних збігів. Той самий gate в
  `untappd-lookup.ts` (Stage 1). **Обмеження (#120, deferred):** gate ловить лише
  **провідний** префікс, тож хвостовий ярлик магазину (`Staropolski` ⋢
  `Kultowy Browar Staropolski`) не матчиться — окремий issue.
- **name-keys (#117).** `nameKeys(name, brewery)` (`matcher.ts`) — множина ключів:
  `COLLAB_SEP`-split → нормалізація сторони → зріз вбудованої пивоварні (`stripBreweryFromName`, будь-де) → **drop сторін
  з < 2 токенів** → токени відсортовані. Збіг = непорожній перетин (рівність множин,
  order/collab-aware, FP-безпечно як exact). Однотокенні назви цілком → порожній set →
  fuzzy-фолбек. У `lookupBeer` fuzzy-фолбек додатково пробує whole-name/`COLLAB_SEP`-сторони
  після зрізу провідної пивоварні, тож `Pohjala Pime Öö PX` може матчити
  `Pime Öö PX (Cellar Series)`, а `Lièvre / Slake` — `Lièvre`.
  Використовується в exact-стадії `matchPrepared` (key-перетин = exact,
  отже несе drunk/personal-заяви) і в `lookupBeer` Stage 2a (перед fuzzy 2b).
- `BREWERY_NOISE` стрипить дескриптори пивоварні багатьма мовами (`browar`,
  `brewery`, `contracts`, `collab`/`collaboration`, `pivovar`, `brauerei`, `brasserie`,
  `birrificio`, `brouwerij`, `bryggeri`, `cerveceria`, …), а також **складені**
  «нано-пивоварня» токени (`nanobrowar`/`nanobrowary`/`nanobryggeri`) — лише як
  єдиний склеєний токен; голе `nano` НЕ є шумом (це окреме слово/частина бренду:
  `Nano Cinco`, `Mandrill Nano Brewing`), бо його зрізання зіпсувало б бренд (#228).
  `canonicalizeBreweryBrand` покриває зворотний випадок: коли `BREWERY_NOISE`-токен
  насправді **несе бренд**, бо в Untappd він склеєний в один токен. Крамниці пишуть
  бренд роздільно (`ALE BROWAR`), тож `browar` зрізається і пивоварня колапсує до
  голого стоп-слова `ale` — ламаючи і пошуковий запит, і гейт проти Untappd-токена
  `AleBrowar`. Тому `\bale\s+browar\b` склеюється в `AleBrowar` ДО токенізації (у
  `normalizeBrewery` і `cleanSearchQuery`); правило вузьке — польське `browar`
  інакше **веде** назву (`Browar Stu Mostów`), а не тягнеться за `ale` (#327).
  `buildSearchQuery` (спільний будівник пошукового запиту для обох щаблів драбини #382;
  `cleanSearchQuery` — його широкий щабель і незмінний продакшн-шлях relay/probes;
  `stripBreweryNoise` збережено, але не в гарячому шляху) додатково
  колапсує `COLLAB_SEP`-роздільники ДО токенізації, тож приклеєне сміття типу `collab/`
  відсіюється і пошуковий запит enrich'у не ANDить обидві колаб-пивоварні (#117 Omnipollo).
  `stripLegalForm` вирізає юридичні
  форми (`Sp. z o.o.`, `S.A.`) ДО токенізації — інакше brewery hard-gate валить
  валідний матч (напр. `Pivovar Černá Hora` ↔ `Cerna Hora Brewery`; ontap
  `Harpagan Brewery` → `harpagan` vs Untappd `Harpagan Contracts`).
- `untappd-lookup.ts` Stage 2: серед однаково-оцінених name-fuzzy збігів —
  ABV-tiebreak (`ABV_TOLERANCE`). `normalizeName` зрізає рік, тож різні
  vintage/міцності одного пива (`Buzdygan Rozkoszy` 8.5% vs `… 2026` 9.8%)
  колапсують в однакову назву; ABV — єдиний сигнал, що їх розрізняє.
  Десяткові release-ідентифікатори в назві (`Ambrosia 9.0`) натомість зберігаються
  як токени і не можуть exact/fuzzy-матчитись до іншого релізу (`Ambrosia 8.0`).
  Числовий tap-noise з `%`/`°`/`ABV` і чотиризначні vintage-роки далі зрізаються.
  `enrichOneOrphan` передає `beer.abv` у `lookupBeer`.
- Збережений `normalized_brewery` — ключ ідемпотентності upsert; при зміні правил
  нормалізації перераховується на старті (`backfill-normalized-brewery.ts`).
  `idx_beers_norm` НЕ unique, тож перерахунок не кидає constraint.
- `createShutdown` отримує опційний `httpServer`; якщо він є — закривається між
  зупинкою бота і закриттям БД. Порядок: cron → bot → http → db → exit.
- Cloudflare-тунель token-managed: роути (`public hostname`) живуть у дашборді
  Zero Trust, **не** в локальному `config.yml`. Для нового hostname (`beer-api.*`)
  достатньо додати роут у дашборді — без перезапуску `cloudflared`.
