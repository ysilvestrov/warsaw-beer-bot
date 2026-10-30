# План (ядро): токен установки, облік і журнал промахів у `/match` (#923)

Спека: `docs/superpowers/specs/2026-10/2026-10-30-923-install-token-design.md` (затверджено 30.10).
Ядро — механізм, на якому стоїть решта: таблиці, третій вид доступу, реєстрація/видалення,
облік і журнал у `/match`. **Обв'язка — окремим планом після наскрізного рев'ю ядра:** enrich з
перевіркою (§2.5, разом із паритетом `alias_alt`), рядки дайджесту й прибирання (§2.6, 90 днів),
клієнт, Options/popup, політика, `cws-data-usage.md`, `extension-install-uk.md`, чейнджлог.

**Інваріант ядра:** установка **не** отримує `/enrich/*` — до обв'язки там діє `authMiddleware`, і
токен установки дістає `403`. Так ядро можна мерджити окремо: воно не відкриває каталог на запис.

Гейт: `npm test && npm run typecheck` (тести — лише через `npm test -- <args>`). `spec.md` правиться
в тій задачі, що вводить поведінку.

## Задача 1 — схема v52 і сховища

`src/storage/schema.ts`, міграція `version: 52` (expand-only: нові таблиці й колонка з `DEFAULT`):

```sql
CREATE TABLE IF NOT EXISTS extension_installs (
  install_id     TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL,
  last_seen_date TEXT NOT NULL,
  ext_version    TEXT,
  telegram_id    INTEGER REFERENCES user_profiles(telegram_id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS install_usage_daily (
  date TEXT NOT NULL,
  install_id TEXT NOT NULL REFERENCES extension_installs(install_id) ON DELETE CASCADE,
  shop TEXT NOT NULL DEFAULT '',
  match_requests INTEGER NOT NULL DEFAULT 0, match_beers INTEGER NOT NULL DEFAULT 0,
  match_misses INTEGER NOT NULL DEFAULT 0, enrich_results INTEGER NOT NULL DEFAULT 0,
  enrich_links INTEGER NOT NULL DEFAULT 0, enrich_rejected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, install_id, shop)
);
CREATE TABLE IF NOT EXISTS install_registrations_daily (
  date TEXT PRIMARY KEY,
  registrations INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS match_misses (
  normalized_brewery TEXT NOT NULL, normalized_name TEXT NOT NULL,
  brewery TEXT NOT NULL, name TEXT NOT NULL, abv REAL, shop TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_seen_date TEXT NOT NULL,
  seen_days INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (normalized_brewery, normalized_name)
);
ALTER TABLE api_usage ADD COLUMN install_requests INTEGER NOT NULL DEFAULT 0;
```

`src/storage/schema.test.ts`: тест голови `1..51` → `1..52` (єдиний, що фіксує голову); новий тест
міграції стверджує `WHERE version = 52` і наявність чотирьох таблиць і колонки.

Нові модулі (функціональний стиль, як `api_tokens.ts`):

- `src/storage/extension_installs.ts`
  - `INSTALL_TOKEN_PREFIX = 'wbi_'`, `REGISTRATIONS_PER_DAY = 2000`.
  - `registerInstall(db, { date, at, version, raw }) → { kind: 'ok'; installId } | { kind: 'capped' }` —
    одна `.immediate()` транзакція: прочитати `registrations` за `date`; ≥ стелі → `rejected += 1`,
    `capped`; інакше вставка установки (`install_id = randomUUID()`, хеш через `hashToken`) і
    `registrations += 1`. Генерацію сирого токена (`wbi_` + 32 байти hex) робить маршрут.
  - `findInstallByHash(db, hash) → { installId, lastSeenDate } | null`.
  - `touchInstall(db, installId, { date, version })` — `UPDATE` лише коли `last_seen_date <> date`
    або версія змінилась (без запису на кожен запит).
  - `deleteInstall(db, installId) → boolean` — `install_registrations_daily` не чіпає.
- `src/storage/install_usage.ts` — `recordInstallUsage(db, { date, installId, shop, matchRequests?,
  matchBeers?, matchMisses? })`: UPSERT-інкремент з тим самим прийомом `busy_timeout = 0`, що
  `recordMatchUsage` (гаряча доріжка `/match`). Колонки enrich ядро лише створює.
- `src/storage/match_misses.ts` — `recordMisses(db, { at, date, shop, cards })`: на кожну картку
  UPSERT за `(normalized_brewery, normalized_name)` (нормалізатори — `normalizeBrewery` /
  `normalizeName`, ті самі, що в матчері); `last_seen_at = at`; `seen_days += 1` і
  `last_seen_date = date` лише коли збережена `last_seen_date` ≠ `date` (варшавська дата; різати
  ISO-час у UTC біля півночі дало б не той день). Сирі `brewery/name/abv/shop` пишуться лише при
  вставці. Той самий `busy_timeout = 0`.
- `src/storage/api_usage.ts` — `recordMatchUsage` отримує `caller: 'anon' | 'user' | 'install'`
  замість `authed: boolean` (усі виклики оновити); `install` → `install_requests`. `DailyUsage`
  отримує `installRequests`; `stats.ts` `extMatchRequests` = anon + authed + install.

Тести: реєстрація пише хеш, не сирий токен; 2000 реєстрацій за добу → 2001-ша `capped` і
`rejected = 1`; реєстрація → видалення ×2001 → остання `capped` (стелю не обійти); `touchInstall`
двічі за день — один `UPDATE` (перевір `changes`); `recordMisses`: та сама картка двічі за день →
`seen_days = 1`, наступного дня → `2`, сирі поля з першої появи; `recordMatchUsage` — кожен
`caller` у свою колонку. `spec.md` §3: чотири таблиці, колонка, історія міграцій (v52).

## Задача 2 — третій вид доступу

`src/api/types.ts`:

```ts
export type Principal = { kind: 'user'; telegramId: number } | { kind: 'install'; installId: string };
export type ApiEnv = { Variables: { telegramId: number | null; principal: Principal | null } };
```

Новий `src/api/middleware/resolve-bearer.ts`:
`resolveBearer(db, header, today, version?) → { kind: 'none' } | { kind: 'invalid' } | Principal`.
`wbi_…` шукає лише в `extension_installs` (і викликає `touchInstall`), інше — лише в `api_tokens`.

- `optionalAuthMiddleware` (`/match`): `none` → анонім (`principal = null`); `invalid` → `401`;
  `user` → як зараз; `install` → `principal` установки, `telegramId = null`.
- `authMiddleware` (`/checkins/*`, `/fest/*`, `/mcp`, **і поки що `/enrich/*`**): `install` →
  `403 {error:'install_token_not_allowed'}`; решта — як зараз.

Тести (`optional-auth.test.ts`, `auth.test.ts`): без заголовка → анонім; валідний `wbi_` → install;
невідомий `wbi_` → `401`; Telegram-токен → user (регресія); `wbi_` на кожному з `/checkins`,
`/fest`, `/mcp`, `/enrich/candidates` → `403`; `touchInstall` викликано з варшавською датою.
`spec.md` §4: principal, 403.

## Задача 3 — `POST /installs` і `DELETE /installs/me`

Новий `src/api/routes/installs.ts`, реєстрація в `createApiApp` до `/match`:

- `POST /installs` — без автентифікації, тіло `{ version: string(1..32) }` (zod), ліміт тіла —
  глобальний. `registerInstall`; `ok` → `201 { install_id, token }`; `capped` → `429` і
  `sendThrottledAlert(db, { key: 'install_registrations_cap_alert', everyMs: DAY, … })` з текстом
  «Розширення: досягнуто стелі 2000 реєстрацій установок за добу — реєстрації відхиляються до
  кінця доби (Варшава)». IP маршрут не читає й не логує.
- `DELETE /installs/me` — `authMiddleware`-подібна перевірка лише `wbi_`: валідний → `deleteInstall`,
  `204`; невідомий/відсутній → `401`.
- `ApiDeps` отримує `notifyAdmin?: (msg: string) => Promise<void>`; `src/index.ts` передає наявний
  `notifyAdmin` у `createApiApp`.

Тести (`installs.test.ts`): `201`, токен починається з `wbi_` і має 68 символів, у БД лише хеш;
`version` порожній/33 символи → `400`; на стелі → `429` і рівно одне повідомлення за два відхилення
поспіль; `DELETE` → `204`, повтор тим самим токеном → `401`, `install_usage_daily` установки
зник (каскад), `match_misses` лишився; `DELETE` з Telegram-токеном → `401`.
`spec.md` §4: обидва ендпоінти.

## Задача 4 — облік і журнал у `/match`

`src/api/routes/match.ts`:

- `MatchBody` отримує `client: z.object({ version: z.string().max(64).optional(), shop:
  z.string().max(64).optional() }).optional()`.
- `recordMatchUsage` — `caller` з `principal` (`null` → `anon`).
- Для `principal` будь-якого виду, **після** `matchBeerList`, одним best-effort блоком (try/catch →
  `log.warn`, як наявний облік):
  - промахи = картки, де `result.matched_beer === null && result.searched === true` **і**
    `findActiveDispositionForCard(db, brewery, name, abv)` = `null` → `recordMisses`;
  - для `install` — `recordInstallUsage` з `matchRequests: 1`, `matchBeers: beers.length`,
    `matchMisses: <кількість записаних>`, `shop: client?.shop ?? ''`.
- Анонім без токена не пише нічого нового (лише `api_usage`, як зараз).

Тести (`match.test.ts`): відповідь установки побайтово дорівнює анонімній на тому самому каталозі;
промах із `searched: true` записано, із `searched: false` (бюджет фолбеку вичерпано — у тестах уже є
спосіб його вичерпати) — ні, з активною диспозицією — ні; Telegram-токен пише промахи, але не
`install_usage_daily`; анонім — нічого в `match_misses`; без `client` → `shop = ''`; `api_usage`
отримує `install_requests = 1`; збій запису обліку (закрита таблиця) не ламає відповідь.
`spec.md` §4 `POST /match`: поле `client`, журнал промахів.

## Після ядра

Наскрізне рев'ю (диф ядра проти `origin/main`, спека поруч), потім план обв'язки:
enrich з перевіркою (`/enrich/*` → «user або install», §2.5 цілком), `alias_alt` у
`parseHydratedBeer` з тестом паритету, дайджест і прибирання (§2.6, 90 днів для
`install_usage_daily` і `match_misses`, GC установок 180 днів), клієнт (§3), документи (§4).
