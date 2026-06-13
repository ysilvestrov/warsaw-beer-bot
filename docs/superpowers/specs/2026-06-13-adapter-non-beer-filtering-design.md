# Adapter non-beer filtering (packs/sets/merch) — design

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-13. **Мотивація:** аналіз `enrich_failures` (прод, 2026-06-12) показав
> ~21 orphan-рядок, що є **не-пивом** (brewery packs, vertical sets, мерч `+ келих`) — їх
> ніколи не знайти на Untappd, але вони безкінечно ретраяться в енричі.
> **Звіряти з:** `spec.md` §6 (Browser Extension Client), §3.13 (`enrich_failures`), §4 (`/enrich/*`).

## 1. Problem

Каталог орфанів (беври без `untappd_id`) наповнюється тим, що **розширення зараз парсить
зі сторінок магазинів**: на кожен прохід content script шле побачені `(brewery, name)` у
`POST /enrich/candidates`, де `ensureBeerRow` створює рядок у `beers`. Якщо адаптер віддає
карткою не-пиво (набір/пак/мерч), воно:

1. створюється як orphan-беври,
2. провалює енрич (`not_found`, бо на Untappd його немає),
3. логується в `enrich_failures` і **ретраїться вічно**.

Станом на 2026-06-12 таких ~21 рядок (див. Додаток A). Приклади: `Drekker Brewery Pack`,
`Limited Edition Anniversary Vertical Set`, `Набір пива Underwood … tasting big set … + келих`.

**Чому фільтрувати на адаптері, а не на сервері.** Серверний blanket-гейт по назві дав би
false-positive'и на реальних пивах (`Beer in a Box`, `Glass`, `Ironic T-Shirt`-подібні бренди).
Найкращий сигнал «не-пиво» **шоп-специфічний**: `hoptimaal` знає його з URL колекції
(`/bundles`, `/merch`), `winetime` — з назви (`Набір`, `+ келих`). Тому рішення фільтрується
адаптером, який має контекст магазину.

**Поточний стан (3 з 6 адаптерів фільтрують, усі по-різному):**

| Адаптер | Фільтр не-пива? | Сигнал |
|---|---|---|
| beerrepublic | ✅ | regex по назві (`vertical set\|brewery pack\|surprise box\|advent calendar`) |
| bierloods22 | ✅ | regex по title (`beerbox`, `beer package`, `subscription`, `abonnement`…) |
| hoptimaal | ✅ | regex по **URL/колекції** (`/bundles`, `/merch`, `/spirits`…) |
| onemorebeer | ❌ | — |
| beerfreak | ❌ | — |
| winetime | ❌ | — (саме він віддав `Набір… + келих`) |

Немає ні спільного контракту, ні тесту, який **гарантує**, що адаптер відкидає не-пиво.

## 2. Goals / Non-goals

**Goals.**
- Зробити «адаптер відкидає очевидні не-пива (паки/сети/мерч)» **тестовано-обов'язковою**
  поведінкою кожного адаптера; механізм детекції лишається шоп-специфічним.
- Привести всі 6 адаптерів до відповідності (3 вже фільтрують поведінково — потрібна фікстура;
  3 — `onemorebeer`/`beerfreak`/`winetime` — отримують новий фільтр).
- Разово вичистити наявні ~21 не-пиво-рядок з прод-БД.
- Оновити рунбуки (`docs/debug-orphan-matching.md`, `docs/adapter-authoring.md`) і `spec.md`.

**Non-goals.**
- Серверний name-pattern гейт (відхилено через FP-ризик — див. §1).
- Новий admin-endpoint для видалення (purge — разова згенерована sudo-команда, §5).
- Зміни матчера/енрич-пайплайну (це окремі ішьюзи #136–139, #120).

## 3. Decision — тестово-форсований контракт адаптера

Кожен адаптер ПОВИНЕН не віддавати картками очевидні не-пива. Це форситься новим кейсом
у конформанс-тесті над реєстром (`extension/src/sites/conformance.test.ts`,
`describe.each(ADAPTERS)`): адаптер без фільтрації **валить CI**.

### 3.1 Форма фікстури (затверджено)

- `extension/tests/fixtures/<id>.nonbeer.html` — **тільки** картки не-пива (curated: pack/set/merch
  у форматі карток того магазину).
- Конформанс-кейс: `expect(adapter.parseCards(<nonbeer fixture>)).toEqual([])` — фікстура з
  чистого не-пива МУСИТЬ дати **нуль** карток. Асерт на `length 0` (а не на substring зі списку
  «excluded») робастний: адаптери чистять назви (бренд зрізається), тож substring-перевірка була б
  крихкою. Чистий нуль карток однозначний.
- **Escape hatch.** Магазин із підтверджено-нульовим не-пивом може віддати сайдкар
  `extension/tests/fixtures/<id>.nonbeer.json` = `{ "none": true, "reason": "…" }` — тест пропускає
  кейс, але **вимагає непорожнього `reason`**, щоб не фабрикувати фіктивні фікстури й не ховати
  пропущену фільтрацію.
- Якщо для зареєстрованого адаптера немає ні `.nonbeer.html`, ні `.nonbeer.json` з `none:true` —
  **червоний CI** (дзеркалить наявну вимогу на `<id>.html`).

> Позитивний бік: `.nonbeer.html` фіксує приклад не-пива з магазину разом із фільтром —
> регресія («хтось послабив фільтр») ловиться одразу.

### 3.2 Спільний хелпер `non-beer.ts` (шар 1 з 3)

Name-based адаптери (`beerrepublic`, `bierloods22`, `winetime`, `beerfreak`) ділять **один
консервативний словник пакувальних фраз/ваучерів**. `hoptimaal` лишається на URL-сигналі.

`extension/src/sites/non-beer.ts`:
- `isNonBeerName(name: string): boolean` — match **багатослівних пакувальних фраз** плюс кілька
  однозначних одиничних слів; **ніколи** голих неоднозначних слів (`box`, `glass`, `puszka` окремо
  НЕ матчаться → захист від FP: `Beer in a Box`, банка `… PUSZKA … KAUCJA`).
- Фінальний словник (звірено з реальними сторінками 2026-06-13):
  - EN: `brewery pack`, `vertical set`, `tasting set`, `tasting box`, `beer package`,
    `beerpackage`, `beer box`/`beerbox`, `advent calendar`, `surprise box`, `signature box`,
    `craftbeer box`, `gift set`, `gift box`, `gift pack`, `gift certificate`, `mixed pack`,
    `mixed case`, `subscription`, `abonnement`, `certificate`;
  - PL: `zestaw`, `pakiet`, `+ szklank…`, `+ glass`;
  - UA: `набір`, `сертифікат` (ваучер beerfreak), `пакування` («Подарункове пакування замовлення»),
    `+ келих` (бандл winetime).
- Unit-тести хелпера: і пакувальні фрази/ваучери (мають матчитись), і FP-кейси
  (`Beer in a Box`, `Glass`, `Imperial Hard Cider`, `MAGIC ROAD … PUSZKA … KAUCJA` — **не**-матч).

### 3.2.1 Шоп-локальні токени (шар 2) і page-gate (шар 3)

Реальні дані показали, що частина не-пива **не ловиться спільним словником**:
- **onemorebeer `/szklanki-i-akcesoria`** — скло/кухлі/футболки/книги (`szklanka`, `pokal`, `kufel`,
  `koszulka`, `książka`), кожне з **реальною пивоварнею-брендом** (тож гард `!brewery` не рятує).
  Це польські merch-токени → живуть **в адаптері** (`MERCH_RE` в `onemorebeer.ts`), не в спільному
  словнику. **FP-гард:** на цій же сторінці є реальне пиво `MAGIC ROAD … PUSZKA 0,5 L KAUCJA`
  (банка+застава) — `MERCH_RE` його НЕ чіпає, бо `puszka`/`kaucja` не merch-токени.
- **onemorebeer `/delikatesy`** — софт-дрінки з реальними брендами (`KOFOLA`, `VIGO KOMBUCHA`,
  `VITA ALOE`, `KWAS CHLEBOWY`) — **спільного токена в назві немає**. Єдиний надійний сигнал —
  **категорія/URL**. → новий опційний метод контракту `SiteAdapter.isNonBeerPage(url): boolean`;
  overlay (`content/main.ts`) пропускає сторінку повністю, коли `true`. onemorebeer матчить
  `/delikatesy`. (`/szklanki-i-akcesoria` НЕ гейтиться повністю — там є пиво MAGIC ROAD, тож
  per-product через `MERCH_RE`.)

`isNonBeerPage` тестується bespoke-тестом адаптера (`/delikatesy`→true, `/piwa`,
`/szklanki-i-akcesoria`→false); конформанс-фікстура для onemorebeer — сторінка аксесуарів
(чистий merch → `parseCards`→`[]`).

### 3.3 Ретрофіт адаптерів

- `winetime` — `isNonBeerName(rawTitle)` (ловить `Набір`/`+ келих`/`сертифікат`) + синтетична `.nonbeer.html`.
- `beerfreak` — `isNonBeerName(rawTitle)` (ловить `набір`/`сертифікат`/`пакування`) + реальна `.nonbeer.html`
  з `beerfreak.org/beer-sets/` (curl + challenge-cookie).
- `onemorebeer` — `MERCH_RE` (шоп-локальні merch-токени) в `parseCards` + `isNonBeerPage('/delikatesy')`;
  реальна `.nonbeer.html` з `/szklanki-i-akcesoria` (Playwright capture); bespoke-тест на MAGIC ROAD.
- `beerrepublic` — мігрувати на спільний хелпер + синтетична `.nonbeer.html`.
- `bierloods22` — лишити `PACKAGE_TITLE_RE` + синтетична `.nonbeer.html` (без зміни коду).
- `hoptimaal` — лишити URL-фільтр + синтетична `.nonbeer.html` з merch/bundle-карткою (без зміни коду).

## 4. spec.md / рунбуки

- **`spec.md` §6** — додати інваріант контракту: *адаптер ПОВИНЕН виключати не-пива
  (паки/сети/мерч/софт-дрінки) — `isNonBeerName` / шоп-локальні токени / `isNonBeerPage`;
  форситься конформанс-тестом (`.nonbeer.html` або `none:true`)*. Розширити опис конформанс-тесту
  (зараз рядки ~839–847) новим кейсом. Згадати опційний `SiteAdapter.isNonBeerPage(url)`.
- **`docs/adapter-authoring.md`** — новий крок між поточними 4 і 5: «реалізувати фільтр
  не-пива + покласти `.nonbeer.html`/`.json` (або `none:true` з причиною); конформанс це форсить».
- **`docs/debug-orphan-matching.md`** — нова гілка тріажу «orphan = не-пиво»: як упізнати
  пак/сет/мерч, що корінь — **відсутній фільтр адаптера** (не матчер), і вказівка на purge (§5)
  з caveat про порядок (після broadcast).

## 5. Разовий purge наявних не-пив

**Безпека (перевірено на снапшоті 2026-06-12):** усі ~21 рядок мають `untappd_id IS NULL` і
**не мають** посилань у `match_links`, `checkins`, `taps` → безпечні до hard-delete (каскадить
`enrich_failures`).

**Механізм (затверджено):** разова **згенерована sudo-команда**, яку оператор запускає вручну
(не endpoint, не загальна процедура). Команда:
1. виконує спершу **dry-run `SELECT`** того, що буде видалено (оператор очима звіряє),
2. потім guarded `DELETE` у транзакції з гейтом
   `untappd_id IS NULL AND NOT EXISTS(match_links) AND NOT EXISTS(checkins)`.

Запуск під bot-користувачем через дозволений wrapper:
`sudo -u warsaw-beer-bot /usr/bin/bash -lc '…sqlite3 /var/lib/warsaw-beer-bot/bot.db …'`.
Точна команда генерується під фінальний список патернів і кладеться в рунбук + видається оператору.

**Порядок (важливо).** Фільтри адаптера — клієнтські; вони зупиняють **повторне створення**
лише після broadcast перебудованого розширення. Тому послідовність:
**merge фільтрів → broadcast → purge.** Purge до broadcast → старі клієнти при перегляді тих
магазинів частково наповнять рядки назад через `/enrich/candidates → ensureBeerRow`.

## 6. Testing

- **Конформанс** (`extension/src/sites/conformance.test.ts`): новий `.nonbeer`-кейс для всіх 6
  адаптерів (Vitest).
- **Хелпер** (`extension/src/sites/non-beer.test.ts`, якщо прийнято §3.2): пакувальні фрази +
  FP-кейси.
- **Bespoke** адаптерів: лише шоп-специфічні маркери, без дублювання контракту.
- Зелений `npm test` в `extension/` до мержу; purge — після broadcast (ручний крок оператора).

## 7. Rollout

1. PR: хелпер (опц.) + ретрофіт 6 адаптерів + `.nonbeer`-фікстури + конформанс-кейс + оновлення
   `spec.md`/рунбуків.
2. AI-review loop (memory `feedback_pr_review_loop`), мерж.
3. `npm run release` → broadcast розширення тестерам (закриває й pending 0.5.2-broadcast).
4. Після broadcast: запустити згенеровану purge-команду (dry-run → DELETE).

## 8. Risks

- **FP у словнику.** Пом'якшено: лише багатослівні фрази, адаптер за останнім словом,
  unit-тести на бренди-як-назви. Кожен новий маркер звіряється проти каталогу перед додаванням.
- **Refill до broadcast.** Пом'якшено порядком §5 (purge після broadcast).
- **Артефіційні фікстури.** Пом'якшено escape hatch `none:true` з обовʼязковою причиною.

## Додаток A — наявні не-пиво-рядки (прод 2026-06-12, безпечні до видалення)

beer_id: 25794 (`Набір пива Underwood … tasting big set … + келих`), 26030
(`Limited Edition Anniversary Vertical Set`), 26035/26036 (Firestone Walker
`Brewer's Collective`/`Cocktail Inspired Brewery Pack`), 29187–29203 (`* Brewery Pack`,
вкл. `… Edition`, Messorem `Collaboration/Demoliri Brewery Pack`). Усі: `untappd_id IS NULL`,
0 посилань у `match_links`/`checkins`/`taps`. Цидри (напр. `Imperial Hard Cider`) — **НЕ**
чіпати: валідні Untappd-сутності.
