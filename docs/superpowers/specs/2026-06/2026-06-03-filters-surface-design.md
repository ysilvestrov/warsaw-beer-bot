# Filters surface: ABV buckets + dynamic style families — design

> **Дата:** 2026-06-03
> **Статус:** approved (brainstorming) → готується план
> **Спека-істина:** оновлює `spec.md` §3.9, §4 (`/filters`), §5.7
> **Походження:** ідея #4 з аналізу `spec.md` — «добити поверхню фільтрів».

## 1. Проблема

`/filters` показує лише 4 захардкоджені стилі (`IPA/Pils/Stout/Sour`) і два
пресети рейтингу (`min 3.5 / min 3.8`). При цьому:

- **ABV вже повністю підтримано в бекенді** — `filterInteresting`
  (`src/domain/filters.ts`) чесно застосовує `abv_min`/`abv_max`, а
  `user_filters` їх зберігає (`spec.md` §3.9). Але **в кнопках їх немає** —
  поле мертве з боку UX.
- 4 стилі — це крихітна підмножина того, що реально ллється у Варшаві.
- Повідомлення `filters.current` — девелоперське (`styles=IPA, min_rating=3.5`),
  стан фільтрів нелегкий до читання.
- Матчинг стилю — нестрогий `style.includes(x)`, через що, напр., `"Ale"`
  ловив би `"Pale Ale"`, `"Amber Ale"` тощо.

**Мета:** зробити поверхню фільтрів повною й релевантною, не чіпаючи доменну
модель фільтрації глибше за необхідне.

## 2. Рішення (узгоджені відповіді)

1. **Стилі — динамічні родини, без захардкодженого списку.**
   Родина = частина Untappd-стилю **до `" - "`** (`familyOf`). Показуємо
   **топ-10 родин, що є на кранах прямо зараз**, ранжовані за кількістю кранів
   (tie-break — алфавіт), **об'єднані з активними** родинами користувача
   (multi-select toggle). Активні позначаються ✓.
2. **ABV — пресетні діапазони, single-select.** Чотири бакети, кожен виставляє
   пару `abv_min`/`abv_max`; повторний тап по активному — очищає.
3. **Стейтфул-клавіатура.** Кожен тап перемальовує і клавіатуру, і
   повідомлення-зведення (замість лише toast'а), щоб увесь стан був видимий.
4. **Матчинг стилю — family-equality** замість substring.

## 3. Архітектура та компоненти

Слідуємо наявному поділу: чиста логіка в `domain/`, тонкі handler'и в `bot/`,
запити в `storage/`. Усі чисті частини — під unit-тестами (вимога CLAUDE.md).

### 3.1 `domain/filters.ts` (чисті функції)

```
familyOf(style: string | null): string | null
  // 'IPA - American'  -> 'IPA'
  // 'Sour - Fruited'   -> 'Sour'
  // 'Mead'             -> 'Mead'   (нема ' - ' → ціла строка)
  // null / ''          -> null
  // обрізає пробіли; split по першому ' - '

topStyleFamilies(
  currentTapStyles: (string | null)[],
  activeStyles: string[],
  n = 10,
): string[]
  // 1) familyOf кожного стилю поточних кранів, відкинути null
  // 2) згрупувати, порахувати; сортувати count desc, потім назва asc
  // 3) взяти топ-n
  // 4) додати активні родини, яких нема в топ-n (порядок: алфавіт), у кінець
  // → впорядкований список для рендера

ABV_BUCKETS: ReadonlyArray<{ key: string; label: string; min: number | null; max: number | null }>
  // [{key:'0-5',  label:'≤5%',  min:null, max:5},
  //  {key:'5-7',  label:'5–7%', min:5,    max:7},
  //  {key:'7-9',  label:'7–9%', min:7,    max:9},
  //  {key:'9plus',label:'9%+',  min:9,    max:null}]

bucketForRange(abv_min: number | null, abv_max: number | null): string | null
  // повертає key бакета, що точно відповідає парі (min,max); інакше null
```

**Зміна в `filterInteresting`:** перевірка стилю переходить з
`s.includes(x.toLowerCase())` на **family-equality**:

```
if (opts.styles?.length) {
  const fam = familyOf(t.style);
  if (fam == null || !opts.styles.some((x) => x.toLowerCase() === fam.toLowerCase())) return false;
}
```

(case-insensitive порівняння; решта сигнатури `FilterOpts` без змін —
`abv_min`/`abv_max` уже там.)

### 3.2 `storage/snapshots.ts`

Додати (або перевикористати, якщо вже є еквівалент) хелпер:

```
currentTapStyles(db: DB): string[]
  // стилі кранів з ОСТАННЬОГО snapshot кожного паба — та сама база
  // «поточних кранів», що й /newbeers (latest snapshot per pub)
```

> На етапі плану перевірити, чи наявний `tapsForSnapshotWithBeer`/інша функція
> вже дає це; якщо так — перевикористати, новий хелпер не плодити.

### 3.3 `bot/keyboards.ts`

`filtersKeyboard` стає чистою від даних:

```
filtersKeyboard(t, state: {
  families: string[];        // вже впорядкований топ-10 ∪ активні
  activeStyles: string[];
  abvKey: string | null;     // активний бакет
  minRating: number | null;
}): InlineKeyboardMarkup
```

Рендер:
- родини по 2 в ряд; активні з префіксом `✅ `; callback `style:<family>`
  (родина може містити пробіл — у `callback_data` це валідно, ліміт 64 байти);
- один ряд ABV-бакетів (4 кнопки); активний з `✅`; callback `abv:<key>`;
- ряд рейтингу (`min 3.5`, `min 3.8`); активний з `✅`; callback `rating:<v>`;
- ряд `♻️ <reset>`; callback `reset`.

### 3.4 `bot/commands/filters.ts`

- `/filters`: `ensureProfile` → `getFilters` → `currentTapStyles` →
  `topStyleFamilies` → рендер повідомлення-зведення + `filtersKeyboard`.
- `action('style:(.+)')`: toggle родини в `styles`, persist, **перемалювати**.
- `action('abv:(.+)')`: якщо тапнутий бакет уже активний — очистити
  (`abv_min=abv_max=null`); інакше виставити `min/max` із `ABV_BUCKETS`. persist,
  перемалювати.
- `action('rating:(.+)')`: якщо те саме значення вже активне — очистити
  (`min_rating=null`); інакше виставити. persist, перемалювати.
- `action('reset')`: очистити всі фільтри, перемалювати.
- Перемалювання: `editMessageText(summary, filtersKeyboard(...))` +
  `answerCbQuery()` (без тексту або з коротким підтвердженням). Перерахунок
  `currentTapStyles`/`topStyleFamilies` на кожен тап (дешево; лише /filters-сесія).

### 3.5 i18n (`src/i18n/locales/{uk,pl,en}.ts`)

- Переписати `filters.current` на багаторядкове зведення:
  ```
  🎛 Твої фільтри
  Стилі: {styles}
  Міцність: {abv}
  Рейтинг: {rating}

  Тисни, щоб увімкнути/вимкнути. ♻️ — скинути все.
  ```
  де порожні значення → локалізоване «—»/«будь-яка».
- Назви родин і мітки бакетів (`≤5%`…) **не локалізуються** (Untappd-англ /
  числові, locale-neutral).
- `filters.reset_button` → `♻️ Скинути все` (та аналоги pl/en).
- `filters.styles_changed`/`rating_changed` toast'и більше не потрібні (стан
  тепер видно у перемальованому UI): кожен action завершується **голим
  `answerCbQuery()`** без тексту. Ці два ключі видаляються з локалей.

## 4. Потік даних

```
/filters → getFilters(db, uid)
        → currentTapStyles(db)                     // latest snapshot per pub
        → topStyleFamilies(styles, active, 10)     // pure
        → render(summary + keyboard)

tap style:/abv:/rating:/reset
        → mutate filters → setFilters(db, uid, f)  // persist
        → recompute families + state
        → editMessageText(summary, keyboard)       // live re-render
```

## 5. Граничні випадки

- **Порожній snapshot / нема кранів:** `topStyleFamilies` повертає лише активні
  родини (або порожньо). Клавіатура все одно показує ABV + рейтинг + reset.
- **Активна родина випала з топ-10:** лишається у списку (union), з ✓, тож її
  завжди видно і можна вимкнути.
- **Legacy-фільтри** (`"Pils"` у старих користувачів): під family-equality
  `IPA/Stout/Sour` далі матчаться, `"Pils"` — ні (реальна родина `"Pilsner"`).
  Малий радіус (кілька користувачів), фікс — один тап `♻️`. **Міграцію не
  робимо**, лише фіксуємо в нотатках.
- **Стиль без `" - "`** (`"Mead"`, `"Cider"`): родина = ціла строка.
- **`familyOf(null)` / порожній стиль:** `null`; такий кран не матчить жодну
  обрану родину (поведінка як сьогодні для беззмістовного стилю).

## 6. Тестування

Unit (Jest), нові/оновлені:
- `familyOf`: dash / no-dash / null / зайві пробіли / кілька `" - "`.
- `topStyleFamilies`: підрахунок, cap топ-n, tie-break алфавітом, union з
  активними (включно з активним, що не в топ-n), порожній вхід.
- `bucketForRange`: кожен бакет, неспівпадіння → null.
- `filterInteresting`: новий family-equality (позитив/негатив, case-insensitive,
  стиль без dash, null-стиль) — без регресу по rating/abv/tried.
- `filtersKeyboard` (render-тест): набір кнопок, позиції ✓ для активних
  style/abv/rating, порядок родин.

Контрактних/HTTP-тестів не додаємо — джерела не чіпаємо.

## 7. Поза скоупом (YAGNI)

- Мультидіапазон ABV (single-select достатньо).
- Локалізація назв стилів.
- Міграція legacy `"Pils"`.
- Кастомні (довільні) min/max ABV або min_rating поза пресетами.
- Зміна доменної моделі фільтрації поза перемиканням style-match на family.

## 8. Вплив на `spec.md`

- **§4 `/filters`**: оновити опис — динамічні топ-10 родин (∪ активні),
  ABV-бакети single-select, стейтфул-перемалювання, family-equality матчинг.
- **§3.9**: відмітити, що `abv_min`/`abv_max` тепер керовані з кнопок.
- **§5.7 / §4 примітка**: прибрати згадку, що ABV «в схемі, але не в кнопках».
