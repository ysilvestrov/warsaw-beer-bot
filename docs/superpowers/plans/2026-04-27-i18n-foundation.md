# i18n Foundation Implementation Plan (PR 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the i18n infrastructure (types, translator, plural selection, locale detection, middleware, DB column) and migrate every existing user-facing literal in the bot into a Ukrainian locale file — without changing the bot's runtime behavior. After this PR, every `ctx.reply` reads from `ctx.t(...)` and the codebase is one PR away from being multilingual.

**Architecture:** Hand-rolled TS module under `src/i18n/`. Type-safe `Messages` interface. `createTranslator(locale)` returns `(key, params) => string`. Plurals via Node's built-in `Intl.PluralRules`. A Telegraf middleware reads the user's stored language (or detects from `from.language_code`), populates `ctx.locale` + `ctx.t`. Pure formatters (`route-format`, `newbeers-format`) accept a `Translator` parameter so they remain unit-testable in isolation.

**Tech Stack:** TypeScript, better-sqlite3, Telegraf 4.x, Jest, Intl.PluralRules (Node ≥ 18).

**Scope (PR 1 only):**
- ✅ Plumbing: types, translator, plural infra, detect-locale, middleware, migration v3, storage helpers.
- ✅ Single locale (`uk`), populated verbatim from existing literals — byte-identical bot output.
- ✅ Plural infrastructure exists and is tested via synthetic fixture (no real plural key in `uk.ts` yet).
- ❌ `/lang` command — Phase 2.
- ❌ `pl` / `en` translations — Phase 2.
- ❌ `be` — Phase 3.

Reference spec: [`docs/superpowers/specs/2026-04-27-i18n-design.md`](../specs/2026-04-27-i18n-design.md).

---

## File Structure

**New files (PR 1):**

```
src/i18n/
├── types.ts                    # Locale, Messages, PluralForms, Translator
├── detect-locale.ts            # detectLocale(language_code) → Locale
├── detect-locale.test.ts
├── translator.ts               # createTranslator + interpolate + plural selection
├── translator.test.ts
├── format.ts                   # fmtAbv, fmtKm (locale-aware)
├── format.test.ts
├── index.ts                    # re-exports public API
└── locales/
    └── uk.ts                   # full Ukrainian dictionary

src/bot/middleware/
├── i18n.ts                     # Telegraf middleware: ctx.locale + ctx.t
└── i18n.test.ts
```

**Modified files (PR 1):**

```
src/storage/schema.ts                 # + migration v3
src/storage/schema.test.ts            # + assert pub_profiles.language exists
src/storage/user_profiles.ts          # + getUserLanguage / setUserLanguage
src/storage/user.test.ts              # + tests for new helpers
src/bot/index.ts                      # extend BotContext, register i18n middleware
src/bot/commands/start.ts             # ctx.t migration
src/bot/commands/link.ts              # ctx.t migration
src/bot/commands/import.ts            # ctx.t migration
src/bot/commands/newbeers.ts          # ctx.t migration (the empty fallback)
src/bot/commands/newbeers-format.ts   # take Translator parameter; locale-aware fmtAbv
src/bot/commands/newbeers-format.test.ts  # update to pass stub Translator
src/bot/commands/route.ts             # ctx.t migration
src/bot/commands/route-format.ts      # take Translator + Locale parameters
src/bot/commands/route-format.test.ts # update to pass stub Translator
src/bot/commands/refresh.ts           # ctx.t migration
src/bot/commands/filters.ts           # ctx.t migration
```

---

## Task 1: Migration v3 — `user_profiles.language`

**Files:**
- Modify: `src/storage/schema.ts:84` (add new migration object after version 2)
- Modify: `src/storage/schema.test.ts:15-16` (extend assertion)

- [ ] **Step 1: Add a failing test that asserts the language column exists**

Edit `src/storage/schema.test.ts`. Add a new test after the existing two:

```ts
it('migration v3 adds user_profiles.language column', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db
    .prepare("PRAGMA table_info(user_profiles)")
    .all() as { name: string; type: string; dflt_value: unknown }[];
  const lang = cols.find((c) => c.name === 'language');
  expect(lang).toBeDefined();
  expect(lang?.type).toBe('TEXT');
  expect(lang?.dflt_value).toBeNull();
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx jest src/storage/schema.test.ts
```

Expected: FAIL — `expect(lang).toBeDefined()` because the column doesn't exist yet.

- [ ] **Step 3: Add migration v3 in `src/storage/schema.ts`**

After the existing version-2 entry (which ends at the `pub_distances` block, around line 96), add:

```ts
  {
    version: 3,
    sql: `
      ALTER TABLE user_profiles ADD COLUMN language TEXT;
    `,
  },
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx jest src/storage/schema.test.ts
```

Expected: PASS — three tests pass (existing two + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(db): migration v3 — user_profiles.language nullable column"
```

---

## Task 2: Storage helpers `getUserLanguage` / `setUserLanguage`

**Files:**
- Modify: `src/storage/user_profiles.ts` (add two functions; the file currently ends at line 27)
- Modify: `src/storage/user.test.ts` (add tests)

These helpers depend on the `Locale` type from Task 3, but to keep tasks independent we'll narrow to a string union here and import the canonical `Locale` once Task 3 lands. Use a local string-union for now; Task 3 will replace it with an import.

- [ ] **Step 1: Write failing tests in `src/storage/user.test.ts`**

Append after the existing two tests:

```ts
import { getUserLanguage, setUserLanguage } from './user_profiles';

test('getUserLanguage returns null when nothing stored', () => {
  const db = fresh();
  ensureProfile(db, 42);
  expect(getUserLanguage(db, 42)).toBeNull();
});

test('getUserLanguage returns null when user has no profile row', () => {
  const db = fresh();
  expect(getUserLanguage(db, 999)).toBeNull();
});

test('setUserLanguage persists and getUserLanguage roundtrips', () => {
  const db = fresh();
  ensureProfile(db, 42);
  setUserLanguage(db, 42, 'uk');
  expect(getUserLanguage(db, 42)).toBe('uk');
  setUserLanguage(db, 42, 'pl');
  expect(getUserLanguage(db, 42)).toBe('pl');
});

test('getUserLanguage returns null when DB has unrecognized value', () => {
  const db = fresh();
  ensureProfile(db, 42);
  // Simulate manual DB tampering / future locale removed in downgrade.
  db.prepare('UPDATE user_profiles SET language = ? WHERE telegram_id = ?').run('xx', 42);
  expect(getUserLanguage(db, 42)).toBeNull();
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
npx jest src/storage/user.test.ts
```

Expected: FAIL — `getUserLanguage` / `setUserLanguage` not exported.

- [ ] **Step 3: Implement helpers in `src/storage/user_profiles.ts`**

Append after the existing `allProfiles` function:

```ts
const KNOWN_LOCALES = new Set(['uk', 'pl', 'en']);

export function getUserLanguage(db: DB, telegramId: number): 'uk' | 'pl' | 'en' | null {
  const row = db
    .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { language: string | null } | undefined;
  const v = row?.language;
  if (v == null) return null;
  return KNOWN_LOCALES.has(v) ? (v as 'uk' | 'pl' | 'en') : null;
}

export function setUserLanguage(db: DB, telegramId: number, lang: 'uk' | 'pl' | 'en'): void {
  db.prepare('UPDATE user_profiles SET language = ? WHERE telegram_id = ?').run(lang, telegramId);
}
```

(Task 3 will replace the inline string union with `Locale` from `src/i18n/types`.)

- [ ] **Step 4: Run tests and verify they pass**

```bash
npx jest src/storage/user.test.ts
```

Expected: PASS — six tests (existing two + four new).

- [ ] **Step 5: Commit**

```bash
git add src/storage/user_profiles.ts src/storage/user.test.ts
git commit -m "feat(storage): add getUserLanguage / setUserLanguage helpers"
```

---

## Task 3: Types module — `src/i18n/types.ts`

No tests needed: types are exercised by every downstream task.

**Files:**
- Create: `src/i18n/types.ts`
- Modify: `src/storage/user_profiles.ts` (replace inline union with `Locale` import)

- [ ] **Step 1: Create `src/i18n/types.ts`**

```ts
export type Locale = 'uk' | 'pl' | 'en';

export type PluralForms = {
  one?: string;
  few?: string;
  many?: string;
  other: string; // обов'язковий
};

export interface Messages {
  // app
  'app.start': string;
  'app.no_data_in_snapshot': string;

  // link
  'link.usage': string;
  'link.success': string;                // {username}

  // import
  'import.prompt': string;
  'import.unsupported_format': string;
  'import.too_large': string;
  'import.fetch_failed': string;
  'import.starting': string;
  'import.progress': string;             // {total}
  'import.done': string;                 // {total}, {format}
  'import.failed': string;               // {total}, {message}

  // newbeers
  'newbeers.empty': string;
  'newbeers.more_pubs_suffix': string;   // {extra}

  // route
  'route.preparing': string;             // {count}
  'route.matrix_progress': string;       // {cached}, {total}, {missing}
  'route.fill_missing': string;          // {done}, {total}
  'route.searching_tour': string;
  'route.failed': string;
  'route.header': string;                // {count}, {km}, {pubs}

  // refresh
  'refresh.cooldown': string;
  'refresh.starting': string;
  'refresh.done': string;
  'refresh.failed': string;

  // filters
  'filters.current': string;             // {styles}, {min_rating}
  'filters.styles_changed': string;      // {styles}
  'filters.rating_changed': string;      // {rating}
  'filters.reset_done': string;
}

export type Translator = (
  key: keyof Messages,
  params?: Record<string, string | number>,
) => string;
```

- [ ] **Step 2: Replace inline union in `src/storage/user_profiles.ts`**

Change lines that currently use `'uk' | 'pl' | 'en'` to use the imported type:

```ts
import type { Locale } from '../i18n/types';

const KNOWN_LOCALES = new Set<Locale>(['uk', 'pl', 'en']);

export function getUserLanguage(db: DB, telegramId: number): Locale | null {
  const row = db
    .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
    .get(telegramId) as { language: string | null } | undefined;
  const v = row?.language;
  if (v == null) return null;
  return (KNOWN_LOCALES as Set<string>).has(v) ? (v as Locale) : null;
}

export function setUserLanguage(db: DB, telegramId: number, lang: Locale): void {
  db.prepare('UPDATE user_profiles SET language = ? WHERE telegram_id = ?').run(lang, telegramId);
}
```

- [ ] **Step 3: Verify typecheck and tests still pass**

```bash
npx tsc --noEmit && npx jest src/storage/user.test.ts
```

Expected: clean tsc, six passing tests.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/types.ts src/storage/user_profiles.ts
git commit -m "feat(i18n): types module — Locale, Messages, PluralForms, Translator"
```

---

## Task 4: `detectLocale` (table-driven)

**Files:**
- Create: `src/i18n/detect-locale.ts`
- Create: `src/i18n/detect-locale.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/i18n/detect-locale.test.ts`:

```ts
import { detectLocale } from './detect-locale';

describe('detectLocale', () => {
  test.each([
    ['uk',     'uk'],
    ['uk-UA',  'uk'],
    ['UK',     'uk'],
    ['pl',     'pl'],
    ['pl-PL',  'pl'],
    ['en',     'en'],
    ['en-US',  'en'],
    ['en-GB',  'en'],
    // Belarusian goes to en in Phase 1; will return 'be' once Phase 3 ships.
    ['be',     'en'],
    ['be-BY',  'en'],
    // Russian explicitly maps to en — we don't impose UA on ru-locale users.
    ['ru',     'en'],
    ['ru-RU',  'en'],
    ['de',     'en'],
    ['fr',     'en'],
    ['',       'en'],
    [undefined,'en'],
  ])('%s → %s', (input, expected) => {
    expect(detectLocale(input as string | undefined)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx jest src/i18n/detect-locale.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `detectLocale`**

Create `src/i18n/detect-locale.ts`:

```ts
import type { Locale } from './types';

export function detectLocale(code: string | undefined): Locale {
  const lang = (code ?? '').toLowerCase().split('-')[0];
  if (lang === 'uk') return 'uk';
  if (lang === 'pl') return 'pl';
  // 'be' / 'ru' / 'en' / unknown / undefined — англійська.
  // Особливо явно: ru → en (не нав'язуємо UA росіянам).
  // Коли в Phase 3 додамо 'be', тут зʼявиться ще одна гілка.
  return 'en';
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx jest src/i18n/detect-locale.test.ts
```

Expected: PASS — 16 cases.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/detect-locale.ts src/i18n/detect-locale.test.ts
git commit -m "feat(i18n): detectLocale — Telegram language_code → Locale"
```

---

## Task 5: Translator core (interpolation + plain string keys)

**Files:**
- Create: `src/i18n/translator.ts`
- Create: `src/i18n/translator.test.ts`

This task ships `createTranslator(locale, dict)` for plain string keys with `{name}` interpolation. Plural support arrives in Task 6.

- [ ] **Step 1: Write failing tests**

Create `src/i18n/translator.test.ts`:

```ts
import { makeTranslatorFromDict } from './translator';
import type { Messages } from './types';

describe('translator (plain string keys)', () => {
  const dict: Pick<Messages, 'app.start' | 'link.success' | 'route.header'> = {
    'app.start': 'Hello, world',
    'link.success': 'Linked: {username}',
    'route.header': 'Found {count} beers, {km} km, {pubs} pubs',
  };
  const t = makeTranslatorFromDict('en', dict as Messages);

  test('returns a string verbatim when no params and no placeholders', () => {
    expect(t('app.start')).toBe('Hello, world');
  });

  test('interpolates a single named placeholder', () => {
    expect(t('link.success', { username: 'yuriy' })).toBe('Linked: yuriy');
  });

  test('interpolates multiple placeholders, preserving order', () => {
    expect(t('route.header', { count: 10, km: 4.7, pubs: 6 })).toBe(
      'Found 10 beers, 4.7 km, 6 pubs',
    );
  });

  test('leaves placeholder text in output when a param is missing', () => {
    expect(t('link.success', {})).toBe('Linked: {username}');
  });

  test('coerces number params to string', () => {
    expect(t('link.success', { username: 42 })).toBe('Linked: 42');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx jest src/i18n/translator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement plain-string translator**

Create `src/i18n/translator.ts`:

```ts
import type { Locale, Messages, PluralForms, Translator } from './types';

function interpolate(tmpl: string, params?: Record<string, string | number>): string {
  if (!params) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : `{${k}}`,
  );
}

export function makeTranslatorFromDict(_locale: Locale, dict: Messages): Translator {
  return (key, params) => {
    const raw = dict[key] as string | PluralForms;
    if (typeof raw === 'string') return interpolate(raw, params);
    // Plural — implemented in Task 6.
    throw new Error(`PluralForms not yet supported for key: ${String(key)}`);
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx jest src/i18n/translator.test.ts
```

Expected: PASS — 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/translator.ts src/i18n/translator.test.ts
git commit -m "feat(i18n): translator core — interpolation for plain string keys"
```

---

## Task 6: Translator plural support

**Files:**
- Modify: `src/i18n/translator.ts` (replace the `throw` with real logic)
- Modify: `src/i18n/translator.test.ts` (add plural tests)

- [ ] **Step 1: Write failing tests**

Append to `src/i18n/translator.test.ts`:

```ts
describe('translator (plurals)', () => {
  // Synthetic dict — PR 1 has no real plural keys in uk.ts yet.
  type PluralFixture = {
    'pubs.uk': PluralForms;
    'pubs.en': PluralForms;
  };
  const ukDict = {
    'pubs.uk': {
      one:  'паб у маршруті: {count}',
      few:  'паби у маршруті: {count}',
      many: 'пабів у маршруті: {count}',
      other:'пабів у маршруті: {count}',
    },
  } as unknown as Messages;
  const enDict = {
    'pubs.en': {
      one:   '{count} pub on the route',
      other: '{count} pubs on the route',
    },
  } as unknown as Messages;

  const ukT = makeTranslatorFromDict('uk', ukDict);
  const enT = makeTranslatorFromDict('en', enDict);

  test('UA selects "one" for count = 1', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 1 })).toBe('паб у маршруті: 1');
  });

  test('UA selects "few" for count = 3', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 3 })).toBe('паби у маршруті: 3');
  });

  test('UA selects "many" for count = 5', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 5 })).toBe('пабів у маршруті: 5');
  });

  test('UA selects "many" for count = 0 (Intl.PluralRules convention)', () => {
    expect(ukT('pubs.uk' as keyof Messages, { count: 0 })).toBe('пабів у маршруті: 0');
  });

  test('EN selects "one" for count = 1', () => {
    expect(enT('pubs.en' as keyof Messages, { count: 1 })).toBe('1 pub on the route');
  });

  test('EN selects "other" for count = 3', () => {
    expect(enT('pubs.en' as keyof Messages, { count: 3 })).toBe('3 pubs on the route');
  });

  test('falls back to "other" when the selected form is missing', () => {
    const partial = {
      'partial': { other: 'fallback' },
    } as unknown as Messages;
    const t = makeTranslatorFromDict('uk', partial);
    expect(t('partial' as keyof Messages, { count: 1 })).toBe('fallback');
  });
});
```

Add the `PluralForms` import at the top:

```ts
import type { PluralForms } from './types';
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx jest src/i18n/translator.test.ts
```

Expected: FAIL — `throw new Error('PluralForms not yet supported...')` from the placeholder branch.

- [ ] **Step 3: Implement plural selection**

Replace the `makeTranslatorFromDict` body in `src/i18n/translator.ts`:

```ts
export function makeTranslatorFromDict(locale: Locale, dict: Messages): Translator {
  const pr = new Intl.PluralRules(locale);
  return (key, params) => {
    const raw = dict[key] as string | PluralForms;
    if (typeof raw === 'string') return interpolate(raw, params);
    // PluralForms — pivot завжди params.count (стандарт ICU/i18next).
    const count = params?.count;
    const form = typeof count === 'number' ? pr.select(count) : 'other';
    const tmpl = raw[form] ?? raw.other;
    return interpolate(tmpl, params);
  };
}
```

- [ ] **Step 4: Run tests and verify all pass**

```bash
npx jest src/i18n/translator.test.ts
```

Expected: PASS — 12 cases (5 plain + 7 plural).

- [ ] **Step 5: Commit**

```bash
git add src/i18n/translator.ts src/i18n/translator.test.ts
git commit -m "feat(i18n): plural support via Intl.PluralRules"
```

---

## Task 7: Locale-aware formatters (`fmtAbv`, `fmtKm`)

**Files:**
- Create: `src/i18n/format.ts`
- Create: `src/i18n/format.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/i18n/format.test.ts`:

```ts
import { fmtAbv, fmtKm } from './format';

describe('fmtAbv', () => {
  test('null → empty', () => {
    expect(fmtAbv('uk', null)).toBe('');
    expect(fmtAbv('en', null)).toBe('');
  });

  test('uk uses comma decimal', () => {
    expect(fmtAbv('uk', 6.1)).toBe('  ·  6,1%');
  });

  test('pl uses comma decimal', () => {
    expect(fmtAbv('pl', 4.5)).toBe('  ·  4,5%');
  });

  test('en uses dot decimal', () => {
    expect(fmtAbv('en', 6.1)).toBe('  ·  6.1%');
  });

  test('integer ABV — no separator at all', () => {
    expect(fmtAbv('uk', 7.0)).toBe('  ·  7%');
    expect(fmtAbv('en', 7.0)).toBe('  ·  7%');
  });
});

describe('fmtKm', () => {
  test('uk uses comma + км', () => {
    expect(fmtKm('uk', 14400)).toBe('14,4 км');
  });

  test('pl uses comma + km', () => {
    expect(fmtKm('pl', 14400)).toBe('14,4 km');
  });

  test('en uses dot + km', () => {
    expect(fmtKm('en', 14400)).toBe('14.4 km');
  });

  test('rounds to one decimal', () => {
    expect(fmtKm('en', 12345)).toBe('12.3 km');
    expect(fmtKm('uk', 1050)).toBe('1,1 км');
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
npx jest src/i18n/format.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement formatters**

Create `src/i18n/format.ts`:

```ts
import type { Locale } from './types';

const COMMA_LOCALES: Set<Locale> = new Set(['uk', 'pl']);
const KM_UNIT: Record<Locale, string> = { uk: 'км', pl: 'km', en: 'km' };

export function fmtAbv(locale: Locale, abv: number | null): string {
  if (abv === null) return '';
  const rounded = Math.round(abv * 10) / 10;
  if (Number.isInteger(rounded)) return `  ·  ${rounded}%`;
  const txt = `${rounded}`;
  return `  ·  ${COMMA_LOCALES.has(locale) ? txt.replace('.', ',') : txt}%`;
}

export function fmtKm(locale: Locale, meters: number): string {
  const km = (meters / 1000).toFixed(1);
  const txt = COMMA_LOCALES.has(locale) ? km.replace('.', ',') : km;
  return `${txt} ${KM_UNIT[locale]}`;
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npx jest src/i18n/format.test.ts
```

Expected: PASS — 9 cases.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/format.ts src/i18n/format.test.ts
git commit -m "feat(i18n): locale-aware fmtAbv / fmtKm"
```

---

## Task 8: Populate `uk.ts` with all current literals + public API

**Files:**
- Create: `src/i18n/locales/uk.ts`
- Create: `src/i18n/index.ts` (re-exports)

This is mechanical: copy every user-facing string from existing commands into the dictionary, replacing inline values like `${total}` with `{total}` placeholders.

- [ ] **Step 1: Create `src/i18n/locales/uk.ts`**

```ts
import type { Messages } from '../types';

export const uk: Messages = {
  // app
  'app.start': [
    'Привіт! Я допоможу зібрати маршрут по варшавських пабах і випити щось нове.',
    '',
    '1) /link <untappd-username> — щоб підтягувати твої чекіни.',
    '2) /import — завантаж CSV-експорт зі свого Untappd для повного бекфілу історії.',
    '3) /newbeers — топ непитих пив на поточних кранах.',
    '4) /route N — маршрут, що покриває ≥ N непитих пив із мінімальною пішою відстанню.',
  ].join('\n'),
  'app.no_data_in_snapshot': 'Немає цікавих непитих пив у поточному snapshot.',

  // link
  'link.usage': 'Використання: /link <username> (або повний URL untappd.com/user/<username>)',
  'link.success': "✅ Прив'язано до untappd.com/user/{username}",

  // import
  'import.prompt':
    'Надішли експорт з Untappd: CSV, JSON або ZIP (до 20 MB).\n' +
    'Supporter → Account → Download History. Великий JSON краще запакувати в ZIP.',
  'import.unsupported_format': 'Формат не підтримується. Очікую .csv, .json або .zip.',
  'import.too_large':
    'Файл > 20 MB — Telegram не дасть боту його скачати. ' +
    'Запакуй JSON у ZIP (стискається ≈10×) і надішли ще раз.',
  'import.fetch_failed': 'Не вдалось отримати файл з Telegram.',
  'import.starting': '⏳ Починаю імпорт…',
  'import.progress': '⏳ Імпортовано {total}…',
  'import.done': '✅ Імпортовано {total} чекінів ({format}).',
  'import.failed': '❌ Помилка після {total} рядків: {message}',

  // newbeers
  'newbeers.empty': 'Нічого цікавого — спробуй /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} інших',

  // route
  'route.preparing': '⏳ Будую маршрут для ≥{count} нових пив…',
  'route.matrix_progress': '🗺 Матриця відстаней: {cached}/{total} з кешу, {missing} нових',
  'route.fill_missing': '🗺 Догружаю пари без кешу: {done}/{total}',
  'route.searching_tour': '🧠 Шукаю найкоротший обхід…',
  'route.failed': '❌ Не вдалось побудувати маршрут — подивись логи.',
  'route.header':
    'Знайдено маршрут для <b>{count}</b> (чи більше) нових пив, відстань ≈ <b>{km}</b>, пабів у маршруті: <b>{pubs}</b>.',

  // refresh
  'refresh.cooldown': '⏱ Занадто часто — спробуй за кілька хвилин.',
  'refresh.starting': '⏳ Оновлюю…',
  'refresh.done': '✅ Готово.',
  'refresh.failed': '❌ Не вдалось — подивись логи.',

  // filters
  'filters.current': 'Поточні: styles={styles}, min_rating={min_rating}',
  'filters.styles_changed': 'styles={styles}',
  'filters.rating_changed': 'min_rating={rating}',
  'filters.reset_done': 'Скинуто',
};
```

Note on `route.header`: previously the formatter built the string inline with literal "км". With locale-aware `fmtKm`, the `{km}` placeholder receives the already-formatted `"4,7 км"` (or `"4.7 km"` in EN). The template no longer hardcodes the unit.

- [ ] **Step 2: Create `src/i18n/index.ts` — public API**

```ts
import type { Locale, Messages, Translator } from './types';
import { makeTranslatorFromDict } from './translator';
import { uk } from './locales/uk';

const LOCALES: Record<Locale, Messages> = {
  uk,
  // PR 2: pl, en (so far they share the uk dict to keep the type happy).
  pl: uk,
  en: uk,
};

export function createTranslator(locale: Locale): Translator {
  return makeTranslatorFromDict(locale, LOCALES[locale]);
}

export type { Locale, Messages, Translator } from './types';
export { detectLocale } from './detect-locale';
export { fmtAbv, fmtKm } from './format';
```

The `pl: uk, en: uk` aliasing is a deliberate temporary hack so the `Record<Locale, Messages>` typechecks before PR 2 ships real PL/EN dicts. It is documented inline.

- [ ] **Step 3: Verify typecheck**

```bash
npx tsc --noEmit
```

Expected: clean — `Messages` interface is fully implemented by `uk` (TS will fail loudly if any key is missing).

- [ ] **Step 4: Verify all tests still pass**

```bash
npx jest
```

Expected: PASS — pre-existing tests + the i18n unit tests from Tasks 1–7.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/locales/uk.ts src/i18n/index.ts
git commit -m "feat(i18n): uk locale + public API surface"
```

---

## Task 9: Telegraf middleware (`src/bot/middleware/i18n.ts`)

**Files:**
- Create: `src/bot/middleware/i18n.ts`
- Create: `src/bot/middleware/i18n.test.ts`

This task introduces `i18nMiddleware`. Because it depends on `BotContext` having `locale` and `t` fields, **the `BotContext` extension is part of Task 10**; this middleware uses a structural-typed function signature in the meantime so it compiles without touching `bot/index.ts` yet.

- [ ] **Step 1: Write failing tests**

Create `src/bot/middleware/i18n.test.ts`:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile, setUserLanguage } from '../../storage/user_profiles';
import { i18nMiddleware } from './i18n';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

interface FakeCtx {
  from?: { id: number; language_code?: string };
  deps: { db: ReturnType<typeof fresh> };
  locale?: string;
  t?: (k: string) => string;
}

async function runMiddleware(ctx: FakeCtx): Promise<FakeCtx> {
  await i18nMiddleware(ctx as any, async () => {});
  return ctx;
}

describe('i18nMiddleware', () => {
  test('uses stored language from DB when present (ignores language_code)', async () => {
    const db = fresh();
    ensureProfile(db, 42);
    setUserLanguage(db, 42, 'pl');
    const ctx: FakeCtx = { from: { id: 42, language_code: 'uk' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('pl');
  });

  test('falls back to detectLocale when no row in DB and persists the result', async () => {
    const db = fresh();
    const ctx: FakeCtx = { from: { id: 7, language_code: 'pl-PL' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('pl');
    // Persisted: ensureProfile + setUserLanguage during the middleware run.
    const stored = db
      .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
      .get(7) as { language: string } | undefined;
    expect(stored?.language).toBe('pl');
  });

  test('ru language_code maps to en (and persists en)', async () => {
    const db = fresh();
    const ctx: FakeCtx = { from: { id: 8, language_code: 'ru' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('en');
    const stored = db
      .prepare('SELECT language FROM user_profiles WHERE telegram_id = ?')
      .get(8) as { language: string } | undefined;
    expect(stored?.language).toBe('en');
  });

  test('absent ctx.from (e.g. channel_post) falls back to en, no DB write', async () => {
    const db = fresh();
    const ctx: FakeCtx = { deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.locale).toBe('en');
    const rows = db.prepare('SELECT COUNT(*) as n FROM user_profiles').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test('exposes a working ctx.t', async () => {
    const db = fresh();
    const ctx: FakeCtx = { from: { id: 1, language_code: 'uk' }, deps: { db } };
    await runMiddleware(ctx);
    expect(ctx.t!('app.no_data_in_snapshot')).toBe('Немає цікавих непитих пив у поточному snapshot.');
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
npx jest src/bot/middleware/i18n.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the middleware**

Create `src/bot/middleware/i18n.ts`:

```ts
import type { MiddlewareFn } from 'telegraf';
import type { Locale } from '../../i18n/types';
import { createTranslator, detectLocale } from '../../i18n';
import {
  ensureProfile,
  getUserLanguage,
  setUserLanguage,
} from '../../storage/user_profiles';

// Loose ctx type — Task 10 widens BotContext to include locale + t.
type Ctx = {
  from?: { id: number; language_code?: string };
  deps: { db: import('../../storage/db').DB };
  locale?: Locale;
  t?: ReturnType<typeof createTranslator>;
};

export const i18nMiddleware: MiddlewareFn<Ctx> = async (ctx, next) => {
  const db = ctx.deps.db;
  const userId = ctx.from?.id;

  let locale: Locale;
  if (userId !== undefined) {
    const stored = getUserLanguage(db, userId);
    if (stored) {
      locale = stored;
    } else {
      locale = detectLocale(ctx.from?.language_code);
      // Persist so subsequent updates skip the detection round-trip and
      // /lang in PR 2 has a row to update.
      ensureProfile(db, userId);
      setUserLanguage(db, userId, locale);
    }
  } else {
    locale = 'en';
  }

  ctx.locale = locale;
  ctx.t = createTranslator(locale);
  await next();
};
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npx jest src/bot/middleware/i18n.test.ts
```

Expected: PASS — 5 cases.

- [ ] **Step 5: Commit**

```bash
git add src/bot/middleware/i18n.ts src/bot/middleware/i18n.test.ts
git commit -m "feat(bot): i18n middleware — ctx.locale + ctx.t with persisted detection"
```

---

## Task 10: Extend `BotContext` and register middleware

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Modify `src/bot/index.ts`**

Replace the entire file contents with:

```ts
import { Telegraf, Context } from 'telegraf';
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type { Locale, Translator } from '../i18n/types';
import { i18nMiddleware } from './middleware/i18n';

export interface AppDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
}

export interface BotContext extends Context {
  deps: AppDeps;
  locale: Locale;
  t: Translator;
}

export function createBot(deps: AppDeps): Telegraf<BotContext> {
  const bot = new Telegraf<BotContext>(deps.env.TELEGRAM_BOT_TOKEN);
  bot.use((ctx, next) => {
    ctx.deps = deps;
    return next();
  });
  bot.use(i18nMiddleware);
  bot.catch((err, ctx) => deps.log.error({ err, update: ctx.update }, 'bot error'));
  return bot;
}
```

Order matters: `deps`-injector first, then `i18nMiddleware` (which reads `ctx.deps.db`), then command handlers (registered later by the caller in `src/index.ts`).

- [ ] **Step 2: Verify typecheck and full test suite**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass. Note: **`ctx.locale` and `ctx.t` are declared on `BotContext` but no command uses them yet** — that's fine, no current code is broken.

- [ ] **Step 3: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat(bot): wire i18n middleware into BotContext + Telegraf chain"
```

---

## Task 11: Migrate `start.ts` to `ctx.t`

**Files:**
- Modify: `src/bot/commands/start.ts`

- [ ] **Step 1: Replace literal with `ctx.t`**

Edit `src/bot/commands/start.ts` to:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { ensureProfile } from '../../storage/user_profiles';

export const startCommand = new Composer<BotContext>();

startCommand.command('start', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  await ctx.reply(ctx.t('app.start'));
});
```

- [ ] **Step 2: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/start.ts
git commit -m "refactor(start): use ctx.t for welcome message"
```

---

## Task 12: Migrate `link.ts` to `ctx.t`

**Files:**
- Modify: `src/bot/commands/link.ts`

- [ ] **Step 1: Replace two literals with `ctx.t`**

Edit `src/bot/commands/link.ts`. Keep the imports and the `parseLinkArgs` function as-is. Replace the command body:

```ts
linkCommand.command('link', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ');
  const parsed = parseLinkArgs(arg);
  if (!parsed) {
    await ctx.reply(ctx.t('link.usage'));
    return;
  }
  ensureProfile(ctx.deps.db, ctx.from.id);
  setUntappdUsername(ctx.deps.db, ctx.from.id, parsed.username);
  await ctx.reply(ctx.t('link.success', { username: parsed.username }));
});
```

- [ ] **Step 2: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass (including the existing `parseLinkArgs` tests).

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/link.ts
git commit -m "refactor(link): use ctx.t for usage + success messages"
```

---

## Task 13: Migrate `import.ts` to `ctx.t`

**Files:**
- Modify: `src/bot/commands/import.ts`

- [ ] **Step 1: Replace eight literals with `ctx.t`**

Edit `src/bot/commands/import.ts`:

- The `/import` command body (line 22-26) becomes:
  ```ts
  importCommand.command('import', async (ctx) => {
    await ctx.reply(ctx.t('import.prompt'));
  });
  ```

- The `'document'` handler. Replace each literal in order:
  - `await ctx.reply('Формат не підтримується. Очікую .csv, .json або .zip.');`
    → `await ctx.reply(ctx.t('import.unsupported_format'));`
  - The 20 MB error: `await ctx.reply(ctx.t('import.too_large'));`
  - `'Не вдалось отримати файл з Telegram.'` → `ctx.t('import.fetch_failed')`
  - `'⏳ Починаю імпорт…'` → `ctx.t('import.starting')`
  - `\`⏳ Імпортовано ${total}…\`` → `ctx.t('import.progress', { total })`
  - `\`✅ Імпортовано ${total} чекінів (${format.toUpperCase()}).\`` →
    `ctx.t('import.done', { total, format: format.toUpperCase() })`
  - `\`❌ Помилка після ${total} рядків: ${(e as Error).message}\`` →
    `ctx.t('import.failed', { total, message: (e as Error).message })`

- [ ] **Step 2: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/import.ts
git commit -m "refactor(import): use ctx.t for all reply strings"
```

---

## Task 14: Migrate `newbeers.ts` + `newbeers-format.ts`

**Files:**
- Modify: `src/bot/commands/newbeers.ts`
- Modify: `src/bot/commands/newbeers-format.ts`
- Modify: `src/bot/commands/newbeers-format.test.ts`

`newbeers-format.formatGroupedBeers` currently embeds `' +{N} інших'`, `⭐` prefix, and the locale-agnostic ABV separator. We'll thread a `Translator` parameter (for the suffix) and a `Locale` (for ABV separator via `fmtAbv`). `fmtRating` and the `⭐ —` empty marker are universal — leave them.

- [ ] **Step 1: Update `newbeers-format.ts` to accept Translator + Locale**

Replace `formatGroupedBeers` and the `fmtAbv` re-export:

```ts
import type { Locale, Translator } from '../../i18n/types';
import { fmtAbv as fmtAbvLocale } from '../../i18n/format';

// (existing groupTaps, rankGroups, BeerGroup, CandidateTap stay as-is)

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const fmtRating = (r: number | null): string =>
  r === null ? '⭐ —' : `⭐ ${r.toFixed(2).replace(/\.?0+$/, '')}`;

// Re-export for callers that want the locale-aware abv formatter.
export { fmtAbvLocale as fmtAbv };

export function formatGroupedBeers(
  groups: BeerGroup[],
  locale: Locale,
  t: Translator,
  opts: { topN?: number; maxPubs?: number } = {},
): string {
  const { topN = 15, maxPubs = 3 } = opts;
  const lines: string[] = [];
  groups.slice(0, topN).forEach((g, i) => {
    const head = `${i + 1}. <b>${escapeHtml(g.display)}</b>  ${fmtRating(g.rating)}${fmtAbvLocale(locale, g.abv)}`;
    const shown = g.pubs.slice(0, maxPubs).map(escapeHtml).join(', ');
    const extra =
      g.pubs.length > maxPubs ? t('newbeers.more_pubs_suffix', { extra: g.pubs.length - maxPubs }) : '';
    lines.push(head, `     · ${shown}${extra}`);
  });
  return lines.join('\n');
}
```

Remove the old top-level `fmtAbv` constant — its replacement is now `fmtAbvLocale` re-exported under the same name.

- [ ] **Step 2: Update `newbeers-format.test.ts` to pass stub Translator + Locale**

Add at the top of the test file:

```ts
import type { Translator } from '../../i18n/types';

const stubT: Translator = (key, params) => {
  // Replicate the production string for keys this test cares about.
  if (key === 'newbeers.more_pubs_suffix') return ` +${params!.extra} інших`;
  return String(key);
};
```

Update every call to `formatGroupedBeers(groups, opts?)` → `formatGroupedBeers(groups, 'uk', stubT, opts?)`.

- [ ] **Step 3: Update `newbeers.ts` to pass locale + t**

Edit the command body. Replace the final two lines:

```ts
const text = formatGroupedBeers(rankGroups(groupTaps(candidates)), ctx.locale, ctx.t);
await ctx.replyWithHTML(text || ctx.t('newbeers.empty'));
```

- [ ] **Step 4: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass (including updated newbeers-format tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/newbeers.ts src/bot/commands/newbeers-format.ts src/bot/commands/newbeers-format.test.ts
git commit -m "refactor(newbeers): thread Translator + Locale through formatter"
```

---

## Task 15: Migrate `route.ts` + `route-format.ts`

**Files:**
- Modify: `src/bot/commands/route.ts`
- Modify: `src/bot/commands/route-format.ts`
- Modify: `src/bot/commands/route-format.test.ts`

`route-format.formatRouteResult` currently inlines `Знайдено маршрут для… {km} км…` and uses the legacy `fmtAbv` from newbeers-format. We thread `Locale` + `Translator` through and use `fmtKm` for the distance.

- [ ] **Step 1: Update `route-format.ts`**

Replace the entire file:

```ts
import type { Locale, Translator } from '../../i18n/types';
import { fmtKm, fmtAbv } from '../../i18n/format';
import { escapeHtml, fmtRating } from './newbeers-format';

export interface RouteBeerLine {
  display: string;       // "Brewery BeerName"
  rating: number | null;
  abv: number | null;
}

export interface RoutePubFormat {
  name: string;
  beers: RouteBeerLine[]; // already deduped + ranked by caller
}

export interface FormatRouteOpts {
  N: number;
  distanceMeters: number;
  pubsInOrder: RoutePubFormat[];
  locale: Locale;
  t: Translator;
}

export function formatRouteResult(opts: FormatRouteOpts): string {
  const { N, distanceMeters, pubsInOrder, locale, t } = opts;
  const km = fmtKm(locale, distanceMeters);
  const lines: string[] = [];
  lines.push(t('route.header', { count: N, km, pubs: pubsInOrder.length }));
  pubsInOrder.forEach((p, i) => {
    lines.push('');
    lines.push(`<b>${i + 1}. ${escapeHtml(p.name)}</b>`);
    for (const beer of p.beers) {
      lines.push(
        `     • <b>${escapeHtml(beer.display)}</b>  ${fmtRating(beer.rating)}${fmtAbv(locale, beer.abv)}`,
      );
    }
  });
  return lines.join('\n');
}
```

- [ ] **Step 2: Update `route-format.test.ts`**

Add a stub `Translator` and pass `locale: 'uk'` + `t: stubT` in every `formatRouteResult` call:

```ts
import type { Translator } from '../../i18n/types';

const stubT: Translator = (key, params) => {
  if (key === 'route.header') {
    return `Знайдено маршрут для <b>${params!.count}</b> (чи більше) нових пив, відстань ≈ <b>${params!.km}</b>, пабів у маршруті: <b>${params!.pubs}</b>.`;
  }
  return String(key);
};
```

For every existing test that calls `formatRouteResult({ N, distanceMeters, pubsInOrder })`, add `, locale: 'uk', t: stubT` to the options.

**Assertion update for the distance test.** Previously `route-format.ts` called the legacy `fmtAbv`-sibling that produced `'14.4 км'` (dot). With `fmtKm('uk', ...)` the separator is now a comma (UA convention). Update these two asserts:

- `expect(firstLine).toContain('14.4 км')` → `expect(firstLine).toContain('14,4 км')`
- `expect(out).toContain('12.3 км')` → `expect(out).toContain('12,3 км')`

The header-phrasing test (`'header uses requested phrasing'`) keeps all its other `toContain` checks unchanged.

- [ ] **Step 3: Update `route.ts`**

Replace the progress-rendering block and the final formatting block.

Find this section in the detached promise (currently around lines 113–117):
```ts
await notify(
  `🗺 Матриця відстаней: ${cachedCount}/${totalPairs} з кешу, ${missing.length} нових`,
  { force: true },
);
```
Replace with:
```ts
await notify(
  ctx.t('route.matrix_progress', { cached: cachedCount, total: totalPairs, missing: missing.length }),
  { force: true },
);
```

Similarly:
- `'Немає цікавих непитих пив у поточному snapshot.'` → `ctx.t('app.no_data_in_snapshot')`
- `\`⏳ Будую маршрут для ≥${N} нових пив…\`` → `ctx.t('route.preparing', { count: N })`
- `\`🗺 Догружаю пари без кешу: ${done}/${missing.length}\`` → `ctx.t('route.fill_missing', { done, total: missing.length })`
- `'🧠 Шукаю найкоротший обхід…'` → `ctx.t('route.searching_tour')`
- `'❌ Не вдалось побудувати маршрут — подивись логи.'` → `ctx.t('route.failed')`

The final formatter call becomes:
```ts
const text = formatRouteResult({
  N,
  distanceMeters: result.distanceMeters,
  pubsInOrder,
  locale: ctx.locale,
  t: ctx.t,
});
await notify(text, { force: true });
```

- [ ] **Step 4: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/route.ts src/bot/commands/route-format.ts src/bot/commands/route-format.test.ts
git commit -m "refactor(route): use ctx.t + locale-aware fmtKm"
```

---

## Task 16: Migrate `refresh.ts` to `ctx.t`

**Files:**
- Modify: `src/bot/commands/refresh.ts`

- [ ] **Step 1: Replace four literals with `ctx.t`**

Edit `src/bot/commands/refresh.ts`. Replace within `cmd.command('refresh', async (ctx) => {…})`:

- `'⏱ Занадто часто — спробуй за кілька хвилин.'` → `ctx.t('refresh.cooldown')`
- `'⏳ Оновлюю…'` → `ctx.t('refresh.starting')`
- `'✅ Готово.'` → `ctx.t('refresh.done')`
- `'❌ Не вдалось — подивись логи.'` → `ctx.t('refresh.failed')`

(The `makeThrottledProgress` helper itself stays as-is — it's pure plumbing.)

- [ ] **Step 2: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/refresh.ts
git commit -m "refactor(refresh): use ctx.t for status messages"
```

---

## Task 17: Migrate `filters.ts` to `ctx.t`

**Files:**
- Modify: `src/bot/commands/filters.ts`

- [ ] **Step 1: Replace four literals with `ctx.t`**

Edit `src/bot/commands/filters.ts`:

- The current-state reply (line 20-23) becomes:
  ```ts
  await ctx.reply(
    ctx.t('filters.current', {
      styles: (f?.styles ?? []).join(',') || '—',
      min_rating: f?.min_rating ?? '—',
    }),
    filtersKeyboard(),
  );
  ```
- `await ctx.answerCbQuery(\`styles=${styles.join(',') || '—'}\`);` →
  `await ctx.answerCbQuery(ctx.t('filters.styles_changed', { styles: styles.join(',') || '—' }));`
- `await ctx.answerCbQuery(\`min_rating=${r}\`);` →
  `await ctx.answerCbQuery(ctx.t('filters.rating_changed', { rating: r }));`
- `await ctx.answerCbQuery('Скинуто');` →
  `await ctx.answerCbQuery(ctx.t('filters.reset_done'));`

(The button labels in `keyboards.ts` — `'IPA'`, `'Pils'`, `'Stout'`, `'Sour'`, `'min 3.5'`, `'min 3.8'`, `'Скинути'` — stay hardcoded for PR 1. PR 2 will localize the `'Скинути'` label; the four style names stay Latin per spec §1.)

- [ ] **Step 2: Verify typecheck and tests**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean tsc + all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/bot/commands/filters.ts
git commit -m "refactor(filters): use ctx.t for current state + callback answers"
```

---

## Task 18: Final verification + sync canonical spec

**Files:**
- Modify: `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md` (add UserProfile.language entry to §2 entity table; add a §14 lesson about i18n foundation landing)

- [ ] **Step 1: Run the entire test suite + typecheck**

```bash
npx tsc --noEmit && npx jest
```

Expected: clean + all suites green. Spot-check that the i18n test suites are present in the output (`detect-locale.test.ts`, `translator.test.ts`, `format.test.ts`, `i18n.test.ts`, `user.test.ts`, `schema.test.ts`).

- [ ] **Step 2: Audit for forgotten literals**

Search the bot source for Cyrillic strings that didn't make it into `uk.ts`:

```bash
grep -nP "['\"][^'\"]*[А-Яа-яІіЇїЄєҐґ][^'\"]*['\"]" src/bot/commands/ src/bot/index.ts src/bot/keyboards.ts | grep -v '\.test\.' | grep -v 'i18n'
```

Expected hits (acceptable):
- `keyboards.ts: 'Скинути'` — stays in PR 1, planned for PR 2.
- Comments containing Ukrainian (e.g. doc-comments) — not user-facing.

Anything else is a literal that escaped the migration. Add it to `uk.ts` and the appropriate command, then re-run typecheck + jest.

- [ ] **Step 3: Update canonical spec**

Edit `docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md`:

- In the entity table (§2), add a row after `PubDistance`:
  ```
  | `UserProfile.language` | локально (Telegram) | `uk` / `pl` / `en`, nullable; авто-детект на першому апдейті |
  ```
- In the §14 operational lessons, append:
  ```
  - **i18n foundation (PR ?? once merged)**: усі user-facing рядки тепер
    ідуть через `ctx.t(...)`. `uk.ts` — поки що єдина повна локаль; PL/EN
    додаються в наступному PR. Архітектура — `src/i18n/` (types, translator
    з `Intl.PluralRules`, detect-locale, locale-aware fmtAbv/fmtKm). Migration
    v3 додав `user_profiles.language`.
  ```

- [ ] **Step 4: Manual smoke checklist (post-merge, on the prod bot)**

Add this as a PR-description checklist; not part of the commit:

- `/start` — текст ідентичний попередній версії, байт-у-байт.
- `/link <username>` — успіх + помилка.
- `/import` — initial prompt, потім файл (.csv) → прогрес → finalmessage.
- `/newbeers` — список з groupTaps, suffix `+N інших` рендериться.
- `/route 5` — header + список пабів з пивом; розділювач у дистанції — кома (uk).
- `/refresh` — cooldown спрацьовує, прогрес-меседжі виводяться.
- `/filters` — поточні значення, тапи на стилі/рейтинг, reset.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-22-warsaw-beer-bot-design.md
git commit -m "docs: log i18n foundation in canonical spec §2 + §14"
```

---

## Done

Branch `feat/i18n-foundation` is ready for PR.

PR title: `feat(i18n): foundation — types, translator, plural infra, middleware, uk locale`

PR description should reference both the spec (`docs/superpowers/specs/2026-04-27-i18n-design.md`) and this plan, plus the manual smoke checklist from Task 18.

**Next:** PR 2 (`feat/i18n-pl-en-lang`) — adds `pl.ts` + `en.ts` (workflow §9 of the spec), the `/lang` command + keyboard, and localizes the remaining `'Скинути'` button label.
