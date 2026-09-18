# #648 Обвʼязка: перевести всі виклики на `renderState`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Зробити так, щоб кожна картка, якої розширення торкнулося, мала бейдж від моменту розбору сторінки й до кінцевого стану — і щоб жоден стан не гинув мовчки.

**Architecture:** Ядро (вже в гілці) дало `CardState`, `renderState` і `stateFromMatch`. Обвʼязка переводить на них `content/index.ts` і `content/enrich.ts`, розкладає `card.skip` по класах, видаляє пʼять старих сеттерів і оновлює документи. Ключове рішення: `enrich.ts` більше не малює бейджів — він повідомляє **події** дошуку, а перекладає їх у стан той, хто тримає початкову відповідь `/match`, тобто `index.ts`. Так уся мапа «що людина бачить» лишається в одному місці.

**Tech Stack:** TypeScript, Vitest + jsdom, content script розширення для Chrome.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-18-648-card-state-badges-design.md`

## Global Constraints

- **Порожньої картки не лишається ніде, крім `isNonBeerPage`.** Якщо після цієї зміни картка без бейджа — це дефект, а не стан.
- **Колір лише на галочці й зірці.** Решта — сіре або біле (вже реалізовано в `renderState`; не додавати кольорів у виклики).
- **`renderState` — єдиний спосіб намалювати бейдж.** Після Task 4 у `badge.ts` не лишається інших експортованих рендерів.
- **Кожен бейдж має `role="img"` і `aria-label`** — це вже властивість `renderState`, ламати її викликами не можна.
- **Тільки інлайнові стилі, жодного `<style>` і жодних `id` у документі крамниці.**
- **Повний гейт на кожну задачу:** `npm test && npm run typecheck` у корені **і** в `extension/`.
- **Документи одним PR:** `spec.md`, `docs/extension-install-uk.md` **і** `docs/extension-install-en.md`, `extension/CHANGELOG.md` користувацькою мовою.
- **Реліз спільний із #666 і #667.** Без #666 бейдж «не встигли» бреше (спека §7).

## Вхідні дані з рев'ю ядра

Наскрізне рев'ю (2026-09-18) лишило одну відкриту вимогу саме до цього плану:

> `stateFromMatch` віддає `queued` для кожної нерозвʼязаної картки, коли `enrichmentPossible` істинне. Але придатність відома лише після відповіді `/enrich/candidates`, а ліміт `MAX_SEARCHES_PER_PAGE` позиційний. Сьогодні `runEnrichment` для непридатних і залімітних карток не робить **нічого** — вони просто лишаються з тим, що намалював `/match`. У новій моделі вони застрягли б на «в черзі» назавжди.

Тому Task 2 зобовʼязаний **розвʼязати кожну картку, яку він узяв у чергу**: придатну — результатом пошуку, непридатну — вердиктом, залімітну — `deferred`.

---

### Task 1: `index.ts` — бейдж від розбору сторінки й до відповіді

**Files:**
- Modify: `extension/src/content/index.ts`
- Test: `extension/src/content/index.test.ts`

**Interfaces:**
- Consumes: `renderState`, `type CardState` з `./badge`; `stateFromMatch` з `./card-state`.
- Produces: `EnrichOrphans` дістає поле `state` у кожному елементі (див. Task 2); `runOverlay` більше не викликає `renderBadge`/`setNonBeer`.

- [ ] **Step 1: Write the failing tests**

У `extension/src/content/index.test.ts` додай `describe('#648 стан картки на всьому шляху')` з такими випадками (хелпери `cardEl`, `adapterFor` уже є у файлі; бейдж читай як `el.querySelector('[data-beerbadge]')`, іконку — як `[data-icon]`):

1. **«в черзі» ставиться до мережі.** `sendMatch` — проміс, який тест тримає нерозвʼязаним; після `runOverlay` (без `await`) кожна не-`nonBeer` картка має `[data-icon="ring"]`.
2. **«працюємо» поки летить `/match`.** Після того як тест дозволив адаптеру віддати картки, але до розвʼязання промісу `sendMatch`, іконка — `arc`.
3. **Кінцевий стан із відповіді.** Розвʼязаний `sendMatch` із рядком, що має `untappd_id`, дає `star`; `is_drunk: true` + `user_rating` — `check`.
4. **Падіння `/match` більше не мовчить.** `sendMatch` кидає — кожна некешована картка має `[data-icon="warn"]`, а не порожнечу. Перевір і `aria-label`.
5. **`nonBeer` одразу.** Картка з `nonBeer: true` має `[data-icon="cross"]` і ніколи не потрапляє в `sendMatch` (перевір аргумент виклику).
6. **Кешована картка малюється з кешу.** `getCached` віддає збіг — картка одразу `star`, `sendMatch` її не отримує.
7. **`enrichmentPossible` false, коли дошуку нема.** `runOverlay` без `enrich`: незматчена картка стає `search` (не `ring`).
8. **`enrichmentPossible` true, коли дошук є.** З `enrich`: та сама картка лишається `ring`, а `enrich` отримує її в списку.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd extension && npx vitest run src/content/index.test.ts`
Expected: FAIL — картки без бейджа, бо `runOverlay` малює лише після відповіді.

- [ ] **Step 3: Implement**

У `runOverlay`:

```ts
// #648: бейдж з'являється в ту мить, коли картку взято в роботу, а не коли прийшла
// відповідь. До цієї зміни порожня картка означала п'ятнадцять різних речей — зокрема
// два протилежні: «зараз буде» і «більше нічого не буде».
for (const card of cards) {
  if (card.nonBeer) {
    renderState(card.el, { kind: 'nonBeer' });
    markSeen(card.el);
    continue;
  }
  renderState(card.el, { kind: 'queued' });
}
```

цей прохід іде **до** `loadCardDetails` і до кеш-лукапу. Далі:

- кеш-хіт: `renderState(card.el, stateFromMatch(cached, { enrichmentPossible: false }))` — кешований результат уже кінцевий для цього проходу (#666 окремо вирішує, чи піде така картка в чергу);
- перед `await sendMatch(...)`: `for (const m of rawMisses) renderState(m.el, { kind: 'working' })`;
- у `catch` навколо `sendMatch`: `for (const m of rawMisses) renderState(m.el, { kind: 'failed', reason: 'network' })` — і **не** `return` мовчки;
- після відповіді: спершу порахуй список сиріт (наявна логіка `orphans`), потім для кожної картки
  `renderState(miss.el, stateFromMatch(result, { enrichmentPossible: orphanKeys.has(miss.key) }))`.

`orphanKeys` — `new Set(orphans.map((o) => o.key))`. Порядок важить: `enrichmentPossible` має бути відомий **до** малювання, інакше сирота на мить блимне як «не знайшли».

У кожен елемент `orphans` додай `state: stateFromMatch(result, { enrichmentPossible: false })` — це стан, яким картка стане, якщо дошук не дасть нічого кращого. Task 2 його використає.

- [ ] **Step 4: Run the tests and watch them pass**

- [ ] **Step 5: Mutation-prove**

| Мутація | Має впасти на |
|---|---|
| прибрати прохід «в черзі» | тест 1 |
| не малювати `working` перед `sendMatch` | тест 2 |
| у `catch` повернути мовчазний `return` | тест 4 |
| завжди `enrichmentPossible: true` | тест 7 |
| завжди `enrichmentPossible: false` | тест 8 |
| малювати `nonBeer` після `sendMatch` | тест 5 |

- [ ] **Step 6: Full gate; Step 7: Commit**

```bash
git add extension/src/content/index.ts extension/src/content/index.test.ts
git commit -m "feat(#648): a card carries a badge from the moment it is parsed, and a failed /match says so"
```

---

### Task 2: `enrich.ts` — події замість бейджів, і жодної картки без вердикту

**Files:**
- Modify: `extension/src/content/enrich.ts`, `extension/src/content/main.ts`
- Test: `extension/src/content/enrich.test.ts`

**Interfaces:**
- Consumes: `OrphanBeer` дістає поле `state: CardState` (з Task 1).
- Produces:
  ```ts
  export type EnrichEvent =
    | { kind: 'searching' }
    | { kind: 'found'; untappdId: number; ratingGlobal: number | null }
    | { kind: 'settled' }                       // дошук відповів: лишається стан із /match
    | { kind: 'deferred' }                      // не дивилися й цього разу не подивимось
    | { kind: 'failed'; reason: 'blocked' | 'network' };
  ```
  `EnrichDeps` втрачає `setSearching`/`setEnriched`/`setOrphan` і дістає `onEvent: (key: string, event: EnrichEvent) => void`.

- [ ] **Step 1: Write the failing tests**

У `extension/src/content/enrich.test.ts`:

1. **Кожна взята картка дістає вердикт.** 25 сиріт, усі `eligible`, `MAX_SEARCHES_PER_PAGE = 20`: перші 20 отримують `searching` і далі `found`/`settled`, решта 5 — рівно один `deferred`. Жодного ключа без завершальної події.
2. **Непридатна картка не висить у черзі.** `eligible: false` → рівно один `settled`, без `searching`.
3. **`not_found` → `settled`**, а не `deferred`: ми дивилися.
4. **`blocked` → `failed` з `reason: 'blocked'`.**
5. **`transient` → `failed` з `reason: 'network'`.**
6. **Виняток у `fetchSearch` → `failed`**, не `settled`.
7. **Обірвана драбина (`abandoned`) → `deferred`**: половину сходинки не пройдено, отже ми не дивилися до кінця.
8. **`found` несе bid і рейтинг.**

- [ ] **Step 2: Run and watch fail** — `deps.setSearching` тощо більше не існують.

- [ ] **Step 3: Implement**

У `runEnrichment` заміни три сеттери на `deps.onEvent(beer.key, …)` і **додай розвʼязання решти**:

```ts
const eligible = candidates.filter((c) => c.eligible);
// Картка, яку сервер не вважає вартою пошуку, вже має відповідь: вона просто не
// покращиться. Без цього рядка вона лишалася б на «в черзі» назавжди.
for (const cand of candidates) {
  if (cand.eligible) continue;
  const beer = byPair.get(pairKey(cand.brewery, cand.name));
  if (beer) deps.onEvent(beer.key, { kind: 'settled' });
}
```

а на виході з циклу — усе, до чого не дійшли:

```ts
for (const cand of eligible.slice(handled)) {
  const beer = byPair.get(pairKey(cand.brewery, cand.name));
  if (beer) deps.onEvent(beer.key, { kind: 'deferred' });
}
```

де `handled` — скільки придатних карток цикл справді обробив (рахуй окремо від `searches`: одна картка може коштувати двох пошуків).

У `main.ts` перекладай події в стани:

```ts
onEvent: (key, ev) => {
  const el = elByKey.get(key);
  const fallback = stateByKey.get(key);
  if (!el) return;
  switch (ev.kind) {
    case 'searching': return renderState(el, { kind: 'working' });
    case 'found': return renderState(el, {
      kind: 'found', drunk: false, mine: null, global: ev.ratingGlobal,
      unsure: false, untappdId: ev.untappdId,
      brewery: breweryByKey.get(key) ?? '', name: nameByKey.get(key) ?? '',
    });
    case 'settled': return renderState(el, fallback ?? { kind: 'missing', brewery: '', name: '', orphan: false });
    case 'deferred': return renderState(el, { kind: 'deferred' });
    case 'failed': return renderState(el, { kind: 'failed', reason: ev.reason });
  }
},
```

`stateByKey` наповнюється з поля `state`, яке Task 1 кладе в кожен елемент `orphans`.

**Відома межа, яку записати коментарем:** `found` після дошуку не знає, чи людина це пиво пила — `/enrich/result` статусу «пив» не несе. Тому картка до і після перезавантаження може виглядати по-різному. Це не регрес цього issue (так було завжди), і фіксить це #666, який навчить дошук оновлювати кеш.

- [ ] **Step 4: Run and watch pass**

- [ ] **Step 5: Mutation-prove**

| Мутація | Має впасти на |
|---|---|
| прибрати цикл `settled` для непридатних | тест 2 |
| прибрати цикл `deferred` для залишку | тест 1 |
| `blocked` віддавати як `settled` | тест 4 |
| `transient` віддавати як `settled` | тест 5 |
| `abandoned` віддавати як `settled` | тест 7 |
| не слати `searching` | тест 1 |

- [ ] **Step 6: Full gate; Step 7: Commit**

---

### Task 3: `card.skip` — три поняття по трьох класах

**Files:**
- Modify: `extension/src/content/index.ts`, `extension/src/sites/flasker.ts`, `extension/src/sites/funkyshop.ts`, `extension/src/sites/types.ts`
- Test: `extension/src/content/index.test.ts`, `extension/src/sites/flasker.test.ts`, `extension/src/sites/funkyshop.test.ts`

**Interfaces:**
- Produces: `Card` дістає `skipReason?: 'pending-detail' | 'unparsed'`; прапорець `skip` лишається (його читає потік), але сам по собі бейджа більше не визначає.

Спека §5.2 розклала `skip` на три випадки. Реалізація:

- `nonBeer` + `skip` (девʼять адаптерів) — `skip` там мертвий, бо `nonBeer` перевіряється першим. Нічого не міняти, лише прибрати зайвий прапорець у тих девʼятьох місцях і покрити тестом, що картка все одно `cross`.
- Flasker `requiresDetail` → `skipReason: 'pending-detail'`. Поки деталь летить — картка показує **`working`**. Якщо після `loadCardDetails` `skip` усе ще `true` і `skipReason === 'pending-detail'` — це провал мережі: **`failed`, `reason: 'network'`**.
- Flasker «заголовок не розібрався» і funkyshop «нема броварні» → `skipReason: 'unparsed'` → **`failed`, `reason: 'unparsed'`**.

- [ ] **Step 1: Write the failing tests** — по тесту на кожен із чотирьох рядків вище, плюс тест, що картка з `skipReason: 'pending-detail'`, якій деталь **прийшла**, доходить до `sendMatch` як звичайна.

- [ ] **Steps 2–7:** як у попередніх задачах; мутації — по одній на кожен `skipReason` і на гілку «деталь прийшла».

---

### Task 4: видалити старі сеттери

**Files:**
- Modify: `extension/src/content/badge.ts`, `extension/src/content/badge.test.ts`, `extension/src/content/main.ts`

Видалити `renderBadge`, `badgeFor`, `setOrphan`, `setNonBeer`, `setSearching`, `setEnriched`, `makeBadge` і їхні тести. `markSeen`, `isSeen`, `resetCard`, `BADGE_MARKER`, `SEEN_MARKER`, `attach`, `wireBadgeClicks` лишаються.

Перевірка, що нічого не забуто: `grep -rn "renderBadge\|setOrphan\|setNonBeer\|setSearching\|setEnriched" extension/src` має дати нуль рядків поза видаленим кодом. Типчек упіймає решту.

Разом із цим зникає й конфлікт, який рев'ю назвало: `setNonBeer` коротив на `existing.textContent === '✕'`, а бейдж `renderState` має порожній `textContent` — два рендери не мають жити поруч.

- [ ] Кроки: видалити → повний гейт → коміт `refactor(#648): delete the five badge setters the state model replaced`.

---

### Task 5: документи

**Files:**
- Modify: `spec.md`, `docs/extension-install-uk.md`, `docs/extension-install-en.md`, `extension/CHANGELOG.md`, `docs/superpowers/specs/2026-09/2026-09-18-648-card-state-badges-design.md`

- [ ] **`spec.md`** — §6.1 «Бейджі та збірка розширення»: замінити опис на дванадцять класів і правило кольору. Заодно прибрати з §6.1 вигадане слово «беври» (рядок 2802) — у проєкті пишемо «пиво». Оновити рядки 966, 1014, 1127, де названі `❓`/`⭐`/`⚪`.
- [ ] **Обидва гайди** — таблиця легенди (UK ~205–224, EN ~207–227) і згадки у вступі (UK 25–33, EN 25–32, 177). Діфити обидва в одному коміті: EN відстав на 0.18.0 саме тому, що його правили окремо.
- [ ] **`extension/CHANGELOG.md`** — один рядок користувацькою мовою, у термінах інтерфейсу. Наприклад: «Значки на картках тепер показують, що саме відбувається: картка чекає черги, перевіряється, знайдена, не знайдена або не встигла. Колір лишився тільки там, де він щось вирішує — чи ти вже пив це пиво і яка в нього оцінка. Невпевнений збіг тепер видно й на пиві, якого ти ще не пив.» Жодних `CardState`, `renderState` чи `aria-label`.
- [ ] **Документ дизайну** — §6: варіант `found` несе `brewery`/`name`; §4.3: підпис для непевного випитого — «Схоже, ти це пив»; §10: анонімний режим тепер каже «Ти це не пив» словами, а не лише гліфом.
- [ ] Повний гейт (документи його не ламають, але правило є правило) → коміт.

---

## Після обвʼязки

Рібейс на `origin/main`, повний гейт наново, PR, AI-рев'ю з перевіркою кожного коментаря. Мердж робить користувач. Реліз розширення — разом із #666 і #667.
