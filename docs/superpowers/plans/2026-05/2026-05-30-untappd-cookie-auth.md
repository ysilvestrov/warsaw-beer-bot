# Untappd Cookie Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume `refreshAllUntappd` by sending `Cookie: untappd_user_v3_e=<value>` with each request, detecting expiry via `CookieExpiredError`, notifying the admin via log + Telegram DM, and providing a one-command rotation script.

**Architecture:** A second `untappdHttp` instance is created in `index.ts` with `cookie` and `redirect: 'manual'` options. The shared `http` (ontap, OSRM, Nominatim, Untappd Search) is untouched. Any 3xx response on a `redirect: 'manual'` client means the session is invalid — `CookieExpiredError` is thrown. `refreshAllUntappd` catches it, calls optional `notifyAdmin`, and breaks the user loop. If `UNTAPPD_SESSION_COOKIE` is not set, the job is simply not registered.

**Tech Stack:** Node.js, TypeScript, Jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-30-untappd-cookie-auth.md`

**Implementation note on location header:** Node 18+ `fetch` with `redirect: 'manual'` returns an opaque redirect response where `headers` are not exposed (Fetch API spec). So expiry detection uses `opts.redirect === 'manual' && res.status >= 300 && res.status < 400` — not the `location` header. This is correct for our use case since `redirect: 'manual'` is only set on `untappdHttp`, and any 3xx from that client means the cookie is invalid.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/sources/http.ts` | Modify | Export `CookieExpiredError`; add `cookie?` + `redirect?` to `HttpOpts`; inject Cookie header; throw `CookieExpiredError` on 3xx when `redirect:'manual'` |
| `src/sources/http.test.ts` | Modify | 4 new tests for the above |
| `src/jobs/refresh-untappd.ts` | Modify | Import `CookieExpiredError`; add `notifyAdmin?` dep; catch expiry → notify + break |
| `src/jobs/refresh-untappd.test.ts` | **Create** | 3 tests: expiry stops loop + notifies; non-expiry continues; no-notifyAdmin is safe |
| `src/config/env.ts` | Modify | Add `UNTAPPD_SESSION_COOKIE` and `ADMIN_TELEGRAM_ID` (both optional) |
| `src/index.ts` | Modify | Create `untappdHttp` conditionally; build `notifyAdmin`; guard both cron + `/refresh` |
| `deploy/refresh-cookie.sh` | **Create** | Replace-or-append cookie in `/etc/warsaw-beer-bot/.env` + restart service |
| `.env.example` | Modify | Add commented-out `UNTAPPD_SESSION_COOKIE` and `ADMIN_TELEGRAM_ID` lines |

---

## Task 1: `http.ts` — CookieExpiredError + cookie/redirect options

**Files:**
- Modify: `src/sources/http.ts`
- Modify: `src/sources/http.test.ts`

- [ ] **Step 1: Write 4 failing tests**

Append to `src/sources/http.test.ts` (after the existing serialization test):

```ts
import { createHttp, CookieExpiredError } from './http';

test('sends Cookie header with untappd_user_v3_e when cookie option is set', async () => {
  const calls: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_, init) => {
    calls.push(init ?? {});
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, cookie: 'abc123' });
  await http.get('https://untappd.com/user/foo/beers');
  expect((calls[0].headers as Record<string, string>)['Cookie']).toBe('untappd_user_v3_e=abc123');
});

test('throws CookieExpiredError on any 3xx when redirect is manual', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 307 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  await expect(http.get('https://untappd.com/user/foo/beers')).rejects.toBeInstanceOf(CookieExpiredError);
});

test('throws generic Error (not CookieExpiredError) on 4xx', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 403 });
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl });
  const err = await http.get('https://example.com/').catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(CookieExpiredError);
  expect(err.message).toContain('HTTP 403');
});

test('passes redirect option to fetch when set', async () => {
  const calls: RequestInit[] = [];
  const fetchImpl: typeof fetch = async (_, init) => {
    calls.push(init ?? {});
    return new Response('ok', { status: 200 });
  };
  const http = createHttp({ userAgent: 'ua', minGapMs: 0, fetchImpl, redirect: 'manual' });
  // Use a 200 here — we just want to verify the option was passed, not trigger the error.
  await http.get('https://example.com/ok');
  expect(calls[0].redirect).toBe('manual');
});
```

- [ ] **Step 2: Verify tests fail**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest http.test --no-coverage 2>&1 | tail -15
```

Expected: 4 new tests fail (`CookieExpiredError` not exported, `cookie`/`redirect` opts not in `HttpOpts`).

- [ ] **Step 3: Implement in `src/sources/http.ts`**

Replace the entire file with:

```ts
import PQueue from 'p-queue';

export class CookieExpiredError extends Error {
  constructor() {
    super('Untappd session cookie expired');
    this.name = 'CookieExpiredError';
  }
}

export interface Http {
  get(url: string): Promise<string>;
}

export interface HttpOpts {
  userAgent: string;
  minGapMs?: number;
  fetchImpl?: typeof fetch;
  cookie?: string;
  redirect?: RequestRedirect;
}

export function createHttp(opts: HttpOpts): Http {
  const queue = new PQueue({ concurrency: 1 });
  const f = opts.fetchImpl ?? fetch;
  const gap = opts.minGapMs ?? 2000;
  let lastAt = 0;

  return {
    async get(url: string): Promise<string> {
      return queue.add(async () => {
        const wait = Math.max(0, lastAt + gap - Date.now());
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const headers: Record<string, string> = { 'User-Agent': opts.userAgent };
        if (opts.cookie) headers['Cookie'] = `untappd_user_v3_e=${opts.cookie}`;

        const fetchOpts: RequestInit = { headers };
        if (opts.redirect) fetchOpts.redirect = opts.redirect;

        const res = await f(url, fetchOpts);
        lastAt = Date.now();

        // With redirect:'manual', any 3xx means the session cookie is invalid.
        if (res.status >= 300 && res.status < 400) {
          if (opts.redirect === 'manual') throw new CookieExpiredError();
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return res.text();
      }) as Promise<string>;
    },
  };
}
```

- [ ] **Step 4: Verify all http tests pass**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest http.test --no-coverage 2>&1 | tail -10
```

Expected: `Tests: 5 passed` (1 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/sources/http.ts src/sources/http.test.ts && git commit -m "$(cat <<'EOF'
feat(http): CookieExpiredError + cookie/redirect options

Adds optional cookie (sends Cookie: untappd_user_v3_e=<value>) and
redirect (passed to fetch) fields to HttpOpts. With redirect:'manual',
any 3xx response throws CookieExpiredError so callers can distinguish
session expiry from other HTTP errors.
EOF
)"
```

---

## Task 2: `refresh-untappd.ts` — expiry handling + notifyAdmin

**Files:**
- Modify: `src/jobs/refresh-untappd.ts`
- Create: `src/jobs/refresh-untappd.test.ts`

- [ ] **Step 1: Write 3 failing tests**

Create `src/jobs/refresh-untappd.test.ts`:

```ts
import { refreshAllUntappd } from './refresh-untappd';
import { CookieExpiredError } from '../sources/http';
import type { DB } from '../storage/db';
import type pino from 'pino';

jest.mock('../storage/user_profiles', () => ({
  allProfiles: jest.fn(),
}));
jest.mock('../storage/beers', () => ({
  upsertBeer: jest.fn(() => 1),
  findBeerByNormalized: jest.fn(() => null),
}));
jest.mock('../storage/untappd_had', () => ({ markHad: jest.fn() }));

import { allProfiles } from '../storage/user_profiles';

const mockLog = {
  warn: jest.fn(),
  info: jest.fn(),
} as unknown as pino.Logger;

const mockDb = {
  prepare: jest.fn(() => ({ run: jest.fn() })),
} as unknown as DB;

beforeEach(() => jest.clearAllMocks());

test('CookieExpiredError: calls notifyAdmin once and stops processing further users', async () => {
  (allProfiles as jest.Mock).mockReturnValue([
    { telegram_id: 1, untappd_username: 'alice' },
    { telegram_id: 2, untappd_username: 'bob' },
  ]);
  const http = { get: jest.fn().mockRejectedValue(new CookieExpiredError()) };
  const notifyAdmin = jest.fn(async () => {});

  await refreshAllUntappd({ db: mockDb, log: mockLog, http, notifyAdmin });

  expect(notifyAdmin).toHaveBeenCalledTimes(1);
  expect(notifyAdmin).toHaveBeenCalledWith(expect.stringContaining('cookie'));
  expect(http.get).toHaveBeenCalledTimes(1); // stopped after first user
});

test('non-CookieExpiredError: logs warn per user and continues to next user', async () => {
  (allProfiles as jest.Mock).mockReturnValue([
    { telegram_id: 1, untappd_username: 'alice' },
    { telegram_id: 2, untappd_username: 'bob' },
  ]);
  const http = { get: jest.fn().mockRejectedValue(new Error('network error')) };
  const notifyAdmin = jest.fn();

  await refreshAllUntappd({ db: mockDb, log: mockLog, http, notifyAdmin });

  expect(notifyAdmin).not.toHaveBeenCalled();
  expect(http.get).toHaveBeenCalledTimes(2);
  expect(mockLog.warn).toHaveBeenCalledTimes(2);
});

test('CookieExpiredError without notifyAdmin does not throw', async () => {
  (allProfiles as jest.Mock).mockReturnValue([
    { telegram_id: 1, untappd_username: 'alice' },
  ]);
  const http = { get: jest.fn().mockRejectedValue(new CookieExpiredError()) };

  await expect(
    refreshAllUntappd({ db: mockDb, log: mockLog, http }),
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Verify tests fail**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest refresh-untappd.test --no-coverage 2>&1 | tail -15
```

Expected: 3 new tests fail (`notifyAdmin` not in Deps, `CookieExpiredError` not caught).

- [ ] **Step 3: Implement in `src/jobs/refresh-untappd.ts`**

Replace the entire file with:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import type { Http } from '../sources/http';
import { CookieExpiredError } from '../sources/http';
import { parseUserBeersPage } from '../sources/untappd/scraper';
import { allProfiles } from '../storage/user_profiles';
import { upsertBeer, findBeerByNormalized } from '../storage/beers';
import { markHad } from '../storage/untappd_had';
import { normalizeBrewery, normalizeName } from '../domain/normalize';
import { noopProgress, type ProgressFn } from './progress';

interface Deps {
  db: DB;
  log: pino.Logger;
  http: Http;
  onProgress?: ProgressFn;
  notifyAdmin?: (msg: string) => Promise<void>;
}

export async function refreshAllUntappd(deps: Deps): Promise<void> {
  const { db, log, http, onProgress = noopProgress, notifyAdmin } = deps;
  const profiles = allProfiles(db).filter((p) => p.untappd_username);
  await onProgress(`👤 untappd: 0/${profiles.length} профілів`, { force: true });

  const updateRatingOnly = db.prepare('UPDATE beers SET rating_global = ? WHERE id = ?');

  let i = 0;
  let ok = 0;
  for (const p of profiles) {
    i++;
    try {
      const html = await http.get(`https://untappd.com/user/${p.untappd_username}/beers`);
      const items = parseUserBeersPage(html);
      for (const it of items) {
        const nb = normalizeBrewery(it.brewery_name);
        const nn = normalizeName(it.beer_name);
        const existing = findBeerByNormalized(db, nb, nn);
        let beerId: number;
        if (existing) {
          updateRatingOnly.run(it.global_rating, existing.id);
          beerId = existing.id;
        } else {
          beerId = upsertBeer(db, {
            untappd_id: it.bid,
            name: it.beer_name,
            brewery: it.brewery_name,
            style: it.style,
            abv: null,
            rating_global: it.global_rating,
            normalized_name: nn,
            normalized_brewery: nb,
          });
        }
        markHad(db, p.telegram_id, beerId, new Date().toISOString());
      }
      ok++;
    } catch (e) {
      if (e instanceof CookieExpiredError) {
        log.warn('untappd cookie expired — stopping scrape');
        await notifyAdmin?.(
          '⚠️ Untappd cookie expired. Run: ./deploy/refresh-cookie.sh <new-value>',
        );
        break;
      }
      log.warn({ err: e, user: p.untappd_username }, 'untappd scrape failed');
    }
    await onProgress(`👤 untappd: ${i}/${profiles.length} — ${p.untappd_username}`);
  }
  await onProgress(`👤 untappd: ✓ ${ok}/${profiles.length} профілів`, { force: true });
}
```

- [ ] **Step 4: Verify all refresh-untappd tests pass**

```bash
cd /home/ysi/warsaw-beer-bot && npx jest refresh-untappd.test --no-coverage 2>&1 | tail -10
```

Expected: `Tests: 3 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/jobs/refresh-untappd.ts src/jobs/refresh-untappd.test.ts && git commit -m "$(cat <<'EOF'
feat(refresh-untappd): catch CookieExpiredError, notify admin, break loop

Adds optional notifyAdmin dep. On CookieExpiredError: log warn + call
notifyAdmin (if set) + break out of user loop so we don't hammer Untappd
with 403s for every user. Non-expiry errors continue per existing behaviour.
EOF
)"
```

---

## Task 3: `env.ts` + `.env.example` — new optional vars

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add vars to `src/config/env.ts`**

Find:
```ts
  UNTAPPD_LOOKUP_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
```

Replace with:
```ts
  UNTAPPD_LOOKUP_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  UNTAPPD_SESSION_COOKIE: z.string().optional(),
  ADMIN_TELEGRAM_ID: z.string().optional(),
```

- [ ] **Step 2: Verify typecheck still passes**

```bash
cd /home/ysi/warsaw-beer-bot && npm run typecheck 2>&1 | tail -5
```

Expected: exit 0, no errors.

- [ ] **Step 3: Update `.env.example`**

Append to `.env.example`:

```
# Optional: value of the untappd_user_v3_e cookie for profile scraping.
# Get it: DevTools → Application → Cookies → untappd.com → untappd_user_v3_e → Value column
# Rotate: ./deploy/refresh-cookie.sh <new-value>
# UNTAPPD_SESSION_COOKIE=

# Optional: your Telegram user ID for cookie-expiry DM alerts.
# Find it: send /start to @userinfobot on Telegram.
# ADMIN_TELEGRAM_ID=
```

- [ ] **Step 4: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/config/env.ts .env.example && git commit -m "feat(env): add optional UNTAPPD_SESSION_COOKIE and ADMIN_TELEGRAM_ID"
```

---

## Task 4: `index.ts` — wire untappdHttp + notifyAdmin

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Create untappdHttp after the shared http client**

Find (line ~36):
```ts
  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });
```

Replace with:
```ts
  const http = createHttp({ userAgent: env.NOMINATIM_USER_AGENT });
  const geocoder = createGeocoder({ userAgent: env.NOMINATIM_USER_AGENT });

  const untappdHttp = env.UNTAPPD_SESSION_COOKIE
    ? createHttp({
        userAgent: env.NOMINATIM_USER_AGENT,
        cookie: env.UNTAPPD_SESSION_COOKIE,
        redirect: 'manual',
      })
    : null;
  if (!untappdHttp) {
    log.warn('untappd profile scraper disabled (UNTAPPD_SESSION_COOKIE not set)');
  }
```

- [ ] **Step 2: Build notifyAdmin after bot is created**

Find (line ~39):
```ts
  const bot = createBot({ db, env, log });
  bot.use(
```

Replace with:
```ts
  const bot = createBot({ db, env, log });

  const notifyAdmin = env.ADMIN_TELEGRAM_ID
    ? (msg: string) =>
        bot.telegram.sendMessage(env.ADMIN_TELEGRAM_ID!, msg).then(() => {})
    : undefined;

  bot.use(
```

- [ ] **Step 3: Update /refresh command to conditionally call refreshAllUntappd**

Find:
```ts
    createRefreshCommand(
      async (notify) => {
        await refreshOntap({
          db, log, http, geocoder, onProgress: notify,
          lookupEnabled: env.UNTAPPD_LOOKUP_ENABLED,
        });
        await refreshAllUntappd({ db, log, http, onProgress: notify });
      },
      buildNewbeersMessage,
    ),
```

Replace with:
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

- [ ] **Step 4: Update cron to conditionally register refreshAllUntappd**

Find:
```ts
    cron.schedule('0 3 * * *', () => {
      refreshAllUntappd({ db, log, http }).catch((e) => log.error({ err: e }, 'untappd cron'));
    }),
```

Replace with:
```ts
    ...(untappdHttp
      ? [cron.schedule('0 3 * * *', () => {
          refreshAllUntappd({ db, log, http: untappdHttp, notifyAdmin })
            .catch((e) => log.error({ err: e }, 'untappd cron'));
        })]
      : []),
```

- [ ] **Step 5: Verify typecheck passes**

```bash
cd /home/ysi/warsaw-beer-bot && npm run typecheck 2>&1 | tail -5
```

Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add src/index.ts && git commit -m "$(cat <<'EOF'
feat(index): wire untappdHttp + notifyAdmin for cookie-authenticated scraping

Creates a separate HTTP client (redirect:manual, Cookie header) for
refreshAllUntappd. If UNTAPPD_SESSION_COOKIE is unset, the job is not
registered in cron and not called from /refresh — startup warning only.
notifyAdmin forwards CookieExpiredError alerts to ADMIN_TELEGRAM_ID.
EOF
)"
```

---

## Task 5: `deploy/refresh-cookie.sh` — rotation script

**Files:**
- Create: `deploy/refresh-cookie.sh`

- [ ] **Step 1: Write the script**

Create `deploy/refresh-cookie.sh`:

```bash
#!/usr/bin/env bash
# Usage: ./deploy/refresh-cookie.sh <untappd_user_v3_e cookie value>
#
# Replaces (or appends) UNTAPPD_SESSION_COOKIE in /etc/warsaw-beer-bot/.env
# and restarts the service. No sudo password required — covered by the
# existing NOPASSWD sudoers fragment (deploy/sudoers.d/warsaw-beer-bot).
set -euo pipefail

NEW_VAL=${1:?Usage: $0 <untappd_user_v3_e cookie value>}
ENV_FILE=/etc/warsaw-beer-bot/.env

sudo -u warsaw-beer-bot bash -lc "
  if grep -q '^UNTAPPD_SESSION_COOKIE=' '$ENV_FILE'; then
    sed -i 's|^UNTAPPD_SESSION_COOKIE=.*|UNTAPPD_SESSION_COOKIE=$NEW_VAL|' '$ENV_FILE'
    echo 'Cookie line updated.'
  else
    printf '\nUNTAPPD_SESSION_COOKIE=%s\n' '$NEW_VAL' >> '$ENV_FILE'
    echo 'Cookie line appended.'
  fi
"

sudo systemctl restart warsaw-beer-bot
echo 'Service restarted.'
echo 'Check logs: journalctl -u warsaw-beer-bot -n 30 --no-pager'
```

- [ ] **Step 2: Make executable**

```bash
chmod +x /home/ysi/warsaw-beer-bot/deploy/refresh-cookie.sh
```

- [ ] **Step 3: Smoke-test the script locally (dry run — don't change prod .env yet)**

```bash
grep UNTAPPD_SESSION_COOKIE /etc/warsaw-beer-bot/.env || echo "(key not present yet)"
```

Expected: either shows the current value or `(key not present yet)`.

- [ ] **Step 4: Commit**

```bash
cd /home/ysi/warsaw-beer-bot && git add deploy/refresh-cookie.sh && git commit -m "deploy(script): refresh-cookie.sh — one-command Untappd cookie rotation"
```

---

## Task 6: Full verification + PR

**Files:** N/A (verification and git only)

- [ ] **Step 1: Typecheck**

```bash
cd /home/ysi/warsaw-beer-bot && npm run typecheck 2>&1 | tail -5
```

Expected: exit 0, no errors.

- [ ] **Step 2: Full test suite**

```bash
cd /home/ysi/warsaw-beer-bot && npm test 2>&1 | tail -15
```

Expected: all tests pass (338 existing + 4 new http tests + 3 new refresh-untappd tests = 345 total).

- [ ] **Step 3: Diff review**

```bash
cd /home/ysi/warsaw-beer-bot && git diff main...HEAD --stat
```

Expected: 8 files changed (`http.ts`, `http.test.ts`, `refresh-untappd.ts`, `refresh-untappd.test.ts` (new), `env.ts`, `index.ts`, `refresh-cookie.sh` (new), `.env.example`).

- [ ] **Step 4: Push + PR**

```bash
cd /home/ysi/warsaw-beer-bot && git push -u origin feat/collab-brewery-search
```

```bash
gh pr create --title "feat: Untappd cookie auth — session cookie + expiry detection + rotation script" --body "$(cat <<'EOF'
## Summary
- `untappdHttp`: separate HTTP client with `Cookie: untappd_user_v3_e=<value>` and `redirect: 'manual'`
- `CookieExpiredError`: thrown on any 3xx from the cookie-auth client (session invalid)
- `refreshAllUntappd`: catches expiry → `log.warn` + optional Telegram DM to `ADMIN_TELEGRAM_ID` → breaks user loop
- If `UNTAPPD_SESSION_COOKIE` not set: startup warn, job not registered
- `deploy/refresh-cookie.sh`: one-command rotation — updates `.env` + restarts service, no sudo password

**Empirical basis:** `untappd_user_v3_e` cookie alone returns 200 for `/user/X/beers` (verified 2026-05-30).

## Setup after merge
1. Copy `untappd_user_v3_e` value from browser DevTools
2. `./deploy/refresh-cookie.sh <value>`
3. `journalctl -u warsaw-beer-bot -n 30 --no-pager` — verify scraper runs

## Test plan
- [x] `npm run typecheck` clean
- [x] `npm test` green — 345 tests, 44 suites
- [ ] Post-deploy: `journalctl` shows untappd scrape succeeding (no 403 warn)
- [ ] Post-deploy: `ADMIN_TELEGRAM_ID` set → confirm DM arrives when cookie manually expired

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- `CookieExpiredError` exported from `http.ts` → Task 1 ✓
- `cookie?` + `redirect?` in `HttpOpts` → Task 1 ✓
- Cookie header `untappd_user_v3_e=<value>` → Task 1 ✓
- `notifyAdmin?` in `refreshAllUntappd` Deps → Task 2 ✓
- Expiry: log + notify + break → Task 2 ✓
- Non-expiry continues per-user → Task 2 ✓
- `UNTAPPD_SESSION_COOKIE` + `ADMIN_TELEGRAM_ID` in env → Task 3 ✓
- `untappdHttp` conditional creation → Task 4 ✓
- Job not registered when cookie absent → Task 4 ✓
- cron + `/refresh` both use `untappdHttp` → Task 4 ✓
- `deploy/refresh-cookie.sh` → Task 5 ✓
- `.env.example` updated → Task 3 ✓

**Placeholder scan:** None. All code blocks complete. ✓

**Type consistency:**
- `CookieExpiredError` exported in Task 1, imported in Task 2 ✓
- `notifyAdmin?: (msg: string) => Promise<void>` defined in Task 2, built in Task 4 ✓
- `untappdHttp: Http | null` — null-check before use in Task 4 ✓
- `env.UNTAPPD_SESSION_COOKIE: string | undefined` — zod optional, narrowed with `? :` in Task 4 ✓
