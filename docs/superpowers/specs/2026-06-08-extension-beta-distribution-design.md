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
- **Version + release notes come from the build artifact, not from manual
  input at send time.** The bot reads them out of the zip. This removes the
  chance of the announced version drifting from the shipped one.
- **Version is bumped in one place** (`package.json`); the manifest derives it.
- **Extension self-version-check is out of scope** for v1 (possible Phase 2).

## Flow

**Release (admin):**
1. Bump `version` in `extension/package.json`; add the matching section to
   `extension/CHANGELOG.md`.
2. `npm run package` → `warsaw-beer-overlay-<version>.zip` with `manifest.json`
   (version) and `RELEASE_NOTES.txt` (version + notes) at the zip root.
3. Forward that zip to the bot as a document (no caption/args needed).
4. Bot reads metadata from the zip, stores the release, and replies with an
   inline **📣 Розіслати / Скасувати** confirmation.
5. On confirm, the bot broadcasts the zip + notes to every token holder.

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

**Packaging.** `npm run package` becomes: `vite build` → generate
`dist/RELEASE_NOTES.txt` from the CHANGELOG section matching `package.json`'s
version → zip `dist/` into `warsaw-beer-overlay-<version>.zip`.
`RELEASE_NOTES.txt` content:

```
Warsaw Beer Overlay v0.2.0

<the body of the matching CHANGELOG section>
```

A new build step (`scripts/release-notes.ts` or extended `zip-dist.py`)
**fails the build** if `package.json`'s version has no matching CHANGELOG
section — this catches "forgot to write notes / forgot to bump". The changelog
slicer is a pure function and is unit-tested in isolation.

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
  file_id      TEXT NOT NULL,               -- Telegram file_id (re-send w/o re-upload)
  notes        TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_by INTEGER NOT NULL             -- admin telegram_id
);
```

"Latest" = the row with the highest semver (compared in code, not lexically).

**Publish handler.** On a document message from `ADMIN_TELEGRAM_ID`:
1. Guard: sender is the admin and the document looks like our zip (filename /
   mime, size bound — same ≤20 MB Telegram limit already handled for `/import`).
2. Download via `getFile` + fetch into a buffer.
3. Unzip in memory (`fflate` — small, zero-dep, sync `unzipSync`). Read
   `manifest.json` → `version` + `name`; read `RELEASE_NOTES.txt` → notes.
4. Validate: `name` === expected ("Warsaw Beer Overlay"); `version` is valid
   semver; `version` is **strictly greater** than the current latest (reject
   duplicate/downgrade); `RELEASE_NOTES.txt` present and non-empty.
5. Insert into `extension_releases` with the received document's `file_id`.
6. Reply to the admin: "Збережено v0.2.0. Отримають N тестерів." + inline
   keyboard **📣 Розіслати / Скасувати**.

A non-admin sending a random document is handled by existing behavior (ignored /
normal fallback) — the publish path simply doesn't trigger.

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
| Publish | sender not admin | publish path not triggered (normal fallback) |
| Publish | not a zip / too large | reply with the reason, no DB write |
| Publish | malformed zip / missing manifest or notes | reply with the reason, no DB write |
| Publish | bad / duplicate / downgrade version | reply with the reason, no DB write |
| Broadcast | a recipient send fails | log + skip; counted in the failure summary |

## Testing (Jest for `src/`, Vitest for `extension/`)

- **Changelog slicer** (extension, pure fn): correct section for a version;
  throws when the section is missing; trims/normalizes whitespace.
- **Manifest version wiring** (extension): manifest version equals
  `package.json` version.
- **Zip metadata extraction** (bot): from a fixture zip → correct version +
  notes; rejects a zip missing `manifest.json` / `RELEASE_NOTES.txt`.
- **`extension_releases` storage** (bot): insert; "latest" by semver; reject
  duplicate; reject downgrade.
- **Broadcast** (bot): iterates all token holders; continues past a failing
  send (mocked Telegram); returns `{ sent, failed }`.
- **Admin guard** (bot): publish + broadcast callbacks reject non-admin senders.

## Out of scope (Phase 2 candidates)

- Extension self-version-check via the API (surface "update available" in the
  options page for testers who muted the bot).
- Automatic reload (not possible off-store on Chromium without enterprise
  policy).
- Multi-browser (Firefox) packaging.
