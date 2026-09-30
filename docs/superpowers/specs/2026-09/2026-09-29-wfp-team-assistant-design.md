# WFP Team Assistant — спека (фестивальний режим)

> **Статус:** спека на всю зміну. План пишеться стадіями: спершу ядро (§9, стадія 1), після
> його наскрізного рев'ю — окремий план на обв'язку (стадія 2).
> **Вхід:** бриф `WFP Team Assistant (PRD)`; дорожня карта з результатами всіх спайків —
> `2026-09-29-wfp-team-assistant-roadmap-design.md` (далі **ДК**). Кожне твердження про
> зовнішні дані тут спирається на пробу з ДК §3.
> **Фестиваль:** WFP22, стадіон Легії. Сесії (Europe/Warsaw): чт 15.10 16–24, пт 16.10 14–24,
> сб 17.10 12–24. Фріз — ср 14.10.

---

## 1. Що будуємо

Команда друзів іде на фестиваль. Бот має:
1. знати **меню** фестивалю й вибирати з нього **Target-и** — пиво, яке ніхто з команди не пив і
   яке варте уваги;
2. показувати, **що з Target-ів зараз наливають** (за чекінами на локаціях фестивалю) і які
   **броварні** відвідати першими;
3. вести **спільну чергу**: хтось приніс пиво → воно в черзі в усіх → кожен чекіниться в
   Untappd → бот сам бачить чекін і відмічає «випито»;
4. **друкувати етикетку** на келих (номер + пиво + хто), з фолбеком на заздалегідь
   надруковані номерні наліпки;
5. слати **алерт** у груповий чат, коли Target уперше з'являється на крані за сесію.

Ухвалені рішення (ДК §4): бот-перший інтерфейс, груповий чат команди, критерій Target —
«непите всіма ∧ (рейтинг ≥ поріг ∨ стиль із фестивального переліку)», етикетка `№ + пиво + ініціали`.

**Поза скоупом:** TWA, OCR карти, нагадування про борги (stretch, ДК §7); будь-які зміни для
користувачів поза командою фестивалю.

---

## 2. Поняття

| Поняття | Значення |
|---|---|
| **Фест** (`fests`) | Одна edition: назва, часовий пояс, сесії, локації, критерії Target |
| **Сесія** | Проміжок `[start_at, end_at)` одного фестивального дня. «День» для алертів і скидань — це сесія, не календарна дата (сесії закінчуються опівночі) |
| **Вікно опитування** | Сесія ± 30 хв |
| **Локація** | Untappd venue: `11142155` (фестиваль), `2815864` (Centrum Konferencyjne Legia), `2167060` (стадіон) |
| **Меню** | Позиції з блоку меню на сторінці локації фестивалю; кожна з bid |
| **Команда** | Telegram-група + її учасники. Учасник — користувач бота з прив'язаним Untappd (`user_profiles.untappd_username`) |
| **Target** | Позиція меню, яку не пив жоден учасник і яка проходить критерій якості, з урахуванням ручних правок |
| **Око** | Будь-яке джерело чекінів: ноут (HTML), сервер (HTML), friend feed (API через MCP). Усі ведуть в одну точку прийому |
| **Покриття** | Проміжок часу на локації, про який доведено, що ми бачили **всі** чекіни |
| **Черга** | Спільний список принесеного пива команди з номерами келихів |

---

## 3. Дані (міграція 42)

Усі таблиці нові; наявні не змінюються. Час — ISO-8601 UTC, як в інших таблицях.

```sql
CREATE TABLE fests (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,            -- 'wfp22'
  name TEXT NOT NULL,
  menu_venue_id INTEGER NOT NULL,       -- 11142155
  target_min_rating REAL NOT NULL,      -- 3.80
  target_style_patterns TEXT NOT NULL   -- JSON-масив підрядків сирого стилю Untappd (§5)
);
CREATE TABLE fest_sessions (
  fest_id INTEGER NOT NULL REFERENCES fests(id) ON DELETE CASCADE,
  session_no INTEGER NOT NULL,          -- 1..N
  start_at TEXT NOT NULL, end_at TEXT NOT NULL,
  PRIMARY KEY (fest_id, session_no)
);
CREATE TABLE fest_venues (
  fest_id INTEGER NOT NULL REFERENCES fests(id) ON DELETE CASCADE,
  venue_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  feed_path TEXT NOT NULL,              -- '/v/<slug>/11142155/activity' або головна сторінка
  PRIMARY KEY (fest_id, venue_id)
);
CREATE TABLE fest_menu (
  fest_id INTEGER NOT NULL REFERENCES fests(id) ON DELETE CASCADE,
  beer_id INTEGER NOT NULL REFERENCES beers(id),
  section TEXT NOT NULL,                -- назва секції меню як є ('PINTA')
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (fest_id, beer_id)
);
CREATE TABLE fest_stands (
  fest_id INTEGER NOT NULL REFERENCES fests(id) ON DELETE CASCADE,
  section TEXT NOT NULL,                -- ключ = секція меню
  floor TEXT, stand TEXT,
  updated_by INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (fest_id, section)
);
CREATE TABLE fest_teams (
  id INTEGER PRIMARY KEY,
  fest_id INTEGER NOT NULL REFERENCES fests(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (fest_id, chat_id)
);
CREATE TABLE fest_team_members (
  team_id INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE,
  telegram_id INTEGER NOT NULL,
  initials TEXT NOT NULL,               -- для етикетки, редагується
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, telegram_id)
);
CREATE TABLE fest_target_overrides (
  team_id INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE,
  beer_id INTEGER NOT NULL REFERENCES beers(id),
  action TEXT NOT NULL CHECK (action IN ('add','remove')),
  by_telegram_id INTEGER NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (team_id, beer_id)
);
CREATE TABLE venue_checkins (
  checkin_id INTEGER PRIMARY KEY,       -- Untappd checkin_id: дедуп між очима
  venue_id INTEGER NOT NULL,
  bid INTEGER NOT NULL,
  untappd_user TEXT,                    -- NULL, якщо око не бачило автора
  checkin_at TEXT NOT NULL,
  first_eye TEXT NOT NULL CHECK (first_eye IN ('laptop','server','friend_feed')),
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_venue_checkins_venue_at ON venue_checkins (venue_id, checkin_at);
CREATE INDEX idx_venue_checkins_bid_at ON venue_checkins (bid, checkin_at);
CREATE TABLE fest_coverage (
  venue_id INTEGER NOT NULL,
  from_at TEXT NOT NULL, to_at TEXT NOT NULL,   -- доведено: між from_at і to_at бачили все
  eye TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (venue_id, from_at, to_at, eye)
);
CREATE TABLE fest_alerts_sent (
  team_id INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE,
  session_no INTEGER NOT NULL,
  beer_id INTEGER NOT NULL,
  checkin_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (team_id, session_no, beer_id)
);
CREATE TABLE fest_queue (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE,
  glass_no INTEGER NOT NULL,
  beer_id INTEGER NOT NULL REFERENCES beers(id),
  added_by INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  UNIQUE (team_id, glass_no)
);
CREATE TABLE fest_print_jobs (
  queue_id INTEGER PRIMARY KEY REFERENCES fest_queue(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','printed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, error TEXT
);
```

**Свідомо не зберігається:**
- **Автоматичний Target** — обчислюється з меню, історії команди й оверрайдів при кожному
  читанні. Збережений прапорець застаріває, щойно хтось чекіниться або меню змінюється.
- **«Випито»** — обчислюється з `checkins` / `venue_checkins` учасника (§6.4) і показується
  разом із `checkin_id`, що це довів.
- **«На крані»** — обчислюється з `venue_checkins` + `fest_coverage` (§6.2).

Сид фесту WFP22 (сесії, три локації, поріг 3.80, шаблони стилів) — у міграції 42, бо це дані, які
код читає як конфіг, а не як факт про світ. Тест міграції фіксує `version = 42` (правило #701/#708).

---

## 4. Джерела («очі») і точка прийому

### 4.1 Парсер (доробка `src/sources/untappd/checkin-feed.ts`)

- `FeedCheckin` отримує поле `author: string | null`: `p.text a.user` →
  `p.text a[href^="/user/"]`, username з `href`.
- Час: **спершу `a.time[data-gregtime]`, потім текст `a.time`**. У DOM браузера текст
  згорнуто до дати («11 Sep 26»), а атрибут несе RFC-час до секунди (ДК §3.1.1).
  Поведінка для наявних викликів (`/checkins/sync`) не змінюється: для сирого HTML
  атрибута нема, і текст той самий.
- Новий чистий парсер меню `parseVenueMenu(html)` → `{ section, bid, name, brewery, style,
  abv, rating }[]` + `updatedAt`. Джерело — `.menu-section` / `li.menu-item`.

### 4.2 Точка прийому `POST /fest/feed`

Bearer-токен (`api_tokens`, той самий middleware, що в `/match`), дозволено лише учасникам
команди якогось активного фесту. Тіло: `{ venueId, html, fetchedAt, cursor? }`.

Сервер:
1. `isBlockPage(html)` → `502 blocked`, нічого не пише;
2. `venueId ∉ fest_venues` → `400`;
3. парсить, `INSERT OR IGNORE` у `venue_checkins` з `first_eye = 'laptop'`;
4. рахує покриття (§6.1) і пише `fest_coverage`;
5. повертає `{ inserted, seen, stitched, nextCursor }`. `stitched=false` означає, що стику з
   відомими чекінами не знайдено, і око має дочитати наступну сторінку за `nextCursor`.

Серверний поллер кладе дані тим самим шляхом, лише з `first_eye = 'server'`.

### 4.3 Ноут — `scripts/fest-eye.ts` (основне око)

Playwright із **persistent-профілем** і встановленим Chrome (`channel: 'chrome'`). Логін
вручну, заздалегідь. Цикл у вікні опитування:
- `/activity` фестивалю — раз на 3 хв; дві інші локації — раз на 6 хв.
- `page.content()` → `POST /fest/feed`. Якщо `stitched=false` — клік «Show More» (або
  XHR `more_feed`) і повторний `POST`, не більше 3 сторінок за тік.
- Помилка навігації або тайм-аут — пропуск тіку, без падіння (виміряно, ДК §3.1.1).
  Cloudflare-челендж — пауза тіку, лог і звук: людина проходить його у видимому вікні.

Скрипт у репо, але до продакшн-процесу не належить. Залежність — `playwright-core` у
devDependencies. `npm prune --omit=dev` на проді його прибирає, що правильно.

### 4.4 Сервер — `jobs/fest-poll.ts` (резервне око)

Крон `* * * * *`. Сам перевіряє вікно опитування й свій тік:
- Кожні 10 хв — **лише сторінка 1** `/activity` фестивалю через куковий клієнт
  (`on-block`), без пагінації: 5 із 8 запитів отримали 403 (ДК §3.1.3).
- Власний breaker `job_state.fest_poll_open_until`: поріг — 2 блоки поспіль, відкриття на
  30 хв. Кука спільна з `refreshAllUntappd`, тож фестивальний поллер не має права її палити.

### 4.5 Friend feed через MCP — `sources/untappd/mcp-feed.ts`

Клієнт `@modelcontextprotocol/sdk` (Streamable HTTP) до `untappd-mcp-…run.app/mcp`,
інструмент `get_my_friend_feed(minId, limit 50)` на токені власника. Відповідь проходить
zod-схему з мінімальним набором полів (`checkin_id`, `created_at`, `beer.bid`, `venue.venue_id`,
`user.user_name`, `rating_score`).
- Чекіни з `venue_id ∈ fest_venues` → `venue_checkins` (`first_eye = 'friend_feed'`).
- Чекіни учасників команди → `checkins` через наявний `mergeCheckin` (upsert за bid) — для
  пасивного закриття.
- **Власних чекінів власника в стрічці друзів немає** (проба 2026-09-30: `checkin/recent` — це
  «everyone the connected account follows», три записи — троє друзів, жодного свого). Тому на тому
  ж тіку — `get_user_checkins(<власник>, minId)` з окремим курсором
  `job_state.fest_owner_feed_min_id`. Бюджет: 12 + 12 викликів/год плюс рідкі догортання — у межах
  100/год токена.
- **Передумова: кожен учасник команди — друг власника в Untappd.** Інакше його чекінів у стрічці
  немає, і закриття для нього тримається лише на авторських рядках локацій (нижче). Перевіряється
  на репетиції 10–11.10, а не заявляється.
- Форма відповіді (проба 2026-09-30, `limit 3`): `checkins.items[]` з `checkin_id` (число),
  `created_at` (RFC 2822 із секундами — той самий формат, що приймає `feedCheckinTime`),
  `rating_score`, `user.user_name`, `beer.{bid, beer_name, beer_style, beer_abv}`,
  `brewery.brewery_name`, `venue.venue_id`; `pagination.max_id`. Запис без локації Untappd віддає з
  `venue: []` — схема приймає й це.
- Тік кожні 5 хв у вікні опитування; гортати `maxId`, доки не буде стику з курсором
  `job_state.fest_friend_feed_min_id`. Без стику після 4 сторінок — дірка, курсор не
  рухається, алерт адміну.
- **Автентифікація — стандартна MCP OAuth 2.1** (розділ Authorization специфікації MCP), клієнт з
  `@modelcontextprotocol/sdk` 1.30.0: `StreamableHTTPClientTransport({ authProvider })`. SDK сам робить
  discovery (`/.well-known/oauth-protected-resource` → метадані сервера авторизації), dynamic client
  registration і оновлення access token за refresh token.
  - `OAuthClientProvider` бота — файл `FEST_MCP_OAUTH_FILE` (`/var/lib/warsaw-beer-bot/fest-mcp-oauth.json`,
    `600`) з реєстрацією клієнта й токенами; `saveTokens` переписує його атомарно.
  - Разовий інтерактивний вхід — `scripts/fest-mcp-login.ts` на ноуті: loopback-редирект
    `http://localhost:8765/callback`, логін власника тим самим акаунтом, до якого прив'язано Untappd,
    `transport.finishAuth(code)`. Файл переноситься на сервер вручну.
  - На сервері `redirectToAuthorization` **не** відкриває браузер: кидає помилку. Refresh, що не пройшов →
    `UnauthorizedError` → breaker `job_state.fest_mcp_open_until` + алерт адміну «перезапусти
    fest-mcp-login». Пасивне закриття тим часом бере HTML-фолбек нижче.
  - **Проба 2026-09-30 (ноут, SDK 1.30.0). Доведено:**
    - сервер віддає стандартні метадані: `oauth-protected-resource` (зокрема `/mcp`),
      `oauth-authorization-server`; `401` на `/mcp` з
      `WWW-Authenticate: Bearer resource_metadata=…`;
    - DCR (`/oauth/register`), PKCE S256, `authorization_code` + `refresh_token`;
    - вхід власника через Google дав ту саму MCP-ідентичність: `get_my_friend_feed` повернув
      чекін друга (`relationship: friends`);
    - access token живе 3600 с, `refresh_token` видається.
  - **Scope — лише `untappd:read`.** SDK 1.30.0 за замовчуванням просить усі `scopes_supported`
    (`untappd:read untappd:write`) і ставить їх вище за `clientMetadata.scope`. Провайдер бота
    звужує scope в authorization URL до `untappd:read`: бот не має права чекінити чи тостити від
    імені власника.
  - **Refresh доведено (2026-09-30, третій запуск проби):** після природного закінчення access token
    SDK сам надіслав `grant_type=refresh_token`, отримав HTTP 200, зберіг оновлені токени через
    `saveTokens` і прочитав friend feed без браузера. Отже, `saveTokens` мусить атомарно
    переписувати файл: сервер може видати новий refresh token, і старий файл після рестарту бота
    вже не спрацює.
  - **Не виміряно:** скільки живе сам refresh token. Одне оновлення за годину доводить механізм, а
    не те, що файл переживе дні між 07.10 (перенесення на сервер) і 17.10. Тому бот оновлює токен
    щонайменше раз на добу навіть поза фестом (дешевий `get_untappd_api_usage`), а невдача дає
    алерт адміну одразу, а не в день фесту.
    Модуль вмикається змінною `FEST_MCP_URL`; без неї пасивне закриття йде HTML-фолбеком нижче.
- **HTML-фолбек пасивного закриття — авторські рядки локацій**, а не скрейп профілів учасників.
  Очі локацій уже пишуть автора (`venue_checkins.untappd_user`), і на фесті учасники чекіняться
  саме там. Окремий скрейп профілів ішов би тією самою кукою, що й очі (5 профілів × 12/год), і
  підняв би ризик блоку для всього режиму. Ціна: чекін учасника без локації фестивалю без MCP
  не закриє позицію — вона лишиться «⏳», а не стане хибною «✅».

### 4.6 Меню — `jobs/fest-menu.ts`

Головна сторінка локації фестивалю, куковий клієнт. Раз на 6 год до фесту; у дні фесту — за
30 хв до сесії й кожні 2 год. Позиції → `upsertBeerByBid` → `fest_menu` (`last_seen_at` =
зараз; позиція, що зникла, не видаляється). Ручний запуск — `/fest menu` (учасник команди).
Якщо сервер отримує 403, те саме робить ноут-око: HTML меню йде в `POST /fest/menu`, шлях
інжесту той самий.

---

## 5. Target (`domain/fest/targets.ts`, чиста функція)

```
targets(menu, teamTried: Map<telegramId, Set<beerId>>, beers, overrides, criteria)
  → { beerId, reasons: ('rating'|'style'|'manual')[], rating, style, section }[]
```

- **Непите:** bid відсутній у `triedBeerIds` **кожного** учасника (`checkins ∪ untappd_had`).
- **Якість:** `rating_global ≥ target_min_rating` **або** сирий стиль Untappd (`beers.style`,
  напр. `Stout - Imperial / Double`) містить один із `target_style_patterns` (без урахування
  регістру). `rating_global IS NULL` — не «низький»: такі позиції показуються окремим
  блоком «без рейтингу», а не зникають мовчки.
- **Оверрайди:** `add` робить Target з будь-якої позиції меню (зокрема питої) з причиною
  `manual`; `remove` прибирає, навіть якщо критерій проходить.
- Порожня команда → порожній список, а не «все меню».

**Чому не `canonicalStyleFamily`.** Її родини надто грубі для цього критерію: `Stout` — усі стаути,
а не лише імперські; окремої родини для Wild Ale нема; Eisbock падає в `Bock`
(`src/domain/style-family.ts`, `FAMILY_RULES`). Змінювати її не можна, бо вона живить
фільтри `/filters` для всіх користувачів (правило «не міняти правило, що діє на всі дані»).
Тому критерій — фестивальний перелік підрядків над сирим стилем, що лежить у конфігу фесту.

Шаблони за замовчуванням для WFP22: `Imperial`, `Wild Ale`, `Sour`, `Lambic`, `Eisbock`,
`Barleywine`, `Wheatwine`. План звіряє їх із реальними стилями позицій меню на момент
написання: жоден шаблон не має збігатися з «нецікавими» стилями на кшталт `Lager`.

---

## 6. Статуси

### 6.1 Покриття (`domain/fest/coverage.ts`)

Сторінка стрічки — неперервний зріз, упорядкований від нових до старих. Тому **кожна сторінка
сама доводить свій проміжок**, стик із уже відомим чекіном для цього не потрібен:
- головна сторінка (без курсора) доводить `[t(найстарішого на сторінці), fetchedAt]`;
- сторінка за курсором доводить `[t(найстарішого на сторінці), t(чекіну-курсора)]`. Якщо
  чекіну-курсора нема в БД, ліва межа не доведена й покриття не пишеться;
- порожня сторінка не доводить нічого: «HTTP 200 з порожнім тілом» уже траплявся без логіну
  (ДК §3.1.2);
- `fetchedAt` обрізається до `min(fetchedAt, серверний now)`.

Покриття локації — об'єднання проміжків від усіх очей. Дірка між головною сторінкою й
попереднім покриттям видна як незакритий проміжок; відповідь прийому `stitched = false` просить
око дочитати наступну сторінку. Перша сторінка сесії одразу доводить свій проміжок. Щоб перша
година сесії не стояла в `unknown`, перший тік дочитує сторінки до `session.start_at − 60 хв`
(≤ 5 сторінок).

### 6.2 «На крані» (`domain/fest/tap-status.ts`)

Для bid з меню й моменту `now`:
- `on_tap { lastAt, count }` — є чекін на будь-якій локації фесту за `(now − 60 хв, now]`;
- `not_seen` — чекіну нема **і** `fest_coverage` кожної локації безперервно покриває
  `[now − 60 хв, now]`;
- `unknown` — чекіну нема, і хоча б в одній локації є дірка в покритті.

Три локації — через OR: на весняній edition чекіни писалися переважно не на локацію
фестивалю (ДК §3.1.3).

### 6.3 Рейтинг броварень (`domain/fest/ranking.ts`)

Група = секція меню. Сортування:
1. кількість Target-ів `on_tap` за спаданням;
2. кількість Target-ів `unknown` за спаданням;
3. кількість усіх Target-ів за спаданням;
4. назва секції.

Секції без жодного Target-а не показуються.

### 6.4 «Випито» (`domain/fest/closure.ts`)

Елемент черги `q` закритий для учасника `m`, якщо є чекін `m` з `bid = q.bid` і
`checkin_at ≥ q.added_at − 10 хв`. Показується з `checkin_id`. Джерела: `checkins` учасника
(friend feed через MCP, синк розширенням, `/import`) і `venue_checkins` з
`lower(untappd_user) = lower(m.untappd_username)` (HTML-фолбек, §4.5). Порівняння імен — без
регістру: `checkins.account_key` уже зберігає нижній регістр, а автор зі стрічки — як показує сайт.
Без чекіну — «⏳», не «❌»: відсутність чекіну не доводить, що людина не пила.

Черга читає пиво через `fest_queue.beer_id`, а **не** через Target-и: щойно хтось із команди
чекіниться, пиво перестає бути Target (§5), а в черзі мусить лишитися.

### 6.5 Алерти (`domain/fest/alerts.ts`)

Для кожної команди на кожному тіку: Target, який став `on_tap` і для якого нема рядка в
`fest_alerts_sent (team, session_no, beer)`, дає повідомлення в груповий чат:
`🆕 <пиво> — <броварня> · <секція/стенд> · перший чекін <HH:MM>`.
- Кілька нових за тік → одне повідомлення списком.
- **Свіже чи давнє — за часом першого чекіну, а не за станом джоби.** «Перший чекін» — найраніший
  чекін цього bid на локаціях фесту від початку сесії. Якщо він не старший за 15 хв
  (`ALERT_FRESH_MS`) — рядок `🆕`. Старший — рядок у блоці «вже наливають: …» того самого
  повідомлення. Так перший тік сесії, тік після простою бота й чекін, який око догорнуло
  запізно, дають зведення без окремого детектора «дірок»: все, що ми дізналися пізно, пізнє за
  власним часом. Рядки в `fest_alerts_sent` пишуться для кожного пива з обох блоків.
- Тригер — статус `on_tap` (§6.2) Target-а команди. Пиво, яке хтось із команди вже випив, не
  Target (§5) і алерту не дає.
- Рядки в `fest_alerts_sent` пишуться **після** успішного надсилання: збій Telegram повторюється
  наступним тіком, а не губить алерт.
- Джоба не залежить від кукового клієнта: око ноута може бути єдиним джерелом.

---

## 7. Бот

Команди працюють і в групі, і в DM. У групі команда прив'язується до `chat_id`.

| Команда / кнопка | Де | Що робить |
|---|---|---|
| `/fest` у групі (перший раз) | група | Створює команду фесту для цього чату; кнопка **«Я в команді»** |
| «Я в команді» | група | Додає учасника. Без прив'язаного Untappd — відповідь «спершу `/link`» у DM |
| `/fest` | обидва | Рейтинг броварень (§6.3), по рядку: `🍺 3 · ? 1 · PINTA · пов. 2 B14`. Кнопка на секцію → деталі |
| Деталі секції | обидва | Target-и зі статусом (`🟢 12 хв тому (4)` / `⚪ не бачили за годину` / `❔`) і кнопка **«Взяв»** на кожному |
| «Взяв» | обидва | Одна транзакція: `fest_queue` (наступний `glass_no`) + `fest_print_jobs (queued)`. Відповідь: `Келих №7` |
| `/fest queue` | обидва | Черга: `№7 Motueka (PINTA) · взяв Ю.С. · ✅ Ю.С. ⏳ О.Б.` + URL-кнопка на сторінку пива в Untappd |
| `/fest targets` | обидва | Target-и з причинами; «без рейтингу» окремо; рядок повноти історії кожного учасника (кількість чекінів у боті vs профіль). Кнопки `➖` / пошук + `➕` |
| `/fest stands` | обидва | Приймає CSV `секція;поверх;стенд` документом; показує секції без стенда |
| `/fest menu` | обидва | Ручний перечит меню |
| `/fest printer` | DM | Одноразовий лінк на станцію друку (§8) |

Усі тексти — uk/pl/en через `src/i18n`. Форматування — в чистих `fest-*-format.ts` із тестами,
хендлери тонкі (§2.3 `spec.md`).

---

## 8. Друк

**Рівень 1 — станція друку.** Статична сторінка `site/fest-print/`, яку віддає Hono через тунель
під `/fest/print/`. Відкривається в Chrome на Android за лінком із `/fest printer` (токен станції
в URL-фрагменті, обмін на короткоживучий Bearer). Раз на 5 с тягне `GET /fest/print-jobs`,
показує лічильник і кнопку **«Друкувати все»** (Web Bluetooth вимагає жесту). Растр
етикетки будує клієнт із даних сервера; бібліотека протоколу — NiimBlue. Після кожної
наліпки — `POST /fest/print-jobs/:id/printed` або `/failed` з текстом помилки.
**S3 доведено (2026-09-30):** D11 власника друкує з Chrome на Android (первинна невдача — розряджена
батарея). Рівень 1 — основний шлях.

**Рівень 2 — картинка.** `GET /fest/print-jobs/:id.png`, той самий растр, генерується на
сервері. Кнопка «PNG» у `/fest queue` надсилає картинку в DM для друку з застосунку Niimbot.

**Рівень 3 — номерні наліпки.** Наліпки `1…150` друкуються наперед. `glass_no` видається
завжди, незалежно від принтера.

Етикетка (`domain/fest/label.ts`): рядок 1 — `№7` великим шрифтом; рядок 2 — назва пива,
обрізана до ширини з «…»; рядок 3 — ініціали. Розмір — з касети власника (S3), до того
40×12 мм.

---

## 9. Стадії

**Стадія 1 — ядро** (план №1, до вт 06.10):
1. Міграція 42 + сховище.
2. Парсер: автор, `data-gregtime`, `parseVenueMenu`.
3. Меню: джоба + `/fest menu`.
4. Точка прийому `POST /fest/feed` + покриття.
5. `scripts/fest-eye.ts`.
6. Серверний поллер.
7. `targets` / `tap-status` / `ranking`.
8. Бот: команда фесту, `/fest`, деталі, `/fest targets`, `/fest stands`.

**Стадія 2 — обв'язка** (пишеться після рев'ю ядра, до сб 10.10), за фактом трьома планами:
- план №2 (#753) — очі, читач меню, бот `/fest`;
- план №3 — черга + «Взяв», пасивне закриття (авторські рядки локацій), алерти;
- план №4 (після рев'ю плану №3) — MCP-клієнт і friend feed, станція друку й PNG, документація.

**Репетиція** — 10–11.10 у варшавському мультитапі: тимчасовий фест із локацією цього бару.

---

## 10. Заявка → доказ

| Що система записує / показує як факт | Що це доводить | Сила | Рішення |
|---|---|---|---|
| Позиція в `fest_menu` | bid із блоку меню локації фестивалю (ДК §3.1.1) | Сильна | — |
| Меню повне | Нічого: меню наповнюється (16 позицій 29.09) | **Слабка** | Заявку не пишемо. `/fest` показує «меню оновлено HH:MM, N позицій» |
| Target «ніхто не пив» | `triedBeerIds` кожного учасника | Сильна рівно наскільки повна історія | Рядок повноти історії в `/fest targets` на кожного |
| Причина `rating` | `rating_global` (Algolia/гідратор) | Сильна | `NULL` → блок «без рейтингу», не відкидання |
| Стенд секції | Ручний ввід / CSV людиною | Сильна | Без OCR-заявок |
| Чекін у `venue_checkins` | `checkin_id` з HTML або API; дедуп між очима доведено одним чекіном (ДК §3.4) | Сильна | — |
| Час чекіну | `data-gregtime` / RFC-текст / API `created_at` — до секунди | Сильна | Текст «11 Sep 26» як час **не приймається**: парсер повертає `null`, рядок відкидається |
| Покриття `[a, b]` | Неперервність самої сторінки (головна: до `fetchedAt`; курсорна: до чекіну-курсора з БД) | Сильна | Порожня сторінка або курсор, якого нема в БД, — жодного запису |
| `on_tap` | Чекін за 60 хв | Середня (чекін ≠ кран) | Показуємо «N хв тому (k чекінів)», а не голе «є» |
| `not_seen` | Покриття всіх локацій за 60 хв + нуль чекінів | Сильна | Без покриття → `unknown` |
| «Випито» | `checkin_id` учасника з bid після `added_at − 10 хв` | Сильна | Без чекіну — «⏳» |
| Алерт «з'явився» | Перший `checkin_id` за сесію, **який ми побачили** | Сильна для часу чекіну; «новий кран» — лише коли чекін свіжий | Чекін старший за 15 хв — у блок «вже наливають», не `🆕` (§6.5) |
| «Випито» з авторського рядка локації | `untappd_user` зі стрічки локації = Untappd учасника (без регістру) | Сильна | — |
| Учасник бачний у friend feed | Нічого, доки не перевірено дружбу з власником | **Слабка** | Не заявляємо; перевірка на репетиції (§4.5) |
| Надруковано | Відповідь бібліотеки принтера | Середня | Кнопка «передрукувати» |
| Учасник у команді | Натискання «Я в команді» в групі + `untappd_username` | Сильна | — |

---

## 11. Зміни в `spec.md`

Новий розділ «Фестивальний режим (WFP)»: таблиці §3, ендпоінти `POST /fest/feed`,
`POST /fest/menu`, `GET /fest/print-jobs`, джоби `festPoll` / `festMenu` / `festFriendFeed`,
команда `/fest`, інваріанти §6 (тристанний статус, покриття лише за стиком). Доповнення до
§3.x про поля парсера (`author`, пріоритет `data-gregtime`). Документ користувача —
`docs/USER-GUIDE.md`, розділ «Фестиваль».

## 12. Тести (найважливіше, решта — у планах)

- Парсер: фікстури з проб — сторінка `/activity` (DOM із `data-gregtime`), сирий фрагмент
  `more_feed`, сторінка меню. **CSRF-токени з фікстур вичищаються** перед комітом.
- Покриття: стик / без стику / порожня сторінка / два ока з перекриттям / межа рівно 60 хв.
- Tap-status: дірка в одній із трьох локацій → `unknown`.
- Target: поріг 3.79/3.80, `NULL`-рейтинг, `add` на питому позицію, `remove` на
  автоматичну, порожня команда.
- Алерти: перший тік сесії → зведення; повтор тієї ж сесії → нічого; нова сесія → знову алерт.
- Міграція 42: `WHERE version = 42`, сид WFP22.
