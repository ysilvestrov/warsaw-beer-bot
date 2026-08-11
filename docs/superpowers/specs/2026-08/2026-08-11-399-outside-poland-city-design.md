# #399 — псевдо-місто «поза Польщею» для extension-only користувачів

**Дата:** 2026-08-11
**Issue:** [#399](https://github.com/ysilvestrov/warsaw-beer-bot/issues/399) (`enhancement`, `priority/tier-2`)

## Проблема

Хто реєструється в боті **лише заради розширення** (`/extension` → токен → браузер),
тому не потрібні ані місто, ані решта функціоналу бота. Зараз такий користувач мовчазно
отримує Варшаву: `user_profiles.city` nullable, `getUserCity` мапить `NULL → DEFAULT_CITY
('warszawa')`. Наслідок — `/pubs`, `/newbeers`, `/route`, `/beers` показують дані міста,
до якого людина не має стосунку, а `/help` рекламує команди, які їй не потрібні.

Прод на момент дизайну: 9 профілів, з них **8 із `city = NULL`**, 4 мають extension-токен.

## Рішення

Вводимо **псевдо-місто `outside-pl`** («поза Польщею»): явний останній пункт клавіатури
`/city`, значення за замовчуванням для всіх, хто міста не обрав. У цьому стані
місто-залежні команди відповідають підказкою й не виконуються, а `/help` їх не показує.

Extension-шлях (`/extension`, `/link`, `/import`, `/status`, `/lang`, `/help`, `/start`,
`/city`, `/filters` і весь HTTP API `/match`) від міста не залежить і не змінюється.

### Обсяг

| | |
|---|---|
| Блокуються | `/newbeers`, `/route`, `/pubs`, `/beers`, `/refresh` |
| Не змінюються | `/extension`, `/link`, `/import`, `/status`, `/lang`, `/help`, `/start`, `/city`, `/filters`, HTTP API |
| Нативне меню Telegram | **не чіпаємо** — лишається глобальним per-locale |
| Міграція БД | **не потрібна** (див. «Сховище») |

## Дизайн

### Домен (`src/domain/cities.ts`)

`CITIES` лишається як є. Це одночасно список для клавіатури **і** список, яким ходить
краулер `refreshOntap` — тому псевдо-місто в нього не потрапляє за побудовою, і джоба
фізично не може смикнути `ontap.pl/outside-pl`.

- `export const OUTSIDE_CITY = 'outside-pl'` — слаг не колізує з жодним ontap-слагом.
- `isKnownCity(slug)` зберігає нинішнє значення — «справжнє польське місто з ontap».
  Він же стає предикатом «місто-залежні команди дозволені».
- `isSelectableCity(slug) = isKnownCity(slug) || slug === OUTSIDE_CITY` — валідатор
  користувацького вибору.
- `DEFAULT_CITY = 'warszawa'` **видаляється**: його єдиний споживач — фолбек у
  `getUserCity`. SQL-дефолт колонки `pubs.city NOT NULL DEFAULT 'warszawa'` до цієї
  константи стосунку не має і лишається незмінним.

`cityLabel` лишається без i18n (домен не знає про перекладач).

### Сховище (`src/storage/user_profiles.ts`)

- `getUserCity`: фолбек `DEFAULT_CITY` → `OUTSIDE_CITY`. Тобто `NULL` і будь-який
  невідомий/зіпсований слаг тепер читаються як «поза Польщею».
- Міграції немає: колонка вже nullable, наявні 8 профілів із `NULL` автоматично
  опиняються в «поза Польщею» — саме та поведінка, яку хотіли. Профіль зі `szczecin`
  не зачіпається.
- Деградація невідомого слага в `outside-pl` безпечніша за нинішню (мовчки показати
  чужу Варшаву).

### i18n (`src/i18n/types.ts` + `locales/{uk,pl,en}.ts`)

| Ключ | uk | pl | en |
|---|---|---|---|
| `city.outside` | `🌍 Поза Польщею` | `🌍 Poza Polską` | `🌍 Outside Poland` |
| `city.blocked` | «Ця команда працює лише для міст Польщі. Обери місто: /city» | (аналог) | (аналог) |
| `help.city_hint` | «Ще кілька команд (паби, маршрут, топ пив) стануть доступними після вибору міста — /city» | (аналог) | (аналог) |

`city.outside` — **одна** мітка на всі три місця: кнопка клавіатури, `city.prompt`/
`city.changed`, рядок міста в `/status`.

`help.city_hint` свідомо **без `{count}`**: лічильник тягне множинні форми в укр./пол.
(1 / 2–4 / 5+), а користі з нього нуль.

### Мітка: `src/bot/city-label.ts` (новий)

```ts
cityDisplayLabel(t, slug) = slug === OUTSIDE_CITY ? t('city.outside') : cityLabel(slug)
```

Домен лишається i18n-вільним, перекладач живе на бот-шарі. Споживачі: `city.ts`,
`keyboards.ts`, `status-build.ts`.

### Каталог команд як єдине джерело істини (`src/bot/commands/catalog.ts`)

- `CommandEntry` отримує `cityScoped?: true` — на `newbeers`, `route`, `pubs`, `beers`,
  `refresh`.
- `buildHelpText(t, allowed: boolean)`: за `allowed = false` викидає ці 5 записів і
  дописує `help.city_hint`; за `true` — нинішня поведінка.
- `buildCommandMenu` **не змінюється** (нативне меню глобальне per-locale).

Той самий прапорець живить і гейт, і `/help` — розсинхрон двох списків неможливий.

Обидва виклики `buildHelpText` (`start.ts`, `help.ts`) рахують `allowed` однаково:
`isKnownCity(getUserCity(db, ctx.from.id))`.

### `/city` (`src/bot/commands/city.ts`)

`applyCitySelection` валідує через `isSelectableCity` замість `isKnownCity` (інакше
`outside-pl` не збережеться); `city.prompt` / `city.changed` беруть мітку з
`cityDisplayLabel`.

### Гейт (`src/bot/commands/city-gate.ts`, новий)

Composer, який реєструє `.command(CITY_SCOPED_COMMANDS, handler)`, де
`CITY_SCOPED_COMMANDS = COMMAND_CATALOG.filter(e => e.cityScoped).map(e => e.command)`.

```
handler: ensureProfile → isKnownCity(getUserCity(db, id))
           ? next()                      // пропустити далі по ланцюгу
           : ctx.reply(ctx.t('city.blocked'))   // і НЕ викликати next()
```

У `src/index.ts` гейт стає **першим** аргументом `bot.use(...)` — перед
`newbeersCommand` і перед `createRefreshCommand(...)`, який зараз стоїть останнім.

Callback-кнопок гейт не потребує: жодна з 5 команд їх не має (`.action(...)` є лише в
`filters`, `lang`, `city` — усі міста-незалежні). Регекс `city:([a-z-]+)` уже приймає
дефіс, тож `outside-pl` проходить без змін.

### Клавіатура (`src/bot/keyboards.ts`)

`cityKeyboard(t, current)` — сигнатура отримує перекладач; кнопка `city:outside-pl`
з міткою `cityDisplayLabel` додається **завжди останнім рядком**, та сама ✓-логіка
для активного пункту.

## Тести (Vitest)

| Файл | Що перевіряє |
|---|---|
| `domain/cities.test.ts` | `outside-pl` селектабельний, але **не** в `CITIES` — регресійний захист краулера; `isKnownCity('outside-pl') === false` |
| `storage/user_profiles.test.ts` | `NULL → outside-pl`; `szczecin → szczecin`; невідомий слаг → `outside-pl` |
| `bot/commands/city-gate.test.ts` | заблокована команда: `next` не викликано + надіслано `city.blocked`; дозволена: `next` викликано, нічого не надіслано |
| `bot/commands/catalog.test.ts` | `allowed = false` ховає рівно 5 команд і додає підказку; `allowed = true` дає нинішній текст |
| `bot/commands/city.test.ts` | кнопка «поза Польщею» остання; ✓ на ній при `current = outside-pl` (тести `cityKeyboard` уже живуть тут, не в `keyboards.test.ts`); `applyCitySelection(db, id, 'outside-pl') === true` і слаг збережено |
| `bot/commands/status-build.test.ts` | рядок міста показує локалізовану мітку |

## Оновлення `spec.md`

- Секція `/city` (~602–607): псевдо-місто, гейт, «нових/невизначених кидає в
  outside-pl, а не в Варшаву».
- Таблиця `user_profiles` (~323): `NULL → OUTSIDE_CITY`.
- Секція багатоміста (~1201–1208): краулер ходить **лише** по `CITIES`; згадка
  `DEFAULT_CITY` замінюється.
- Секція `/help` та `/status`: фільтрація команд і локалізована мітка міста.

`docs/extension-install-uk.md` **не оновлюємо**: гайд ніде не згадує вибір міста, а
`extension/**` ця зміна не зачіпає.

## Свідомо поза обсягом (YAGNI)

- Per-chat `setMyCommands` (нативне меню під конкретного користувача) — +виклик API на
  кожну зміну міста й окремий шлях коду заради дублювання того, що вже робить `/help`.
- Онбординг-промпт вибору міста в `/start` — issue цього не просить; `/help` уже містить
  підказку `help.city_hint`.
- Гейт на callback-кнопках — жодна з 5 команд їх не має.
