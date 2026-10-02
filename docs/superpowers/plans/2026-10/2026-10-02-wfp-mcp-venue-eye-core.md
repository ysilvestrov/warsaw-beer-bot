# План: MCP-око локацій — ядро

> **Спека:** `docs/superpowers/specs/2026-10/2026-10-02-wfp-mcp-venue-eye-design.md` (далі **С**).
> **Етап 1 з 2** (CLAUDE.md, «велика зміна йде стадіями»): ядро — міграція, прийом рядків, крок
> пейджингу, джоба. Проводка в `src/index.ts` і документи — окремий план **після** наскрізного рев'ю ядра.
> **Гейт кожної задачі:** `npm test && npm run typecheck`.

## Задача 1 — міграція 44 і значення ока `mcp_venue`

- `src/storage/schema.ts`: `V44_FEST_MCP_EYE_SQL` — для `venue_checkins` і `fest_coverage`:
  `CREATE TABLE <t>_new (… CHECK (… IN ('laptop', 'server', 'friend_feed', 'mcp_venue')) …)`,
  `INSERT INTO <t>_new SELECT * FROM <t>`, `DROP TABLE <t>`, `ALTER TABLE <t>_new RENAME TO <t>`,
  відновити індекси `idx_venue_checkins_venue_at`, `idx_venue_checkins_bid_at`. Колонки й порядок —
  як у v42. `{ version: 44, sql: V44_FEST_MCP_EYE_SQL }`.
- `src/storage/venue_checkins.ts`: `Eye = 'laptop' | 'server' | 'friend_feed' | 'mcp_venue'`.
- `src/storage/schema.test.ts`: голова 43 → 44 (єдиний тест голови).

**Тести (нові, у `schema.test.ts`):** міграція 44 записує v44; рядок `venue_checkins` і рядок
`fest_coverage`, вставлені на v43, після міграції на місці з тими самими полями; `mcp_venue`
приймається в обидві таблиці; `'other'` — `CHECK` відкидає; обидва індекси існують
(`sqlite_master`).

## Задача 2 — `mem` у розборі MCP-сторінки

- `src/sources/untappd/mcp-checkins.ts`: `McpPage` успіху дістає `cached: boolean` —
  `true`, коли в тілі нема `mem === false` (тобто `mem: true` або поля нема). Решта без змін.

**Тести:** `mem: false` → `cached: false`; `mem: true` → `true`; без поля → `true`; стрічка друзів
(фікстура `mcp-friend-feed.json`) розбирається як раніше.

Дрібна (повний код у тексті, 1 файл + тест, без рішень) — виконується інлайн.

## Задача 3 — ядро прийому `ingestCheckinRows`

- `src/jobs/fest-ingest.ts`: винести з `ingestFeedPage` усе після розбору HTML у
  `ingestCheckinRows(db, { venueId, rows, cursor, fetchedAt, eye, now, provesCoverage })`, де
  `rows: { checkin_id: number; venue_id: number | null; bid: number; untappd_user: string | null;
  checkin_at: string | null }[]` (сирі: `venue_id` будь-який, `checkin_at` уже ISO або `null`),
  `cursor: number | null`, `provesCoverage: boolean`. Підрахунок `mismatched`/`dropped`, правило
  «будь-який відкинутий рядок → без покриття», `cursorAt` з БД, транзакція — переносяться без змін.
  `provesCoverage === false` → `span = null`. Повертає те саме `FeedPageResult` без `nextCursor`.
- `ingestFeedPage` = блок-сторінка → розбір HTML → `ingestCheckinRows(…, provesCoverage: true)` +
  `nextCursor` зі сторінки. Поведінка для HTML не змінюється.

**Тести:** наявні `fest-ingest.test.ts` проходять без правок (доказ, що HTML-шлях не змінився);
нові для `ingestCheckinRows`: `provesCoverage: false` → рядки вставлено, `fest_coverage` порожня;
рядок з `venue_id: null` → `mismatched: 1`, покриття нема; `cursor`, якого нема в БД → покриття нема.

## Задача 4 — крок пейджингу локації

- `src/domain/fest/mcp-paging.ts`:
  `venuePageStep({ cursor, floorAt, pageNo, ids, oldestAt }): PageStep`, де `cursor` — курсор локації
  або `null`, `floorAt` — ISO `session.start_at − 60 хв` (діє лише без курсора), `ids` — id сторінки,
  `oldestAt` — ISO найстарішого:
  - `ids.length < MCP_PAGE_CAP` → `'done'`;
  - з курсором: `min(ids) <= cursor` → `'done'`;
  - без курсора: `oldestAt <= floorAt` → `'done'`;
  - інакше `pageNo >= MCP_MAX_PAGES` → `'hole'`, ні — `'more'`.
- `nextCursor` — наявний, без змін.

**Тести (`mcp-paging.test.ts`):** кожна гілка окремим тестом із точним `toBe`; межі: `min(ids) ===
cursor` → `done`; `oldestAt === floorAt` → `done`; `pageNo === 4` → `hole`, `3` → `more`; 0 id → `done`.

## Задача 5 — джоба `runFestMcpVenues`

`src/jobs/fest-mcp-venues.ts`:

```ts
export const VENUE_EVERY_MS = { menu: 3 * 60 * 1000, other: 6 * 60 * 1000 };
export const venueCursorKey = (venueId: number) => `fest_mcp_venue_cursor:${venueId}`;
export const venueLastKey = (venueId: number) => `fest_mcp_venue_last_at:${venueId}`;
export async function runFestMcpVenues(deps: FestFriendFeedDeps, now: Date): Promise<number | null>
```

- `activeFest(db, now)`; нема → `null`. `!breaker.canAttempt(now)` → `null`.
- Для кожної `festVenues` фесту, чий `last_at` старший за її каденс (`menu_venue_id` — 3 хв, інші — 6):
  1. Сторінки: `mcp.call('get_venue_checkins', { venueId, limit: 25, maxId? })` →
     `parseMcpCheckins`; помилка → виняток локації.
  2. Кожна сторінка → `ingestCheckinRows(db, { venueId, rows, cursor: maxId ?? null, fetchedAt:
     now, eye: 'mcp_venue', now, provesCoverage: !page.cached })`, де `rows` — `McpCheckin` →
     `{ checkin_id, venue_id: venueId-з-відповіді, bid, untappd_user: userName, checkin_at }`.
     Сторінки пишуться по одній: наступна сторінка покладається на чекін `maxId`, записаний попередньою.
  3. Крок — `venuePageStep`; `maxId` = найменший id сторінки.
  4. Після останньої сторінки: курсор = `nextCursor(cursor, усі id)`, `last_at = now` — в одній
     транзакції; `'hole'` → `log.warn` (алерт — у плані обв'язки, якщо рев'ю скаже, що він потрібен).
- Помилка локації: її курсор і `last_at` не рухаються, `breaker.onResult(true)`, інші локації тіку
  читаються далі. Усі локації без помилок → `breaker.onResult(false)`.
- Повертає кількість нових рядків (сума `inserted`).

**Тести (`fest-mcp-venues.test.ts`, фейковий `FestMcp`, БД `:memory:` з сидом WFP22):**
поза вікном — 0 викликів; перший тік — читає всі три локації, без курсора дочитує до `start − 60 хв`;
через 3 хв — лише фестивальна, через 6 — усі три; з курсором зупиняється на ньому; `cached` сторінка —
рядки є, покриття нема; помилка однієї локації — її курсор не змінився, інші прочитано,
`breaker.onResult(true)`; дірка після 4 сторінок — курсор на найновішому; закритий breaker — 0 викликів.

## Після ядра

Наскрізне рев'ю ядра (з інлайновою задачею 2 у пакеті). Далі — окремий план обв'язки:
проводка в MCP-крон `src/index.ts`, `spec.md` (око, `mcp_venue`, міграція 44), `docs/USER-GUIDE.md`,
документ підготовки.
