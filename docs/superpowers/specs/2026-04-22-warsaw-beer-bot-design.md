# Warsaw Beer Crawler Bot — дизайн-документ

> Статус: **MVP у проді (v1.0, 2026-04-25)**. Бот живе на Hetzner CX33 під systemd.
> Усі Q1–Q4 закриті (див. §13). Розділ §14 фіксує операційні уроки після першого деплою.
> Команди для кінцевого користувача — у [`docs/USER-GUIDE.md`](../../USER-GUIDE.md).

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
| `UserProfile`  | локально                     | `telegram_id`, `untappd_username?`, `language?` (`uk`/`pl`/`en`, авто-детект на першому апдейті), `default_filters` |
| `UserFilter`   | локально                     | `telegram_id`, `styles[]`, `min_rating`, `abv_min`, `abv_max`, `default_route_n` |
| `MatchLink`    | обчислювана                  | `ontap_beer_ref → untappd_beer_id`, `confidence`, `reviewed_by_user` |
| `PubDistance`  | OSRM (кеш)                   | `(pub_id_a < pub_id_b)`, `meters`, `source` (`osrm`/`haversine`), `updated_at` |

## 3. Модульна структура

```
src/
├── sources/            # збір даних (pure I/O)
│   ├── ontap.ts        # парсер ontap.pl (Warsaw)
│   ├── untappd/
│   │   ├── export.ts   # streaming-парсер експорту (CSV / JSON / ZIP)
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
│   ├── pub_distances.ts # кеш OSRM-дистанцій між пабами
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
  (CSV / JSON / ZIP — streaming + batched transactions)
cron/on-demand  → sources/untappd/scraper  → storage/checkins (merge by checkin_id)
```

### 4.3 Запит «покажи щось нове»
```
bot /newbeers → для кожного пабу: latest_snapshot → tapsForSnapshot
                                → filterInteresting(taps, drunk, user_filters)
             → groupTaps  (ключ: match_links.untappd_beer_id, fallback на
                          (normalized_brewery, normalized_name))
             → rankGroups (rating desc → pub-count desc → display name)
             → formatGroupedBeers (HTML, top-15, до 3 пабів + "+N інших")
             → ctx.replyWithHTML
```
Один пивний рядок ≈ дві строки: жирне ім'я + ⭐ рейтинг + ABV (`5,5%`),
нижче список пабів. ABV — окремий «чіп», важлива інформація для вибору.
Логіка групування/форматування винесена в чисту `bot/commands/newbeers-format.ts`,
покриту unit-тестами; handler — тонка обгортка.

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
- **Експорт файлом** (`sources/untappd/export.ts`): разовий масовий бекфіл історії.
  Користувач вивантажує файл з Untappd (Supporter → Account → Download History)
  і заливає боту командою `/import`. Формати:
  - `.csv` і `.json` — нативні формати експорту Untappd;
  - `.zip` — архів, який розпаковується на льоту (перший `.csv`/`.json` всередині).
  - Реальні файли бувають великими (спостерігали **15 MB JSON / ~1.9 MB у ZIP**),
    тому парсер — **streaming** (`csv-parse` streaming, `stream-json` для JSON,
    `yauzl` для ZIP). Імпорт у БД — батчами по 500 у `db.transaction`, з
    прогрес-повідомленням у чаті.
  - Telegram Bot API `getFile` обмежений 20 MB — якщо файл більший, бот просить
    перезапакувати у ZIP.
- **Скрапер публічної сторінки** (`sources/untappd/scraper.ts`): парсинг
  `https://untappd.com/user/{username}/beer`, тягнути останні **25** чекінів
  як інкрементальне оновлення. Без session cookie — профіль має бути публічним
  (перевіряємо на старті й кажемо користувачу, якщо ні).
  - Ключ у `UserProfile`: `untappd_username`.
  - Merge у `storage/checkins` за `checkin_id` (ідемпотентно).
  - Частота: cron щодоби о **03:00 UTC** + ручний `/refresh`. (Зсув по
    користувачах не впроваджували — для нинішньої кількості профілів зайве,
    повернемося, якщо лімітатимемось untappd-сторінкою.)

### 5.3 Геокодер
- **Primary**: координати беруться прямо з ontap.pl (href на Google Maps
  містить `lat`/`lon`).
- **Fallback**: Nominatim (OSM), якщо ontap.pl не дав координат — 1 rps, кеш,
  User-Agent з контактом.
- Результати зберігаються у `pubs.lat/lon`; не чіпаємо, якщо вже заповнено.

## 6. Модуль: Матчинг пива

Найризикованіший шматок. На ontap.pl назви часто неканонічні («Pinta AIPA»
проти «Piwne Podziemie — Atak Pinty»). Стратегія каскадом:

1. **Нормалізація** (`domain/normalize.ts`): lowercase, видалення діакритики
   (включно з польським Ł→L), стоп-слів стилю (`IPA`, `Imperial`…), і
   **чисто-цифрових токенів** (`24`, `8`, `2026`). Останнє ловить ABV-залишки
   після base-normalize і vintages у назвах.
2. **Парсер ontap.pl** (`sources/ontap/pub.ts → extractBeerName`) перед матчингом
   витягує канонічну beer_name з h4Text: відсікає все з першого ABV-патерну
   (`\d+(?:[.,]\d+)?\s*[°%]`) і знімає brewery-префікс, якщо він повторюється.
3. **Exact match** по нормалізованому `(brewery, name)`: коли є кілька кандидатів
   (різні vintages у Untappd) — сортуємо `id DESC` і за наявності
   `input.abv` беремо першого з `|c.abv − input.abv| ≤ 0.3`. Якщо ABV-збігу
   нема або ABV не задано — повертаємо найсвіжіший. Confidence = 1.
4. **Fuzzy fallback** (`fast-fuzzy` token-set, поріг **0.75**) серед same-brewery
   pool, інакше повний catalog. Confidence = score.
5. Що нижче порогу — `null`, refresh-job створить новий beers-рядок і `match_link`
   зі score 1 (ми згодні з вибором парсера).

Збереження: таблиця `match_links(ontap_ref, untappd_beer_id, confidence, reviewed_by_user)`.
`untappd_beer_id` — це локальний `beers.id` (історично названо за джерелом).

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

Реалізований набір команд (повний user-facing опис — у
[`docs/USER-GUIDE.md`](../../USER-GUIDE.md)):

- `/start` — реєстрація профілю + інструкція.
- `/link <username>` — прив'язка публічного Untappd-профілю (приймає bare
  username або повний URL `untappd.com/user/<u>`; валідація — у
  `parseLinkArgs`, юніт-тести).
- `/import` — приймає `.csv`/`.json`/`.zip` експорт Untappd до 20 MB
  (Telegram Bot API getFile cap). Streaming-парсер, батчі по 500 у
  `db.transaction`, прогрес-апдейти кожні 2 c через `editMessageText`.
- `/newbeers` — топ-15 цікавих непитих пив, згрупованих по пиву, з HTML-форматуванням
  (див. §4.3).
- `/route [N]` — маршрут, що покриває ≥ N непитих пив; default N береться з
  `user_filters.default_route_n` або `env.DEFAULT_ROUTE_N` (=5). Будує
  walking-distance матрицю по координатах пабів з трирівневою стратегією:
  (1) кеш у `pub_distances` (BD), (2) OSRM `/table` API на пари без кешу
  (один HTTPS-виклик на N×N), (3) per-pair `/route` з haversine-fallback,
  якщо `/table` недоступний. Свіжі значення складуються в `pub_distances`,
  кеш інвалідується на зміну координат паба (`upsertPub`/`setPubCoords`).
  **Fire-and-forget**: handler миттєво відповідає `⏳ Будую маршрут…` і
  відчіплює роботу — навіть з кешем і `/table` cold-старт може дотягуватись
  до handler-timeout 90с. Live-progress через `editMessageText` з тим же
  троттлом 2с, що і `/refresh`.
- `/filters` — інлайн-клавіатура для стилів і `min_rating` (зараз; ABV-фільтри
  є в схемі, але не в кнопках — додати при потребі).
- `/refresh` — примусове оновлення обох пайплайнів. **Fire-and-forget**: handler
  миттєво відповідає `⏳ Оновлюю…` й завершується, фактична робота біжить у
  фоні й оновлює те ж повідомлення через `editMessageText` з троттлом 2с.
  Це обхід Telegraf-вого `handlerTimeout=90s`, який інакше валив би довгі sweep'и.
  Per-user cooldown 5 хвилин зберігається.

Спільний тип `ProgressFn = (text, { force? }) => Promise<void>` (`src/jobs/progress.ts`)
використовується і `/import`, і `/refresh`, і обома refresh-jobs.

Стан розмови: поки що без Telegraf scenes — усі команди stateless, FSM додамо
лише якщо з'явиться багатокрокова взаємодія.

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
| Untappd міняє HTML / блокує скрейпер | високий | fallback лише на файловий експорт (CSV/JSON/ZIP) + ручне оновлення |
| Untappd-профіль приватний → скрейпер бачить 0 чекінів | середній | валідація на `/link`, повідомлення користувачу, відкат на файловий експорт |
| ontap.pl не має даних по частині пабів | середній | допускаємо ручне додавання пабу |
| Matcher має багато false-positives | середній | threshold + manual review через бот |
| Nominatim / OSRM rate-limit | низький | кеш + self-host при рості |

## 13. Рішення по відкритих питаннях

| # | Питання | Рішення |
|---|---------|---------|
| Q1 | Канал збору Untappd-даних | Файловий імпорт (`/import`: CSV / JSON / ZIP, streaming + батчі, ≤ 20 MB через Telegram) + скрейпер публічної сторінки `untappd.com/user/<u>/beer`, останні 25 чекінів інкрементально. Без session cookie. |
| Q2 | ontap.pl API чи HTML | Чистий HTML-парсинг через cheerio. API/JSON на сайті немає. Координати з Google-Maps href, Untappd-рейтинг уже в HTML. |
| Q3a | Старт/фініш маршруту | Не фіксується — бот повертає оптимальну послідовність (open TSP). |
| Q3b | Критерій оптимальності | Покриття ≥ N цікавих непитих пив, серед таких підмножин — мінімізуємо пішу дистанцію (жадібний set-cover + локальна оптимізація + open-TSP). |
| Q3c | Ліміти маршруту | Жодних жорстких лімітів. Підсвічуємо сумарну дистанцію в повідомленні. |
| Q4a | Multi-user? | Multi-user, відкритий доступ. `telegram_id` — FK у всіх користувацьких таблицях. |
| Q4b | Деплой | Hetzner CX33, systemd + SQLite в `/var/lib/...` + `.env` в `/etc/...` + `node-cron` у процесі. |

## 14. Операційні уроки (post-MVP)

Зібрано з фіксів після першого on-host smoke (PRs #8, #9, #12, #14, #15):

- **`enable --now` ≠ `restart`**. На вже запущеному unit'і `systemctl enable --now`
  нічого не перезапускає. `deploy.sh` тепер робить `enable` + явний `restart`
  (PR #15). Симптом до фіксу: бот віддає старий код навіть після успішного rsync+build.
- **rsync `-a` зберігає власника source'а (root)**. Деплой має зробити `chown -R`
  на робочу директорію після rsync, інакше `npm ci` як `warsaw-beer-bot` падає
  з EACCES (PR #8). У README — `useradd -r -m`, бо без `-m` нема `$HOME` і
  npm не може писати кеш/логи.
- **TypeScript у devDependencies**. `npm ci --omit=dev` пропускає `tsc` →
  `npm run build` падає на хості. Деплой тепер: `npm ci` → `npm run build` →
  `npm prune --omit=dev` (PR #9). На диску результат еквівалентний прод-only
  встановленню, але крок збірки має чим запуститись.
- **Telegraf `handlerTimeout` = 90 с**. Для будь-якого handler'а, що чекає на
  довгу зовнішню роботу (refresh = ~3 хв на 43 паби; route = ~7 хв на 30
  пабів через 435 OSRM-викликів) треба fire-and-forget +
  `editMessageText` через захоплені `ctx.telegram` + `chatId` + `messageId`
  (PR #14 для `/refresh`, аналогічний фікс для `/route` пізніше). Інакше
  Telegraf кидає `TimeoutError` у `bot.catch` через 90 c, а користувач у
  Telegram бачить лише початковий «⏳ …».
  - **Зроблено**: OSRM `/table` API + кеш дистанцій у `pub_distances`
    (один HTTPS-виклик замість N²/2; теплий кеш — миттєвий `/route`).
    Інвалідація на зміну `pubs.lat/lon`, fallback per-pair OSRM/haversine
    при недоступності `/table`.
- **`stream-json@2` exports map не додає `.js`-суфікс**. `require('stream-json/streamers/stream-array')`
  розрулюється в неіснуючий файл після pattern substitution. ts-jest пробачає,
  Node — ні. Потрібен явний `.js` (зловлено smoke'ом Task 25).
- **`bot.stop()` не виходить з процесу**. Telegraf зупиняє лише довге опитування,
  але `node-cron` schedules і `better-sqlite3`-handle тримають event loop. Без
  явного teardown systemd чекає `TimeoutStopSec` (за замовчуванням 90 c) і б'є
  SIGKILL — кожен redeploy ризикує брудним flush WAL. Фікс: `createShutdown()`
  зупиняє cron'и → бот → закриває БД → `process.exit(0)`. У unit'і додано
  `TimeoutStopSec=20` як страхувальник.
- **i18n foundation**: усі user-facing рядки тепер ідуть через `ctx.t(...)`.
  `uk.ts` — поки що єдина повна локаль; PL/EN додаються у наступному PR
  (план — `docs/superpowers/specs/2026-04-27-i18n-design.md`). Архітектура —
  `src/i18n/` (types, translator з `Intl.PluralRules`, detect-locale,
  locale-aware fmtAbv/fmtKm) + Telegraf middleware у `src/bot/middleware/i18n.ts`,
  який ставить `ctx.locale` + `ctx.t` на кожний апдейт. Migration v3 додав
  `user_profiles.language` (nullable; авто-детект з `from.language_code` на
  першому апдейті, persist через `setUserLanguage`). `ru` свідомо мапиться на
  `en`. Кнопка `'Скинути'` у `keyboards.ts` свідомо лишилась hardcoded — її
  локалізує PR 2 разом з `/lang`.

Ці грабельки — чек-лист на першу секунду нового деплою.
