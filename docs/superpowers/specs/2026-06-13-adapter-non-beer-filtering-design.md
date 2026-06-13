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

- `extension/tests/fixtures/<id>.nonbeer.html` — реальні картки не-пива з того магазину.
- Сайдкар `extension/tests/fixtures/<id>.nonbeer.json` — список товарів, що **мусять бути
  виключені**:
  ```json
  { "excluded": ["Drekker Brewery Pack", "Beer Club Subscription"] }
  ```
- Конформанс-кейс: `const cards = adapter.parseCards(<nonbeer fixture>)`; асерт, що **жодна**
  назва зі списку `excluded` не зустрічається в `cards[].name` (та/або title).
- **Escape hatch.** Магазин із підтверджено-нульовим не-пивом може віддати
  `{ "none": true, "reason": "…" }` — тест пропускає асерт-виключення, але **вимагає
  явного обґрунтування**, щоб не фабрикувати фіктивні фікстури й не ховати пропущену фільтрацію.
- Якщо для зареєстрованого адаптера немає ні `.nonbeer.html`+`.json`, ні `none:true` —
  **червоний CI** (дзеркалить наявну вимогу на `<id>.html`).

> Позитивний бік: `.nonbeer.html` фіксує приклад не-пива з магазину разом із фільтром —
> регресія («хтось послабив фільтр») ловиться одразу.

### 3.2 Спільний хелпер `non-beer.ts` — рекомендовано, фінальний словник тут

Користь реальна: name-based адаптери (`beerrepublic`, `bierloods22`, `winetime`) ділять
**один консервативний словник багатослівних пакувальних фраз**, тож додавання нового маркера
(`+ келих`) вмикає його скрізь. `hoptimaal` лишається на URL-сигналі.

`extension/src/sites/non-beer.ts`:
- `isNonBeerName(name: string): boolean` — match лише **багатослівних** пакувальних фраз,
  ніколи голих неоднозначних слів (`glass`, `box` окремо НЕ матчаться → захист від FP типу
  `Beer in a Box`).
- Запропонований словник (union наявних beerrepublic + bierloods22 + сигнали з даних, **на ревʼю**):
  - EN: `brewery pack`, `vertical set`, `tasting set`, `tasting box`, `beer package`,
    `beerpackage`, `beer box`/`beerbox`, `advent calendar`, `surprise box`, `signature box`,
    `craftbeer box`, `gift set`, `gift box`, `subscription`, `abonnement`,
    `brewer's collective … pack`, `… pack … edition`;
  - UA/PL: `набір`, `+ келих`, `+ szklanka`, `+ glass`, `zestaw`, `pakiet`.
- Адаптери лишають за собою **остаточне рішення** (можуть додати шоп-специфічні маркери або
  переважити). Хелпер — це baseline, не обов'язковий гейт.
- Unit-тести хелпера: і пакувальні фрази (мають матчитись), і FP-кейси
  (`Beer in a Box`, `Glass`, бренд-як-назва — мають лишитись **не**-матчем).

> Якщо на етапі імплементації виявиться, що сигнали надто розходяться (URL vs name vs title)
> і хелпер не дає чистого виграшу — лишаємо детекцію в адаптерах, а спільним робимо тільки
> словник-константу. Рішення фіксується в плані.

### 3.3 Ретрофіт адаптерів

- `winetime`, `onemorebeer`, `beerfreak` — додати фільтр (name-хелпер і/або шоп-специфічний
  сигнал) + `.nonbeer.html`/`.json`.
- `beerrepublic`, `bierloods22` — мігрувати на спільний хелпер (якщо прийнято) + `.nonbeer`-фікстура.
- `hoptimaal` — лишити URL-фільтр + `.nonbeer.html` з merch/bundle-карткою.

## 4. spec.md / рунбуки

- **`spec.md` §6** — додати інваріант контракту: *адаптер ПОВИНЕН виключати не-пива
  (паки/сети/мерч); це форситься конформанс-тестом (`.nonbeer.html`+`.json` або `none:true`)*.
  Розширити опис конформанс-тесту (зараз рядки ~839–847) новим кейсом.
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
