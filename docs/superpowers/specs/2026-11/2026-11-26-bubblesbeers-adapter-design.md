# Адаптер браузерного розширення для Bubbles Beers (`bubblesbeers.com`)

Дата: 2026-11-26
Статус: чекає на затвердження
Spec-review: codex/gpt-6.1-sol @ 2ba66b6 (author: agy) — 3 findings: 3 fixed, 0 rejected

## Для власника

**Мета.** Користувачі розширення бачать свій статус Untappd («вже пив» + особисту оцінку або глобальний рейтинг) на сторінках іспанського магазину крафтового пива `bubblesbeers.com` (каталог `/shop/`, категорії стилів, пагінація) — без потрапляння подарункових наборів, дегустацій, соди та мерчу в пошук, без хибного червоного `✕` на справжньому пиві з дескрипторами смаків чи серій на кшталт Tangerine чи Wolf Pack, без хибного бейджа чужого пива на столовому сорті Mesa, і з видимим попередженням «Не змогли розібрати цю картку» для односегментних позицій без відомої броварні.

**Що зміниться для тебе.** Розширення отримує новий host permission для `https://bubblesbeers.com/*` та `https://*.bubblesbeers.com/*`. Через новий host permission наступний реліз потребуватиме ручного завантаження zip-пакета в Chrome Web Store (як задокументовано в `docs/extension-release.md`), а сама зміна на сервер нічого не додає і версію розширення не піднімає.

**На чому стоїть рішення.**
- Вітрина працює на WooCommerce SSR (тема Astra), де товари рендеряться в списку `ul.products` картками `li.product` із заголовками `h2.woocommerce-loop-product__title` `[проба]` (§Проби, 1).
- Повний обхід живого каталогу (усі 4 сторінки `/shop/`, 40 унікальних товарів) та фікстури показує: 38 позицій — пиво (за фізичними роздільниками: 35 трисегментних `Brewery – Name – Style`, 1 двосегментна без стилю `Althaia – Mediterranean Tostada Sin Alcohol`, 1 чотирисегментна `La Quince – The Wonder Blade – West Coast Pils – Sin gluten` та 1 односегментна з відомою броварнею `Yakka Querida Ipa`; логічно парсер успішно виділяє броварню та назву для всіх 38, а для 36 з них — і стиль), 7 — не-пиво; живі проби через `POST /match` знаходять 33 з 38 сортів (33 exact matches, 4 повертають `null` через відсутність збігу в базі сервера, 0 хибних fuzzy-бейдів) `[проба]` (§Проби, 1).
- Клієнтська канонізація броварень (`CANONICAL_BREWERIES`) обмежена лише броварнями, підтвердженими фікстурою чи каталогом (Althaia, Attik, Garage, La Quince, La Sitgetana, Montseny, Octavo Arte, Oddity, Oso Brew, RIOAZUL, Sáez & Son, Yakka). Вона критично необхідна: без неї `Montseny / IPA` дає `null` (промах), `Althaia` дає `fuzzy` замість `exact`, а `Yakka` без префікса `Cervezas` дає небезпечний хибний збіг (`fuzzy`) на чужу броварню Amundsen Brewery `[проба]` (§Проби, 2). Непідтверджені позиції (Basqueland, Deya, Alhambra, Espiga) вилучено зі словників.
- Шість специфічних SKU (`SLUG_OVERRIDES`) покривають колаборацію, зареєстровану на Untappd під другою броварнею (`Rio Azul x La Quince` під `La Quince Brewing Co.`), релізи з префіксами стилю або дочірніми брендами (`TERP Fresh Press`, `TERP Golden Hour`, `FELIPPA BREW CO by Sáez & Son`, `Wildfires`), а також сорт `Oso Brew Co. – Mesa – Table Beer` (`bid 5292594`), для якого в базі сервера немає точного збігу і без оверрайду отримувався хибний fuzzy-бейдж чужого сорту `Ménage À Trois` (`bid 5019595`) `[проба]` (§Проби, 3).
- За `spec.md` §6 хибна відповідь гірша за відсутню: не-пиво фільтрується комбінацією глобального `isNonBeerName` по всій назві, префікса бренду `ES_NON_BEER_BRAND_RE` по першому сегменту та класів WooCommerce (`product_cat-packs`, `product_tag-soda` тощо), а картки без визначеної броварні або з пропущеними сегментами отримують `skip: true, skipReason: 'unparsed'` з попередженням «Не змогли розібрати цю картку» замість запитів з порожньою броварнею `[вимога власника]`.

**Ключові рішення.**
1. Розбиття назви за дефісом на `Brewery – Name – Style` із очищенням кінцевих об'ємів (`33cl`, `44cl` тощо) як із назви, так і зі стилю, а для 2-сегментних назв `style` лишається `undefined`, щоб категорії магазину (`Maltosas`, `Colaboraciones`) не підміняли стиль — розглянуто стандартне: підставляти категорію магазину як стиль — відкинуто, бо навігаційні категорії вітрини не є пивними стилями для `/enrich/*`.
2. Клієнтський словник `CANONICAL_BREWERIES` захищає від хибних збігів і промахів для 12 перевірених брендів — розглянуто стандартне: передавати броварню як є і покладатися на нечіткий пошук сервера — відкинуто, бо жива проба виявила, що `Montseny / IPA` стає промахом (`null`), а `Yakka` дає хибний збіг на Amundsen Brewery.
3. Колаборації (`Oso Brew Co x Hops Company`, `Oso Brew X Pühaste`): за замовчуванням береться перша броварня, що дає точні збіги `exact` на сервері. Для винятків, де на Untappd пиво приписане іншій броварні (`Rio Azul x La Quince` -> `La Quince Brewing Co.`), застосовується точковий `SLUG_OVERRIDES`.
4. Свідомий пропуск (`skip: true, skipReason: 'unparsed'`) для `Oso Brew Co. – Mesa – Table Beer` (`oso-brew-co-mesa-table-beer`): сорт на Untappd має `bid 5292594`, але в локальній базі сервера не знаходить збігу, через що нечіткий матчер видавав хибний збіг на `Ménage À Trois` (`bid 5019595`, 4.09). За правилом §6 картку позначено як нерозібрану, щоб не показувати чуже пиво.
5. `skipReason: 'unparsed'` («Не змогли розібрати цю картку») для односегментних назв без відомої броварні, карток із пропущеними сегментами (`Garage – – IPA`, `– Soup – Hazy IPA`), назв із відсіканням об'єму (`Garage – 44cl – IPA`) або заголовків лише з броварні (`Garage Beer Co.`) — розглянуто стандартне: надсилати у `/match` з `brewery: ''` чи вигаданими сегментами — відкинуто, бо це створює безрезультатні запити та ризик хибного матчу.
6. Дворівнева фільтрація не-пива: глобальний `isNonBeerName` по всій назві + `ES_NON_BEER_BRAND_RE` строго по першому сегменту (бренду) + категорії/теги WooCommerce — розглянуто стандартне: шукати іспанські слова не-пива по всій назві — відкинуто, бо це ставило червоний `✕` на справжнє пиво з назвами на кшталт `Tangerine Dream`, `Wolf Pack`, `Cream Soda Sour`, `Cola de Caballo`, `Copa del Rey`.
7. Збереження оригінальної іспанської назви з `data-success_message` кнопки додавання в кошик для захисту від вбудованого автоперекладу браузера. Для out-of-stock та variable товарів без цієї кнопки заголовок береться з видимого `.woocommerce-loop-product__title`.

**Що стане гірше.**
- Товари нових іспанських крафтових броварень з односегментними назвами (без роздільника ` – ` і поза `KNOWN_BREWERIES`), а також сорти без точного збігу на сервері, які тригерять хибний fuzzy (як Mesa), покажуть жовтий бейдж-попередження «Не змогли розібрати цю картку».
- Товари не в наявності (out-of-stock) та варіативні товари у WooCommerce не мають кнопки додавання до кошика з атрибутом `data-success_message`. Для них заголовок зчитується з видимого тексту `.woocommerce-loop-product__title`, тому за умови увімкненого автоперекладу сторінки браузером їхні назви можуть надсилатися на зіставлення перекладеними.

**Оцінка.** Власник: S. Автор: S — адаптер (~40%), фікстури та тести (~35%), документація/спека/скріншоти (~25%).

**Питання до власника.** Немає.

## Тіло

### Проби

1. **Живий браузер і повний HTTP-обхід каталогу `bubblesbeers.com` (2026-11-26) та фікстури:**
   - Повністю опитано всі 4 сторінки каталогу магазину (`/shop/`, `/shop/page/2/`, `/shop/page/3/`, `/shop/page/4/`; сторінка 5 повертає 404) та фікстуру `extension/tests/fixtures/bubblesbeers.html`.
   - Каталог і фікстура сумарно містять 45 унікальних товарів: 38 пивних позицій та 7 не-пивних (паки, сода, коробка-сюрприз).
   - Розподіл структур назв пивних товарів за фізичними роздільниками (` – `): 35 мають трисегментну структуру `Brewery – Name – Style`, 1 має двосегментну `Brewery – Name` (`Althaia – Mediterranean Tostada Sin Alcohol`, без стилю), 1 має чотирисегментну `Brewery – Name – Style – Substyle` (`La Quince – The Wonder Blade – West Coast Pils – Sin gluten`, де хвости об'єднуються у стиль), та 1 односегментна з відомою броварнею (`Yakka Querida Ipa`). Логічно парсер успішно виділяє броварню і назву для всіх 38 карток.
   - Усі 38 пивних карток прогнано через `POST https://beer-api.ysilvestrov-ai.uk/match`.
   - **Результат матчингу:** 33 exact matches, 4 null matches (немає збігу через `/match`: `Althaia – Mediterranean Tostada Sin Alcohol`, `Attik – Smile`, `La Quince – The Wonder Blade`, `Yakka Querida Ipa`), 1 свідомо пропущена картка Mesa (`skipReason: 'unparsed'`), 0 хибних fuzzy-збігів.

2. **Порівняння raw-броварні проти канонічної форми (`CANONICAL_BREWERIES`):**
   - `Montseny / IPA`: з raw `Montseny` дає `null` (промах); з канонічною `Companyia Cervesera del Montseny` дає `exact` (`bid 199890`).
   - `Yakka / German Pils`: з raw `Yakka` дає хибний `fuzzy` збіг на `Amundsen Brewery - 9th Birthday Cake...` (`bid 5141210`); з канонічною `Cervezas Yakka` дає `null` (захист від показу чужого пива).
   - `Althaia / Barlovento`: з raw `Althaia` дає `fuzzy`; з канонічною `Cervezas Althaia` дає `exact` (`bid 1903411`).
   - `Althaia / Mascarat`: з raw `Althaia` дає `fuzzy`; з канонічною `Cervezas Althaia` дає `exact` (`bid 2407179`).
   - `Garage / Lollies`: обидві дають `exact` (`bid 6721018`).
   - `La Quince / Mr. Bubbles`: обидві дають `exact` (`bid 6196638`).
   - `La Sitgetana / Maricel`: обидві дають `exact` (`bid 2329121`).
   - `Oddity / Wildfires`: обидві дають `exact` (`bid 6147841`).
   - `Oso Brew / Ace High`: обидві дають `exact` (`bid 7659216`).
   - `Saez & Son / TERP Fresh Press`: обидві дають `exact` (`bid 7180590`).
   - Усі непокриті каталогом броварні (Basqueland, Deya, Alhambra, Espiga) вилучено.

3. **Колаборації та аналіз оверрайдів (`SLUG_OVERRIDES`):**
   - Колаборації зі звичайним порядком броварень:
     - `Oso Brew Co x Hops Company – Happy Days – NEIPA`: розбивається за `x`, береться перша броварня `Oso Brew Co`. Запит `Oso Brew Co` / `Happy Days` повертає `exact` (`bid 7659220`, rating 3.87).
     - `Oso Brew X Pühaste – Choc-a-bloc – Imperial Stout`: береться перша броварня `Oso Brew Co`. Запит `Oso Brew Co` / `Choc-a-bloc` повертає `exact` (`bid 7659224`, rating 4.14).
   - `rio-azul-x-laquince-a-giant-leap-for-an-ape-tiramisu-patry-stout`:
     - Назва на вітрині: `Rio Azul x La Quince – A Giant Leap for an Ape – Tiramisú Pastry Stout`.
     - На Untappd сорт зареєстровано під `La Quince Brewing Co.` як `A GIANT LEAP FOR AN APE!` (`bid 7401043`). Без оверрайду колаборація розбивається за першою броварнею `RIOAZUL`, що дає `null`. З оверрайдом — `exact`.
   - `saez-son-saezsonf-fresh-press-te-rp-smoothiesour`:
     - Назва на вітрині: `Saez & Son – Fresh Press – TERP Smoothie Sour`.
     - На Untappd назва сорту включає лінійку: `TERP Fresh Press` (`bid 7180590`). Без оверрайду запит `Fresh Press` дає лише `fuzzy`. З оверрайдом `TERP Fresh Press` — `exact`.
   - `saez-son-golden-hour-terp-smoothie-sour`:
     - Назва на вітрині: `Saez & Son – Golden Hour – TERP Smoothie Sour`.
     - На Untappd назва сорту: `TERP Golden Hour` (`bid 7180377`). Без оверрайду — `fuzzy`. З оверрайдом — `exact`.
   - `saezson-felippa-west-coast-ipa`:
     - Назва на вітрині: `Saez & Son – Felippa – West Coast IPA`.
     - На Untappd зареєстровано як окремий бренд `FELIPPA BREW CO by Sáez & Son` (`bid 6833796`).
   - `oddity-wildfires`:
     - Назва на вітрині містить однину: `Oddity – Wildfire – Neipa`.
     - На Untappd назва в множині: `Wildfires` (`bid 6147841`). Без оверрайду — `fuzzy`. З оверрайдом — `exact`.
   - `oso-brew-co-mesa-table-beer`:
     - Назва на вітрині: `Oso Brew Co. – Mesa – Table Beer`.
     - На Untappd сорт існує як `Mesa` (`bid 5292594`), але в локальній базі сервера не знаходить збігу. Запит `Oso Brew Co / Mesa` давав хибний `fuzzy` збіг на `Ménage À Trois` (`bid 5019595`, 4.09). Через оверрайд встановлено `skip: true`, повертаючи `skipReason: 'unparsed'`.

4. **Поведінка карток без броварні та неповноцінних назв:**
   - Для односегментних карток без відомої броварні (`Attikus Lager`), позицій із пропущеними сегментами (`Garage – – IPA`, `– Soup – Hazy IPA`), назв, які після чищення об'єму виявляються порожніми (`Garage – 44cl – IPA`), або заголовків, що містять лише броварню (`Garage Beer Co.`, `La Quince Brewing Co.`):
     - Адаптер маркує їх як `skip: true, skipReason: 'unparsed'`.
     - Мережевий запит не виконується, користувач бачить попередження «Не змогли розібрати цю картку».

### Зміна

- Адаптер `extension/src/sites/bubblesbeers.ts`:
  - `isNonBeerPage(url)` перевіряє чорний список шляхів (блог, дегустації, кошик, акаунт).
  - `parseCards(root)`:
    - Читає заголовок через `extractOriginalTitle` (з `data-success_message` за наявності, або з `.woocommerce-loop-product__title` для out-of-stock та variable товарів, у яких кнопка додавання до кошика з цим атрибутом відсутня).
    - Перевіряє не-пиво: `isNonBeerName(rawTitle)` по всій назві, `ES_NON_BEER_BRAND_RE` по першому сегменту, категорії `Packs`/`Refrescos` та класи WooCommerce.
    - Перевіряє `SLUG_OVERRIDES` (якщо `override.skip === true`, віддає `skip: true, skipReason: 'unparsed'`).
    - Парсить назву за трьох- або двокомпонентною схемою `Brewery – Name – Style` зі збереженням позицій.
    - Очищає кінцеві об'єми (`33cl`, `44cl`, `75cl`, `1l`) як з назви, так і зі стилю функцією `stripVolume`.
    - Для 2-сегментних назв поле `style` залишає `undefined`, захищаючи від підміни стилю категоріями магазину.
    - Для односегментних назв шукає броварню в `KNOWN_BREWERIES` з обов'язковою межею слова; якщо назва містить лише броварню — зупиняється.
    - Якщо броварню чи назву визначити не вдалося, віддає `skip: true, skipReason: 'unparsed'`.
    - Застосовує `CANONICAL_BREWERIES` та `SLUG_OVERRIDES`.
- Тести `extension/src/sites/bubblesbeers.test.ts`:
  - 12 тестів, що покривають повний контракт: фікстура, захист від хибного не-пива, чищення об'ємів, межа слів, unparsed картки (включно з неповноцінними заголовками, чищенням об'єму та назвами лише з броварні), збереження іспанського заголовка, колаборації, класи WooCommerce та оверрайд Mesa.
- Реєстрація та документація:
  - `registry.ts`, `manifest.config.ts`, `supported-shops.ts`, `spec.md`, `extension/CHANGELOG.md`, `docs/extension-install-{en,uk}.md`, `site/index.html` та перезняті скріншоти popup.

## Заявка → доказ

Усі рядки побудовано з двох реальних джерел: фікстури `extension/tests/fixtures/bubblesbeers.html` та повного обходу вітрини `bubblesbeers.com` станом на 2026-11-26 (усі 4 сторінки `/shop/`, 40 SKU). Результати перевірено повторними запитами до `POST https://beer-api.ysilvestrov-ai.uk/match`:

| Товар на вітрині / Заголовок | Що надсилає адаптер | Відповідь `/match` (`source`, `bid`, сорт, рейтинг) | Джерело | Сила |
|---|---|---|---|---|
| `Althaia – Barlovento – Smoked Imperial Stout` | `Cervezas Althaia` / `Barlovento` | `exact`, `bid 1903411` (Cervezas Althaia — Barlovento, rating 3.82) | Фікстура | `[проба]` |
| `Althaia – Mascarat – Black Rye IPA` | `Cervezas Althaia` / `Mascarat` | `exact`, `bid 2407179` (Cervezas Althaia — Mascarat, rating 3.57) | Фікстура | `[проба]` |
| `Althaia – Mediterranean IPA – American ipa` | `Cervezas Althaia` / `Mediterranean IPA` | `exact`, `bid 1032784` (Cervezas Althaia — Mediterranean IPA, rating 3.59) | Фікстура | `[проба]` |
| `Althaia – Mediterranean Tostada Sin Alcohol` | `Cervezas Althaia` / `Mediterranean Tostada Sin Alcohol` | `null` (немає збігу через `/match`) | Фікстура | `[проба]` |
| `Attik – Smile – West Coast IPA sin gluten` | `Attik Brewing` / `Smile` | `null` (немає збігу через `/match`) | Фікстура | `[проба]` |
| `Attik – Zessie – Wild Ale Cereza` | `Attik Brewing` / `Zessie` | `exact`, `bid 6487512` (Attik Brewing — Zessie, rating 3.94) | Фікстура | `[проба]` |
| `Garage – Lollies – Berliner weisse` | `Garage Beer Co.` / `Lollies` | `exact`, `bid 6721018` (Garage Beer Co. — Lollies, rating 3.72) | Фікстура | `[проба]` |
| `Garage – Stef – West Coast Pils` | `Garage Beer Co.` / `Stef` | `exact`, `bid 6721219` (Garage Beer Co. — Stef, rating 3.74) | Фікстура | `[проба]` |
| `Garage – Viduka – New England Pale Ale` | `Garage Beer Co.` / `Viduka` | `exact`, `bid 6784631` (Garage Beer Co. — Viduka, rating 3.8) | Фікстура | `[проба]` |
| `La Quince – Mr. Bubbles – Czech Lager Sin Gluten` | `La Quince Brewing Co.` / `Mr. Bubbles` | `exact`, `bid 6196638` (La Quince Brewing Co. — Mr. Bubbles, rating 3.56) | Фікстура | `[проба]` |
| `La Quince – The Wonder Blade – West Coast Pils – Sin gluten` | `La Quince Brewing Co.` / `The Wonder Blade` | `null` (немає збігу через `/match`) | Фікстура | `[проба]` |
| `La Sitgetana – Maricel – American Pale ale` | `La Sitgetana Craftbeer` / `Maricel` | `exact`, `bid 2329121` (La Sitgetana Craftbeer — Maricel, rating 3.57) | Каталог (2026-11-26) | `[проба]` |
| `La Sitgetana – Ultra Citra – Hoppy lager` | `La Sitgetana Craftbeer` / `Ultra Citra` | `exact`, `bid 6630520` (La Sitgetana Craftbeer — Ultra Citra, rating 3.74) | Каталог (2026-11-26) | `[проба]` |
| `Montseny – IPA – American IPA` | `Companyia Cervesera del Montseny` / `IPA` | `exact`, `bid 199890` (Companyia Cervesera del Montseny — IPA, rating 3.49) | Каталог (2026-11-26) | `[проба]` |
| `Octavo Arte – 1521 – Porter sin gluten` | `Octavo Arte` / `1521` | `exact`, `bid 1509054` (Octavo Arte — 1521, rating 3.63) | Каталог (2026-11-26) | `[проба]` |
| `Octavo Arte – Dumbo – Hazy IPA` | `Octavo Arte` / `Dumbo` | `exact`, `bid 7318827` (Octavo Arte — Dumbo, rating 3.88) | Каталог (2026-11-26) | `[проба]` |
| `Octavo Arte – Magia Blanca – Milkshake IPA` | `Octavo Arte` / `Magia Blanca` | `exact`, `bid 7662143` (Octavo Arte — Magia Blanca, rating 3.97) | Каталог (2026-11-26) | `[проба]` |
| `Octavo Arte – Ultra Ligera – Hazy Pale Ale` | `Octavo Arte` / `Ultra Ligera` | `exact`, `bid 7662142` (Octavo Arte — Ultra Ligera, без рейтингу) | Каталог (2026-11-26) | `[проба]` |
| `Oddity – Wildfire – Neipa` | `Oddity Brewing` / `Wildfires` | `exact`, `bid 6147841` (Oddity Brewing — Wildfires, rating 3.8) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew – Ace High – West Coast IPA` | `Oso Brew Co` / `Ace High` | `exact`, `bid 7659216` (Oso Brew Co — Ace High, rating 3.76) | Каталог (2026-11-26) | `[проба]` |
| `Oso brew – Badlands – West Coast IPA` | `Oso Brew Co` / `Badlands` | `exact`, `bid 6819953` (Oso Brew Co — Badlands, rating 3.69) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew – Evermore – NEIPA` | `Oso Brew Co` / `Evermore` | `exact`, `bid 7659219` (Oso Brew Co — Evermore, rating 4.02) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew – Win Win – NEIPA` | `Oso Brew Co` / `Win Win` | `exact`, `bid 7659218` (Oso Brew Co — Win Win, rating 3.9) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew Co x Hops Company – Happy Days – NEIPA` | `Oso Brew Co` / `Happy Days` | `exact`, `bid 7659220` (Oso Brew Co — Happy Days, rating 3.87) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew Co. – Far Out –  NZ Pale Ale` | `Oso Brew Co` / `Far Out` | `exact`, `bid 6819950` (Oso Brew Co — Far Out, rating 3.71) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew Co. – Mesa – Table Beer` | — (не надсилається) | `skipReason: 'unparsed'` (свідомо пропущено для уникнення хибного бейджа) | Каталог (2026-11-26) | `[проба]` |
| `Oso Brew X Pühaste – Choc-a-bloc – Imperial Stout` | `Oso Brew Co` / `Choc-a-bloc` | `exact`, `bid 7659224` (Oso Brew Co — Choc-a-bloc, rating 4.14) | Каталог (2026-11-26) | `[проба]` |
| `Río Azul – Highway Dreams – West Coast IPA` | `RIOAZUL` / `Highway Dreams` | `exact`, `bid 7218719` (RIOAZUL — Highway Dreams, rating 3.77) | Каталог (2026-11-26) | `[проба]` |
| `Rio Azul x LaQuince –  A giant leap for an ape – Tiramisu patry stout` | `La Quince Brewing Co.` / `A GIANT LEAP FOR AN APE!` | `exact`, `bid 7401043` (La Quince Brewing Co. — A GIANT LEAP FOR AN APE!, rating 3.8) | Каталог (2026-11-26) | `[проба]` |
| `Sáez & Son – Fresh Press – Terp Smoothie Sour` | `Sáez & Son` / `TERP Fresh Press` | `exact`, `bid 7180590` (Sáez & Son — TERP Fresh Press, rating 4.12) | Каталог (2026-11-26) | `[проба]` |
| `Sáez & Son – Golden Hour – Terp Smoothie Sour` | `Sáez & Son` / `TERP Golden Hour` | `exact`, `bid 7180377` (Sáez & Son — TERP Golden Hour, rating 4.23) | Каталог (2026-11-26) | `[проба]` |
| `Saez&Son  – Mistbound – Doble Hazy IPA` | `Sáez & Son` / `Mistbound` | `exact`, `bid 7180150` (Sáez & Son — Mistbound, rating 4.01) | Каталог (2026-11-26) | `[проба]` |
| `Saez&Son – Felippa – West Coast IPA` | `FELIPPA BREW CO by Sáez & Son` / `FELIPPA` | `exact`, `bid 6833796` (FELIPPA BREW CO by Sáez & Son — FELIPPA, rating 3.82) | Каталог (2026-11-26) | `[проба]` |
| `Sáez&Son – No Reason – Hazy IPA` | `Sáez & Son` / `No Reason` | `exact`, `bid 7180237` (Sáez & Son — No Reason, rating 4.1) | Каталог (2026-11-26) | `[проба]` |
| `Yakka – Blonde – Belgian blonde` | `Cervezas Yakka` / `Blonde` | `exact`, `bid 5310076` (Cervezas Yakka — Blonde, rating 3.44) | Каталог (2026-11-26) | `[проба]` |
| `Yakka -Triple – Belgian tripel` | `Cervezas Yakka` / `Triple` | `exact`, `bid 5640820` (Cervezas Yakka — Triple, rating 3.63) | Каталог (2026-11-26) | `[проба]` |
| `Yakka Querida Ipa` | `Cervezas Yakka` / `Querida Ipa` | `null` (немає збігу через `/match`) | Каталог (2026-11-26) | `[проба]` |
| `Althaia – Batiscafo – Imperial Stout con cacao` | `Cervezas Althaia` / `Batiscafo` | `exact`, `bid 4048612` (Cervezas Althaia — Batiscafo, rating 3.91) | Каталог (2026-11-26) | `[проба]` |

## Рев'ю спеки

| # | Перевірка | Рішення | Причина / що змінено |
|---|---|---|---|
| 1 | [1] Захист від автоперекладу не діє на товари без атрибута `data-success_message` (out-of-stock та variable), але це обмеження не розкрито в розділі для власника | Виправлено | Додано явне застереження у «Для власника» («Що стане гірше») та «Зміна»: товари без кнопки додавання до кошика читаються з `.woocommerce-loop-product__title` і при браузерному перекладі можуть передавати перекладені назви. |
| 2 | [4] Промах `/match` (`null`) трактується як доказ відсутності сорту в базі сервера | Виправлено | Формулювання змінено на точніше: «не зіставлено / немає збігу через `/match`» без необґрунтованого ствердження про відсутність у каталозі сервера. |
| 3 | [2] Інвентар структур назв суперечить фікстурі (де є 2-сегментна та 4-сегментна назви) | Виправлено | Виправлено класифікацію за фізичними роздільниками (` – `): 35 трисегментних, 1 двосегментна (`Althaia – Mediterranean Tostada Sin Alcohol`), 1 чотирисегментна (`La Quince – The Wonder Blade – West Coast Pils – Sin gluten`) та 1 односегментна (`Yakka Querida Ipa`); логічно парсер виділяє назву та броварню (і стиль для 36 карток). |
