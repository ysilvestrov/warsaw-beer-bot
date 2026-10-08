# #809 — Fest Venue Slug Redirect vs Expired Cookie Classification: Design

**Date:** 2026-10-08  
**Status:** proposed  
**Issue:** #809  

---

## 1. Problem & Symptom

On 2026-10-08 at 16:55 UTC, Untappd changed the canonical slug of the Warszawski Festiwal Piwa (WFP22) venue (`venue_id` = `11142155`):
- **Old path:** `/v/warsaw-beer-festival-warszawski-festiwal-piwa/11142155/activity`
- **New canonical path:** `/v/warszawski-festiwal-piwa/11142155/activity`

Untappd responds to the old path with `307 Temporary Redirect` pointing to the new canonical URL via `Location: https://untappd.com/v/warszawski-festiwal-piwa/11142155/activity`.

Because the cookie-authenticated Untappd HTTP client was created with `redirect: 'manual'` ([src/index.ts](file:///home/ysi/warsaw-agy-bb/src/index.ts#L149)), [`src/sources/http.ts:66-67`](file:///home/ysi/warsaw-agy-bb/src/sources/http.ts#L66-L67) unconditionally classified **any** 3xx response as `CookieExpiredError`:
```ts
if (res.status >= 300 && res.status < 400) {
  if (opts.redirect === 'manual') throw new CookieExpiredError();
  throw new HttpError(res.status, url);
}
```

### Consequences
1. **False admin alerts:** Every 6 hours, the admin was alerted: `Фест: Untappd-кука протухла — серверне око сліпе, онови куку`. Replacing the cookie (`deploy/refresh-cookie.sh`) had zero effect because the cookie was valid.
2. **Blind server eye:** The festival server feed poller (`runFestPoll`) and venue menu poller (`runFestMenu` / `refreshFestMenu`) halted updates for ~7 hours until an operational database update manually rewrote the row in production.
3. **Fresh DB vulnerability:** The seed in [`src/storage/schema.ts`](file:///home/ysi/warsaw-agy-bb/src/storage/schema.ts#L335) retains the obsolete slug, so newly initialized databases or test fixtures replicate the outage.
4. **Festival risk:** WFP22 runs 2026-10-15 to 2026-10-17. If Untappd normalizes or alters slugs again during the festival, the server eye would blind itself again with false alarms.

---

## 2. Mechanism & Live Probe Evidence

A live probe conducted against Untappd with production proxy and cookies established the exact behavioral contract:

1. **Unauthenticated / expired session on a protected endpoint** (`/user/ysilvestrov/beers`):
   - Response: `307 Temporary Redirect`
   - `Location: https://untappd.com/login?go_to=https%3A%2F%2Funtappd.com%2Fuser%2Fysilvestrov%2Fbeers`
   - Target URL pathname is `/login`.
2. **Venue slug change** (`/v/warsaw-beer-festival-warszawski-festiwal-piwa/11142155/activity`):
   - Response: `307 Temporary Redirect`
   - `Location: https://untappd.com/v/warszawski-festiwal-piwa/11142155/activity`
   - Target URL pathname is `/v/warszawski-festiwal-piwa/11142155/activity` (not `/login`).
3. **Public venue page accessibility**:
   - GET `/v/warszawski-festiwal-piwa/11142155/activity` without cookies returns `200 OK` (25 check-ins). Venue pages are public and do not require user authentication.

---

## 3. Claims and Their Evidence

| Claim | What records it as fact | Evidence proving it |
| :--- | :--- | :--- |
| Untappd session expiry redirects to `/login` | `http.ts` `CookieExpiredError` contract | Live probe: GET `/user/ysilvestrov/beers` without auth returns `307` with `Location: https://untappd.com/login?go_to=...`. |
| Untappd venue slug changes redirect to canonical `/v/<slug>/<venue_id>` | `http.ts` safe redirect contract | Live probe: GET `/v/warsaw-beer-festival.../11142155/activity` returns `307` with `Location: https://untappd.com/v/warszawski-festiwal-piwa/11142155/activity`. |
| Untappd venue activity feeds and menus do not require session auth | Fest feed polling design | Live probe: GET `/v/warszawski-festiwal-piwa/11142155/activity` without cookie returns `200` with 25 check-ins. |
| Production DB row 11142155 was fixed manually, but code repository still carries stale seed | `src/storage/schema.ts` line 335 | Code inspection: line 335 seeds `/v/warsaw-beer-festival-warszawski-festiwal-piwa/11142155/activity`; prod query confirms row was patched via `sqlite3`. |
| Safe redirects preserve proxy dispatcher and request headers | `createHttp` undici fetch wrapper | Undici dispatcher passed per request in `doFetch`; headers and cookies remain attached when following hops. |

---

## 4. Architectural Decisions

### 4.1 Redirect Classification and Safe Following in `createHttp`

In [`src/sources/http.ts`](file:///home/ysi/warsaw-agy-bb/src/sources/http.ts):

1. **Header extraction:** Extend `FetchResponseLike` in [`src/sources/fetch-like.ts`](file:///home/ysi/warsaw-agy-bb/src/sources/fetch-like.ts) with `readonly headers?: { get(name: string): string | null }`. Both `undici.fetch` and global `fetch` satisfy this.
2. **Inspection under `redirect: 'manual'`:**
   When `res.status >= 300 && res.status < 400`:
   - Read `location = res.headers?.get('location')`.
   - If `!location`, throw `HttpError(res.status, url)`.
   - Resolve target URL: `target = new URL(location, currentUrl)`.
   - **Login detection:** If `target.pathname === '/login' || target.pathname.startsWith('/login/')`:
     Throw `new CookieExpiredError()`.
   - **Safe redirect:** If target does **not** lead to login:
     Follow redirect transparently (up to `MAX_REDIRECTS = 3` hops).
     Preserve request headers (`User-Agent`, `Cookie`), proxy `dispatcher`, and queue serialization.
     Invoke optional redirect callback `onRedirect?.(currentUrl, target.href)` so consumers can update persistent state.
     If redirect hops exceed 3, throw `HttpError(res.status, currentUrl)` to prevent redirect loops.
3. **Block handling during redirects:**
   If a redirect hop encounters Cloudflare blocks (status 403/429 or challenge page), the existing `outcome.kind === 'block'` rotation and retry loop operates normally on the current hop URL.

```ts
export interface HttpGetOpts {
  onRedirect?: (fromUrl: string, toUrl: string) => void;
}

export interface Http {
  get(url: string, opts?: HttpGetOpts): Promise<string>;
  rotations?(): number;
}
```

### 4.2 Dynamic Feed Path Update in `fest_venues`

When `runFestPoll` or `refreshFestMenu` follows a redirect:

1. Add `updateFestVenueFeedPath(db: DB, venueId: number, feedPath: string): number` in [`src/storage/fests.ts`](file:///home/ysi/warsaw-agy-bb/src/storage/fests.ts).
2. In [`src/jobs/fest-poll.ts`](file:///home/ysi/warsaw-agy-bb/src/jobs/fest-poll.ts):
   - In `runFestPoll`: pass `onRedirect` to `guardedGet`. If target URL belongs to the same `venue.venue_id` (e.g. pathname matches `^/v/[^/]+/11142155(/activity)?$`), update `fest_venues.feed_path` to the canonical `/v/<new-slug>/${venue.venue_id}/activity`.
   - In `refreshFestMenu`: similarly pass `onRedirect`. If target URL matches the menu venue, update `fest_venues.feed_path` with the canonical activity path.
3. **Effect:**
   - Subsequent polls query the canonical URL directly (1 HTTP request instead of 2).
   - `GET /fest/config` reads `festVenues(db, fest.id)` and immediately provides the updated slug to laptop eyes (`scripts/fest-eye`) without hardcoding or manual restarts.

### 4.3 Schema Seed Update & Migration v46

1. In [`src/storage/schema.ts`](file:///home/ysi/warsaw-agy-bb/src/storage/schema.ts):
   Update the initial seed row for `wfp22` venue `11142155`:
   ```sql
   INSERT OR IGNORE INTO fest_venues (fest_id, venue_id, label, feed_path)
     SELECT id, 11142155, 'Warszawski Festiwal Piwa',
            '/v/warszawski-festiwal-piwa/11142155/activity' FROM fests WHERE slug = 'wfp22'
   ```
2. Add migration `v46`:
   ```sql
   UPDATE fest_venues
      SET feed_path = '/v/warszawski-festiwal-piwa/11142155/activity'
    WHERE venue_id = 11142155;
   ```
   Idempotent and safe for databases where row was already manually updated.
3. Update `spec.md` migration table with v46 and document the redirect classification rules in §4.4.

---

## 5. Verification Plan

1. **Unit tests in `src/sources/http.test.ts`:**
   - Verify 3xx redirect to `https://untappd.com/login?go_to=...` throws `CookieExpiredError`.
   - Verify 3xx redirect to `/login` throws `CookieExpiredError`.
   - Verify 3xx redirect to `/v/new-slug/11142155/activity` is followed and returns 200 body.
   - Verify `onRedirect` callback is fired with original and new URLs.
   - Verify redirects exceeding 3 hops throw `HttpError`.
   - Verify 3xx without `Location` throws `HttpError` (not `CookieExpiredError`).
2. **Integration tests in `src/jobs/fest-poll.test.ts`:**
   - Verify `runFestPoll` updates `fest_venues.feed_path` when a 307 redirect is encountered.
   - Verify subsequent poll uses updated `feed_path`.
   - Verify `refreshFestMenu` updates `fest_venues.feed_path` when a 307 redirect is encountered.
   - Verify `CookieExpiredError` is still handled correctly with throttled admin alert.
3. **Migration & schema tests in `src/storage/schema.test.ts`:**
   - Verify migration v46 updates `fest_venues.feed_path` for venue `11142155`.
   - Verify fresh database migration applies 1..46 with no gaps.
4. **Full test gate:**
   - `npm test && npm run typecheck`.
5. **Cross-review:**
   - `npm run cross-review -- --reviewer claude`.
