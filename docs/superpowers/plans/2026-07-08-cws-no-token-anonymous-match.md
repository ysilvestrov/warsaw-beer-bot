# CWS graceful no-token via anonymous catalog match — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Without an API token the extension shows global Untappd ratings (⭐/⚪) instead of failing silently, and the popup clearly states the user is unauthenticated — so a Chrome Web Store reviewer can verify the core feature with zero setup.

**Architecture:** `/match` becomes optional-auth: no `Authorization` header → anonymous (global-only, empty drunk/ratings sets); valid token → personal (unchanged); invalid token → 401. The client calls `/match` even with an empty token (omitting the header), so existing ⭐/⚪ badge rendering works unchanged. The popup surfaces the not-authorized state.

**Tech Stack:** Node.js, TypeScript, Hono (API), Telegraf (bot, untouched here), Vitest. Extension is MV3 + Vite.

**Design doc:** `docs/superpowers/specs/2026-07-08-cws-no-token-anonymous-match-design.md`

**Repo rules (must hold in the final PR):**
- `spec.md` is the single source of truth — update it in the same PR (CLAUDE.md).
- Any user-facing `extension/**` change must update `docs/extension-install-uk.md` in the same PR (CLAUDE.md).
- Every new logic module gets Vitest coverage before merge (CLAUDE.md).

**Root commands (run from repo root `/home/ysi/warsaw-beer-bot`):**
- Server tests: `npm test -- <path>` (Vitest).
- Extension tests: `cd extension && npx vitest run <path>` (separate Vitest project).

---

### Task 1: Server — `optionalAuthMiddleware`

New middleware for `/match` only. Mirrors `authMiddleware` but treats a **missing** header as anonymous (calls `next()` without setting `telegramId`) while still 401-ing a **present-but-invalid** token.

**Files:**
- Create: `src/api/middleware/optional-auth.ts`
- Test: `src/api/middleware/optional-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/api/middleware/optional-auth.test.ts`:

```typescript
import { Hono } from 'hono';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { rotateToken, hashToken } from '../../storage/api_tokens';
import { optionalAuthMiddleware } from './optional-auth';
import type { ApiEnv } from '../types';

function appWithOptionalAuth() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 777);
  rotateToken(db, 777, hashToken('good-token'), '2026-06-07T00:00:00Z');
  const app = new Hono<ApiEnv>();
  app.use('/probe', optionalAuthMiddleware(db));
  app.get('/probe', (c) => c.json({ telegramId: c.get('telegramId') ?? null }));
  return app;
}

describe('optionalAuthMiddleware', () => {
  it('passes anonymously (telegramId null) when the Authorization header is missing', async () => {
    const res = await appWithOptionalAuth().request('/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: null });
  });

  it('401 when a token is present but unknown', async () => {
    const res = await appWithOptionalAuth().request('/probe', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('sets telegramId for a valid token', async () => {
    const res = await appWithOptionalAuth().request('/probe', {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telegramId: 777 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/api/middleware/optional-auth.test.ts`
Expected: FAIL — `optionalAuthMiddleware` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/api/middleware/optional-auth.ts`:

```typescript
import type { MiddlewareHandler } from 'hono';
import type { DB } from '../../storage/db';
import type { ApiEnv } from '../types';
import { hashToken, findTelegramIdByHash } from '../../storage/api_tokens';

// Optional-auth for /match: a MISSING Authorization header is anonymous (no
// telegramId set → caller treats it as global-only). A PRESENT but invalid
// token is still rejected with 401 so a broken/typo'd token stays diagnosable.
export function optionalAuthMiddleware(db: DB): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (header === undefined) return next(); // anonymous
    const m = header.match(/^Bearer (.+)$/);
    if (!m) return c.json({ error: 'unauthorized' }, 401);
    const telegramId = findTelegramIdByHash(db, hashToken(m[1]));
    if (telegramId === null) return c.json({ error: 'unauthorized' }, 401);
    c.set('telegramId', telegramId);
    await next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/api/middleware/optional-auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/middleware/optional-auth.ts src/api/middleware/optional-auth.test.ts
git commit -m "feat(api): optional-auth middleware for anonymous /match (#245)"
```

---

### Task 2: Server — anonymous `/match` + wiring

Make `telegramId` nullable on the API context, branch `matchRoute` on it (empty drunk/ratings when null), swap the middleware on `/match`, and keep the auth-gated routes compiling.

**Files:**
- Modify: `src/api/types.ts:12`
- Modify: `src/api/routes/match.ts:26-35`
- Modify: `src/api/index.ts:9-27`
- Modify: `src/api/routes/checkins.ts:20,34` (non-null assertions — auth guarantees a value)
- Test: `src/api/routes/match.test.ts`, `src/api/index.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/api/routes/match.test.ts`, add an anonymous helper and a test inside `describe('POST /match', ...)`. Add this helper next to `appAs` in `setup()` (return it too):

```typescript
  function appAnon() {
    const app = new Hono<ApiEnv>();
    // No middleware sets telegramId → route must treat it as anonymous.
    matchRoute(app, { db, env: {} as never, log });
    return app;
  }
```

Update the `return` of `setup()` to `return { appAs, appAnon, panIpani };` and add:

```typescript
  it('returns global-only data anonymously when no telegramId is set', async () => {
    const { appAnon } = setup();
    const res = await post(appAnon(), { beers: [{ brewery: 'Trzech Kumpli', name: 'Pan IPAni' }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({
      matched_beer: { name: 'Pan IPAni', rating_global: 3.85, untappd_id: 9001 },
      is_drunk: false,
      drunk_uncertain: false,
      user_rating: null,
    });
  });
```

In `src/api/index.test.ts`, replace the `POST /match requires a valid token` test with two tests:

```typescript
  it('POST /match works anonymously when no token is sent (global-only)', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
  });

  it('POST /match rejects a present-but-invalid token with 401', async () => {
    const app = createApiApp(deps());
    const res = await app.request('/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
      body: JSON.stringify({ beers: [{ brewery: 'X', name: 'Y' }] }),
    });
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/api/routes/match.test.ts src/api/index.test.ts`
Expected: FAIL — anonymous request currently 401s (index) and `matchRoute` throws/mistypes on missing telegramId.

- [ ] **Step 3: Make `telegramId` nullable on the context**

In `src/api/types.ts`, change line 12:

```typescript
export type ApiEnv = { Variables: { telegramId: number | null } };
```

- [ ] **Step 4: Branch `matchRoute` on anonymity**

Replace the body of the handler in `src/api/routes/match.ts` (lines 26-35):

```typescript
  app.post('/match', zValidator('json', MatchBody), async (c) => {
    const telegramId = c.get('telegramId') ?? null;
    const { beers } = c.req.valid('json');

    const catalog = loadCatalog(deps.db);
    // Anonymous callers get global-only results: empty drunk/ratings sets mean
    // is_drunk=false, user_rating=null, but matched_beer still carries the global
    // rating + untappd_id (⭐/⚪ badges render unchanged).
    const drunkSet = telegramId === null ? new Set<number>() : triedBeerIds(deps.db, telegramId);
    const ratings = telegramId === null ? new Map<number, number>() : latestRatingsByBeer(deps.db, telegramId);

    const results = await matchBeerList(catalog, drunkSet, ratings, beers);
    return c.json({ results });
  });
```

- [ ] **Step 5: Swap the middleware on `/match`**

In `src/api/index.ts`: add the import and replace the `/match` middleware. Change line 9 area to also import the new middleware:

```typescript
import { authMiddleware } from './middleware/auth';
import { optionalAuthMiddleware } from './middleware/optional-auth';
```

And change lines 25-27 from:

```typescript
  // Auth applies to /match only — /health stays open.
  app.use('/match', authMiddleware(deps.db));
  matchRoute(app, deps);
```

to:

```typescript
  // /match is optional-auth: no token → anonymous global-only; invalid token → 401.
  app.use('/match', optionalAuthMiddleware(deps.db));
  matchRoute(app, deps);
```

- [ ] **Step 6: Keep the auth-gated routes compiling**

`checkins.ts` reads `c.get('telegramId')`, now typed `number | null`. It runs behind `authMiddleware`, which guarantees a value, so assert non-null at both read sites.

In `src/api/routes/checkins.ts` line 20, change:

```typescript
    const telegramId = c.get('telegramId');
```
to:
```typescript
    const telegramId = c.get('telegramId')!; // auth middleware guarantees a value
```

And do the identical change at line 34.

- [ ] **Step 7: Run the full server suite**

Run: `npm test -- src/api`
Expected: PASS. Confirm no type errors: `npx tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add src/api
git commit -m "feat(api): anonymous /match returns global-only ratings (#245)"
```

---

### Task 3: Client — `postMatch` omits the Authorization header when the token is empty

**Files:**
- Modify: `extension/src/api/client.ts:28-48`
- Test: `extension/src/api/client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `extension/src/api/client.test.ts` (follow the file's existing `fetch`-mock style; if it stubs `global.fetch`, reuse that). Add inside the `postMatch` describe (or create one):

```typescript
  it('omits the Authorization header when the token is empty (anonymous match)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await postMatch('https://api.test', '', [{ brewery: 'B', name: 'N' }]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends the Authorization header when a token is present', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await postMatch('https://api.test', 'tok', [{ brewery: 'B', name: 'N' }]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
```

The file already imports `postMatch` and `vi` and has `afterEach(() => vi.restoreAllMocks())`; no extra cleanup needed — each test re-stubs `fetch` via `vi.stubGlobal`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/api/client.test.ts`
Expected: FAIL — Authorization is always `Bearer ` even for empty token.

- [ ] **Step 3: Implement — build headers conditionally**

In `extension/src/api/client.ts`, change the `postMatch` fetch call (lines 34-40) so the header is only added when a token exists:

```typescript
  let res: Response;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    res = await fetchWithTimeout(`${trimBase(baseUrl)}/match`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ beers }),
    }, timeoutMs);
  } catch {
    throw new ApiError('network');
  }
```

(Leave the other `post*` helpers unchanged — enrich/checkins are token-only.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/api/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/api/client.ts extension/src/api/client.test.ts
git commit -m "feat(extension): postMatch omits auth header for anonymous match (#245)"
```

---

### Task 4: Client — `handleMatch` calls `/match` even without a token

Drop the `no-token` short-circuit and remove the now-dead `'no-token'` code from the `MatchReply` union.

**Files:**
- Modify: `extension/src/background/index.ts:12-14,24-39`
- Test: `extension/src/background/handle-match.test.ts:16-20`

- [ ] **Step 1: Update the failing test**

In `extension/src/background/handle-match.test.ts`, replace the first test (lines 16-20, the `no-token` case) with:

```typescript
  it('calls postMatch anonymously (empty token) when no token is set', async () => {
    await setSettings({ token: '', baseUrl: 'https://api.test' });
    const spy = vi.spyOn(client, 'postMatch').mockResolvedValue([mkResult('X')]);
    const reply = await handleMatch({ type: 'match', cards: [{ brewery: 'B', name: 'X' }] });
    expect(reply).toEqual({ type: 'match:ok', results: [mkResult('X')] });
    expect(spy).toHaveBeenCalledWith('https://api.test', '', [{ brewery: 'B', name: 'X' }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/background/handle-match.test.ts`
Expected: FAIL — `handleMatch` returns `{ type: 'match:err', code: 'no-token' }` instead of calling `postMatch`.

- [ ] **Step 3: Implement — remove the short-circuit and the dead union member**

In `extension/src/background/index.ts`:

Change the `MatchReply` type (lines 12-14) to drop `'no-token'`:

```typescript
export type MatchReply =
  | { type: 'match:ok'; results: MatchResult[] }
  | { type: 'match:err'; code: 'unauthorized' | 'server' | 'network' };
```

In `handleMatch` (lines 24-26), remove the early return so an empty token falls through to an anonymous call:

```typescript
export async function handleMatch(msg: MatchMessage): Promise<MatchReply> {
  const { token, baseUrl } = await getSettings();
  try {
```

(Delete the `if (!token) return { type: 'match:err', code: 'no-token' };` line. The rest of the function is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/background`
Expected: PASS. Then `cd extension && npx tsc --noEmit` to confirm no consumer still references `'no-token'`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/background/index.ts extension/src/background/handle-match.test.ts
git commit -m "feat(extension): match anonymously when no token is set (#245)"
```

---

### Task 5: Popup — show the "not authorized" state

When the stored token is empty, the popup shows a note that only global ratings are visible plus a button that opens Options. Extract a pure helper for the note text so it is unit-testable.

**Files:**
- Modify: `extension/src/popup/popup.html:14-19`
- Modify: `extension/src/popup/popup.ts` (add `authNoteText`, wire into `initPopup`)
- Test: `extension/src/popup/popup.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `extension/src/popup/popup.test.ts`:

```typescript
import { authNoteText } from './popup';

describe('authNoteText', () => {
  it('returns the not-authorized note when there is no token', () => {
    expect(authNoteText(false)).toBe(
      'Не авторизовано — показуються лише глобальні рейтинги (⭐). Додай токен, щоб бачити «вже пив» ✅ і свою оцінку.',
    );
  });
  it('returns null when a token is present', () => {
    expect(authNoteText(true)).toBeNull();
  });
});
```

(Add `authNoteText` to the existing top-of-file import from `'./popup'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/popup/popup.test.ts`
Expected: FAIL — `authNoteText` is not exported.

- [ ] **Step 3: Implement the helper + DOM wiring**

In `extension/src/popup/popup.ts`, add the pure helper near the top (after the imports):

```typescript
/** Popup note shown when the extension has no token: global-only, with how to authorize. */
export function authNoteText(hasToken: boolean): string | null {
  return hasToken
    ? null
    : 'Не авторизовано — показуються лише глобальні рейтинги (⭐). Додай токен, щоб бачити «вже пив» ✅ і свою оцінку.';
}
```

Add the config import at the top of the file:

```typescript
import { getSettings } from '../shared/config';
```

Inside `initPopup`, after the `const [tab] = await chrome.tabs.query(...)` block, add:

```typescript
  const authNote = el<HTMLElement>('authNote');
  const getTokenBtn = el<HTMLButtonElement>('getToken');
  const { token } = await getSettings();
  const note = authNoteText(Boolean(token));
  if (authNote && getTokenBtn) {
    if (note) {
      authNote.textContent = note;
      authNote.style.display = '';
      getTokenBtn.style.display = '';
      getTokenBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
    } else {
      authNote.style.display = 'none';
      getTokenBtn.style.display = 'none';
    }
  }
```

- [ ] **Step 4: Add the popup markup**

In `extension/src/popup/popup.html`, insert after the `syncStatus` paragraph (line 19), before `</main>`:

```html
      <p id="authNote" class="status" style="display:none" aria-live="polite"></p>
      <button id="getToken" type="button" style="display:none">Як отримати токен</button>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd extension && npx vitest run src/popup/popup.test.ts`
Expected: PASS. Then `cd extension && npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add extension/src/popup/popup.ts extension/src/popup/popup.html extension/src/popup/popup.test.ts
git commit -m "feat(extension): popup shows not-authorized state + get-token button (#245)"
```

---

### Task 6: Docs, spec, CHANGELOG, and CWS review notes

Repo rules require `spec.md` + `docs/extension-install-uk.md` in the same PR. Add the CWS reviewer notes and a CHANGELOG entry.

**Files:**
- Modify: `spec.md` (§4 HTTP API `/match` + a note near §3.11 `api_tokens`)
- Modify: `docs/extension-install-uk.md`
- Create: `docs/cws-review-notes.md`
- Modify: `extension/CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Update `spec.md`**

Find the `POST /match` description in §4 (search for `/match`). Add/adjust so it documents optional-auth. Insert this note under the `/match` endpoint description:

```markdown
**Optional-auth (#245).** `/match` is the only endpoint that accepts *anonymous*
requests. With no `Authorization` header the server matches against the catalog and
returns **global-only** fields (`matched_beer.rating_global`, `matched_beer.untappd_id`);
`is_drunk`, `drunk_uncertain` and `user_rating` are always false/null. A present but
invalid token still yields `401` (so a broken token is diagnosable). A valid token
returns personal drunk-status + rating as before. This lets a freshly-installed
extension (e.g. a Chrome Web Store reviewer with no bot token) show ⭐/⚪ badges
immediately. `/enrich/*` and `/checkins/*` remain token-only.
```

Near the `api_tokens` §3.11 auth line (`Bearer → sha256 → api_tokens → c.set('telegramId')`), add: `для /match авторизація опційна — див. §4 (анонімний global-only match).`

- [ ] **Step 2: Update `docs/extension-install-uk.md`**

Add a short subsection explaining the no-token behavior. Place it right after the intro list of supported shops (after the "Працює на:" list, before "## Передумови"):

```markdown
### Що видно без токена

Розширення працює навіть **без токена**: на сторінках магазинів показуються
**глобальні рейтинги Untappd** (бейдж ⭐) і посилання на пиво/пошук. Це дозволяє
одразу побачити, як воно працює.

Персональні можливості вмикає **токен** (Частина 2): бейдж ✅ «ти вже це пив» із
**твоєю** оцінкою, ❓ для ймовірних збігів, а також пошук відсутніх пив і
синхронізація чекінів. Popup розширення підкаже «Не авторизовано», поки токен не
додано.
```

- [ ] **Step 3: Create `docs/cws-review-notes.md`**

```markdown
# Chrome Web Store — review notes (Warsaw Beer Overlay)

## What the extension does

It overlays your personal Untappd status and ratings onto craft-beer shop pages
(BeerRepublic, OneMoreBeer, BeerFreak, Bierloods22, WineTime, Hoptimaal, Flasker,
Piwne Mosty, Funkyshop). For each product it shows a badge:

- ⭐ + number — the beer's **global** Untappd rating.
- ⚪ — the beer is known but has no linked Untappd id yet.
- ✅ (+ your rating) — you have already checked this beer in (requires a token).
- ❓ — a probable (fuzzy) match you may have had.

## How to verify WITHOUT any setup (anonymous mode)

No account, login, or token is required to see the core feature:

1. Install the extension.
2. Open any supported shop, e.g. `https://onemorebeer.pl/` and browse to a beer
   listing/category page.
3. Wait ~1–2s: ⭐ rating badges appear on beers present in our catalog. Clicking a
   badge opens the beer (or an Untappd search) in a new tab.
4. Click the toolbar icon: the popup shows **"Не авторизовано — показуються лише
   глобальні рейтинги (⭐)"** with a **"Як отримати токен"** button. This is the
   expected unauthenticated state — the extension is fully functional for global
   ratings; a token only adds personal ✅/rating data.

## Authorized mode (optional)

Personal "already drank" badges require a token issued by the project's Telegram
bot (`/extension` command) after a user imports their own Untappd history. This is
opt-in and not needed to review the core functionality.

## Permissions

- Host access to the supported shop domains — to read product names and inject
  rating badges.
- `untappd.com` + `*.algolia.net` are **optional** and requested only if the user
  enables "find missing beers" / check-in sync.

## Privacy

See the published privacy policy. Anonymous `/match` sends only shop product
names/breweries to the backend and returns public catalog ratings — no personal or
account data is involved unless the user adds a token.
```

- [ ] **Step 4: Add the CHANGELOG entry**

In `extension/CHANGELOG.md`, under `## [Unreleased]`, add a bullet:

```markdown
- Extension now shows global Untappd ratings (⭐) on supported shops even without a token; the popup states "Не авторизовано" and links to token setup. Personal ✅/rating badges still require a token.
```

- [ ] **Step 5: Verify docs reference reality**

Run: `grep -n "Не авторизовано" extension/src/popup/popup.ts docs/extension-install-uk.md docs/cws-review-notes.md`
Expected: the exact same phrase appears in all three (popup helper text + docs).

- [ ] **Step 6: Commit**

```bash
git add spec.md docs/extension-install-uk.md docs/cws-review-notes.md extension/CHANGELOG.md
git commit -m "docs: anonymous /match + CWS review notes + no-token UX (#245)"
```

---

### Task 7: Full verification + PR

- [ ] **Step 1: Run both test suites**

Run: `npm test` (server) and `cd extension && npx vitest run` (extension). Then `npx tsc --noEmit` in both root and `extension/`.
Expected: all green, no type errors.

- [ ] **Step 2: Build the extension**

Run: `cd extension && npm run build`
Expected: build succeeds (confirms popup.html + new elements compile through Vite).

- [ ] **Step 3: Open the PR**

Push the branch and open a PR referencing #245. Body should summarize: anonymous global-only `/match`, popup not-authorized state, docs/spec/review-notes. Then follow the PR review loop (wait for the AI review, assess + address comments) before merge.

---

## Notes for the executor

- **Commit location guard:** all `git` commands must run in the working checkout for this branch. Before each commit run `git rev-parse --show-toplevel` and `git branch --show-current` and confirm they match the intended worktree/branch — do not commit into the main checkout by mistake.
- **Two Vitest projects:** the root suite and `extension/` are separate. Run each with its own command as shown.
- **No release/broadcast in this PR:** version bump + zip + `extension_releases` broadcast are a separate ops step (see release-ops runbook). This PR only lands the code + docs + a `[Unreleased]` CHANGELOG line.
