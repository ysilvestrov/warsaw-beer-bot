# /newbeers <pub> filter + /pubs discovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional positional substring filter to `/newbeers` (filters by pub name, case-insensitive) and a new `/pubs` command listing all available pub names alphabetically.

**Architecture:** Extend the pure `buildNewbeersMessage(deps)` with an optional `pubQuery?: string`; widen its return type from `string | null` to a `NewbeersResult` discriminated union (`'ok' | 'empty' | 'pub_not_found'`) so the handler can produce a targeted error on bad input. The `/refresh` autorun closure adapts to the new shape but stays aggregated (no pubQuery, only sends on `'ok'`). A symmetrical `buildPubsMessage(deps)` + thin `pubsCommand` provides the discovery loop. The `NewbeersResult` widening is a single breaking change that touches `newbeers-build.ts`, `newbeers.ts`, and `refresh.ts` atomically (one commit), to keep every intermediate revision green.

**Tech Stack:** TypeScript, Jest, Telegraf 4.x, better-sqlite3 (`:memory:` for tests). No new dependencies. No schema/migration changes. No storage-layer changes.

**Spec:** `docs/superpowers/specs/2026-05-25-newbeers-pub-filter-design.md` (commit `42a6603`).

**Branch:** `feat/newbeers-pub-filter` off `origin/main`.

---

## File Structure

- **Modify** `src/i18n/types.ts` — add 4 keys to `Messages`.
- **Modify** `src/i18n/locales/uk.ts`, `pl.ts`, `en.ts` — add 4 string implementations; update `app.start` to mention `/pubs` and the new `/newbeers` argument.
- **Modify** `src/bot/commands/newbeers-build.ts` — `pubQuery?` parameter; `NewbeersResult` return.
- **Modify** `src/bot/commands/newbeers-build.test.ts` — adapt 4 existing tests to new shape; add 4 new tests for `pubQuery`.
- **Modify** `src/bot/commands/newbeers.ts` — parse positional arg; switch on `result.kind`.
- **Modify** `src/bot/commands/refresh.ts` — `createRefreshCommand`'s `postRun?` type widens; closure switches on `kind === 'ok'`.
- **Create** `src/bot/commands/pubs-build.ts` — pure `buildPubsMessage`.
- **Create** `src/bot/commands/pubs-build.test.ts` — 3 cases (empty, alphabetical, HTML-escape).
- **Create** `src/bot/commands/pubs.ts` — thin command wrapper.
- **Modify** `src/index.ts` — import and register `pubsCommand`.
- **Modify** `docs/USER-GUIDE.md` — short paragraph near the `/newbeers` section.

No new files outside `src/bot/commands/` and `src/i18n/locales/`. No tests deleted; no migrations.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/newbeers-pub-filter /home/ysi/warsaw-beer-bot-pub-filter origin/main
cd /home/ysi/warsaw-beer-bot-pub-filter
```

- [ ] **Step 2: Install dependencies**

Run: `npm ci`
Expected: clean install, exit 0.

- [ ] **Step 3: Baseline green suite**

Run: `npm test -- --silent`
Expected: every suite passes (this is the baseline we will not regress).

- [ ] **Step 4: Baseline typecheck**

Run: `npm run typecheck`
Expected: exit 0.

---

## Task 2: Add i18n keys (`pubs.*`, `newbeers.pub_not_found`) + update `app.start`

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/uk.ts`
- Modify: `src/i18n/locales/pl.ts`
- Modify: `src/i18n/locales/en.ts`

The compile-time guarantee on `Messages` is the safety net here — if any locale forgets a key, `tsc` errors. No separate unit test is added for these strings (locale-completeness is type-enforced).

- [ ] **Step 1: Extend the `Messages` interface**

In `src/i18n/types.ts`, find the `// newbeers` block (lines 29-31):

```typescript
  // newbeers
  'newbeers.empty': string;
  'newbeers.more_pubs_suffix': string;   // {extra}
```

Replace with:

```typescript
  // newbeers
  'newbeers.empty': string;
  'newbeers.more_pubs_suffix': string;   // {extra}
  'newbeers.pub_not_found': string;      // {query}

  // pubs
  'pubs.header': string;
  'pubs.empty': string;
  'pubs.hint': string;
```

- [ ] **Step 2: Confirm typecheck fails on missing locale entries**

Run: `npm run typecheck`
Expected: FAIL with `Property 'newbeers.pub_not_found' is missing` (and the three `pubs.*`), reported against each locale file. This is the "test" for locale completeness.

- [ ] **Step 3: Add the strings to `uk.ts`**

In `src/i18n/locales/uk.ts`, find the `// newbeers` block (lines 33-35):

```typescript
  // newbeers
  'newbeers.empty': 'Нічого цікавого — спробуй /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} інших',
```

Replace with:

```typescript
  // newbeers
  'newbeers.empty': 'Нічого цікавого — спробуй /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} інших',
  'newbeers.pub_not_found': 'Паб «{query}» не знайдено. /pubs покаже доступні.',

  // pubs
  'pubs.header': 'Доступні паби:',
  'pubs.empty': 'У базі ще нема пабів — спочатку має пройти /refresh.',
  'pubs.hint': 'Підказка: /newbeers <частина назви> покаже новинки тільки в матчених пабах.',
```

Then update `app.start` (lines 5-12) to mention `/pubs` and the new `/newbeers` argument. Replace the whole `app.start` assignment with:

```typescript
  'app.start': [
    'Привіт! Я допоможу зібрати маршрут по варшавських пабах і випити щось нове.',
    '',
    '1) /link <untappd-username> — щоб підтягувати твої чекіни.',
    '2) /import — завантаж CSV-експорт зі свого Untappd для повного бекфілу історії.',
    '3) /newbeers [пiдрядок назви паба] — топ непитих пив; з аргументом — тільки в матчених пабах.',
    '4) /pubs — список доступних пабів.',
    '5) /route N — маршрут, що покриває ≥ N непитих пив із мінімальною пішою відстанню.',
  ].join('\n'),
```

- [ ] **Step 4: Add the strings to `pl.ts`**

In `src/i18n/locales/pl.ts`, find the `// newbeers` block:

```typescript
  // newbeers
  'newbeers.empty': 'Nic ciekawego — spróbuj /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} innych',
```

Replace with:

```typescript
  // newbeers
  'newbeers.empty': 'Nic ciekawego — spróbuj /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} innych',
  'newbeers.pub_not_found': 'Nie znaleziono pubu „{query}". /pubs pokaże dostępne.',

  // pubs
  'pubs.header': 'Dostępne puby:',
  'pubs.empty': 'W bazie nie ma jeszcze pubów — najpierw musi się wykonać /refresh.',
  'pubs.hint': 'Podpowiedź: /newbeers <fragment nazwy> pokaże nowości tylko w dopasowanych pubach.',
```

Then update `app.start` in `pl.ts`. Read the current value first (the structure mirrors uk.ts), then replace with:

```typescript
  'app.start': [
    'Cześć! Pomogę ułożyć trasę po warszawskich pubach i wypić coś nowego.',
    '',
    '1) /link <untappd-username> — żeby podciągnąć twoje check-iny.',
    '2) /import — wyślij CSV-eksport z Untappd dla pełnego backfillu historii.',
    '3) /newbeers [fragment nazwy pubu] — top niespróbowanych piw; z argumentem — tylko w dopasowanych pubach.',
    '4) /pubs — lista dostępnych pubów.',
    '5) /route N — trasa pokrywająca ≥ N niespróbowanych piw z minimalnym dystansem.',
  ].join('\n'),
```

(The existing pl `app.start` text is in Polish; preserve its tone — these are the bullets after translation.)

- [ ] **Step 5: Add the strings to `en.ts`**

In `src/i18n/locales/en.ts`, find the `// newbeers` block:

```typescript
  // newbeers
  'newbeers.empty': 'Nothing interesting — try /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} more',
```

Replace with:

```typescript
  // newbeers
  'newbeers.empty': 'Nothing interesting — try /refresh.',
  'newbeers.more_pubs_suffix': ' +{extra} more',
  'newbeers.pub_not_found': 'Pub "{query}" not found. /pubs lists available ones.',

  // pubs
  'pubs.header': 'Available pubs:',
  'pubs.empty': 'No pubs in the database yet — wait for the first /refresh.',
  'pubs.hint': 'Tip: /newbeers <name fragment> shows new beers only in matching pubs.',
```

Then update `app.start` in `en.ts`. Replace with:

```typescript
  'app.start': [
    'Hi! I help plan a route across Warsaw pubs and drink something new.',
    '',
    '1) /link <untappd-username> — to pull your check-ins.',
    '2) /import — upload a CSV export from Untappd for a full history backfill.',
    '3) /newbeers [pub-name fragment] — top untried beers; with an argument — only in matching pubs.',
    '4) /pubs — list of available pubs.',
    '5) /route N — a route covering ≥ N untried beers with minimal walking distance.',
  ].join('\n'),
```

- [ ] **Step 6: Confirm typecheck is green**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Run the full suite**

Run: `npm test -- --silent`
Expected: every test still passes (the new keys are not referenced yet by any production code).

- [ ] **Step 8: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "$(cat <<'EOF'
feat(i18n): add pubs.* + newbeers.pub_not_found keys; update app.start

Adds four new Messages keys in all three locales, plus an updated
welcome message that mentions /pubs and the new optional /newbeers
positional argument. The keys are not referenced yet — they land in
this commit so the type system enforces locale completeness before
any production code starts depending on them.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: NewbeersResult + pubQuery (atomic breaking change)

**Files:**
- Modify: `src/bot/commands/newbeers-build.ts`
- Modify: `src/bot/commands/newbeers-build.test.ts`
- Modify: `src/bot/commands/newbeers.ts`
- Modify: `src/bot/commands/refresh.ts`

The return type of `buildNewbeersMessage` widens from `string | null` to a discriminated union. Three production files reference that type (`newbeers.ts` handler, `refresh.ts` postRun closure, plus `index.ts` indirectly through `buildNewbeersMessage` being passed in). All edits land in a single commit so every intermediate revision compiles. `index.ts` does NOT change in this task — it passes `buildNewbeersMessage` by reference and the call is structurally compatible.

- [ ] **Step 1: Update `newbeers-build.test.ts` (8 tests total)**

Overwrite `src/bot/commands/newbeers-build.test.ts` with:

```typescript
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createSnapshot, insertTaps } from '../../storage/snapshots';
import { upsertBeer } from '../../storage/beers';
import { upsertMatch } from '../../storage/match_links';
import { createTranslator } from '../../i18n';
import { buildNewbeersMessage } from './newbeers-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

// Fixture: two pubs each with one matched tap. Used by several pubQuery tests.
function seedTwoPubs(db: ReturnType<typeof fresh>) {
  const pubA = upsertPub(db, {
    slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null,
  });
  const pubB = upsertPub(db, {
    slug: 'pub-b', name: 'Pub B', address: null, lat: null, lon: null,
  });
  const snapA = createSnapshot(db, pubA, '2026-05-25T12:00:00Z');
  const snapB = createSnapshot(db, pubB, '2026-05-25T12:00:00Z');
  const beerA = upsertBeer(db, {
    untappd_id: 1, name: 'Atak Chmielu', brewery: 'Pinta', style: 'AIPA',
    abv: 6.1, rating_global: 3.85,
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
  });
  const beerB = upsertBeer(db, {
    untappd_id: 2, name: 'Buty Skejta', brewery: 'Stu Mostow', style: 'Pils',
    abv: 5.0, rating_global: 3.5,
    normalized_name: 'buty skejta', normalized_brewery: 'stu mostow',
  });
  upsertMatch(db, 'PINTA Atak Chmielu', beerA, 1.0);
  upsertMatch(db, 'Stu Mostow Buty Skejta', beerB, 1.0);
  insertTaps(db, snapA, [{
    tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA',
    abv: 6.1, ibu: null, style: 'AIPA', u_rating: 3.9,
  }]);
  insertTaps(db, snapB, [{
    tap_number: 1, beer_ref: 'Stu Mostow Buty Skejta', brewery_ref: 'Stu Mostow',
    abv: 5.0, ibu: null, style: 'Pils', u_rating: 3.7,
  }]);
}

describe('buildNewbeersMessage', () => {
  test('returns kind=empty when there are no snapshots at all', () => {
    const db = fresh();
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toEqual({ kind: 'empty' });
  });

  test('returns kind=empty when snapshots exist but no tap survives filtering', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'P', address: null, lat: null, lon: null });
    const snapId = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    void snapId; // no taps inserted
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toEqual({ kind: 'empty' });
  });

  test('returns kind=ok with HTML containing the beer when a matched tap exists', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return; // type narrow
    expect(out.html).toContain('Atak Chmielu');
    expect(out.html).toContain('Pub A');
    expect(out.html).toContain('Buty Skejta');
    expect(out.html).toContain('Pub B');
  });

  test('returns kind=empty when the user has already tried (triedBeerIds) the only tap', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 200, name: 'Buty Skejta', brewery: 'Stu Mostow', style: 'Pils',
      abv: 5.0, rating_global: 3.5,
      normalized_name: 'buty skejta', normalized_brewery: 'stu mostow',
    });
    upsertMatch(db, 'Stu Mostow Buty Skejta', beerId, 1.0);
    insertTaps(db, snapId, [{
      tap_number: 1, beer_ref: 'Stu Mostow Buty Skejta', brewery_ref: 'Stu Mostow',
      abv: 5.0, ibu: null, style: 'Pils', u_rating: 3.7,
    }]);
    db.prepare(
      'INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)',
    ).run(1, beerId, '2026-05-25T11:00:00Z');
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toEqual({ kind: 'empty' });
  });

  test('pubQuery="A" (case-insensitive substring) keeps only Pub A', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: 'A' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('Atak Chmielu');
    expect(out.html).toContain('Pub A');
    expect(out.html).not.toContain('Buty Skejta');
    expect(out.html).not.toContain('Pub B');
  });

  test('pubQuery matching several pubs groups them into one entry per beer', () => {
    const db = fresh();
    const pubX = upsertPub(db, { slug: 'pub-x', name: 'Pub X', address: null, lat: null, lon: null });
    const pubY = upsertPub(db, { slug: 'pub-y', name: 'Pub Y', address: null, lat: null, lon: null });
    const snapX = createSnapshot(db, pubX, '2026-05-25T12:00:00Z');
    const snapY = createSnapshot(db, pubY, '2026-05-25T12:00:00Z');
    const beer = upsertBeer(db, {
      untappd_id: 50, name: 'Shared Brew', brewery: 'Co-op', style: 'IPA',
      abv: 6.0, rating_global: 3.7,
      normalized_name: 'shared brew', normalized_brewery: 'co op',
    });
    upsertMatch(db, 'Co-op Shared Brew', beer, 1.0);
    for (const snapId of [snapX, snapY]) {
      insertTaps(db, snapId, [{
        tap_number: 1, beer_ref: 'Co-op Shared Brew', brewery_ref: 'Co-op',
        abv: 6.0, ibu: null, style: 'IPA', u_rating: 3.7,
      }]);
    }

    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: 'Pub' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('Shared Brew');
    expect(out.html).toContain('Pub X');
    expect(out.html).toContain('Pub Y');
  });

  test('pubQuery with no match returns kind=pub_not_found preserving the original query', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: 'nonexistent' });
    expect(out).toEqual({ kind: 'pub_not_found', query: 'nonexistent' });
  });

  test('whitespace-only pubQuery is treated as no filter', () => {
    const db = fresh();
    seedTwoPubs(db);
    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t, pubQuery: '   ' });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Both pubs visible — same as no-arg call.
    expect(out.html).toContain('Pub A');
    expect(out.html).toContain('Pub B');
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails**

Run: `npm test -- --testPathPatterns=newbeers-build --silent`
Expected: FAIL — type errors on the `.kind`/`.html` access, plus assertion failures because the production code still returns `string | null`.

- [ ] **Step 3: Update `newbeers-build.ts`**

Overwrite `src/bot/commands/newbeers-build.ts` with:

```typescript
import type { DB } from '../../storage/db';
import type { Locale, Translator } from '../../i18n/types';
import { latestSnapshotsPerPub, tapsForSnapshotWithBeer } from '../../storage/snapshots';
import { triedBeerIds } from '../../storage/untappd_had';
import { getFilters } from '../../storage/user_filters';
import { filterInteresting } from '../../domain/filters';
import { listPubs } from '../../storage/pubs';
import { normalizeBrewery, normalizeName } from '../../domain/normalize';
import {
  groupTaps,
  rankGroups,
  formatGroupedBeers,
  type CandidateTap,
} from './newbeers-format';

export interface NewbeersDeps {
  db: DB;
  telegramId: number;
  locale: Locale;
  t: Translator;
  pubQuery?: string;
}

export type NewbeersResult =
  | { kind: 'ok'; html: string }
  | { kind: 'empty' }
  | { kind: 'pub_not_found'; query: string };

export function buildNewbeersMessage(deps: NewbeersDeps): NewbeersResult {
  const { db, telegramId, locale, t } = deps;
  const tried = triedBeerIds(db, telegramId);
  const filters =
    getFilters(db, telegramId) ?? {
      styles: [],
      min_rating: null,
      abv_min: null,
      abv_max: null,
      default_route_n: null,
    };
  const pubs = new Map(listPubs(db).map((p) => [p.id, p]));

  const q = deps.pubQuery?.trim().toLowerCase();
  let matchedIds: Set<number> | null = null;
  if (q) {
    const matched = [...pubs.values()].filter((p) => p.name.toLowerCase().includes(q));
    if (matched.length === 0) {
      return { kind: 'pub_not_found', query: deps.pubQuery! };
    }
    matchedIds = new Set(matched.map((p) => p.id));
  }

  const candidates: CandidateTap[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
    if (matchedIds && !matchedIds.has(snap.pub_id)) continue;
    const pub = pubs.get(snap.pub_id);
    if (!pub) continue;
    const taps = tapsForSnapshotWithBeer(db, snap.id);
    const good = filterInteresting(taps, tried, filters);
    for (const tap of good) {
      const display = tap.brewery_ref ? `${tap.brewery_ref} ${tap.beer_ref}`.trim() : tap.beer_ref;
      candidates.push({
        beer_id: tap.beer_id,
        display,
        brewery_norm: normalizeBrewery(tap.brewery_ref ?? ''),
        name_norm: normalizeName(tap.beer_ref),
        abv: tap.abv,
        rating: tap.u_rating,
        pub_name: pub.name,
      });
    }
  }

  const text = formatGroupedBeers(rankGroups(groupTaps(candidates)), locale, t);
  return text ? { kind: 'ok', html: text } : { kind: 'empty' };
}
```

- [ ] **Step 4: Run the test — newbeers-build passes, full project does NOT yet compile**

Run: `npm test -- --testPathPatterns=newbeers-build --silent`
Expected: 8 passing tests.

Run: `npm run typecheck`
Expected: FAIL — `newbeers.ts` handler does `text ?? ctx.t('newbeers.empty')` against an object, and `refresh.ts` declares `postRun?: (deps) => string | null` which no longer matches `buildNewbeersMessage`. We fix these next.

- [ ] **Step 5: Update `newbeers.ts` handler**

Overwrite `src/bot/commands/newbeers.ts` with:

```typescript
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildNewbeersMessage } from './newbeers-build';

export const newbeersCommand = new Composer<BotContext>();

newbeersCommand.command('newbeers', async (ctx) => {
  const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
  const result = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
    pubQuery: arg || undefined,
  });
  switch (result.kind) {
    case 'ok':
      await ctx.replyWithHTML(result.html);
      return;
    case 'empty':
      await ctx.reply(ctx.t('newbeers.empty'));
      return;
    case 'pub_not_found':
      await ctx.reply(ctx.t('newbeers.pub_not_found', { query: result.query }));
      return;
  }
});
```

- [ ] **Step 6: Update `refresh.ts`**

In `src/bot/commands/refresh.ts`, find this import block (line 6):

```typescript
import type { NewbeersDeps } from './newbeers-build';
```

Replace with:

```typescript
import type { NewbeersDeps, NewbeersResult } from './newbeers-build';
```

Then find the `createRefreshCommand` signature (lines 54-57):

```typescript
export function createRefreshCommand(
  run: (notify: ProgressFn) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => string | null,
) {
```

Replace with:

```typescript
export function createRefreshCommand(
  run: (notify: ProgressFn) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
```

Then find the postRun closure (lines 86-93):

```typescript
    const postRunClosure = postRun
      ? async () => {
          const text = postRun({ db, telegramId, locale, t });
          if (text) {
            await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
          }
        }
      : undefined;
```

Replace with:

```typescript
    const postRunClosure = postRun
      ? async () => {
          const result = postRun({ db, telegramId, locale, t });
          if (result.kind === 'ok') {
            await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
          }
        }
      : undefined;
```

- [ ] **Step 7: Run the full suite + typecheck**

```bash
npm test -- --silent
npm run typecheck
```

Expected: both exit 0. The `runRefreshPipeline` tests in `refresh.test.ts` operate on the inner `() => Promise<void>` signature (unchanged) and are unaffected.

- [ ] **Step 8: Verify no leftover string|null usage**

Run: `grep -n "string | null" src/bot/commands/refresh.ts src/bot/commands/newbeers-build.ts src/bot/commands/newbeers.ts || echo "OK: no string|null references"`
Expected: `OK: no string|null references`.

- [ ] **Step 9: Commit**

```bash
git add src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts \
        src/bot/commands/newbeers.ts src/bot/commands/refresh.ts
git commit -m "$(cat <<'EOF'
feat(newbeers): pubQuery filter + NewbeersResult discriminated union

buildNewbeersMessage now accepts an optional pubQuery (case-insensitive
substring of pub.name, trim, whitespace-only treated as unset) and
returns a NewbeersResult tagged union ('ok' | 'empty' | 'pub_not_found')
so the handler can produce a targeted error on unknown pubs instead of
collapsing it into the generic empty-fallback. /newbeers parses a
positional arg (everything after the command, like /link) and switches
on result.kind. /refresh autorun adapts to the new shape and remains
aggregated — it never passes pubQuery, so pub_not_found cannot fire
from there.

Single commit because the return-type change is breaking; intermediate
revisions would not compile.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `/pubs` command

**Files:**
- Create: `src/bot/commands/pubs-build.ts`
- Create: `src/bot/commands/pubs-build.test.ts`
- Create: `src/bot/commands/pubs.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test file**

Create `src/bot/commands/pubs-build.test.ts`:

```typescript
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createTranslator } from '../../i18n';
import { buildPubsMessage } from './pubs-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('buildPubsMessage', () => {
  test('returns the pubs.empty fallback when there are no pubs', () => {
    const db = fresh();
    const t = createTranslator('uk');
    const out = buildPubsMessage({ db, t });
    expect(out).toBe(t('pubs.empty'));
  });

  test('lists pubs alphabetically with header and hint', () => {
    const db = fresh();
    // Insert in non-alphabetical order to prove the sort.
    upsertPub(db, { slug: 'cuda', name: 'Cuda', address: null, lat: null, lon: null });
    upsertPub(db, { slug: 'bar',  name: 'Bar',  address: null, lat: null, lon: null });
    upsertPub(db, { slug: 'alfa', name: 'Alfa', address: null, lat: null, lon: null });

    const t = createTranslator('uk');
    const out = buildPubsMessage({ db, t });

    expect(out).toContain(t('pubs.header'));
    expect(out).toContain(t('pubs.hint'));
    expect(out).toContain('Alfa');
    expect(out).toContain('Bar');
    expect(out).toContain('Cuda');
    // Order check: each later pub must appear after the previous.
    expect(out.indexOf('Alfa')).toBeLessThan(out.indexOf('Bar'));
    expect(out.indexOf('Bar')).toBeLessThan(out.indexOf('Cuda'));
  });

  test('HTML-escapes pub names containing special characters', () => {
    const db = fresh();
    upsertPub(db, { slug: 'tricky', name: 'Cuda & <Co>', address: null, lat: null, lon: null });
    const t = createTranslator('uk');
    const out = buildPubsMessage({ db, t });
    expect(out).toContain('Cuda &amp; &lt;Co&gt;');
    expect(out).not.toContain('Cuda & <Co>');
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails on missing module**

Run: `npm test -- --testPathPatterns=pubs-build --silent`
Expected: FAIL — `Cannot find module './pubs-build'`.

- [ ] **Step 3: Create the implementation**

Create `src/bot/commands/pubs-build.ts`:

```typescript
import type { DB } from '../../storage/db';
import type { Translator } from '../../i18n/types';
import { listPubs } from '../../storage/pubs';
import { escapeHtml } from './newbeers-format';

export interface PubsDeps {
  db: DB;
  t: Translator;
}

export function buildPubsMessage(deps: PubsDeps): string {
  const pubs = listPubs(deps.db).sort((a, b) => a.name.localeCompare(b.name));
  if (pubs.length === 0) return deps.t('pubs.empty');
  const lines = pubs.map((p) => `• ${escapeHtml(p.name)}`);
  return [deps.t('pubs.header'), '', ...lines, '', deps.t('pubs.hint')].join('\n');
}
```

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npm test -- --testPathPatterns=pubs-build --silent`
Expected: 3 passing tests.

- [ ] **Step 5: Create the command wrapper**

Create `src/bot/commands/pubs.ts`:

```typescript
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildPubsMessage } from './pubs-build';

export const pubsCommand = new Composer<BotContext>();

pubsCommand.command('pubs', async (ctx) => {
  const text = buildPubsMessage({ db: ctx.deps.db, t: ctx.t });
  await ctx.replyWithHTML(text);
});
```

- [ ] **Step 6: Register `pubsCommand` in `index.ts`**

In `src/index.ts`, find this line:

```typescript
import { newbeersCommand } from './bot/commands/newbeers';
```

Add directly below it:

```typescript
import { pubsCommand } from './bot/commands/pubs';
```

Then find the `bot.use(...)` block — locate the `newbeersCommand,` line and insert `pubsCommand,` directly after it:

```typescript
    newbeersCommand,
    pubsCommand,
    routeCommand,
```

- [ ] **Step 7: Typecheck + full suite + build**

```bash
npm run typecheck
npm test -- --silent
npm run build
```

Expected: all three exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/pubs-build.ts src/bot/commands/pubs-build.test.ts \
        src/bot/commands/pubs.ts src/index.ts
git commit -m "$(cat <<'EOF'
feat(pubs): /pubs command lists available pubs alphabetically

New discovery command: lists every pub.name from listPubs() sorted
alphabetically, with a header and a one-line hint pointing at
/newbeers <fragment>. HTML-escaped so future pub names with special
characters do not break parsing. Closes the discovery loop for
/newbeers's substring filter — newbeers.pub_not_found points at /pubs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: USER-GUIDE update

**Files:**
- Modify: `docs/USER-GUIDE.md` — append a paragraph to the `/newbeers` section (around line 102) and insert a new `### /pubs` section before `### /route [N]` (around line 103-104).

- [ ] **Step 1: Append a paragraph to the `/newbeers` section**

In `docs/USER-GUIDE.md`, find this line (currently line 101-102):

```
Фільтри з `/filters` (стиль, мінімальний рейтинг) застосовуються до
кандидатів *перед* групуванням.
```

Insert this new paragraph directly after it (BEFORE the blank line that precedes `### /route [N]`):

```markdown

`/newbeers <частина назви паба>` обмежує вивід пабами, чия назва
містить вказаний підрядок (case-insensitive). Якщо підрядок не матчить
жодного паба — бот про це скаже і запропонує `/pubs`. Поточні фільтри
з `/filters` далі застосовуються в межах матчених пабів.
```

- [ ] **Step 2: Add a new `### /pubs` section**

In `docs/USER-GUIDE.md`, find the line `### /route [N]` (currently line 104). Insert this block IMMEDIATELY BEFORE that heading:

```markdown
### `/pubs`
Алфавітний список усіх пабів, що бот про них знає. Корисно, коли треба
згадати, як саме пишеться назва — наприклад, щоб передати її як
аргумент у `/newbeers <назва>`.

```

(End with a blank line so `### /route [N]` is still preceded by a blank line.)

- [ ] **Step 3: Commit**

```bash
git add docs/USER-GUIDE.md
git commit -m "$(cat <<'EOF'
docs(user-guide): document /newbeers pub filter and /pubs

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: every test passes. Total = baseline 231 + 4 new newbeers-build + 3 new pubs-build = **238** tests across 36 suites.

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline origin/main..HEAD`
Expected: 4 commits in order:
1. `feat(i18n): add pubs.* + newbeers.pub_not_found keys; update app.start`
2. `feat(newbeers): pubQuery filter + NewbeersResult discriminated union`
3. `feat(pubs): /pubs command lists available pubs alphabetically`
4. `docs(user-guide): document /newbeers pub filter and /pubs`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff origin/main...HEAD --stat`
Expected files (11):
- `src/i18n/types.ts`
- `src/i18n/locales/uk.ts`
- `src/i18n/locales/pl.ts`
- `src/i18n/locales/en.ts`
- `src/bot/commands/newbeers-build.ts`
- `src/bot/commands/newbeers-build.test.ts`
- `src/bot/commands/newbeers.ts`
- `src/bot/commands/refresh.ts`
- `src/bot/commands/pubs.ts`
- `src/bot/commands/pubs-build.ts`
- `src/bot/commands/pubs-build.test.ts`
- `src/index.ts`
- `docs/USER-GUIDE.md`

(13 entries if you count locales separately — main point: no stray edits outside this set.)

---

## Task 7: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/newbeers-pub-filter
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: /newbeers <pub> filter + /pubs discovery" --body "$(cat <<'EOF'
## Summary
- `/newbeers <substring>` filters output to pubs whose name matches the substring (case-insensitive, trim). Persistent filters (rating/abv/styles) still apply.
- New `/pubs` command lists every pub alphabetically, with a usage hint.
- Widens `buildNewbeersMessage` return from `string | null` to a `NewbeersResult` discriminated union (`'ok' | 'empty' | 'pub_not_found'`) so `/newbeers cuda` against an unknown pub produces a targeted error instead of the generic empty fallback.
- `/refresh` autorun adapts to the new shape; remains aggregated (no `pubQuery`).
- i18n: 4 new keys × 3 locales; `app.start` updated to mention both new surfaces.

Implements `docs/superpowers/specs/2026-05-25-newbeers-pub-filter-design.md`.

## Test plan
- [x] `npm test` green locally (238 tests across 36 suites; +4 newbeers-build, +3 pubs-build vs main baseline of 231/35)
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [ ] After merge + deploy: `/pubs` returns the alphabetical list
- [ ] After merge + deploy: `/newbeers cuda` shows beers only from pubs matching "cuda" (case-insensitive)
- [ ] After merge + deploy: `/newbeers nonexistent` shows the pub-not-found message that references `/pubs`
- [ ] After merge + deploy: `/newbeers` without arg behaves unchanged (same output as before)
- [ ] After merge + deploy: `/refresh` autorun still sends the aggregated `/newbeers` HTML on success

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges; runtime verification happens post-deploy.

---

## What this plan does NOT cover

- **`/pubs` metadata** (snapshot age, tap counts) — YAGNI; revisit if discovery feels too thin in practice.
- **Inline-keyboard pub picker** — not requested.
- **Fuzzy/Levenshtein suggestions on no-match** — out of scope per spec.
- **`/route <pub>` filter** — future iteration.
- **Worktree teardown** — done after the PR merges (`git worktree remove /home/ysi/warsaw-beer-bot-pub-filter`).
