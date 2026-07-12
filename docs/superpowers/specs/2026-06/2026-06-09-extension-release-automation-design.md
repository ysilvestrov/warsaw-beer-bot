# Extension release automation — design

**Date:** 2026-06-09
**Status:** approved (brainstorming)
**Builds on:** [extension beta distribution](2026-06-08-extension-beta-distribution-design.md)

## Problem

Cutting an extension release (`npm run release`) is not fully automated on the prod
host. Three frictions surfaced publishing v0.2.0 (2026-06-09):

1. **Zip sha is non-deterministic.** `extension/scripts/zip-dist.py` walks `dist/` in
   filesystem order and writes each entry with the file's current mtime, so every build
   yields a different `warsaw-beer-overlay-<v>.zip` sha for identical content. The bot
   sha-matches the forwarded zip against the DB row, so the exact hashed zip must be
   forwarded — a "don't rebuild after publishing" footgun.
2. **The publish step can't write the prod DB.** The build must run as `ysi` (only
   `/home/ysi/warsaw-beer-bot/extension` has `node_modules`/vite), but
   `/var/lib/warsaw-beer-bot/bot.db` is owned by `warsaw-beer-bot` and `/home/ysi` is
   mode `750`, so the service user can't traverse into the repo to run the publish
   script. Today the row was written by hand-assembling SQL piped to
   `sudo -u warsaw-beer-bot sqlite3`.
3. **Getting the zip to a Telegram client.** The zip lived under `/home` (`750`), which
   blocks scp/file-manager pickup; it had to be copied to `/tmp` by hand.

## Goal

One command — `npm run release` (run as `ysi` in `extension/`) — performs **build →
write release row to prod DB → stage zip to an accessible location**. The only manual
steps left are the two deliberate Telegram actions: forwarding the zip to the bot and
pressing **📣 Розіслати** (the broadcast button stays a human gate before sending to
real users).

## Scope boundary

| Step | Owner |
| --- | --- |
| `vite build` → `RELEASE_NOTES.txt` → zip | automated |
| write `extension_releases` row to prod DB | automated (privilege-escalated for the single row insert) |
| stage zip to `~/extension-releases/` | automated |
| forward zip to the bot (bot sha-matches → sets `file_id`) | **manual** |
| press 📣 Розіслати → broadcast | **manual** |

## Flow

```
npm run release            (user: ysi, cwd: extension/)
 ├─ npm run package
 │   ├─ vite build
 │   ├─ release-notes.ts  → dist/RELEASE_NOTES.txt
 │   └─ zip-dist.py       → warsaw-beer-overlay-<v>.zip      [now DETERMINISTIC]
 └─ npx tsx scripts/publish-extension-release.ts
     ├─ buildReleaseRow()  → { version, sha256(zip), notes }
     ├─ write row → extension_releases   (adaptive transport, see Component 2)
     ├─ stage zip → ~/extension-releases/warsaw-beer-overlay-<v>.zip
     └─ print: staged path + sha256 + scp hint
```

Fail-fast ordering: the DB row is written **before** staging, so a build that can't
publish never produces a stage-able zip the operator might forward without a matching
row.

## Components

### 1. `extension/scripts/zip-dist.py` — deterministic archive

Today: `os.walk` order (filesystem-dependent) + `z.write(abs, arcname)` (stores the
file's mtime). Change to:

- Collect all arcnames and **sort** them (stable entry order).
- For each, build a `zipfile.ZipInfo(filename=arcname, date_time=(1980, 1, 1, 0, 0, 0))`
  (the zip epoch floor), set `compress_type = ZIP_DEFLATED` and a fixed
  `external_attr` (e.g. `0o644 << 16`), read the file bytes, and `z.writestr(info,
  data)`.

Result: byte-identical zip across runs of the same `dist/`. Makes re-runs idempotent
(same sha → upsert is a no-op) and removes the "don't rebuild" footgun. Zip mtimes are
metadata nobody consumes, so pinning them is free.

### 2. `scripts/publish-extension-release.ts` — adaptive write + staging

Keep the tested `buildReleaseRow({ version, zip, notes })` (sha256 over zip bytes,
trimmed notes). Choose the write transport by prod-DB writability:

- **DB writable by the current user** (local dev / CI DB) → existing in-process path:
  `openDb(dbPath)` + `upsertRelease(db, row)`.
- **DB not writable** (prod, owned by `warsaw-beer-bot`) → invoke the privileged
  wrapper (Component 3):
  `execFileSync('sudo', ['-u', 'warsaw-beer-bot', helperPath, version, sha256], { input: notes })`
  — `version` and `sha256` as argv, free-text `notes` over stdin.

`helperPath` is a constant (`/usr/local/bin/apply-extension-release.sh`) overridable via
`RELEASE_APPLY_HELPER` (used only by tests).

After a successful write: copy the zip to `~/extension-releases/` (`mkdir -p`), then
print the absolute staged path, the sha256, and a ready-to-use `scp` one-liner. Staging
into `ysi`'s own home is reachable by `ysi`'s own scp (the `/home` `750` only blocked
the *service* user / cross-user pickup).

### 3. Privileged wrapper + sudoers (one-time host setup)

**`/usr/local/bin/apply-extension-release.sh`** — performs exactly one fixed upsert into
a **hard-coded** prod DB path. Owned `root:root`, mode `755`, **not writable by `ysi`**
(otherwise the narrow grant is meaningless — `ysi` could rewrite it).

```bash
#!/usr/bin/env bash
set -euo pipefail
version="$1"; sha="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version" >&2; exit 2; }
[[ "$sha"     =~ ^[0-9a-f]{64}$           ]] || { echo "bad sha" >&2; exit 2; }
notes="$(cat)"                  # free text from stdin
notes_esc="${notes//\'/\'\'}"   # SQLite text-literal escape: double single quotes (complete rule)
printf 'PRAGMA busy_timeout=5000;\nINSERT INTO extension_releases (version,sha256,notes) VALUES('"'"'%s'"'"','"'"'%s'"'"','"'"'%s'"'"') ON CONFLICT(version) DO UPDATE SET sha256=excluded.sha256, notes=excluded.notes;\n' \
  "$version" "$sha" "$notes_esc" \
  | sqlite3 /var/lib/warsaw-beer-bot/bot.db
```

- `version`/`sha` validated by regex; `notes` escaped for SQLite (doubling `'` is the
  complete rule — SQLite has no backslash escapes in string literals). `printf` is used
  with a constant format string, so the values can't be reinterpreted as format
  directives.
- `PRAGMA busy_timeout=5000` because the live bot holds the DB open in WAL.
- The prod DB path is **hard-coded**, so the script physically cannot do anything but
  this one upsert on the bot DB.

**`/etc/sudoers.d/warsaw-beer-extension-release`:**

```
ysi ALL=(warsaw-beer-bot) NOPASSWD: /usr/local/bin/apply-extension-release.sh
```

`ysi` may now run **only this script** as `warsaw-beer-bot` without a password — not
arbitrary SQL. Running as the service user (not root) keeps WAL/`-shm` ownership
correct. This is not an escalation: `ysi` is already in the `sudo` group; the rule only
removes the prompt for this one fixed command.

**Repo home:** canonical wrapper source lives at `deploy/bin/apply-extension-release.sh`
and the sudoers snippet at `deploy/sudoers.d/warsaw-beer-extension-release` for
reproducibility. Installation (copy to `/usr/local/bin` + `/etc/sudoers.d`, set
ownership/perms, `visudo -c`) is a one-time root step, documented in the runbook — not a
per-release action.

### 4. `docs/extension-release.md` — runbook update

Rewrite for the one-command flow: prerequisites (signing key + one-time wrapper/sudoers
install), then `cd extension && npm run release`, then forward the staged
`~/extension-releases/...zip` and press 📣. Drop the obsolete manual SQL / `/tmp` steps.

## Error handling

- Wrapper/sudo failure (missing NOPASSWD, lock, bad args) → non-zero exit with a clear
  message; **staging is skipped** (write precedes stage).
- `DATABASE_PATH` unset → error (current behaviour).
- Idempotency: `ON CONFLICT` upsert + deterministic zip → re-running the same version is
  a safe no-op.

## Testing (Jest / vitest)

- `buildReleaseRow` — existing unit coverage retained.
- **Wrapper** — tested without sudo against a temp DB: run a copy of the script with the
  DB path substituted (the installed prod copy stays hard-coded), feeding sample
  `version`/`sha` and `notes` that contain a single quote; assert the row landed with
  correctly-escaped notes and that a second run upserts idempotently.
- **Zip determinism** — build the zip from a fixed `dist/` twice and assert identical
  sha256.
- **Adaptive transport** — exercise the writable-DB → in-process branch against a temp
  DB and assert the row.
- All existing extension + bot suites remain green.

## Spec note

`spec.md` (OpenSpec, single source of truth) is reviewed as part of implementation. The
maintainer release tooling is operational and likely outside `spec.md`'s behavioural
scope; if `spec.md` already documents the release/distribution contract, add a line
noting the deterministic artifact + one-command publish. Decide and, if needed, update
`spec.md` in the same PR.

## Out of scope

- Automating the Telegram forward or the broadcast (deliberately manual).
- Auto-capturing `file_id` via the Bot API.
- Changing prod DB ownership/permissions (rejected in favour of the narrow wrapper).
