# #809 Fest Venue Slug Redirect vs Cookie Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify Untappd 3xx redirects to `/login` as `CookieExpiredError` while safely following non-login redirects (up to 3 hops) and dynamically updating `fest_venues.feed_path` in SQLite.

**Architecture:** Extend `FetchResponseLike` with header inspection. In `createHttp`, inspect `Location` when `redirect: 'manual'`: throw `CookieExpiredError` only for `/login` targets; for safe targets, follow redirects transparently (up to 3 hops) and fire `onRedirect`. In `fest-poll.ts`, handle venue redirects by updating `fest_venues.feed_path` via `updateFestVenueFeedPath`. Update the schema seed for `wfp22` and add migration `v46`.

**Tech Stack:** TypeScript, Node.js (Node 24), Undici, SQLite (better-sqlite3), Vitest.

**Spec:** [docs/superpowers/specs/2026-10/2026-10-08-809-fest-location-redirect-cookie-classification-design.md](file:///home/ysi/warsaw-agy-bb/docs/superpowers/specs/2026-10/2026-10-08-809-fest-location-redirect-cookie-classification-design.md)

## Global Constraints

- Never throw `CookieExpiredError` unless `Location` pathname starts with `/login`.
- Preserve request headers (`User-Agent`, `Cookie`) and proxy `dispatcher` across followed redirect hops.
- Limit manual redirect hops to 3 to prevent infinite loops.
- Do not mutate `feed_path` unless the redirected target URL retains the same `venue_id`.
- Single test pins migration head array length (45 -> 46).
- Idempotent migration v46.

## Review Focus

1. **Relative `Location` headers** (`/login?go_to=...` or `/v/...`): must resolve against current URL without crashing or misclassifying.
2. **Absolute `Location` headers** (`https://untappd.com/login?...`): pathname correctly extracted and tested against `/login`.
3. **Missing `Location` header on 3xx**: throws `HttpError` rather than crashing or throwing `CookieExpiredError`.
4. **Redirect loop exceeding 3 hops**: aborts with `HttpError` after hop 3.
5. **Persistence of updated slug**: `fest_venues.feed_path` written to SQLite so subsequent calls use 1 HTTP request and `GET /fest/config` returns canonical slug.

---

### Task 1: 3xx Classification, Safe Redirect Following, and `onRedirect` in `createHttp`

**Files:**
- Modify: `src/sources/fetch-like.ts:14-20`
- Modify: `src/sources/http.ts:22-113`
- Test: `src/sources/http.test.ts`

**Interfaces:**
- Consumes: `FetchResponseLike.headers?.get(name: string): string | null`
- Produces: `HttpGetOpts { onRedirect?: (fromUrl: string, toUrl: string) => void }`, `Http.get(url: string, opts?: HttpGetOpts): Promise<string>`

- [ ] **Step 1: Write unit tests in `src/sources/http.test.ts`**
  - Verify 307 with `Location: https://untappd.com/login?go_to=...` throws `CookieExpiredError`.
  - Verify 307 with relative `Location: /login` throws `CookieExpiredError`.
  - Verify 307 with `Location: https://untappd.com/v/new-slug/11142155/activity` follows redirect to 200 and returns body.
  - Verify `onRedirect` callback receives `(fromUrl, toUrl)` when redirect is followed.
  - Verify redirect chain > 3 hops throws `HttpError(307, url)`.
  - Verify 307 without `Location` header throws `HttpError(307, url)` (not `CookieExpiredError`).

- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test -- src/sources/http.test.ts`
  Expected: FAIL on new redirect behavior tests.

- [ ] **Step 3: Implement header inspection and redirect following in `fetch-like.ts` and `http.ts`**
  - In `src/sources/fetch-like.ts`, add `readonly headers?: { get(name: string): string | null }` to `FetchResponseLike`.
  - In `src/sources/http.ts`, export `HttpGetOpts` with `onRedirect`. Update `Http.get(url: string, opts?: HttpGetOpts): Promise<string>`.
  - When `opts.redirect === 'manual'` and `res.status >= 300 && res.status < 400`:
    - Read `location = res.headers?.get('location')`.
    - If no `location`: throw `new HttpError(res.status, url)`.
    - Resolve `target = new URL(location, url)`.
    - If `target.pathname === '/login' || target.pathname.startsWith('/login/')`: throw `new CookieExpiredError()`.
    - Otherwise follow up to `MAX_REDIRECTS = 3` hops: invoke `opts.onRedirect?.(currentUrl, target.href)`, `getOpts?.onRedirect?.(currentUrl, target.href)`, and fetch `target.href` with original headers and dispatcher. If hops exceed 3, throw `new HttpError(res.status, currentUrl)`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test -- src/sources/http.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit changes**
  ```bash
  git add src/sources/fetch-like.ts src/sources/http.ts src/sources/http.test.ts
  git commit -m "fix(sources): follow safe 3xx redirects and throw CookieExpiredError only on /login (#809)"
  ```

---

### Task 2: Update `fest_venues.feed_path` on Redirect in `fest-poll`

**Files:**
- Modify: `src/storage/fests.ts`
- Modify: `src/jobs/fest-poll.ts`
- Test: `src/storage/fests.test.ts`
- Test: `src/jobs/fest-poll.test.ts`

**Interfaces:**
- Produces: `updateFestVenueFeedPath(db: DB, venueId: number, feedPath: string): number`
- Consumes: `updateFestVenueFeedPath`, `Http.get(url, { onRedirect })`

- [ ] **Step 1: Write tests in `src/storage/fests.test.ts` and `src/jobs/fest-poll.test.ts`**
  - In `fests.test.ts`: test `updateFestVenueFeedPath(db, venueId, newFeedPath)` updates the row and returns `changes = 1`.
  - In `fest-poll.test.ts`: test `runFestPoll` invokes `updateFestVenueFeedPath` when `http.get` encounters a 307 redirect to a new slug for `venue_id`.
  - In `fest-poll.test.ts`: test `refreshFestMenu` invokes `updateFestVenueFeedPath` when `http.get` encounters a 307 redirect to a new slug for `menu_venue_id`.
  - In `fest-poll.test.ts`: verify subsequent poll reads the updated `venue.feed_path`.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npm test -- src/jobs/fest-poll.test.ts src/storage/fests.test.ts`
  Expected: FAIL on new tests.

- [ ] **Step 3: Implement `updateFestVenueFeedPath` and redirect wiring in `fests.ts` and `fest-poll.ts`**
  - In `src/storage/fests.ts`, implement `updateFestVenueFeedPath(db: DB, venueId: number, feedPath: string): number`.
  - In `src/jobs/fest-poll.ts`:
    - In `guardedGet`, accept optional `onRedirect` callback and forward it to `deps.http.get(url, { onRedirect })`.
    - In `runFestPoll`: provide `onRedirect` to update `fest_venues.feed_path` when destination URL matches `/${venue.venue_id}/` (preserving trailing `/activity`).
    - In `refreshFestMenu`: provide `onRedirect` to update `fest_venues.feed_path` with canonical `${basePath}/activity` when destination matches `/${fest.menu_venue_id}/`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npm test -- src/jobs/fest-poll.test.ts src/storage/fests.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit changes**
  ```bash
  git add src/storage/fests.ts src/jobs/fest-poll.ts src/storage/fests.test.ts src/jobs/fest-poll.test.ts
  git commit -m "fix(fest): persist canonical venue feed_path on redirect (#809)"
  ```

---

### Task 3: Schema Seed Update, Migration v46, and `spec.md`

**Files:**
- Modify: `src/storage/schema.ts`
- Modify: `src/storage/schema.test.ts`
- Modify: `spec.md`

**Interfaces:**
- Produces: Migration version 46 in `schema_version`.
- Updates: `fest_venues` seed for `wfp22` (`11142155`).

- [ ] **Step 1: Write migration tests in `src/storage/schema.test.ts`**
  - Update `records every migration 1..45 on a fresh db, with no gaps` to `1..46`.
  - Add test `migration v46 updates fest_venues feed_path for venue 11142155`:
    - Asserts `SELECT version FROM schema_version WHERE version = 46` equals `{ version: 46 }`.
    - Asserts `SELECT feed_path FROM fest_venues WHERE venue_id = 11142155` equals `/v/warszawski-festiwal-piwa/11142155/activity`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npm test -- src/storage/schema.test.ts`
  Expected: FAIL on migration 46 test.

- [ ] **Step 3: Implement schema seed update and migration v46 in `src/storage/schema.ts` and update `spec.md`**
  - In `src/storage/schema.ts`, update `fest_venues` seed for venue 11142155 to `/v/warszawski-festiwal-piwa/11142155/activity`.
  - Add migration `v46` updating `fest_venues` for venue 11142155.
  - In `spec.md`, add row 46 to the migrations table and document the 3xx redirect behavior under §4.4.

- [ ] **Step 4: Run test to verify pass**
  Run: `npm test -- src/storage/schema.test.ts`
  Expected: PASS

- [ ] **Step 5: Run full test gate**
  Run: `npm test && npm run typecheck`
  Expected: PASS (all test suites and typecheck green).

- [ ] **Step 6: Commit changes**
  ```bash
  git add src/storage/schema.ts src/storage/schema.test.ts spec.md
  git commit -m "feat(schema): add migration v46 for canonical wfp22 venue slug and update spec (#809)"
  ```
