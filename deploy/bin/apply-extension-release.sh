#!/usr/bin/env bash
# Privileged release-row applier. Installed at /usr/local/bin (root:root, 0755) and run
# only via the NOPASSWD sudoers rule as warsaw-beer-bot. Performs exactly one fixed
# upsert into the hard-coded prod bot DB. Keep the DB path literal — the test patches a
# copy, never this file.
set -euo pipefail
version="$1"
sha="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $version" >&2; exit 2; }
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha: $sha" >&2; exit 2; }
notes="$(cat)"                  # free text from stdin
notes_esc="${notes//\'/\'\'}"   # SQLite text-literal escape: double single quotes
printf 'PRAGMA busy_timeout=5000;\nINSERT INTO extension_releases (version,sha256,notes) VALUES('"'"'%s'"'"','"'"'%s'"'"','"'"'%s'"'"') ON CONFLICT(version) DO UPDATE SET sha256=excluded.sha256, notes=excluded.notes;\n' \
  "$version" "$sha" "$notes_esc" \
  | sqlite3 /var/lib/warsaw-beer-bot/bot.db
