# Дизайн — ідентичність назв кранів зі слів стилю (закриває #663, пов'язані #465, #636)

**Issue:** [#663](https://github.com/ysilvestrov/warsaw-beer-bot/issues/663). **Статус:** дизайн підготовлено за результатами живих проб прод-БД (2026-09-18).  
**Пов'язані issues:** [#465](https://github.com/ysilvestrov/warsaw-beer-bot/issues/465) (порожній candidateName в `inputIdentityAliases`), [#636](https://github.com/ysilvestrov/warsaw-beer-bot/issues/636) (`digitIdentity`, вимога літер для `number-fallback`), [#505](https://github.com/ysilvestrov/warsaw-beer-bot/issues/505) (`nameIdentity` для відновлених назв).

Докази (скрипти проб і живий вивід прод-БД) — у `~/warsaw-beer-probes/636/style-only-names.ts` та протоколах діагностики сесії.

---

## 1. Проблема (доведена живими пробами)

### 1.1 Механізм

`normalizeName` відкидає стильові слова (`STYLE_WORDS`), спец-мітки (`SPEC_LABEL_WORDS`: `alc`, `abv`, `ibu`) та чисті числа (`isNumericNoise`). Коли назва крана складається виключно з них:
- `Pils 12°`, `Pils 12,0°`, `Pils 11°`
- `Weizen`, `WEIZEN 12°`, `Weizen 12,5°`
- `Stout`, `Dry Stout 16°`
- `LAGER 10.5°`, `Lager 12°`
- `IPA 13,5°`, `Session IPA 12°`, `AIPA 15,5°`
- `Saison 12,5°`, `Bock 16,5°`

нормалізована назва згортається в порожній рядок: `normalizeName(name) === ''`.

Порожній нормалізований ключ читається як **ідентичність** у п'яти підсистемах системи:

| Місце | Що робить з ключем | Поведінка при `nn === ''` сьогодні | Наслідок |
|---|---|---|---|
| `matchPrepared`, точна стадія (`src/domain/matcher.ts:356`) | `c.nameNorm === nn` | `c.nameNorm === ''` — будь-який рядок броварні з порожньою `nameNorm` («WEIZEN», «Pils», «21», «15», «LAGER») вважається точним збігом | `Stout` → `LAGER`, `Pils 12°` → `WEIZEN`, `LAGER 10.5°` → `21`, `Bock 16,5°` → `Weizen` (усі `confidence: 1.0`) |
| `matchPrepared`, fuzzy-стадія (`src/domain/matcher.ts:473`) | `searcher.search(\`${seedBrewery} ${nn}\`)` + `nameTokensDiverge(nn, cand.nameNorm)` | Шукає `${seedBrewery} ` (лише броварню). Дивергенція токенів `nameTokensDiverge('', cand)` завжди `false` (0 токенів входу) | Автоматично лінкує **перше-ліпше пиво цієї броварні** зі скором 1.00: `IPA 13,5°` → `Black IPA`, `Session IPA` → `Wild Imperial Stout`, `Lager` → `Magik`, `Pils` → `Tadek` |
| `ensureOrphan` (`src/storage/beers.ts:184`) | `SELECT ... WHERE normalized_name = ?` + `digitsCompatibleAsPeers` | Знаходить першу сироту з `normalized_name = ''`. Обидві без цифр → вважаються сумісними | `Magic Road / Stout` і `Magic Road / LAGER` **злипаються в один рядок-сироту** |
| `ensureBeerRow` (`src/api/routes/enrich.ts:158`) | `listBeersByNormalized(..., '')` + `pickRowByDigits` | Повертає перший-ліпший рядок броварні з `normalized_name = ''`, якщо цифри сумісні | Картка крамниці `Pils` отримує рядок `WEIZEN`, і bid крамниці йде в репарацію чужого рядка |
| `resolvableOrphan` (`src/storage/beers.ts:82`) | `SELECT ... WHERE normalized_name = ?` + `digitIdentity` | Резолвить сироту з порожньою назвою через bid іншого стилю тієї ж броварні | Чекін або імпорт `LAGER` резолвить і перейменовує сироту `Stout` |
| `inputIdentityAliases` (`src/domain/untappd-lookup.ts:469`, #465) | `baseNormalize(\`${alias} ${candidateName}\`)` | При порожньому `candidateName` колапсує в голий аліас броварні | Кандидат сторонньої броварні, чий `alias_alt` містить цей бренд, лінкується як identity hit без жодного збігу назви пива |

---

### 1.2 Доказ (2026-09-18, жива прод-БД `/var/lib/warsaw-beer-bot/bot.db`, readonly)

Серед **1 009** активних автолінків кранів (без пінів, без `merged_at`, в останньому снепшоті кранів):
- **24** мають назву крана, яка нормалізується в порожнечу (`normalizeName === ''`);
- **23** з них автоматично злінковані з `confidence ≥ 0.99`;
- **16 очевидно хибних лінків:**
  - `Trzech Kumpli Brewery / IPA (abv=6.4)` → `Magic Road / ICE BOCK (abv=16)` [6438657] (`conf=0.99`)
  - `Kraftwerk & Remeslo / Pils 12° (abv=4.8)` → `Browar Zakładowy / Pils (abv=5.2)` [3838301] (`conf=0.99`)
  - `Cieszyn / Pilsner (abv=4.8)` → `Arcyksiążęcy Browar Zamkowy Cieszyn / Session IPA (abv=3.8)` [6661496] (`conf=1.00`)
  - `Magic Road / Stout (abv=4.5)` → `Magic Road / LAGER (abv=4.3)` [6843489] (`conf=1.00`)
  - `Trzech Kumpli / Bock 16,5° (abv=6.7)` → `Trzech Kumpli / Weizen (abv=5)` [2567420] (`conf=1.00`)
  - `Gościszewo / Lager 12° (abv=5)` → `Browar Gościszewo / Magik (abv=3.2)` [6731824] (`conf=1.00`)
  - `De Facto / Pils (abv=5.6)` → `De Facto / Piernikowe (abv=5)` [3794270] (`conf=1.00`)
  - `Vilniaus / PILSNER (abv=4.7)` → `Vilniaus Alus / Retro (abv=1.2)` [776396] (`conf=1.00`)
  - `Maryensztadt / Dry Stout 16° (abv=4.5)` → `MARYENSZTADT / NEED (abv=7)` [6432228] (`conf=1.00`)
  - `Litovel / Weizen` → `Litovel / Jasny (abv=4.8)` [3504511] (`conf=1.00`)
  - `Brewery remeslo / Pils 12,0° (abv=4.7)` → `Kraftwerk & Remeslo / WEIZEN (abv=4.3)` [3760135] (`conf=1.00`)
  - `Brovarnia Gdańsk / IPA 13,5° (abv=5.5)` → `Brovarnia Gdańsk / Black IPA (abv=7)` [2782804] (`conf=1.00`)
  - `Funky Fluid / LAGER 10.5° (abv=4.5)` → `Funky Fluid / 21 (abv=9)` [4088549] (`conf=1.00`)
  - `Browar Nieczajna / Session IPA 12° (abv=5)` → `Browar Nieczajna / WIld Imperial Stout (abv=11.7)` [6761278] (`conf=1.00`)
  - `Piwoteka / Pils 12° (abv=5.6)` → `Piwoteka / Tadek (abv=6.5)` [1443230] (`conf=1.00`)
  - `Otwocki / AIPA 15,5° (abv=6.3)` → `Otwocki / German Pilsner (abv=5.6)` (`conf=1.00`)

- **Дійсно правильні збіги (де пиво Untappd дійсно має лише стильову назву):**
  - `Browar Zakładowy / Pils 12° (abv=5.2)` → `Browar Zakładowy / Pils (abv=5.2)`
  - `Trzech Kumpli / Weizen 12,5° (abv=5)` → `Trzech Kumpli / Weizen (abv=5)`
  - `Zwierzyniec / Pils 13° (abv=6)` → `Browar Zwierzyniec / Pils (abv=6)`
  - `Kraftwerk & Remeslo / WEIZEN 12° (abv=4.5)` → `Kraftwerk & Remeslo / WEIZEN (abv=4.3)`
  - `Palatum/Niezły PoLew / Saison 12,5° (abv=5.7)` → `Palatum / Saison (MBC) (abv=5.8)`

В каталозі `beers` наразі **251** пиво має `normalized_name = ''` (`Varvar Imperial Stout`, `Lagunitas IPA`, `Founders Porter`, `Primátor Stout`, `Funky Fluid 21`, `Kamenice 10` тощо).

### 1.3 Ціна для користувача

Користувач бачить на крані чуже пиво з чужим рейтингом і помилковим бейджем «пив/не пив» (наприклад, замовляє `Stout`, а бот показує оцінку лагера; або `Funky Fluid LAGER 10.5°` показує рейтинг і чекіни міцного імперського стаута `21`).

---

## 2. Рішення

### 2.1 Принцип ідентичності для назв зі стилю (`styleNameIdentity`)

`normalizeName` **не змінюється** — він годує пошукові запити Untappd/Algolia, де стильові слова зобов'язані відкидатися, щоб пошуковий ladder не повертав 0 результатів.

Але для визначення тотожності назви, коли `normalizeName(name) === ''`, вводиться чиста функція відновлення стильової ідентичності:

```typescript
export function styleNameIdentity(rawName: string, breweryNorm: string): string {
  const clean = baseNormalize(stripSearchNoise(rawName));
  return stripBreweryFromName(clean, breweryNorm).trim();
}
```

Властивості `styleNameIdentity`:
1. `stripSearchNoise` знімає структурний шум: чеські/польські градуси (`12°`, `12,0°`), відсотки ABV (`10.5%`), списки хмелів і тару.
2. `baseNormalize` зводить до нижнього регістру, знімає діакритику і пунктуацію.
3. `stripBreweryFromName` видаляє префікс/ехо броварні (якщо воно вписане в назву).
4. **Результат:**
   - `Pils 12°` → `"pils"`
   - `Pils` → `"pils"`
   - `WEIZEN 12°` → `"weizen"`
   - `WEIZEN` → `"weizen"`
   - `LAGER 10.5°` → `"lager"`
   - `21` → `"21"`
   - `Stout` → `"stout"`
   - `Black IPA` → `"black ipa"`
   - `Session IPA 12°` → `"session ipa"`
   - `Wild Imperial Stout` → `"wild imperial stout"`

---

### 2.2 Правила для підсистем

#### 1. `matchPrepared` (`src/domain/matcher.ts`)
- **Точна стадія:**
  `c.nameNorm === nn` перевіряється **лише коли `nn !== ''`**:
  ```typescript
  const exactNormalized = nn !== '' && c.nameNorm === nn;
  ```
  Коли `nn === ''`, кандидат може стати `exact` **виключно за тотожністю стильової ідентичності та перевіркою ABV**:
  ```typescript
  const styleMatch =
    nn === '' &&
    styleNameIdentity(c.name, c.breweryNorm) === inputStyleIdentity &&
    (wantAbv == null || c.abv == null || Math.abs(c.abv - wantAbv) <= ABV_TOLERANCE);
  ```
- **Заборона fuzzy-стадії при порожній назві:**
  Якщо `nn === ''`, fuzzy-пошук на рівні броварні **ніколи не виконується** (за аналогією з `isBareBrandName`):
  ```typescript
  if (isBareBrandName(input.name, input.brewery) || nn === '') return null;
  ```
  Якщо точний збіг стилю не знайдено — чесний `orphan`.

#### 2. `ensureOrphan` (`src/storage/beers.ts`)
Коли `b.normalized_name === ''`, пошук існуючої сироти серед рядків броварні вимагає збігу `styleNameIdentity`:
```typescript
const existing = orphans.find((o) =>
  digitsCompatibleAsPeers(o.name, b.name) &&
  (b.normalized_name !== '' || styleNameIdentity(o.name, b.normalized_brewery) === inputStyle)
);
```
`Magic Road / Stout` і `Magic Road / LAGER` залишаються двома різними сиротами.

#### 3. `ensureBeerRow` (`src/api/routes/enrich.ts`)
При виборі рядка для картки крамниці з `normalized_name === ''`, список кандидатів фільтрується за тотожністю `styleNameIdentity(row.name, row.normalized_brewery) === styleNameIdentity(cardName, normalized_brewery)`. Картка `Pils` ніколи не обере рядок `WEIZEN`.

#### 4. `resolvableOrphan` (`src/storage/beers.ts`)
При резолвленні сироти за Untappd bid, якщо `b.normalized_name === ''`, кандидат-сирота зобов'язаний мати такий самий `styleNameIdentity`.

#### 5. `inputIdentityAliases` (`src/domain/untappd-lookup.ts`, #465)
При формуванні `inputIdentityAliases`:
```typescript
if (!candidateName.trim()) return [];
```
Порожні залишки назви відкидаються, не допускаючи потрапляння чистого бренду броварні до `inputIdentityAliases`.

#### 6. `number-fallback` у `digitIdentity` (#636)
Для переходу в `number-fallback` (коли в кандидата є число, якого немає у входу), назва кандидата **повинна містити хоча б одну літеру** поза межами цифрових токенів. Це блокує лінкування `LAGER 10.5°` на чисто числові рядки типу `21` або `15`.

---

## 3. Таблиця фактів і доказів

| Що записується як факт | Де записується | Що стверджує | Чим доведено (live probe / replay) |
|---|---|---|---|
| `match_links` (автолінк крана) | `refresh-ontap.ts:125` via `matchPrepared` | Кран є пивом `beers(id)` | Проба 24 кранів прод-БД: 16 хибних лінків (`conf=1.00`). За новим правилом: усі 16 відхиляються (стають orphan), 6 легітимних (`Pils`→`Pils`, `Weizen`→`Weizen`, `Saison`→`Saison`) зберігаються. |
| `beers` (сирота крана) | `ensureOrphan` (`beers.ts:180`) | Існує сирота для цієї назви | Проба: `Stout` і `LAGER` однієї броварні злипалися в один рядок. З новим правилом створюються окремі сироти. |
| `beers` (рядок картки крамниці) | `ensureBeerRow` (`enrich.ts:151`) | Картка відповідає рядку пари | Аналіз: `pickRowByDigits` брав перший рядок пари з `normalized_name = ''`. З фільтром `styleNameIdentity` бере лише однаковий стиль. |
| `beers.untappd_id` (резолвлення сироти) | `resolvableOrphan` (`beers.ts:78`) | Сирота відповідає цьому bid | Перевірено: без перевірки стилю сирота `Stout` резолвилась би чекіном `LAGER`. Нове правило вимагає збігу стилю. |
| `inputIdentityAliases` | `untappd-lookup.ts:469` | Кандидат є аліасом пива | Перевірено тест-кейсом #465: порожній `candidateName` давав чистий бренд броварні в множину аліасів пива. |
| `number-fallback` | `digitIdentity.ts` | Число кандидата — номер партії/серії | Перевірено: `LAGER 10.5°` проти `21`. Кандидат без літер не може бути варіантом назви без чисел. |

---

## 4. Спростовані варіанти

1. **Додати стильові слова назад у `normalizeName`:**
   *Спростовано:* зламає побудову запитів Algolia term-AND (#236, #295, #321). Untappd не знаходить `Pinta This Is Light Leichtbier`, якщо в запиті є `Leichtbier`.
2. **Використати `nameIdentity` напряму в `matchPrepared` без порівняння стилю:**
   *Спростовано пробним скриптом:* `identityAllowsApprox` повертає `true` для `Stout 4.5%` проти `LAGER 4.3%`, оскільки обидва мають відновлену ідентичність і однаковий ABV (різниця 0.2% <= 0.3%). Це створило б помилковий лінк між стаутом і лагером.
3. **Заборонити всі лінки при `nn === ''` (навіть `Pils`→`Pils`):**
   *Спростовано:* Zakładowy `Pils`, Trzech Kumpli `Weizen`, Zwierzyniec `Pils` є справжніми флагманами з офіційною назвою зі стилю. Відмова від них відправила б правильні крани в сироти.
