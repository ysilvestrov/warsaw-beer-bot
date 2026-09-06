# #409 — незалежний від порядку вибір кандидатів: дизайн

**Дата:** 2026-09-05
**Issue:** #409

## Проблема

Strict near-name і fuzzy Stage 2b обчислюють score для кандидатів, але при однаковому
максимальному score зрештою обирали перший результат Algolia. Через це перестановка тих самих
пив могла змінити вибраний `bid`, хоча порядок пошуку не є доказом ідентичності.

## Рішення

Обидві scored approximate стадії використовують один приватний resolver:

1. Дедуплікувати результати за `bid`, зберігаючи найсильніший score кожного пива.
2. Утворити top cohort лише з кандидатів, score яких точно дорівнює максимуму.
3. Якщо distinct top-кандидат один, повернути його за чинною поведінкою стадії, навіть коли
   відомий ABV суперечить вхідному.
4. Якщо distinct top-кандидатів кілька, вимагати `rating_count` для кожного й делегувати вибір
   чинному `dominantCandidate`: щонайменше 1 000 рейтингів і перевага щонайменше у п'ять разів.
5. ABV у tie лише накладає вето на popularity leader. Він не обирає runner-up.
6. Без повного popularity-доказу або без домінантного кандидата завершити цей result set як
   `not_found`, не переходячи до слабшої стадії.

## Межі

- Змінюються лише strict near-name Stage 2a.5 і fuzzy Stage 2b.
- Exact key, relaxed brewery, native alias, brand, Czech grade, flagship та local `/match`
  зберігають свої контракти.
- Пороги score, popularity й ABV не змінюються.
- Додаткового hydration для старих relay payloads без `rating_count` немає; неоднозначність
  навмисно fail-closed.
- Production-БД, ownership рядків #334, extension і release flow не змінюються.

## Перевірка

Public-seam тести `lookupBeer` покривають обидві стадії: переставлений exact-score tie без
popularity, сумісного dominant leader, ABV-veto без promotion, unique top із нижчим scored
конкурентом і duplicate того самого `bid`. Окремий exact-key vintage test доводить, що Stage 2a
далі використовує ABV як selector.

## Таблиця «заявка -> доказ»

Ця зміна не записує нового persistent state, cursor, verdict або cache як факт. Рішення
приймається лише в пам'яті одного lookup; доказом його контракту є focused regression suite.
