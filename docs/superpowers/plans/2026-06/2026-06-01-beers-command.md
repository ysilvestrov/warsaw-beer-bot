# `/beers` Debug Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/beers <pub>` Telegram command that dumps every tap of one pub's latest snapshot raw (no had-list / no user filters), for debugging what the scraper parsed.

**Architecture:** A new pure builder `buildBeersMessage` reuses the existing `filterPubsByQuery` (pub resolution) and `tapsForSnapshotWithBeer` (tap data). It returns a discriminated union; a thin Telegraf composer (`beersCommand`) renders each arm. No grouping, no ranking, no filtering — every tap is shown in `tap_number` order with a 🟢 (matched) / ⚪ (orphan) icon.

**Tech Stack:** Node.js, TypeScript, Telegraf, better-sqlite3, Jest. i18n via the project's typed `Translator`.

**Spec:** `docs/superpowers/specs/2026-06-01-beers-command-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/i18n/types.ts` | add `beers.*` keys to the `Messages` interface (modify) |
| `src/i18n/locales/{uk,pl,en}.ts` | add `beers.*` translations + help line (modify) |
| `src/bot/commands/beers-build.ts` | pure `buildBeersMessage` + tap-line formatting (create) |
| `src/bot/commands/beers-build.test.ts` | unit tests for the builder (create) |
| `src/bot/commands/beers.ts` | thin Telegraf composer `beersCommand` (create) |
| `src/index.ts` | register `beersCommand` in `bot.use(...)` (modify) |

---

## Task 1: i18n keys for `/beers`

**Files:**
- Modify: `src/i18n/types.ts` (after the `// newbeers` block, ~line 32)
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`

This task has no unit test of its own — it is verified by `tsc` (the `Messages` interface forces all three locales to define every key). The builder/handler tasks depend on these keys existing.

- [ ] **Step 1: Add keys to the `Messages` interface**

In `src/i18n/types.ts`, insert this block immediately after the three `'newbeers.*'` lines (after line 32):

```ts
  // beers (debug: raw tap dump for one pub)
  'beers.usage': string;
  'beers.header': string;          // {pub}, {address}, {count}
  'beers.pub_not_found': string;   // {query}
  'beers.ambiguous': string;
  'beers.ambiguous_item': string;  // {name}, {address}
  'beers.empty': string;           // {pub}
```

- [ ] **Step 2: Add Ukrainian translations**

In `src/i18n/locales/uk.ts`, insert after the `// newbeers` block (after the `'newbeers.pub_not_found'` line):

```ts
  // beers (debug)
  'beers.usage': 'Використання: /beers <частина назви паба>. Аргумент обовʼязковий.',
  'beers.header': '🍺 <b>{pub}</b>{address}\nКранів: {count}',
  'beers.pub_not_found': 'Паб «{query}» не знайдено. /pubs покаже доступні.',
  'beers.ambiguous': 'Підходить кілька пабів — уточни запит (напр. додай вулицю):',
  'beers.ambiguous_item': '• {name} — {address}',
  'beers.empty': 'У пабі «{pub}» зараз немає даних про крани.',
```

Then add a help line to the `'app.start'` array (after the `/route` line):

```ts
    '6) /beers <паб> — діагностика: усі краны паба як їх розпарсив бот.',
```

- [ ] **Step 3: Add Polish translations**

In `src/i18n/locales/pl.ts`, insert after the `// newbeers` block:

```ts
  // beers (debug)
  'beers.usage': 'Użycie: /beers <fragment nazwy pubu>. Argument wymagany.',
  'beers.header': '🍺 <b>{pub}</b>{address}\nKrany: {count}',
  'beers.pub_not_found': 'Pub „{query}” nie znaleziony. /pubs pokaże dostępne.',
  'beers.ambiguous': 'Pasuje kilka pubów — doprecyzuj zapytanie (np. dodaj ulicę):',
  'beers.ambiguous_item': '• {name} — {address}',
  'beers.empty': 'Pub „{pub}” nie ma teraz danych o kranach.',
```

Then add a help line to the `'app.start'` array (after the `/route` line):

```ts
    '6) /beers <pub> — debug: wszystkie krany pubu tak, jak rozpoznał je bot.',
```

- [ ] **Step 4: Add English translations**

In `src/i18n/locales/en.ts`, insert after the `// newbeers` block:

```ts
  // beers (debug)
  'beers.usage': 'Usage: /beers <pub name fragment>. Argument required.',
  'beers.header': '🍺 <b>{pub}</b>{address}\nTaps: {count}',
  'beers.pub_not_found': 'Pub "{query}" not found. /pubs lists available ones.',
  'beers.ambiguous': 'Several pubs match — narrow the query (e.g. add a street):',
  'beers.ambiguous_item': '• {name} — {address}',
  'beers.empty': 'Pub "{pub}" has no tap data right now.',
```

Then add a help line to the `'app.start'` array (after the `/route` line):

```ts
    '6) /beers <pub> — debug: all taps of a pub exactly as the bot parsed them.',
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors (all three locales now satisfy `Messages`).

- [ ] **Step 6: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "feat(i18n): beers.* keys for /beers debug command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `buildBeersMessage` pure builder

**Files:**
- Create: `src/bot/commands/beers-build.ts`
- Test: `src/bot/commands/beers-build.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/commands/beers-build.test.ts`:

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createSnapshot, insertTaps } from '../../storage/snapshots';
import { upsertBeer } from '../../storage/beers';
import { upsertMatch } from '../../storage/match_links';
import { createTranslator } from '../../i18n';
import { buildBeersMessage } from './beers-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const t = createTranslator('uk');
const base = (db: ReturnType<typeof fresh>, pubQuery?: string) =>
  buildBeersMessage({ db, locale: 'uk' as const, t, pubQuery });

describe('buildBeersMessage — resolution', () => {
  test('missing argument returns no_arg', () => {
    const db = fresh();
    expect(base(db)).toEqual({ kind: 'no_arg' });
  });

  test('whitespace-only argument returns no_arg', () => {
    const db = fresh();
    expect(base(db, '   ')).toEqual({ kind: 'no_arg' });
  });

  test('unknown query returns pub_not_found with trimmed query', () => {
    const db = fresh();
    upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null });
    expect(base(db, '  zzz  ')).toEqual({ kind: 'pub_not_found', query: 'zzz' });
  });

  test('two name-matches return ambiguous with both pubs', () => {
    const db = fresh();
    upsertPub(db, { slug: 'a', name: 'PINTA Warszawa', address: 'Chmielna 7', lat: null, lon: null });
    upsertPub(db, { slug: 'b', name: 'PINTA Warszawa', address: 'Nowogrodzka 4', lat: null, lon: null });
    const out = base(db, 'pinta');
    expect(out.kind).toBe('ambiguous');
    if (out.kind !== 'ambiguous') return;
    expect(out.pubs).toEqual([
      { name: 'PINTA Warszawa', address: 'Chmielna 7' },
      { name: 'PINTA Warszawa', address: 'Nowogrodzka 4' },
    ]);
  });

  test('ambiguous caps the list at 3 pubs', () => {
    const db = fresh();
    for (let i = 1; i <= 4; i++) {
      upsertPub(db, { slug: `m${i}`, name: `Multi Bar ${i}`, address: null, lat: null, lon: null });
    }
    const out = base(db, 'multi');
    expect(out.kind).toBe('ambiguous');
    if (out.kind !== 'ambiguous') return;
    expect(out.pubs).toHaveLength(3);
  });

  test('matched pub without any snapshot returns empty with pub name', () => {
    const db = fresh();
    upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null });
    expect(base(db, 'kufel')).toEqual({ kind: 'empty', pub: 'Kufel' });
  });

  test('matched pub with snapshot but no taps returns empty', () => {
    const db = fresh();
    const id = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null });
    createSnapshot(db, id, '2026-05-25T12:00:00Z');
    expect(base(db, 'kufel')).toEqual({ kind: 'empty', pub: 'Kufel' });
  });
});

describe('buildBeersMessage — ok rendering', () => {
  test('shows every tap incl. orphan and already-tried, with 🟢/⚪ icons', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: 'Foo 1', lat: null, lon: null });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 1, name: 'Atak Chmielu', brewery: 'Pinta', style: 'AIPA',
      abv: 6.1, rating_global: 3.85,
      normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
    // tap 1: matched; tap 2: orphan (no match_link)
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA',
        abv: 6.1, ibu: null, style: 'AIPA', u_rating: 3.9 },
      { tap_number: 2, beer_ref: 'Mystery Brew', brewery_ref: 'Unknown Co',
        abv: 5.0, ibu: null, style: null, u_rating: 4.2 },
    ]);
    // mark the matched beer as already tried — must STILL appear (no filtering)
    db.prepare('INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)')
      .run(1, beerId, '2026-05-25T11:00:00Z');

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('PINTA Atak Chmielu'); // tried, still shown
    expect(out.html).toContain('Mystery Brew');       // orphan, still shown
    expect(out.html).toContain('🟢');                 // matched icon
    expect(out.html).toContain('⚪');                 // orphan icon
    expect(out.html).toContain('Kufel');              // header pub name
    expect(out.html).toContain('Foo 1');              // header address
    expect(out.html).toContain('Кранів: 2');          // header count
  });

  test('null tap_number / abv / rating render as em dash', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    insertTaps(db, snap, [
      { tap_number: null, beer_ref: 'No Numbers', brewery_ref: null,
        abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // line is: "— • <b>No Numbers</b> • — • — • ⚪"
    expect(out.html).toContain('— • <b>No Numbers</b> • — • — • ⚪');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest beers-build`
Expected: FAIL — `Cannot find module './beers-build'`.

- [ ] **Step 3: Implement the builder**

Create `src/bot/commands/beers-build.ts`:

```ts
import type { DB } from '../../storage/db';
import type { Locale, Translator } from '../../i18n/types';
import { latestSnapshot, tapsForSnapshotWithBeer } from '../../storage/snapshots';
import { listPubs } from '../../storage/pubs';
import { filterPubsByQuery } from './newbeers-build';
import { escapeHtml } from './newbeers-format';

export interface BeersDeps {
  db: DB;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
}

export type BeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'no_arg' }
  | { kind: 'pub_not_found'; query: string }
  | { kind: 'ambiguous'; pubs: { name: string; address: string | null }[] }
  | { kind: 'empty'; pub: string };

const fmtTapNum = (n: number | null): string => (n == null ? '—' : String(n));
const fmtAbv = (abv: number | null): string =>
  abv == null ? '—' : `${Math.round(abv * 10) / 10}%`;
const fmtRating = (r: number | null): string => (r == null ? '—' : r.toFixed(1));

export function buildBeersMessage(deps: BeersDeps): BeersResult {
  const { db, t } = deps;
  const q = deps.pubQuery?.trim() ?? '';
  if (!q) return { kind: 'no_arg' };

  const matched = filterPubsByQuery(listPubs(db), q);
  if (matched.length === 0) return { kind: 'pub_not_found', query: q };
  if (matched.length >= 2) {
    return {
      kind: 'ambiguous',
      pubs: matched.slice(0, 3).map((p) => ({ name: p.name, address: p.address })),
    };
  }

  const pub = matched[0];
  const snap = latestSnapshot(db, pub.id);
  if (!snap) return { kind: 'empty', pub: pub.name };

  const taps = tapsForSnapshotWithBeer(db, snap.id);
  if (taps.length === 0) return { kind: 'empty', pub: pub.name };

  const address = pub.address ? ` — ${escapeHtml(pub.address)}` : '';
  const header = t('beers.header', {
    pub: escapeHtml(pub.name),
    address,
    count: taps.length,
  });

  const lines = taps.map((tap) => {
    const display = tap.brewery_ref
      ? `${tap.brewery_ref} ${tap.beer_ref}`.trim()
      : tap.beer_ref;
    const icon = tap.beer_id != null ? '🟢' : '⚪';
    return (
      `${fmtTapNum(tap.tap_number)} • <b>${escapeHtml(display)}</b>` +
      ` • ${fmtAbv(tap.abv)} • ${fmtRating(tap.u_rating)} • ${icon}`
    );
  });

  return { kind: 'ok', html: [header, ...lines].join('\n') };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest beers-build`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/beers-build.ts src/bot/commands/beers-build.test.ts
git commit -m "feat(beers): buildBeersMessage — raw tap dump for one pub

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `/beers` command handler + registration

**Files:**
- Create: `src/bot/commands/beers.ts`
- Modify: `src/index.ts` (import near line 15, register in `bot.use(...)` after `newbeersCommand` ~line 61)

No unit test — the project's other thin command handlers (`newbeers.ts`, `pubs.ts`) are untested; verification is `tsc` + the full suite + a build.

- [ ] **Step 1: Create the composer**

Create `src/bot/commands/beers.ts`:

```ts
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildBeersMessage } from './beers-build';

export const beersCommand = new Composer<BotContext>();

beersCommand.command('beers', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const result = buildBeersMessage({
    db: ctx.deps.db,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
  });
  switch (result.kind) {
    case 'ok':
      await ctx.replyWithHTML(result.html);
      return;
    case 'no_arg':
      await ctx.reply(ctx.t('beers.usage'));
      return;
    case 'pub_not_found':
      await ctx.reply(ctx.t('beers.pub_not_found', { query: result.query }));
      return;
    case 'ambiguous': {
      const items = result.pubs.map((p) =>
        ctx.t('beers.ambiguous_item', { name: p.name, address: p.address ?? '—' }),
      );
      await ctx.reply([ctx.t('beers.ambiguous'), ...items].join('\n'));
      return;
    }
    case 'empty':
      await ctx.reply(ctx.t('beers.empty', { pub: result.pub }));
      return;
    default:
      // exhaustiveness: if BeersResult grows a new arm, TS errors here
      result satisfies never;
  }
});
```

- [ ] **Step 2: Register the command in `src/index.ts`**

Add the import after the `newbeersCommand` import (line 13):

```ts
import { beersCommand } from './bot/commands/beers';
```

Add `beersCommand` to the `bot.use(...)` list, right after `newbeersCommand,` (line 61):

```ts
    newbeersCommand,
    beersCommand,
    pubsCommand,
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/beers.ts src/index.ts
git commit -m "feat(beers): wire /beers command into the bot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npx jest`
Expected: all suites pass, including the new `beers-build` suite. No regressions in `newbeers-build`.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean compile, `dist/` rebuilt with no errors.

- [ ] **Step 3: Confirm i18n parity**

Run: `npx jest i18n`
Expected: PASS — every locale defines the new `beers.*` keys (enforced by the `Messages` type, double-checked by i18n tests).

---

## Self-Review Notes

- **Spec coverage:** §2 requirements → Task 2 tests (no_arg, pub_not_found, ambiguous≤3, empty×2, ok); §3.3 line format → Task 2 ok-rendering tests; §3.4 handler arms → Task 3; §3.5 i18n keys + help → Task 1.
- **No filtering guarantee:** the "already-tried + orphan both shown" test (Task 2) is the explicit proof that had-list/filters are bypassed.
- **Type consistency:** `BeersResult` arms and `t('beers.*')` keys are identical across builder (Task 2), handler (Task 3), and i18n types (Task 1). `empty` carries `pub` everywhere.
- **Icons:** 🟢 (matched, `beer_id != null`) / ⚪ (orphan) — fixed literals, not localized, per spec.
