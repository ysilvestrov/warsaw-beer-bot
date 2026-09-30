# План 5/5 — WFP: станція друку

> **Спека:** `docs/superpowers/specs/2026-09/2026-09-29-wfp-team-assistant-design.md` (далі **С**),
> §8 переписано в цьому ж коміті за пробами нижче.
> **Змерджено:** ядро (#752), очі й бот (#753), черга/закриття/алерти (#756, #762), MCP (#763).
> **Мета:** «Взяв» друкує наліпку `№7 · пиво · ініціали` на D11 власника без ручної роботи;
> якщо Bluetooth не підключається — PNG з тієї ж сторінки в застосунок Niimbot; якщо й це ні —
> наперед надруковані номери (нічого не треба від коду, `glass_no` уже видається).
> **Дедлайн:** змерджено до сб 10.10 — репетиція перевіряє друк саме з цієї сторінки.
> **Гейт кожної задачі:** `npm test && npm run typecheck`.

## Наскрізне рев'ю плану 4 і проби — висновки

1. **Токен розширення не годиться для станції:** `rotateToken` тримає один токен на людину — новий
   знищив би токен розширення й ока ноута. Потрібна окрема таблиця (міграція 43).
2. **NiimBlue** (`@mmote/niimbluelib` 0.47.0, MIT; тарбол npm, 2026-09-30): UMD-збірка
   `niimbluelib.min.js` (120 КБ, простір імен `niimbluelib`); `client.getPrintTaskType()` /
   `getModelMetadata()` після `connect()`; D11 — 203 dpi, `printDirection "left"`, голівка 96 точок;
   `ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, dir)`; друк — `newPrintTask(...)` → `printInit` →
   `printPage(img, 1)` → `waitForPageFinished` → `waitForFinished` → `printEnd`.
3. **CDN з контейнера недоступний** (jsDelivr — 403 від проксі), тож збіг файлу на CDN з тарболом
   не перевірити; і на фесті мобільний інтернет. Бібліотека вендориться в `src/api/fest-print/`
   (деплой везе `src/**`) і віддається тим самим сервером.
4. **Серверний PNG** потребував би нативної залежності (canvas/sharp) з ризиком для lock-файлу —
   рівень 2 переходить на сторінку (`canvas.toBlob`), С §8 оновлено.
5. **План 4 не дав нових засновків для друку**; черга вже пише `fest_print_jobs (queued)` на
   кожне «Взяв» (#756).

---

## Задача 1 — міграція 43 і сховище станції

- `src/storage/schema.ts`: `V43_FEST_PRINT_SQL` — `fest_print_stations (token_hash TEXT PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES fest_teams(id) ON DELETE CASCADE, created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`, ідемпотентно; тест голови схеми → 43.
- `src/storage/fest_print.ts`:
  - `createStation(db, { teamId, createdBy, now, expiresAt }) → token` (32 байти base64url; у БД —
    SHA-256);
  - `stationTeam(db, token, now) → teamId | null` (прострочений — `null`);
  - `pendingJobs(db, teamId) → { id, glassNo, beerName, initials, status, attempts, error }[]` —
    `queued` і `failed`, за `glass_no`;
  - `markPrinted(db, teamId, queueId, now)` / `markFailed(db, teamId, queueId, error, now)`
    (`attempts + 1`, помилка обрізана до 200 символів) / `requeue(db, teamId, queueId, now)` —
    лише рядок своєї команди; інакше `false`.

**Тести:** токен не зберігається в БД відкритим; прострочений → `null`; чужа команда не бачить і не
чіпає чужих рядків; `failed` лишається в черзі з текстом помилки; `printed` зникає.

## Задача 2 — ендпоінти

`src/api/routes/fest-print.ts`, змонтовано поза auth-мідлварою API (своя перевірка токена станції):
- `GET /fest/print` — HTML станції; `GET /fest/print/niimbluelib.min.js` — вендорений файл
  (`application/javascript`, кеш на добу);
- `GET /fest/print-jobs` (Bearer станції) → `{ jobs }`;
- `POST /fest/print-jobs/:id/printed | /failed {error} | /requeue`.

**Тести:** без токена / з чужим / з простроченим → 401; черга своєї команди; `failed` з помилкою;
`printed` зникає; HTML і JS віддаються з правильними типами.

## Задача 3 — сторінка станції

`src/api/fest-print/index.html` (без збірки, чистий JS):
- токен із `#t=` → `localStorage`, фрагмент прибирається з адреси;
- «Підключити принтер» (жест) → `NiimbotBluetoothClient.connect()`; модель і напрям — з
  `getModelMetadata()`;
- розмір етикетки (мм) у `localStorage`, за замовчуванням 40×12;
- опитування раз на 5 с; лічильник; «Друкувати все» друкує `queued` по одному, звітує кожну;
- по рядку: «PNG» (`canvas.toBlob` → завантаження) і «Ще раз» для `failed`;
- компонування: `№N` великим, назва з «…» за `measureText`, ініціали.

Юніт-тестів сторінка не має (Web Bluetooth); перевірка — репетиція.

## Задача 4 — бот і документи

- `/fest printer` — лише в приватному чаті, лише учаснику команди: `createStation` (термін — кінець
  останньої сесії + 1 доба) → повідомлення з посиланням `https://beer-api.ysilvestrov-ai.uk/fest/print#t=…`
  і попередженням не пересилати.
- `spec.md` (розділ «друк»), `docs/USER-GUIDE.md` (станція, PNG, номерні наліпки).
