# Plan: ontap → user-checkins matching

Closes ysilvestrov/warsaw-beer-bot#18 — `/newbeers` показує пива, які
користувач уже пив.

## Root cause

`src/sources/ontap/pub.ts` склеює `h4Text + " — " + subtitle` у `beer_ref`,
тож матчер бачить рядки на кшталт
`"Buzdygan Rozkoszy 24°·8,5% — Caribbean Imperial Stout"` замість
канонічної назви. Нормалізатор не викидає числа, exact-match фейлиться,
fuzzy@0.85 не дотягується, і refresh створює новий beers-рядок без зв'язку
з імпортованими чекінами користувача → drunk-set не спрацьовує.

Додатково: untappd має кілька версій (vintages) одного пива по роках. Зараз
ми трактуємо їх як різні рядки, тож обхід ontap пропускає поточну "2026"
версію, бо вона ще не імпортована.

## Decisions (confirmed by user)

- ABV — окремий "чіп" у виводі `/newbeers`.
- Vintage-aware matching: якщо у каталозі кілька кандидатів з тим же
  нормалізованим ключем (різні роки) — бертимо найсвіжіший за `id` DESC,
  з ABV-перевіркою.
- Без міграції БД — старі дублі лишаються, наступний `refresh` правильно
  перепише `match_links` поверх.

## Module changes

### `src/domain/normalize.ts`
- `normalizeName` і `normalizeBrewery` додатково викидають чисто-цифрові токени
  (`/^\d+$/`). Покриває `"24°·8,5%"` → після `baseNormalize` стає `"24 8 5"` →
  всі три токени стрипляться. Також ловить роки `2024`/`2025`/`2026`.
- Trade-off: легітимні цифрові імена пива ("Pinta 555") теж стрипнуться.
  Acceptable.

### `src/sources/ontap/pub.ts`
- Новий `extractBeerName(h4Text, brewery_ref)`:
  - Обрізає все, починаючи з першого ABV-патерну (`\d+(?:[.,]\d+)?\s*[°%]`).
  - Якщо те, що лишилось, починається з `brewery_ref` (case-insensitive) —
    стрипає brewery-префікс.
- `beer_ref = extractBeerName(h4Text, brewery_ref)`.
- `style = subtitle || null` (зараз — завжди null, бо subtitle йшов у beer_ref).

### `src/domain/matcher.ts`
- `CatalogBeer` отримує `abv: number | null`.
- Сигнатура `matchBeer(input: { brewery, name, abv? }, catalog)`.
- Логіка:
  1. Знайти всі exact-кандидати по `(normalized_brewery, normalized_name)`,
     відсортувати `id DESC`.
  2. Якщо є кандидати:
     - Якщо `input.abv != null` — взяти першого з `|c.abv − input.abv| ≤ 0.3`.
     - Інакше або якщо ABV-збігу нема — повернути найсвіжіший.
  3. Якщо exact нема — fuzzy fallback (поріг знижено `0.85 → 0.75`).

### `src/jobs/refresh-ontap.ts`
- `listBeerCatalog` додатково селектить `abv`.
- `matchBeer` викликається з `abv: t.abv`.

### `src/bot/commands/newbeers-format.ts`
- `CandidateTap.display` (нове поле) — людино-читабельна форма
  `"Browar X BeerName"`. `beer_ref` як окрема концепція тут не потрібна.
- `CandidateTap.abv: number | null`.
- `BeerGroup.abv: number | null` — береться з рейтинг-репрезентанта.
- `formatGroupedBeers` рендерить `<b>{display}</b>  ⭐ {rating}  ·  {abv}%`
  (відсоток з комою як десятковим, або `5%` якщо ціле). Якщо `abv == null`
  — пропускається.

### `src/bot/commands/newbeers.ts`
- `display = brewery_ref ? "{brewery_ref} {beer_ref}" : beer_ref`.
- Передає `abv: t.abv` у `CandidateTap`.

## Sequence (TDD)

1. Тести нормалізатора на цифрові токени і роки → impl.
2. Тести матчера на vintage-логіку (multi-кандидат, ABV-disambiguation,
   fuzzy@0.75) → impl + оновлення `CatalogBeer` сигнатури.
3. Тест `extractBeerName` (string-level) → impl.
4. Оновити `pub.test.ts` на новій фікстурі: `beer_ref` не містить
   `°`/`%`, `style` non-null для taps з subtitle.
5. Оновити `refresh-ontap.ts` (catalog SELECT, matcher call).
6. Оновити `newbeers.ts` + `newbeers-format.ts` + тести: ABV у виводі.
7. `npm run typecheck && npm test && npm run build && smoke` → green.
8. Оновити spec §4.3, §6 і `docs/USER-GUIDE.md` (новий приклад виводу,
   пояснення vintage-handling).
9. Commit, PR `Closes #18`.

## Risk

- Парсер не вміє відділити brewery, якщо HTML не має окремого `.brewery`
  елемента з тим же значенням, що в h4. Перевіримо на live `beer-bones.html`.
  Якщо вилізе багато випадків — покладаюсь на TDD і додам інший shortcut.
