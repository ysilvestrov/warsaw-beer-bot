# Design: automate Chrome Web Store uploads (#266)

**Date:** 2026-07-31
**Issue:** #266 — "CWS: automate store uploads via chrome-webstore-upload-cli"
**Status:** approved (brainstorming)

## Problem

Releasing the extension to the Chrome Web Store is still a manual drag-and-drop in the
CWS dashboard. `docs/cws-listing.md` ends with "Upload the store package
(`cd extension && npm run package:store`) and submit for review", and `spec.md` §6.4
says outright: "аплоад у CWS dashboard (автоматизація відкладена, #266)".

Current state (verified 2026-07-31):

- `extension/` builds a store variant via `npm run package:store`
  (`CWS_BUILD=1 vite build` → drops the `key` and the broad `https://*/*` optional host
  permission) and zips it with `scripts/zip-dist.py`.
- The store item is **live**: 0.12.0 is published under item id
  `fdelmnhijeiojadcaihfdpecfcldbndg`.
- 0.13.0 is built but not uploaded to the store.
- The off-store bot channel is a separate command (`npm run release` →
  `scripts/publish-extension-release.ts`: DB row in `extension_releases` + staged zip).
- No Chrome Web Store API credentials exist yet.

One defect in the current packaging surfaces here and is fixed as part of this work:

- `package` and `package:store` write the **same** file,
  `extension/warsaw-beer-overlay-<version>.zip`, although they are different builds. A
  store build silently overwrites the dev zip whose sha256 is already recorded in
  `extension_releases`.

## Goals

- One local command, `npm run release:store`, that builds the store package, uploads it
  to the live item and submits it for review.
- Failures are loud and specific — in particular the CWS API's habit of reporting
  failure inside an HTTP 200 body.
- A repeatable, credential-only-in-`.env` setup, documented well enough to redo after a
  token revocation.

## Non-goals

- No GitHub Actions / tag-triggered workflow (local-only, per the release flow which
  already needs this host's `sudo` for the bot channel).
- No listing/screenshot updates through the API.
- No change to the off-store bot channel, and no retirement of it (#267).
- Not the 0.13.0 broadcast itself.

## Prerequisite: credentials (must precede any integration code)

Project policy (`feedback_validate_external_apis_first`): prove the external API works
with a live authenticated call **before** writing integration code. For #266 that means
credentials come first, and the read-only probe is the gate.

One-time browser steps (maintainer only):

1. Google Cloud project → enable **Chrome Web Store API**.
2. OAuth consent screen → **External**, and moved to **In production**. This is
   load-bearing, not cosmetic: while the app stays in *Testing*, Google issues refresh
   tokens that expire after **7 days**, so the automation would silently break between
   releases with `invalid_grant`.
3. OAuth client of type **Desktop app** → `client_id` + `client_secret`. Desktop clients
   accept a loopback redirect on any port, so no redirect URL has to be registered
   (Google disabled the old OOB flow).

One-time bootstrap script, `scripts/cws-auth-bootstrap.ts`:

- Starts a listener on `127.0.0.1:<port>`.
- Writes the authorisation URL (scope `https://www.googleapis.com/auth/chromewebstore`)
  to `./tmp/cws-auth-url.txt` — per the CLAUDE.md `./tmp/` policy, so nothing has to be
  copied out of the terminal.
- Catches the `code` on the loopback redirect; if the browser is not on this host, the
  operator pastes the `code=` value from the address bar instead.
- Exchanges the code for a refresh token and writes ready-to-paste env lines to
  `./tmp/cws-env.txt`.

Secrets live in the repo-root `.env` (same place as `DATABASE_PATH`, `WEBSHARE_PROXY`):
`CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_ITEM_ID` (defaulting to
`fdelmnhijeiojadcaihfdpecfcldbndg`). Never committed; `./tmp/` is wiped when the task
ends.

**Gate:** a live `GET /chromewebstore/v1.1/items/{itemId}?projection=DRAFT`. It proves
credentials, API enablement and account access to this specific item in one call and
mutates nothing. Release code is written only after that probe returns green.

## Approach

A hand-written client on `undici` rather than `chrome-webstore-upload-cli` or the
`chrome-webstore-upload` library. The API is three endpoints that have been stable for
years; the project already writes thin clients this way (Algolia, Brave); and the whole
risk of the feature lives in interpreting CWS responses, which we want to own and test
directly. It also keeps the release path free of new dependencies (cf. #103, dev-dep CVE
hygiene).

## Components

### `scripts/cws-client.ts`

Four pure functions with an injected `fetch`; no `process.env`, no filesystem, so all of
it is testable without network:

- `getAccessToken(creds)` — `POST https://oauth2.googleapis.com/token`, grant type
  `refresh_token`.
- `getItem(itemId, token)` — `GET .../chromewebstore/v1.1/items/{id}?projection=DRAFT`.
- `uploadPackage(itemId, zip, token)` — `PUT .../upload/chromewebstore/v1.1/items/{id}`,
  body = zip bytes.
- `publishItem(itemId, token)` —
  `POST .../chromewebstore/v1.1/items/{id}/publish?publishTarget=default`.

All requests carry `Authorization: Bearer <token>` and `x-goog-api-version: 2`.

### `scripts/publish-store-release.ts`

The orchestrator, modelled on `scripts/publish-extension-release.ts`: reads the version
from `extension/package.json`, locates the store zip, reads the `CWS_*` env, runs the
preflight, then upload → publish, and prints a summary. Supports `--dry-run`.

### `extension`/root npm scripts

`release:store` at the repo root:
`ZIP_DIST_OUT=<…-store.zip> npm --prefix extension run package:store && tsx scripts/publish-store-release.ts`.

The distinct output name (`extension/warsaw-beer-overlay-<version>-store.zip`) fixes the
dev/store zip collision described above; `.gitignore` already covers it via
`extension/*.zip`.

## Error handling

- **Success is not HTTP 200.** Upload returns 200 with
  `{uploadState: "FAILURE", itemError: [{error_code, error_detail}]}`; publish returns
  200 with `{status: ["ITEM_NOT_UPDATABLE" | "NOT_AUTHORIZED" | …]}`. The client treats
  an operation as successful only on `uploadState === "SUCCESS"` / `status` containing
  `OK`, and surfaces `error_detail` verbatim. A naive wrapper reports success here.
- **Publish only after a successful upload.** A failed upload exits non-zero and
  `publishItem` is never called.
- **Preflight catches the most common mistake early.** `getItem` returns the draft's
  `crxVersion`; if it equals the local version, the run aborts before the upload with
  "version X is already uploaded — bump `extension/package.json`", instead of a cryptic
  `PKG_INVALID_VERSION_NUMBER` a minute later.
- **`invalid_grant` on refresh** maps to a message naming both causes: revoked access, or
  a consent screen left in *Testing* (the 7-day trap), pointing at
  `cws-auth-bootstrap.ts`.
- **`--dry-run`** refreshes the token and calls `getItem` only. It is both the initial
  validation probe and the standing "are the credentials still alive?" check.
- **No retries.** Uploading is a deliberate one-off action by the releaser; a silent
  retry is worse than a visible error.

## Testing

`scripts/cws-client.test.ts` (injected `fetch`, no network):

- `uploadState: FAILURE` + `itemError` → throws, message contains `error_detail`.
- `uploadState: SUCCESS` → resolves.
- publish `status: ["ITEM_NOT_UPDATABLE"]` → throws; `["OK"]` → resolves.
- token refresh returning `invalid_grant` → the mapped, actionable message.
- request shape: `PUT` for upload, `Authorization: Bearer`, `x-goog-api-version: 2`,
  body is the zip bytes.

`scripts/publish-store-release.test.ts` (injected client + fs/env deps):

- preflight version collision aborts **before** upload.
- missing `CWS_*` env var → explicit error naming the variable.
- missing `…-store.zip` → explicit error.
- `--dry-run` calls neither `uploadPackage` nor `publishItem`.

## Documentation (same PR)

- `spec.md` §6.4 — replace "аплоад у CWS dashboard (автоматизація відкладена, #266)"
  with the automated flow, and refresh the stale "item подано на рев'ю 2026-07-10; версія
  0.11.0" line (0.12.0 is live); §5.6 (secrets) gains the four `CWS_*` variables.
- `docs/cws-listing.md` — the last operational-checklist item becomes
  `npm run release:store`, with the dashboard upload kept as a fallback.
- `docs/extension-release.md` — a store-channel section: one-time OAuth setup,
  `--dry-run`, normal release.
- `docs/extension-install-uk.md` — **not** touched. The CLAUDE.md rule covers
  user-facing extension changes; this is a releaser-only tool, and no permission, badge
  or UI behaviour changes.

## Open risks

- The GCP/OAuth setup is browser-only and cannot be done or verified from the shell; the
  whole feature is blocked until it is finished and the probe is green.
- Publishing puts the item into the review queue. This design does not add a "wait for
  review outcome" step; the store notifies by email as it does today.
