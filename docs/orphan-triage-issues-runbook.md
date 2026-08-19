# Ранбук: черга `orphan-triage` issues

> Джерело істини по схемі — `spec.md` §3.13. Дизайн стану saturated —
> `docs/superpowers/specs/2026-08/2026-08-15-421-fix-keyed-lock-design.md` (fix
> keyed lock) та `docs/superpowers/specs/2026-08/2026-08-19-431-saturation-as-state-design.md`.

## 1. Що це і чим відрізняється від `debug-orphan-matching.md`

[`debug-orphan-matching.md`](./debug-orphan-matching.md) веде від симптому
**одного пива** (orphan / не той матч) до кореня. Цей ранбук — про інше:
не про конкретне пиво, а про **чергу GitHub-issues** з міткою `orphan-triage`,
кожен з яких володіє набором рядків у `enrich_failures` (через
`enrich_failures.issue_number`). Тут — як знайти, який issue брати наступним,
як декомпозувати «розбухлий» issue не розірвавши зв'язок рядків з фіксом, і
що відбувається автоматично при його закритті.

## 2. Знайти роботу

Три способи, від найдешевшого:

1. **Рядок `Насичені:` у щоденному дайджесті.** Джоба `orphan-triage`
   формує його з `SATURATED_LINE_LIMIT = 5` найбільш насичених issues,
   відсортованих за кількістю рядків спадаюче — перший запис у списку і є
   наступним кандидатом:

   ```
   Насичені: #405 (21), #427 (14), #334 (12) — усього 3
   ```

2. **GitHub-пошук:** `is:open label:orphan-triage label:saturated`.

3. **SQL по `enrich_failures`** — рахує **інакше**, ніж мітка:

   ```bash
   sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' "
     SELECT issue_number, COUNT(*) AS rows_lifetime
       FROM enrich_failures
      WHERE issue_number IS NOT NULL
      GROUP BY issue_number
      ORDER BY rows_lifetime DESC;"
   ```

   > `COUNT(*)` тут — лічильник **за весь час**, а мітка `saturated`
   > відображає `postCreationRows`, тобто рядки, дописані **після** створення
   > issue. Для issue, народжених із перелічених рядків (як #405, що
   > з'явився з 15), числа законно розходяться. Мітка не помиляється — вони
   > міряють різне.

І зворотна перевірка — таблиця `enrich_failures` рекламує роботу, яку вже
вбили задеплоєні фікси, тож перед тим як братись за issue, перевір, чи в
нього ще лишились живі рядки:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT COUNT(*) FROM enrich_failures WHERE issue_number = <N>;"
```

> `0` означає, що дефект більше не має живих рядків — issue закривається як
> зроблений, без коду.

## 3. Перед фіксом — реплей

Проєктна політика: перш ніж писати код, відтворити приклади самого issue
живим запитом до Untappd (не покладатись на опис у issue). #340, #303 і
#350 кожен був спростований саме так — і один з них, якби його
заімплементували, погіршив би матчинг. Такий реплей — це **spike**: він не
лишає закомміченого коду і не потребує ні spec, ні plan. Якщо з реплею
народжується реальна зміна — вона повертається у повний цикл
(brainstorming → spec → plan → worktree), як і будь-яка інша зміна
поведінки.

## 4. Декомпозиція — перемапити рядки в тому ж кроці

Розбиваючи `orphan-triage` issue на під-issue (або замінюючи його вужчим),
перемап його рядки в тому ж кроці — інакше замок (`unlock-fixed-orphans`)
розімкнеться на закриття не того issue:

```bash
sudo -u warsaw-beer-bot bash -lc \
  "sqlite3 /var/lib/warsaw-beer-bot/bot.db \
   \"UPDATE enrich_failures SET issue_number = <під-issue> WHERE beer_id IN (34852, 34901)\""
```

Перевір свіжим read-only читанням:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT beer_id, issue_number, review_class FROM enrich_failures WHERE beer_id IN (34852, 34901);"
```

Чотири правила, кожне зі своїм «чому»:

- **Тільки ті рядки, які під-issue справді покриває, перелічені явно
  `beer_id`.** Здогадка не рахується.
- **Ніколи** гуртом `WHERE issue_number = <батько>` на одну дитину: рядок,
  для якого не можеш назвати під-issue, лишається на батькові й платить свій
  один зайвий лукап — бо хибний лінк гірший за відсутній, він розімкнеться
  на закритті чужого issue.
- **`review_class` при перемапуванні не чіпати.** Клас каже, який це
  дефект, номер issue — хто його фіксить; зміна обох разом позбавляє
  вердикт свідчення.
- **Читай назад тільки з `?mode=ro`, ніколи з `immutable=1`.** Бот працює у
  WAL-режимі; `immutable=1` читає лише основний файл БД і не бачить WAL —
  покаже застарілий знімок, який пропустить щойно зроблений запис.

## 5. Закриття issue

Після закриття issue на GitHub спрацьовує ланцюжок автоматично, без
ручного втручання:

- **такт 1** — `unlock-fixed-orphans` бачить, що issue вийшов з відкритого
  набору, ставить `unlocked_at`, скидає лічильник backoff;
- **такт 2** — наступна невдала спроба енричу очищає
  `review_class`/`review_note`/`reviewed_at`/`unlocked_at` і повертає рядок
  у чергу тріажу, **зберігаючи `issue_number`** як запис про те, що цей фікс
  уже пробувався і не покрив цей рядок.

Знімай когорту **до** закриття — зматчений рядок сам себе видаляє з
`enrich_failures` (#127), і порахувати його потім вже не вийде:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT beer_id FROM enrich_failures WHERE issue_number = <N>;" > ./tmp/cohort-<N>.txt
```

Потім, після прогону unlock:

```bash
sqlite3 'file:/var/lib/warsaw-beer-bot/bot.db?mode=ro' \
  "SELECT COUNT(*) FROM enrich_failures WHERE issue_number = <N> AND unlocked_at IS NOT NULL;"
```

> «Розімкнуто» саме по собі **нічого не доводить**. Перший такий прогін
> (2026-08-16) розімкнув 152 рядки, з яких 91 були поза будь-яким досяжним
> пулом — тобто крон до них просто не доходить. Рахуй те, що зматчилось за
> тиждень: рядки з когорти (файл `./tmp/cohort-<N>.txt`), яких більше немає
> в `enrich_failures`.

## 6. Мітка `saturated`

Керується машиною, самою джобою `orphan-triage`: додається, коли
пост-creation рядків набирається 12 (`SATURATION_ALERT_ROWS`), знімається,
коли їх стає менше. Виставляти чи знімати її вручну — марно: наступний
прогін все одно приведе до відповідності стану.

**Закритий** issue лишається з міткою `saturated` назавжди — джоба
перелічує лише **відкриті** issues і закритий більше не бачить. Це не
проблема: кожен запит у цьому ранбуку фільтрує `is:open`, тож застаріла
мітка на закритому issue нічого не зіпсує.
