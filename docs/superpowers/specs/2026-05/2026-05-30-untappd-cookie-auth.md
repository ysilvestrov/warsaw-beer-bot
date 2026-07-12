# Untappd Cookie Auth — Design Spec

> **Status:** Approved for implementation (2026-05-30)

## Context

Untappd changed `/user/<username>/beers` to require authentication on 2026-05-29.
Unauthenticated requests receive `307 → /login?go_to=...`, followed by Cloudflare
bot challenge (403) on the login page. Automated login via form POST is blocked by
Cloudflare; a headless browser solution is disproportionate for a manually-rotated
credential.

**Empirical verification (2026-05-30):** `untappd_user_v3_e` cookie alone returns
200 for `/user/ysilvestrov/beers`. No other Untappd or Cloudflare cookie needed.

## Goal

Resume the `refreshAllUntappd` scraper by sending `Cookie: untappd_user_v3_e=<value>`
with each request. Support manual cookie rotation via a shell script. Notify the
operator (log + Telegram DM) when the cookie expires.

---

## Architecture

### Separate HTTP client for Untappd profile scraping

`createHttp` gains two new optional fields in `HttpOpts`:
- `cookie?: string` — if set, appended as `Cookie: untappd_user_v3_e=<value>`
  to every request made by that instance
- `redirect?: RequestRedirect` — passed to `fetch`; `'manual'` prevents following
  3xx redirects

A second `untappdHttp` instance is created in `index.ts` with
`cookie: env.UNTAPPD_SESSION_COOKIE, redirect: 'manual'`. The shared `http`
instance (ontap.pl, OSRM, Nominatim, Untappd Search) is **not touched**.

`enrich-orphans` and `refresh-tap-ratings` hit the Untappd public Search API
(`/search?q=...`), which does not require auth — they keep using `http`.

### CookieExpiredError

`http.ts` exports `class CookieExpiredError extends Error {}`. When a response
with `redirect: 'manual'` has status 3xx **and** `location` header contains
`/login`, the HTTP client throws `CookieExpiredError` instead of the generic
`HTTP <N> for <url>` error. This lets `refreshAllUntappd` distinguish expiry
from transient network failures.

### refreshAllUntappd — expiry handling

`Deps` gains `notifyAdmin?: (msg: string) => Promise<void>`.

When `CookieExpiredError` is caught:
1. `log.warn('untappd cookie expired')`
2. `notifyAdmin?.('⚠️ Untappd cookie expired. Run deploy/refresh-cookie.sh <new-value> to rotate.')`
3. Break out of the user loop immediately — all users will fail the same way.

Non-expiry errors (network, parse) continue to be caught per-user with `log.warn`
as before.

### index.ts wiring

If `UNTAPPD_SESSION_COOKIE` is not set:
- Log `warn: untappd profile scraper disabled (UNTAPPD_SESSION_COOKIE not set)`
  at startup
- `refreshAllUntappd` is **not registered** in cron and **not called** from
  `/refresh` — the job simply does not run

If set:
- `untappdHttp = createHttp({ userAgent: env.NOMINATIM_USER_AGENT, cookie: env.UNTAPPD_SESSION_COOKIE, redirect: 'manual' })`
- `notifyAdmin = env.ADMIN_TELEGRAM_ID ? (msg) => bot.telegram.sendMessage(env.ADMIN_TELEGRAM_ID!, msg) : undefined`
- Both `cron.schedule('0 3 * * *', ...)` and the `/refresh` command pass `untappdHttp` and `notifyAdmin` to `refreshAllUntappd`

### deploy/refresh-cookie.sh

One-step rotation script. Usage: `./deploy/refresh-cookie.sh <cookie-value>`.

Behaviour:
- If `UNTAPPD_SESSION_COOKIE=` line exists in `/etc/warsaw-beer-bot/.env` → replace it
- If it doesn't exist → append `UNTAPPD_SESSION_COOKIE=<value>` to the file
- Restart the service

Uses only operations already covered by existing sudoers NOPASSWD rules:
`sudo -u warsaw-beer-bot bash -lc "..."` (for `.env` edit as file owner)
and `sudo systemctl restart warsaw-beer-bot`.

---

## Environment Variables

### New in `.env` / `env.ts`

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `UNTAPPD_SESSION_COOKIE` | `string` | optional | Value of `untappd_user_v3_e` cookie from browser DevTools |
| `ADMIN_TELEGRAM_ID` | `string` | optional | Telegram user ID to DM on cookie expiry |

Both added to `.env.example` as commented-out lines with instructions.

### How to get the cookie value

1. Log into Untappd in a browser
2. Open DevTools → Application → Storage → Cookies → `https://untappd.com`
3. Find row `untappd_user_v3_e`
4. Copy the **Value** column
5. Paste into `.env` or run `deploy/refresh-cookie.sh <value>`

---

## Files Changed

| File | Change |
|------|--------|
| `src/sources/http.ts` | Export `CookieExpiredError`; add `cookie?` + `redirect?` to `HttpOpts`; send cookie header; throw `CookieExpiredError` on login redirect |
| `src/sources/http.test.ts` | Tests: (1) cookie header sent when `cookie` opt set; (2) `CookieExpiredError` thrown on 307 with location containing `/login`; (3) generic error thrown on non-login 3xx; (4) `fetch` called with `{ redirect: 'manual' }` when opt set |
| `src/jobs/refresh-untappd.ts` | Add `notifyAdmin?` dep; catch `CookieExpiredError` → notify + break |
| `src/jobs/refresh-untappd.test.ts` | Tests for CookieExpiredError handling and notifyAdmin call |
| `src/config/env.ts` | Add `UNTAPPD_SESSION_COOKIE` and `ADMIN_TELEGRAM_ID` (both optional) |
| `src/index.ts` | Create `untappdHttp`; build `notifyAdmin`; conditional registration of `refreshAllUntappd` |
| `deploy/refresh-cookie.sh` | New script: replace-or-append cookie in `.env` + restart service |
| `.env.example` | Add commented-out `UNTAPPD_SESSION_COOKIE` and `ADMIN_TELEGRAM_ID` lines |

**Not changed:** `scraper.ts`, `storage/*`, `bot/*`, `untappd-had.ts`

---

## Error Handling Summary

| Scenario | Behaviour |
|----------|-----------|
| `UNTAPPD_SESSION_COOKIE` not set | Startup warn log; job not registered; no cron, no `/refresh` call |
| `ADMIN_TELEGRAM_ID` not set | `notifyAdmin` is no-op; only log warn on expiry |
| Cookie valid | Request → 200, parse as before |
| Cookie expired (307→login) | `CookieExpiredError` → log warn + optional Telegram DM → break user loop |
| Network/parse error (non-expiry) | Per-user `log.warn`, loop continues — existing behaviour |

---

## Rotation Flow (operator)

1. Log into Untappd in browser, copy `untappd_user_v3_e` value from DevTools
2. Run: `./deploy/refresh-cookie.sh <value>`
3. Script updates `/etc/warsaw-beer-bot/.env` and restarts the service
4. Verify: `journalctl -u warsaw-beer-bot -n 20 --no-pager`

No need to edit `.env` manually. No sudo password required (existing NOPASSWD rules cover the operations).
