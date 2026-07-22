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
│   │   └── pub.ts          # парсер сторінки паба + extractBeerName
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
| `city` | TEXT | nullable (v14) | обране місто; `NULL` → `DEFAULT_CITY` (`'warszawa'`) |

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
| `search_url` | TEXT | NOT NULL | людиночитний debug-URL, побудований `buildSearchUrl` (перша brewery-частина) — зручно відкрити для ручної перевірки; **реальний запит йде через Algolia API**, а не цю HTML-сторінку |
| `outcome` | TEXT | NOT NULL CHECK IN (`not_found`,`blocked`) | результат провалу |
| `candidates_count` | INTEGER | NOT NULL | скільки кандидатів повернув пошук (0 = зашумлений запит) |
| `candidates_summary` | TEXT | NOT NULL | топ-3 `"<brewery> — <name>"`, `;`-joined (порожньо для blocked) |
| `fail_count` | INTEGER | NOT NULL DEFAULT 1 | скільки разів провалився (++ на upsert) |
| `last_at` | TEXT | NOT NULL | час останнього провалу (ISO) |
| `source_url` | TEXT | NOT NULL DEFAULT '' | URL сторінки магазину, з якої прийшла ця пара brewery/name; заповнюється лише client-relay (`/enrich/result` з `pageUrl`); серверний крон пише `''` (URL невідомий) |
| `review_class` | TEXT | nullable CHECK IN (`parser_bug`,`matcher_bug`,`not_on_untappd`,`wontfix`) | клас тріажу після ручного розгляду; `NULL` = ще не розмічено; `parser_bug` — НАШ адаптер зіпсував інакше чистий рядок (криво розбита пивоварня/назва, обрізання, HTML-сміття, merch/скло/вино/їжа); зіпсований лістинг самої крамниці (типоси в її даних) — НЕ parser_bug; `matcher_bug` — пиво правдоподібно є на Untappd, але ми промахнулись: alias-геп, розбіжність назв, або шум у запиті, який треба лише нормалізувати перед пошуком; `not_on_untappd` — відсутнє на Untappd; `wontfix` — навмисно без матчингу |
| `review_note` | TEXT | nullable | довільна нотатка тріажу (агент або адмін) |
| `reviewed_at` | TEXT | nullable | час розмітки (ISO); виставляється ендпоінтом `POST /admin/enrich-failures/review` |
| `retired_at` | TEXT | nullable (міграція 18) | термінальний стан для класифікованого провалу, чия причина вже усунена (відповідний фікс задеплоєно). Виставляється ops-тулою `retire-resolved-orphans`. Рядок **зберігає** початковий `review_class` (для аудиту); `review_note` доповнюється причиною |

**Retirement (`retired_at`).** Класифіковані рядки провалів залишаються в БД назавжди (видаляються лише на `matched`), тож уже вирішені кластери (вино/спирт тепер фільтруються, brewery=name #238 тощо) продовжують виглядати «активними» й роздувати лічильник orphan'ів. `retire-resolved-orphans` (npm-скрипт, dry-run за замовчуванням, `--apply`) переводить **доказово вирішені** рядки в `retired_at`. Вибір — лише верифікований, ніколи за віком чи класом: **авто-шлях** бере класифікованих orphan'ів, яких поточний `isOntapNonBeerTap` тепер відкидає (доказ вирішення); **escape-hatch `--ids <csv> --reason "<text>"`** — явно задані оператором `beer_id` (для фіксів, яких предикат не ловить — напр. `VINO KARPATIA` italian-`vino`, або parse-split кластери після шипу фіксу). Retired-рядки виключені з enrich-пулу (`listLookupCandidates`, поряд із `wontfix`) та з лічильника `orphansPending` у щоденному дайджесті.

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

### `/beers <паб>` — діагностика кранів (аргумент обов'язковий)
Показує **всі** крани одного паба з останнього snapshot **без** had-списку й
фільтрів. Формат: `{№} • {Пивоварня Назва} [• {стиль, якщо відомий}] • {ABV} • {рейтинг} • {🟢|⚪}`,
де 🟢 = `beers.untappd_id IS NOT NULL` (назва — клікабельне посилання
`https://untappd.com/beer/<id>`, що відкриває застосунок Untappd), ⚪ = orphan.
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
**`/city`.** Inline-клавіатура курованих міст; вибір зберігається в
`user_profiles.city` (валідація `isKnownCity`; невідомий slug ігнорується). Команди
`/pubs`, `/route`, `/newbeers`, `/beers` фільтрують паби за активним містом користувача
(`getUserCity` → `listPubs(db, city)`); усі, хто не обрав місто (вкл. наявних
користувачів), бачать Варшаву. Каталог пива, рейтинги, drunk-статус і розширення/`/match`
лишаються глобальними (міста-незалежними).

### `/status` — статус і налаштування користувача

Особиста зведена картка (HTML, локалізована uk/pl/en). Дві секції:

**Налаштування (завжди):** активне місто, мова інтерфейсу, короткий
однорядковий підсумок фільтрів (стилі / мін. рейтинг / ABV / N маршруту), з
підказкою `/filters` для редагування.

**Untappd / синхронізація:**
- якщо не прив'язано — підказка `/link` (+ `/import`), без статистики;
- якщо прив'язано — username, `synced` чекінів (із `/ profile_total`, коли
  відомо; ✅ коли `synced ≥ profile_total`), к-сть унікального
  випитого пива, дата останнього чекіна (або підказка `/import` / розширення,
  якщо чекінів немає).

Свідомо НЕ показує жодного обчисленого «треба переімпортувати» — обидва числа
показуються, користувач робить висновок сам. Закриває #147 та #93.

### `/refresh [частина назви паба]` — примусове оновлення
Без аргументу: обхід ontap.pl **усіх курованих міст** (`CITIES`, #146 — пабів і час
масштабуються з кількістю міст) **+** скрейп untappd-профілів. З аргументом: лише крани матчених пабів (untappd-скрейп
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
Пошуковий запит enrich'у будується через `cleanSearchQuery` (collab-aware: колапсує
`COLLAB_SEP`-роздільники, стрипить `BREWERY_NOISE` incl. `collab`/`collaboration`, дедуплікує —
див. «Дедуп пошукового запиту» нижче); у `lookupBeer` кожна колаб-частина пивоварні ще й
розбивається `brewerySearchParts` ДО виклику, щоб не ANDити обидві пивоварні.
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

**Brand-as-beer-name (#138B).** Якщо кандидат провалює і strict, і relaxed гейт пивоварні, але вхідна
пивоварня (бренд на полиці) є суцільним токен-підсписком **назви пива** кандидата (Untappd веде пиво під
материнською компанією — `Murphy's` → `Heineken Ireland — Murphy's Irish Stout`), він матчиться **лише** на
точний перетин name-keys, порахованих із вхідної назви **без зрізання пивоварні** (`nameKeys(name, '')` — бренд
лишається в ключі). Бренд-в-назві гейт обовʼязковий: без нього дві неповʼязані пивоварні зі спільною назвою
пива матчились би лише за назвою. Ніколи fuzzy; оцінюється після strict/relaxed (реальний збіг пивоварні завжди виграє).

#### `POST /enrich/candidates` / `POST /enrich/result` — client-relay Untappd enrichment

Auth like `/match`. `/enrich/candidates` приймає `{beers:[{brewery,name}]}`, апсертить
кожне нове пиво як orphan (`untappd_id` NULL) і повертає `{candidates:[{brewery,name,
eligible,algolia}]}`, де `eligible` = backoff-due (`isEligible`), пиво ще orphan і **не** `wontfix`.
`algolia` містить публічні параметри `{appId,searchKey,indexName:"beer",query,hitsPerPage}`; `query`
будується через `cleanSearchQuery(brewery,name)` і лишається серверним контрактом.
Розширення, якщо користувач увімкнув opt-in і дав runtime-дозвіл `untappd.com` + `*.algolia.net`, робить
браузерний `POST https://{appId}-dsn.algolia.net/1/indexes/beer/query` з цими параметрами
та публічними Algolia headers, а потім шле JSON hits у `/enrich/result`.
`/enrich/result` приймає `{brewery,name,algolia,pageUrl?}` (`pageUrl` — опційна URL сторінки магазину,
зберігається як `source_url` в `enrich_failures`), проганяє `parseAlgoliaResponse(algolia)` через
наявний `lookupBeer` pipeline і застосовує спільний `applyLookupOutcome`. Legacy `{html}` payload
зберігається як сумісний fallback через `htmlSearch`, але основний relay-контракт — Algolia JSON.
Логіка `applyLookupOutcome`:
matched → `recordLookupSuccess` (bid+рейтинг; UNIQUE-клеш → merge у канонічний рядок),
not_found → `recordLookupNotFound` (backoff++), blocked → НІЧОГО не пише в backoff (блок
ніколи не мутує backoff). Той самий orphan-пул і backoff, що й у серверного enrich-крона —
клієнт лише дозбирює видиме й due.

**Лог провалів (дебаг).** Обидва канали (крон + client-relay) через `applyLookupOutcome`
upsert'ять рядок у `enrich_failures` (§3.13) на `not_found`/`blocked` — вхід + `search_url`
+ summary кандидатів, self-cleared на `matched`. Це робить орфани дебажними без ручного
відтворення/прикладання HTML до ішьюзу (бо Untappd-пошук відтворюється без кукі — досить
`search_url`). Backoff це НЕ зачіпає: `blocked` пише лише debug-рядок, не `untappd_lookup_*`.

**Дедуп пошукового запиту (#126).** Запит Untappd-пошуку будується через `cleanSearchQuery(brewery, name)`:
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
Body:    {"query": "<cleanSearchQuery>", "hitsPerPage": 5}
```
`appId` і `searchKey` — публічні клієнтські ключі (задокументовані дефолти в коді: `9WBO4RQ3HO` /
`1d347324…`), перевизначаються через опційні env-змінні `UNTAPPD_ALGOLIA_APP_ID` /
`UNTAPPD_ALGOLIA_SEARCH_KEY`.

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
interface BeerSearch { search(query: string): Promise<SearchResult[]> }
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
`not_on_untappd`, `wontfix`; `note` — опційний рядок.

**Відповіді:** `200 { status: "reviewed", beer_id, review_class }` — розмітка збережена; `400` — невалідний або
відсутній `review_class`; `401` — токен невалідний або відсутній;
`404` — `beer_id` не знайдено в `enrich_failures`; `503` — `ADMIN_API_TOKEN` не задано.

Повторний `recordEnrichFailure` на тому самому пиві скидає `review_class`/`review_note`/
`reviewed_at` до `NULL` **лише коли `candidates_count` перетинає межу `0 ↔ >0`** — тоді рядок
знову з'являється в тріажі; інакше класифікація зберігається (§3.13).

### Фонові джоби (node-cron, у процесі)
| Джоба | Розклад | Призначення |
|-------|---------|-------------|
| `refreshOntap` | `0 */12 * * *` | обхід ontap.pl → non-beer gate → snapshots → match |
| `refreshAllUntappd` | `0 3 * * *` | скрейп профілів → checkins/untappd_had (лише якщо є cookie) |
| `enrichOrphans` | `30 */3 * * *` | lookup orphan-beers у Untappd (LIMIT 20/запуск) |
| `refreshTapRatings` | `30 1,4,7,10,13,16,19,22 * * *` | дотягування рейтингів кранів (offset 1 год від enrich) |
| `cleanupOldSnapshots` | `0 5 * * *` | видалення `tap_snapshots` старших за `SNAPSHOT_RETENTION_DAYS` (default 14); latest-per-pub завжди зберігається |
| `dailyStatus` | `*/15 * * * *` | health-дайджест адміну. UTC-тік; джоба сама шле раз на варшавську добу у вікні `[09:00, 12:00)` Europe/Warsaw, ідемпотентно за `job_state.daily_status_last_sent` (лише якщо є `ADMIN_TELEGRAM_ID`). Раніше `0 9 * * * {tz}` — timezone-тік node-cron виявився ненадійним. Дайджест включає секцію **Enrich**: `enrichMatched24h` зматчених orphan'ів, `enrichFailures24h` провалів, індикатор здоров'я Untappd-пошуку (`untappdSearchHealthy` = останній canary ok І breaker не відкритий). Рядок «Розширення /match (вчора)»: усього запитів, з них анонімних, і сума пив за **останню повну варшавську добу** (з таблиці `api_usage`, §3.15). Нулі показуються, якщо трафіку не було |

**Startup-джоби** (`src/index.ts`, до launch): `dedupeBreweryAliases`
(злиття дублів каталогу), `cleanupPollutedOntap` (чистка «брудних» назв) і
`cleanupOldSnapshots` (прунінг старих snapshot'ів — той самий код, що й
щоденний крон) — усі ідемпотентні (no-op на чистій БД).
Додатково після `bot.launch()` один раз викликається `dailyStatus` (catch-up:
якщо бот був недоступний о 09:00, але піднявся в межах ранкового вікна — дайджест
виходить одразу; ідемпотентний за `job_state`).

**Багатомісто (#146).** `refreshOntap` проходить по курованому списку міст
(`src/domain/cities.ts`, `CITIES`) — для кожного `GET https://ontap.pl/<slug>`,
парсить індекс (`parseOntapCityIndex`, спільний DOM) і проставляє паба `pubs.city =
<slug>`. Невдале завантаження індексу міста логується й пропускається (інші міста
скрейпляться далі). Інлайн-енрич свіжих орфанів обмежений **бюджетом на запуск**
(`inlineEnrichBudget`, дефолт 20) — решта добирається rate-limited `enrich-orphans`
кроном (захист від Untappd-бану). schema_version **14** додає `pubs.city`
(`NOT NULL DEFAULT 'warszawa'`) та `user_profiles.city` (nullable; NULL → `DEFAULT_CITY`).

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
- **Ontap non-beer gate.** `refreshOntap` ПОВИНЕН відкидати очевидні не-пивні
  крани (wine/prosecco/frizzante/spritz/cocktails/nalewka/szprycer/kombucha, а також
  brewery_ref-сміття парсера — schedule/nav рядки на кшталт `-> … od 18.00`) **до**
  створення snapshot/tap рядків, matcher/upsert orphan і enrich. Загальні сигнали gate —
  `taps.style` і `taps.brewery_ref`; `beer_ref`/назва використовується лише для
  нормалізованого точного sentinel `kran w serwisie` (case- і whitespace-insensitive),
  без substring/fuzzy-фільтрації, щоб не провокувати широкі Untappd-запити на кшталт
  `wino`/`merlot`. Cider, kvass/`Kwas chlebowy`
  /`квас` і mead/melomel лишаються eligible і не blacklist-яться цим правилом.
- `/newbeers` без beer-фільтрів може показувати orphan-и, але завжди відкидає
  порожні `N/A`; з активним style/rating/ABV-фільтром показує лише пива з
  реальним `untappd_id`. Маршрут завжди відкидає orphan-и.
- `/beers` — навпаки, показує **все сире**, без фільтрів і had-списку (діагностика).
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
  (`domain/lookup-backoff.ts`, `BACKOFF_HOURS = [0, 72, 168, 728]`): 4 спроби,
  після чого orphan **термінально dormant** (`isEligible` → false назавжди,
  поки `untappd_lookup_count` не скинуто). Орфани з `enrich_failures.review_class
  = 'wontfix'` повністю виключені з пулу кандидатів (`listLookupCandidates`).
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
доповнення до людського рев'ю, не заміна. **Архітектуру замінено 2026-06-19
(#143 → PR #174): сторонню дію `anc95/ChatGPT-CodeReview` прибрано, рев'ювер тепер
наш власний скрипт.** Дизайн/план:
`docs/superpowers/specs/2026-06-19-ai-pr-review-hardening-design.md`,
`docs/superpowers/plans/2026-06-19-ai-pr-review-hardening.md`.

- **Workflow:** `.github/workflows/codex-review.yml` на подіях PR
  `opened`/`reopened`/`synchronize` (`concurrency` cancel-in-progress; найменші
  права `contents:read / pull-requests:write`) виконує наш `scripts/ai-pr-review.ts`
  через `npx tsx` (після `actions/setup-node` + `npm ci` + `git fetch origin <base>`).
  Секрети: `OPENAI_API_KEY` + `OPENAI_API_ENDPOINT` (=`https://api.openai.com/v1`) +
  вбудований `GITHUB_TOKEN`. Модель `gpt-4o-mini`.
- **Один топ-левел рев'ю, НЕ inline-коментарі.** Скрипт публікує єдине рев'ю
  (`POST .../pulls/{n}/reviews`, `event: COMMENT`, лише `body`) з прихованим
  маркером `<!-- ai-pr-review -->`; на повторних прогонах знаходить попереднє
  маркер-рев'ю і **оновлює його** (PUT), не плодячи нові. Відсутність inline-рядків
  конструктивно усуває старий збій `422 "Line could not be resolved"`.
- **`AGENTS.md` (`.github/ai-review/AGENTS.md`)** — системний промпт рев'ювера
  (персона Senior Backend Security Reviewer; фокус P0/P1: витоки ресурсів, безпека
  транзакцій SQLite і race через `await`, таймаути зовнішнього I/O; anti-focus:
  форматування, назви, type hints у тестах). **Читається скриптом напряму** (більше
  жодної обв'язки `cat` у `$GITHUB_ENV`). Націлений на TS/Node.
- **Fail-loud: скрипт сам володіє exit-кодом.** Немає більше «зелений чек без рев'ю»
  і прибрано окремий крок `Verify review was posted`. Червоно (exit 1): відсутні
  секрети/конфіг; OpenAI впав після 3 ретраїв (429/5xx/мережа; 4xx як 401 — без
  ретраю); пост у GitHub не вдався (помилка містить статус+тіло відповіді). Зелено
  (exit 0): рев'ю опубліковано (зокрема «немає зауважень») або в діфі немає файлів у
  скоупі (skip із `::notice::`). Тож **поповнений** OpenAI-акаунт обов'язковий —
  `429 quota` тепер навмисно валить чек ЧЕРВОНИМ.
- **Скоуп-фільтри `INCLUDE_PATTERNS`/`IGNORE_PATTERNS` — у самому скрипті (одне
  джерело правди), застосовуються через невеликий `globToRegExp`.** Include:
  `src/**/*.ts,tests/**/*.ts,scripts/**/*.ts,extension/**/*.ts,.github/workflows/*.yml`;
  ignore: `package-lock.json,*.md,docs/**`. Діф, що шлеться моделі, обмежено
  100 000 символів (про обрізання сказано в промпті).
- **Зміна будь-чого під `.github/workflows/` вимагає OAuth-scope `workflow`**
  (інакше push → `remote rejected`). Фікс:
  `gh auth refresh -s workflow --hostname github.com`. Same-repo `pull_request`
  виконує workflow з head-гілки, тож зміна workflow само-тестується на власному PR.
- **Відкритий follow-up #175 — ЯКІСТЬ зауважень, не інфраструктура.** `gpt-4o-mini`
  видає low-confidence/галюциновані зауваження попри «prefer no comment over a
  low-confidence comment» в `AGENTS.md` (на #174: 5 зауважень, 0 реальних багів,
  включно з галюцинованим P0). Кандидати: сильніша модель, structured-JSON із
  confidence-фільтром, few-shot негативні приклади в `AGENTS.md`.

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
- LLM класифікує кожен orphan (`parser_bug` / `matcher_bug` / `not_on_untappd` /
  `wontfix`) і кластеризує actionable-класи в патерни: коментар до наявної issue
  або нова issue (**≤3 нових за запуск**; мітки примусово `orphan-triage` +
  `parser-bug`/`matcher-bug`).
- Межа parser/matcher: якщо brewery+name на сторінці крамниці по суті правильні,
  але матч не стався (alias-геп, розбіжність назв, шум у запиті — дужкові adjunct-
  списки, ABV/spec-рядки, collab-дужки, випалі/зайві токени) — це `matcher_bug`;
  якщо сам рядок є хибними даними нашого адаптера — `parser_bug`. Зіпсований лістинг
  самої крамниці (типоси в її даних) адаптер прочитав вірно → `matcher_bug` (якщо
  fuzzy-кандидат міг би врятувати) або `wontfix`, але не `parser_bug`.
- Тіло кожної нової issue завершується рядком `Scope:` з machine-findable фільтром
  (`enrich_failures WHERE review_class='…'`); приклади — «з сьогоднішнього батчу».
  Агент бачить лише поточну вибірку 50 orphans, тож глобальний count НЕ вказується.
- **LLM лише пропонує** — скрипт валідує (клас із CHECK-списку, номер issue з
  відкритого списку, beer_id лише з поточної вибірки, дублікати відкидаються) і
  виконує. Порядок на orphan: спочатку GitHub, потім запис
  `review_class`/`review_note` у БД; збій GitHub лишає orphan нетріаженим на завтра.
- Класи `not_on_untappd`/`wontfix` — тихі: лише запис у БД, без GitHub. Людське
  рішення відбувається на рівні GitHub-issues, не сирих помилок.
- **Порожні/неповні вердикти:** якщо LLM повертає **порожній** список вердиктів на
  непорожній батч — один негайний повтор `analyze`; якщо і він порожній (жоден
  orphan з батчу не покритий) — запуск завершується `error` у digest
  («Тріаж: помилка (LLM повернув 0 вердиктів …)»), orphans лишаються нетріаженими
  на завтра. Часткова нестача (покрито менше, ніж у батчі) — лише `warn`-лог, батч
  обробляється штатно.
- Провайдер/модель конфігуруються: `TRIAGE_LLM_PROVIDER` (`anthropic`|`openai`),
  `TRIAGE_LLM_MODEL` (дефолт `claude-opus-4-8`), ключі `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`, `GITHUB_TOKEN` + `GITHUB_REPO`. Відсутній ключ = джоба
  вимкнена (не падає), що видно в digest. Опційний `TRIAGE_LOG_DIR` вмикає архів
  сирого LLM-I/O кожного запуску (`${TRIAGE_LOG_DIR}/<дата>.json`, ротація 30
  файлів, best-effort); не заданий ⇒ архів вимкнено.
- Результат запуску — рядок у daily-status digest (через `job_state`,
  ключ `orphan_triage_last_result`): «Тріаж: 7 нових → 2 до #228, 1 нова #232,
  3 not_on_untappd, 1 пропущено», або «помилка (…)» / «вимкнено (…)».
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
  відомий display-prefix brewery
  видаляється з name, leading `ПРЕДРЕЛІЗ`/`ПРЕДРЕДІЗ`/`ПРОБНИК:` labels теж;
  volume-gate: пиво завжди містить об'єм в ml/л/l, non-beer без об'єму
  відкидається; ABV із `%` у title), домен `flasker.com.ua`), `piwnemosty`
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
  `kofola/kombucha/vita aloe`), URL колекції (`hoptimaal`), або **гейт цілої
  категорії** через опційний `SiteAdapter.isNonBeerPage(url)` — overlay пропускає сторінку
  повністю тільки коли broad skip не може сховати eligible cider/mead/kvass. Kvass/`квас`/
  `Kwas chlebowy` є eligible категорією і не фільтрується ні shared helper'ом, ні
  шоп-локальними фільтрами, ні page-gate'ами. FP-гарди: банка з заставою
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

### 6.1 Дистрибуція бета-версій (off-store, через бота)
> ⚠️ **Legacy на час переходу (#247).** Це початковий off-store канал. Основним став
> Chrome Web Store — див. §6.4; цей канал працює **паралельно лише під час переходу** і
> ретайриться на cutover (#267).
> Приватна роздача ~10 технічним тестерам; **без Chrome Web Store** (рев'ю,
> публічність, зайве навантаження на Untappd). Дизайн:
> `docs/superpowers/specs/2026-06-08-extension-beta-distribution-design.md`,
> рунбук: `docs/extension-release.md`.

- **Бейджі.** Питі беври (exact-матч) — `✅` + особиста оцінка. Каталожні беври, які
  користувач ще не пив, але мають `untappd_id` і глобальний рейтинг — `⭐` + глобальна
  оцінка Untappd. Fuzzy-матч пива з drunk-set (`drunk_uncertain: true`) — `❓` +
  глобальний рейтинг (якщо є; «ймовірно випите, без певності»). Усі бейджі клікабельні: `✅`/`❓`/`⭐` ведуть на сторінку беври в Untappd
  (`https://untappd.com/beer/<untappd_id>`), а якщо `untappd_id` ще немає —
  на пошук Untappd із підставленою назвою (`brewery name`). Зматчені орфани
  (без `untappd_id`) показуються як `⚪` і ведуть на той самий пошук.
  Незматчені (`matched_beer` null) — без бейджа.
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

### 6.2 Store/dev варіанти збірки (підготовка до Chrome Web Store)
> Серія `chrome-web-store` (#242–247). Дизайн: `docs/superpowers/specs/2026-07-08-cws-icons-store-manifest-design.md`.

- **Дві збірки з однієї кодової бази.** `manifest.config.ts` — фабрика
  `buildManifest({ store })`; `default export` читає `process.env.CWS_BUILD`.
  Dev (за замовч., `npm run build`/`package`/`release`) — незмінний off-store канал.
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

### 6.4 Дистрибуція: перехід на Chrome Web Store (#247)
> Рішення серії `chrome-web-store`. Дизайн: `docs/superpowers/specs/2026-07-10-cws-distribution-migration-design.md`. Cutover-дії → #267; автоматизація аплоаду → #266.

- **Модель — перехідний період, потім повний перехід.** **Chrome Web Store — основний**
  канал: CWS **сам авто-оновлює** користувачів. Off-store bot-канал (§6.1) стає **legacy** і
  працює **паралельно лише на час переходу**, поки тестери мігрують; після cutover — ретайр.
- **Store extension ID:** `fdelmnhijeiojadcaihfdpecfcldbndg` (item подано на рев'ю 2026-07-10;
  версія 0.11.0). Store-збірка **без `key`**, тож CWS присвоює цей ID сам (див. §6.2).
- **Наслідок зміни ID.** Store-ID **відрізняється** від `key`-pinned ID unpacked-збірки, а
  `chrome.storage.local` прив'язаний до ID → у store-версії сховище **порожнє**: тестер має
  **заново вставити токен** в Options і видалити unpacked-версію.
- **Реліз під час переходу — обидва канали.** Нова версія = `npm run package:store` → **ручний**
  аплоад у CWS dashboard (автоматизація відкладена, #266) **та** `npm run release` (off-store dev
  zip + bot-broadcast, §6.1) для тестерів, що ще на unpacked. Після cutover лишається лише перший.
- **Dev/maintainer.** Unpacked-збірка з `key` лишається як локальний dev-режим мейнтейнера.
- **Cutover (#267):** коли store-версія стане LIVE — розіслати міграційне повідомлення (нижче),
  витримати grace-період, тоді ретайрити off-store канал (`extension_releases` §3.12 + broadcast).

**Міграційне повідомлення тестерам (чернетка, розсилка на cutover, #267):**
> 📦 «Warsaw Beer Overlay» тепер у Chrome Web Store! Постав офіційну версію звідти:
> https://chromewebstore.google.com/detail/fdelmnhijeiojadcaihfdpecfcldbndg — вона
> оновлюватиметься автоматично. Після встановлення: відкрий **Options** і **встав токен
> заново** (у версії зі стору сховище порожнє — новий ID розширення) → перевір **Test
> connection** → **видали стару unpacked-версію** з `chrome://extensions`. Питання — пиши боту.

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
  `cleanSearchQuery` (продакшн-будівник
  пошукового запиту; `stripBreweryNoise` збережено, але не в гарячому шляху) додатково
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
