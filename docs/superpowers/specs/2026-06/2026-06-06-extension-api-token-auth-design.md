# Browser Extension API & Token Auth — design

> **Статус:** Approved (brainstorming) → ready for writing-plans.
> **Дата:** 2026-06-06.
> **Цикл:** brainstorming → spec → plan → worktree (CLAUDE.md §5.1).
> **Похідне джерело постановки:** `task.txt` (draft), уточнене в брейнстормінгу.
> **Зачіпає `spec.md`:** так — §2.2 (нова дир. `api/`), §3 (міграція v8 +
> таблиця `api_tokens`), §4 (нова команда `/extension`), §5.6 (нова env
> `API_PORT`), §5.9 (cloudflare-роут у деплой-чек-лист). Оновити в тому ж PR.

---

## 1. Контекст і мета

Браузерне розширення для інтернет-магазинів крафтового пива має підсвічувати
пиво, яке користувач уже пив, його особисту оцінку і глобальний рейтинг. Щоб
уникнути локів SQLite і дублювання матч-логіки, API **вбудовується в поточний
Node.js-процес бота** через мікрофреймворк **Hono**, а не виноситься в окремий
сервіс. Розширення — **read-only** клієнт; автентифікація — статичні
per-user токени, які генерує бот.

**Скоуп цього spec — лише серверний API і токен-шар.** Саме розширення
(per-shop DOM-адаптери) — окремий проєкт, що *споживає* цей контракт.

### Рішення, ухвалені в брейнстормінгу
1. **Структурований вхід.** Клієнт надсилає `{ brewery, name, abv? }`, а не
   сирий рядок. Розбір «brewery+name» живе в розширенні, де є DOM-контекст
   магазину; сервер зберігає brewery-hard-gate `matchBeer` недоторканим
   (висока точність, низький рівень хибних «ти це пив»).
2. **Мережа — через наявний Cloudflare-тунель.** Hono слухає `127.0.0.1`,
   публічний хост `beer-api.ysilvestrov-ai.uk` віддається тунелем (TLS на
   edge, жодних відкритих вхідних портів) — той самий патерн, що й
   `code.ysilvestrov-ai.uk → 127.0.0.1:8080` (code-server).
3. **Токен зберігається як `sha256`-хеш.** Сирий токен бачить лише
   Telegram-повідомлення; БД (стрім у R2 через Litestream) ніколи не містить
   сирих токенів. Витік бекапу → лише марні хеші.
4. **Захист від зловживань — на edge** (Cloudflare WAF rate-limit), не в коді.

---

## 2. Архітектура (огляд)

```
[shop page JS]                         the bot process (single Node.js)
   fetch https://beer-api...   ┌───────────────────────────────────────┐
        │  Bearer <token>      │  Telegraf bot  ──/extension──► api_tokens │
        ▼                      │                                         │
[Cloudflare edge: TLS, WAF]    │  Hono app (127.0.0.1:API_PORT)          │
        │ tunnel (outbound)    │   cors → auth(Bearer→sha256) → /match    │
        ▼                      │              │                          │
[cloudflared on host] ────────►│   domain/match-list (pure)  storage/*   │
                               │              └────────► SQLite (1 handle)│
                               └───────────────────────────────────────┘
```

Один процес, одне SQLite-з'єднання (без локів між ботом і API). Залежності
(`db`, `log`, `env`) збираються в composition root (`src/index.ts`) і
ін'єктуються в Hono через замикання — **жодних `process.env`/глобалів у
маршрутах** (spec.md §2.3).

---

## 3. Зміни в базі даних — міграція v8

Нова таблиця токенів доступу:

```sql
CREATE TABLE api_tokens (
  token_hash  TEXT PRIMARY KEY,            -- sha256(raw token), hex
  telegram_id INTEGER NOT NULL
              REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_api_tokens_telegram ON api_tokens (telegram_id);
```

- `token_hash` — PK, уже індексований → пошук за хешем покритий. Окремий
  `idx_api_tokens_token` із драфту **не потрібен** (надлишковий).
- `idx_api_tokens_telegram` потрібен для ротації (видалення старого рядка
  користувача).
- `ON DELETE CASCADE` — токен зникає разом із профілем.
- Реєструється як міграція **v8** у `src/storage/schema.ts`; оновити таблицю
  історії міграцій у `spec.md §3.13`.

---

## 4. Telegram-шар — команда `/extension`

- Новий файл `src/bot/commands/extension.ts`; підключення в `src/index.ts`
  (`bot.use(...)`); додання в `COMMAND_CATALOG`
  (`src/bot/commands/catalog.ts`) — щоб `/help` і нативне меню Telegram
  (`registerCommandMenu`) підхопили команду.
- i18n-опис `cmd.extension` в `uk`/`pl`/`en`; текст повідомлення (інструкція +
  URL) теж локалізований.
- **Логіка генерації** (одна транзакція, ротація 1:1):
  1. `raw = crypto.randomBytes(32).toString('hex')`;
  2. `hash = sha256(raw)` (hex);
  3. `DELETE FROM api_tokens WHERE telegram_id = ?` (інвалідація старого
     токена **негайно**, без grace-вікна);
  4. `INSERT` нового рядка.
- **Відповідь:** сирий `raw` у `code`-блоці + інструкція додати його в
  налаштування розширення + URL API. **HTML-режим:** локалі-рядки екрануються
  в білдері; жодних metavar-кутових дужок (memory: telegraf-html-locale).
- Чиста частина (форматування тексту) виноситься в `*-build`/`*-format` і
  тестується окремо (spec.md §5.5); сама команда лише склеює.

Новий storage-модуль `src/storage/api_tokens.ts`:
- `rotateToken(db, telegramId, hash, at)` — delete-then-insert у транзакції;
- `findTelegramIdByHash(db, hash): number | null` — для auth-middleware.

---

## 5. API-шар — `src/api/`

```
src/api/
├── index.ts            # createApiApp(deps): Hono;  createApiServer(app, env): server
├── middleware/auth.ts  # Authorization: Bearer → sha256 → lookup → c.set('telegramId') | 401
└── routes/match.ts     # POST /match (тонкий handler)
```

- Нові рантайм-залежності: `hono`, `@hono/node-server`, `@hono/zod-validator`.
- **Ініціалізація** в `src/index.ts` (composition root): `createApiApp({ db,
  log, env })` → `serve({ fetch: app.fetch, hostname: '127.0.0.1', port:
  env.API_PORT })`. Логуємо `api listening`.
- **CORS:** `hono/cors` з `origin: '*'`. Безпечно: автентифікація — заголовок
  `Authorization`, не cookie, тож `*` дозволений і креденшели не віддзеркалю-
  ються. (Origin запиту = домен магазину, не наш — тому CORS обов'язковий.)
- **`GET /health`** (без авторизації) → `{ ok: true }` для тунель/uptime-чека.
- **Auth-middleware застосовується лише до `/match`** (монтується на цьому
  роуті, не глобально), щоб `/health` лишався відкритим. Логіка: читає
  `Authorization: Bearer <token>`; якщо немає/невір-
  ного формату → `401`; інакше `sha256(token)` → `findTelegramIdByHash`; немає
  рядка → `401`; є → `c.set('telegramId', id)` і `next()`.
- **`env.ts`:** додати `API_PORT: z.coerce.number().int().positive().default(3000)`.

### Graceful shutdown
`ShutdownDeps` (`src/shutdown.ts`) отримує http-сервер. Порядок teardown:
**cron → bot → http-сервер → db** (сервер перестає приймати з'єднання до
закриття БД, бо handler'и читають БД). Закриття сервера — через
`server.close()` обгорнуте в Promise; помилка лише логується (як решта кроків).

---

## 6. Доменна логіка — `POST /match`

### Контракт
**Запит (zod, `@hono/zod-validator`):**
```ts
{ beers: Array<{ brewery: string; name: string; abv?: number }> }
//  .min(1).max(200)  — обмежує роботу на запит
```

**Відповідь (порядок результатів = порядок входу):**
```json
{ "results": [
  { "raw": { "brewery": "Trzech Kumpli", "name": "Pan IPAni" },
    "matched_beer": { "id": 105, "name": "Pan IPAni",
                      "brewery": "Trzech Kumpli", "rating_global": 3.85 },
    "is_drunk": true, "user_rating": 4.0 },
  { "raw": { "brewery": "X", "name": "Unknown Stout" },
    "matched_beer": null, "is_drunk": false, "user_rating": null }
]}
```
- `raw` — ехо вхідного елемента, щоб розширення корелювало без покладання
  лише на позицію.
- `user_rating` = `null`, коли пиво «випите» лише через `untappd_had` (без
  чекіну) — узгоджено й очікувано.

### Чиста функція `src/domain/match-list.ts`
```ts
matchBeerList(
  catalog: CatalogBeer[],
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: Array<{ brewery: string; name: string; abv?: number | null }>,
): MatchListResult[]
```
- **Без I/O.** Для кожного `item` викликає наявний `matchBeer` (brewery
  hard-gate + name-fuzzy збережені); за `id` визначає `is_drunk` (належність
  до `drunkSet`), `user_rating` (з `ratingByBeerId`), `matched_beer` (з
  каталогу/рейтинг-мапи).
- **Покривається unit-тестами ПЕРШОЮ**, до HTTP-handler'а (spec.md §5.3).

### Handler `routes/match.ts` (тонкий)
Бере `telegramId` з контексту (виставлений auth-middleware) і на кожен запит
завантажує, **строго скоупнуто по `telegramId`**:
1. каталог — новий лоадер у `storage/beers.ts`
   (`loadCatalog(db) → { id, brewery, name, abv, rating_global }[]`);
2. `triedBeerIds(db, telegramId)` — two-source drunk-set
   (`checkins ∪ untappd_had`);
3. `ratingByBeerId` — найсвіжіший непорожній `user_rating` на пиво: з
   `checkinsForUser` (уже `ORDER BY checkin_at DESC`) — беремо перший
   ненульовий рейтинг на `beer_id`.

Потім викликає `matchBeerList(...)` і повертає JSON.

---

## 7. Інваріанти (з task.txt §6 + spec.md §5.2)

- **Ізоляція користувачів:** кожен запит до історії фільтрується по
  `telegramId` з Bearer-токена. API **ніколи** не віддає історію одного
  користувача іншому. Покрито тестом крос-юзер-ізоляції.
- **Two-source drunk model:** статус «пив/не пив» — лише через `triedBeerIds`
  (`checkins ∪ untappd_had`). Читати лише `checkins` — баг.
- **Без глобалів/`process.env` у маршрутах** — залежності через замикання.
- **Матч-логіка — чиста `domain/`-функція**, unit-тестована першою.
- **Реальний статус матчингу** з `beers.untappd_id`, не з `match_links`
  (тут не використовуємо match_links узагалі — матчимо проти каталогу).

---

## 8. Обробка помилок

- `400` — провал zod-валідації (через `@hono/zod-validator`).
- `401` — відсутній/невірний Bearer-токен.
- `500` — будь-яка неперехоплена помилка; Hono `app.onError` логує `{ err }`
  через pino і повертає мінімальний JSON. **Процес не падає** (дзеркало
  `bot.catch`, spec.md §5.4).
- Збій старту сервера (напр., порт зайнятий) — логується і фатальний у
  composition root (як решта ініціалізації).

---

## 9. Тестування (spec.md §5.3)

- `src/domain/match-list.test.ts` — чисті unit-тести: drunk через checkins;
  drunk лише через had (rating = null); немає матчу; ABV-tiebreak;
  збереження порядку; кілька чекінів → найсвіжіший рейтинг.
- `src/storage/api_tokens.test.ts` — insert / rotate (старий зникає) / lookup
  за хешем; in-memory БД per-test (`fresh()`).
- `src/api/middleware/auth.test.ts` — 401 без/з невірним токеном, прохід із
  валідним.
- `src/api/routes/match.test.ts` — Hono-app над in-memory БД: happy path,
  400 на невалідному body, **крос-юзер-ізоляція** (токен A не бачить історію B).
- `src/storage/schema.test.ts` — застосування міграції v8.

---

## 10. Деплой / ops (spec.md §5.9 + appendix)

- Нові рантайм-deps: `hono`, `@hono/node-server`, `@hono/zod-validator`
  (в `dependencies`, не dev).
- **Ручний крок (користувач):** додати в Cloudflare Zero Trust public-hostname
  роут `beer-api.ysilvestrov-ai.uk → http://localhost:3000` (тунель
  token-managed → роути в дашборді, не в локальному файлі).
- `.env.example` + прод `/etc/warsaw-beer-bot/.env` отримують `API_PORT`
  (default 3000 — можна не задавати явно).
- Жодних відкритих вхідних портів на хості (тунель — outbound).

---

## 11. Поза скоупом (YAGNI)

- Саме браузерне розширення (окремий проєкт; цей spec лише дає контракт).
- App-level rate-limiting (на edge через Cloudflare WAF).
- Кілька активних токенів на користувача (ротація строго 1:1).
- Write-ендпойнти (API лишається read-only).
- Token-scopes / expiry (статичні токени; ротація через повторний `/extension`).
