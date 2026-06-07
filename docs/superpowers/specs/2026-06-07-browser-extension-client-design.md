# Browser Extension Client (drunk-status overlay) — design

> **Статус:** Approved (brainstorming) → ready for writing-plans.
> **Дата:** 2026-06-07.
> **Цикл:** brainstorming → spec → plan → worktree (CLAUDE.md §5.1).
> **Похідне джерело постановки:** `task.md` (draft), уточнене в брейнстормінгу.
> **Попередник:** `2026-06-06-extension-api-token-auth-design.md` — серверний
> `POST /match` + токен-шар; цей spec описує **клієнта**, що споживає той контракт.
> **Зачіпає `spec.md`:** так — нова секція про компонент `extension/`
> (монорепо-lite), згадка в §2.2 (структура), посилання на §4 `POST /match`
> контракт і §5.9 (cloudflare-хост). Оновити в тому ж PR.

---

## 1. Контекст і мета

Read-only браузерне розширення, що накладає **особистий drunk-статус і рейтинг**
на сітки товарів у магазинах крафтового пива. Воно парсить видимі картки пива,
шле `{ brewery, name, abv? }` у наявний `POST /match` і малює бейдж на кожній
картці: ✅ + твоя оцінка для випитого, нічого (або тонкий ⚪) для нового/незматченого.

Розширення **нічого не змінює** на сторінці магазину окрім власних вставлених
бейдж-нод — жодного втручання в кошик/чекаут/решту DOM.

**Скоуп цього spec — сам клієнт** (scaffolding + per-shop DOM-адаптери +
рендер + кеш). Серверний контракт уже існує (spec.md §4 `POST /match`,
міграція v8 `api_tokens`, команда `/extension`) і **не змінюється**.

### Перші цільові магазини
| Магазин | Платформа | Наслідок для парсера |
|---------|-----------|----------------------|
| `onemorebeer.pl` | кастомна `b2b.one`, **server-rendered** | сітка `/piwa` віддає `Producent:`, `Styl`, `Moc (%)`, обʼєм у початковому HTML; класична пагінація (~1884 пива / ~126 сторінок) |
| `beerrepublic.eu` | **Shopify**, server-rendered | картка віддає brewery окремим лінком + назву тайтлом; **класична нумерована пагінація** (`?page=N`, ~33 сторінки) — без infinite scroll |

Платформи різні → парсер **не може** бути одним generic-скрейпером. Потрібна
абстракція **per-site адаптера** (див. §3.1). **Обидва** магазини — server-rendered
з класичною пагінацією (повне завантаження сторінки на кожен `?page=N`), тож
динамічного довантаження карток у DOM немає → `MutationObserver` у MVP не потрібен.

### Рішення, ухвалені в брейнстормінгу
1. **Візуал — бейдж (Option A).** Кутовий бейдж на картці: ✅ + особиста оцінка
   для випитого; нічого/тонкий ⚪ для нового. Найменш інтрузивно, завжди читабельно.
   Floating-панель і «hide drunk»-toggle — свідомо поза скоупом MVP (можна додати пізніше).
2. **onemorebeer brewery — з ноди `Producent:`, не евристикою з тайтла.** Тайтл
   містить «PRODUCENT Назва»; brewery читаємо з виділеної ноди `Producent: <brewery>`,
   назву — з тайтла (з опційним стрипом відомого префікса-пивоварні). ABV — з
   `Dane techniczne → Moc`, коли є; інакше опускаємо (контракт дозволяє `abv?`).
3. **Match-on-load (per page).** Один `POST /match` на видиму сітку кожної
   сторінки. Обидва магазини — класична пагінація з повним перезавантаженням,
   тож кожна `?page=N` = свіжий парс + один матч. Infinite-scroll/`MutationObserver`
   — поза скоупом MVP (додамо лише якщо магазин зʼявить динамічне довантаження).
4. **Auth:** токен у `chrome.storage.local` (не sync — credential не їде через
   Google-сервери). Base URL **редагований**, дефолт `https://beer-api.ysilvestrov-ai.uk`.
   Кнопка **Test connection** (пінг `GET /health` → потім 1-beer `/match` для перевірки токена).
5. **Fetch — у background service worker, не в content script.** Bearer-токен
   **ніколи не потрапляє в контекст сторінки магазину**; host-permission логіка
   централізована. Content script ↔ worker через `runtime.sendMessage` (картки → результати).
6. **Кеш — short-TTL persistent.** `chrome.storage.local`, ключ = нормалізований
   `brewery|name`, TTL ~6–12 год. Бекендні drunk-статус/рейтинги міняються лише
   на denну cron-каденцію, тож same-day кеш безпечний і ріже виклики при пагінації.
7. **Стек скаффолда:** Vite + Vanilla TS + `@crxjs/vite-plugin`, MV3. Тести —
   **Vitest** (для пакета `extension/`; бекенд лишається на Jest), jsdom для DOM-тестів.

---

## 2. Архітектура (high-level)

Standalone MV3-розширення в `extension/`, повністю ізольоване від бекенда
(власні `package.json`, deps, build — «monorepo-lite»). Потік:

```
[content script]  parseCards(adapter)  ─┐
   на сторінці магазину                 │  { brewery, name, abv? }[]
                                        ▼
                              cache lookup (TTL)
                                        │ misses
                                        ▼
                       runtime.sendMessage ──► [background worker]
                                        │            │ Bearer + baseUrl
                                        │            ▼
                                        │     POST /match (Hono API)
                                        │            │
                                        ◄────────────┘ results
                                        ▼
                       write fresh → cache;  merge cache hits
                                        ▼
                           badge.ts: render ✅+rating / ⚪
```
(Обидва магазини — класична пагінація: кожна `?page=N` проходить весь потік
заново на свіжому завантаженні сторінки. Динамічного довантаження карток нема.)

**Інваріант:** усе I/O (fetch) і доступ до токена — у worker; content script
бачить лише розпарсені картки й результати матчу, ніколи credential.

---

## 3. Компоненти

```
extension/
├── package.json                 # scripts: dev, build (Vite + @crxjs)
├── vite.config.ts               # @crxjs/vite-plugin, MV3 manifest
├── tsconfig.json                # strict
├── manifest.config.ts           # content_scripts (2 хости), options_page, background
├── src/
│   ├── sites/                    # ── абстракція per-site адаптера ──
│   │   ├── types.ts              #   SiteAdapter { hostMatch(url), parseCards(root)→Card[] }
│   │   ├── onemorebeer.ts        #   Producent:/Moc/title з server-rendered сітки
│   │   ├── beerrepublic.ts       #   Shopify card: brewery-link + title
│   │   └── registry.ts           #   вибір адаптера за hostname
│   ├── content/
│   │   ├── index.ts              #   orchestrate: parse → cache/match → render
│   │   └── badge.ts              #   рендер кутового бейджа (pure DOM)
│   ├── background/index.ts       #   /match + /health fetch; Bearer; messaging
│   ├── api/
│   │   ├── client.ts             #   postMatch(), getHealth()
│   │   └── types.ts              #   MatchRequest/MatchResult — дзеркало контракту §4
│   ├── cache/store.ts            #   short-TTL кеш над chrome.storage.local
│   ├── options/
│   │   ├── options.html
│   │   ├── options.ts            #   token + редагований URL + Test connection
│   │   └── options.css
│   └── shared/
│       ├── config.ts             #   read/write { token, baseUrl } з chrome.storage.local
│       └── normalize.ts          #   ключ нормалізації для кеша (brewery|name)
└── tests/
    └── fixtures/                 #   збережений HTML сіток обох магазинів
```

### 3.1 `SiteAdapter` — інтерфейс парсера
```ts
type Card = { el: HTMLElement; brewery: string; name: string; abv?: number };
interface SiteAdapter {
  hostMatch(url: URL): boolean;          // чи цей адаптер для цього хоста
  parseCards(root: ParentNode): Card[];  // витягти картки з (під)дерева DOM
}
```
- `onemorebeer.ts`: brewery ← нода `Producent:`; name ← тайтл (стрип префікса
  пивоварні); abv ← `Dane techniczne → Moc` (опційно).
- `beerrepublic.ts`: brewery ← окремий лінк пивоварні; name ← тайтл товару;
  abv зазвичай відсутній на картці → опускаємо.
- `registry.ts`: `pickAdapter(url)` → перший адаптер, чий `hostMatch` істинний.

`parseCards` приймає `root` (а не `document`) для тестопридатності (парс
фікстури-фрагмента) і на майбутнє (піддерево, якщо колись зʼявиться динамічне
довантаження); у MVP `root === document` на кожному завантаженні сторінки.

### 3.2 Messaging-контракт (content ↔ background)
```
content → worker:  { type: 'match', cards: { brewery, name, abv? }[] }
worker  → content: { type: 'match:ok', results: MatchResult[] }
                 | { type: 'match:err', code: 'unauthorized'|'network'|'server' }
```
Worker читає `{ token, baseUrl }`, ріже на чанки якщо >200, кешем не займається
(кеш — на боці content script, бо ключ ↔ DOM-нода).

### 3.3 Бейдж (`badge.ts`)
Чиста функція `renderBadge(card.el, result)`: вставляє один абсолютно-позиційний
вузол у кут картки. `is_drunk` → ✅ + `user_rating` (або просто ✅, якщо оцінки
нема); незматчене/нове → нічого (MVP) або тонкий ⚪. Ідемпотентно: повторний
рендер не дублює вузол (data-атрибут-маркер).

---

## 4. Потік даних (детально)
1. Worker на старті / on-demand читає `{ token, baseUrl }` з `chrome.storage.local`.
2. Content script на `DOMContentLoaded`: `adapter.parseCards(document)` → `Card[]`.
3. Для кожної картки — cache lookup за ключем `normalize(brewery|name)`; свіжі
   хіти застосовуються одразу.
4. Кеш-міси → `sendMessage({type:'match', cards})` → worker → `POST /match`
   (чанк лише якщо >200; сітка зазвичай 24–48).
5. Свіжі результати → запис у кеш із TTL; мерж із хітами.
6. `renderBadge` на кожній картці.

Перехід на іншу сторінку (`?page=N`) — повне завантаження → весь потік 1–6
повторюється заново. Динамічного довантаження карток у межах однієї сторінки нема.

---

## 5. Обробка помилок (ніколи не ламати сторінку магазину)
- Будь-який `parseCards`/рендер обгорнутий у `try/catch`; кинутий адаптер
  **не впливає** на магазин (graceful skip, лог у консоль розширення).
- **Немає токена / 401** → бейджі тихо пропускаються + одноразовий ненавʼязливий
  сигнал (badge на іконці розширення), без спаму в консоль.
- **API down / network** → тихий skip, ретрай на наступному завантаженні;
  сторінка магазину недоторкана.
- CORS уже вирішено на сервері (`origin:'*'`, Bearer не cookies — spec.md §4).
- Read-only гарантія: розширення лише **додає** власні вузли; жодних мутацій
  чужого DOM, форм, кошика.

---

## 6. Тестування (дзеркалить конвенції бекенда, spec.md §5.3)
- **Per-site адаптери — контрактні тести на збережених HTML-фікстурах** (як
  `sources/*`): зміна верстки магазину **гучно** валить тест. Найризиковіша поверхня.
- Unit-тести: TTL-логіка кеша, `normalize` ключа, `api/client` (mock fetch),
  messaging-роутинг worker'а.
- Runner — **Vitest** + jsdom (пакет `extension/`); бекенд лишається на Jest.

---

## 7. Scaffolding (Task 1 — виконується після затвердження spec)
1. `extension/` з `@crxjs/vite-plugin` boilerplate (MV3, Vanilla TS).
2. `package.json` зі скриптами `dev`, `build` (+ `test` → vitest).
3. Кореневий `.gitignore`: додати `extension/dist`, `extension/node_modules`.
4. Manifest: `content_scripts` matches для `*.onemorebeer.pl/*` і
   `beerrepublic.eu/*`; `options_page`; background service worker;
   `host_permissions` для дефолтного API-хоста (`beer-api.ysilvestrov-ai.uk`),
   решта хостів — за потреби через `optional_host_permissions` при зміні URL.
5. Оновити `spec.md` новою секцією про компонент `extension/` (той самий PR).

### Свідомо поза скоупом MVP
- **`MutationObserver` / infinite-scroll handling** — обидва магазини зараз
  класична пагінація; додамо лише якщо зʼявиться динамічне довантаження карток.
- Floating summary-панель і «hide drunk»-toggle (dim/blur уже-випитого).
- Будь-які магазини окрім двох перших.
- Запис/синхронізація стану назад у бекенд (розширення лишається read-only).
- Popup-UI (працюємо лише через options + інжект на сторінці).

---

## 8. Відкриті питання / ризики
- **onemorebeer стрип префікса-пивоварні з назви.** Потрібно підтвердити на
  фікстурах, що `name` чисто відділяється від `Producent:` (можливі крайові
  кейси з колабами «X / Y»). Бекендний `normalize.ts`/brewery-alias частково
  страхує на сервері.
- **CSS-селектори карток обох магазинів** фіксуються під час імплементації
  адаптерів на живих фікстурах (`tests/fixtures/`).
- **`optional_host_permissions` UX** при зміні base URL: де саме просити
  permission (на save в options) — деталь плану.
