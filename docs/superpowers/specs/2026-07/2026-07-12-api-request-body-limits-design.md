# API Request Body Limits Design

**Issue:** #281  
**Status:** Approved for implementation  
**Date:** 2026-07-12

## Problem

The API currently parses JSON bodies without a transport-level size ceiling. Several
extension-facing routes then pass attacker-controlled strings into synchronous HTML
parsing or normalization on Node's shared event loop:

- `POST /checkins/sync`
- `POST /enrich/result`
- `POST /enrich/candidates`
- `POST /match`

Array lengths are already bounded where relevant, but individual strings are not.
An accidental or abusive multi-megabyte request can therefore consume memory and
stall all bot and API work during JSON, Cheerio, or normalization processing.

## Goals

- Reject oversized requests before JSON parsing whenever the transport size is known.
- Stop streamed requests once their accumulated bytes exceed the applicable limit.
- Bound parser and normalization inputs even when the total request remains below its
  transport limit.
- Return a stable 413 response that the extension can distinguish from ordinary
  validation errors.
- Emit enough structured logging to tune improper limits and identify repeated abuse.
- Keep the change local to the existing Hono API architecture and add no dependency.

## Non-goals

- Rate limiting or request throttling.
- Persisting abuse events in SQLite.
- Blocking or suspending users automatically.
- Changing extension retry behavior in this issue.
- Making limits configurable through environment variables.

## Chosen Approach

Use layered fixed constants:

1. A global Hono `bodyLimit` ceiling protects every current and future request body.
2. Tighter Hono `bodyLimit` middleware protects the four extension-facing POST routes.
3. Zod `.max()` constraints bound individual strings before synchronous domain parsing
   or normalization.

This gives defense in depth without adding a new architectural layer. A global-only
limit would still permit expensive near-limit parsing, while route-only limits could be
forgotten on a future endpoint.

## Limits

All transport limits are byte counts. Zod string limits are JavaScript character
counts and are deliberately lower than the enclosing byte ceiling so JSON overhead
does not weaken transport enforcement.

| Scope | Limit |
|---|---:|
| Global request body | 4 MiB |
| `POST /checkins/sync` body | 1 MiB |
| `POST /enrich/result` body | 512 KiB |
| `POST /match` body | 256 KiB |
| `POST /enrich/candidates` body | 256 KiB |
| Check-in `html` | 768 Ki characters |
| Enrich-result `html` | 384 Ki characters |
| `brewery` and `name` | 512 characters each |
| `pageUrl` | 2,048 characters |

Existing array caps remain unchanged at 200 items. The Algolia object remains
structurally validated as it is today; the 512 KiB route ceiling bounds its total
serialized input.

Constants will live with the API limit middleware rather than in environment config.
Names will include units so byte and character limits cannot be confused.

## Request Flow and Error Semantics

The global limiter runs before route dispatch. Route-specific limiters run in each
route's middleware chain before `zValidator`, so requests with a usable
`Content-Length` are rejected without reading or parsing JSON. Hono's built-in
middleware also counts chunks when `Content-Length` is absent or cannot be trusted and
stops reading after the ceiling is crossed.

Every size-related rejection returns:

```json
{ "error": "payload_too_large" }
```

with HTTP status 413.

This includes Zod `too_big` violations for the bounded string fields. Other schema
errors retain the existing 400 behavior. No parser, matcher, normalization function,
or database mutation runs after a size rejection.

## Structured Logging and Attribution

Each 413 emits one warning-level event named `api payload too large`. The event
contains:

- `method`
- `path`
- `rejectionLayer`: `global`, `route`, or `schema`
- `limit`
- `limitUnit`: `bytes` or `characters`
- `contentLength`: parsed declared length when valid, otherwise `null`
- `auth`: `anonymous`, `authenticated`, or `invalid`
- `telegramId`: present only when a bearer token resolves to a user
- schema field path when the rejection came from Zod

The raw request body, rejected field value, Authorization header, and token/hash are
never logged.

For global rejections, the logger resolves a bearer token only inside the rejection
callback using the existing SHA-256 token lookup. Normal requests receive no extra
database lookup. Missing Authorization is `anonymous`; malformed or unknown
credentials are `invalid`; a valid token is `authenticated` and includes its
`telegramId`. Route and schema rejection logging uses the `telegramId` already placed
on the Hono context when available, while preserving the same three-state auth model.

Identity lookup is observability only: it must not change the 413 response into a 401
or expose whether a supplied token is valid to the caller.

## Components

- `src/api/middleware/body-limit.ts` will own fixed byte constants, construct the Hono
  limiter with the common JSON response, and emit rejection logs.
- A small request-identity helper will use the existing token hash lookup for logging.
  Existing authentication semantics remain unchanged.
- Route schemas will use shared character constants and a validator hook that maps
  size violations to the same logged 413 response while leaving other failures alone.
- `src/api/index.ts` and the affected route registrations will apply the appropriate
  global and route middleware.

Helpers remain API-local. No domain or storage interface changes are required.

## Testing

Focused tests will verify:

- a request above 4 MiB is rejected globally with the stable 413 JSON response;
- each affected route rejects a body above its tighter ceiling;
- a request without `Content-Length` is stopped when streamed bytes cross the limit,
  where Hono's test request interface permits a reliable reproduction;
- an oversized string below the transport ceiling receives 413 before parser/domain
  work or database mutation;
- ordinary schema failures still receive 400;
- anonymous, authenticated, and invalid-auth rejections produce the expected warning
  metadata, including `telegramId` only for authenticated requests;
- log records contain no body, field value, raw token, or token hash;
- existing valid requests continue to pass.

Verification will include targeted API tests, the complete root test suite, typecheck,
and build.

## Documentation and Extension Impact

`spec.md` will document the new API limits and 413 contract. The extension continues
to receive a normal HTTP error response and no extension source file changes are
required, so the extension changelog is outside this change.

## One-week Operational Follow-up

One week after this change reaches production, review the accumulated
`api payload too large` warning events and reassess the fixed limits. The review will
measure:

- rejection counts by route and rejection layer;
- declared content-length distribution where available;
- authenticated, anonymous, and invalid-auth rejection counts;
- repeated authenticated rejections grouped by `telegramId` to identify abuse or a
  consistently oversized legitimate client flow;
- whether any legitimate check-in, enrichment, or matching request was rejected.

If legitimate requests approach or exceed a limit, adjust only the affected route or
field using the observed payload sizes and retain reasonable safety headroom. If the
limits produce no false positives, record that they were reviewed and keep them
unchanged. Repeated abusive traffic should be carried into the separate rate-limiting
follow-up rather than broadening this issue.
