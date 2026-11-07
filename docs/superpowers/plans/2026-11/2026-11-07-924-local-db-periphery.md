# #924 Локальна база чекінів — план обв'язки (PR 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** людина без Telegram-токена синкає свої чекіни в IndexedDB браузера і бачить ✅/❓/свій рейтинг на сторінках крамниць, а історія не йде на наш сервер.

**Architecture:** режим визначає токен (`linked` з Telegram-токеном, інакше `local`). Ядро (PR #936) уже дає сховище (`extension/src/local/db.ts`) і локальні `getState`/`submitPage` (`extension/src/local/sync.ts`). Цей план підключає їх у фоновий процес: крок синку без токена йде через локальний адаптер, відповідь `/match` і кеш лишаються анонімними, а «пив» накладається на кожному читанні з індексу bid → рейтинг. Далі popup, Options і документи.

**Tech Stack:** TypeScript, Chrome MV3 service worker, IndexedDB (`fake-indexeddb` у тестах), Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-31-924-local-checkin-db-design.md` (§5–§7, тести 6–9; ядро — PR #936, автосинк — #934/PR #939).

**Виконання:** native (`superpowers:executing-plans`): задачі послідовно спираються на інтерфейси одна одної (індекс → фон → popup/Options), і весь контекст фону вже в цій сесії; наскрізне рев'ю — після останньої задачі.

## Global Constraints

- Режим: `mode = settings.token ? 'linked' : 'local'`; перемикача в інтерфейсі нема (спека, «На чому стоїть рішення»).
- У `linked` поведінка не змінюється: кожен новий шлях стоїть за `mode === 'local'`, і наявні тести `linked` не правляться в очікуваннях.
- У `local` жодного запиту на `/checkins/*` (спека, тест 8); тіло `/match` те саме, що анонімне.
- Накладання дослівно (спека §5): `is_drunk = source === 'exact' && index.has(id)`; `drunk_uncertain = source === 'fuzzy' && index.has(id)`; `user_rating = source === 'exact' ? index.get(id) ?? null : null`; тільки при `matched_beer.untappd_id !== null`.
- Рейтинг в індексі — з найновішого (за `checkin_at`, рівність — більший числовий `checkin_id`) чекіна з ненульовим рейтингом; немає такого — `null` (правило серверного `latestRatingsByBeer`).
- Кеш у `local` зберігає анонімну відповідь: `is_drunk: false`, `drunk_uncertain: false`, `user_rating: null`.
- Тексти розширення — англійською (локалізація — #937). Тексти чейнджлогу — для користувача, без термінів коду.
- Тести — за п. 5 блоку detent у `CLAUDE.md`: точні асерти, без розгалужень, межі й помилки.

## Review Focus

1. **Токен з'явився або зник, коли статус уже записано.** Запис статусу з локальною прив'язкою (`token: ''`) у режимі `linked` не дає хибного «Untappd account changed», а прив'язка `linked` у режимі `local` дає порожній статус, не чужий ✓. Тести — задача 3.
2. **IndexedDB недоступна** (приватне вікно, квота, збій відкриття). `/match` і читання кешу не падають і повертають анонімну відповідь. Тест — задача 2.
3. **Очищення посеред синку.** Після «Clear» popup показує «Sync my check-ins», а не ✓ старої бази; пізня сторінка старого покоління нічого не пише (ядро, тест 10). Тест — задача 3.
4. **Порожня база** (синку ще не було). Накладання повертає анонімну відповідь; Options показує, як почати. Тести — задачі 1 і 5.
5. **Найновіший чекін пива без рейтингу, старший — з рейтингом.** Рейтинг береться зі старшого; чекін, у якого рейтинг прибрали, рейтингу не показує. Тест — задача 1.

---

### Task 1: Індекс «пив» і накладання

**Files:**
- Create: `extension/src/local/had.ts`
- Test: `extension/src/local/had.test.ts`

**Interfaces:**
- Consumes: `LocalCheckin` і `allCheckins()` з `extension/src/local/db.ts`; `MatchResult` з `extension/src/api/types.ts`.
- Produces:
  - `type HadIndex = Map<number, number | null>`
  - `buildHadIndex(rows: LocalCheckin[]): HadIndex`
  - `overlayHad(result: MatchResult, index: HadIndex): MatchResult` — новий об'єкт; при `untappd_id === null` чи bid поза індексом повертає `anonymous(result)`
  - `anonymous(result: MatchResult): MatchResult` — поля «пив» до анонімних значень, решта як є
  - `hadIndex(): Promise<HadIndex>` — будується з `allCheckins()` один раз і кешується в модулі; збій IndexedDB → порожній індекс (не кешується, наступний виклик пробує знову)
  - `invalidateHadIndex(): void`

- [ ] **Step 1: Тести `buildHadIndex`** — `it('keeps the rating of the newest rated check-in of a beer')`: рядки bid 7 `{checkin_at '2026-01-01T…', rating 3.5}`, `{'2026-03-01…', 4.25}`, `{'2026-02-01…', null}` → `index.get(7)` `toBe(4.25)`; `it('takes an older rating when the newest check-in has none')`: `{'2026-01-01', 4}`, `{'2026-05-01', null}` → `4`; `it('stores null for a beer that was never rated')` → `index.has(9)` `true`, `get(9)` `null`; `it('breaks a tie on check-in time by the larger check-in id')`: той самий `checkin_at`, id `'100'` → 3, id `'99'` → 5 → `3`; `it('is empty for no rows')` → `size` `0`.
- [ ] **Step 2: Тести `overlayHad`/`anonymous`** (тест 6 спеки): `exact` + у базі → `{is_drunk: true, drunk_uncertain: false, user_rating: 4.25}`; `fuzzy` + у базі → `{is_drunk: false, drunk_uncertain: true, user_rating: null}`; не в базі → поля анонімні; `matched_beer: null` → анонімні; `untappd_id: null` → анонімні; вхідний об'єкт не змінено (`toEqual` знімка до виклику); `anonymous` на результаті з `is_drunk: true, user_rating: 4` → `false`/`false`/`null`, `raw`, `matched_beer`, `source`, `searched`, `cacheBinding` без змін.
- [ ] **Step 3: Тести `hadIndex`** на `fake-indexeddb`: запис сторінки через `inPageTx` → `hadIndex()` бачить bid; другий запис без `invalidateHadIndex()` → індекс той самий (кешований); після `invalidateHadIndex()` → новий bid видно; `openLocalDb` кидає (`vi.spyOn(indexedDB, 'open')` з помилкою) → `size` `0`, і після відновлення наступний виклик бачить дані.
- [ ] **Step 4:** `npm test -- src/local/had.test.ts` у `extension/` — FAIL (модуля нема).
- [ ] **Step 5:** реалізувати `extension/src/local/had.ts` за Interfaces.
- [ ] **Step 6:** тести PASS; гейт розширення (`npm test && npm run typecheck` в `extension/`).
- [ ] **Step 7:** коміт `feat(extension): #924 had index and overlay for local mode`.

### Task 2: Накладання у `/match` і кеші

**Files:**
- Modify: `extension/src/shared/config.ts` (додати `syncMode`)
- Modify: `extension/src/background/index.ts` (`handleMatch`, `handleCacheGetMany`, `handleCacheSet`, `handleCacheSetMany`, `handleCacheSetIfMatching`)
- Test: `extension/src/background/index.test.ts`, `extension/src/shared/config.test.ts` (якщо є; інакше в `index.test.ts`)

**Interfaces:**
- Consumes: `hadIndex`, `overlayHad`, `anonymous` (задача 1).
- Produces: `syncMode(s: Settings): 'linked' | 'local'` у `extension/src/shared/config.ts`.

- [ ] **Step 1: Тести** (тест 7 спеки), режим `local` (без `settings.token`), у базі bid 101 з рейтингом 4.5:
  - `handleMatch` з відповіддю `exact` на bid 101 → `is_drunk: true, user_rating: 4.5`; запит пішов на `/match` з тим самим тілом, що анонімний (порівняти `fetch` body з тілом у режимі без бази).
  - `handleCacheSet` накладеного результату → у сховищі кешу `is_drunk: false, user_rating: null`; `handleCacheGetMany` того ключа → знову `true`/`4.5`.
  - Синк між записом і читанням: запис кешу на bid 202 (не в базі) → додати чекін bid 202 через `inPageTx` + `invalidateHadIndex()` → `handleCacheGetMany` → `is_drunk: true` без інвалідації кешу.
  - `handleCacheSetIfMatching` з `expected` = накладений `fuzzy` на bid 101 (`drunk_uncertain: true`) і новим результатом → `true`, у кеші нова відповідь (анонімна).
  - IndexedDB недоступна (`indexedDB.open` кидає) → `handleMatch` `match:ok` з анонімними полями.
  - Режим `linked`: `handleMatch` повертає поля сервера як є (`is_drunk` з відповіді `true`, хоча локальної бази немає), а `handleCacheSet` пише результат без змін.
- [ ] **Step 2:** тести FAIL.
- [ ] **Step 3:** реалізувати: у `local` `handleMatch` і `handleCacheGetMany` прогоняють результати через `overlayHad` з одним `await hadIndex()` на виклик; три `handleCacheSet*` перед записом і порівнянням прогоняють результати (і `expected`) через `anonymous`. Режим читається з тих самих `getSettings()`, що вже читаються в обробнику.
- [ ] **Step 4:** тести PASS, гейт розширення, коміт `feat(extension): #924 local ✅ on /match answers and the match cache`.

### Task 3: Синк, статус і очищення в режимі `local`

**Files:**
- Modify: `extension/src/local/db.ts` (додати `localStats`)
- Modify: `extension/src/background/index.ts` (`launchCheckinSync`, `handleCheckinSyncStatus`, `syncStatusReply`, `syncScheduler` deps, обробники повідомлень)
- Test: `extension/src/background/index.test.ts`, `extension/src/local/db.test.ts` (новий)

**Interfaces:**
- Consumes: `localSyncDeps` (`extension/src/local/sync.ts`), `clearLocalDb`, `currentGeneration` (`db.ts`), `invalidateHadIndex` (задача 1), `syncMode` (задача 2).
- Produces:
  - `localStats(): Promise<{ checkins: number; beers: number; meta: LocalMeta | null }>` у `db.ts` (`beers` — кількість різних bid).
  - Відповідь статусу отримує поле `mode: 'linked' | 'local'`.
  - Повідомлення `{type: 'local-db:stats'}` → `{type: 'local-db:stats:ok', mode, checkins, beers, lastSync: string | null, username: string | null}` (`lastSync` = `meta.updatedAt`); у `linked` — `checkins: 0, beers: 0, lastSync: null, username: null`.
  - Повідомлення `{type: 'local-db:clear'}` → `{type: 'local-db:cleared', ok: boolean}`; у `linked` `ok: false` і нічого не видаляється.

- [ ] **Step 1: Тести:**
  - **Мережа** (тест 8): `local`, повний синк на 3 сторінки (фікстури `src/sources/untappd/__fixtures__/` з `nextMaxId`, як у `sync.test.ts`) через `handleCheckinSyncStart` → кожен `fetch` іде на `https://untappd.com/…`; жодного URL з `/checkins/`; у базі чекіни трьох сторінок; статус `outcome: 'done'`, `mode: 'local'`, `username` — власник бази.
  - **Індекс після сторінки:** після синку `hadIndex()` містить bid зі сторінки без ручного `invalidateHadIndex()`.
  - **Кеш `/match` не чиститься** синком у `local` (`handleCacheClearAll` не викликано: запис кешу, синк, той самий запис читається).
  - **Статус без мережі:** `handleCheckinSyncStatus` у `local` не робить жодного `fetch`; повертає збережений запис, якщо його прив'язка `token: ''` і `linkRevision === currentGeneration()`, інакше порожній статус (`outcome: null`).
  - **Перехід режимів** (Review Focus 1): збережений статус із прив'язкою `local` + з'явився Telegram-токен → відповідь `linked` має `outcome: null` (не `account_changed`); збережений статус `linked` + токен прибрали → `local`, `outcome: null`.
  - **Очищення** (тест 9): `local-db:clear` → три сховища порожні (`localStats()` → `{checkins: 0, beers: 0, meta: null}`), `hadIndex()` порожній, статус `outcome: null`, наступний `getState` створює нового власника; очищення посеред синку → крок завершується `cancelled`, статус після нього `outcome: null` (Review Focus 3); у `linked` → `ok: false`, база ціла.
  - **Stats:** дві сторінки з повтором bid → `checkins` = кількість чекінів, `beers` = кількість різних bid, `lastSync` = `meta.updatedAt`.
  - **Тиха перевірка в `local`:** `syncScheduler.check()` без Telegram-токена, з дозволом untappd.com → `'started'`, не `'no_token'`.
- [ ] **Step 2:** тести FAIL.
- [ ] **Step 3:** реалізувати:
  - `launchCheckinSync` у `local` — замість гілки «без токена → error» той самий цикл з `getState`/`submitPage` від `localSyncDeps({ fetchText })`, де `fetchText` — `fetch(url, {credentials: 'include', signal})`, не-`ok` → `ApiError('feed_unavailable')`. Обгортка `getState` ставить прив'язку `{username, linkRevision: state.linkRevision, token: '', baseUrl}` і пише статус `running`, **не** чистить кеш. Обгортка `submitPage` після успіху кличе `invalidateHadIndex()`. `fetchFeed`, `sessionOf`, `beforeFetch`/`afterPage` — ті самі.
  - `handleCheckinSyncStatus` у `local` — гілка без мережі з правилом вище; у `linked` прив'язка з `token: ''` прирівнюється до відсутньої.
  - Scheduler deps: `hasToken: async () => true` (обидва режими мають куди синкати; поле лишається для тестів планувальника); `clearMatchCache` у `local` нічого не робить (кеш анонімний, індекс скидається сторінкою).
  - `local-db:clear`: `syncScheduler.stop()`, далі `clearLocalDb(() => syncAbortController?.abort())`, `invalidateHadIndex()`, новий `syncGeneration` і `enqueueSyncStatus(emptySyncStatus(), generation)`.
- [ ] **Step 4:** тести PASS, гейт розширення, коміт `feat(extension): #924 local sync, status and Clear in the background`.

### Task 4: Popup у режимі `local`

**Files:**
- Modify: `extension/src/popup/popup.ts`, `extension/src/popup/token-state.ts`
- Test: `extension/src/popup/popup.test.ts`, `extension/src/popup/token-state.test.ts`

**Interfaces:**
- Consumes: поле `mode` у відповіді статусу, повідомлення `local-db:clear` (задача 3).
- Produces: `SyncStatusView.mode: 'linked' | 'local'`; `SyncWidgetView.action.kind` отримує `'clear'`.

- [ ] **Step 1: Тести:**
  - `tokenStateView(false, …)` → `syncEnabled: true`, `syncTier: 'btn-primary'`, `syncCaption: ''`, `authVisible: true`, `authTier: 'btn-secondary'`; з токеном — як було.
  - `authNoteText(false, true)` → `"Works without Telegram — ⭐ global ratings, missing-beer search, and ✅ from check-ins you sync into this browser only. A bot token adds recommendations and sync across devices."`; `authNoteText(false, false)` → те саме без `"missing-beer search, "`: `"Works without Telegram — ⭐ global ratings and ✅ from check-ins you sync into this browser only. A bot token adds recommendations and sync across devices."`.
  - `syncWidgetView` для `account_changed` з `mode: 'local'`, `username: 'alice'` → `{label: 'Untappd account changed', detail: 'This browser\'s check-ins belong to alice. Clear them and sync this account?', action: {kind: 'clear', label: 'Clear and sync'}, link: null}`; без `username` → detail `'Clear the check-ins stored in this browser and sync this account?'`; `mode: 'linked'` — як було.
  - `initPopup` без токена: віджет показано, статус опитано (`sendMessage` з `{type: 'checkin-sync:status'}`), кнопка активна.
  - Клік `Clear and sync`: спершу `chrome.permissions.request`, далі `{type: 'local-db:clear'}`, далі `{type: 'checkin-sync:start'}` — у цьому порядку.
- [ ] **Step 2:** тести FAIL.
- [ ] **Step 3:** реалізувати; прибрати умову `hasToken` з показу віджета; гілку `account_changed` розвести за `mode`.
- [ ] **Step 4:** тести PASS, гейт розширення, коміт `feat(extension): #924 popup syncs without Telegram and offers Clear on another account`.

### Task 5: Options — блок «Local check-ins»

**Files:**
- Modify: `extension/src/options/options.html`, `extension/src/options/options.ts`, `extension/src/options/options.css`
- Test: `extension/src/options/options.test.ts`

**Interfaces:**
- Consumes: `local-db:stats`, `local-db:clear` (задача 3).
- Produces: `localDbSummary(s: {checkins: number; beers: number; lastSync: string | null}): string`.

- [ ] **Step 1: Тести:**
  - `localDbSummary({checkins: 0, beers: 0, lastSync: null})` → `'Empty — open the popup and tap Sync my check-ins.'`
  - `localDbSummary({checkins: 12407, beers: 9031, lastSync: '2026-11-07T10:05:00.000Z'})` → `'12 407 check-ins · 9 031 beers · last sync 2026-11-07'` (дата — перші 10 символів ISO; групування — `count()` з popup).
  - `localDbSummary({checkins: 1, beers: 1, …})` → однина `'1 check-in · 1 beer · …'`.
  - Секція `#localDb` прихована з Telegram-токеном і показана без нього.
  - Клік `#localDbClear` → `confirm` з текстом `'Delete 12 407 check-ins stored in this browser? Your Untappd account is not affected.'` (вузький пробіл у числі); «так» → `{type: 'local-db:clear'}` і `#localDbStatus` `'Cleared.'`, підсумок оновлено; «ні» → повідомлення не надсилається.
- [ ] **Step 2:** тести FAIL.
- [ ] **Step 3:** реалізувати секцію: заголовок `Local check-ins`, абзац `Without a Telegram token, your check-ins are stored only in this browser and never sent to our server.`, `#localDbStats`, кнопка `#localDbClear` `Clear local check-ins` (secondary), `#localDbStatus` з `aria-live`. `count()` імпортувати з `popup.ts` не можна (той модуль запускає `initPopup` за наявності DOM) — винести `count` у `extension/src/shared/format.ts` і імпортувати в обох місцях.
- [ ] **Step 4:** тести PASS, гейт розширення, коміт `feat(extension): #924 Options shows and clears the local check-ins`.

### Task 6: Документи

**Files:**
- Modify: `spec.md` (§6), `site/privacy/index.html`, `docs/cws-data-usage.md`, `docs/extension-install-uk.md`, `docs/extension-install-en.md`, `extension/CHANGELOG.md`, план (секція рішень)

- [ ] **Step 1:** `spec.md` §6 — абзац «**Локальний режим (#924).**»: режим за токеном; синк без токена — у IndexedDB, без запитів на `/checkins/*`; накладання (правило з Global Constraints); кеш анонімний; popup «Clear and sync» на іншому акаунті; Options — блок і очищення.
- [ ] **Step 2:** політика приватності — речення: без Telegram-токена історія чекінів, прочитана з untappd.com у вашій сесії, зберігається лише в IndexedDB браузера, не надсилається нікуди й видаляється кнопкою в Options або разом з розширенням. `cws-data-usage.md` — «User activity» NO без змін; «Website content» — додати, що стрічка untappd.com читається й зберігається локально.
- [ ] **Step 3:** інструкції uk/en — розділ «Без Telegram»: Sync працює, ✅ з чекінів у цьому браузері, Clear в Options, інший акаунт → «Clear and sync».
- [ ] **Step 4:** `CHANGELOG.md` `[Unreleased]` — один рядок для користувача: «Without a Telegram token you can now tap “Sync my check-ins”: your check-ins are kept only in this browser, and shop pages show ✅ for beers you've had and your rating. Clear them any time on the options page.»
- [ ] **Step 5:** гейт (повний), коміт `docs: #924 local mode in spec, privacy, guides and changelog`.

## Рішення під час реалізації

- **Задачі 2–3, наявні тести фонового процесу.** Тести A–G у `background/index.test.ts` ганяли синк без токена й очікували відмову чи помилку — з #924 це локальний режим. Їх переписано під local (`no_session`, `outcome: null` замість `error`); тести з токеном (linked) в очікуваннях не правились, як і вимагає Global Constraints.
- **Задача 3, прив'язка запису local.** `username` порожній на старті кроку (ім'я сесії ще невідоме), `linkRevision` — `currentGeneration()` бази. Покоління відрізняє запис до Clear від запису після нього; `token: ''` відрізняє local від linked. У linked прив'язка з порожнім токеном вважається відсутньою.
- **Задача 3, планувальник.** `hasToken` у залежностях планувальника тепер завжди `true` (продовження наміру, який людина запустила, йде в обох режимах). Тиху перевірку без токена стримує окрема залежність `mayCheckQuietly`: лише коли база вже є, інакше `never_synced` — політика приватності обіцяє, що без натискання Sync стрічка не читається (знахідка наскрізного рев'ю). `clearMatchCache` у local нічого не робить — кеш анонімний, натомість після кожної сторінки скидається індекс (`invalidateHadIndex`).
- **Задача 3, перехід linked → local.** Якщо в local стоїть запис статусу з linked-прив'язкою, кеш чиститься best-effort, а статус починається з нуля (`localSyncStatus`): персональні ✅ сервера не мають пережити зняття токена.
- **Задача 4, `tokenStateView`.** Параметр `hasInstall` прибрано: з #924 install-токен більше не міняє ієрархію popup (синк primary в обох станах), він лише додає «missing-beer search» в `authNoteText`.
- **Задача 4, Clear and sync.** Дозвіл на untappd.com просить першим (жест), далі `local-db:clear`; `ok: false` синк не стартує.
- **Задача 5, Options.** Логіку блоку винесено в експортовану `initLocalDb(nodes, hasToken, send, ask)`, щоб тести не піднімали всю сторінку. Порожня база не вимикає кнопку Clear (на зламаній базі лічильники нульові, а очистити її якраз треба); `confirm` тоді без числа: «Delete the check-ins stored in this browser? …». Підсумок без дати синку показує самі лічильники — захисна гілка: ядро пише `updatedAt` разом із записом власника, до першої сторінки.
- **Задача 6, документи.** Крім запланованого, прибрано застарілі речення про «без токена лише глобальні рейтинги» (інструкції uk/en, політика) і про `disabled`-синк без токена в `spec.md` §6 (popup, ієрархія, tab-order); у §2 «Тиха перевірка» тепер і без токена.
- **Наскрізне рев'ю.** «Clear and sync» у popup питає те саме, що Options, і має посилання на untappd.com (повернутися в акаунт власника); ім'я власника береться з запису бази. Зняття токена посеред linked-прогону, що ще не дізнався акаунт, зупиняє прогін. Options слідують за токеном після Save, дата синку — локальна.
