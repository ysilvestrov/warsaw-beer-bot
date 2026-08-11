# #399 «Поза Польщею» — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дати extension-only користувачам псевдо-місто `outside-pl` («поза Польщею») як дефолт: місто-залежні команди відповідають підказкою й не виконуються, `/help` їх не показує.

**Architecture:** Псевдо-місто живе **поза** `CITIES` (той самий масив живить краулер `refreshOntap`), тому джоба фізично не може смикнути `ontap.pl/outside-pl`. Дозвіл на місто-залежні команди = `isKnownCity(getUserCity(...))`. Гейт — один Composer, зареєстрований першим у `bot.use(...)`; список команд він бере з `COMMAND_CATALOG` за прапорцем `cityScoped`, тим самим, за яким `/help` їх ховає.

**Tech Stack:** Node.js + TypeScript, Telegraf (Composer/`.command()`), better-sqlite3, Vitest (`globals: true`, тому `describe/test/expect` без імпорту), i18n — власний словниковий перекладач (`src/i18n`).

**Spec:** `docs/superpowers/specs/2026-08/2026-08-11-399-outside-poland-city-design.md`

**Загальні правила для кожної задачі:**
- Тести ганяти точково: `npx vitest run <шлях-до-файлу>`; наприкінці задачі — `npm test` не обов'язково, але після Task 9 обов'язково `npm test && npm run typecheck`.
- Коміт після кожної задачі. Репозиторій має бути зелений (`npm test`) на **кожному** коміті.
- Мова коментарів у коді — англійська (як у решті репо).

---

### Task 1: Домен — `OUTSIDE_CITY` + `isSelectableCity`

**Files:**
- Modify: `src/domain/cities.ts`
- Test: `src/domain/cities.test.ts`

- [ ] **Step 1: Написати падаючі тести**

Дописати в кінець `describe('cities', ...)` у `src/domain/cities.test.ts` (і додати `OUTSIDE_CITY, isSelectableCity` до вже наявного імпорту з `./cities` у першому рядку файлу):

```ts
  test('OUTSIDE_CITY is selectable but is NOT a crawlable ontap city', () => {
    // CITIES is what refreshOntap iterates over — the pseudo-city must never leak in,
    // or the crawler would fetch ontap.pl/outside-pl.
    expect(CITIES.some((c) => c.slug === OUTSIDE_CITY)).toBe(false);
    expect(isKnownCity(OUTSIDE_CITY)).toBe(false);
    expect(isSelectableCity(OUTSIDE_CITY)).toBe(true);
  });

  test('isSelectableCity accepts real cities and rejects unknown slugs', () => {
    expect(isSelectableCity('warszawa')).toBe(true);
    expect(isSelectableCity('szczecin')).toBe(true);
    expect(isSelectableCity('atlantis')).toBe(false);
    expect(isSelectableCity('')).toBe(false);
  });
```

- [ ] **Step 2: Запустити тест — має впасти**

Run: `npx vitest run src/domain/cities.test.ts`
Expected: FAIL — TS/рантайм помилка про те, що `OUTSIDE_CITY` / `isSelectableCity` не експортуються з `./cities`.

- [ ] **Step 3: Реалізація**

У `src/domain/cities.ts` **після** `export const DEFAULT_CITY = 'warszawa';` додати:

```ts
// Pseudo-city for users who are not in Poland (extension-only users, #399).
// Deliberately NOT in CITIES: that array is also the crawl list for refreshOntap,
// and `outside-pl` is not an ontap.pl path segment.
export const OUTSIDE_CITY = 'outside-pl';
```

І **після** `isKnownCity` додати:

```ts
// A slug the user is allowed to pick in /city: a real ontap city, or the pseudo-city.
// `isKnownCity` stays the narrower predicate — it also answers "are city-scoped
// commands available for this user?".
export function isSelectableCity(slug: string): boolean {
  return isKnownCity(slug) || slug === OUTSIDE_CITY;
}
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `npx vitest run src/domain/cities.test.ts`
Expected: PASS (5 тестів).

- [ ] **Step 5: Коміт**

```bash
git add src/domain/cities.ts src/domain/cities.test.ts
git commit -m "feat(#399): add the outside-pl pseudo-city to the cities domain"
```

---

### Task 2: Сховище — фолбек `getUserCity` на `OUTSIDE_CITY`, прибрати `DEFAULT_CITY`

Міграції БД **немає**: `user_profiles.city` уже nullable, тож наявні профілі з `NULL` просто починають читатися як `outside-pl`.

**Files:**
- Modify: `src/storage/user_profiles.ts:3`, `src/storage/user_profiles.ts:29-35`
- Modify: `src/domain/cities.ts` (видалити `DEFAULT_CITY`)
- Test: `src/storage/user-city.test.ts`, `src/domain/cities.test.ts`

- [ ] **Step 1: Переписати тести під нову поведінку**

Замінити **весь вміст** `src/storage/user-city.test.ts` на:

```ts
import { describe, test, expect } from 'vitest';
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile, getUserCity, setUserCity } from './user_profiles';
import { OUTSIDE_CITY } from '../domain/cities';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('User city storage', () => {
  test('getUserCity returns OUTSIDE_CITY when unset (#399: new/extension-only users)', () => {
    const db = fresh();
    ensureProfile(db, 1);
    expect(getUserCity(db, 1)).toBe(OUTSIDE_CITY);
  });

  test('setUserCity round-trips a known city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUserCity(db, 1, 'krakow');
    expect(getUserCity(db, 1)).toBe('krakow');
  });

  test('setUserCity round-trips the pseudo-city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    setUserCity(db, 1, OUTSIDE_CITY);
    expect(getUserCity(db, 1)).toBe(OUTSIDE_CITY);
  });

  test('an unknown stored slug degrades to OUTSIDE_CITY, not to someone else’s city', () => {
    const db = fresh();
    ensureProfile(db, 1);
    db.prepare("UPDATE user_profiles SET city = 'atlantis' WHERE telegram_id = 1").run();
    expect(getUserCity(db, 1)).toBe(OUTSIDE_CITY);
  });
});
```

У `src/domain/cities.test.ts` видалити тест `'DEFAULT_CITY is one of the configured cities'` цілком і прибрати `DEFAULT_CITY` з імпорту в першому рядку.

- [ ] **Step 2: Запустити тести — мають впасти**

Run: `npx vitest run src/storage/user-city.test.ts`
Expected: FAIL — `expected 'warszawa' to be 'outside-pl'` у першому й четвертому тестах.

- [ ] **Step 3: Реалізація**

У `src/storage/user_profiles.ts` рядок 3 замінити на:

```ts
import { OUTSIDE_CITY, isSelectableCity } from '../domain/cities';
```

і тіло `getUserCity` (рядки 29–35) на:

```ts
export function getUserCity(db: DB, telegramId: number): string {
  const row = db
    .prepare('SELECT city FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { city: string | null } | undefined;
  const v = row?.city;
  // NULL (never chose a city) and any stale/unknown slug both mean "outside Poland":
  // showing a stranger's Warszawa would be worse than showing nothing (#399).
  return v != null && isSelectableCity(v) ? v : OUTSIDE_CITY;
}
```

У `src/domain/cities.ts` видалити рядок `export const DEFAULT_CITY = 'warszawa';`.

- [ ] **Step 4: Перевірити, що інших споживачів `DEFAULT_CITY` не лишилось**

Run: `grep -rn "DEFAULT_CITY" src scripts spec.md`
Expected: жодного влучання в `src/` та `scripts/` (у `spec.md` влучання лишаються — їх правимо в Task 9).

- [ ] **Step 5: Запустити тести — мають пройти**

Run: `npx vitest run src/storage/user-city.test.ts src/domain/cities.test.ts && npm run typecheck`
Expected: PASS обидва файли; typecheck без помилок.

- [ ] **Step 6: Коміт**

```bash
git add src/storage/user_profiles.ts src/storage/user-city.test.ts src/domain/cities.ts src/domain/cities.test.ts
git commit -m "feat(#399): default an unset user city to outside-pl"
```

---

### Task 3: i18n — три нові ключі в трьох локалях

**Files:**
- Modify: `src/i18n/types.ts` (біля `'city.prompt'` / `'city.changed'`, ~рядки 29-30)
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`
- Test: `src/i18n/index.test.ts`

- [ ] **Step 1: Написати падаючий тест**

Дописати в `describe('createTranslator', ...)` у `src/i18n/index.test.ts`:

```ts
  test('#399 outside-Poland strings resolve in all three locales', () => {
    expect(createTranslator('uk')('city.outside')).toBe('🌍 Поза Польщею');
    expect(createTranslator('pl')('city.outside')).toBe('🌍 Poza Polską');
    expect(createTranslator('en')('city.outside')).toBe('🌍 Outside Poland');
    for (const loc of ['uk', 'pl', 'en'] as const) {
      expect(createTranslator(loc)('city.blocked')).toContain('/city');
      expect(createTranslator(loc)('help.city_hint')).toContain('/city');
    }
  });
```

- [ ] **Step 2: Запустити тест — має впасти**

Run: `npx vitest run src/i18n/index.test.ts`
Expected: FAIL — TS-помилка «Argument of type '"city.outside"' is not assignable to parameter of type 'keyof Messages'».

- [ ] **Step 3: Реалізація — типи**

У `src/i18n/types.ts` після рядка `'city.changed': string;                // {name}` додати:

```ts
  'city.outside': string;                // #399 label of the outside-pl pseudo-city
  'city.blocked': string;                // #399 reply when a city-scoped command is blocked
  'help.city_hint': string;              // #399 /help footer for outside-pl users
```

- [ ] **Step 4: Реалізація — локалі**

У `src/i18n/locales/uk.ts` після рядка `'city.changed': '✅ Місто змінено на {name}.',` додати:

```ts
  'city.outside': '🌍 Поза Польщею',
  'city.blocked': 'Ця команда працює лише для міст Польщі. Обери місто: /city',
  'help.city_hint':
    'Ще кілька команд (паби, маршрут, топ пив) стануть доступними після вибору міста — /city',
```

У `src/i18n/locales/pl.ts` — після відповідного `'city.changed'`:

```ts
  'city.outside': '🌍 Poza Polską',
  'city.blocked': 'Ta komenda działa tylko dla miast w Polsce. Wybierz miasto: /city',
  'help.city_hint':
    'Kilka dodatkowych komend (puby, trasa, top piw) pojawi się po wyborze miasta — /city',
```

У `src/i18n/locales/en.ts` — після відповідного `'city.changed'`:

```ts
  'city.outside': '🌍 Outside Poland',
  'city.blocked': 'This command only works for cities in Poland. Pick a city: /city',
  'help.city_hint':
    'A few more commands (pubs, route, top beers) unlock once you pick a city — /city',
```

- [ ] **Step 5: Запустити тест — має пройти**

Run: `npx vitest run src/i18n/ && npm run typecheck`
Expected: PASS; typecheck без помилок (він же й гарантує, що жодна локаль не забула ключ).

- [ ] **Step 6: Коміт**

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts src/i18n/index.test.ts
git commit -m "feat(#399): add outside-Poland i18n strings"
```

---

### Task 4: `cityDisplayLabel` — локалізована мітка на бот-шарі

Домен лишається без i18n; перекладач живе тут.

**Files:**
- Create: `src/bot/city-label.ts`
- Test: `src/bot/city-label.test.ts` (create)

- [ ] **Step 1: Написати падаючий тест**

Створити `src/bot/city-label.test.ts`:

```ts
import { createTranslator } from '../i18n';
import { OUTSIDE_CITY } from '../domain/cities';
import { cityDisplayLabel } from './city-label';

test('real cities keep their static label, regardless of locale', () => {
  expect(cityDisplayLabel(createTranslator('uk'), 'warszawa')).toBe('Warszawa');
  expect(cityDisplayLabel(createTranslator('en'), 'krakow')).toBe('Kraków');
});

test('the pseudo-city label is translated', () => {
  expect(cityDisplayLabel(createTranslator('uk'), OUTSIDE_CITY)).toBe('🌍 Поза Польщею');
  expect(cityDisplayLabel(createTranslator('pl'), OUTSIDE_CITY)).toBe('🌍 Poza Polską');
  expect(cityDisplayLabel(createTranslator('en'), OUTSIDE_CITY)).toBe('🌍 Outside Poland');
});

test('an unknown slug is echoed, as cityLabel does', () => {
  expect(cityDisplayLabel(createTranslator('en'), 'atlantis')).toBe('atlantis');
});
```

- [ ] **Step 2: Запустити тест — має впасти**

Run: `npx vitest run src/bot/city-label.test.ts`
Expected: FAIL — «Failed to resolve import "./city-label"».

- [ ] **Step 3: Реалізація**

Створити `src/bot/city-label.ts`:

```ts
import type { Translator } from '../i18n/types';
import { OUTSIDE_CITY, cityLabel } from '../domain/cities';

// Single place that turns a stored city slug into user-facing text: real cities carry
// a static label from the domain, the pseudo-city is a translated string (#399).
export function cityDisplayLabel(t: Translator, slug: string): string {
  return slug === OUTSIDE_CITY ? t('city.outside') : cityLabel(slug);
}
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `npx vitest run src/bot/city-label.test.ts`
Expected: PASS (3 тести).

- [ ] **Step 5: Коміт**

```bash
git add src/bot/city-label.ts src/bot/city-label.test.ts
git commit -m "feat(#399): add cityDisplayLabel for localized city names"
```

---

### Task 5: `/status` показує локалізовану мітку міста

**Files:**
- Modify: `src/bot/commands/status-build.ts:3`, `src/bot/commands/status-build.ts:50`
- Test: `src/bot/commands/status-build.test.ts`

- [ ] **Step 1: Написати падаючий тест**

Дописати в `describe('buildStatusMessage', ...)` у `src/bot/commands/status-build.test.ts` (файл уже має локальні `t` і `base`; `base.city` — `'warszawa'`):

```ts
  it('renders the outside-Poland pseudo-city with its localized label (#399)', () => {
    const out = buildStatusMessage(t, { ...base, city: 'outside-pl' });
    expect(out).toContain('🌍 Outside Poland');
    expect(out).not.toContain('outside-pl');
  });
```

(У цьому файлі вже є `const t = createTranslator('en')` і `const base: StatusView` з `city: 'warszawa'` — нічого додатково готувати не треба.)

- [ ] **Step 2: Запустити тест — має впасти**

Run: `npx vitest run src/bot/commands/status-build.test.ts`
Expected: FAIL — у виводі буде сирий слаг `outside-pl`.

- [ ] **Step 3: Реалізація**

У `src/bot/commands/status-build.ts` замінити імпорт (рядок 3)

```ts
import { cityLabel } from '../../domain/cities';
```

на

```ts
import { cityDisplayLabel } from '../city-label';
```

і рядок 50

```ts
  lines.push(esc(t('status.city', { name: cityLabel(view.city) })));
```

на

```ts
  lines.push(esc(t('status.city', { name: cityDisplayLabel(t, view.city) })));
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `npx vitest run src/bot/commands/status-build.test.ts`
Expected: PASS (усі тести файлу, включно з наявними).

- [ ] **Step 5: Коміт**

```bash
git add src/bot/commands/status-build.ts src/bot/commands/status-build.test.ts
git commit -m "feat(#399): show the localized city label in /status"
```

---

### Task 6: клавіатура `/city` + збереження вибору

**Files:**
- Modify: `src/bot/keyboards.ts:15-23` (`cityKeyboard`)
- Modify: `src/bot/commands/city.ts`
- Test: `src/bot/commands/city.test.ts`

- [ ] **Step 1: Переписати тести файлу `src/bot/commands/city.test.ts`**

Замінити **весь вміст** на:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import { CITIES, OUTSIDE_CITY } from '../../domain/cities';
import { cityKeyboard } from '../keyboards';
import { applyCitySelection } from './city';

const t = createTranslator('en');

function flat(kb: ReturnType<typeof cityKeyboard>) {
  return kb.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
}

test('cityKeyboard marks the current city', () => {
  const all = flat(cityKeyboard(t, 'krakow'));
  expect(all.find((b) => b.callback_data === 'city:krakow')!.text).toBe('✓ Kraków');
  expect(all.find((b) => b.callback_data === 'city:warszawa')!.text).toBe('Warszawa');
});

test('the outside-Poland button is always the last row', () => {
  const rows = cityKeyboard(t, 'krakow').reply_markup.inline_keyboard as {
    callback_data: string;
  }[][];
  expect(rows).toHaveLength(CITIES.length + 1);
  expect(rows[rows.length - 1].map((b) => b.callback_data)).toEqual([`city:${OUTSIDE_CITY}`]);
});

test('the outside-Poland button carries the localized label and takes the ✓ when active', () => {
  const all = flat(cityKeyboard(t, OUTSIDE_CITY));
  expect(all.find((b) => b.callback_data === `city:${OUTSIDE_CITY}`)!.text)
    .toBe('✓ 🌍 Outside Poland');
  expect(all.find((b) => b.callback_data === 'city:warszawa')!.text).toBe('Warszawa');
  expect(flat(cityKeyboard(createTranslator('pl'), 'krakow'))
    .find((b) => b.callback_data === `city:${OUTSIDE_CITY}`)!.text).toBe('🌍 Poza Polską');
});

test('a known slug is stored, an unknown slug is ignored', () => {
  const db = openDb(':memory:'); migrate(db);
  ensureProfile(db, 7);
  expect(applyCitySelection(db, 7, 'krakow')).toBe(true);
  expect(getUserCity(db, 7)).toBe('krakow');
  expect(applyCitySelection(db, 7, 'atlantis')).toBe(false);
  expect(getUserCity(db, 7)).toBe('krakow');
});

test('the pseudo-city is a storable choice (#399)', () => {
  const db = openDb(':memory:'); migrate(db);
  ensureProfile(db, 8);
  expect(applyCitySelection(db, 8, 'krakow')).toBe(true);
  expect(applyCitySelection(db, 8, OUTSIDE_CITY)).toBe(true);
  expect(getUserCity(db, 8)).toBe(OUTSIDE_CITY);
});
```

- [ ] **Step 2: Запустити тести — мають впасти**

Run: `npx vitest run src/bot/commands/city.test.ts`
Expected: FAIL — `cityKeyboard` очікує 1 аргумент, а передано 2; і `applyCitySelection(db, 8, 'outside-pl')` повертає `false`.

- [ ] **Step 3: Реалізація — клавіатура**

У `src/bot/keyboards.ts`: додати до імпортів

```ts
import { CITIES, OUTSIDE_CITY } from '../domain/cities';
import { cityDisplayLabel } from './city-label';
```

(рядок `import { CITIES } from '../domain/cities';` замінюється першим із них), і замінити `cityKeyboard` на:

```ts
export const cityKeyboard = (t: Translator, current: string) =>
  Markup.inlineKeyboard(
    [...CITIES.map((c) => c.slug), OUTSIDE_CITY].map((slug) => [
      Markup.button.callback(
        slug === current
          ? `✓ ${cityDisplayLabel(t, slug)}`
          : cityDisplayLabel(t, slug),
        `city:${slug}`,
      ),
    ]),
  );
```

- [ ] **Step 4: Реалізація — команда**

У `src/bot/commands/city.ts` замінити рядки 5–6 на:

```ts
import { ensureProfile, setUserCity, getUserCity } from '../../storage/user_profiles';
import { isSelectableCity } from '../../domain/cities';
import { cityDisplayLabel } from '../city-label';
```

у `applyCitySelection` замінити `if (!isKnownCity(slug)) return false;` на `if (!isSelectableCity(slug)) return false;`, а обидва виклики `cityLabel(...)` — на `cityDisplayLabel(ctx.t, ...)`:

```ts
  await ctx.reply(ctx.t('city.prompt', { name: cityDisplayLabel(ctx.t, current) }), cityKeyboard(ctx.t, current));
```

```ts
  await ctx.editMessageText(ctx.t('city.changed', { name: cityDisplayLabel(ctx.t, slug) }));
```

Регекс екшена `/^city:([a-z-]+)$/` **не змінюється** — він уже приймає дефіс.

- [ ] **Step 5: Запустити тести — мають пройти**

Run: `npx vitest run src/bot/commands/city.test.ts src/bot/keyboards.test.ts && npm run typecheck`
Expected: PASS обидва файли; typecheck чистий (він і зловить будь-який інший виклик `cityKeyboard` зі старою сигнатурою).

- [ ] **Step 6: Коміт**

```bash
git add src/bot/keyboards.ts src/bot/commands/city.ts src/bot/commands/city.test.ts
git commit -m "feat(#399): offer outside-pl as the last /city choice"
```

---

### Task 7: каталог команд — прапорець `cityScoped` і фільтрація `/help`

**Files:**
- Modify: `src/bot/commands/catalog.ts`
- Modify: `src/bot/commands/help.ts`, `src/bot/commands/start.ts`
- Test: `src/bot/commands/catalog.test.ts`

- [ ] **Step 1: Написати падаючі тести**

У `src/bot/commands/catalog.test.ts` замінити наявний `describe('buildHelpText', ...)` на:

```ts
describe('buildHelpText', () => {
  test('allowed=true: intro + one line per command, each starting with /command', () => {
    const t = createTranslator('en');
    const text = buildHelpText(t, true);
    expect(text).toContain(t('help.intro'));
    for (const e of COMMAND_CATALOG) {
      expect(text).toContain(`/${e.command} — ${t(e.descKey)}`);
    }
    const cmdLines = text.split('\n').filter((l) => l.startsWith('/'));
    expect(cmdLines).toHaveLength(COMMAND_CATALOG.length);
    expect(text).not.toContain(t('help.city_hint'));
  });

  test('allowed=false: hides exactly the city-scoped commands and adds the hint (#399)', () => {
    const t = createTranslator('en');
    const text = buildHelpText(t, false);
    const scoped = COMMAND_CATALOG.filter((e) => e.cityScoped).map((e) => e.command);
    expect(scoped.sort()).toEqual(['beers', 'newbeers', 'pubs', 'refresh', 'route']);
    for (const c of scoped) expect(text).not.toContain(`/${c} —`);
    for (const e of COMMAND_CATALOG.filter((x) => !x.cityScoped)) {
      expect(text).toContain(`/${e.command} — ${t(e.descKey)}`);
    }
    const cmdLines = text.split('\n').filter((l) => l.startsWith('/'));
    expect(cmdLines).toHaveLength(COMMAND_CATALOG.length - scoped.length);
    expect(text).toContain(t('help.city_hint'));
  });
});
```

Також дописати в `describe('buildCommandMenu', ...)`:

```ts
  test('the native menu is unaffected by #399 — it still lists every command', () => {
    const menu = buildCommandMenu(createTranslator('uk'));
    expect(menu.map((c) => c.command)).toEqual(COMMAND_CATALOG.map((e) => e.command));
  });
```

- [ ] **Step 2: Запустити тести — мають впасти**

Run: `npx vitest run src/bot/commands/catalog.test.ts`
Expected: FAIL — TS: `buildHelpText` очікує 1 аргумент; `Property 'cityScoped' does not exist on type 'CommandEntry'`.

- [ ] **Step 3: Реалізація**

У `src/bot/commands/catalog.ts`:

```ts
export interface CommandEntry {
  command: string;
  descKey: keyof Messages;
  // #399: needs an active Polish city. Same flag feeds the /help filter and the
  // city gate (src/bot/commands/city-gate.ts) — one list, no drift.
  cityScoped?: true;
}
```

У `COMMAND_CATALOG` додати `cityScoped: true` рівно п'ятьом записам:

```ts
export const COMMAND_CATALOG: CommandEntry[] = [
  { command: 'newbeers', descKey: 'cmd.newbeers', cityScoped: true },
  { command: 'route', descKey: 'cmd.route', cityScoped: true },
  { command: 'pubs', descKey: 'cmd.pubs', cityScoped: true },
  { command: 'filters', descKey: 'cmd.filters' },
  { command: 'link', descKey: 'cmd.link' },
  { command: 'import', descKey: 'cmd.import' },
  { command: 'extension', descKey: 'cmd.extension' },
  { command: 'beers', descKey: 'cmd.beers', cityScoped: true },
  { command: 'refresh', descKey: 'cmd.refresh', cityScoped: true },
  { command: 'lang', descKey: 'cmd.lang' },
  { command: 'city', descKey: 'cmd.city' },
  { command: 'status', descKey: 'cmd.status' },
  { command: 'help', descKey: 'cmd.help' },
  { command: 'start', descKey: 'cmd.start' },
];
```

І `buildHelpText`:

```ts
// `allowed` = the user has an active Polish city. When false, city-scoped commands are
// hidden and replaced by a single hint line (#399).
export function buildHelpText(t: Translator, allowed: boolean): string {
  const entries = allowed ? COMMAND_CATALOG : COMMAND_CATALOG.filter((e) => !e.cityScoped);
  const lines = entries.map((e) => `/${e.command} — ${t(e.descKey)}`);
  const tail = allowed ? [] : ['', t('help.city_hint')];
  return [t('help.intro'), '', ...lines, ...tail].join('\n');
}
```

`buildCommandMenu` **не чіпати**.

- [ ] **Step 4: Оновити двох викликачів**

`src/bot/commands/help.ts` — повністю:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildHelpText } from './catalog';
import { isKnownCity } from '../../domain/cities';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';

export const helpCommand = new Composer<BotContext>();

helpCommand.command('help', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const allowed = isKnownCity(getUserCity(ctx.deps.db, ctx.from.id));
  await ctx.reply(buildHelpText(ctx.t, allowed));
});
```

`src/bot/commands/start.ts` — повністю:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';
import { isKnownCity } from '../../domain/cities';
import { buildHelpText } from './catalog';

export const startCommand = new Composer<BotContext>();

startCommand.command('start', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const allowed = isKnownCity(getUserCity(ctx.deps.db, ctx.from.id));
  await ctx.reply(buildHelpText(ctx.t, allowed));
});
```

- [ ] **Step 5: Запустити тести — мають пройти**

Run: `npx vitest run src/bot/commands/catalog.test.ts && npm run typecheck`
Expected: PASS; typecheck чистий.

- [ ] **Step 6: Коміт**

```bash
git add src/bot/commands/catalog.ts src/bot/commands/catalog.test.ts src/bot/commands/help.ts src/bot/commands/start.ts
git commit -m "feat(#399): hide city-scoped commands from /help without a city"
```

---

### Task 8: гейт міст-залежних команд

**Files:**
- Create: `src/bot/commands/city-gate.ts`
- Create: `src/bot/commands/city-gate.test.ts`
- Modify: `src/index.ts:185-186` (перший аргумент `bot.use(...)`)

- [ ] **Step 1: Написати падаючий тест**

Створити `src/bot/commands/city-gate.test.ts`:

```ts
import { vi } from 'vitest';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUserCity } from '../../storage/user_profiles';
import { createTranslator } from '../../i18n';
import { COMMAND_CATALOG } from './catalog';
import { CITY_SCOPED_COMMANDS, cityGateHandler } from './city-gate';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function ctxFor(db: ReturnType<typeof fresh>, telegramId: number) {
  const reply = vi.fn();
  const ctx = { deps: { db }, t: createTranslator('en'), from: { id: telegramId }, reply };
  return { ctx: ctx as never, reply };
}

test('the gated command list comes from the catalog flag', () => {
  expect([...CITY_SCOPED_COMMANDS].sort()).toEqual(['beers', 'newbeers', 'pubs', 'refresh', 'route']);
  expect(CITY_SCOPED_COMMANDS).toEqual(
    COMMAND_CATALOG.filter((e) => e.cityScoped).map((e) => e.command),
  );
});

test('a user with a Polish city passes through untouched', async () => {
  const db = fresh();
  ensureProfile(db, 1);
  setUserCity(db, 1, 'krakow');
  const { ctx, reply } = ctxFor(db, 1);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(reply).not.toHaveBeenCalled();
});

test('a user without a city is blocked and told how to fix it', async () => {
  const db = fresh();
  ensureProfile(db, 2); // city stays NULL → outside-pl
  const { ctx, reply } = ctxFor(db, 2);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledWith(createTranslator('en')('city.blocked'));
});

test('a user who explicitly picked outside-pl is blocked too', async () => {
  const db = fresh();
  ensureProfile(db, 3);
  setUserCity(db, 3, 'outside-pl');
  const { ctx, reply } = ctxFor(db, 3);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});

test('the gate creates a profile for a first-time user instead of throwing', async () => {
  const db = fresh(); // no ensureProfile
  const { ctx, reply } = ctxFor(db, 99);
  const next = vi.fn();

  await cityGateHandler(ctx, next);

  expect(next).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Запустити тест — має впасти**

Run: `npx vitest run src/bot/commands/city-gate.test.ts`
Expected: FAIL — «Failed to resolve import "./city-gate"».

- [ ] **Step 3: Реалізація**

Створити `src/bot/commands/city-gate.ts`:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { COMMAND_CATALOG } from './catalog';
import { isKnownCity } from '../../domain/cities';
import { ensureProfile, getUserCity } from '../../storage/user_profiles';

// Derived from the catalog so the gate and the /help filter can never disagree (#399).
export const CITY_SCOPED_COMMANDS: string[] = COMMAND_CATALOG
  .filter((e) => e.cityScoped)
  .map((e) => e.command);

// A command update always carries `from`; narrow it so the handler can be unit-tested
// with a plain object instead of a full Telegraf context.
type CommandCtx = BotContext & { from: NonNullable<BotContext['from']> };

// Blocks city-scoped commands for users who are "outside Poland" (or never picked a
// city). Passes everything else through by calling next().
export async function cityGateHandler(
  ctx: CommandCtx,
  next: () => Promise<void>,
): Promise<void> {
  ensureProfile(ctx.deps.db, ctx.from.id);
  if (isKnownCity(getUserCity(ctx.deps.db, ctx.from.id))) {
    await next();
    return;
  }
  await ctx.reply(ctx.t('city.blocked'));
}

export const cityGate = new Composer<BotContext>();

cityGate.command(CITY_SCOPED_COMMANDS, (ctx, next) => cityGateHandler(ctx as CommandCtx, next));
```

- [ ] **Step 4: Запустити тест — має пройти**

Run: `npx vitest run src/bot/commands/city-gate.test.ts`
Expected: PASS (5 тестів).

- [ ] **Step 5: Підключити гейт у боті**

У `src/index.ts` додати імпорт поруч із рештою імпортів команд (біля рядка 22):

```ts
import { cityGate } from './bot/commands/city-gate';
```

і зробити його **першим** аргументом наявного виклику `bot.use(...)` (рядок ~185), тобто:

```ts
  bot.use(
    cityGate,
    startCommand,
```

Решта аргументів лишається без змін — зокрема `createRefreshCommand(...)`, який стоїть останнім і теж має бути за гейтом.

- [ ] **Step 6: Перевірити порядок і збірку**

Run: `npm run typecheck && grep -n -A 3 "bot.use(" src/index.ts | head -12`
Expected: typecheck чистий; у виводі `cityGate` стоїть першим рядком усередині `bot.use(`.

- [ ] **Step 7: Коміт**

```bash
git add src/bot/commands/city-gate.ts src/bot/commands/city-gate.test.ts src/index.ts
git commit -m "feat(#399): gate city-scoped commands behind an active Polish city"
```

---

### Task 9: `spec.md` + зелений прогін усього

**Files:**
- Modify: `spec.md` (секції `/city` ~602–607, таблиця `user_profiles` ~323, багатомісто ~1201–1208, `/help`, `/status`)

- [ ] **Step 1: Знайти всі місця, що описують стару поведінку**

Run: `grep -n "DEFAULT_CITY\|warszawa\|isKnownCity\|бачать Варшаву" spec.md`
Expected: влучання щонайменше в рядках ~208, ~323, ~473, ~604–607, ~1208.

- [ ] **Step 2: Переписати секцію `/city`**

Замінити абзац секції `### /city — вибір активного міста` на:

```markdown
**`/city`.** Inline-клавіатура курованих міст + **останній пункт «поза Польщею»**
(`OUTSIDE_CITY = 'outside-pl'`, мітка локалізована — `city.outside`). Вибір зберігається
в `user_profiles.city` (валідація `isSelectableCity`; невідомий slug ігнорується).
Псевдо-міста **немає** в `CITIES`, тому краулер `refreshOntap` його ніколи не бачить.

Команди `/pubs`, `/route`, `/newbeers`, `/beers`, `/refresh` фільтрують паби за активним
містом (`getUserCity` → `listPubs(db, city)`) і закриті гейтом
(`src/bot/commands/city-gate.ts`): якщо `isKnownCity(getUserCity(...))` хибний — бот
відповідає `city.blocked` і не виконує команду. Список гейтованих команд походить з
прапорця `cityScoped` у `COMMAND_CATALOG` — з того самого, за яким `/help` їх ховає
(натомість дописує `help.city_hint`). Нативне меню Telegram лишається глобальним
per-locale і показує всі команди.

Усі, хто міста не обрав (вкл. наявних користувачів і тих, хто прийшов лише по
розширення), потрапляють у «поза Польщею», а не у Варшаву (#399). Каталог пива,
рейтинги, drunk-статус і розширення/`/match` лишаються глобальними
(міста-незалежними).
```

- [ ] **Step 3: Виправити таблицю `user_profiles` і секцію багатоміста**

У таблиці профілю (рядок ~323) замінити комірку

```
| `city` | TEXT | nullable (v14) | обране місто; `NULL` → `DEFAULT_CITY` (`'warszawa'`) |
```

на

```
| `city` | TEXT | nullable (v14) | обране місто; `NULL`/невідомий slug → `OUTSIDE_CITY` (`'outside-pl'`, #399) |
```

У секції багатоміста (рядок ~1208) замінити фрагмент
`та `user_profiles.city` (nullable; NULL → `DEFAULT_CITY`)` на
`та `user_profiles.city` (nullable; NULL → `OUTSIDE_CITY`, #399)`, і в описі
`refreshOntap` уточнити, що він проходить **лише** по `CITIES` (псевдо-міста там немає).

Рядок ~208 (`pubs.city` `NOT NULL DEFAULT 'warszawa'`) **не чіпати** — це SQL-дефолт
таблиці пабів, до профілю стосунку не має.

- [ ] **Step 4: Дописати про `/status` і `/help`**

У секції `/status` у переліку «Налаштування (завжди)» замінити «активне місто» на
«активне місто (локалізована мітка, вкл. «поза Польщею»)».

- [ ] **Step 5: Повний прогін**

Run: `npm test && npm run typecheck`
Expected: усі тести зелені, typecheck без помилок.

- [ ] **Step 6: Коміт**

```bash
git add spec.md
git commit -m "docs(#399): spec the outside-pl pseudo-city and the command gate"
```

---

## Ручна перевірка перед PR

- [ ] `npm test` — зелено.
- [ ] `npm run typecheck` — чисто.
- [ ] `grep -rn "DEFAULT_CITY" src scripts` — порожньо.
- [ ] `grep -rn "cityLabel(" src --include=*.ts | grep -v city-label` — лишаються тільки `src/domain/cities.ts` (визначення) і `src/domain/cities.test.ts`.
