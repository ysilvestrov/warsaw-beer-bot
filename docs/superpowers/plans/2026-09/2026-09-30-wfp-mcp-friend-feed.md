# План 4/5 — WFP: MCP-клієнт, friend feed, стрічка власника

> **Спека:** `docs/superpowers/specs/2026-09/2026-09-29-wfp-team-assistant-design.md` (далі **С**),
> §4.5 доповнено в цьому ж коміті результатами проб нижче.
> **Змерджено:** ядро (#752), очі й бот (#753), черга/закриття/алерти (#756, #762).
> **Мета плану 4:** чекіни учасників доходять до бота без HTML — через Untappd API під токеном
> власника. Закриття черги перестає залежати від того, чи чекінився учасник саме на локації фесту;
> friend feed стає третім оком для чекінів на локаціях.
> **План 5** (після наскрізного рев'ю цього): станція друку, PNG, документація друку.
> **Дедлайн:** змерджено й токен на сервері до ср 07.10 (щоденний keepalive має часу показати, чи
> живе refresh token), репетиція 10–11.10.
> **Гейт кожної задачі:** `npm test && npm run typecheck`.
> **Деплой:** PR несе `[deploy:hold]` — потрібні новий ключ `.env` і файл токена на хості.

## Наскрізне рев'ю плану 3 і проби (перед цим планом) — висновки

1. **`get_user_checkins` власника** (жива проба 2026-09-30, `limit 1`): та сама форма запису, що й
   у friend feed (`checkin_id`, `created_at` RFC 2822 із секундами, `beer.bid`, `user.user_name`,
   `venue.venue_id`); `limit` ≤ 25. Власник читається ним, бо friend feed його не містить.
2. **`minId` ігнорує `limit`** (жива проба: `limit 2, minId` → 25 записів, найновіші, з діркою до
   курсора). Отже «стик» — це сторінка з < 25 записів, догортання — `maxId` з тим самим `minId`.
   Спека §4.5 виправлена: курсор після дірки **переходить** (стара редакція лишала його на місці, і
   тоді кожен тік упирався б у ту саму дірку назавжди).
3. **Відповідь інструмента — JSON у `content[0].text`**. `structuredContent` не перевірено — на нього
   не покладаємося; скрипт входу друкує, чи розібралась відповідь, і це перша перевірка на ноуті.
4. **`@modelcontextprotocol/sdk` 1.30.0 уже в `dependencies`** і вже імпортується в CJS-збірці
   (`src/api/mcp/server.ts`), тож клієнтські шляхи `.../client/index.js` працюють без змін
   lock-файлу.
5. **Власник у файлі токена.** Ім'я Untappd власника потрібне, щоб читати його стрічку; скрипт
   входу бере його з `get_my_profile` і пише у той самий файл — окремий ключ `.env` не потрібен.
6. **Закриття з plan 3 уже читає `checkins` учасника** (`memberBeerCheckins`), тож чекіни з MCP,
   записані через `mergeCheckin` під ключем історії учасника, закривають позиції без змін у черзі.
   Ціна: такий чекін робить пиво «питим» і для Target — це правильно (С §5).

---

## Задача 1 — розбір відповіді й клієнт MCP

**Файли:**
- `src/sources/untappd/mcp-checkins.ts` (чисте): zod-схема мінімального запису (`checkin_id`,
  `created_at`, `beer.{bid, beer_name, beer_style?, beer_abv?}`, `brewery.brewery_name`,
  `venue` — об'єкт із `venue_id` **або** порожній масив, `user.user_name`, `rating_score`) →
  `parseMcpCheckins(result) → { items: McpCheckin[]; maxId: number | null }` або `{ error }`:
  - `isError: true` → `{ error: <текст> }`;
  - `content[0].text` не JSON / не проходить схему → `{ error: 'bad_shape' }`;
  - запис, що не проходить схему, відкидається поодинці (решта сторінки живе);
  - час — через наявний `feedCheckinTime` (лише з секундами) → ISO `Z`; без часу — запис відкидається.
- `src/sources/untappd/mcp-oauth-file.ts`: `FileOAuthProvider` для SDK — `clientInformation`,
  `tokens`, `codeVerifier` і `owner` в одному JSON-файлі; кожен `save*` переписує файл **атомарно**
  (запис у `<файл>.tmp` з правами `0600` → `rename`); `redirectToAuthorization` на сервері
  **кидає** `McpLoginRequired` (скрипт входу передає власну реалізацію); `scope` в authorization
  URL звужується до `untappd:read`.
- `src/sources/untappd/mcp-client.ts`: `createFestMcp({ url, oauthFile, log })` →
  `{ call(tool, args): Promise<CallToolResult>; owner(): string | null; close() }` — лінивий
  `connect` через `StreamableHTTPClientTransport({ authProvider })`, тайм-аут виклику 30 с, після
  помилки транспорту — перепідключення на наступному виклику.

**Тести:** `parseMcpCheckins` на фікстурі з живої відповіді (обрізана до 3 записів, без фото й тостів)
— усі поля; `venue: []` → `venueId: null`; `isError` → текст; зламаний JSON → `bad_shape`; запис
без `bid` відкидається, решта лишається. `FileOAuthProvider`: `saveTokens` → файл перечитується
новим провайдером (рестарт), права `0600`, тимчасового файлу не лишається; `redirectToAuthorization`
кидає; `scope` в URL — лише `untappd:read`.

## Задача 2 — джоба friend feed і стрічки власника

**Файли:**
- `src/domain/fest/mcp-paging.ts` (чисте): `nextPage({ pages, cursor })` — рішення «догортати /
  стик / дірка» за правилом С §4.5 (`MCP_PAGE_CAP = 25`, ≤ 4 сторінки) і новий курсор
  (найновіший `checkin_id` з усіх сторінок; без жодного запису — курсор не рухається).
- `src/jobs/fest-friend-feed.ts`: `runFestFriendFeed(deps, now)`:
  - лише в активному вікні опитування, раз на 5 хв (`job_state.fest_friend_feed_last_at`);
  - breaker `job_state.fest_mcp_open_until` (поріг 2, пауза 30 хв); `McpLoginRequired` /
    `UnauthorizedError` → breaker + алерт адміну «запусти fest-mcp-login» (раз на 6 год, тим самим
    механізмом, що й алерт куки в `fest-poll.ts`);
  - дві стрічки: `get_my_friend_feed` (курсор `fest_friend_feed_min_id`) і
    `get_user_checkins(owner)` (курсор `fest_owner_feed_min_id`); кожна гортається за `nextPage`;
  - кожен запис: `venueId ∈ festVenues` → `insertVenueCheckins(eye 'friend_feed', author)`;
    автор — учасник будь-якої команди фесту (без регістру) → `upsertBeerByBid(source 'checkin')` +
    `mergeCheckin` під ключем історії цього учасника;
  - курсори пишуться **після** запису рядків, в одній транзакції з ними.
- `src/jobs/fest-mcp-keepalive.ts`: раз на добу (і поза фестом) — `get_untappd_api_usage`;
  невдача → алерт адміну одразу.
- `src/storage/fest_teams.ts`: `festMembersByUsername(db, festId) → Map<lower(username), telegramId>`.

**Тести:** `nextPage` — 24 записи → стик; 25 → далі; 4 повні сторінки → дірка, курсор = найновіший;
порожня сторінка без курсора → курсор не рухається. Джоба з фейковим `mcp`: чекін учасника на
стадіоні → рядок `venue_checkins` (`friend_feed`, автор) **і** рядок `checkins` учасника; чекін
чужого друга на стадіоні → лише `venue_checkins`; чекін учасника вдома → лише `checkins`; другий тік
з тим самим курсором → `minId` = збережений; `UnauthorizedError` → breaker + один алерт за два тіки;
поза вікном → жодного виклику. Keepalive: успіх → нічого, помилка → алерт.

## Задача 3 — вхід, конфіг, проводка

**Файли:**
- `scripts/fest-mcp-login.ts` (ноут, `npx tsx scripts/fest-mcp-login.ts --out ./tmp/fest-mcp-oauth.json`):
  loopback `http://localhost:8765/callback`, друкує URL входу (і пробує відкрити браузер),
  `transport.finishAuth(code)`, `get_my_profile` → `owner` у файл, потім **перевірка**: по одному
  виклику `get_untappd_api_usage` і `get_my_friend_feed(limit 1)` через `parseMcpCheckins` — друкує
  лише «розібрано N записів, поля на місці» або текст помилки; токенів не друкує ніколи.
- `src/config/env.ts`: `FEST_MCP_URL` (опційний), `FEST_MCP_OAUTH_FILE` (за замовчуванням
  `/var/lib/warsaw-beer-bot/fest-mcp-oauth.json`); `.env.example`.
- `src/index.ts`: з `FEST_MCP_URL` — клієнт, `runFestFriendFeed` у хвилинному кроні фесту
  (незалежно від `untappdHttp`), keepalive — окремий добовий крон.
- `spec.md`: розділ «Фестивальний режим — MCP»; `docs/USER-GUIDE.md` — абзац «чекінься будь-де,
  бот бачить через стрічку власника, якщо ви друзі в Untappd».

**Тести:** env — без `FEST_MCP_URL` модуль вимкнено, шлях файлу за замовчуванням. Скрипт входу
юніт-тестами не покривається (браузер і людина); його перевірка — вивід на ноуті.

**Кроки для людини (опис PR, `[deploy:hold]`):** на ноуті — `fest-mcp-login`; перенести файл на
сервер у `/var/lib/warsaw-beer-bot/fest-mcp-oauth.json` (власник `warsaw-beer-bot`, `600`); додати
`FEST_MCP_URL` у `.env`; `bash deploy/deploy.sh`; через добу — переконатися, що keepalive не дав алерту.

---

## Після плану

Наскрізне рев'ю плану 4 → план 5 (друк) → репетиція 10–11.10.
