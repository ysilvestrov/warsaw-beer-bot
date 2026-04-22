# Warsaw Beer Crawler Bot — дизайн-документ

> Статус: **брейнстормінг завершено**. Усі Q1–Q4 закриті (див. §13).
> Наступний крок — `writing-plans`.

## 1. Огляд продукту

Telegram-бот, який допомагає користувачам (multi-user, рішення Q4) знайти
**цікаве непите пиво** у Варшаві та побудувати **оптимальний пивний маршрут**
між пабами, де воно зараз налите на крані.

Ключова цінність: перетин двох джерел — «що зараз наливають у місті» (ontap.pl)
та «що я вже пив» (Untappd) — автоматично оновлюється, ранжується за рейтингом,
приземляється в маршрут.

## 2. Ключові дані та сутності

| Сутність       | Джерело                      | Ключові поля |
|----------------|------------------------------|--------------|
| `Beer`         | Untappd / ontap.pl           | `id_untappd?`, `name`, `brewery`, `style`, `abv`, `rating_global`, `aliases[]` |
| `Checkin`      | Untappd export + scraper     | `checkin_id` (merge key), `telegram_id`, `beer_id`, `user_rating`, `checkin_at`, `venue?` |
| `Pub`          | ontap.pl                     | `slug` (=`id_ontap`), `name`, `address`, `lat`, `lon` |
| `TapSnapshot`  | ontap.pl                     | `snapshot_at`, `pub_id` |
| `Tap`          | ontap.pl (snapshot-scoped)   | `snapshot_id`, `pub_id`, `beer_ref` (raw ontap string), `abv?`, `ibu?`, `style?`, `u_rating?` |
| `UserProfile`  | локально                     | `telegram_id`, `untappd_username?`, `default_filters` |
| `UserFilter`   | локально                     | `telegram_id`, `styles[]`, `min_rating`, `abv_min`, `abv_max`, `default_route_n` |
| `MatchLink`    | обчислювана                  | `ontap_beer_ref → untappd_beer_id`, `confidence`, `reviewed_by_user` |

## 3. Модульна структура

```
src/
├── sources/            # збір даних (pure I/O)
│   ├── ontap.ts        # парсер ontap.pl (Warsaw)
│   ├── untappd/
│   │   ├── export.ts   # імпорт CSV-експорту
│   │   └── scraper.ts  # свіжі чекіни з веб-профілю
│   └── geocoder.ts     # адреса → координати (fallback)
├── domain/             # бізнес-логіка (pure functions)
│   ├── matcher.ts      # ontap-пиво ↔ untappd-пиво
│   ├── filters.ts      # «нове для мене», ранжування, стиль/ABV
│   └── router.ts       # побудова оптимального маршруту
├── storage/            # SQLite (репозиторії)
│   ├── schema.ts       # DDL + міграції
│   ├── beers.ts
│   ├── checkins.ts
│   ├── pubs.ts
│   ├── snapshots.ts    # tap_snapshots + taps
│   ├── match_links.ts
│   ├── user_profiles.ts
│   └── user_filters.ts
├── bot/                # Telegram (Telegraf)
│   ├── index.ts
│   ├── commands/
│   └── keyboards.ts
├── jobs/               # планувальник (node-cron)
│   ├── refresh-ontap.ts
│   └── refresh-untappd.ts
├── config/
│   └── env.ts          # zod-валідація .env
└── index.ts            # composition root
```

**Принципи:**
- I/O (sources, storage, bot) відокремлені від чистої логіки (domain).
- Весь стейт у SQLite; in-memory тільки кеш у межах одного запиту.
- `.env` читається **один раз** у `config/env.ts` і передається як залежність.

## 4. Потоки даних

### 4.1 Оновлення каталогу кранів
```
cron → sources/ontap → normalize → storage/snapshots
                                 → storage/pubs (upsert)
                                 → storage/beers (upsert ontap side)
                                 → domain/matcher → storage/match_links
```

### 4.2 Оновлення історії користувача
```
manual /import  → sources/untappd/export   → storage/checkins
cron/on-demand  → sources/untappd/scraper  → storage/checkins (merge by checkin_id)
```

### 4.3 Запит «покажи щось нове»
```
bot /newbeers → domain/filters(latest_snapshot, checkins, user_filters)
             → ранжування за rating_global
             → формат повідомлення + інлайн-кнопки
```

### 4.4 Запит маршруту
```
bot /route N → domain/filters: interesting(p) для кожного пабу з останнього snapshot
            → domain/router: greedy set-cover ≥ N → local-swap під дистанцію → open-TSP
            → distance-matrix (OSRM public / haversine fallback)
            → Telegram: список пабів + непитих пив у кожному + «≈ X км, Y пабів»
```

## 5. Модуль: Збір даних

### 5.1 ontap.pl (рішення Q2 — HTML-парсинг через cheerio)

**Розвідка показала**: сайт — статичний HTML, жодного API, `__NEXT_DATA__`,
`ld+json` або microdata. SSR-фреймворків немає.

Двошаровий обхід:
1. **Index**: `https://ontap.pl/warszawa` — список ~40+ пабів, кожен — посилання
   на сабдомен (`<slug>.ontap.pl`). Дає: назва пабу, к-сть кранів, час останнього
   оновлення, slug.
2. **Сторінка пабу**: `https://<slug>.ontap.pl/` — 1 сторінка на паб, пагінації
   немає. Дає:
   - Паб: адреса, координати (дістаються з href на maps.google), назва.
     Телефон і години роботи **відсутні** (фіксуємо як обмеження).
   - Кран (~21 елемент): номер, пивоварня + назва пива, країна (прапор), ABV,
     IBU, стиль, час на крані, рейтинг (з префіксом `u:` = Untappd, `rb:` = RateBeer).
   - Ціна, об'єм, прямий untappd-id — **відсутні** → матчинг по назві обов'язковий.

Використовуємо `cheerio`. Фікстури: HTML-снепшоти `tests/fixtures/ontap/*.html`,
контрактні тести падають при зміні верстки.

- Rate limit: консервативно 1 req / 2s, єдина черга `p-queue`, User-Agent з контактом.
- Snapshot-модель: кожне витягнення зберігається як окремий `tap_snapshot`,
  поточні крани — view над останнім snapshot. Це дає історію «що коли лилось».
- Бонус: `u:rating` з ontap уже є → для ранжування можемо не тягнути Untappd
  додатково.

### 5.2 Untappd
Офіційне API фактично закрите для нових клієнтів з ~2020 → два канали (рішення Q1):
- **Експорт CSV** (`sources/untappd/export.ts`): разовий масовий бекфіл історії.
  Користувач вивантажує файл і заливає боту командою `/import`.
- **Скрапер публічної сторінки** (`sources/untappd/scraper.ts`): парсинг
  `https://untappd.com/user/{username}/beer`, тягнути останні **25** чекінів
  як інкрементальне оновлення. Без session cookie — профіль має бути публічним
  (перевіряємо на старті й кажемо користувачу, якщо ні).
  - Ключ у `UserProfile`: `untappd_username`.
  - Merge у `storage/checkins` за `checkin_id` (ідемпотентно).
  - Частота: cron кожні **24 год** + ручний `/refresh`.

### 5.3 Геокодер
- **Primary**: координати беруться прямо з ontap.pl (href на Google Maps
  містить `lat`/`lon`).
- **Fallback**: Nominatim (OSM), якщо ontap.pl не дав координат — 1 rps, кеш,
  User-Agent з контактом.
- Результати зберігаються у `pubs.lat/lon`; не чіпаємо, якщо вже заповнено.

## 6. Модуль: Матчинг пива

Найризикованіший шматок. На ontap.pl назви часто неканонічні («Pinta AIPA»
проти «Piwne Podziemie — Atak Pinty»). Стратегія каскадом:

1. Нормалізація: lowercase, видалення діакритики, стоп-слів (`IPA`, `Imperial`…).
2. Точний матч `(brewery, name)` → `confidence = 1.0`.
3. Fuzzy (token-set ratio, напр. `fast-fuzzy` / `fuse.js`) з порогом 0.85.
4. Все нижче — у чергу «manual review» і питання до користувача через бот.

Збереження: таблиця `match_links(ontap_ref, untappd_id, confidence, reviewed_by_user)`.

## 7. Модуль: Побудова маршруту

**Критерій (рішення Q3b).** Вхід: `N` — цільова кількість цікавих непитих пив.
Знайти підмножину пабів `S` таку, що `|⋃ interesting(p) for p ∈ S| ≥ N`,
і серед усіх таких `S` мінімізувати довжину open-TSP обходу через `S`.

Двофазний алгоритм (усе локальне, без OR-бібліотек):

1. **Відбір кандидатів.** `interesting(p)` = пиво на крані в `p`, яке (а) не є
   в чекінах користувача і (б) проходить user-фільтри (стиль, min_rating, ABV).
2. **Set-cover жадібно**: поки покриття < N — додавати паб з найбільшою
   маржинальною кількістю нових непитих пив. Дає початкову `S₀`.
3. **Локальна оптимізація під дистанцію**: для кожного `p ∈ S₀` пробуємо замінити
   на `p' ∉ S₀` так, щоб покриття лишалось ≥ N, а довжина обходу зменшувалась.
   Зупиняємось у локальному мінімумі.
4. **Open-TSP на |S| ≤ ~8**: брутфорс або DP за бітмасками (O(|S|²·2^|S|)).

Граф: `distance_matrix[i][j]` — пішохідна відстань через OSRM public API
(`router.project-osrm.org` або self-host), haversine як fallback при збої.

Граничні випадки:
- «цікавих у місті < N» → повертаємо best-effort і попереджаємо користувача.
- `/route` без аргументу → дефолтне `N` (наприклад, 5; константа в `config`).

**Жорстких лімітів (рішення Q3c)** на кількість пабів чи сумарну дистанцію
**не вводимо**. Якщо це породжує маршрут на 12 пабів і 20 км — так і віддаємо,
явно підсвічуючи загальну дистанцію у відповіді, щоб користувач бачив масштаб.
Повідомлення формує маршрут + рядок `≈ X.X км, Y пабів` у хедері.

Години роботи пабів недоступні з ontap.pl → **поза MVP**.

## 8. Модуль: Telegram

Команди (мінімальний набір для MVP):
- `/start` — інструкція, посилання на імпорт.
- `/import` — прийняти CSV від Untappd.
- `/link <username>` — прив'язати публічний Untappd-профіль (без cookie).
- `/newbeers [стиль] [min_rating]` — топ новинок за поточним snapshot.
- `/route N` — зібрати маршрут, що покриває ≥ `N` цікавих непитих пив, з мінімальним пішим обходом.
- `/filters` — інлайн-клавіатура для стилів / ABV / рейтингу.
- `/refresh` — примусове оновлення snapshot (з rate-limit на користувача).

Стан розмови: FSM на рівні Telegraf scenes.

## 9. Зберігання (SQLite)

Одна БД-файл, WAL-режим. Міграції — простим `migrate` скриптом (kysely
або власний runner, вирішимо на етапі плану).

Основні індекси:
- `beers(untappd_id)`, `beers(normalized_name)`
- `checkins(beer_id)`, `checkins(telegram_id)`
- `tap_snapshots(snapshot_at)`, `taps(snapshot_id, pub_id)`
- `match_links(ontap_ref)`.

## 10. Інфраструктура

- Runtime: Node ≥ 20, TS strict.
- Тести: Jest, кожний модуль `domain/*` покритий unit-тестами (вимога CLAUDE.md).
  Для `sources/*` — контрактні тести на фікстурах (HTML/CSV у `tests/fixtures`).
- Конфіг: `.env` + `zod` валідація, з окремим `.env.example`.
- Логування: `pino` (JSON).
- **Користувачі (Q4a)**: multi-user, відкритий доступ. Профіль створюється
  автоматично при першому `/start`, ключ — `telegram_id`. Усі таблиці
  користувацьких даних (`checkins`, `user_filters`, `user_profiles`) мають
  FK на `telegram_id`.
- **Деплой (Q4b)**: Hetzner CX33 (той самий сервер, на якому ведеться розробка).
  - Runtime: Node ≥ 20 під systemd-юнітом (`warsaw-beer-bot.service`).
  - `.env` — у `/etc/warsaw-beer-bot/.env`, `chmod 600`.
  - SQLite-файл — у `/var/lib/warsaw-beer-bot/bot.db` (WAL-режим).
  - Cron — всередині процесу через `node-cron`:
    - `refresh-ontap` — кожні **12 год** (дані на ontap.pl оновлюються нечасто);
    - `refresh-untappd` — кожні **24 год** на користувача, зсувно по часу.
  - Логи — `pino` у stdout → journald.
  - Оновлення — git pull + `npm ci` + `systemctl restart`; деплой-скрипт
    пишемо одразу.

## 11. Нефункціональні вимоги

- **Стійкість до змін HTML** ontap.pl: парсер інкапсульований, контрактні тести
  на фікстурах ловитимуть регрес.
- **Не DDoS-ити джерела**: єдина черга `p-queue` на всі зовнішні HTTP + кеш.
- **Приватність**: `TELEGRAM_BOT_TOKEN` — єдиний чутливий секрет у `.env`
  (session cookie Untappd не використовуємо, рішення Q1). `.env` не в логах.
  Дані чекінів — персональні: зберігаються на тому ж Hetzner-хості, не
  експортуються назовні.

## 12. Ризики

| Ризик | Вплив | План Б |
|-------|-------|--------|
| Untappd міняє HTML / блокує скрейпер | високий | fallback лише на CSV-експорт + ручне оновлення |
| Untappd-профіль приватний → скрейпер бачить 0 чекінів | середній | валідація на `/link`, повідомлення користувачу, відкат на CSV |
| ontap.pl не має даних по частині пабів | середній | допускаємо ручне додавання пабу |
| Matcher має багато false-positives | середній | threshold + manual review через бот |
| Nominatim / OSRM rate-limit | низький | кеш + self-host при рості |

## 13. Рішення по відкритих питаннях

| # | Питання | Рішення |
|---|---------|---------|
| Q1 | Канал збору Untappd-даних | CSV-імпорт (`/import`) + скрейпер публічної сторінки `untappd.com/user/<u>/beer`, останні 25 чекінів інкрементально. Без session cookie. |
| Q2 | ontap.pl API чи HTML | Чистий HTML-парсинг через cheerio. API/JSON на сайті немає. Координати з Google-Maps href, Untappd-рейтинг уже в HTML. |
| Q3a | Старт/фініш маршруту | Не фіксується — бот повертає оптимальну послідовність (open TSP). |
| Q3b | Критерій оптимальності | Покриття ≥ N цікавих непитих пив, серед таких підмножин — мінімізуємо пішу дистанцію (жадібний set-cover + локальна оптимізація + open-TSP). |
| Q3c | Ліміти маршруту | Жодних жорстких лімітів. Підсвічуємо сумарну дистанцію в повідомленні. |
| Q4a | Multi-user? | Multi-user, відкритий доступ. `telegram_id` — FK у всіх користувацьких таблицях. |
| Q4b | Деплой | Hetzner CX33, systemd + SQLite в `/var/lib/...` + `.env` в `/etc/...` + `node-cron` у процесі. |
