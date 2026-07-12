# API Request Body Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect extension-facing API routes from oversized request bodies and fields while returning a stable 413 response and logging safe, attributable evidence for tuning and abuse analysis.

**Architecture:** Add one API-local middleware module that owns fixed byte/character constants, wraps Hono's `bodyLimit`, classifies request authentication for observability, and maps Zod string-size failures to the same 413 contract. Apply it globally in the Hono composition root and more tightly on the four affected POST routes before validation, leaving existing authentication, handlers, and domain logic unchanged.

**Tech Stack:** TypeScript, Hono 4 `bodyLimit`, `@hono/zod-validator`, Zod 4, Pino, Vitest, better-sqlite3.

---

## File Map

- Create `src/api/middleware/payload-limit.ts`: limits, safe auth attribution,
  warning logs, Hono byte limiter, and Zod size-error hook.
- Create `src/api/middleware/payload-limit.test.ts`: byte, stream, error, auth, and
  log-safety tests.
- Modify `src/api/index.ts` and `src/api/index.test.ts`: global 4 MiB ceiling.
- Modify `src/api/routes/{checkins,enrich,match}.ts` and their tests: tighter body and
  string limits.
- Modify `spec.md`: limits, 413 contract, logging, and one-week review.

### Task 1: Shared payload-limit primitives

**Files:**
- Create: `src/api/middleware/payload-limit.ts`
- Create: `src/api/middleware/payload-limit.test.ts`

- [ ] **Step 1: Write failing byte-limit tests**

Create a Hono test app with an in-memory migrated database, a valid token for Telegram
ID 555, and a Pino-compatible logger stub whose `warn` is `vi.fn()`. Install the future
middleware on `POST /body`. Add these tests:

```ts
it('rejects a declared body above the byte limit with stable JSON', async () => {
  const { app } = setup(32);
  const res = await app.request('/body', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(40) }),
  });
  expect(res.status).toBe(413);
  expect(await res.json()).toEqual({ error: 'payload_too_large' });
});

it('stops a streamed body without content-length after the byte limit', async () => {
  const { app } = setup(8);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12345'));
      controller.enqueue(new TextEncoder().encode('67890'));
      controller.close();
    },
  });
  const request = new Request('http://localhost/body', {
    method: 'POST', body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  expect((await app.fetch(request)).status).toBe(413);
});
```

Add table-driven cases for missing Authorization, valid `Bearer tok`, and invalid
`Bearer nope`. Verify `auth` is respectively `anonymous`, `authenticated`, or
`invalid`, and only the valid case includes `telegramId: 555`. Assert:

```ts
expect(warn).toHaveBeenCalledWith(
  expect.objectContaining({
    method: 'POST', path: '/body', rejectionLayer: 'route',
    limit: 32, limitUnit: 'bytes', auth: 'authenticated', telegramId: 555,
  }),
  'api payload too large',
);
```

Stringify captured warning arguments and assert they do not contain `tok`, `nope`,
the SHA-256 token hash, or the repeated body value.

- [ ] **Step 2: Write failing schema-hook tests**

Call `payloadSizeValidationHook` with a real failed parse from
`z.object({ html: z.string().max(4) }).safeParse({ html: '12345' })`. Assert it returns
a 413 response and logs `rejectionLayer: 'schema'`, `limit: 4`,
`limitUnit: 'characters'`, and `fieldPath: 'html'`. Pass a missing-field failure and
assert the hook returns `undefined`, preserving ordinary validator behavior.

- [ ] **Step 3: Run tests and verify RED**

Run `npx vitest run src/api/middleware/payload-limit.test.ts`.

Expected: FAIL because `./payload-limit` does not exist.

- [ ] **Step 4: Implement fixed constants and Hono middleware**

Create `src/api/middleware/payload-limit.ts` with:

```ts
export const MIB = 1024 * 1024;
export const KIB = 1024;
export const GLOBAL_BODY_LIMIT_BYTES = 4 * MIB;
export const CHECKINS_SYNC_BODY_LIMIT_BYTES = 1 * MIB;
export const ENRICH_RESULT_BODY_LIMIT_BYTES = 512 * KIB;
export const MATCH_BODY_LIMIT_BYTES = 256 * KIB;
export const ENRICH_CANDIDATES_BODY_LIMIT_BYTES = 256 * KIB;
export const CHECKINS_HTML_LIMIT_CHARS = 768 * KIB;
export const ENRICH_HTML_LIMIT_CHARS = 384 * KIB;
export const BEER_TEXT_LIMIT_CHARS = 512;
export const PAGE_URL_LIMIT_CHARS = 2_048;
export const CURSOR_LIMIT_CHARS = 512;
```

Wrap Hono's `bodyLimit`:

```ts
export function payloadBodyLimit(
  deps: ApiDeps,
  maxSize: number,
  rejectionLayer: 'global' | 'route',
): MiddlewareHandler<ApiEnv> {
  return bodyLimit({
    maxSize,
    onError: (c) => payloadTooLarge(c, deps, {
      rejectionLayer, limit: maxSize, limitUnit: 'bytes',
    }),
  });
}
```

The common responder must return `c.json({ error: 'payload_too_large' }, 413)` and
warn with method, path, rejection layer, limit, unit, a finite non-negative integer
`contentLength` or `null`, auth classification, optional `telegramId`, and optional
`fieldPath`.

- [ ] **Step 5: Implement safe attribution and Zod mapping**

Use this identity union:

```ts
type RequestIdentity =
  | { auth: 'anonymous' }
  | { auth: 'invalid' }
  | { auth: 'authenticated'; telegramId: number };
```

Prefer a numeric `c.get('telegramId')`. Otherwise classify a missing header as
anonymous, malformed/non-Bearer credentials as invalid, and resolve a bearer value
through existing `hashToken` and `findTelegramIdByHash`. Perform this lookup only from
the rejection logger.

`payloadSizeValidationHook(deps)` selects the first failed Zod issue with
`code === 'too_big'` and `origin === 'string'`, then responds/logs with schema layer,
`issue.maximum`, character units, and `issue.path.join('.')`. Return `undefined` for
all other validation failures.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
npx vitest run src/api/middleware/payload-limit.test.ts
npm run typecheck
git diff --check
```

Expected: all exit 0. Commit:

```bash
git add src/api/middleware/payload-limit.ts src/api/middleware/payload-limit.test.ts
git commit -m "fix(api): add attributable payload limit middleware"
```

### Task 2: Install the global 4 MiB ceiling

**Files:**
- Modify: `src/api/index.ts`
- Modify: `src/api/index.test.ts`

- [ ] **Step 1: Write failing global tests**

Expose a `warn` spy from the existing dependency helper. Add anonymous and valid
`Bearer tok` requests to `/match` whose bodies exceed `GLOBAL_BODY_LIMIT_BYTES`.
Assert stable 413 JSON; assert global-layer warnings; and assert only the valid token
case includes `auth: 'authenticated', telegramId: 555`.

- [ ] **Step 2: Verify RED**

Run `npx vitest run src/api/index.test.ts`.

Expected: FAIL because the app proceeds to JSON validation instead of global 413.

- [ ] **Step 3: Add global middleware**

In `createApiApp`, immediately after CORS and before `/health` and route auth, add:

```ts
app.use('*', payloadBodyLimit(deps, GLOBAL_BODY_LIMIT_BYTES, 'global'));
```

Do not move or change existing auth middleware.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
npx vitest run src/api/index.test.ts src/api/middleware/payload-limit.test.ts
npm run typecheck
git diff --check
```

Expected: all exit 0. Commit:

```bash
git add src/api/index.ts src/api/index.test.ts
git commit -m "fix(api): enforce a global request body ceiling"
```

### Task 3: Add tight route and field limits

**Files:**
- Modify: `src/api/routes/checkins.ts`
- Modify: `src/api/routes/checkins.test.ts`
- Modify: `src/api/routes/enrich.ts`
- Modify: `src/api/routes/enrich.test.ts`
- Modify: `src/api/routes/match.ts`
- Modify: `src/api/routes/match.test.ts`

- [ ] **Step 1: Write failing check-in tests**

Expose a warning spy. Test an above-`CHECKINS_SYNC_BODY_LIMIT_BYTES` raw body and an
under-body-limit object with `html` one character above `CHECKINS_HTML_LIMIT_CHARS`.
Expect route/schema 413 metadata respectively. Verify check-in count and sync state do
not change. Add `{}` and assert ordinary malformed input remains 400.

- [ ] **Step 2: Verify check-in RED**

Run `npx vitest run src/api/routes/checkins.test.ts`.

Expected: FAIL because size-specific 413 handling is absent.

- [ ] **Step 3: Implement check-in limits**

Use:

```ts
const SyncBody = z.object({
  html: z.string().max(CHECKINS_HTML_LIMIT_CHARS),
  maxId: z.string().max(CURSOR_LIMIT_CHARS).nullable().optional(),
});
```

Register middleware in this order:

```ts
app.post(
  '/checkins/sync',
  payloadBodyLimit(deps, CHECKINS_SYNC_BODY_LIMIT_BYTES, 'route'),
  zValidator('json', SyncBody, payloadSizeValidationHook(deps)),
  handler,
);
```

- [ ] **Step 4: Verify check-in GREEN**

Run `npx vitest run src/api/routes/checkins.test.ts`; expected PASS.

- [ ] **Step 5: Write failing enrich and match tests**

For `/enrich/candidates`, test an above-256-KiB body and 513-character brewery. For
`/enrich/result`, test an above-512-KiB body, oversized HTML, and 2,049-character
`pageUrl`. For `/match`, test an above-256-KiB anonymous request and a 513-character
name with authenticated wiring. Assert 413 JSON and correct route/schema warning
metadata. Keep existing empty-array and malformed-input 400 expectations.

- [ ] **Step 6: Verify enrich/match RED**

Run `npx vitest run src/api/routes/enrich.test.ts src/api/routes/match.test.ts`.

Expected: FAIL because route and string limits are absent.

- [ ] **Step 7: Implement enrich and match limits**

Apply `.max(BEER_TEXT_LIMIT_CHARS)` to affected brewery/name strings,
`.max(ENRICH_HTML_LIMIT_CHARS)` to result HTML, and
`.max(PAGE_URL_LIMIT_CHARS)` to `pageUrl`. Preserve array caps and the existing
`html or algolia is required` refinement.

Before each route's validator, add `payloadBodyLimit` with
`ENRICH_CANDIDATES_BODY_LIMIT_BYTES`, `ENRICH_RESULT_BODY_LIMIT_BYTES`, or
`MATCH_BODY_LIMIT_BYTES`. Pass `payloadSizeValidationHook(deps)` to all four affected
POST validators. Do not add route-specific limits to GET/admin routes.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
npx vitest run src/api/routes/checkins.test.ts src/api/routes/enrich.test.ts src/api/routes/match.test.ts src/api/index.test.ts
npm run typecheck
git diff --check
```

Expected: all exit 0. Commit:

```bash
git add src/api/routes/checkins.ts src/api/routes/checkins.test.ts src/api/routes/enrich.ts src/api/routes/enrich.test.ts src/api/routes/match.ts src/api/routes/match.test.ts
git commit -m "fix(api): bound extension request payloads"
```

### Task 4: Update the source-of-truth spec and verify

**Files:**
- Modify: `spec.md`

- [ ] **Step 1: Document the API contract**

In the HTTP API section, record the exact global/per-route byte limits, string
character limits, `413 {"error":"payload_too_large"}`, warning fields and credential
redaction, ordinary-validation 400 behavior, and one-week production review from the
approved design.

- [ ] **Step 2: Confirm extension changelog scope**

Run `git diff --name-only origin/main...HEAD`.

Expected: no path under `extension/`, so no extension changelog update is required.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: at least 109 test files and 1,109 tests pass; all other commands exit 0.

- [ ] **Step 4: Commit the spec**

```bash
git add spec.md
git commit -m "docs(api): specify request payload ceilings"
```

- [ ] **Step 5: Review branch scope**

Run:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

Expected: a clean worktree containing only design, plan, implementation, focused
tests, and spec changes. Then run code review and verification-before-completion,
address valid in-scope findings, and ask whether to create a pull request.
