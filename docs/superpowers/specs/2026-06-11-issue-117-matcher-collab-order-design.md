# Issue #117 — Wrong/missing matches for collab, bilingual & reordered beer names

> **Стандарт:** OpenSpec (spec-driven). **Статус:** `DESIGN`.
> **Дата:** 2026-06-11. **Issue:** #117 «Wrong match beer in Beerloods22 and OneMoreBeer».
> **Звіряти з:** `spec.md` §4 (`/match`, `/enrich/*`), §5.2 (інваріанти матчингу),
> §6 (browser extension адаптери), Appendix (matcher gotchas).

## 1. Problem

Сім реальних пив із магазинів (Bierloods22 / OneMoreBeer) лишаються **orphan'ами**
(`untappd_id IS NULL`), хоча відповідне пиво **існує** в Untappd. Назва issue —
«wrong match», але прод-БД (`untappd_lookup_count = 1`, `untappd_id NULL`) і завантажені
сторінки пошуку Untappd доводять, що це **false negatives**: пиво або не знайшлося в
пошуку, або знайшлося, але було **відхилене на стадії матчингу**.

Діагностика по семи прикладах (ground truth — реальні HTML пошуку Untappd, збережені у
`tmp/Untappd Beer Search _ *.html`, прогнані через справжні `parseSearchPage` +
`lookupBeer`):

| Пиво (shop input) | Untappd-канон | Корінь проблеми |
|---|---|---|
| Kykao `Handcrafted - Sour Berliner Weisse - Raspberry Edition (2025)` | `Kykao - Handcrafted` / `Sour Berliner Weisse - Raspberry Edition (2025)` | **адаптер**: пивоварня `Kykao - Handcrafted` містить ` - `, split по першому ` - ` заштовхує «Handcrafted» у назву |
| Schneider `TAP04 FESTWEISSE` | `Schneider Weisse…` / `Festweisse (TAP04)` | **matcher**: name-fuzzy чутливий до **порядку** токенів (`tap04 festweisse` vs `festweisse tap04`: seq 0.625, token-sorted 1.0) |
| Root + Branch `Fast Talking / North Park` | `Root + Branch` / `Fast Talking` | **matcher**: колаб-партнер після `/` **у назві інпуту** |
| Messorem `Globe Coagulant / Finback` | `Messorem` / `Globe Coagulant` | **matcher**: колаб-партнер після `/` **у назві інпуту** |
| Primator `PRIMÁTOR FREE MOTHER IN LAW` | `Primátor` / `Free Tchyně / Free Mother In Law` | **matcher**: (а) пивоварня продубльована в назві, (б) канонічна назва **двомовна** (`/` на боці Untappd) |
| Omnipollo `Kanelbullar` (brewery `Omnipollo collab/ Trillium Brewing Company`) | `Omnipollo` / `Kanelbullar` (а також `Trillium` / `Kanelbullar`) | **query**: токен-сміття `collab/` у пошуковому запиті → 0 результатів |
| Staropolski `KULTOWE PILS` | `Kultowy Browar Staropolski` / `Kultowe Pils` | **brewery gate**: реальна пивоварня — `Kultowy Browar Staropolski`, ярлик магазину `Staropolski` — це **хвостовий** токен, а hard-gate матчить лише провідний префікс |

**Out of scope цього дизайну:** Staropolski (потребує окремого, ризикованого
послаблення brewery hard-gate — окремий issue **#120**).

## 2. Goals / Non-goals

**Goals.** Шість із семи пив (усі, крім Staropolski) енричаться правильно. Без нових
false positives — нова логіка така ж сувора, як поточний exact-match.

**Non-goals.** Не міняємо схему БД, не міняємо `FUZZY_THRESHOLD`/`NAME_FUZZY_THRESHOLD`,
не послаблюємо brewery hard-gate (Staropolski), не чіпаємо клієнт-relay архітектуру
(один searchUrl на кандидата).

## 3. Design

Три незалежні зміни на двох шарах (matcher несе основну вагу + точковий фікс адаптера).

### 3.1 Matcher: name-keys set-intersection (`src/domain/matcher.ts`)

Кожному пиву зіставляємо **множину канонічних ключів назви**:

```
nameKeys(rawName, brewery): Set<string>
  для кожного side у rawName.split(COLLAB_SEP):        // '/', ' x ', ' & '
    norm  = normalizeName(side)                         // стиль/числа/діакритика
    norm  = stripLeadingBrewery(norm, normalizeBrewery(brewery))  // дубль пивоварні в назві
    toks  = norm.split(' ').filter(непорожні)
    if toks.length < 2: continue                        // MULTI-TOKEN GUARD (див. нижче)
    додати toks.sort().join(' ')                        // ORDER-INSENSITIVE
```

`stripLeadingBrewery(nameNorm, breweryNorm)` — якщо токени `breweryNorm` є **провідним
префіксом** токенів `nameNorm`, відрізати їх; інакше повернути без змін.

**Multi-token guard (обов'язковий).** Ключі з **< 2 токенів** відкидаються. Однотокенні
сторони (`fifty`, `hazy`, `finback`) — слабкі ключі, що дають хибні перетини між різними
пивами однієї пивоварні (напр. `Fifty/Fifty - Pineapple` vs `Fifty/Fifty Clementine`
обидва мають сторону `fifty`). Однотокенні **назви цілком** (напр. `Kanelbullar`) дають
порожній key-set і матчаться через звичайний fuzzy-фолбек (exact-назва → fuzzy = 1.0 ≥
поріг), тож нічого не втрачається.

**Правило збігу назв:** `nameKeys(input) ∩ nameKeys(canonical) ≠ ∅`. Це **рівність
множин по стороні** (не підмножина, не fuzzy) → стільки ж захищена від FP, скільки
поточний exact-match, але тепер **нечутлива до порядку** і **колаб/двомовно-свідома**.

Перевірено на ground truth (FP-проби відхиляються):

```
match  Schneider     {festweisse tap04} ∩ same
match  FastTalking    {fast talking, north park} ∩ {fast talking}
match  Messorem       {coagulant globe, finback} ∩ {coagulant globe}
match  Primator       {free in law mother} ∩ {free tchyne, free in law mother}
match  Kykao(fixed)   {berliner edition raspberry weisse} ∩ same
reject "Hazy Mango" vs "Hazy"            (∅)
reject "Fast Talking" vs "Slow Whispering" (∅)
reject "Stout" vs "Imperial Stout Vanilla" (∅; style-word стрипиться)
```

**Інтеграція (без міграції — ключі рахуються в рантаймі):**
- `PreparedBeer` отримує `keys: Set<string>` (рахується раз у `prepareBeer`).
- `matchPrepared` **exact-стадія**: **доповнити** (не замінити) умову —
  `breweryAliasesMatch && (c.nameNorm === nn || intersects(c.keys, inputKeys))`.
  Зберігаємо `nameNorm === nn`, щоб однотокенні exact-назви лишалися **exact** (це
  критично для правила #108 «is_drunk/user_rating лише для exact»); key-перетин додає
  order/collab-збіги теж як exact. Brewery-gate і vintage/ABV-логіка незмінні; fuzzy-фолбек
  (≥ 0.75) із divergence-guard незмінний.
- `lookupBeer` **Stage 2a (нове)**: на brewery-gated результатах спробувати перетин
  `nameKeys`; серед key-hit'ів — ABV-tiebreak, інакше перший. **Stage 2b (фолбек)**:
  якщо key-перетину нема — поточний fast-fuzzy ≥ 0.85 (з ABV-tiebreak), без змін.
  (Omnipollo `Kanelbullar` — однотокенна назва → key-set порожній → matched через 2b
  fuzzy = 1.0, щойно запит став чистим, §3.3.)

> Збережений `normalized_name` НЕ змінюється (лишається для групування/відображення в
> `/newbeers`, `/beers`). Ключі — суто матчинговий концепт.

### 3.2 Адаптер bierloods22: пивоварня з brand-префіксу (`extension/src/sites/bierloods22.ts`)

Кожна картка `.product-block` має `a.title` з:
- **textContent** = повний заголовок `"{пивоварня} - {назва}"`,
- **`title=` атрибут** = `"{brand} {textContent}"`.

Алгоритм:
```
text  = a.title.textContent                       // "Kykao - Handcrafted - Mediterranean Cedrus DIPA"
attr  = a.title[title]                             // "KYKAO - Handcrafted Kykao - Handcrafted - Mediterranean Cedrus DIPA"
brand = attr без хвоста text (case-insensitive)    // "KYKAO - Handcrafted"
n     = кількість " - "-сегментів у brand          // 2
segs  = text.split(" - ")                          // ["Kykao","Handcrafted","Mediterranean Cedrus DIPA"]
brewery = segs.slice(0, n).join(" - ")             // "Kykao - Handcrafted"
name    = segs.slice(n).join(" - ").trim()         // "Mediterranean Cedrus DIPA"
```
**Фолбек:** якщо `attr` не закінчується на `text` (brand порожній/невизначений) →
поточна поведінка (split по першому ` - `). Backward-compatible для пивоварень без
внутрішнього ` - `:

| brand (attr−text) | segs | brewery | name |
|---|---|---|---|
| `Kykao - Handcrafted` (2) | 3 | `Kykao - Handcrafted` | `Mediterranean Cedrus DIPA` |
| `Brokreacja` (1) | 2 | `Browar Brokreacja` | `The Dancer` |
| `Nano Cinco` (1) | 2 | `Nano Cinco` | `Georges Le Crapaud` |
| `` (порожній) | n | перший сегмент | решта |

### 3.3 Normalize + enrich query: токен `collab` (`src/domain/normalize.ts`)

- Додати `collab`, `collaboration` до `BREWERY_NOISE`.
- `stripBreweryNoise` робиться **collab-separator-aware**: спершу замінити `COLLAB_SEP`
  (глобально) на пробіл, ПОТІМ токенізувати й фільтрувати noise. Так приклеєне сміття
  `collab/` стає голим `collab` і відсіюється.

Перевірено:
```
"Omnipollo collab/ Trillium Brewing Company" -> "Omnipollo Trillium"   // query "Omnipollo Trillium Kanelbullar" -> знаходить пиво (2 результати, обидва gate✓)
"Kykao - Handcrafted"                        -> "Kykao - Handcrafted"  // " - " не COLLAB_SEP, ціле
"Root + Branch"                              -> "Root + Branch"        // "+" не COLLAB_SEP, ціле
```

> Це чинить лише на побудову пошукового запиту (`/enrich/candidates` searchUrl та
> `lookupBeer` per-part query). `breweryAliases`/brewery-gate не зачіпаються.

## 4. Testing

- **`matcher.test.ts`:** `nameKeys`/`stripLeadingBrewery` — 5 позитивних кейсів + FP-проби
  (`Hazy Mango`↛`Hazy`, різні пива, style-only-назва) + **regression guard:**
  `Fifty/Fifty Clementine` має key-hit'ити лише 5001 (Clementine), не 5000 (Pineapple) —
  доводить, що multi-token guard прибирає слабку сторону `fifty`.
- **`untappd-lookup.test.ts` / `match.test.ts`:** інтеграція проти **7 реальних HTML**
  пошуку Untappd (перенести з `tmp/` у `tests/fixtures/untappd-search/`). Очікування:
  6 → matched (крім Staropolski), Staropolski → not_found (доки brewery-gate не змінено).
- **`normalize.test.ts`:** `stripBreweryNoise` колаб-кейси (`collab/`, ` x `, ` & `, 3-way).
- **bierloods22 (Vitest):** Kykao (2-сегментна пивоварня) + Brokreacja (1-сегментна) +
  фолбек (порожній brand). Оновити/доповнити фікстуру `extension/tests/fixtures/bierloods22.html`
  карткою з ` - `-пивоварнею.

## 5. Spec impact (`spec.md`)

- §4 `/enrich/*` + `/match`: описати name-keys-матчинг (order-insensitive, collab/двомовний
  split, brewery-dedup) і collab-aware побудову запиту.
- §6 bierloods22-адаптер: brand-prefix екстракція пивоварні (замість split по першому ` - `).
- Appendix gotchas: `collab` у `BREWERY_NOISE`; name-keys як концепт матчингу; bierloods22
  brand-префікс; нагадування, що Staropolski (хвостовий brewery-токен) — окремий issue #120.

## 6. Rollout

- Без міграції БД. Після деплою наявні orphan'и (#117) переенричаться наступним
  `enrichOrphans`-проходом (backoff due) або клієнтським enrich; `untappd_id` проставиться.
- Staropolski лишається orphan (очікувано) до окремого фіксу brewery-gate.
