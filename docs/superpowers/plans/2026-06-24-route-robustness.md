# /route Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/route` un-hangable (cap N at 70 + bound the TSP solver with a heuristic fallback) and stop deploys from leaving frozen progress messages (a shutdown sweep that marks in-flight `/route` and `/refresh` progress messages as interrupted).

**Architecture:** Bug 1 lives in the pure `domain/router.ts` (a size-dispatching `solveTour` replaces the unbounded exact Held-Karp) plus a tiny clamp in the `route.ts` command. Bug 2 adds a process-wide registry (`bot/active-progress.ts`) that the two fire-and-forget commands register with and that the graceful-shutdown path sweeps.

**Tech Stack:** TypeScript, Telegraf, Vitest.

---

## File Structure

**Create:**
- `src/bot/active-progress.ts` — registry of in-flight progress messages + shutdown sweep.
- `src/bot/active-progress.test.ts` — registry unit tests.

**Modify:**
- `src/domain/router.ts` — add `solveTour` (Held-Karp ≤12, else nearest-neighbour + 2-opt); route the 3 `openTsp` call sites through it.
- `src/domain/router.test.ts` — add a large-`|S|` no-blowup test.
- `src/bot/commands/route.ts` — `clampRouteN` + `MAX_ROUTE_N`; track/release progress.
- `src/bot/commands/route.test.ts` — `clampRouteN` tests.
- `src/bot/commands/refresh.ts` — track/release progress around the detached pipeline.
- `src/i18n/types.ts`, `src/i18n/locales/{en,uk,pl}.ts` — `common.interrupted_by_restart`.
- `src/shutdown.ts` — optional `interruptActiveProgress` hook, called early.
- `src/index.ts` — wire the hook with `bot.telegram` + `createTranslator`.
- `spec.md` — `/route` section.

---

### Task 1: Bound the TSP solver (`solveTour`)

**Files:**
- Modify: `src/domain/router.ts`
- Modify: `src/domain/router.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/domain/router.test.ts`, add after the existing `buildRoute` tests (after the
`'handles partial coverage when N > union'` test):

```ts
test('does not blow up for a large selected set (heuristic path)', () => {
  // 20 pubs, each with a distinct interesting beer, spread on a line.
  // N=20 forces greedySetCover to pick all 20 → |S|=20 > Held-Karp cap → heuristic.
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    lat: 0,
    lon: i * 0.01,
    interesting: new Set([100 + i]),
  }));
  const start = Date.now();
  const r = buildRoute(many, 20, { distance: haversineMeters });
  expect(Date.now() - start).toBeLessThan(2000); // would be minutes with exact DP
  expect(r.pubIds.length).toBe(20);
  expect(new Set(r.pubIds).size).toBe(20); // every pub exactly once
  expect(Number.isFinite(r.distanceMeters)).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/router.test.ts`
Expected: FAIL — exact Held-Karp on 20 nodes allocates `2^20` arrays; the test either
times out or exhausts memory (it does **not** finish under 2 s).

- [ ] **Step 3: Add the heuristic + dispatcher in `router.ts`**

In `src/domain/router.ts`, add a `HELD_KARP_MAX` constant near the top (after the
`RouteOpts` interface, before `haversineMeters`):

```ts
// Exact Held-Karp is O(2^k · k²); only use it for small selected sets. Above this
// many pubs, fall back to a polynomial nearest-neighbour + 2-opt heuristic.
const HELD_KARP_MAX = 12;
```

Then add these two functions immediately **after** the existing `openTsp` function (after its
closing brace, before `createOsrmDistance`):

```ts
function nearestNeighbourTwoOpt(
  pubs: RoutePub[],
  opts: RouteOpts,
): { order: RoutePub[]; distance: number } {
  const n = pubs.length;
  if (n <= 1) return { order: pubs, distance: 0 };

  const dist: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? 0 : opts.distance([pubs[i].lat, pubs[i].lon], [pubs[j].lat, pubs[j].lon]),
    ),
  );
  const pathLen = (ord: number[]): number => {
    let s = 0;
    for (let i = 0; i + 1 < ord.length; i++) s += dist[ord[i]][ord[i + 1]];
    return s;
  };

  // Nearest-neighbour construction from node 0.
  const visited = new Array(n).fill(false);
  let cur = 0;
  visited[0] = true;
  let order = [0];
  for (let k = 1; k < n; k++) {
    let best = -1;
    let bd = Infinity;
    for (let j = 0; j < n; j++) if (!visited[j] && dist[cur][j] < bd) { bd = dist[cur][j]; best = j; }
    order.push(best);
    visited[best] = true;
    cur = best;
  }

  // 2-opt on the open path; bounded number of sweeps.
  for (let sweep = 0; sweep < n; sweep++) {
    let improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const cand = [...order.slice(0, i), ...order.slice(i, k + 1).reverse(), ...order.slice(k + 1)];
        if (pathLen(cand) < pathLen(order) - 1e-9) { order = cand; improved = true; }
      }
    }
    if (!improved) break;
  }

  return { order: order.map((i) => pubs[i]), distance: pathLen(order) };
}

function solveTour(pubs: RoutePub[], opts: RouteOpts): { order: RoutePub[]; distance: number } {
  return pubs.length <= HELD_KARP_MAX ? openTsp(pubs, opts) : nearestNeighbourTwoOpt(pubs, opts);
}
```

- [ ] **Step 4: Route the 3 `openTsp` call sites through `solveTour`**

In `src/domain/router.ts`, change the three `openTsp(` calls (NOT the `function openTsp`
definition) to `solveTour(`:

(a) In `buildRoute`:
```ts
  const tour = openTsp(improved, opts);
```
→
```ts
  const tour = solveTour(improved, opts);
```

(b) In `localSwapForDistance`, the initial best distance:
```ts
  let best = selected; let bestDist = openTsp(best, opts).distance;
```
→
```ts
  let best = selected; let bestDist = solveTour(best, opts).distance;
```

(c) In `localSwapForDistance`, inside the loop:
```ts
        const d = openTsp(trial, opts).distance;
```
→
```ts
        const d = solveTour(trial, opts).distance;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/domain/router.test.ts`
Expected: PASS — the new large-set test finishes well under 2 s; the existing small-`n`
optimality tests are unchanged (those sets are `≤ 12`, so they still use exact Held-Karp).

- [ ] **Step 6: Commit**

```bash
git add src/domain/router.ts src/domain/router.test.ts
git commit -m "fix(route): bound TSP solver — heuristic above 12 pubs, no exponential blowup (#193 follow-up)"
```

---

### Task 2: Clamp N at the command (`MAX_ROUTE_N = 70`)

**Files:**
- Modify: `src/bot/commands/route.ts`
- Modify: `src/bot/commands/route.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/bot/commands/route.test.ts`, add (top-level, alongside existing tests — check the
existing import line and extend it):

```ts
import { clampRouteN, MAX_ROUTE_N } from './route';

describe('clampRouteN', () => {
  it('passes small positive N through', () => {
    expect(clampRouteN(5)).toBe(5);
  });
  it('caps N at MAX_ROUTE_N', () => {
    expect(clampRouteN(200)).toBe(MAX_ROUTE_N);
    expect(MAX_ROUTE_N).toBe(70);
  });
  it('floors N to at least 1', () => {
    expect(clampRouteN(0)).toBe(1);
    expect(clampRouteN(-4)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/bot/commands/route.test.ts`
Expected: FAIL — `clampRouteN` / `MAX_ROUTE_N` are not exported yet.

- [ ] **Step 3: Add `clampRouteN` and apply it**

In `src/bot/commands/route.ts`, add near the top after `const PROGRESS_MIN_INTERVAL_MS = 2000;`:

```ts
export const MAX_ROUTE_N = 70;

// Clamp the requested coverage to a sane range. Beyond MAX_ROUTE_N the route would
// span dozens of pubs and the tour search gets expensive; below 1 is meaningless.
export function clampRouteN(n: number): number {
  return Math.min(Math.max(1, Math.floor(n)), MAX_ROUTE_N);
}
```

Then wrap the `N` computation in the handler. Find:

```ts
  const N =
    parseInt(arg ?? '', 10) ||
    getFilters(db, ctx.from.id)?.default_route_n ||
    ctx.deps.env.DEFAULT_ROUTE_N;
```

Replace with:

```ts
  const N = clampRouteN(
    parseInt(arg ?? '', 10) ||
      getFilters(db, ctx.from.id)?.default_route_n ||
      ctx.deps.env.DEFAULT_ROUTE_N,
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/bot/commands/route.test.ts && npm run typecheck`
Expected: PASS — `clampRouteN` tests green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/route.ts src/bot/commands/route.test.ts
git commit -m "fix(route): clamp requested N to 1..70 (#193 follow-up)"
```

---

### Task 3: Active-progress registry module

**Files:**
- Create: `src/bot/active-progress.ts`
- Create: `src/bot/active-progress.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bot/active-progress.test.ts`:

```ts
import { trackProgress, interruptActiveProgress } from './active-progress';
import type { Locale } from '../i18n/types';

type EditCall = { chatId: number; messageId: number; text: string };

function fakeTelegram() {
  const calls: EditCall[] = [];
  const telegram = {
    editMessageText: async (chatId: number, messageId: number, _inline: undefined, text: string) => {
      calls.push({ chatId, messageId, text });
      return true as unknown;
    },
  };
  return { telegram, calls };
}

// Deterministic translator: returns the locale + key so assertions are locale-agnostic.
const fakeTranslator = (locale: Locale) => ((key: string) => `[${locale}]${key}`) as never;

describe('active-progress registry', () => {
  it('appends the interrupt suffix to each active message and clears the map', async () => {
    const h1 = trackProgress(111, 1, 'uk');
    const h2 = trackProgress(222, 2, 'en');
    h1.update('progress one');
    h2.update('progress two');

    const { telegram, calls } = fakeTelegram();
    await interruptActiveProgress(telegram, fakeTranslator);

    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.chatId === 111)!.text).toBe('progress one\n\n[uk]common.interrupted_by_restart');
    expect(calls.find((c) => c.chatId === 222)!.text).toBe('progress two\n\n[en]common.interrupted_by_restart');

    // Map cleared: a second sweep edits nothing.
    const second = fakeTelegram();
    await interruptActiveProgress(second.telegram, fakeTranslator);
    expect(second.calls).toHaveLength(0);

    h1.release();
    h2.release();
  });

  it('does not edit a released entry', async () => {
    const h = trackProgress(333, 3, 'pl');
    h.update('x');
    h.release();
    const { telegram, calls } = fakeTelegram();
    await interruptActiveProgress(telegram, fakeTranslator);
    expect(calls).toHaveLength(0);
  });

  it('uses the suffix alone when there is no progress text yet', async () => {
    const h = trackProgress(444, 4, 'en');
    const { telegram, calls } = fakeTelegram();
    await interruptActiveProgress(telegram, fakeTranslator);
    expect(calls[0].text).toBe('[en]common.interrupted_by_restart');
    h.release();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/bot/active-progress.test.ts`
Expected: FAIL — module `./active-progress` does not exist yet.

- [ ] **Step 3: Implement the module**

Create `src/bot/active-progress.ts`:

```ts
import type { Telegram } from 'telegraf';
import { createTranslator } from '../i18n';
import type { Locale, Translator } from '../i18n/types';

interface Entry {
  chatId: number;
  messageId: number;
  locale: Locale;
  lastText: string;
}

const active = new Map<string, Entry>();
const key = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

export interface ProgressHandle {
  update(text: string): void;
  release(): void;
}

// Register an in-flight progress message so a graceful shutdown can mark it as
// interrupted instead of leaving it frozen forever.
export function trackProgress(chatId: number, messageId: number, locale: Locale): ProgressHandle {
  const k = key(chatId, messageId);
  active.set(k, { chatId, messageId, locale, lastText: '' });
  return {
    update(text: string): void {
      const e = active.get(k);
      if (e) e.lastText = text;
    },
    release(): void {
      active.delete(k);
    },
  };
}

// Best-effort: append an "interrupted by restart" notice to every still-active
// progress message, then clear the registry. Called from the shutdown path.
export async function interruptActiveProgress(
  telegram: Pick<Telegram, 'editMessageText'>,
  makeTranslator: (locale: Locale) => Translator = createTranslator,
): Promise<void> {
  const entries = [...active.values()];
  active.clear();
  for (const e of entries) {
    const suffix = makeTranslator(e.locale)('common.interrupted_by_restart');
    const text = e.lastText ? `${e.lastText}\n\n${suffix}` : suffix;
    await telegram.editMessageText(e.chatId, e.messageId, undefined, text).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/bot/active-progress.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/bot/active-progress.ts src/bot/active-progress.test.ts
git commit -m "feat(bot): active-progress registry for graceful-shutdown interrupt notices"
```

---

### Task 4: i18n key `common.interrupted_by_restart`

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/en.ts`, `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`

- [ ] **Step 1: Declare the key**

In `src/i18n/types.ts`, find the `// app` section start:

```ts
export interface Messages {
  // app
  'app.no_data_in_snapshot': string;
```

Insert a `common` block right after `'app.no_data_in_snapshot': string;`:

```ts

  // common
  'common.interrupted_by_restart': string;
```

- [ ] **Step 2: Add the locale strings**

`src/i18n/locales/en.ts` — after `  'app.no_data_in_snapshot': 'No interesting untried beers right now.',`:

```ts

  // common
  'common.interrupted_by_restart': '⚠️ Interrupted by a restart — please re-run the command.',
```

`src/i18n/locales/uk.ts` — after its `'app.no_data_in_snapshot'` line:

```ts

  // common
  'common.interrupted_by_restart': '⚠️ Перервано рестартом — повтори команду.',
```

`src/i18n/locales/pl.ts` — after its `'app.no_data_in_snapshot'` line:

```ts

  // common
  'common.interrupted_by_restart': '⚠️ Przerwano przez restart — uruchom polecenie ponownie.',
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — the new key is declared once and present in all three locales.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/en.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts
git commit -m "i18n: add common.interrupted_by_restart"
```

---

### Task 5: Wire the registry into the commands + shutdown

**Files:**
- Modify: `src/bot/commands/route.ts`
- Modify: `src/bot/commands/refresh.ts`
- Modify: `src/shutdown.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Track/release in `route.ts`**

In `src/bot/commands/route.ts`, add the import alongside the others (after the
`googleMapsWalkingUrl` import):

```ts
import { trackProgress } from '../active-progress';
```

After `const locale = ctx.locale;`, add:

```ts
  const tracker = trackProgress(chatId, messageId, locale);
```

In the `notify` send callback, record the text. Find:

```ts
  const notify = makeThrottledProgress(
    async (text) => {
      await telegram
        .editMessageText(chatId, messageId, undefined, text, { parse_mode: 'HTML' })
        .catch(() => {});
    },
    PROGRESS_MIN_INTERVAL_MS,
  );
```

Replace the callback body's first line so it becomes:

```ts
  const notify = makeThrottledProgress(
    async (text) => {
      tracker.update(text);
      await telegram
        .editMessageText(chatId, messageId, undefined, text, { parse_mode: 'HTML' })
        .catch(() => {});
    },
    PROGRESS_MIN_INTERVAL_MS,
  );
```

Add a `finally` to release the tracker. Find the end of the detached block:

```ts
    } catch (e) {
      log.error({ err: e }, 'route failed');
      await notify(t('route.failed'), { force: true });
    }
  })();
```

Replace with:

```ts
    } catch (e) {
      log.error({ err: e }, 'route failed');
      await notify(t('route.failed'), { force: true });
    } finally {
      tracker.release();
    }
  })();
```

- [ ] **Step 2: Track/release in `refresh.ts`**

In `src/bot/commands/refresh.ts`, add the import (after the existing imports at the top of
the file):

```ts
import { trackProgress } from '../active-progress';
```

After `const locale = ctx.locale;`, add:

```ts
    const tracker = trackProgress(chatId, messageId, locale);
```

In the `notify` callback, record the text. Find:

```ts
    const notify = makeThrottledProgress(
      async (text) => {
        await telegram
          .editMessageText(chatId, messageId, undefined, text)
          .catch(() => {});
      },
      PROGRESS_MIN_INTERVAL_MS,
    );
```

Replace with:

```ts
    const notify = makeThrottledProgress(
      async (text) => {
        tracker.update(text);
        await telegram
          .editMessageText(chatId, messageId, undefined, text)
          .catch(() => {});
      },
      PROGRESS_MIN_INTERVAL_MS,
    );
```

Wrap the detached pipeline so the tracker is always released. Find:

```ts
    void runRefreshPipeline({
      run: (n) => run(n, { pubSlugs }),
      notify,
      t,
      log,
      postRun: postRunClosure,
    });
```

Replace with:

```ts
    void (async () => {
      try {
        await runRefreshPipeline({
          run: (n) => run(n, { pubSlugs }),
          notify,
          t,
          log,
          postRun: postRunClosure,
        });
      } finally {
        tracker.release();
      }
    })();
```

- [ ] **Step 3: Add the optional hook to `shutdown.ts`**

In `src/shutdown.ts`, add the field to `ShutdownDeps` (after `log: pino.Logger;`):

```ts
  interruptActiveProgress?: () => Promise<void>;
```

In the `shutdown` function, call it right after the "shutdown initiated" log and before the
cron loop. Find:

```ts
    deps.log.info({ signal }, 'shutdown initiated');

    for (const job of deps.cronJobs) {
```

Replace with:

```ts
    deps.log.info({ signal }, 'shutdown initiated');

    if (deps.interruptActiveProgress) {
      try {
        await deps.interruptActiveProgress();
      } catch (err) {
        deps.log.error({ err }, 'interrupt active progress failed');
      }
    }

    for (const job of deps.cronJobs) {
```

- [ ] **Step 4: Wire it in `index.ts`**

In `src/index.ts`, add imports (next to the existing `createShutdown` import and an i18n
import):

```ts
import { interruptActiveProgress } from './bot/active-progress';
import { createTranslator } from './i18n';
```

(If `createTranslator` is already imported, do not duplicate it.)

Update the `createShutdown` call. Find:

```ts
  const shutdown = createShutdown({ bot, cronJobs, db, httpServer: apiServer, log });
```

Replace with:

```ts
  const shutdown = createShutdown({
    bot,
    cronJobs,
    db,
    httpServer: apiServer,
    log,
    interruptActiveProgress: () => interruptActiveProgress(bot.telegram, createTranslator),
  });
```

- [ ] **Step 5: Typecheck + targeted tests**

Run: `npm run typecheck && npx vitest run src/bot/active-progress.test.ts src/bot/commands/route.test.ts src/shutdown.test.ts`
Expected: PASS — typecheck clean (route/refresh now reference `trackProgress`; shutdown has
the optional field; index wires it); existing shutdown tests still green (the new field is
optional).

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/route.ts src/bot/commands/refresh.ts src/shutdown.ts src/index.ts
git commit -m "feat(bot): mark in-flight /route & /refresh progress as interrupted on shutdown"
```

---

### Task 6: Spec update + full verification

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Update `spec.md`**

In `spec.md`, in the `/route` section (the paragraph describing "Під капотом
(`domain/router.ts`)" and the `open-TSP on |S| ≤ ~8` line), update the tour description to
state that the requested `N` is clamped to `≤ 70`, and the tour is solved exactly
(Held-Karp) for `≤ 12` pubs and with a nearest-neighbour + 2-opt heuristic above that.
Match the surrounding Ukrainian prose. Also add a short note (near the fire-and-forget
description) that in-flight `/route` and `/refresh` progress messages are marked
"⚠️ перервано рестартом" on graceful shutdown instead of being left frozen.

- [ ] **Step 2: Full test + build**

Run: `npm test && npm run build`
Expected: PASS (all suites green; build clean).

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): /route N cap, heuristic TSP, interrupted-progress on shutdown"
```

---

## Self-Review

**Spec coverage:**
- Cap N=70 at command → Task 2 (`clampRouteN`/`MAX_ROUTE_N`). ✅
- `solveTour`: Held-Karp ≤12 else NN+2-opt; `buildRoute` + `localSwapForDistance` use it → Task 1. ✅
- Registry `trackProgress` / `interruptActiveProgress` with `{chatId, messageId, locale, lastText}` → Task 3. ✅
- Append suffix to `lastText`; suffix-only when empty; best-effort; clear map → Task 3 (impl + tests). ✅
- Wire into route + refresh (track/update/release) → Task 5 Steps 1-2. ✅
- Shutdown hook called early, try/catch → Task 5 Step 3. ✅
- `index.ts` wires `bot.telegram` + `createTranslator` → Task 5 Step 4. ✅
- i18n `common.interrupted_by_restart` (en/uk/pl + types) → Task 4. ✅
- spec.md update → Task 6. ✅
- Tests: router large-set no-blowup, registry behaviour → Tasks 1 & 3. ✅

**Placeholder scan:** No TBD/vague steps — every code step shows full code. ✅

**Type consistency:** `solveTour`/`nearestNeighbourTwoOpt` return `{ order: RoutePub[]; distance: number }`, matching `openTsp`'s shape and `buildRoute`'s usage (`tour.order`, `tour.distance`). `ProgressHandle` (`update`/`release`) is produced by `trackProgress` and consumed identically in route/refresh. `interruptActiveProgress(telegram, makeTranslator)` signature matches the `index.ts` call site (`bot.telegram`, `createTranslator`) and the test's fakes. `Translator` type imported from `../i18n/types`. ✅
