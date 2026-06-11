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
| Тести | **Jest** + **ts-jest** | unit + контрактні тести |

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
│   │   └── pub.ts          # парсер сторінки паба + extractBeerName
│   └── untappd/
│       ├── export.ts       # streaming-парсер експорту (CSV/JSON/ZIP)
│       ├── scraper.ts      # свіжі чекіни з /user/<u>/beers
│       ├── search.ts       # пошук пива в каталозі Untappd
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
| `reviewed_by_user` | INTEGER | NOT NULL DEFAULT 0 | прапор ручної ревізії |

> ⚠️ **Gotcha:** `untappd_beer_id` — це **локальний `beers.id`**, а не Untappd-id;
> він заповнений навіть для orphan-рядків. Реальний статус матчингу читати з
> `beers.untappd_id`, не з наявності match-link.

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

### 3.12 `extension_releases` — релізи браузерного розширення (v9)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `version` | TEXT | NOT NULL PRIMARY KEY | semver релізу (напр. `0.2.0`) |
| `sha256` | TEXT | NOT NULL | hex-дайджест zip (пишеться збіркою) |
| `notes` | TEXT | NOT NULL | тіло секції CHANGELOG (пишеться збіркою) |
| `file_id` | TEXT | nullable | Telegram `file_id` для перешилання; NULL поки адмін не завантажить |
| `published_at` | TEXT | NOT NULL DEFAULT CURRENT_TIMESTAMP | час запису рядка |
| `attached_by` | INTEGER | nullable | telegram_id адміна, що прикріпив `file_id` |

**Хто що пише:** `version`/`sha256`/`notes` — збірка (`npm run release`);
`file_id`/`attached_by` — бот, коли адмін надсилає zip і його sha256 збігається з
останнім рядком. «Остання» версія — за semver (числове порівняння, не лексичне).

### 3.13 `enrich_failures` — лог провалів енричу (v10)
| Поле | Тип | Обмеження | Опис |
|------|-----|-----------|------|
| `beer_id` | INTEGER | PK → `beers(id)` **ON DELETE CASCADE** | один рядок на пиво |
| `brewery` | TEXT | NOT NULL | сирий вхід (як прийшов) |
| `name` | TEXT | NOT NULL | сирий вхід |
| `search_url` | TEXT | NOT NULL | побудований запит (перша brewery-частина) — відкрити для відтворення |
| `outcome` | TEXT | NOT NULL CHECK IN (`not_found`,`blocked`) | результат провалу |
| `candidates_count` | INTEGER | NOT NULL | скільки кандидатів повернув пошук (0 = зашумлений запит) |
| `candidates_summary` | TEXT | NOT NULL | топ-3 `"<brewery> — <name>"`, `;`-joined (порожньо для blocked) |
| `fail_count` | INTEGER | NOT NULL DEFAULT 1 | скільки разів провалився (++ на upsert) |
| `last_at` | TEXT | NOT NULL | час останнього провалу (ISO) |
| `source_url` | TEXT | NOT NULL DEFAULT '' | URL сторінки магазину, з якої прийшла ця пара brewery/name; заповнюється лише client-relay (`/enrich/result` з `pageUrl`); серверний крон пише `''` (URL невідомий) |

**Хто що пише:** `applyLookupOutcome` (спільний для серверного крона і client-relay)
upsert'ить рядок на `not_found`/`blocked` і **видаляє** його на `matched`. Один рядок на
пиво (upsert по `beer_id`), розмір обмежений поточним набором orphan'ів. Untappd-пошук
відтворюваний без кукі, тож `search_url` достатньо для дебагу. `source_url` (URL
сторінки магазину) дозволяє відкрити першоджерело і перевірити, чи parser-баг
(адаптер прочитав назву/пивоварню криво) чи matcher-баг; заповнюється лише
client-relay (`/enrich/result`), серверний крон пише `''`. Запит:
`SELECT … FROM enrich_failures ORDER BY last_at DESC` — «0 кандидатів» = зашумлений запит;
«N, але not_found» = brewery-gate / name-fuzzy відсік (видно по `candidates_summary`).
Покроковий дебаг-ранбук: `docs/debug-orphan-matching.md`.

### 3.14 `schema_version` — версія міграцій
Єдине поле `version INTEGER PRIMARY KEY`; по рядку на застосовану міграцію.

### 3.15 Зв'язки (ER, текстом)
```
user_profiles 1───* checkins        (telegram_id)
user_profiles 1───1 user_filters    (telegram_id, CASCADE)
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

### 3.16 Історія міграцій
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

---

## 4. User Flows / Commands

> Усі user-facing рядки йдуть через `ctx.t(...)` (i18n: uk/pl/en).
> Мова визначається з `from.language_code` (ru/be → en) і persist'иться у
> `user_profiles.language`; `/lang` дозволяє override.
> Усі команди наразі stateless (без Telegraf scenes).

### `/start` та `/help` — реєстрація + довідник команд
`/start` створює профіль (ключ — `telegram_id`; ідемпотентно) і друкує довідку.
`/help` друкує **той самий** текст без сайд-ефектів. Джерело тексту —
`buildHelpText` з `src/bot/commands/catalog.ts`: `COMMAND_CATALOG` (єдиний
впорядкований список усіх команд) + i18n-описи `cmd.*` / `help.intro`.
Локалізовано (uk/pl/en).

Нативне меню Telegram («/») заповнюється на старті через
`registerCommandMenu` (`src/bot/register-command-menu.ts`): `setMyCommands` для
`uk`/`pl`/`en` + дефолтний англійський scope, з того ж каталогу. Збій
`setMyCommands` лише логується (`warn`), старт не падає.

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
5. форматування HTML (`newbeers-format.ts`): жирна назва + ⭐ рейтинг + ABV-чіп,
   до 3 пабів + «+N інших».

Показуються лише **зматчені** крани. Vintage-логіка: збіг ABV із найсвіжішим
роком → «пите». З аргументом обмежує паби за підрядком назви (case-insensitive).

### `/pubs` — алфавітний список пабів
Усі відомі боту паби. Корисно, щоб дізнатися точне написання для аргументу
`/newbeers <назва>` / `/beers <назва>`.

### `/beers <паб>` — діагностика кранів (аргумент обов'язковий)
Показує **всі** крани одного паба з останнього snapshot **без** had-списку й
фільтрів. Формат: `{№} • {Пивоварня Назва} • {ABV} • {рейтинг} • {🟢|⚪}`,
де 🟢 = `beers.untappd_id IS NOT NULL`, ⚪ = orphan. Дизамбіґуація паба: за назвою,
потім за адресою; кілька кандидатів → перші 3, без угадування.

### `/route [N]` — пішохідний маршрут
Будує маршрут, що покриває **≥ N** непитих пив, мінімізуючи сумарну дистанцію.
`N` ← аргумент → `user_filters.default_route_n` → `env.DEFAULT_ROUTE_N` (=5).
**Під капотом (`domain/router.ts`):**
1. `interesting(p)` для кожного паба з останнього snapshot;
2. жадібний **set-cover** ≥ N → `S₀`;
3. **локальна оптимізація** заміною пабів під дистанцію;
4. **open-TSP** на `|S| ≤ ~8` (DP за бітмасками), без фіксованих кінців.

Дистанції: кеш `pub_distances` → один OSRM `/table` на пропуски → per-pair
`/route` / **haversine** fallback. **Жорстких лімітів немає** — дистанція й
кількість пабів завжди в хедері. **Fire-and-forget** + throttled
`editMessageText` (обхід `handlerTimeout` 90 c).

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

### `/refresh [частина назви паба]` — примусове оновлення
Без аргументу: обхід ontap.pl (~50 пабів послідовно, ~3 хв) **+** скрейп
untappd-профілів. З аргументом: лише крани матчених пабів (untappd-скрейп
пропускається) + одразу `/newbeers <той самий запит>`.
**Кулдаун:** повний — 5 хв/користувача; скоупнутий — 30 c.
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
      "user_rating": null
    }
  ]
}
```
`matched_beer: null` — пиво не зматчено в каталозі. `is_drunk` — two-source
drunk-model (`checkins ∪ untappd_had`) для власника токена (§5.2).
`user_rating` — особиста оцінка з `checkins` (або `null`). Серверна
помилка → `500 { error: "internal" }`.

**Name-keys матчинг (order/collab-aware, #117).** Збіг назв — це перетин **множин
канонічних ключів** (`nameKeys`, `matcher.ts`): назва ріжеться на `COLLAB_SEP`-сторони
(`/`, ` x `, ` & `), кожна нормалізується, зрізається продубльована провідна пивоварня,
сторони з **< 2 токенів** відкидаються (слабкі ключі), решта — сортуються по токенах
(нечутливо до порядку). Це робить exact-стадію `matchPrepared` стійкою до перестановки
слів (`TAP04 Festweisse` ↔ `Festweisse (TAP04)`), колаб-партнера в назві
(`Fast Talking / North Park` ↔ `Fast Talking`) і двомовних назв Untappd
(`Free Tchyně / Free Mother In Law`) — лишаючись настільки ж FP-безпечною, як exact
(рівність множин, не підмножина). Однотокенні назви цілком (`Kanelbullar`) дають порожній
key-set і матчаться звичайним fuzzy. `lookupBeer` має ту саму key-стадію (2a) перед
fuzzy (2b). Пошуковий запит enrich'у будується collab-aware `stripBreweryNoise` (стрипить
`collab`/`collaboration` і колапсує колаб-роздільники, щоб не ANDити обидві пивоварні).

**Гейтинг сильних заяв.** Fuzzy-кандидат відхиляється, якщо нормалізована назва
розходиться з інпутом по контентних токенах (різні смакові варіанти одного базового
пива — fuzzy-покриття токенів, тож відмінки/опечатки лишаються матчем). `is_drunk` і
`user_rating` проставляються **лише для exact-матчів** (key-перетин рахується exact);
fuzzy-матч дає `matched_beer` (тобто глобальний рейтинг), але ніколи не заявляє
«пите»/особисту оцінку.

#### `POST /enrich/candidates` / `POST /enrich/result` — client-relay Untappd enrichment

Auth like `/match`. `/enrich/candidates` приймає `{beers:[{brewery,name}]}`, апсертить
кожне нове пиво як orphan (`untappd_id` NULL) і повертає `{candidates:[{brewery,name,
eligible,searchUrl}]}`, де `eligible` = backoff-due (`isEligible`) і пиво ще orphan.
`/enrich/result` приймає `{brewery,name,html,pageUrl?}` (обрізана клієнтом сторінка Untappd-пошуку; `pageUrl` — опційна URL сторінки магазину, зберігається як `source_url` в `enrich_failures`),
проганяє наявний `lookupBeer` з `fetch=()=>html` і застосовує спільний `applyLookupOutcome`:
matched → `recordLookupSuccess` (bid+рейтинг; UNIQUE-клеш → merge у канонічний рядок),
not_found → `recordLookupNotFound` (backoff++), blocked → НІЧОГО не пише в backoff (блок
ніколи не мутує backoff). Той самий orphan-пул і backoff, що й у серверного enrich-крона —
клієнт лише дозбирює видиме й due.

**Лог провалів (дебаг).** Обидва канали (крон + client-relay) через `applyLookupOutcome`
upsert'ять рядок у `enrich_failures` (§3.13) на `not_found`/`blocked` — вхід + `search_url`
+ summary кандидатів, self-cleared на `matched`. Це робить орфани дебажними без ручного
відтворення/прикладання HTML до ішьюзу (бо Untappd-пошук відтворюється без кукі — досить
`search_url`). Backoff це НЕ зачіпає: `blocked` пише лише debug-рядок, не `untappd_lookup_*`.

### Фонові джоби (node-cron, у процесі)
| Джоба | Розклад | Призначення |
|-------|---------|-------------|
| `refreshOntap` | `0 */12 * * *` | обхід ontap.pl → snapshots → match |
| `refreshAllUntappd` | `0 3 * * *` | скрейп профілів → checkins/untappd_had (лише якщо є cookie) |
| `enrichOrphans` | `30 */3 * * *` | lookup orphan-beers у Untappd (LIMIT 20/запуск) |
| `refreshTapRatings` | `30 1,4,7,10,13,16,19,22 * * *` | дотягування рейтингів кранів (offset 1 год від enrich) |
| `cleanupOldSnapshots` | `0 5 * * *` | видалення `tap_snapshots` старших за `SNAPSHOT_RETENTION_DAYS` (default 14); latest-per-pub завжди зберігається |
| `dailyStatus` | `0 9 * * *` | щоденний health-дайджест адміну (лише якщо є `ADMIN_TELEGRAM_ID`) |

**Startup-джоби** (`src/index.ts`, до launch): `dedupeBreweryAliases`
(злиття дублів каталогу), `cleanupPollutedOntap` (чистка «брудних» назв) і
`cleanupOldSnapshots` (прунінг старих snapshot'ів — той самий код, що й
щоденний крон) — усі ідемпотентні (no-op на чистій БД).

**Untappd circuit breaker (in-memory).** `enrichOrphans` і `refreshTapRatings`
гейтяться спільним in-memory circuit breaker. Сигнали блокування на non-cookie
шляху — HTTP 403/429 **або** captcha/login-сторінка (Cloudflare-маркери). При
блокуванні breaker відкривається на 6 год (потім half-open probe); джоби в цей
час пропускають запуск. Алерти адміну лише на переходах: trip (`closed→open`) і
recovery (`open→closed`). Стан скидається на рестарті. Cookie-джоба
(`refreshAllUntappd`) не гейтиться — має власний `CookieExpiredError`-шлях.

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
- `/newbeers` показує **лише зматчені** крани; orphan'и приховані до енричу.
- `/beers` — навпаки, показує **все сире**, без фільтрів і had-списку (діагностика).
- Маршрут — **open-TSP без жорстких лімітів**; дистанцію завжди показувати явно.
- **Блок ≠ not_found.** Виявлений блок Untappd (403/429/captcha) **ніколи** не
  записується як `not_found`/`transient` і не змінює backoff-стан beer'а — він
  лише трипить circuit breaker. Інакше captcha-вікно тихо «ховає» реальні пива.

### 5.3 Тестування (CLAUDE.md)
- **Кожен новий модуль логіки покривається базовими Jest-тестами перед злиттям.**
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
  `ADMIN_TELEGRAM_ID`.
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
  не били Untappd одночасно; lookup має експоненційний backoff
  (`domain/lookup-backoff.ts`).
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
доповнення до людського рев'ю, не заміна.

- **Workflow:** `.github/workflows/codex-review.yml` — `anc95/ChatGPT-CodeReview@main`
  на події PR `opened` + `synchronize`. Найменші права:
  `permissions: contents:read / pull-requests:write`. Секрети: `OPENAI_API_KEY`
  (репо-секрет) + вбудований `GITHUB_TOKEN`.
- **`AGENTS.md` (корінь репо)** — системний промпт рев'ювера (персона
  Senior Backend Security Reviewer; фокус P0/P1: витоки ресурсів/незакриті
  потоки, безпека транзакцій SQLite і race-умови через `await`, таймаути й
  обробка помилок зовнішнього I/O; anti-focus: форматування, назви, type hints у
  тестах). **Націлений на TS/Node** — згадка «Python» у постановці хибна (див.
  корекцію стеку на початку файлу).
- **Дія НЕ читає `AGENTS.md` нативно.** Файл підвантажується в рантаймі: крок
  `actions/checkout` + `cat AGENTS.md` у `$GITHUB_ENV`, далі передається як
  `PROMPT`. (Справжня інтеграція OpenAI Codex читала б `AGENTS.md` напряму й
  зняла б цю обв'язку.)
- **Кост-гард `MAX_PATCH_LENGTH: 8000`** — `PROMPT` шлеться **по файлу**, тож
  великі генеровані/vendored-діфи пропускаються, щоб не множити токени. Це
  **per-file skip-поріг**, а не контекст-ліміт: рев'ювер розглядає кожен файл
  окремо незалежно від цього числа (тюнінг порога FP не прибирає).
- **`IGNORE_PATTERNS: package-lock.json`** — лок-файли повністю виключені з
  рев'ю (інакше дають лише шумні «validate your deps»). Кома-розділені glob'и
  (minimatch + regex-fallback), матчаться по шляху файла (`anc95 src/bot.ts`).
- **Зміна будь-чого під `.github/workflows/` вимагає OAuth-scope `workflow`**
  (інакше push → `remote rejected`). Фікс:
  `gh auth refresh -s workflow --hostname github.com`.
- **Дія ковтає помилки OpenAI і все одно репортить job `success`.** `429`/auth-збій
  → **жодного рев'ю при зеленому чеку**. Робочий ознака — лише **опублікований
  коментар бота**, не галочка CI. Потрібен **поповнений** OpenAI-акаунт
  (перший прогін упав на `429 quota exceeded`).

**Відомі хибні спрацювання рев'ювера (контекст, якого він не має).** PROMPT
шлеться по файлу, тож рев'ювер не бачить решти діфа (зокрема тестів) і не знає
рантайму. Це — навмисні конвенції, НЕ зауваження до виправлення. **Більшість із них тепер явно закодовані в
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
- **Кожен модуль логіки має колоковані `*.test.ts`.** «Немає тестів для X»
  зазвичай означає, що рев'ювер не отримав діфа тест-файлу (per-file PROMPT), а не
  що тестів немає.

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
  `beerfreak.org`), `bierloods22` (Bierloods22 SSR — `.product-block`,
  пивоварня з **brand-префіксу** `a.title[title]` (`"{brand} {title}"` → `brand = attr − text`;
  кількість ` - `-сегментів brand'у задає межу пивоварні, тож пивоварні з внутрішнім ` - `
  типу `Kykao - Handcrafted` парсяться правильно; порожній brand → фолбек split по першому
  ` - `), домен `bierloods22.nl`), `winetime` (WineTime SSR — `a.product-micro`,
  brewery/name з `window.initialData.category.products` metadata keyed by
  `data-productkey`, fallback на видимий title/brewery, ABV опускається,
  домен `winetime.com.ua`), `hoptimaal` (Hoptimaal Shopify SSR — `.product-item`,
  назва з `.product-item__product-title`, brewery з vendor-фільтрів або агресивного
  title-prefix fallback, ABV із subtitle; Beer Club/Merch/Spirits/Bundles виключаються),
  домен `hoptimaal.com`). `registry.pickAdapter(url)`.
  Опційний `reRenderContainerSelector` —
  **звуження скоупу re-parse**, НЕ вмикач re-render (див. нижче). Як додати
  адаптер: `docs/adapter-authoring.md`.
- **Потік:** content script парсить видиму сітку → short-TTL кеш
  (`chrome.storage.local`) → промахи йдуть у background service worker, який
  тримає Bearer-токен (**ніколи** не в контексті сторінки) і б'є `POST /match` →
  бейдж ✅+оцінка на випитих. **Re-render однаковий для всіх адаптерів:** overlay
  позначає оброблені картки (`data-beerseen`), а спостерігач на `document.body`
  перезапускає `runOverlay` щойно серед розпарсених карток з'являється непозначена
  (навігація / SPA ре-маунт / infinite-scroll); кеш дедуплікує повторні матчі.
- **Auth:** токен з команди `/extension` зберігається в `chrome.storage.local`;
  base URL редагований (дефолт `https://beer-api.ysilvestrov-ai.uk`, §5.9);
  options-сторінка має Test connection (`GET /health` + 1-beer `/match`).
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

### 6.1 Дистрибуція бета-версій (off-store, через бота)
> Приватна роздача ~10 технічним тестерам; **без Chrome Web Store** (рев'ю,
> публічність, зайве навантаження на Untappd). Дизайн:
> `docs/superpowers/specs/2026-06-08-extension-beta-distribution-design.md`,
> рунбук: `docs/extension-release.md`.

- **Бейджі.** Питі беври — `✅` + особиста оцінка. Каталожні беври, які користувач ще
  не пив, але які мають `untappd_id` і глобальний рейтинг — `⭐` + глобальна оцінка
  Untappd. Будь-який бейдж із `untappd_id` клікабельний: відкриває сторінку беври на
  Untappd (`https://untappd.com/beer/<untappd_id>`) у новій вкладці. Орфани (без
  `untappd_id`/рейтингу) і незматчені — без бейджа.
- **Збірка — єдине джерело метаданих.** Версія береться з `extension/package.json`
  (маніфест імпортує її; `key` у маніфесті фіксує ID розширення → токен переживає
  переустановку). `npm run release` = build → `RELEASE_NOTES.txt` (тіло секції
  `CHANGELOG.md`; білд падає, якщо секції нема) → `warsaw-beer-overlay-<v>.zip` →
  запис рядка `extension_releases` (version, notes, sha256) у БД бота → стейджинг
  zip у `~/extension-releases/`. Zip **детермінований** (сортовані записи, фіксований
  mtime), тож повторний реліз тієї ж версії дає той самий sha (upsert-no-op). Запис у
  прод-БД адаптивний: in-process, якщо БД писабельна; інакше — через вузький
  привілейований applier (`deploy/bin/apply-extension-release.sh` + NOPASSWD-sudoers),
  бо прод-БД належить сервісному юзеру. Рунбук: `docs/extension-release.md`.
- **Бот zip не парсить.** Адмін пересилає zip боту лише щоб Telegram видав
  `file_id`; бот рахує sha256 й звіряє з останнім рядком `extension_releases`
  (§3.12), при збігу зберігає `file_id` і пропонує двокрокову розсилку
  (📣 Розіслати / Скасувати). Хендлер `on('document')` стоїть **перед** `/import`
  і пропускає (next) усе, що не є адмінським релізним zip.
- **Розсилка** йде всім власникам `api_tokens` (тим, хто робив `/extension`),
  кожному його мовою, стійко до збоїв доставки (підсумок «надіслано X, помилок Y»).
  `/extension` також віддає актуальний прикріплений реліз новим тестерам.
- **Оновлення в тестера:** розпакувати новий zip поверх тієї ж теки + `↻ reload`
  (Chromium не авто-оновлює off-store розширення — прийнятно для техаудиторії).

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
  `COLLAB_SEP`-split → нормалізація сторони → зріз провідної пивоварні → **drop сторін
  з < 2 токенів** → токени відсортовані. Збіг = непорожній перетин (рівність множин,
  order/collab-aware, FP-безпечно як exact). Однотокенні назви цілком → порожній set →
  fuzzy-фолбек. Використовується в exact-стадії `matchPrepared` (key-перетин = exact,
  отже несе drunk/personal-заяви) і в `lookupBeer` Stage 2a (перед fuzzy 2b).
- `BREWERY_NOISE` стрипить дескриптори пивоварні багатьма мовами (`browar`,
  `brewery`, `contracts`, `collab`/`collaboration`, `pivovar`, `brauerei`, `brasserie`,
  `birrificio`, `brouwerij`, `bryggeri`, `cerveceria`, …); `stripBreweryNoise` додатково
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
  `enrichOneOrphan` передає `beer.abv` у `lookupBeer`.
- Збережений `normalized_brewery` — ключ ідемпотентності upsert; при зміні правил
  нормалізації перераховується на старті (`backfill-normalized-brewery.ts`).
  `idx_beers_norm` НЕ unique, тож перерахунок не кидає constraint.
- `createShutdown` отримує опційний `httpServer`; якщо він є — закривається між
  зупинкою бота і закриттям БД. Порядок: cron → bot → http → db → exit.
- Cloudflare-тунель token-managed: роути (`public hostname`) живуть у дашборді
  Zero Trust, **не** в локальному `config.yml`. Для нового hostname (`beer-api.*`)
  достатньо додати роут у дашборді — без перезапуску `cloudflared`.
