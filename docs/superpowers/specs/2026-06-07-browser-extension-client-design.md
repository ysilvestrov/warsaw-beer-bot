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
| Магазин | Платформа | Рендер сітки | Наслідок для парсера |
|---------|-----------|--------------|----------------------|
| `beerrepublic.eu` | **Shopify** | **SSR** — 48 карток `.product-item` у початковому HTML | чисті стабільні селектори: `.product-item` (картка), `.product-item__vendor` (brewery), `.product-item__title` (назва); фікстура — `curl`. Класична нумерована пагінація (`?page=N`, ~33 сторінки) |
| `onemorebeer.pl` | кастомна `b2b.one` на **Nuxt/Vue** | **client-rendered** — початковий HTML містить лише сайдбар-фільтри + `window.__NUXT__`; `one-catalog-view-list__catalog-row` порожній до гідрації | картки малюються Vue **після** гідрації → content script мусить **дочекатися рендеру** перед парсом (§3.4); фікстура — рендер-дамп (headless Playwright), не `curl`. Класична пагінація (~1884 пива / ~126 сторінок) |

Платформи різні **і рендеряться по-різному** → парсер **не може** бути одним
generic-скрейпером. Потрібна абстракція **per-site адаптера** (§3.1) плюс
**render-readiness gate** для client-rendered сайтів (§3.4). **Послідовність
імплементації:** спершу `beerrepublic` (повністю concrete, нічим не блокований),
потім `onemorebeer` (render-wait + headless-фікстура). Infinite-scroll/incremental
matching — поза скоупом MVP (обидва — класична пагінація з повним перезавантаженням).

### Рішення, ухвалені в брейнстормінгу
1. **Візуал — бейдж (Option A).** Кутовий бейдж на картці: ✅ + особиста оцінка
   для випитого; нічого/тонкий ⚪ для нового. Найменш інтрузивно, завжди читабельно.
   Floating-панель і «hide drunk»-toggle — свідомо поза скоупом MVP (можна додати пізніше).
2. **onemorebeer brewery — з ноди `Producent:`, не евристикою з тайтла.** Тайтл
   містить «PRODUCENT Назва»; brewery читаємо з виділеної ноди `Producent: <brewery>`,
   назву — з тайтла (з опційним стрипом відомого префікса-пивоварні). ABV — з
   `Dane techniczne → Moc`, коли є; інакше опускаємо (контракт дозволяє `abv?`).
   Точні селектори визначаються на рендер-фікстурі (§3.4, §6), бо сітка
   client-rendered.
3. **Match-on-load (per page) + render-wait.** Один `POST /match` на видиму сітку
   кожної сторінки. `beerrepublic` (SSR) парситься одразу на `DOMContentLoaded`;
   `onemorebeer` (client-rendered) — **після** того як render-readiness gate (§3.4)
   виявив намальовані картки. Перехід на `?page=N` = повне перезавантаження →
   потік повторюється. Infinite-scroll/incremental matching — поза скоупом MVP.
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
(SSR-сайт (`beerrepublic`) стартує потік на `DOMContentLoaded`; client-rendered
(`onemorebeer`) — після render-readiness gate (§3.4). Кожна `?page=N` — повне
перезавантаження → потік повторюється. Динамічного довантаження карток у межах
сторінки нема, тож incremental matching не потрібен.)

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
│   │   ├── types.ts              #   SiteAdapter { hostMatch, parseCards, waitForGrid? }
│   │   ├── beerrepublic.ts       #   Shopify SSR: .product-item / __vendor / __title
│   │   ├── onemorebeer.ts        #   Nuxt client-rendered: Producent/Moc/title + waitForGrid
│   │   └── registry.ts           #   вибір адаптера за hostname
│   ├── content/
│   │   ├── index.ts              #   orchestrate: (waitForGrid?) → parse → cache/match → render
│   │   ├── grid-ready.ts         #   render-readiness gate (observe+timeout helper) — §3.4
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
  hostMatch(url: URL): boolean;            // чи цей адаптер для цього хоста
  parseCards(root: ParentNode): Card[];    // витягти картки з (під)дерева DOM
  waitForGrid?: (root: ParentNode) => Promise<void>;  // опц.: дочекатися client-render
}
```
- `beerrepublic.ts` (SSR): brewery ← `.product-item__vendor`; name ←
  `.product-item__title`; картка ← `.product-item`; abv зазвичай відсутній на
  картці → опускаємо. **`waitForGrid` не визначено** (картки вже в DOM).
- `onemorebeer.ts` (client-rendered): brewery ← нода `Producent:` у картці;
  name ← тайтл (стрип префікса-пивоварні); abv ← `Moc (%)` (опційно).
  **Визначає `waitForGrid`** (чекає появи карток у `catalog-row`). Точні
  селектори — з рендер-фікстури (§3.4, §6).
- `registry.ts`: `pickAdapter(url)` → перший адаптер, чий `hostMatch` істинний.

`parseCards` приймає `root` (а не `document`) для тестопридатності (парс
фікстури-фрагмента); у рантаймі `root === document`.

### 3.4 Render-readiness gate (`content/grid-ready.ts`)
Для client-rendered сайтів (`onemorebeer`) картки зʼявляються в DOM **після**
гідрації Vue. Адаптерний `waitForGrid(root)` повертає `Promise`, що резолвиться,
коли в контейнері сітки зʼявився ≥1 елемент-картка. Реалізація — спільний хелпер
`waitForSelector(root, selector, { timeoutMs })`: миттєва перевірка → інакше
`MutationObserver` на `root` (subtree) + `setTimeout`-fallback; резолвиться на
першій появі або по таймауту (graceful — парсимо що є). Це **one-shot
render-gate**, не infinite-scroll observer: спрацьовує раз на завантаження
сторінки. SSR-адаптери `waitForGrid` не визначають → content script парсить одразу.

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
2. Content script на `DOMContentLoaded`: якщо адаптер має `waitForGrid`, спершу
   `await adapter.waitForGrid(document)` (render-gate §3.4); тоді
   `adapter.parseCards(document)` → `Card[]`.
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
  - `beerrepublic` фікстура: `curl https://beerrepublic.eu/collections/all`
    (SSR — картки вже в HTML).
  - `onemorebeer` фікстура: **рендер-дамп** через headless Playwright (`curl`
    дає порожню сітку). Скрипт `scripts/capture-omb-fixture.ts`: завантажує
    `/piwa`, чекає селектор картки, пише `outerHTML` сітки у `tests/fixtures/`.
    На VPS без GUI — headless, GUI не потрібен.
- Unit-тести: TTL-логіка кеша, `normalize` ключа, `api/client` (mock fetch),
  `grid-ready` `waitForSelector` (jsdom + ручний MutationObserver-тригер),
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
- **Infinite-scroll / incremental matching** — обидва магазини зараз класична
  пагінація; додамо лише якщо зʼявиться динамічне довантаження карток у межах
  сторінки. (Render-gate §3.4 — це інше: one-shot очікування першого рендеру.)
- Floating summary-панель і «hide drunk»-toggle (dim/blur уже-випитого).
- Будь-які магазини окрім двох перших.
- Запис/синхронізація стану назад у бекенд (розширення лишається read-only).
- Popup-UI (працюємо лише через options + інжект на сторінці).

---

## 8. Відкриті питання / ризики
- **onemorebeer селектори client-rendered.** Точна структура картки (нода
  `Producent:`, тайтл, `Moc`) фіксується на рендер-фікстурі (§6). `beerrepublic`
  селектори вже підтверджені на SSR HTML (`.product-item`/`__vendor`/`__title`).
- **onemorebeer стрип префікса-пивоварні з назви.** Перевірити на фікстурі, що
  `name` чисто відділяється від `Producent:` (крайові кейси колаб «X / Y»);
  бекендний `normalize.ts`/brewery-alias частково страхує.
- **`waitForGrid` таймаут.** Дефолт (напр. 8 с) — щоб повільна гідрація не лишила
  сторінку без бейджів; по таймауту парсимо що встигло намалюватися (graceful).
- **`optional_host_permissions` UX** при зміні base URL: де саме просити
  permission (на save в options) — деталь плану.
