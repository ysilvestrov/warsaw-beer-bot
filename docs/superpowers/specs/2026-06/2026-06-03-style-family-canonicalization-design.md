# Style family canonicalization — design

> **Дата:** 2026-06-03
> **Статус:** approved (brainstorming) → готується план
> **Спека-істина:** оновлює `spec.md` §4 (`/filters`)
> **Суперсідить:** `familyOf` (prefix-before-`" - "`) з
> `2026-06-03-filters-surface-design.md` — те припущення хибне для реальних даних.

## 1. Проблема

`/filters` групує стилі через `familyOf(style)` = частина рядка до `" - "`.
Це припускало Untappd-формат `"Family - Subtype"`. Але `taps.style` приходить
**з ontap.pl** — це вільний, багатомовний (EN/PL/CZ/DE), непослідовно
капіталізований текст **без** роздільника `" - "`. Наслідок: `familyOf`
повертає цілий рядок, тож кожен стиль — окрема «родина».

**Виміряно в проді (2026-06-03):** 306 різних значень `style` на 575 поточних
кранах. Кластери, які мали б злитися:

- **IPA**: `American IPA`, `West Coast IPA`, `Hazy IPA`, `Wheat IPA`, `AIPA`,
  `NEIPA`, `New England IPA`, `Cold IPA`, `Session IPA`, `WEST COAST IPA`…
- **Wheat**: `Weizen`, `Pszeniczne`, `Hefeweizen`, `HEFEWEIZEN`, `Witbier`,
  `Belgian Witbier`, `German Hefeweizen`, `Pszenica z malinami`…
- **Lager**: `Lager`, `Pils`, `Czeski Lager`, `Svetlý Ležák`, `Svetly Lezak`,
  `Vienna Lager`, `Pale Lager`, `Desitka`…
- **Lambic**: `Lambic wiśniowy` → має бути просто `Lambic`.
- Шум: `PROSECCO`.

**Мета:** канонізувати вільний стиль у невелику множину родин для кнопок
`/filters` і для матчингу.

## 2. Узгоджені рішення

1. **Двигун:** упорядкована таблиця правил `{ family, keywords[] }`;
   `canonicalStyleFamily(style)` нормалізує рядок, токенізує і повертає **першу**
   родину, чий keyword-токен присутній. Порядок = пріоритет.
2. **Пріоритет компаундів:** «гучніші» родини (IPA, Sour, Stout, Porter)
   перемагають субстрат (Wheat, Lager). Зокрема `Wheat IPA` → **IPA**.
3. **Fallback:** жодне правило не зматчило → одна родина **`Other`** (включно з
   `null`/порожнім стилем). `Other` — повноцінна обирана родина.
4. **Gose → Sour:** в Untappd Gose належить до Sour, у PL Gose/Pastry Sour часто
   те саме — зливаємо (`gose` як keyword під Sour).
5. **Мова міток:** інтернаціональні назви стилів (loanwords) показуємо як є в усіх
   локалях; родина = і ідентифікатор, і мітка. Єдиний виняток — **`Other`**:
   стабільний sentinel у сторі, локалізована мітка.
6. **Модель фільтра:** лишається **include** (обираєш родини, які хочеш).
   «Прибрати лагер» = обрати все, крім Lager.

## 3. Канонічна множина родин і порядок

`canonicalStyleFamily` перебирає правила згори вниз, перша співпала родина
повертається. Keywords — нормалізовані токени (після `baseNormalize`:
lowercase + знятa діакритика + пунктуація → пробіли).

| # | Family | Keyword-токени (нормалізовані, мультимовні) |
|---|--------|----------------------------------------------|
| 1 | IPA | `ipa, aipa, neipa, dipa, tipa, wcipa, neneipa` |
| 2 | Stout | `stout` |
| 3 | Porter | `porter` |
| 4 | Sour | `sour, gose, kwasne, kwasny, pastry` |
| 5 | Lambic | `lambic, gueuze` |
| 6 | Saison | `saison` |
| 7 | Pale Ale | `apa, pale` |
| 8 | Wheat | `weizen, hefeweizen, witbier, wit, pszeniczne, pszenica, pszeniczny, wheat` |
| 9 | Lager | `lager, pils, pilsner, lezak, helles, dunkel, vienna, marzen, desitka` |
| 10 | Bock | `bock` |
| 11 | Barleywine | `barleywine, barley` |
| — | **Other** | fallback (жодного збігу / null / порожньо) |

**Зауваги до правил:**
- Токен-матч (не substring) уникає хибних збігів (`apa` всередині `trapa`),
  але ловить однотокенні компаунди (`neipa`, `aipa`) — вони в keyword-списку.
- `Pale Ale`: `pale` ловить `Pale Lager`?— ні, бо `Lager` нижче, а `Pale Lager`
  має токен `pale` → впаде в Pale Ale **раніше** Lager. ⚠️ Це конфлікт: `Pale Lager`
  має бути Lager. Рішення: правило Pale Ale матчить `apa` АБО (`pale` І токен
  `ale`); `Pale Lager` не має `ale` → проходить далі до Lager. `American Pale Ale`
  має `pale`+`ale` → Pale Ale. ✅
- `Wheat`: `wit` як окремий токен ловить `Witbier`? `witbier` — один токен, не
  `wit`. Тому keyword має бути `witbier` (і `wit` для рідкісного `Wit`/`Wit Beer`,
  де `wit` окремий токен). Обидва в списку.
- `Pils` → Lager (узгоджено: 4 види лагерів зливаються в Lager; окремої родини
  Pilsner немає).
- **`pastry` і порядок:** Sour несе keyword `pastry`, тож `Pastry <X>` хибно
  впав би в Sour для будь-якого `X`, що стоїть **нижче** Sour. Тому **Stout і
  Porter стоять вище Sour** (#2, #3): `Pastry Stout` → Stout, `Pastry Porter` →
  Porter, а `Pastry Sour` → Sour (токен `sour`). Бакет `pastry` лишаємо в Sour
  для голого `Pastry`-стилю без базового слова.

> Множина родин і keyword-списки — **жива конфігурація**; нові варіанти
> додаються в таблицю правил у наступних PR. Top-10-present приховує довгий
> хвіст, тож неповнота не критична.

## 4. Архітектура та компоненти

- **`src/domain/normalize.ts`**: експортувати наявну приватну `baseNormalize`
  (lowercase + `stripDiacritics` + пунктуація→пробіл). Без дублювання
  нормалізації.
- **`src/domain/style-family.ts`** (новий, одна відповідальність):
  ```
  export const OTHER_FAMILY = 'Other';
  export const FAMILY_RULES: ReadonlyArray<{ family: string; keywords: string[] }>;
  export function canonicalStyleFamily(style: string | null): string;
    // null/'' → OTHER_FAMILY
    // baseNormalize → split(' ') → tokens
    // для кожного правила по порядку: якщо перетин tokens∩keywords непорожній
    //   (з урахуванням спец-логіки Pale Ale: 'apa' OR ('pale' AND 'ale')) → family
    // інакше → OTHER_FAMILY
  ```
- **Заміна `familyOf`:** `canonicalStyleFamily` замінює `familyOf` у двох місцях,
  `familyOf` видаляється:
  - `topStyleFamilies` (`domain/filters.ts`) — підрахунок родин поточних кранів.
  - `filterInteresting` (`domain/filters.ts`) — матч стилю.
- **`src/bot/keyboards.ts`** `filtersKeyboard`: мітка кнопки —
  `fam === OTHER_FAMILY ? t('filters.family_other') : fam`; callback завжди
  `style:${fam}` (для Other — `style:Other`). Імпорт `OTHER_FAMILY`.
- **`src/bot/commands/filters.ts`** `render`: у рядку-зведенні активні стилі
  мапляться через ту саму локалізацію Other перед `join(', ')`.
- **i18n:** новий ключ `filters.family_other` у `types.ts` + `uk/pl/en`
  (`Інше` / `Inne` / `Other`).

### Зміни сигнатур

- `filterInteresting` style-гілка:
  ```
  if (opts.styles && opts.styles.length) {
    const fam = canonicalStyleFamily(t.style);            // ніколи не null
    if (!opts.styles.some((x) => x.toLowerCase() === fam.toLowerCase())) return false;
  }
  ```
  (case-insensitive порівняння лишаємо — толерантно; канонічні родини
  фіксованого регістру, але тест звіряє нечутливість.)
- `topStyleFamilies`: `familyOf(s)` → `canonicalStyleFamily(s)`; тепер ніколи не
  повертає null (замість — `Other`), тож `Other` рахується і може потрапити в
  top-10. `currentTapStyles` і далі відсікає `NULL` на рівні SQL, тож `Other`
  від null-стилів у лічильник top-10 не потрапляє; у `filterInteresting`
  null-стиль → `Other` (фільтрується лише якщо обрано `Other`).

## 5. Потік даних (без змін у формі)

```
/filters → getFilters → currentTapStyles(db)
        → topStyleFamilies(styles, active, 10)   // canonicalStyleFamily всередині
        → render(summary + keyboard)             // Other → локалізована мітка
toggle/abv/rating/reset → mutate → setFilters → re-render (canonical families)
```

## 6. Граничні випадки

- **Stale-вибір з prefix-версії (сьогоднішня):** користувач, що тапнув кнопку за
  кілька годин роботи `familyOf`-білда, має у сторі напр. `"American IPA"`; воно
  більше не дорівнює канонічній `IPA` → пере-фільтрує. Пом'якшення: union-with-active
  рендерить його (✓), тож видно й можна зняти; **міграції немає** — `♻️` чистить.
  Радіус мінімальний (фіча — години).
- **Діакритика/регістр** (`Svetlý Ležák`↔`Svetly Lezak`, `WEST COAST IPA`)
  колапсують через `baseNormalize`.
- **`PROSECCO`, one-offs, null/''** → `Other`.
- **`Pale Lager`** → Lager (через `ale`-умову Pale Ale, див. §3).

## 7. Тестування

Новий `src/domain/style-family.test.ts` — `canonicalStyleFamily` на реальних
кластерах:
- IPA: `American IPA`, `West Coast IPA`, `Hazy IPA`, `AIPA`, `NEIPA`,
  `WEST COAST IPA` (регістр), `Wheat IPA` (пріоритет над Wheat).
- Wheat: `Weizen`, `Pszeniczne`, `Hefeweizen`, `Witbier`, `Belgian Witbier`.
- Lager: `Lager`, `Pils`, `Czeski Lager`, `Svetlý Ležák`, `Pale Lager`,
  `Vienna Lager`, `Desitka`.
- Lambic: `Lambic wiśniowy`.
- Sour: `Pastry Sour`, `Gose` (злито).
- Pale Ale: `American Pale Ale`, `New Zealand APA`.
- Porter: `India Export Porter`, `Pastry Porter`. Stout: `Milk Stout`,
  `Pastry Stout` (пріоритет над Sour).
- Other: `PROSECCO`, `''`, `null`.

Оновити/перевірити наявні:
- `topStyleFamilies` тести (вхід `'IPA - American'` тощо канонізується в
  `IPA`/`Sour`/`Lager`/`Stout` — очікування лишаються чинними).
- `filterInteresting` family-тест (`'IPA'`→IPA, `'Ale'`→[], `'stout'`
  case-insensitive→Stout, null→Other).
- `keyboards.test.ts`: додати рендер-кейс для `Other` → локалізована мітка.

Контрактних/HTTP-тестів не додаємо.

## 8. Поза скоупом (YAGNI)

- Локалізація назв родин (крім `Other`).
- Exclude-фільтр (лишаємо include).
- Міграція stale-виборів.
- Авто-вивід родин з зовнішньої таксономії / LLM (немає в стеку).
- Вичерпне покриття всіх 306 рядків — лише поширені родини + Other.

## 9. Вплив на `spec.md`

- **§4 `/filters`**: `familyOf` (prefix-before-dash) → `canonicalStyleFamily`
  (keyword-rule канонізація, `domain/style-family.ts`); згадати `Other`-бакет і
  що матчинг родин — канонічний, не за substring.
