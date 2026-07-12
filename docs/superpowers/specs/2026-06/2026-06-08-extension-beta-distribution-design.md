# Extension beta distribution via the Telegram bot — design

**Date:** 2026-06-08
**Status:** Approved (brainstorming)
**Component:** `extension/` (build), `src/` (bot + storage), `docs/`

## Problem

The browser extension (`extension/`) currently ships as source only: a tester
clones the repo, runs `npm install && npm run build`, and loads `extension/dist/`
unpacked. Shipping a **new** version means each tester manually `git pull`s,
rebuilds, and reloads. There is no signal that a new version exists.

We want a low-friction way to push new versions to a small group of **technical
beta-testers** (4–5 now, up to ~10), without going to the Chrome Web Store.

## Constraints & decisions (from brainstorming)

- **Off-store, private.** No Chrome Web Store: avoids review latency, public
  visibility, and the extra Untappd-scraping load/exposure that a public launch
  would invite. Chromium does not auto-update off-store extensions for normal
  users, and that is acceptable for a technical audience.
- **Distribute a prebuilt zip** — testers never run Node.
- **The Telegram bot is the delivery channel.** Every tester already uses the
  bot (they minted their token via `/extension`). Telegram hosts the file; we
  re-send by `file_id`, so there is no separate file hosting.
- **The build is the single source of metadata.** At build time we write the
  version + release notes into **both** the zip (for the human) **and** the
  `extension_releases` table (for the bot), together with the zip's **sha256**.
  The bot never parses the zip — it has no unzip dependency.
- **The bot's only job on receiving the zip is to attach a `file_id`.** It
  hashes the received document and checks the hash equals the latest release
  row's `sha256`; on match it stores the Telegram `file_id` so it can re-send
  the file later. The file is uploaded to the bot **solely** to obtain that
  reusable `file_id`.
- **Version is bumped in one place** (`package.json`); the manifest derives it.
- **Extension self-version-check is out of scope** for v1 (possible Phase 2).

## Flow

**Release (admin):**
1. Bump `version` in `extension/package.json`; add the matching section to
   `extension/CHANGELOG.md`.
2. `npm run release` → builds → `warsaw-beer-overlay-<version>.zip` with
   `manifest.json` (version) and `RELEASE_NOTES.txt` (version + notes) at the zip
   root → computes the zip's **sha256** → **writes the `extension_releases` row**
   (version, notes, sha256; `file_id` still NULL) into the bot's DB.
3. Forward that zip to the bot as a document (no caption/args needed).
4. Bot hashes the received file; if it matches the latest release row's sha256,
   it stores the `file_id` and replies with an inline
   **📣 Розіслати / Скасувати** confirmation.
5. On confirm, the bot broadcasts the zip (by `file_id`) + the stored notes to
   every token holder.

**Tester (first install):** `/extension` → token **and** the current zip +
instructions → unzip into a stable folder → `chrome://extensions` →
Load unpacked (once).

**Tester (update):** bot DMs the new zip → unzip **over the same folder** →
click the **↻ reload** icon on the extension card. Token and settings survive.

## Components

### A. Extension build (`extension/`)

**Single source of truth for version.**
`extension/package.json` `version` is authoritative. `manifest.config.ts` imports
it instead of the hardcoded `'0.1.0'`:

```ts
import pkg from './package.json';
export default defineManifest({ /* … */ version: pkg.version });
```

The current duplicated `version: '0.1.0'` in `manifest.config.ts` is removed.

**Changelog.** `extension/CHANGELOG.md` in keep-a-changelog style; one section
per release headed `## [x.y.z] - YYYY-MM-DD`.

**Packaging + release.** `npm run package` builds the zip:
`vite build` → generate `dist/RELEASE_NOTES.txt` from the CHANGELOG section
matching `package.json`'s version → zip `dist/` into
`warsaw-beer-overlay-<version>.zip`. `RELEASE_NOTES.txt` content:

```
Warsaw Beer Overlay v0.2.0

<the body of the matching CHANGELOG section>
```

`npm run release` runs `package`, then computes `sha256(zip)` and **upserts the
`extension_releases` row** (version, notes, sha256) into the bot's DB. The DB
path comes from the same env the bot uses; since the release runs on the bot
host, it writes the live DB directly (SQLite WAL + the pinned `busy_timeout`
make a concurrent writer safe). The row's `file_id` stays NULL until the admin
uploads the file to the bot.

A new build step (`scripts/release-notes.ts`) **fails the build** if
`package.json`'s version has no matching CHANGELOG section — this catches
"forgot to write notes / forgot to bump". The changelog slicer is a pure
function and is unit-tested in isolation.

**Stable extension ID.** Add a `key` (base64 public key) to the manifest so the
unpacked extension ID is deterministic regardless of the install path. Without
it, re-loading unpacked from a different folder yields a new ID and silently
loses the stored token (`chrome.storage`). With it, settings survive even a full
remove/re-add. The keypair is generated once; the public key goes in
`manifest.config.ts`, the private key is kept by the maintainer (not committed —
documented in the deploy/release notes).

### B. Bot + storage (`src/`)

**Migration v9 — `extension_releases`:**

```sql
CREATE TABLE extension_releases (
  version      TEXT NOT NULL PRIMARY KEY,   -- semver, e.g. "0.2.0"
  sha256       TEXT NOT NULL,               -- hex digest of the zip (written by the build)
  notes        TEXT NOT NULL,               -- changelog body (written by the build)
  file_id      TEXT,                        -- Telegram file_id; NULL until the admin uploads
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attached_by  INTEGER                      -- admin telegram_id who attached file_id; NULL until then
);
```

The build (`npm run release`) inserts `version`, `sha256`, `notes`. The bot fills
`file_id` + `attached_by` when the admin uploads the matching file. "Latest" =
the row with the highest semver (compared in code, not lexically).

**Publish handler.** On a document message from `ADMIN_TELEGRAM_ID`:
1. Guard: sender is the admin and the document looks like our zip (filename /
   mime, size bound — same ≤20 MB Telegram limit already handled for `/import`).
2. Download via `getFile` + fetch into a buffer; compute `sha256`.
3. Look up the **latest** `extension_releases` row. If its `sha256` matches the
   uploaded file's hash, store the document's `file_id` + `attached_by` on that
   row. The bot never opens the zip.
4. Reply to the admin: "Прикріплено файл до v0.2.0. Отримають N тестерів." +
   inline keyboard **📣 Розіслати / Скасувати**.

Mismatch / no row → reject with the reason ("файл не відповідає останньому
релізу в таблиці — спершу `npm run release`"). A non-admin sending a random
document is handled by existing behavior (ignored / normal fallback) — the
publish path simply doesn't trigger.

**Broadcast.** On the **Розіслати** callback (admin-only):
- Select distinct `telegram_id` from `api_tokens`.
- For each: send a message — "🔔 Нова версія розширення v0.2.0" + the changelog
  notes + a 2-line "як оновити" footer + the zip document (by `file_id`).
- Per-recipient `try/catch`: a blocked/failed send is logged and skipped, never
  aborts the loop. Sequential with a small delay (≤10 recipients; well under
  Telegram's ~30 msg/s cap).
- After the loop, edit/reply to the admin with a summary: "Надіслано X, помилок Y."
- On **Скасувати**: the stored release stays (so `/extension` still serves it),
  but no broadcast goes out; reply "Скасовано, не розіслано."

**`/extension` for new testers.** After minting the token, the command also
sends the current latest zip (by `file_id`) + short install instructions, when a
release exists. If no release is stored yet, it falls back to the current
token-only behavior + a note to build from source.

**i18n.** All new bot strings go through the locale system, escaped for the
HTML send mode (per existing `replyWithHTML` escaping rules; metavars like
version are inserted as escaped text).

### C. Documentation (`docs/extension-install-uk.md`)

Part 2 ("Встановлення") changes from "build from source" to "get the zip from
the bot": `/extension` returns token + zip; unzip into a stable folder; Load
unpacked once. Add an **"Оновлення"** subsection: bot sends a new zip → unzip
over the same folder → click ↻ reload; token/settings persist. The
build-from-source path is kept as an appendix for maintainers.

## Error handling

| Where | Condition | Behavior |
|---|---|---|
| Build | version has no CHANGELOG section | `npm run package` exits non-zero with a clear message |
| Build | `dist/manifest.json` missing | exit non-zero (build didn't run) |
| Release | can't reach/write the DB | `npm run release` exits non-zero; zip is still produced |
| Publish | sender not admin | publish path not triggered (normal fallback) |
| Publish | not a zip / too large | reply with the reason, no DB change |
| Publish | hash matches no release row | reply "файл не відповідає останньому релізу — спершу `npm run release`" |
| Broadcast | `file_id` not attached yet | buttons aren't shown until attach, so this can't be reached |
| Broadcast | a recipient send fails | log + skip; counted in the failure summary |

## Testing (Jest for `src/`, Vitest for `extension/`)

- **Changelog slicer** (extension, pure fn): correct section for a version;
  throws when the section is missing; trims/normalizes whitespace.
- **Manifest version wiring** (extension): manifest version equals
  `package.json` version.
- **Release DB write** (bot/script): `npm run release` upserts a row with the
  expected version, notes, and the zip's sha256.
- **`extension_releases` storage** (bot): insert by build; "latest" by semver;
  attach `file_id` to the latest row; idempotent re-attach.
- **Hash-match on publish** (bot): a file whose sha256 matches the latest row
  attaches its `file_id`; a non-matching file is rejected and no row changes.
- **Broadcast** (bot): iterates all token holders; continues past a failing
  send (mocked Telegram); returns `{ sent, failed }`.
- **Admin guard** (bot): publish + broadcast callbacks reject non-admin senders.

## Out of scope (Phase 2 candidates)

- Extension self-version-check via the API (surface "update available" in the
  options page for testers who muted the bot).
- Automatic reload (not possible off-store on Chromium without enterprise
  policy).
- Multi-browser (Firefox) packaging.
