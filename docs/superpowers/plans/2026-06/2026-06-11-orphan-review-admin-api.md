# Orphan review classification + admin API (#2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent mark an orphan `enrich_failures` row as triaged (with a classification + note) through an admin-authenticated API, so repeated triage passes skip already-reviewed rows; a recurring failure clears the mark.

**Architecture:** Three nullable review columns on `enrich_failures`. `recordEnrichFailure` resets them on conflict (a recurring failure re-surfaces in triage). A new admin-only route `POST /admin/enrich-failures/review` (guarded by `ADMIN_API_TOKEN`, separate from the per-user Telegram auth) updates them. Agents keep reading the DB read-only and POST review marks via `curl`.

**Tech Stack:** Node.js, TypeScript, better-sqlite3, Hono, Zod, `node:crypto` (constant-time compare), Jest.

**Order:** This is PR #2 of the batch. **Land PR #1 (`source_url`) first** — this plan assumes migration version 11 (`source_url`) already exists and that `EnrichFailureRow` / `recordEnrichFailure` already carry `source_url`. If #1 is not yet merged, rebase after it lands and renumber this migration accordingly.

> **Path note (deviation from spec):** The spec wrote `POST /enrich/failures/review`, but `app.use('/enrich/*', authMiddleware)` already guards every `/enrich/*` path with per-user Telegram auth. To use admin auth instead, this plan puts the endpoint under `/admin/*` (`POST /admin/enrich-failures/review`) so it gets the admin middleware, not the per-user one. Update `spec.md` to match (Task 6).

**Worktree:** Create via `superpowers:using-git-worktrees` (branches from `origin/main`; cherry-pick the doc commits if needed — `reference_worktree_docs_cherrypick`).

---

### Task 1: Migration — add review columns to `enrich_failures`

**Files:**
- Modify: `src/storage/schema.ts` (append migration version 12)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/storage/schema.test.ts`:

```typescript
test('enrich_failures has nullable review columns', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare(`PRAGMA table_info(enrich_failures)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  for (const name of ['review_class', 'review_note', 'reviewed_at']) {
    const col = cols.find((c) => c.name === name);
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0); // nullable
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/schema.test.ts -t "review columns"`
Expected: FAIL (columns undefined).

- [ ] **Step 3: Add the migration**

Append to the `MIGRATIONS` array in `src/storage/schema.ts` (after the `version: 11` object from PR #1):

```typescript
  {
    version: 12,
    sql: `
      ALTER TABLE enrich_failures ADD COLUMN review_class TEXT
        CHECK (review_class IN ('parser_bug','matcher_bug','not_on_untappd','wontfix'));
      ALTER TABLE enrich_failures ADD COLUMN review_note TEXT;
      ALTER TABLE enrich_failures ADD COLUMN reviewed_at TEXT;
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/schema.test.ts -t "review columns"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(enrich): add review columns to enrich_failures (#2)"
```

---

### Task 2: `recordEnrichFailure` resets review fields on conflict; add `setEnrichFailureReview`

**Files:**
- Modify: `src/storage/enrich_failures.ts`
- Test: `src/storage/enrich_failures.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/storage/enrich_failures.test.ts` (import `setEnrichFailureReview` from the module):

```typescript
test('setEnrichFailureReview updates review fields and reports change', () => {
  const { db, id } = freshDbWithBeer();
  recordEnrichFailure(db, row({ beer_id: id }));
  const ok = setEnrichFailureReview(db, id, 'parser_bug', 'name split wrong', '2026-06-11T02:00:00Z');
  expect(ok).toBe(true);
  const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got).toMatchObject({ review_class: 'parser_bug', review_note: 'name split wrong', reviewed_at: '2026-06-11T02:00:00Z' });
});

test('setEnrichFailureReview reports no change for an unknown beer', () => {
  const { db } = freshDbWithBeer();
  expect(setEnrichFailureReview(db, 99999, 'wontfix', null, '2026-06-11T02:00:00Z')).toBe(false);
});

test('a recurring failure clears a prior review', () => {
  const { db, id } = freshDbWithBeer();
  recordEnrichFailure(db, row({ beer_id: id }));
  setEnrichFailureReview(db, id, 'matcher_bug', null, '2026-06-11T02:00:00Z');
  recordEnrichFailure(db, row({ beer_id: id, at: '2026-06-11T03:00:00Z' })); // fails again
  const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
  expect(got.review_class).toBeNull();
  expect(got.review_note).toBeNull();
  expect(got.reviewed_at).toBeNull();
  expect(got.fail_count).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/storage/enrich_failures.test.ts`
Expected: FAIL (`setEnrichFailureReview` not exported; review not reset on conflict).

- [ ] **Step 3: Implement — reset on conflict**

In `src/storage/enrich_failures.ts`, add three reset lines to the `ON CONFLICT(beer_id) DO UPDATE SET` clause of `recordEnrichFailure` (after `last_at = excluded.last_at`):

```typescript
       last_at            = excluded.last_at,
       review_class       = NULL,
       review_note        = NULL,
       reviewed_at        = NULL`,
```

- [ ] **Step 4: Implement — `setEnrichFailureReview`**

Append to `src/storage/enrich_failures.ts`:

```typescript
export type ReviewClass = 'parser_bug' | 'matcher_bug' | 'not_on_untappd' | 'wontfix';

// Marks an orphan failure as triaged. Returns false if no row exists for beerId
// (e.g. the failure already cleared because the beer matched). A later recurring
// failure resets these fields via recordEnrichFailure's ON CONFLICT clause.
export function setEnrichFailureReview(
  db: DB,
  beerId: number,
  reviewClass: ReviewClass,
  note: string | null,
  atIso: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE enrich_failures
         SET review_class = ?, review_note = ?, reviewed_at = ?
       WHERE beer_id = ?`,
    )
    .run(reviewClass, note, atIso, beerId);
  return info.changes > 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/storage/enrich_failures.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 6: Commit**

```bash
git add src/storage/enrich_failures.ts src/storage/enrich_failures.test.ts
git commit -m "feat(enrich): setEnrichFailureReview + reset review on recurring failure (#2)"
```

---

### Task 3: `ADMIN_API_TOKEN` env var

**Files:**
- Modify: `src/config/env.ts`
- Test: `src/config/env.test.ts`

- [ ] **Step 1: Write the failing test**

`src/config/env.test.ts` defines a `baseEnv` const inside `describe('loadEnv', ...)`. Add these two tests inside that same `describe` block (so `baseEnv` is in scope):

```typescript
it('ADMIN_API_TOKEN passes through when set', () => {
  const env = loadEnv({ ...baseEnv, ADMIN_API_TOKEN: 'secret-token' });
  expect(env.ADMIN_API_TOKEN).toBe('secret-token');
});

it('ADMIN_API_TOKEN is undefined when absent', () => {
  const env = loadEnv(baseEnv);
  expect(env.ADMIN_API_TOKEN).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/config/env.test.ts -t ADMIN_API_TOKEN`
Expected: FAIL (property missing).

- [ ] **Step 3: Implement**

In `src/config/env.ts`, add to the `Schema` object (next to `ADMIN_TELEGRAM_ID`):

```typescript
  ADMIN_API_TOKEN: z.string().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/config/env.test.ts -t ADMIN_API_TOKEN`
Expected: PASS.

- [ ] **Step 5: Document and commit**

Add `ADMIN_API_TOKEN` to `.env.example` (if present) with a comment: `# admin token for POST /admin/* maintenance endpoints; unset = those endpoints return 503`.

```bash
git add src/config/env.ts src/config/env.test.ts .env.example
git commit -m "feat(config): add optional ADMIN_API_TOKEN (#2)"
```

---

### Task 4: Admin auth middleware

**Files:**
- Create: `src/api/middleware/admin.ts`
- Test: `src/api/middleware/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/middleware/admin.test.ts`:

```typescript
import { Hono } from 'hono';
import type { Env } from '../../config/env';
import type { ApiEnv } from '../types';
import { adminMiddleware } from './admin';

function appWith(token: string | undefined) {
  const app = new Hono<ApiEnv>();
  app.use('/admin/*', adminMiddleware({ ADMIN_API_TOKEN: token } as Env));
  app.get('/admin/ping', (c) => c.json({ ok: true }));
  return app;
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

describe('adminMiddleware', () => {
  it('503 when ADMIN_API_TOKEN is unset', async () => {
    const res = await appWith(undefined).request('/admin/ping');
    expect(res.status).toBe(503);
  });
  it('401 with no/!bearer header', async () => {
    const res = await appWith('secret').request('/admin/ping');
    expect(res.status).toBe(401);
  });
  it('401 with a wrong token', async () => {
    const res = await appWith('secret').request('/admin/ping', auth('nope'));
    expect(res.status).toBe(401);
  });
  it('passes through with the correct token', async () => {
    const res = await appWith('secret').request('/admin/ping', auth('secret'));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/middleware/admin.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

Create `src/api/middleware/admin.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env';
import type { ApiEnv } from '../types';

// Constant-time string compare; length mismatch short-circuits to false (the
// lengths themselves are not secret).
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// Bearer-token auth for /admin/* maintenance endpoints, gated on ADMIN_API_TOKEN.
// Separate from the per-user Telegram-token authMiddleware: 503 when the token is
// not configured (endpoint disabled), 401 on a missing/bad token.
export function adminMiddleware(env: Env): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const expected = env.ADMIN_API_TOKEN;
    if (!expected) return c.json({ error: 'admin disabled' }, 503);
    const m = c.req.header('Authorization')?.match(/^Bearer (.+)$/);
    if (!m || !safeEqual(m[1], expected)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/api/middleware/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/middleware/admin.ts src/api/middleware/admin.test.ts
git commit -m "feat(api): admin Bearer-token middleware gated on ADMIN_API_TOKEN (#2)"
```

---

### Task 5: `POST /admin/enrich-failures/review` route + wiring

**Files:**
- Create: `src/api/routes/admin.ts`
- Modify: `src/api/index.ts` (wire middleware + route)
- Test: `src/api/routes/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/routes/admin.test.ts`:

```typescript
import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertBeer } from '../../storage/beers';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { recordEnrichFailure } from '../../storage/enrich_failures';
import { adminMiddleware } from '../middleware/admin';
import { adminRoute } from './admin';
import type { ApiEnv } from '../types';
import type { Env } from '../../config/env';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const log = pino({ level: 'silent' });
  const env = { ADMIN_API_TOKEN: 'secret' } as Env;
  const app = new Hono<ApiEnv>();
  app.use('/admin/*', adminMiddleware(env));
  adminRoute(app, { db, env, log });
  const id = upsertBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  recordEnrichFailure(db, {
    beer_id: id, brewery: 'Track', name: 'Taking Shape',
    search_url: 'u', source_url: '', outcome: 'not_found',
    candidates_count: 0, candidates_summary: '', at: '2026-06-11T00:00:00Z',
  });
  return { db, app, id };
}

function review(app: Hono<ApiEnv>, body: unknown, token = 'secret') {
  return app.request('/admin/enrich-failures/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe('POST /admin/enrich-failures/review', () => {
  it('marks an existing failure as reviewed', async () => {
    const { db, app, id } = setup();
    const res = await review(app, { beer_id: id, review_class: 'parser_bug', note: 'split wrong' });
    expect(res.status).toBe(200);
    const got = db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id) as any;
    expect(got.review_class).toBe('parser_bug');
    expect(got.review_note).toBe('split wrong');
  });

  it('404 when no failure exists for beer_id', async () => {
    const { app } = setup();
    const res = await review(app, { beer_id: 99999, review_class: 'wontfix' });
    expect(res.status).toBe(404);
  });

  it('400 on an invalid review_class', async () => {
    const { app, id } = setup();
    const res = await review(app, { beer_id: id, review_class: 'nonsense' });
    expect(res.status).toBe(400);
  });

  it('401 with a bad admin token', async () => {
    const { app, id } = setup();
    const res = await review(app, { beer_id: id, review_class: 'wontfix' }, 'wrong');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/routes/admin.test.ts`
Expected: FAIL (route module not found).

- [ ] **Step 3: Implement the route**

Create `src/api/routes/admin.ts`:

```typescript
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { setEnrichFailureReview } from '../../storage/enrich_failures';

const ReviewBody = z.object({
  beer_id: z.number().int().positive(),
  review_class: z.enum(['parser_bug', 'matcher_bug', 'not_on_untappd', 'wontfix']),
  note: z.string().optional(),
});

// Admin maintenance routes. Assumes adminMiddleware has already authenticated.
export function adminRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/admin/enrich-failures/review', zValidator('json', ReviewBody), (c) => {
    const { beer_id, review_class, note } = c.req.valid('json');
    const updated = setEnrichFailureReview(
      deps.db, beer_id, review_class, note ?? null, new Date().toISOString(),
    );
    if (!updated) return c.json({ error: 'no failure for beer_id' }, 404);
    return c.json({ status: 'reviewed', beer_id, review_class });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/api/routes/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into the app**

In `src/api/index.ts`, add imports and register the admin middleware + route. The `/admin/*` middleware must be registered before the route (mirroring the `/enrich/*` pattern):

```typescript
import { adminMiddleware } from './middleware/admin';
import { adminRoute } from './routes/admin';
```

After the `enrichRoute(app, deps);` line:

```typescript
  app.use('/admin/*', adminMiddleware(deps.env));
  adminRoute(app, deps);
```

- [ ] **Step 6: Run the full API suite**

Run: `npx jest src/api`
Expected: PASS (nothing else broken; `/admin/*` does not overlap `/match` or `/enrich/*`).

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/admin.ts src/api/index.ts src/api/routes/admin.test.ts
git commit -m "feat(api): POST /admin/enrich-failures/review (admin-gated) (#2)"
```

---

### Task 6: Update the runbook + spec.md

**Files:**
- Modify: the orphan-failure runbook in `docs/` (find with `grep -rl enrich_failures docs/`)
- Modify: `spec.md`

- [ ] **Step 1: Document the triage workflow**

In the runbook, add:
- The triage read query should now exclude reviewed rows:
  ```sql
  SELECT beer_id, brewery, name, source_url, candidates_count, fail_count
  FROM enrich_failures
  WHERE review_class IS NULL
  ORDER BY fail_count DESC;
  ```
- How to mark a row reviewed (admin token required):
  ```bash
  curl -fsS -X POST "$API_BASE/admin/enrich-failures/review" \
    -H "Authorization: Bearer $ADMIN_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"beer_id":123,"review_class":"parser_bug","note":"beerfreak split brewery into name"}'
  ```
- Note: a recurring failure clears the mark, re-surfacing the row.

- [ ] **Step 2: Update spec.md**

Add the `/admin/enrich-failures/review` endpoint and the `enrich_failures` review columns to `spec.md` (OpenSpec source of truth, per CLAUDE.md). Note the path differs from the original design (`/admin/*`, not `/enrich/*`) and why.

- [ ] **Step 3: Full suite + typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs spec.md
git commit -m "docs(enrich): triage workflow + admin review endpoint (#2)"
```

---

## Self-Review Checklist (run before opening the PR)

- [ ] `npx jest` green; `npx tsc --noEmit` clean.
- [ ] PR #1 (`source_url`) is merged into the base this branch targets; migration is v12.
- [ ] Deploy note: set `ADMIN_API_TOKEN` in the prod `.env` before agents use the endpoint (otherwise 503). See `reference_prod_deploy_and_db_ops` memory.
- [ ] Follow the PR review loop (`feedback_pr_review_loop`): open PR → wait for AI review → assess each comment.
