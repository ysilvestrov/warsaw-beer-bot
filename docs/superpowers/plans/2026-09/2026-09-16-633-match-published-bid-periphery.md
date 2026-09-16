# #633 обв'язка: розширення надсилає bid, чейнджлог і реліз — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** розширення надсилає в `/match` опублікований крамницею `bid` і `brand`, користувач бачить зміну в чейнджлозі й інструкціях, реліз 0.19.0 виходить після мерджу.

**Architecture:** ядро вже на гілці (`a8cd2ef`, `e3415c8`, `bffe40b`, `1f7fb1e`, `86d63db`, `3150f1b`): сервер приймає поля й відповідає за bid. Лишається клієнт — два файли в `extension/` — і користувацькі документи. Реліз операційний і йде **після** мерджу PR.

**Tech Stack:** TypeScript, Vite, Vitest (окремий проєкт `extension/` зі своїм гейтом), Chrome MV3.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-15-633-match-published-bid-design.md`

## Global Constraints

- **Гейтів два, і обидва обов'язкові після кожної задачі:** у корені `npm test && npm run typecheck`, у теці `extension/` — `npm test && npm run typecheck`. Серверний гейт зміни в `extension/**` не покриває.
- **`brand` без `bid` не надсилається ніколи** — сервер без `bid` його й не читає, а зайве поле в payload означало б, що ми шлемо бренд крамниці без потреби.
- **Фільтр дошуку (`enrich`) не змінюється.** Картка, на яку відповів bid, повертається з `matched_beer.untappd_id === bid`, тож у дошук не йде; картка з відхиленим гейтом лишається суперечливою і йде в репарацію #384, як сьогодні.
- **Чейнджлог — користувацький текст** (`extension/CHANGELOG.md`, шапка файлу): рядок називає симптом, який людина бачила, мовою інтерфейсу. Рядок, якого користувач не може помітити, не пишеться взагалі.
- **Кожен тест доводиться мутацією**; стаби — з видимими значеннями.
- **Коміти:** один на задачу, повідомлення називає механізм; остання стрічка — `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`. Коміт лише явними шляхами.
- Версію в `extension/package.json` **на цих задачах не чіпати** — бамп робиться на зрізі релізу (задача 4).

---

### Task 1: Картка надсилає `bid` і `brand` у `/match`

Адаптер Flasker уже кладе `card.bid` і `card.brand` до запиту (`loadDetailsBeforeCache: true`), а `RawBeer` їх не несе. Додаємо їх у payload — і тільки їх.

**Files:**
- Modify: `extension/src/api/types.ts` (інтерфейс `RawBeer`)
- Modify: `extension/src/content/index.ts` (побудова `rawMisses`, рядки ~83–94)
- Test: `extension/src/content/index.test.ts`

**Interfaces:**
- Consumes: `Card.bid?: number`, `Card.brand?: string` (`extension/src/sites/types.ts`) — уже є.
- Produces: `RawBeer` дістає `bid?: number` і `brand?: string`; payload `/match` несе їх лише для картки з `bid`.

- [ ] **Step 1: Write the failing tests**

У `extension/src/content/index.test.ts` (стиль наявних тестів: адаптер віддає картки, `sendMatch` — шпигун, звірка через `toHaveBeenCalledWith`):

```ts
  it('sends the shop-published bid and brand for a card that has them (#633)', async () => {
    const card = cardEl('FLASKER', 'Abrikoos');
    const adapter = {
      ...adapterFor([card]),
      loadDetailsBeforeCache: true,
      loadCardDetails: async (cards: Card[]) => {
        cards[0].bid = 5081070;
        cards[0].brand = 'Mad Brew';
      },
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([
      { brewery: 'FLASKER', name: 'Abrikoos', bid: 5081070, brand: 'Mad Brew' },
    ]);
  });

  it('never sends brand without a bid (#633)', async () => {
    const card = cardEl('FLASKER', 'Abrikoos');
    const adapter = {
      ...adapterFor([card]),
      loadDetailsBeforeCache: true,
      loadCardDetails: async (cards: Card[]) => { cards[0].brand = 'Mad Brew'; },
    };
    const sendMatch = vi.fn(async () => [drunkResult('FLASKER', 'Abrikoos')]);

    await runOverlay(document, adapter, sendMatch);

    expect(sendMatch).toHaveBeenCalledWith([{ brewery: 'FLASKER', name: 'Abrikoos' }]);
  });
```

(`cardEl`/`adapterFor`/`drunkResult` — наявні хелпери файлу; якщо назви інші, взяти ті, що вже використовують сусідні тести, і не вводити нових.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd extension && npx vitest run src/content/index.test.ts`
Expected: перший тест падає — payload без `bid`/`brand`; другий проходить одразу (поля ще нікуди не потрапляють) і стає сторожем після реалізації.

- [ ] **Step 3: Write the implementation**

`extension/src/api/types.ts`:

```ts
export interface RawBeer {
  brewery: string;
  name: string;
  abv?: number;
  /** #633: Untappd id, який крамниця публікує на сторінці товару. */
  bid?: number;
  /** #633: бренд із тієї ж сторінки — доказ броварні, проти якого сервер перевіряє bid. */
  brand?: string;
}
```

`extension/src/content/index.ts`, у побудові `rawMisses` (там, де вже рахується `abv`):

```ts
      .map(({ el, key, card }) => {
        const abv = usableAbv(card.abv);
        // #633: bid і brand їдуть у /match разом, або не їдуть зовсім: без bid бренд серверу
        // нічого не доводить, а без brand сервер bid не приймає.
        const published = card.bid !== undefined
          ? { bid: card.bid, ...(card.brand !== undefined ? { brand: card.brand } : {}) }
          : {};
        return {
          el,
          key,
          raw: abv !== undefined
            ? { brewery: card.brewery, name: card.name, abv, ...published }
            : { brewery: card.brewery, name: card.name, ...published },
          card,
          ...(abv !== undefined ? { abv } : {}),
        };
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd extension && npx vitest run src/content/index.test.ts`
Expected: обидва тести зелені, решта файлу — без змін.

- [ ] **Step 5: Prove the tests by mutation**

- прибрати `...published` з обох гілок `raw` → падає перший тест;
- зробити `published` безумовним (`{ bid: card.bid, brand: card.brand }`) → падає другий тест (`brand` без `bid`, плюс `bid: undefined` у payload).
Повернути код після кожної.

- [ ] **Step 6: Both gates**

Run: `cd extension && npm test && npm run typecheck`, далі з кореня `npm test && npm run typecheck`.
Expected: усе зелене.

- [ ] **Step 7: Commit**

```bash
git commit extension/src/api/types.ts extension/src/content/index.ts extension/src/content/index.test.ts -m "feat(#633): the card sends the shop-published bid and brand to /match"
```

---

### Task 2: Рядок у чейнджлозі

**Files:**
- Modify: `extension/CHANGELOG.md` (секція `## [Unreleased]`)

- [ ] **Step 1: Add one user-facing line**

Дописати **першим** рядком у `## [Unreleased]` (він найцінніший для читача з трьох):

```markdown
- Beers whose shop page links to Untappd now get the right beer straight away — the badge shows that beer's rating and whether you have had it. Previously some of these showed no badge, a ⚪, or another beer by the same brewery.
```

Чого в цьому рядку **не** має бути: слів `bid`, `/match`, «гейт», «аліас», назв файлів. Перевір за шапкою `CHANGELOG.md`.

- [ ] **Step 2: Check the neighbours**

Перечитати два наявні рядки `[Unreleased]` очима користувача: обидва називають видиму зміну (бейдж для Imperial Stout і вінтажів; червоний ✕ для не-пива) — лишити як є.

- [ ] **Step 3: Commit**

```bash
git commit extension/CHANGELOG.md -m "docs(#633): changelog — a shop that links to Untappd now gets the right beer"
```

---

### Task 3: Речення в обидві інструкції

Зміна видима користувачу (бейджі з'являються там, де їх не було), тож правило проєкту вимагає оновити `docs/extension-install-uk.md` **і** `docs/extension-install-en.md` у цьому ж PR. Легенда ❓/⭐ лишається правдивою — міняти рядки таблиці не треба; додаємо одне речення про джерело збігу.

**Files:**
- Modify: `docs/extension-install-uk.md` (нотатка під таблицею бейджів, поруч із рядком ~215)
- Modify: `docs/extension-install-en.md` (та сама нотатка, рядок ~218)

- [ ] **Step 1: UK**

Додати в нотатку під таблицею:

```markdown
> Якщо сторінка товару в магазині сама посилається на Untappd, розширення бере це посилання:
> тоді бейдж показує саме те пиво, навіть коли магазин написав назву інакше. Коли посилання
> суперечить броварні, яку називає сам магазин, бейдж стає обережним (**❓**/**⭐**) — перевір
> кліком.
```

- [ ] **Step 2: EN**

```markdown
> When a shop's product page links to Untappd itself, the extension follows that link, so the
> badge shows exactly that beer even if the shop spells the name differently. When the link
> disagrees with the brewery the shop names, the badge stays cautious (**❓**/**⭐**) — click it
> to check.
```

- [ ] **Step 3: Verify both guides say the same thing**

Run: `diff <(grep -c '' docs/extension-install-uk.md) <(grep -c '' docs/extension-install-en.md)` — не для рівності рядків, а щоб не забути жодну з двох (EN відставала на 0.18.0, [[project_extension_0_18]]).
Перечитати обидва абзаци поруч.

- [ ] **Step 4: Commit**

```bash
git commit docs/extension-install-uk.md docs/extension-install-en.md -m "docs(#633): both install guides explain badges that come from the shop's own Untappd link"
```

---

### Task 4: PR і реліз 0.19.0 (операційне, після мерджу)

- [ ] **Step 1: Rebase before the PR**

```bash
git fetch origin main
git rebase origin/main
npm test && npm run typecheck
cd extension && npm test && npm run typecheck
```
Якщо `git fetch` падає з `GitHub is temporarily limiting some unauthenticated downloads` — це #583; робоча форма з `Authorization`-заголовком описана в CLAUDE.md.

- [ ] **Step 2: Push and open the PR**

```bash
git push --force-with-lease -u origin feat/633-match-published-bid
gh pr create --title "..." --body "..."
```
Тіло PR: що змінилося, вимір (18 карток зі 98 на живій сторінці), відома ціна (Cherry Pie), перевірка після релізу. Останній рядок — `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: AI-рев'ю PR**

Дочекатися рев'ю, перевірити **кожне** зауваження проти коду, на хибні — відповісти з доказом. Зелені тести ≠ готово.

- [ ] **Step 4: Мердж робить користувач**

Ніколи `gh pr merge` самостійно. Повідомити «готове до мерджу» і чекати.

- [ ] **Step 5: Реліз після мерджу** (`docs/extension-release.md`)

Порядок критичний: **спершу мердж**, бо анонс #379 будує сторінку чейнджлогу з `main`.
1. `extension/package.json` → `0.19.0`;
2. `## [Unreleased]` → `## [0.19.0] - 2026-09-DD`, перечитати всі три рядки очима користувача;
3. лістинг у дашборді CWS не змінюється (нових магазинів і дозволів немає) — крок 3 інструкції пропускається;
4. `npm run release:store`.

- [ ] **Step 6: Перевірка після релізу**

- `journalctl -u warsaw-beer-bot | grep 'match fallback stats'` — у рядку має з'явитися `bid` з ненульовим `sent`, а частка `conflict` бути порівнянною з пробою;
- `enrich: shop-published bid rejected` для Teréna / Mad Brew → pHormula має перестати надходити від оновлених клієнтів;
- жива сторінка Flasker: 18 карток із доказу 1 отримують рядок свого bid.
