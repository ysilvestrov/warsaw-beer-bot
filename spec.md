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
├── index.ts                # composition root: env → db → migrate → bot → cron → shutdown
├── shutdown.ts             # graceful teardown (cron → bot → db → exit)
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
│   ├── schema.ts           # DDL + версіоновані міграції (v1..v7)
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
│       ├── filters.ts  lang.ts  refresh.ts
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
> після міграцій **v1–v7**.

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

### 3.11 `schema_version` — версія міграцій
Єдине поле `version INTEGER PRIMARY KEY`; по рядку на застосовану міграцію.

### 3.12 Зв'язки (ER, текстом)
```
user_profiles 1───* checkins        (telegram_id)
user_profiles 1───1 user_filters    (telegram_id, CASCADE)
user_profiles 1───* untappd_had     (telegram_id)
beers         1───* checkins         (beer_id)
beers         1───* untappd_had      (beer_id, CASCADE)
beers         1───* match_links      (untappd_beer_id = LOCAL beers.id)
pubs          1───* tap_snapshots    (pub_id)
tap_snapshots 1───* taps             (snapshot_id, CASCADE)
pubs          *───* pubs             via pub_distances (a<b)
```

### 3.13 Історія міграцій
| v | Зміст |
|---|-------|
| 1 | базова схема: beers, pubs, tap_snapshots, taps, checkins, match_links, user_profiles, user_filters |
| 2 | `pub_distances` (кеш OSRM) |
| 3 | `user_profiles.language` (i18n) |
| 4 | `untappd_had` (two-source drunk model) |
| 5 | `beers.untappd_lookup_at` + `untappd_lookup_count` (lookup backoff) |
| 6 | `beers.rating_refresh_at` + `rating_refresh_count` (rating refresh) |
| 7 | reset lookup-backoff для orphan'ів (`untappd_id IS NULL`) — переенрич |

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

### Фонові джоби (node-cron, у процесі)
| Джоба | Розклад | Призначення |
|-------|---------|-------------|
| `refreshOntap` | `0 */12 * * *` | обхід ontap.pl → snapshots → match |
| `refreshAllUntappd` | `0 3 * * *` | скрейп профілів → checkins/untappd_had (лише якщо є cookie) |
| `enrichOrphans` | `30 */3 * * *` | lookup orphan-beers у Untappd (LIMIT 20/запуск) |
| `refreshTapRatings` | `30 1,4,7,10,13,16,19,22 * * *` | дотягування рейтингів кранів (offset 1 год від enrich) |
| `cleanupOldSnapshots` | `0 5 * * *` | видалення `tap_snapshots` старших за `SNAPSHOT_RETENTION_DAYS` (default 14); latest-per-pub завжди зберігається |

**Startup-джоби** (`src/index.ts`, до launch): `dedupeBreweryAliases`
(злиття дублів каталогу), `cleanupPollutedOntap` (чистка «брудних» назв) і
`cleanupOldSnapshots` (прунінг старих snapshot'ів — той самий код, що й
щоденний крон) — усі ідемпотентні (no-op на чистій БД).

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
  → закриття БД → `process.exit(0)`, щоб не SIGKILL'нутись на чистому WAL-flush.

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
  `UNTAPPD_LOOKUP_ENABLED` (=true), `UNTAPPD_SESSION_COOKIE`, `ADMIN_TELEGRAM_ID`.
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
- `BREWERY_NOISE` стрипить дескриптори пивоварні багатьма мовами (`browar`,
  `brewery`, `pivovar`, `brauerei`, `brasserie`, `birrificio`, `brouwerij`,
  `bryggeri`, `cerveceria`, …) — інакше brewery hard-gate валить валідний матч
  (напр. `Pivovar Černá Hora` ↔ `Cerna Hora Brewery`). Зміна списку міняє
  `normalized_brewery` → `dedupeBreweryAliases` може злити нові дублі на старті.
