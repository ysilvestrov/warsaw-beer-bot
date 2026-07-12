# /status Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user `/status` command that shows the user's configured choices (city, language, filters) plus Untappd link & check-in sync state, so they can see whether their data is complete or needs a re-import (closes #147 and #93).

**Architecture:** A pure `buildStatusMessage(t, view)` function renders an HTML message from a plain `StatusView` data object; a thin `statusCommand` Composer gathers that data from storage and sends it. The "do I need a re-import?" signal requires persisting the Untappd profile total (already parsed on every extension sync but currently discarded) via a new nullable `profile_total` column on `checkin_sync_state`.

**Tech Stack:** Node.js, TypeScript, Telegraf, better-sqlite3, Vitest.

---

## Important corrections vs. the design doc

- The design doc says "Migration **v14**". That is stale — **v14 and v15 already exist** in `src/storage/schema.ts` (v14 = city columns, v15 = `job_state`). The new migration is **v16**. (Fixed in Task 7's spec edit.)
- Adding `profile_total` to `SyncState` changes the object shape, so the **existing** `checkin_sync_state.test.ts` `toEqual({...})` assertions must gain `profile_total: null` (Task 1).

## File Structure

**Create:**
- `src/bot/commands/status-build.ts` — pure message builder + `StatusView` interface + `summarizeFilters` (the only real logic; fully unit-tested).
- `src/bot/commands/status-build.test.ts` — covers every render state.
- `src/bot/commands/status.ts` — thin Composer: gather data → `buildStatusMessage` → `replyWithHTML`.

**Modify:**
- `src/storage/schema.ts` — add migration v16 (`profile_total` column).
- `src/storage/checkin_sync_state.ts` — `SyncState.profile_total`; read + write it (latest-non-null-wins).
- `src/storage/checkin_sync_state.test.ts` — fix existing `toEqual`s; add `profile_total` cases.
- `src/api/routes/checkins.ts` — pass `page.profileTotal` into `advanceSyncState`.
- `src/storage/checkins.ts` — add `latestCheckinAt`.
- `src/storage/checkins.test.ts` — test `latestCheckinAt`.
- `src/i18n/types.ts` — add `cmd.status` + `status.*` keys to `Messages`.
- `src/i18n/locales/{en,uk,pl}.ts` — add the new strings.
- `src/index.ts` — import + register `statusCommand`.
- `src/bot/commands/catalog.ts` — add the `status` catalog entry.
- `spec.md` — §4 `/status` section, §3.14 column, §3.17 v16 row.
- `docs/superpowers/specs/2026-06-23-status-command-design.md` — correct "v14" → "v16".

**Note on command-handler tests:** Following the existing codebase convention (`beers.ts`, `pubs.ts`, etc. have no handler-level tests; their logic lives in tested `*-build.ts` files), `status.ts` is thin glue and is not given a dedicated handler test. All logic — the builder, `summarizeFilters`, and storage helpers — is covered. The `catalog.test.ts` suite auto-covers the new menu/help entry, and `tsc --noEmit` enforces locale completeness.

---

### Task 1: Persist `profile_total` on `checkin_sync_state`

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`)
- Modify: `src/storage/checkin_sync_state.ts`
- Test: `src/storage/checkin_sync_state.test.ts`

- [ ] **Step 1: Add the v16 migration**

In `src/storage/schema.ts`, add a new entry to the `MIGRATIONS` array immediately after the `version: 15` entry (keep ascending order):

```ts
  {
    version: 16,
    sql: `
      ALTER TABLE checkin_sync_state ADD COLUMN profile_total INTEGER;
    `,
  },
```

- [ ] **Step 2: Update existing tests for the new shape, and add coverage**

In `src/storage/checkin_sync_state.test.ts`, add `profile_total: null` to **every** existing `toEqual` object (there are several across the `returns a default state`, `advances the deepest cursor`, `keeps the lowest`, `latches complete`, and `handles a null maxId` tests). For example the first becomes:

```ts
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: null, complete: false, profile_total: null });
```

Then append a new test block for the profile-total policy:

```ts
  it('stores profile_total and keeps the latest non-null value', () => {
    const db = freshDb();
    ensureProfile(db, 1);

    // first sync sees a total
    advanceSyncState(db, 1, '500', false, 11287);
    expect(getSyncState(db, 1)).toEqual({ deepest_max_id: '500', complete: false, profile_total: 11287 });

    // a later page parses null → previous total is preserved
    advanceSyncState(db, 1, '400', false, null);
    expect(getSyncState(db, 1).profile_total).toBe(11287);

    // a later page with a fresh total overwrites (latest non-null wins)
    advanceSyncState(db, 1, '300', false, 11290);
    expect(getSyncState(db, 1).profile_total).toBe(11290);
  });

  it('defaults profile_total to null when omitted', () => {
    const db = freshDb();
    ensureProfile(db, 1);
    advanceSyncState(db, 1, '500', false);
    expect(getSyncState(db, 1).profile_total).toBeNull();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/storage/checkin_sync_state.test.ts`
Expected: FAIL — `getSyncState` returns an object without `profile_total`, and `advanceSyncState` rejects the 5th argument / ignores it.

- [ ] **Step 4: Implement the storage changes**

Replace the contents of `src/storage/checkin_sync_state.ts` with:

```ts
import type { DB } from './db';

export interface SyncState {
  deepest_max_id: string | null;
  complete: boolean;
  profile_total: number | null;
}

export function getSyncState(db: DB, telegramId: number): SyncState {
  const row = db
    .prepare(
      'SELECT deepest_max_id, complete, profile_total FROM checkin_sync_state WHERE telegram_id = ?',
    )
    .get(telegramId) as
    | { deepest_max_id: string | null; complete: number; profile_total: number | null }
    | undefined;
  if (!row) return { deepest_max_id: null, complete: false, profile_total: null };
  return {
    deepest_max_id: row.deepest_max_id,
    complete: row.complete === 1,
    profile_total: row.profile_total,
  };
}

// max_id is a numeric Untappd cursor; "deepest" = lowest value. We keep the
// minimum of the existing and incoming cursor so a Phase-1 top-up page (a high
// max_id near "now") never rewinds the Phase-2 deep cursor. complete latches on.
// profile_total: latest non-null wins — COALESCE keeps the prior value when the
// incoming page parsed no total.
export function advanceSyncState(
  db: DB,
  telegramId: number,
  maxId: string | null,
  complete: boolean,
  profileTotal: number | null = null,
): void {
  const prev = getSyncState(db, telegramId);
  const deepest = deeper(prev.deepest_max_id, maxId);
  db.prepare(
    `INSERT INTO checkin_sync_state (telegram_id, deepest_max_id, complete, profile_total, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(telegram_id) DO UPDATE SET
       deepest_max_id = excluded.deepest_max_id,
       complete = MAX(checkin_sync_state.complete, excluded.complete),
       profile_total = COALESCE(excluded.profile_total, checkin_sync_state.profile_total),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(telegramId, deepest, complete || prev.complete ? 1 : 0, profileTotal);
}

function deeper(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Number(b) < Number(a) ? b : a;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/storage/checkin_sync_state.test.ts`
Expected: PASS (all old + new cases).

- [ ] **Step 6: Commit**

```bash
git add src/storage/schema.ts src/storage/checkin_sync_state.ts src/storage/checkin_sync_state.test.ts
git commit -m "feat(checkins): persist Untappd profile_total on sync state (#93)"
```

---

### Task 2: Feed `profile_total` from the sync route

**Files:**
- Modify: `src/api/routes/checkins.ts:~73` (the `advanceSyncState` call inside `POST /checkins/sync`)

- [ ] **Step 1: Pass the parsed total into the writer**

In `src/api/routes/checkins.ts`, find this line inside the transaction:

```ts
      advanceSyncState(deps.db, telegramId, page.nextMaxId, page.nextMaxId === null);
```

Replace it with:

```ts
      advanceSyncState(deps.db, telegramId, page.nextMaxId, page.nextMaxId === null, page.profileTotal);
```

(`page.profileTotal` is already in scope — it is returned in the JSON response on the next lines.)

- [ ] **Step 2: Verify the existing route tests still pass**

Run: `npx vitest run src/api`
Expected: PASS. (No behavior change to the response; the new column just gets populated.)

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/checkins.ts
git commit -m "feat(checkins): record profile_total on each extension sync (#93)"
```

---

### Task 3: `latestCheckinAt` storage helper

**Files:**
- Modify: `src/storage/checkins.ts`
- Test: `src/storage/checkins.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/storage/checkins.test.ts` (it already imports from `./checkins` and constructs an in-memory migrated DB — reuse that file's existing `freshDb`/setup helper; if the helper is named differently, match the file's existing pattern). Add the import `latestCheckinAt` to the existing import line from `./checkins`, then:

```ts
describe('latestCheckinAt', () => {
  it('returns null when the user has no check-ins', () => {
    const db = freshDb();
    expect(latestCheckinAt(db, 999)).toBeNull();
  });

  it('returns the most recent checkin_at for the user', () => {
    const db = freshDb();
    mergeCheckin(db, { checkin_id: 'a', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2023-01-01 10:00:00', venue: null });
    mergeCheckin(db, { checkin_id: 'b', telegram_id: 1, beer_id: null, user_rating: null, checkin_at: '2024-05-05 20:00:00', venue: null });
    mergeCheckin(db, { checkin_id: 'c', telegram_id: 2, beer_id: null, user_rating: null, checkin_at: '2025-09-09 09:00:00', venue: null });
    expect(latestCheckinAt(db, 1)).toBe('2024-05-05 20:00:00');
  });
});
```

> If `checkins.test.ts` does not already define `freshDb` and import `mergeCheckin`, mirror the setup used at the top of that file (open `:memory:` DB, `migrate`, `ensureProfile`) and add `mergeCheckin` to its `./checkins` import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/storage/checkins.test.ts`
Expected: FAIL — `latestCheckinAt` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/storage/checkins.ts`:

```ts
export function latestCheckinAt(db: DB, telegramId: number): string | null {
  const row = db
    .prepare('SELECT MAX(checkin_at) AS m FROM checkins WHERE telegram_id = ?')
    .get(telegramId) as { m: string | null };
  return row.m;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/storage/checkins.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/checkins.ts src/storage/checkins.test.ts
git commit -m "feat(checkins): add latestCheckinAt helper"
```

---

### Task 4: i18n keys for `/status`

**Files:**
- Modify: `src/i18n/types.ts` (add keys to `Messages`)
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`

- [ ] **Step 1: Add the key declarations to the `Messages` interface**

In `src/i18n/types.ts`, add `'cmd.status': string;` next to the other `cmd.*` keys, and add a new block (place it near the other command blocks):

```ts
  // status (/status — per-user freshness + settings)
  'status.title': string;
  'status.settings_header': string;
  'status.city': string;              // {name}
  'status.language': string;          // {name}
  'status.language_auto': string;
  'status.filters': string;           // {summary}
  'status.filters_none': string;
  'status.filter_styles': string;     // {list}
  'status.filter_rating': string;     // {rating}
  'status.filter_abv': string;        // {min}, {max}
  'status.filter_route': string;      // {n}
  'status.filters_edit': string;
  'status.untappd_header': string;
  'status.not_linked': string;
  'status.username': string;          // {username}
  'status.checkins': string;          // {synced}
  'status.checkins_of': string;       // {synced}, {total}
  'status.sync_complete': string;
  'status.sync_in_progress': string;
  'status.distinct_beers': string;    // {count}
  'status.last_checkin': string;      // {date}
  'status.no_checkins': string;
```

> Because each locale object is typed `: Messages`, `tsc` will fail until all three locale files define every new key. That is the completeness guarantee — no separate test needed.

- [ ] **Step 2: Add the English strings**

In `src/i18n/locales/en.ts`, add `'cmd.status': 'your status & settings',` next to the other `cmd.*` entries, and a status block:

```ts
  // status
  'status.title': '📊 Your status',
  'status.settings_header': '⚙️ Settings',
  'status.city': 'City: {name}',
  'status.language': 'Language: {name}',
  'status.language_auto': 'auto',
  'status.filters': 'Filters: {summary}',
  'status.filters_none': 'none',
  'status.filter_styles': 'styles: {list}',
  'status.filter_rating': 'min ★{rating}',
  'status.filter_abv': 'ABV {min}–{max}%',
  'status.filter_route': 'route {n}',
  'status.filters_edit': 'Edit via /filters',
  'status.untappd_header': '🍺 Untappd',
  'status.not_linked': 'Not linked. Use /link to connect, or /import your history.',
  'status.username': 'Account: {username}',
  'status.checkins': 'Check-ins synced: {synced}',
  'status.checkins_of': 'Check-ins synced: {synced} / {total}',
  'status.sync_complete': 'Sync: complete ✅',
  'status.sync_in_progress': 'Sync: deep sync in progress ⏳',
  'status.distinct_beers': 'Distinct beers had: {count}',
  'status.last_checkin': 'Last check-in: {date}',
  'status.no_checkins': 'No check-ins yet — try /import or the extension.',
```

- [ ] **Step 3: Add the Ukrainian strings**

In `src/i18n/locales/uk.ts`, add `'cmd.status': 'твій статус і налаштування',` and:

```ts
  // status
  'status.title': '📊 Твій статус',
  'status.settings_header': '⚙️ Налаштування',
  'status.city': 'Місто: {name}',
  'status.language': 'Мова: {name}',
  'status.language_auto': 'авто',
  'status.filters': 'Фільтри: {summary}',
  'status.filters_none': 'немає',
  'status.filter_styles': 'стилі: {list}',
  'status.filter_rating': 'рейтинг від ★{rating}',
  'status.filter_abv': 'ABV {min}–{max}%',
  'status.filter_route': 'маршрут {n}',
  'status.filters_edit': 'Змінити: /filters',
  'status.untappd_header': '🍺 Untappd',
  'status.not_linked': 'Не прив’язано. Використай /link, або /import для історії.',
  'status.username': 'Акаунт: {username}',
  'status.checkins': 'Синхронізовано чекінів: {synced}',
  'status.checkins_of': 'Синхронізовано чекінів: {synced} / {total}',
  'status.sync_complete': 'Синхронізація: завершено ✅',
  'status.sync_in_progress': 'Синхронізація: триває глибока синхронізація ⏳',
  'status.distinct_beers': 'Унікального пива випито: {count}',
  'status.last_checkin': 'Останній чекін: {date}',
  'status.no_checkins': 'Ще немає чекінів — спробуй /import або розширення.',
```

- [ ] **Step 4: Add the Polish strings**

In `src/i18n/locales/pl.ts`, add `'cmd.status': 'twój status i ustawienia',` and:

```ts
  // status
  'status.title': '📊 Twój status',
  'status.settings_header': '⚙️ Ustawienia',
  'status.city': 'Miasto: {name}',
  'status.language': 'Język: {name}',
  'status.language_auto': 'auto',
  'status.filters': 'Filtry: {summary}',
  'status.filters_none': 'brak',
  'status.filter_styles': 'style: {list}',
  'status.filter_rating': 'min ★{rating}',
  'status.filter_abv': 'ABV {min}–{max}%',
  'status.filter_route': 'trasa {n}',
  'status.filters_edit': 'Zmień: /filters',
  'status.untappd_header': '🍺 Untappd',
  'status.not_linked': 'Brak powiązania. Użyj /link, lub /import dla historii.',
  'status.username': 'Konto: {username}',
  'status.checkins': 'Zsynchronizowane meldunki: {synced}',
  'status.checkins_of': 'Zsynchronizowane meldunki: {synced} / {total}',
  'status.sync_complete': 'Synchronizacja: zakończona ✅',
  'status.sync_in_progress': 'Synchronizacja: trwa głęboka synchronizacja ⏳',
  'status.distinct_beers': 'Unikalne wypite piwa: {count}',
  'status.last_checkin': 'Ostatni meldunek: {date}',
  'status.no_checkins': 'Brak meldunków — spróbuj /import lub rozszerzenia.',
```

- [ ] **Step 5: Typecheck to confirm all locales are complete**

Run: `npm run typecheck`
Expected: PASS (no missing-key errors in any locale).

- [ ] **Step 6: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/en.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts
git commit -m "feat(i18n): add /status strings (en/uk/pl)"
```

---

### Task 5: Pure `buildStatusMessage` builder

**Files:**
- Create: `src/bot/commands/status-build.ts`
- Test: `src/bot/commands/status-build.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/status-build.test.ts`:

```ts
import { createTranslator } from '../../i18n';
import { buildStatusMessage, summarizeFilters, type StatusView } from './status-build';
import type { Filters } from '../../storage/user_filters';

const t = createTranslator('en');

const base: StatusView = {
  city: 'warszawa',
  language: 'en',
  filters: null,
  linked: true,
  username: 'beerfan',
  synced: 11287,
  profileTotal: 11290,
  complete: true,
  distinctBeers: 842,
  lastCheckinAt: '2024-05-05 20:00:00',
};

describe('summarizeFilters', () => {
  it('returns the "none" label for null filters', () => {
    expect(summarizeFilters(t, null)).toBe(t('status.filters_none'));
  });

  it('joins the active filter parts', () => {
    const f: Filters = { styles: ['IPA', 'Stout'], min_rating: 3.5, abv_min: 5, abv_max: 8, default_route_n: 3 };
    const s = summarizeFilters(t, f);
    expect(s).toContain('IPA, Stout');
    expect(s).toContain('3.5');
    expect(s).toContain('5');
    expect(s).toContain('8');
    expect(s).toContain('3');
    expect(s).toContain('·');
  });

  it('treats an all-empty filter row as "none"', () => {
    const f: Filters = { styles: [], min_rating: null, abv_min: null, abv_max: null, default_route_n: null };
    expect(summarizeFilters(t, f)).toBe(t('status.filters_none'));
  });
});

describe('buildStatusMessage', () => {
  it('shows settings + full sync stats with profile total', () => {
    const out = buildStatusMessage(t, base);
    expect(out).toContain('Warszawa');               // city label, not slug
    expect(out).toContain('English');                // language native name
    expect(out).toContain('11287 / 11290');          // synced / total
    expect(out).toContain('beerfan');
    expect(out).toContain('842');
    expect(out).toContain('2024-05-05');             // date part only
    expect(out).toContain('<b>');                    // HTML headers present
  });

  it('omits the total when profileTotal is null', () => {
    const out = buildStatusMessage(t, { ...base, profileTotal: null });
    expect(out).toContain('Check-ins synced: 11287');
    expect(out).not.toContain('/ ');
  });

  it('shows the link nudge and no sync stats when not linked', () => {
    const out = buildStatusMessage(t, { ...base, linked: false, username: null });
    expect(out).toContain(t('status.not_linked'));
    expect(out).not.toContain('Check-ins synced');
    expect(out).toContain('Warszawa');               // settings still shown
  });

  it('shows the no-checkins hint when there are none', () => {
    const out = buildStatusMessage(t, { ...base, synced: 0, distinctBeers: 0, lastCheckinAt: null });
    expect(out).toContain(t('status.no_checkins'));
  });

  it('shows deep-sync-in-progress when not complete', () => {
    const out = buildStatusMessage(t, { ...base, complete: false });
    expect(out).toContain(t('status.sync_in_progress'));
  });

  it('renders "auto" when language is unset', () => {
    const out = buildStatusMessage(t, { ...base, language: null });
    expect(out).toContain(t('status.language_auto'));
  });

  it('HTML-escapes an adversarial username', () => {
    const out = buildStatusMessage(t, { ...base, username: 'a<b>&"x' });
    expect(out).toContain('a&lt;b&gt;&amp;');
    expect(out).not.toContain('a<b>&"x');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/bot/commands/status-build.test.ts`
Expected: FAIL — `./status-build` does not exist.

- [ ] **Step 3: Implement the builder**

Create `src/bot/commands/status-build.ts`:

```ts
import type { Locale, Translator } from '../../i18n/types';
import type { Filters } from '../../storage/user_filters';
import { cityLabel } from '../../domain/cities';
import { escapeHtml } from './html';

const LOCALE_NAMES: Record<Locale, string> = {
  uk: 'Українська',
  pl: 'Polski',
  en: 'English',
};

export interface StatusView {
  city: string;                 // city slug
  language: Locale | null;
  filters: Filters | null;
  linked: boolean;
  username: string | null;
  synced: number;
  profileTotal: number | null;
  complete: boolean;
  distinctBeers: number;
  lastCheckinAt: string | null; // ISO-ish; only the date part is shown
}

export function summarizeFilters(t: Translator, f: Filters | null): string {
  if (!f) return t('status.filters_none');
  const parts: string[] = [];
  if (f.styles.length) parts.push(t('status.filter_styles', { list: f.styles.join(', ') }));
  if (f.min_rating != null) parts.push(t('status.filter_rating', { rating: f.min_rating }));
  if (f.abv_min != null || f.abv_max != null) {
    parts.push(
      t('status.filter_abv', {
        min: f.abv_min != null ? f.abv_min : '—',
        max: f.abv_max != null ? f.abv_max : '—',
      }),
    );
  }
  if (f.default_route_n != null) parts.push(t('status.filter_route', { n: f.default_route_n }));
  return parts.length ? parts.join(' · ') : t('status.filters_none');
}

// All dynamic values and translated lines are escaped here before being joined,
// because the message is sent with replyWithHTML. Locale strings carry no markup;
// the only HTML is the <b> we add around section headers in code. (See the
// HTML-mode i18n gotcha: never let raw <…> reach Telegram unescaped.)
export function buildStatusMessage(t: Translator, view: StatusView): string {
  const esc = escapeHtml;
  const bold = (s: string): string => `<b>${esc(s)}</b>`;
  const lines: string[] = [];

  lines.push(bold(t('status.title')));
  lines.push('');

  // Settings — always shown, independent of Untappd linking.
  lines.push(bold(t('status.settings_header')));
  lines.push(esc(t('status.city', { name: cityLabel(view.city) })));
  lines.push(
    esc(
      t('status.language', {
        name: view.language ? LOCALE_NAMES[view.language] : t('status.language_auto'),
      }),
    ),
  );
  lines.push(esc(t('status.filters', { summary: summarizeFilters(t, view.filters) })));
  lines.push(esc(t('status.filters_edit')));
  lines.push('');

  // Untappd / sync.
  lines.push(bold(t('status.untappd_header')));
  if (!view.linked) {
    lines.push(esc(t('status.not_linked')));
    return lines.join('\n');
  }
  lines.push(esc(t('status.username', { username: view.username ?? '' })));
  lines.push(
    esc(
      view.profileTotal != null
        ? t('status.checkins_of', { synced: view.synced, total: view.profileTotal })
        : t('status.checkins', { synced: view.synced }),
    ),
  );
  lines.push(esc(view.complete ? t('status.sync_complete') : t('status.sync_in_progress')));
  lines.push(esc(t('status.distinct_beers', { count: view.distinctBeers })));
  lines.push(
    esc(
      view.lastCheckinAt
        ? t('status.last_checkin', { date: view.lastCheckinAt.slice(0, 10) })
        : t('status.no_checkins'),
    ),
  );

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/bot/commands/status-build.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/status-build.ts src/bot/commands/status-build.test.ts
git commit -m "feat(status): pure /status message builder (#147)"
```

---

### Task 6: Wire up the `/status` command

**Files:**
- Create: `src/bot/commands/status.ts`
- Modify: `src/index.ts`
- Modify: `src/bot/commands/catalog.ts`

- [ ] **Step 1: Create the command**

Create `src/bot/commands/status.ts`:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { getProfile, getUserCity, getUserLanguage } from '../../storage/user_profiles';
import { getFilters } from '../../storage/user_filters';
import { countCheckins, drunkBeerIds, latestCheckinAt } from '../../storage/checkins';
import { getSyncState } from '../../storage/checkin_sync_state';
import { buildStatusMessage, type StatusView } from './status-build';

export const statusCommand = new Composer<BotContext>();

statusCommand.command('status', async (ctx) => {
  const db = ctx.deps.db;
  const id = ctx.from.id;
  const profile = getProfile(db, id);
  const sync = getSyncState(db, id);

  const view: StatusView = {
    city: getUserCity(db, id),
    language: getUserLanguage(db, id),
    filters: getFilters(db, id),
    linked: !!profile?.untappd_username,
    username: profile?.untappd_username ?? null,
    synced: countCheckins(db, id),
    profileTotal: sync.profile_total,
    complete: sync.complete,
    distinctBeers: drunkBeerIds(db, id).size,
    lastCheckinAt: latestCheckinAt(db, id),
  };

  await ctx.replyWithHTML(buildStatusMessage(ctx.t, view));
});
```

- [ ] **Step 2: Register it in the bot**

In `src/index.ts`, add the import alongside the other command imports (after the `helpCommand` import line):

```ts
import { statusCommand } from './bot/commands/status';
```

Then add `statusCommand,` to the `bot.use(...)` list (place it next to `helpCommand,`):

```ts
    helpCommand,
    statusCommand,
```

- [ ] **Step 3: Add the catalog entry**

In `src/bot/commands/catalog.ts`, add an entry to `COMMAND_CATALOG`. Place it just before the `help` entry:

```ts
  { command: 'status', descKey: 'cmd.status' },
  { command: 'help', descKey: 'cmd.help' },
```

- [ ] **Step 4: Run the catalog + menu tests and typecheck**

Run: `npx vitest run src/bot/commands/catalog.test.ts src/bot/register-command-menu.test.ts && npm run typecheck`
Expected: PASS — `catalog.test.ts` derives counts from `COMMAND_CATALOG.length` (no hardcoded count to break), and `cmd.status` resolves placeholder-free in all locales.

- [ ] **Step 5: Full test run + build**

Run: `npm test && npm run build`
Expected: PASS (all suites green; `tsc` build clean).

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/status.ts src/index.ts src/bot/commands/catalog.ts
git commit -m "feat(status): register /status command + menu entry (#147, #93)"
```

---

### Task 7: Update spec.md and correct the design doc

**Files:**
- Modify: `spec.md` (§3.14, §3.17, §4)
- Modify: `docs/superpowers/specs/2026-06-23-status-command-design.md`

- [ ] **Step 1: Document the new column in §3.14**

In `spec.md` §3.14 (`checkin_sync_state`), add a row/sentence documenting the new column:

> `profile_total` (INTEGER, nullable) — останній відомий загальний лік чекінів у профілі Untappd (парситься з кожної сторінки extension-синхронізації; *latest non-null wins*). Використовується `/status` для показу `synced / profile_total`. NULL для користувачів, що не користуються розширенням (import-only / link-only).

- [ ] **Step 2: Add the v16 migration-history row in §3.17**

In the migration-history table, append:

```
| 16 | `checkin_sync_state.profile_total` (INTEGER) — лік чекінів профілю Untappd для `/status` |
```

- [ ] **Step 3: Add the `/status` command section in §4**

Add a new subsection under §4 (near `/link` and `/import`):

```markdown
### `/status` — статус і налаштування користувача

Особиста зведена картка (HTML, локалізована uk/pl/en). Дві секції:

**Налаштування (завжди):** активне місто, мова інтерфейсу, короткий
однорядковий підсумок фільтрів (стилі / мін. рейтинг / ABV / N маршруту), з
підказкою `/filters` для редагування.

**Untappd / синхронізація:**
- якщо не прив'язано — підказка `/link` (+ `/import`), без статистики;
- якщо прив'язано — username, `synced` чекінів (із `/ profile_total`, коли
  відомо), стан синхронізації (завершено / триває глибока), к-сть унікального
  випитого пива, дата останнього чекіна (або підказка `/import` / розширення,
  якщо чекінів немає).

Свідомо НЕ показує жодного обчисленого «треба переімпортувати» — обидва числа
показуються, користувач робить висновок сам. Закриває #147 та #93.
```

- [ ] **Step 4: Correct the design doc version reference**

In `docs/superpowers/specs/2026-06-23-status-command-design.md`, replace the two "v14" references for the new migration with "v16" (the "**Migration v14**" bullet and the "§3.17 … **v14** row" line). Leave any unrelated text intact.

- [ ] **Step 5: Commit**

```bash
git add spec.md docs/superpowers/specs/2026-06-23-status-command-design.md
git commit -m "docs(spec): document /status and checkin_sync_state.profile_total (v16)"
```

---

## Self-Review

**Spec coverage:**
- Settings block (city/language/filters) → Tasks 4, 5, 6. ✅
- Persist `profile_total`, latest-non-null-wins → Task 1; fed from route → Task 2. ✅
- Both numbers, no nudge/tolerance → builder logic (`checkins_of` vs `checkins`), Task 5. ✅
- Distinct beers, last check-in, sync status, not-linked nudge, zero-checkins hint → Task 5 tests. ✅
- `/help` + native menu + spec.md + design-doc fix → Tasks 6, 7. ✅
- Vitest coverage for builder + storage → Tasks 1, 3, 5. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — all code shown in full. ✅

**Type consistency:** `StatusView` fields are defined once (Task 5) and consumed identically (Task 6). `advanceSyncState(db, telegramId, maxId, complete, profileTotal?)` signature matches its one prod caller (Task 2) and tests (Task 1). `SyncState.profile_total` used as `sync.profile_total` in Task 6. i18n keys declared in Task 4 match every `t('status.*')` call in Task 5. ✅

**Migration number:** v16 confirmed against `schema.ts` (v14/v15 already used). ✅
