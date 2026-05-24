# /refresh auto-runs /newbeers on success — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a successful `/refresh`, the bot automatically sends the `/newbeers` HTML output as a separate message (silent on empty; skipped on failure).

**Architecture:** Extract the `/newbeers` pipeline into a pure `buildNewbeersMessage(deps): string | null` (mirrors today's `text || empty-fallback` contract). Add a `runRefreshPipeline` helper inside `refresh.ts` that takes the existing `run/notify/t/log` plus an optional `postRun: () => Promise<void>` and is exported only for testing. `createRefreshCommand` gains an optional `postRun?: (deps: NewbeersDeps) => string | null` parameter; the handler wraps it into a Promise-returning closure that sends the HTML when non-null. `src/index.ts` passes `buildNewbeersMessage` as that second argument — the only place where `refresh.ts` and `newbeers.ts` meet.

**Tech Stack:** TypeScript, Jest, Telegraf 4.x, better-sqlite3 (`:memory:` for tests), pino logger. No new dependencies, no schema changes, no i18n keys.

**Spec:** `docs/superpowers/specs/2026-05-24-refresh-autorun-newbeers-design.md` (commit `6c01c00`).

**Branch:** `feat/refresh-autorun-newbeers` off `main` (currently at `6c01c00`).

---

## File Structure

- **Create** `src/bot/commands/newbeers-build.ts` — pure `buildNewbeersMessage(deps)`.
- **Create** `src/bot/commands/newbeers-build.test.ts` — empty/non-empty contract tests.
- **Modify** `src/bot/commands/newbeers.ts` — thin wrapper around `buildNewbeersMessage`.
- **Modify** `src/bot/commands/refresh.ts` — add `postRun?` parameter; extract `runRefreshPipeline` helper.
- **Modify** `src/bot/commands/refresh.test.ts` — add `describe('runRefreshPipeline')` covering postRun success/null/throw/run-rejects/undefined cases.
- **Modify** `src/index.ts` — pass `buildNewbeersMessage` as the second argument to `createRefreshCommand`.

No new files outside `src/bot/commands/`. No locale changes. No migrations.

---

## Task 1: Worktree + branch setup

**Files:** none yet.

- [ ] **Step 1: Create worktree off main**

```bash
cd /home/ysi/warsaw-beer-bot
git fetch origin main
git worktree add -b feat/refresh-autorun-newbeers ../warsaw-beer-bot-refresh-autorun origin/main
cd ../warsaw-beer-bot-refresh-autorun
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

## Task 2: Extract `buildNewbeersMessage` pure function

**Files:**
- Create: `src/bot/commands/newbeers-build.ts`
- Create: `src/bot/commands/newbeers-build.test.ts`

This is the first TDD cycle. We build the pure function backed by a real `:memory:` DB so the test exercises the same `triedBeerIds → snapshots → filterInteresting → formatGroupedBeers` pipeline that `/newbeers` uses today.

- [ ] **Step 1: Write the failing test file**

Create `src/bot/commands/newbeers-build.test.ts`:

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

describe('buildNewbeersMessage', () => {
  test('returns null when there are no snapshots at all', () => {
    const db = fresh();
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toBeNull();
  });

  test('returns null when snapshots exist but no tap survives filtering', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'P', address: null, lat: null, lon: null });
    const snapId = createSnapshot(db, pubId, '2026-05-24T12:00:00Z');
    // Tap with no match_links row → beer_id is NULL, but filterInteresting
    // still allows it under default filters. To force an empty result we
    // simply do not insert any taps at all.
    void snapId;
    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toBeNull();
  });

  test('returns non-null HTML containing the beer when a matched tap exists', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-24T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 100,
      name: 'Atak Chmielu',
      brewery: 'Pinta',
      style: 'AIPA',
      abv: 6.1,
      rating_global: 3.85,
      normalized_name: 'atak chmielu',
      normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
    insertTaps(db, snapId, [
      {
        tap_number: 1,
        beer_ref: 'PINTA Atak Chmielu',
        brewery_ref: 'PINTA',
        abv: 6.1,
        ibu: null,
        style: 'AIPA',
        u_rating: 3.9,
      },
    ]);

    const t = createTranslator('uk');
    const out = buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t });
    expect(out).not.toBeNull();
    expect(out).toContain('Atak Chmielu');
    expect(out).toContain('Pub A');
  });

  test('returns null when the user has already tried (triedBeerIds) the only tap', () => {
    const db = fresh();
    const pubId = upsertPub(db, {
      slug: 'pub-a', name: 'Pub A', address: null, lat: null, lon: null,
    });
    const snapId = createSnapshot(db, pubId, '2026-05-24T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 200,
      name: 'Buty Skejta',
      brewery: 'Stu Mostow',
      style: 'Pils',
      abv: 5.0,
      rating_global: 3.5,
      normalized_name: 'buty skejta',
      normalized_brewery: 'stu mostow',
    });
    upsertMatch(db, 'Stu Mostow Buty Skejta', beerId, 1.0);
    insertTaps(db, snapId, [
      {
        tap_number: 1,
        beer_ref: 'Stu Mostow Buty Skejta',
        brewery_ref: 'Stu Mostow',
        abv: 5.0,
        ibu: null,
        style: 'Pils',
        u_rating: 3.7,
      },
    ]);

    // Mark the user as having had this beer via untappd_had.
    db.prepare(
      'INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)',
    ).run(1, beerId, '2026-05-24T11:00:00Z');

    const t = createTranslator('uk');
    expect(buildNewbeersMessage({ db, telegramId: 1, locale: 'uk', t })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — confirm it fails on import**

Run: `npm test -- --testPathPatterns=newbeers-build --silent`
Expected: FAIL — `Cannot find module './newbeers-build'`.

- [ ] **Step 3: Create the implementation**

Create `src/bot/commands/newbeers-build.ts`:

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
}

export function buildNewbeersMessage(deps: NewbeersDeps): string | null {
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

  const candidates: CandidateTap[] = [];
  for (const snap of latestSnapshotsPerPub(db)) {
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
  return text || null;
}
```

The implementation is a verbatim lift of `newbeers.ts:19-51`, with two differences: (1) inputs come from `deps` instead of `ctx`, (2) the final line returns `text || null` instead of falling through to `ctx.t('newbeers.empty')`. The empty-fallback decision moves to the caller.

- [ ] **Step 4: Run the test — confirm it passes**

Run: `npm test -- --testPathPatterns=newbeers-build --silent`
Expected: 4 passing tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/newbeers-build.ts src/bot/commands/newbeers-build.test.ts
git commit -m "$(cat <<'EOF'
feat(newbeers): extract buildNewbeersMessage pure function

Lifts the /newbeers candidate-collection + format pipeline out of the
Telegraf handler into a ctx-free function that returns string | null
(null = nothing to show under the user's filters). The handler will be
re-pointed at this in the next commit; /refresh will also call it on
success to auto-show new beers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Re-point `/newbeers` handler at `buildNewbeersMessage`

**Files:**
- Modify: `src/bot/commands/newbeers.ts` — replace the body with a thin wrapper.

Pure mechanical refactor. Behavior of `/newbeers` must remain byte-identical: non-empty output is the same string; empty falls back to `t('newbeers.empty')` exactly as before.

- [ ] **Step 1: Replace `src/bot/commands/newbeers.ts` with the thin wrapper**

Overwrite the file with:

```typescript
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import { buildNewbeersMessage } from './newbeers-build';

export const newbeersCommand = new Composer<BotContext>();

newbeersCommand.command('newbeers', async (ctx) => {
  const text = buildNewbeersMessage({
    db: ctx.deps.db,
    telegramId: ctx.from.id,
    locale: ctx.locale,
    t: ctx.t,
  });
  await ctx.replyWithHTML(text ?? ctx.t('newbeers.empty'));
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test -- --silent`
Expected: every test still passes. The format-level tests (`newbeers-format.test.ts`) and the new `newbeers-build.test.ts` already cover the logic; no `/newbeers` handler-level tests exist today, so nothing else can break here.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Verify no leftover imports**

Run: `grep -n "latestSnapshotsPerPub\|tapsForSnapshotWithBeer\|filterInteresting\|listPubs\|normalizeBrewery" src/bot/commands/newbeers.ts`
Expected: no output. All of those moved into `newbeers-build.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/newbeers.ts
git commit -m "$(cat <<'EOF'
refactor(newbeers): handler becomes a thin wrapper

Calls buildNewbeersMessage and either replies with its HTML or, when
null, falls back to the existing newbeers.empty translation — exact
same observable output as before.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `runRefreshPipeline` + `postRun` parameter to `refresh.ts`

**Files:**
- Modify: `src/bot/commands/refresh.ts`
- Modify: `src/bot/commands/refresh.test.ts`

We extract a small pure-ish helper `runRefreshPipeline` from the existing background block so the post-run logic is testable without mocking a Telegraf context. `createRefreshCommand` gains the `postRun?` parameter and wires it into the handler's closure.

- [ ] **Step 1: Rewrite the test file**

Overwrite `src/bot/commands/refresh.test.ts` with:

```typescript
import pino from 'pino';
import { makeThrottledProgress, runRefreshPipeline } from './refresh';
import type { Translator } from '../../i18n/types';

describe('makeThrottledProgress', () => {
  test('drops non-forced calls within interval', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 100, () => now);

    await notify('a');
    await notify('b');
    expect(calls).toEqual(['a']);

    now += 50;
    await notify('c');
    expect(calls).toEqual(['a']);

    now += 60;
    await notify('d');
    expect(calls).toEqual(['a', 'd']);
  });

  test('forced calls bypass throttle', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 100000, () => now);

    await notify('start', { force: true });
    await notify('mid');
    await notify('end', { force: true });
    expect(calls).toEqual(['start', 'end']);
  });

  test('dedupes consecutive identical messages', async () => {
    let now = 1000;
    const calls: string[] = [];
    const send = async (t: string) => {
      calls.push(t);
    };
    const notify = makeThrottledProgress(send, 0, () => now);

    await notify('a');
    await notify('a');
    await notify('a', { force: true });
    expect(calls).toEqual(['a']);
  });
});

const silentLog = pino({ level: 'silent' });

// `(key: string) => key` is structurally wider than Translator's keyof-Messages
// constraint, so a double-cast is the smallest type ceremony to use it as a
// stub here. The pipeline only forwards `t(...)` calls verbatim, so identity
// is enough.
const tStub = ((key: string) => key) as unknown as Translator;

interface NotifyCall {
  text: string;
  force: boolean;
}

function makeNotify() {
  const calls: NotifyCall[] = [];
  const notify = async (text: string, opts?: { force?: boolean }) => {
    calls.push({ text, force: opts?.force === true });
  };
  return { notify, calls };
}

describe('runRefreshPipeline', () => {
  test('on success: refresh.done emitted BEFORE postRun runs', async () => {
    const { notify, calls } = makeNotify();
    const events: string[] = [];
    // Tag the notify so we can sequence notify against run/postRun.
    const wrappedNotify = async (text: string, opts?: { force?: boolean }) => {
      events.push(`notify:${text}`);
      await notify(text, opts);
    };
    const run = async () => {
      events.push('run');
    };
    const postRun = async () => {
      events.push('postRun');
    };

    await runRefreshPipeline({ run, notify: wrappedNotify, t: tStub, log: silentLog, postRun });

    expect(events).toEqual(['run', 'notify:refresh.done', 'postRun']);
    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
  });

  test('on success without postRun: only refresh.done is emitted', async () => {
    const { notify, calls } = makeNotify();
    const run = async () => {};

    await runRefreshPipeline({ run, notify, t: tStub, log: silentLog });

    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
  });

  test('postRun throws: error is logged, pipeline still resolves, no refresh.failed', async () => {
    const { notify, calls } = makeNotify();
    const errors: unknown[] = [];
    const log = {
      error: (obj: unknown) => errors.push(obj),
      info: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as typeof silentLog;
    const run = async () => {};
    const postRun = async () => {
      throw new Error('boom');
    };

    await expect(
      runRefreshPipeline({ run, notify, t: tStub, log, postRun }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([{ text: 'refresh.done', force: true }]);
    expect(errors).toHaveLength(1);
  });

  test('run rejects: emits refresh.failed and never calls postRun', async () => {
    const { notify, calls } = makeNotify();
    let postRunCalled = false;
    const run = async () => {
      throw new Error('scrape died');
    };
    const postRun = async () => {
      postRunCalled = true;
    };

    await runRefreshPipeline({ run, notify, t: tStub, log: silentLog, postRun });

    expect(postRunCalled).toBe(false);
    expect(calls).toEqual([{ text: 'refresh.failed', force: true }]);
  });
});
```

Note: this file completely replaces the previous 52-line test file. The existing `makeThrottledProgress` tests are preserved verbatim — they just sit above the new `runRefreshPipeline` block in the same file.

- [ ] **Step 2: Run the test — confirm it fails on import**

Run: `npm test -- --testPathPatterns=refresh --silent`
Expected: FAIL — `runRefreshPipeline` is not exported by `./refresh`.

- [ ] **Step 3: Rewrite `src/bot/commands/refresh.ts`**

Overwrite the file with:

```typescript
import { Composer } from 'telegraf';
import type pino from 'pino';
import type { BotContext } from '../index';
import type { ProgressFn } from '../../jobs/progress';
import type { Translator } from '../../i18n/types';
import type { NewbeersDeps } from './newbeers-build';

const COOLDOWN_MS = 5 * 60 * 1000;
const PROGRESS_MIN_INTERVAL_MS = 2000;
const lastCall = new Map<number, number>();

export function makeThrottledProgress(
  send: (text: string) => Promise<void>,
  intervalMs: number,
  now: () => number = Date.now,
): ProgressFn {
  let lastAt = 0;
  let lastText = '';
  return async (text, opts) => {
    if (text === lastText) return;
    if (!opts?.force && now() - lastAt < intervalMs) return;
    lastAt = now();
    lastText = text;
    await send(text);
  };
}

export interface RunRefreshPipelineArgs {
  run: (notify: ProgressFn) => Promise<void>;
  notify: ProgressFn;
  t: Translator;
  log: pino.Logger;
  postRun?: () => Promise<void>;
}

export async function runRefreshPipeline(args: RunRefreshPipelineArgs): Promise<void> {
  const { run, notify, t, log, postRun } = args;
  try {
    await run(notify);
    await notify(t('refresh.done'), { force: true });
    if (postRun) {
      try {
        await postRun();
      } catch (e) {
        log.error({ err: e }, 'refresh post-run failed');
      }
    }
  } catch (e) {
    log.error({ err: e }, 'refresh failed');
    await notify(t('refresh.failed'), { force: true });
  }
}

export function createRefreshCommand(
  run: (notify: ProgressFn) => Promise<void>,
  postRun?: (deps: NewbeersDeps) => string | null,
) {
  const cmd = new Composer<BotContext>();
  cmd.command('refresh', async (ctx) => {
    const prev = lastCall.get(ctx.from.id) ?? 0;
    if (Date.now() - prev < COOLDOWN_MS) {
      await ctx.reply(ctx.t('refresh.cooldown'));
      return;
    }
    lastCall.set(ctx.from.id, Date.now());

    const status = await ctx.reply(ctx.t('refresh.starting'));
    const chatId = ctx.chat.id;
    const messageId = status.message_id;
    const telegram = ctx.telegram;
    const log = ctx.deps.log;
    const t = ctx.t;
    const db = ctx.deps.db;
    const telegramId = ctx.from.id;
    const locale = ctx.locale;

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
          const text = postRun({ db, telegramId, locale, t });
          if (text) {
            await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
          }
        }
      : undefined;

    // Detach the work: the refresh sweep takes minutes, but Telegraf's
    // handlerTimeout (default 90s) would otherwise kill the handler and
    // raise TimeoutError into bot.catch. Captured locals above keep the
    // background promise independent of ctx's lifetime.
    void runRefreshPipeline({
      run,
      notify,
      t,
      log,
      postRun: postRunClosure,
    });
  });
  return cmd;
}
```

Key changes vs the previous file:

1. New export `runRefreshPipeline` (the testable helper).
2. `createRefreshCommand` accepts an optional second arg `postRun: (deps: NewbeersDeps) => string | null`.
3. The handler captures three extra locals before detach (`db`, `telegramId`, `locale`) and wraps `postRun` into a Promise-returning closure that handles the `sendMessage`.
4. The previous inline `try/catch` body becomes a single `void runRefreshPipeline(...)`.

- [ ] **Step 4: Run the test — confirm green**

Run: `npm test -- --testPathPatterns=refresh --silent`
Expected: all tests pass (the 3 existing `makeThrottledProgress` tests + the 4 new `runRefreshPipeline` tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test -- --silent`
Expected: still green everywhere. `createRefreshCommand` is called in `src/index.ts` with only one argument — the new signature's second parameter is optional, so this remains compilable until Task 5 wires it up.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/refresh.ts src/bot/commands/refresh.test.ts
git commit -m "$(cat <<'EOF'
feat(refresh): extract runRefreshPipeline + add postRun hook

runRefreshPipeline encapsulates the success/failure branching that used
to live in the detached IIFE; exporting it makes the success-path /
postRun-throw / run-rejects cases unit-testable without faking a
Telegraf context. createRefreshCommand gains an optional postRun
callback that receives (db, telegramId, locale, t) and returns the
HTML to send (or null to stay silent).

Wiring into index.ts comes next.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `buildNewbeersMessage` into `createRefreshCommand` in `src/index.ts`

**Files:**
- Modify: `src/index.ts` — import `buildNewbeersMessage`, pass it as the second argument.

- [ ] **Step 1: Add the import**

In `src/index.ts`, find the existing import line:

```typescript
import { newbeersCommand } from './bot/commands/newbeers';
```

Add the following line directly below it:

```typescript
import { buildNewbeersMessage } from './bot/commands/newbeers-build';
```

- [ ] **Step 2: Pass `buildNewbeersMessage` to `createRefreshCommand`**

Find the block (currently around lines 44-47):

```typescript
    createRefreshCommand(async (notify) => {
      await refreshOntap({ db, log, http, geocoder, onProgress: notify });
      await refreshAllUntappd({ db, log, http, onProgress: notify });
    }),
```

Replace with:

```typescript
    createRefreshCommand(
      async (notify) => {
        await refreshOntap({ db, log, http, geocoder, onProgress: notify });
        await refreshAllUntappd({ db, log, http, onProgress: notify });
      },
      buildNewbeersMessage,
    ),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. The types of `buildNewbeersMessage` and `createRefreshCommand`'s second parameter (`(deps: NewbeersDeps) => string | null`) line up exactly.

- [ ] **Step 4: Run the full suite**

Run: `npm test -- --silent`
Expected: every test passes.

- [ ] **Step 5: Smoke build (no execution)**

Run: `npm run build`
Expected: exit 0 (TS compiles to `dist/`). We do not exercise the bot live — runtime verification happens after the PR merges and deploys.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat(refresh): auto-call buildNewbeersMessage after successful /refresh

src/index.ts now passes buildNewbeersMessage to createRefreshCommand
as the postRun hook. After a successful /refresh, the bot sends the
same HTML /newbeers would have built — silently skipped when there's
nothing new under the user's filters.

Cron-triggered refreshes call refreshOntap / refreshAllUntappd
directly and remain unaffected (no chat to message).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Final verification before push

**Files:** none.

- [ ] **Step 1: Full suite**

Run: `npm test -- --silent`
Expected: every test passes.

- [ ] **Step 2: Typecheck + build**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 3: Inspect git log on the branch**

Run: `git log --oneline main..HEAD`
Expected: 4 commits in order:
1. `feat(newbeers): extract buildNewbeersMessage pure function`
2. `refactor(newbeers): handler becomes a thin wrapper`
3. `feat(refresh): extract runRefreshPipeline + add postRun hook`
4. `feat(refresh): auto-call buildNewbeersMessage after successful /refresh`

- [ ] **Step 4: Inspect cumulative diff**

Run: `git diff main...HEAD --stat`
Expected files (6):
- `src/bot/commands/newbeers-build.ts`
- `src/bot/commands/newbeers-build.test.ts`
- `src/bot/commands/newbeers.ts`
- `src/bot/commands/refresh.ts`
- `src/bot/commands/refresh.test.ts`
- `src/index.ts`

No edits outside this set.

- [ ] **Step 5: Manual smoke (optional, sanity)**

If a local SQLite DB is available, run `node -e "..."` to call `buildNewbeersMessage` against it and confirm the return type matches expectations. Skip if no fixture DB at hand.

---

## Task 7: Push + open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/refresh-autorun-newbeers
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "feat: /refresh auto-shows /newbeers on success" --body "$(cat <<'EOF'
## Summary
- Extract `buildNewbeersMessage(deps)` from the `/newbeers` handler so the pipeline can be called outside Telegraf.
- `createRefreshCommand` gains an optional `postRun?: (deps) => string | null`; on successful `/refresh` the handler sends the returned HTML (silent when null).
- Failure path (`refresh.failed`) skips the auto-call entirely.
- Cron-triggered refreshes call the underlying jobs directly — unaffected.

Implements `docs/superpowers/specs/2026-05-24-refresh-autorun-newbeers-design.md`.

## Test plan
- [x] `npm test` green locally (4 new tests in `newbeers-build`, 4 new tests in `refresh` for `runRefreshPipeline`)
- [x] `npm run typecheck` clean
- [x] `npm run build` clean
- [ ] After merge + deploy: issue `/refresh`; observe one status message editing to `refresh.done`, followed by a separate HTML message listing new beers
- [ ] After merge + deploy: with empty `triedBeerIds` exclusion (or no fresh snapshots), confirm only `refresh.done` arrives — no empty-state spam
- [ ] After merge + deploy: simulate a failure (e.g. block outbound HTTP for the scrape window) and confirm `refresh.failed` appears with no auto-newbeers follow-up

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL back to the user**

Stop here. User reviews + merges; runtime verification happens post-deploy.

---

## What this plan does NOT cover

- **Cron-triggered refreshes** — they bypass `createRefreshCommand` (see `src/index.ts:51-56`) and have no chat to message; out of scope per spec.
- **Per-user opt-out / setting** — not requested; revisit only if users push back.
- **Combining `refresh.done` with a "nothing new" message into one** — spec deliberately chose silent-on-empty.
- **Worktree teardown** — done after the PR merges (`git worktree remove ../warsaw-beer-bot-refresh-autorun`).
- **i18n / locale changes** — no new translation keys; the auto-message reuses the existing `formatGroupedBeers` output (already locale-aware) and no new status string.

## Coverage notes

- The "post-run returns `null` → no `sendMessage`" case is covered indirectly: `buildNewbeersMessage`'s null-on-empty contract has dedicated tests in `newbeers-build.test.ts`, and the handler-side guard is a single `if (text) { … }`. Promoting that two-line guard into a separately-tested helper would be YAGNI on this surface.
