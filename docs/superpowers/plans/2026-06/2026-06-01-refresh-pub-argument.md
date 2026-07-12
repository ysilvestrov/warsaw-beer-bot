# `/refresh [паб]` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional pub-name argument to `/refresh` that refreshes only the matching pub(s) on ontap.pl (skipping the Untappd scrape), then replies with `/newbeers` scoped to the same query.

**Architecture:** Reuse `filterPubsByQuery` (the same name-first/address-tiebreaker matcher `/newbeers` uses) to turn the argument into a set of pub slugs. `refreshOntap` gains an optional `pubSlugs` filter applied to the parsed index. The command handler resolves the scope, picks one of two independent cooldown maps (5 min full / 30 s scoped), runs the pipeline ontap-only when scoped, and shows the scoped `/newbeers` result (including `empty`).

**Tech Stack:** Node.js, TypeScript, Telegraf, better-sqlite3, Jest.

---

## File Structure

- **Modify** `src/jobs/refresh-ontap.ts` — add `pubSlugs?: Set<string>` to `Deps`; new exported pure helper `filterIndexBySlugs`.
- **Modify** `src/jobs/refresh-ontap.test.ts` (**Create** — does not exist yet) — unit tests for `filterIndexBySlugs`.
- **Modify** `src/bot/commands/refresh.ts` — new exported pure helpers `resolveRefreshScope`, `checkAndStampCooldown`, `cooldownWindowFor`; updated `createRefreshCommand` `run` signature and handler.
- **Modify** `src/bot/commands/refresh.test.ts` — unit tests for the three new helpers.
- **Modify** `src/index.ts` — `run` closure honors `opts.pubSlugs` (ontap-only when set).
- **Modify** `docs/USER-GUIDE.md` — document the `/refresh <паб>` form.

Note: the spec calls for a "refreshOntap with pubSlugs visits only matched slugs" test. Rather than mock HTTP + craft fragile HTML fixtures, we extract the filter into the pure `filterIndexBySlugs` helper and test that directly — the per-pub loop simply iterates its output, so "visits only matched" and "progress denominator correct" both follow from the helper's return value.

---

## Task 1: `refreshOntap` accepts a `pubSlugs` filter

**Files:**
- Modify: `src/jobs/refresh-ontap.ts`
- Test: `src/jobs/refresh-ontap.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/jobs/refresh-ontap.test.ts`:

```ts
import { filterIndexBySlugs } from './refresh-ontap';
import type { IndexPub } from '../sources/ontap/index';

const idx: IndexPub[] = [
  { slug: 'bracka', name: 'Bracka 4', taps: 10 },
  { slug: 'piwpaw', name: 'PiwPaw', taps: 20 },
  { slug: 'kufle', name: 'Kufle i kapsle', taps: 30 },
];

describe('filterIndexBySlugs', () => {
  test('returns the full list unchanged when no slugs given', () => {
    expect(filterIndexBySlugs(idx, undefined)).toEqual(idx);
  });

  test('keeps only entries whose slug is in the set', () => {
    const out = filterIndexBySlugs(idx, new Set(['piwpaw', 'kufle']));
    expect(out.map((p) => p.slug)).toEqual(['piwpaw', 'kufle']);
  });

  test('empty set yields empty list', () => {
    expect(filterIndexBySlugs(idx, new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/jobs/refresh-ontap.test.ts`
Expected: FAIL — `filterIndexBySlugs` is not exported / not a function.

- [ ] **Step 3: Add the helper and wire it in**

In `src/jobs/refresh-ontap.ts`, confirm `IndexPub` is importable (it is exported from `../sources/ontap/index`). Add the import for the type at the top alongside `parseWarsawIndex`:

```ts
import { parseWarsawIndex, type IndexPub } from '../sources/ontap/index';
```

Add the exported helper (place it near the bottom, beside `listBeerCatalog`):

```ts
export function filterIndexBySlugs(
  pubs: IndexPub[],
  slugs: Set<string> | undefined,
): IndexPub[] {
  if (!slugs) return pubs;
  return pubs.filter((p) => slugs.has(p.slug));
}
```

Add `pubSlugs` to the `Deps` interface:

```ts
interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  geocoder: Geocoder;
  onProgress?: ProgressFn;
  lookupEnabled?: boolean;     // default true
  lookupSleepMs?: number;       // default 500
  now?: () => Date;             // for tests
  pubSlugs?: Set<string>;       // when set, refresh only these pubs (scoped /refresh)
}
```

Destructure it and apply the filter right after parsing the index. Replace:

```ts
  const indexHtml = await http.get('https://ontap.pl/warszawa');
  const indexPubs = parseWarsawIndex(indexHtml);
  log.info({ n: indexPubs.length }, 'ontap index parsed');
```

with:

```ts
  const indexHtml = await http.get('https://ontap.pl/warszawa');
  const indexPubs = filterIndexBySlugs(parseWarsawIndex(indexHtml), deps.pubSlugs);
  log.info({ n: indexPubs.length, scoped: deps.pubSlugs != null }, 'ontap index parsed');
```

(`deps` is already in scope — the function signature is `refreshOntap(deps: Deps)` and destructures select fields; reference `deps.pubSlugs` directly without adding it to the destructure if you prefer, but adding it to the destructure is fine too. Use `deps.pubSlugs` in both the filter and the log to avoid an unused-var lint.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/jobs/refresh-ontap.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/refresh-ontap.ts src/jobs/refresh-ontap.test.ts
git commit -m "feat(refresh-ontap): pubSlugs filter to scope the sweep to selected pubs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `resolveRefreshScope` — turn the argument into a scope

**Files:**
- Modify: `src/bot/commands/refresh.ts`
- Test: `src/bot/commands/refresh.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/bot/commands/refresh.test.ts`:

```ts
import { resolveRefreshScope } from './refresh';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';

function dbWithPubs() {
  const db = openDb(':memory:');
  migrate(db);
  upsertPub(db, { slug: 'bracka', name: 'Bracka 4', address: 'Bracka 4', lat: null, lon: null });
  upsertPub(db, { slug: 'piwpaw', name: 'PiwPaw', address: 'Foksal 16', lat: null, lon: null });
  upsertPub(db, { slug: 'piwpaw-bis', name: 'PiwPaw Bis', address: 'Żurawia 32', lat: null, lon: null });
  return db;
}

describe('resolveRefreshScope', () => {
  test('empty argument → all', () => {
    const db = dbWithPubs();
    expect(resolveRefreshScope(db, '')).toEqual({ kind: 'all' });
    expect(resolveRefreshScope(db, '   ')).toEqual({ kind: 'all' });
  });

  test('argument matching exactly one pub → scoped with that slug', () => {
    const db = dbWithPubs();
    const scope = resolveRefreshScope(db, 'bracka');
    expect(scope).toEqual({ kind: 'scoped', slugs: new Set(['bracka']), query: 'bracka' });
  });

  test('argument matching several pubs → scoped with all their slugs', () => {
    const db = dbWithPubs();
    const scope = resolveRefreshScope(db, 'piwpaw');
    expect(scope.kind).toBe('scoped');
    if (scope.kind !== 'scoped') throw new Error('expected scoped');
    expect(scope.slugs).toEqual(new Set(['piwpaw', 'piwpaw-bis']));
  });

  test('argument matching nothing → pub_not_found', () => {
    const db = dbWithPubs();
    expect(resolveRefreshScope(db, 'nonexistent')).toEqual({
      kind: 'pub_not_found',
      query: 'nonexistent',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/commands/refresh.test.ts -t resolveRefreshScope`
Expected: FAIL — `resolveRefreshScope` is not exported.

- [ ] **Step 3: Implement `resolveRefreshScope`**

In `src/bot/commands/refresh.ts`, add imports at the top:

```ts
import type { DB } from '../../storage/db';
import { listPubs } from '../../storage/pubs';
import { filterPubsByQuery } from './newbeers-build';
```

Add the type and function (place above `createRefreshCommand`):

```ts
export type RefreshScope =
  | { kind: 'all' }
  | { kind: 'scoped'; slugs: Set<string>; query: string }
  | { kind: 'pub_not_found'; query: string };

export function resolveRefreshScope(db: DB, arg: string): RefreshScope {
  const query = arg.trim();
  if (!query) return { kind: 'all' };
  const matched = filterPubsByQuery(listPubs(db), query);
  if (matched.length === 0) return { kind: 'pub_not_found', query };
  return { kind: 'scoped', slugs: new Set(matched.map((p) => p.slug)), query };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/bot/commands/refresh.test.ts -t resolveRefreshScope`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/refresh.ts src/bot/commands/refresh.test.ts
git commit -m "feat(refresh): resolveRefreshScope — map argument to pub slugs via shared matcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Independent cooldown helpers

**Files:**
- Modify: `src/bot/commands/refresh.ts`
- Test: `src/bot/commands/refresh.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/bot/commands/refresh.test.ts`:

```ts
import { checkAndStampCooldown, cooldownWindowFor } from './refresh';

describe('cooldownWindowFor', () => {
  test('full refresh → 5 minutes', () => {
    expect(cooldownWindowFor('all')).toBe(5 * 60 * 1000);
  });
  test('scoped refresh → 30 seconds', () => {
    expect(cooldownWindowFor('scoped')).toBe(30 * 1000);
  });
});

describe('checkAndStampCooldown', () => {
  test('first call allowed and stamps the map', () => {
    const map = new Map<number, number>();
    expect(checkAndStampCooldown(map, 42, 1000, 5000)).toBe(true);
    expect(map.get(42)).toBe(5000);
  });

  test('second call within the window is blocked', () => {
    const map = new Map<number, number>();
    checkAndStampCooldown(map, 42, 1000, 5000);
    expect(checkAndStampCooldown(map, 42, 1000, 5500)).toBe(false);
  });

  test('call after the window is allowed again', () => {
    const map = new Map<number, number>();
    checkAndStampCooldown(map, 42, 1000, 5000);
    expect(checkAndStampCooldown(map, 42, 1000, 6001)).toBe(true);
  });

  test('separate maps do not interfere', () => {
    const full = new Map<number, number>();
    const scoped = new Map<number, number>();
    checkAndStampCooldown(full, 42, 300000, 1000);
    // full is now in cooldown, but the scoped map is untouched
    expect(checkAndStampCooldown(scoped, 42, 30000, 1000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/commands/refresh.test.ts -t cooldown`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the helpers**

In `src/bot/commands/refresh.ts`, replace the existing constants/map:

```ts
const COOLDOWN_MS = 5 * 60 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastCall = new Map<number, number>();
```

with:

```ts
const FULL_COOLDOWN_MS = 5 * 60 * 1000;
const SCOPED_COOLDOWN_MS = 30 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastFullCall = new Map<number, number>();
const lastScopedCall = new Map<number, number>();

export function cooldownWindowFor(kind: 'all' | 'scoped'): number {
  return kind === 'all' ? FULL_COOLDOWN_MS : SCOPED_COOLDOWN_MS;
}

// Returns true if the call is allowed (and stamps `now`), false if still
// inside the cooldown window. Pure: caller supplies the map and clock.
export function checkAndStampCooldown(
  map: Map<number, number>,
  id: number,
  windowMs: number,
  now: number,
): boolean {
  const prev = map.get(id) ?? 0;
  if (now - prev < windowMs) return false;
  map.set(id, now);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/bot/commands/refresh.test.ts -t cooldown`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/refresh.ts src/bot/commands/refresh.test.ts
git commit -m "feat(refresh): independent full/scoped cooldown helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the argument through the command handler

**Files:**
- Modify: `src/bot/commands/refresh.ts`

This task has no new unit test — `createRefreshCommand` builds a Telegraf handler that the existing suite does not exercise (it tests pure helpers only). Correctness is covered by Tasks 1–3 helpers plus the manual run in Task 6's verification and the full `npm test`.

- [ ] **Step 1: Update the `run` signature on `createRefreshCommand`**

Replace the signature:

```ts
export function createRefreshCommand(
  run: (notify: ProgressFn) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
```

with:

```ts
export function createRefreshCommand(
  run: (notify: ProgressFn, opts?: { pubSlugs?: Set<string> }) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => NewbeersResult,
) {
```

- [ ] **Step 2: Rewrite the handler body**

Replace the whole `cmd.command('refresh', async (ctx) => { ... });` block with:

```ts
  cmd.command('refresh', async (ctx) => {
    const arg = ctx.message.text.split(' ').slice(1).join(' ').trim();
    const scope = resolveRefreshScope(ctx.deps.db, arg);

    if (scope.kind === 'pub_not_found') {
      await ctx.reply(ctx.t('newbeers.pub_not_found', { query: scope.query }));
      return;
    }

    const cooldownMap = scope.kind === 'all' ? lastFullCall : lastScopedCall;
    const allowed = checkAndStampCooldown(
      cooldownMap,
      ctx.from.id,
      cooldownWindowFor(scope.kind),
      Date.now(),
    );
    if (!allowed) {
      await ctx.reply(ctx.t('refresh.cooldown'));
      return;
    }

    const status = await ctx.reply(ctx.t('refresh.starting'));
    const chatId = ctx.chat.id;
    const messageId = status.message_id;
    const telegram = ctx.telegram;
    const log = ctx.deps.log;
    const t = ctx.t;
    const db = ctx.deps.db;
    const telegramId = ctx.from.id;
    const locale = ctx.locale;
    const pubSlugs = scope.kind === 'scoped' ? scope.slugs : undefined;
    const pubQuery = scope.kind === 'scoped' ? scope.query : undefined;

    const notify = makeThrottledProgress(
      async (text) => {
        await telegram
          .editMessageText(chatId, messageId, undefined, text)
          .catch(() => {});
      },
      PROGRESS_MIN_INTERVAL_MS,
    );

    const postRunClosure = postRun
      ? async () => {
          const result = postRun({ db, telegramId, locale, t, pubQuery });
          if (result.kind === 'ok') {
            await telegram.sendMessage(chatId, result.html, { parse_mode: 'HTML' });
          } else if (result.kind === 'empty' && pubSlugs) {
            // Scoped refresh: the user asked about a specific pub, so a silent
            // "nothing new" would be confusing. Full refresh stays silent on
            // empty to avoid spamming after a successful city-wide sweep.
            await telegram.sendMessage(chatId, t('newbeers.empty'));
          }
          // 'pub_not_found' cannot occur here: a non-matching query was already
          // short-circuited above before any refresh started.
        }
      : undefined;

    // Detach the work: the refresh sweep takes minutes, but Telegraf's
    // handlerTimeout (default 90s) would otherwise kill the handler and
    // raise TimeoutError into bot.catch. Captured locals above keep the
    // background promise independent of ctx's lifetime.
    void runRefreshPipeline({
      run: (n) => run(n, { pubSlugs }),
      notify,
      t,
      log,
      postRun: postRunClosure,
    });
  });
```

Note: `runRefreshPipeline`'s `run` is `(notify) => Promise<void>`, so we adapt by passing `(n) => run(n, { pubSlugs })`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. (If `ctx.message.text` errors, mirror `newbeers.ts` which uses the same expression — the `BotContext` command update is narrowed the same way there.)

- [ ] **Step 4: Run the full refresh test file**

Run: `npx jest src/bot/commands/refresh.test.ts`
Expected: PASS (all existing + new helper tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/refresh.ts
git commit -m "feat(refresh): wire pub argument — scoped cooldown, ontap-only run, scoped newbeers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `index.ts` run closure honors `opts.pubSlugs`

**Files:**
- Modify: `src/index.ts:68-79`

- [ ] **Step 1: Update the `run` closure**

Replace:

```ts
    createRefreshCommand(
      async (notify) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        });
        if (untappdHttp) {
          await refreshAllUntappd({ db, log, http: untappdHttp, onProgress: notify, notifyAdmin });
        }
      },
      buildNewbeersMessage,
    ),
```

with:

```ts
    createRefreshCommand(
      async (notify, opts) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
          pubSlugs: opts?.pubSlugs,
        });
        // Scoped refresh (a specific pub) is ontap-only: the Untappd had-list
        // is not pub-specific and is refreshed daily + on a full /refresh.
        if (!opts?.pubSlugs && untappdHttp) {
          await refreshAllUntappd({ db, log, http: untappdHttp, onProgress: notify, notifyAdmin });
        }
      },
      buildNewbeersMessage,
    ),
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: exit 0.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all suites pass.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(refresh): ontap-only pipeline when /refresh is scoped to a pub

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Document `/refresh <паб>` in the user guide

**Files:**
- Modify: `docs/USER-GUIDE.md` (the `### /refresh` section, ~line 215)

- [ ] **Step 1: Extend the `/refresh` section**

After the existing intro line of the `### /refresh` section ("Примусово запускає обидва пайплайни прямо зараз:" and its numbered list), add a subsection describing the argument. Insert before the cooldown line ("**Кулдаун:** 5 хв на користувача…"):

```markdown
**`/refresh <частина назви паба>`** оновлює лише крани матчених пабів на
ontap.pl (Untappd-скрейп пропускається — had-список не залежить від паба) і
одразу показує `/newbeers` по тому ж запиту. Паб шукається так само, як у
`/newbeers <назва>` (спершу за назвою, потім уточнення за адресою); якщо запит
підходить кільком пабам — оновлюються всі. Якщо жоден не підійшов — бот скаже
про це й запропонує `/pubs`, refresh не стартує.
```

Then update the cooldown line to mention both windows:

Replace:

```markdown
**Кулдаун:** 5 хв на користувача — щоб не довбати джерела.
```

with:

```markdown
**Кулдаун:** повний `/refresh` — 5 хв на користувача; скоупнутий
`/refresh <паб>` має окремий, коротший кулдаун 30 с (він дешевий — лише
матчені паби), тож кілька пабів можна оновити поспіль.
```

- [ ] **Step 2: Commit**

```bash
git add docs/USER-GUIDE.md
git commit -m "docs(user-guide): document /refresh <pub> scoped form

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npm run typecheck` → exit 0
- [ ] `npm run build` → exit 0
- [ ] `npm test` → all suites pass
- [ ] Manual smoke (optional, needs a live token/db): `/refresh bracka` refreshes one pub and replies with a scoped `/newbeers`; `/refresh zzz` replies pub-not-found without starting a sweep; bare `/refresh` behaves as before.
