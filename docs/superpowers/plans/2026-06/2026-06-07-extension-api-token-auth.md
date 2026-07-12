# Browser Extension API & Token Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only HTTP API (Hono) embedded in the bot process that lets a browser extension match shop beer listings against the user's drunk-history, authenticated by per-user tokens minted via a new `/extension` Telegram command.

**Architecture:** Single Node.js process shares one SQLite handle between Telegraf and a Hono app bound to `127.0.0.1:${API_PORT}` (exposed publicly via the existing Cloudflare tunnel). Deps (`db`, `log`, `env`) are injected into the Hono app through closures at the composition root — no globals in routes. Matching is a pure `domain/` function reusing the existing `matchBeer` brewery hard-gate.

**Tech Stack:** TypeScript (strict), Hono + `@hono/node-server` + `@hono/zod-validator`, better-sqlite3, Telegraf, zod, Jest, node `crypto` (sha256 token hashing).

**Spec:** `docs/superpowers/specs/2026-06-06-extension-api-token-auth-design.md`

**Conventions observed:**
- Per-test in-memory DB via `openDb(':memory:')` then `migrate(db)` (see `src/storage/schema.test.ts`).
- Functional style; I/O in `storage/`/`api/`/`bot/`, pure logic in `domain/`.
- HTML Telegram replies escape locale strings via `escapeHtml` (`src/bot/commands/newbeers-format.ts:75`); raw hex token is safe inside `<code>`.
- Migrations are append-only entries in the `MIGRATIONS` array of `src/storage/schema.ts`.

---

### Task 1: Migration v8 — `api_tokens` table

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/storage/schema.test.ts`:

```ts
  it('migration v8 creates api_tokens table with token_hash PK', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .prepare("PRAGMA table_info(api_tokens)")
      .all() as { name: string; pk: number }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['token_hash', 'telegram_id', 'created_at']),
    );
    expect(cols.find((c) => c.name === 'token_hash')?.pk).toBe(1);

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='api_tokens'")
      .all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain('idx_api_tokens_telegram');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/schema.test.ts -t "migration v8"`
Expected: FAIL — `no such table: api_tokens`.

- [ ] **Step 3: Add migration v8**

Append this object to the `MIGRATIONS` array in `src/storage/schema.ts` (after the `version: 7` entry):

```ts
  {
    version: 8,
    sql: `
      CREATE TABLE api_tokens (
        token_hash  TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL
                    REFERENCES user_profiles(telegram_id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_api_tokens_telegram ON api_tokens(telegram_id);
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/schema.test.ts -t "migration v8"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(db): add api_tokens table (migration v8)"
```

---

### Task 2: Token storage — hash, rotate, lookup

**Files:**
- Create: `src/storage/api_tokens.ts`
- Test: `src/storage/api_tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/api_tokens.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import { ensureProfile } from './user_profiles';
import { hashToken, rotateToken, findTelegramIdByHash } from './api_tokens';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 111);
  ensureProfile(db, 222);
  return db;
}

describe('api_tokens storage', () => {
  it('hashToken is deterministic sha256 hex (64 chars)', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('stores a token and finds the owner by hash', () => {
    const db = fresh();
    rotateToken(db, 111, hashToken('raw-1'), '2026-06-07T00:00:00Z');
    expect(findTelegramIdByHash(db, hashToken('raw-1'))).toBe(111);
    expect(findTelegramIdByHash(db, hashToken('nope'))).toBeNull();
  });

  it('rotation is 1:1 — old token for the same user is removed', () => {
    const db = fresh();
    rotateToken(db, 111, hashToken('old'), '2026-06-07T00:00:00Z');
    rotateToken(db, 111, hashToken('new'), '2026-06-07T01:00:00Z');
    expect(findTelegramIdByHash(db, hashToken('old'))).toBeNull();
    expect(findTelegramIdByHash(db, hashToken('new'))).toBe(111);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE telegram_id = ?')
      .get(111) as { n: number };
    expect(count.n).toBe(1);
  });

  it('rotation does not touch other users tokens', () => {
    const db = fresh();
    rotateToken(db, 111, hashToken('a'), '2026-06-07T00:00:00Z');
    rotateToken(db, 222, hashToken('b'), '2026-06-07T00:00:00Z');
    rotateToken(db, 111, hashToken('a2'), '2026-06-07T02:00:00Z');
    expect(findTelegramIdByHash(db, hashToken('b'))).toBe(222);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/api_tokens.test.ts`
Expected: FAIL — cannot find module `./api_tokens`.

- [ ] **Step 3: Write the implementation**

Create `src/storage/api_tokens.ts`:

```ts
import { createHash } from 'crypto';
import type { DB } from './db';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// 1:1 rotation: drop any existing token for this user, then insert the new one.
export function rotateToken(
  db: DB,
  telegramId: number,
  tokenHash: string,
  at: string,
): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM api_tokens WHERE telegram_id = ?').run(telegramId);
    db.prepare(
      'INSERT INTO api_tokens (token_hash, telegram_id, created_at) VALUES (?, ?, ?)',
    ).run(tokenHash, telegramId, at);
  });
  tx();
}

export function findTelegramIdByHash(db: DB, tokenHash: string): number | null {
  const row = db
    .prepare('SELECT telegram_id FROM api_tokens WHERE token_hash = ?')
    .get(tokenHash) as { telegram_id: number } | undefined;
  return row ? row.telegram_id : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/api_tokens.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/api_tokens.ts src/storage/api_tokens.test.ts
git commit -m "feat(storage): api_tokens repository (hash, rotate, lookup)"
```

---

### Task 3: Catalog loader + per-user latest ratings

**Files:**
- Modify: `src/storage/beers.ts` (add `loadCatalog`)
- Modify: `src/storage/checkins.ts` (add `latestRatingsByBeer`)
- Test: `src/storage/beers.test.ts`, `src/storage/checkins.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/storage/beers.test.ts` (reuse the file's existing `fresh()`/`openDb` setup pattern — open `:memory:`, `migrate`, then insert via `upsertBeer`):

```ts
import { loadCatalog } from './beers';
import { normalizeName, normalizeBrewery } from '../domain/normalize';

describe('loadCatalog', () => {
  it('returns id, brewery, name, abv, rating_global for every beer', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = upsertBeer(db, {
      untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
      style: 'IPA', abv: 6.0, rating_global: 3.85,
      normalized_name: normalizeName('Pan IPAni'),
      normalized_brewery: normalizeBrewery('Trzech Kumpli'),
    });
    const cat = loadCatalog(db);
    expect(cat).toContainEqual({
      id, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85,
    });
  });
});
```

> Note: `BeerInput` (`src/storage/beers.ts:3-12`) requires the NOT-NULL
> `normalized_name`/`normalized_brewery` fields — they're computed with the real
> normalize helpers above. `loadCatalog` selects only the 5 columns asserted.

Add to `src/storage/checkins.test.ts`:

```ts
import { latestRatingsByBeer } from './checkins';

describe('latestRatingsByBeer', () => {
  it('returns the most recent non-null rating per beer for the user', () => {
    const db = openDb(':memory:'); migrate(db);
    const base = { telegram_id: 1, venue: null as string | null };
    mergeCheckin(db, { ...base, checkin_id: 'c1', beer_id: 10, user_rating: 3.0, checkin_at: '2026-01-01T00:00:00Z' });
    mergeCheckin(db, { ...base, checkin_id: 'c2', beer_id: 10, user_rating: 4.5, checkin_at: '2026-03-01T00:00:00Z' });
    mergeCheckin(db, { ...base, checkin_id: 'c3', beer_id: 11, user_rating: null, checkin_at: '2026-03-02T00:00:00Z' });
    const map = latestRatingsByBeer(db, 1);
    expect(map.get(10)).toBe(4.5);   // newer checkin wins
    expect(map.has(11)).toBe(false); // null rating not recorded
  });

  it('falls back to an older non-null rating when the newest is null', () => {
    const db = openDb(':memory:'); migrate(db);
    const base = { telegram_id: 1, venue: null as string | null };
    mergeCheckin(db, { ...base, checkin_id: 'd1', beer_id: 20, user_rating: 3.7, checkin_at: '2026-01-01T00:00:00Z' });
    mergeCheckin(db, { ...base, checkin_id: 'd2', beer_id: 20, user_rating: null, checkin_at: '2026-05-01T00:00:00Z' });
    expect(latestRatingsByBeer(db, 1).get(20)).toBe(3.7);
  });
});
```

> Ensure `mergeCheckin` is imported in `checkins.test.ts` (it is part of the same module).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/storage/beers.test.ts -t loadCatalog src/storage/checkins.test.ts -t latestRatingsByBeer`
Expected: FAIL — `loadCatalog`/`latestRatingsByBeer` not exported.

- [ ] **Step 3: Write the implementations**

Add to `src/storage/beers.ts`:

```ts
export interface CatalogRow {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
  rating_global: number | null;
}

export function loadCatalog(db: DB): CatalogRow[] {
  return db
    .prepare('SELECT id, brewery, name, abv, rating_global FROM beers')
    .all() as CatalogRow[];
}
```

Add to `src/storage/checkins.ts` (uses the existing `checkinsForUser`, which is already `ORDER BY checkin_at DESC`):

```ts
// Most recent non-null personal rating per beer. Iterates newest-first and
// keeps the first non-null rating seen for each beer_id.
export function latestRatingsByBeer(db: DB, telegramId: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of checkinsForUser(db, telegramId)) {
    if (c.beer_id === null || c.user_rating === null) continue;
    if (!out.has(c.beer_id)) out.set(c.beer_id, c.user_rating);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/storage/beers.test.ts -t loadCatalog src/storage/checkins.test.ts -t latestRatingsByBeer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/beers.ts src/storage/beers.test.ts src/storage/checkins.ts src/storage/checkins.test.ts
git commit -m "feat(storage): loadCatalog + latestRatingsByBeer for the match API"
```

---

### Task 4: Pure matching function `matchBeerList`

**Files:**
- Create: `src/domain/match-list.ts`
- Test: `src/domain/match-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/match-list.test.ts`:

```ts
import { matchBeerList, type CatalogBeerWithRating } from './match-list';

const catalog: CatalogBeerWithRating[] = [
  { id: 105, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85 },
  { id: 200, brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7 },
];

describe('matchBeerList', () => {
  it('marks a matched, drunk beer with its personal rating', () => {
    const res = matchBeerList(
      catalog,
      new Set([105]),
      new Map([[105, 4.0]]),
      [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }],
    );
    expect(res).toEqual([
      {
        raw: { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
        matched_beer: { id: 105, name: 'Pan IPAni', brewery: 'Trzech Kumpli', rating_global: 3.85 },
        is_drunk: true,
        user_rating: 4.0,
      },
    ]);
  });

  it('drunk via had-list only → is_drunk true, user_rating null', () => {
    const res = matchBeerList(catalog, new Set([200]), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
    ]);
    expect(res[0].is_drunk).toBe(true);
    expect(res[0].user_rating).toBeNull();
  });

  it('no catalog match → matched_beer null, not drunk', () => {
    const res = matchBeerList(catalog, new Set(), new Map(), [
      { brewery: 'Nowhere', name: 'Unknown Stout' },
    ]);
    expect(res[0]).toEqual({
      raw: { brewery: 'Nowhere', name: 'Unknown Stout' },
      matched_beer: null,
      is_drunk: false,
      user_rating: null,
    });
  });

  it('preserves input order', () => {
    const res = matchBeerList(catalog, new Set(), new Map(), [
      { brewery: 'PINTA', name: 'Atak Chmielu' },
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(res.map((r) => r.matched_beer?.id)).toEqual([200, 105]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/match-list.test.ts`
Expected: FAIL — cannot find module `./match-list`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/match-list.ts`:

```ts
import { matchBeer, type CatalogBeer } from './matcher';

export interface CatalogBeerWithRating extends CatalogBeer {
  rating_global: number | null;
}

export interface MatchInput {
  brewery: string;
  name: string;
  abv?: number | null;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
}

export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  user_rating: number | null;
}

export function matchBeerList(
  catalog: CatalogBeerWithRating[],
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
): MatchListResult[] {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  return items.map((item) => {
    const raw = { brewery: item.brewery, name: item.name };
    const m = matchBeer(item, catalog);
    if (!m) {
      return { raw, matched_beer: null, is_drunk: false, user_rating: null };
    }
    const beer = byId.get(m.id)!;
    return {
      raw,
      matched_beer: {
        id: beer.id,
        name: beer.name,
        brewery: beer.brewery,
        rating_global: beer.rating_global,
      },
      is_drunk: drunkSet.has(m.id),
      user_rating: ratingByBeerId.get(m.id) ?? null,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/match-list.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/match-list.ts src/domain/match-list.test.ts
git commit -m "feat(domain): matchBeerList pure function for the extension API"
```

---

### Task 5: Install Hono dependencies + `API_PORT` config

**Files:**
- Modify: `package.json` (via npm)
- Modify: `src/config/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install runtime deps**

Run:
```bash
npm install hono @hono/node-server @hono/zod-validator
```
Expected: three packages added to `dependencies` in `package.json`.

- [ ] **Step 2: Add `API_PORT` to the env schema**

In `src/config/env.ts`, add to the `Schema` object (e.g. after `DEFAULT_ROUTE_N`):

```ts
  API_PORT: z.coerce.number().int().positive().default(3000),
```

- [ ] **Step 3: Document the env var**

In `.env.example`, add a line:

```
# Port for the embedded read-only extension API (bound to 127.0.0.1)
API_PORT=3000
```

- [ ] **Step 4: Verify the build typechecks**

Run: `npx tsc --noEmit`
Expected: no errors (env type now includes `API_PORT`).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/config/env.ts .env.example
git commit -m "chore(api): add hono deps and API_PORT config"
```

---

### Task 6: Auth middleware

**Files:**
- Create: `src/api/types.ts`
- Create: `src/api/middleware/auth.ts`
- Test: `src/api/middleware/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/middleware/auth.test.ts`:

```ts
import { Hono } from 'hono';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { authMiddleware } from './auth';
import type { ApiEnv } from '../types';

function appWithAuth() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 777);
  rotateToken(db, 777, hashToken('good-token'), '2026-06-07T00:00:00Z');
  const app = new Hono<ApiEnv>();
  app.use('/secure', authMiddleware(db));
  app.get('/secure', (c) => c.json({ telegramId: c.get('telegramId') }));
  return app;
}

describe('authMiddleware', () => {
  it('401 when Authorization header is missing', async () => {
    const res = await appWithAuth().request('/secure');
    expect(res.status).toBe(401);
  });

  it('401 when the token is unknown', async () => {
    const res = await appWithAuth().request('/secure', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('passes and sets telegramId for a valid token', async () => {
    const res = await appWithAuth().request('/secure', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: 777 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/middleware/auth.test.ts`
Expected: FAIL — cannot find module `./auth` / `../types`.

- [ ] **Step 3: Write the implementations**

Create `src/api/types.ts`:

```ts
import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type pino from 'pino';

export interface ApiDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
}

// Hono generics: variables set on the request context by middleware.
export type ApiEnv = { Variables: { telegramId: number } };
```

Create `src/api/middleware/auth.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import type { DB } from '../../storage/db';
import type { ApiEnv } from '../types';
import { hashToken, findTelegramIdByHash } from '../../storage/api_tokens';

export function authMiddleware(db: DB): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const m = header?.match(/^Bearer (.+)$/);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const telegramId = findTelegramIdByHash(db, hashToken(m[1]));
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('telegramId', telegramId);
    await next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/api/middleware/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/types.ts src/api/middleware/auth.ts src/api/middleware/auth.test.ts
git commit -m "feat(api): Bearer-token auth middleware"
```

---

### Task 7: `/match` route handler

**Files:**
- Create: `src/api/routes/match.ts`
- Test: `src/api/routes/match.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/routes/match.ts` is needed by the app (Task 8). Write the handler test against the full app once Task 8 exists — but to keep this task self-contained, test the handler factory directly here by mounting it on a minimal Hono app with a stubbed `telegramId`.

Create `src/api/routes/match.test.ts`:

```ts
import { Hono } from 'hono';
import pino from 'pino';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { upsertBeer } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { normalizeName, normalizeBrewery } from '../../domain/normalize';
import { matchRoute } from './match';
import type { ApiEnv } from '../types';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  ensureProfile(db, 2);
  const panIpani = upsertBeer(db, {
    untappd_id: 9001, name: 'Pan IPAni', brewery: 'Trzech Kumpli',
    style: 'IPA', abv: 6.0, rating_global: 3.85,
    normalized_name: normalizeName('Pan IPAni'),
    normalized_brewery: normalizeBrewery('Trzech Kumpli'),
  });
  // user 1 drank Pan IPAni (rating 4.0); user 2 did not.
  mergeCheckin(db, {
    checkin_id: 'c1', telegram_id: 1, beer_id: panIpani,
    user_rating: 4.0, checkin_at: '2026-01-01T00:00:00Z', venue: null,
  });
  const log = pino({ level: 'silent' });

  // Mount the handler with a fixed telegramId injected (simulates auth).
  function appAs(telegramId: number) {
    const app = new Hono<ApiEnv>();
    app.use('/match', async (c, next) => { c.set('telegramId', telegramId); await next(); });
    matchRoute(app, { db, env: {} as never, log });
    return app;
  }
  return { appAs, panIpani };
}

function post(app: Hono<ApiEnv>, body: unknown) {
  return app.request('/match', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /match', () => {
  it('returns drunk status + personal rating for the calling user', async () => {
    const { appAs } = setup();
    const res = await post(appAs(1), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({
      matched_beer: { name: 'Pan IPAni', rating_global: 3.85 },
      is_drunk: true,
      user_rating: 4.0,
    });
  });

  it('isolates users — user 2 has not drunk the beer', async () => {
    const { appAs } = setup();
    const res = await post(appAs(2), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    const body = await res.json();
    expect(body.results[0].is_drunk).toBe(false);
    expect(body.results[0].user_rating).toBeNull();
  });

  it('400 on an invalid body', async () => {
    const { appAs } = setup();
    const res = await post(appAs(1), { beers: [] }); // violates .min(1)
    expect(res.status).toBe(400);
  });
});
```

> The two-source drunk path (`untappd_had`) is already unit-covered in
> `domain/match-list.test.ts` (Task 4); this route test focuses on per-user
> scoping and validation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/routes/match.test.ts`
Expected: FAIL — cannot find module `./match`.

- [ ] **Step 3: Write the implementation**

Create `src/api/routes/match.ts`:

```ts
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import { loadCatalog } from '../../storage/beers';
import { triedBeerIds } from '../../storage/untappd_had';
import { latestRatingsByBeer } from '../../storage/checkins';
import { matchBeerList } from '../../domain/match-list';

const MatchBody = z.object({
  beers: z
    .array(
      z.object({
        brewery: z.string(),
        name: z.string(),
        abv: z.number().optional(),
      }),
    )
    .min(1)
    .max(200),
});

// Registers POST /match on the given app. Assumes auth middleware has set
// 'telegramId' on the context for this route.
export function matchRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post('/match', zValidator('json', MatchBody), (c) => {
    const telegramId = c.get('telegramId');
    const { beers } = c.req.valid('json');

    const catalog = loadCatalog(deps.db);
    const drunkSet = triedBeerIds(deps.db, telegramId);
    const ratings = latestRatingsByBeer(deps.db, telegramId);

    const results = matchBeerList(catalog, drunkSet, ratings, beers);
    return c.json({ results });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/api/routes/match.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/match.ts src/api/routes/match.test.ts
git commit -m "feat(api): POST /match route (scoped to token owner)"
```

---

### Task 8: App assembly — CORS, health, error handler, server

**Files:**
- Create: `src/api/index.ts`
- Test: `src/api/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/index.test.ts`:

```ts
import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { ensureProfile } from '../storage/user_profiles';
import { rotateToken, hashToken } from '../storage/api_tokens';
import { createApiApp } from './index';

function deps() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 555);
  rotateToken(db, 555, hashToken('tok'), '2026-06-07T00:00:00Z');
  return { db, env: {} as never, log: pino({ level: 'silent' }) };
}

describe('createApiApp', () => {
  it('GET /health is open and returns ok', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('POST /match requires a valid token', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('sets permissive CORS headers', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/health', { headers: { Origin: 'https://shop.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/api/index.test.ts`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3: Write the implementation**

Create `src/api/index.ts`:

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type pino from 'pino';
import type { Env } from '../config/env';
import type { ApiDeps, ApiEnv } from './types';
import { authMiddleware } from './middleware/auth';
import { matchRoute } from './routes/match';

export function createApiApp(deps: ApiDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  // Requests originate from arbitrary shop domains; auth is a Bearer header
  // (not cookies), so a wildcard origin is safe.
  app.use('*', cors({ origin: '*' }));

  app.get('/health', (c) => c.json({ ok: true }));

  // Auth applies to /match only — /health stays open.
  app.use('/match', authMiddleware(deps.db));
  matchRoute(app, deps);

  app.onError((err, c) => {
    deps.log.error({ err }, 'api error');
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

export function createApiServer(
  app: Hono<ApiEnv>,
  env: Env,
  log: pino.Logger,
): ServerType {
  return serve(
    { fetch: app.fetch, hostname: '127.0.0.1', port: env.API_PORT },
    (info) => log.info({ port: info.port }, 'api listening'),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/api/index.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/index.ts src/api/index.test.ts
git commit -m "feat(api): assemble Hono app (cors, health, auth, error handler)"
```

---

### Task 9: Graceful shutdown of the HTTP server

**Files:**
- Modify: `src/shutdown.ts`
- Test: `src/shutdown.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/shutdown.test.ts` (follow the existing mock style — it builds fake `bot`/`cronJobs`/`db` with jest mocks):

```ts
  it('closes the http server between bot stop and db close', async () => {
    const order: string[] = [];
    const bot = { stop: jest.fn(() => order.push('bot')) };
    const db = { close: jest.fn(() => order.push('db')) };
    const httpServer = {
      close: jest.fn((cb?: (err?: Error) => void) => { order.push('http'); cb?.(); }),
    };
    const log = { info: jest.fn(), error: jest.fn() } as never;
    const shutdown = createShutdown({ bot, cronJobs: [], db, httpServer, log });
    await shutdown('SIGTERM');
    expect(order).toEqual(['bot', 'http', 'db']);
  });

  it('works when no http server is provided', async () => {
    const bot = { stop: jest.fn() };
    const db = { close: jest.fn() };
    const log = { info: jest.fn(), error: jest.fn() } as never;
    const shutdown = createShutdown({ bot, cronJobs: [], db, log });
    await expect(shutdown('SIGINT')).resolves.toBeUndefined();
    expect(db.close).toHaveBeenCalled();
  });
```

> Check the top of `src/shutdown.test.ts` for the exact import of `createShutdown` and reuse the file's existing `log` mock if it defines one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/shutdown.test.ts`
Expected: FAIL — `httpServer` not part of `ShutdownDeps`; order assertion fails.

- [ ] **Step 3: Update the implementation**

In `src/shutdown.ts`, extend `ShutdownDeps` and the teardown sequence:

```ts
export interface ShutdownDeps {
  bot: Pick<Telegraf<never>, 'stop'>;
  cronJobs: Pick<ScheduledTask, 'stop'>[];
  db: Pick<DB, 'close'>;
  httpServer?: { close: (cb?: (err?: Error) => void) => void };
  log: pino.Logger;
}
```

Inside `shutdown`, between the `bot.stop` block and the `db.close` block, add:

```ts
    if (deps.httpServer) {
      try {
        await new Promise<void>((resolve) => deps.httpServer!.close(() => resolve()));
      } catch (err) { deps.log.error({ err }, 'http server close failed'); }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/shutdown.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/shutdown.ts src/shutdown.test.ts
git commit -m "feat(shutdown): close http server before db (cron→bot→http→db)"
```

---

### Task 10: i18n strings for `/extension`

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/locales/uk.ts`, `src/i18n/locales/pl.ts`, `src/i18n/locales/en.ts`

- [ ] **Step 1: Add the message keys to the type**

In `src/i18n/types.ts`, add to the `Messages` interface — one in the command-catalog group and a new `extension` group:

```ts
  'cmd.extension': string;
```
```ts
  // extension (browser-extension API token)
  'extension.success': string;   // {url} — instructional text; token sent separately in <code>
```

- [ ] **Step 2: Add translations to all three locales**

In `src/i18n/locales/uk.ts` add near `'cmd.help'`:
```ts
  'cmd.extension': 'токен для браузерного розширення',
```
and a new block:
```ts
  // extension
  'extension.success':
    'Ваш токен доступу для браузерного розширення. Додайте його в налаштування ' +
    'розширення (поле «API Token»). Старий токен, якщо був, більше не діє.\n' +
    'Адреса API: {url}',
```

In `src/i18n/locales/pl.ts`:
```ts
  'cmd.extension': 'token dla rozszerzenia przeglądarki',
```
```ts
  // extension
  'extension.success':
    'Twój token dostępu do rozszerzenia przeglądarki. Dodaj go w ustawieniach ' +
    'rozszerzenia (pole „API Token”). Poprzedni token, jeśli istniał, przestał działać.\n' +
    'Adres API: {url}',
```

In `src/i18n/locales/en.ts`:
```ts
  'cmd.extension': 'browser-extension access token',
```
```ts
  // extension
  'extension.success':
    'Your access token for the browser extension. Add it to the extension ' +
    "settings (the \"API Token\" field). Any previous token has been revoked.\n" +
    'API URL: {url}',
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (all three locales satisfy the `Messages` interface; a missing key would fail here).

- [ ] **Step 4: Commit**

```bash
git add src/i18n/types.ts src/i18n/locales/uk.ts src/i18n/locales/pl.ts src/i18n/locales/en.ts
git commit -m "feat(i18n): strings for the /extension command"
```

---

### Task 11: `/extension` Telegram command

**Files:**
- Create: `src/bot/commands/extension.ts`
- Modify: `src/bot/commands/catalog.ts` (register in `COMMAND_CATALOG`)
- Test: `src/bot/commands/extension.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/extension.test.ts` (tests the pure message builder + token generation/rotation; the Composer handler is thin glue):

```ts
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { findTelegramIdByHash, hashToken } from '../../storage/api_tokens';
import { generateAndStoreToken, buildExtensionMessage } from './extension';

describe('generateAndStoreToken', () => {
  it('mints a 64-hex token, stores its hash, and rotates 1:1', () => {
    const db = openDb(':memory:'); migrate(db);
    ensureProfile(db, 42);
    const first = generateAndStoreToken(db, 42, '2026-06-07T00:00:00Z');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(findTelegramIdByHash(db, hashToken(first))).toBe(42);

    const second = generateAndStoreToken(db, 42, '2026-06-07T01:00:00Z');
    expect(second).not.toBe(first);
    expect(findTelegramIdByHash(db, hashToken(first))).toBeNull(); // old revoked
    expect(findTelegramIdByHash(db, hashToken(second))).toBe(42);
  });
});

describe('buildExtensionMessage', () => {
  it('wraps the token in a <code> block and escapes the instructions', () => {
    const t = ((key: string, params?: Record<string, string>) =>
      key === 'extension.success' ? `Use & enjoy: ${params?.url}` : key) as never;
    const html = buildExtensionMessage(t, 'deadbeef', 'https://beer-api.example/match');
    expect(html).toContain('<code>deadbeef</code>');
    expect(html).toContain('Use &amp; enjoy:'); // & escaped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/commands/extension.test.ts`
Expected: FAIL — cannot find module `./extension`.

- [ ] **Step 3: Write the implementation**

Create `src/bot/commands/extension.ts`:

```ts
import { randomBytes } from 'crypto';
import { Composer } from 'telegraf';
import type { BotContext } from '../index';
import type { Translator } from '../../i18n/types';
import type { DB } from '../../storage/db';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { escapeHtml } from './newbeers-format';

// Public hostname served via the Cloudflare tunnel → 127.0.0.1:API_PORT.
const API_URL = 'https://beer-api.ysilvestrov-ai.uk/match';

// Mints a fresh raw token, stores only its hash (1:1 rotation), returns the raw.
export function generateAndStoreToken(db: DB, telegramId: number, at: string): string {
  const raw = randomBytes(32).toString('hex');
  rotateToken(db, telegramId, hashToken(raw), at);
  return raw;
}

// HTML message: escaped instructions + raw token in a copy-friendly <code> block.
// The token is hex, so it needs no escaping; instructions go through escapeHtml
// (locale strings may contain & or angle brackets).
export function buildExtensionMessage(t: Translator, token: string, url: string): string {
  return `${escapeHtml(t('extension.success', { url }))}\n\n<code>${token}</code>`;
}

export const extensionCommand = new Composer<BotContext>();

extensionCommand.command('extension', async (ctx) => {
  ensureProfile(ctx.deps.db, ctx.from.id);
  const token = generateAndStoreToken(ctx.deps.db, ctx.from.id, new Date().toISOString());
  await ctx.replyWithHTML(buildExtensionMessage(ctx.t, token, API_URL));
});
```

- [ ] **Step 4: Register in the command catalog**

In `src/bot/commands/catalog.ts`, add to `COMMAND_CATALOG` (e.g. after the `link`/`import` group, before `lang`):

```ts
  { command: 'extension', descKey: 'cmd.extension' },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/bot/commands/extension.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/extension.ts src/bot/commands/extension.test.ts src/bot/commands/catalog.ts
git commit -m "feat(bot): /extension command mints a per-user API token"
```

---

### Task 12: Wire API + command into the composition root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import the new pieces**

In `src/index.ts`, add imports near the other bot-command imports and the shutdown import:

```ts
import { extensionCommand } from './bot/commands/extension';
import { createApiApp, createApiServer } from './api';
```

- [ ] **Step 2: Register the `/extension` command**

In the `bot.use(...)` block, add `extensionCommand` alongside the others (e.g. after `langCommand`):

```ts
    extensionCommand,
```

- [ ] **Step 3: Start the API server and hand it to shutdown**

After `bot.launch();` and `log.info('bot launched');`, add:

```ts
  const apiApp = createApiApp({ db, env, log });
  const apiServer = createApiServer(apiApp, env, log);
```

Then update the shutdown construction to pass the server:

```ts
  const shutdown = createShutdown({ bot, cronJobs, db, httpServer: apiServer, log });
```

- [ ] **Step 4: Verify the build typechecks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the whole test suite**

Run: `npx jest`
Expected: all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire extension API + /extension command into composition root"
```

---

### Task 13: Update `spec.md` (single source of truth)

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Apply the spec edits**

Make these edits to `spec.md`:

1. **§2.2 directory tree** — add an `api/` block:
```
├── api/                    # embedded read-only HTTP API (Hono)
│   ├── index.ts            # createApiApp (cors/health/auth/onError) + createApiServer
│   ├── types.ts            # ApiDeps, ApiEnv (Hono Variables)
│   ├── middleware/auth.ts  # Bearer → sha256 → api_tokens lookup → c.set('telegramId')
│   └── routes/match.ts     # POST /match (scoped to token owner)
```
2. **§3 new table** — add a `3.x api_tokens` subsection: `token_hash TEXT PK (sha256 hex)`, `telegram_id INTEGER NOT NULL → user_profiles ON DELETE CASCADE`, `created_at`. Index `idx_api_tokens_telegram`. Note: 1:1 rotation, raw token never stored.
3. **§3.13 migrations** — add row: `| 8 | api_tokens (browser-extension token auth) |`.
4. **§4 commands** — add a `/extension` entry: mints a per-user API token (1:1 rotation), replies with the raw token in a `<code>` block; only the sha256 hash is persisted.
5. **§5.6 config** — add `API_PORT` (=3000) to the optional env list.
6. **§5.9 / Appendix** — add deploy note: extension API is reachable via the existing Cloudflare tunnel; add public-hostname route `beer-api.ysilvestrov-ai.uk → http://localhost:3000` in the Cloudflare Zero Trust dashboard (tunnel is token-managed → routes live in the dashboard, not a local file). Hono binds `127.0.0.1`; no inbound ports opened.

- [ ] **Step 2: Sanity check**

Run: `git diff --stat spec.md`
Expected: `spec.md` shows insertions across the noted sections.

- [ ] **Step 3: Commit**

```bash
git add spec.md
git commit -m "docs(spec): extension API, api_tokens (v8), /extension, API_PORT"
```

---

### Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npx jest`
Expected: all suites green, including the new `api/`, `domain/match-list`, `storage/api_tokens`, and `schema` v8 tests.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; build succeeds.

- [ ] **Step 3: Smoke-test the API locally (manual)**

Run the bot with a temp DB, then:
```bash
curl -s http://127.0.0.1:3000/health
# → {"ok":true}
curl -s -X POST http://127.0.0.1:3000/match -H 'Content-Type: application/json' \
  -d '{"beers":[{"brewery":"X","name":"Y"}]}'
# → 401 (no token)
```
Then `/extension` in Telegram, copy the token, and:
```bash
curl -s -X POST http://127.0.0.1:3000/match \
  -H 'Content-Type: application/json' -H "Authorization: Bearer <token>" \
  -d '{"beers":[{"brewery":"Trzech Kumpli","name":"Pan IPAni"}]}'
# → {"results":[{ ... "is_drunk": ..., "user_rating": ... }]}
```
Expected: health open, `/match` 401 without token, valid JSON with a token.

---

## Post-implementation (out of plan scope)

- **Manual ops (user):** add the Cloudflare tunnel public-hostname route `beer-api.ysilvestrov-ai.uk → http://localhost:3000`; optionally a Cloudflare WAF rate-limit rule on that hostname.
- **PR review loop** per the project's review conventions (open PR → AI review → assess).
- **Deploy** via `deploy.sh` (restart, not `enable --now`).
- The **browser extension** itself is a separate project that consumes this contract.
