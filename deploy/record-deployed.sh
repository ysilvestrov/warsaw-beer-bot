#!/usr/bin/env bash
# #435 — record which commit is live in /opt.
#
# The autodeploy guard computes its diff from the DEPLOYED commit, so a stale
# baseline does not merely mislead: it BLOCKS the mechanism. Every merge that
# is not deployed adds paths to that diff, and once the diff leaves the
# allowlist the guard refuses every future security tag — silently, because a
# refusal looks exactly like the guard working correctly.
#
# MEASURED 2026-08-18: three merged pull requests put twelve unrelated files
# between the baseline and `main`, and autodeploy was blocked without a single
# error anywhere.
#
# So the baseline is written where reality changes — at the end of a deploy —
# rather than by a separate step somebody has to remember.
#
# Usage: record-deployed.sh <sha>    record a commit as live
#        record-deployed.sh ''       clear it (nothing trustworthy is known)
set -euo pipefail

sha=${1-}
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
STATE="$STATE_DIR/state.env"

mkdir -p "$STATE_DIR"
touch "$STATE"

# Rewrite DEPLOYED_SHA, keep every other key. autodeploy.sh owns PREVIOUS_SHA
# and LAST_FAILED_SHA and must not lose them to a deploy that happened to run
# in between.
tmp=$(mktemp "$STATE_DIR/.state.XXXXXX")
trap 'rm -f "$tmp"' EXIT

awk -v sha="$sha" '
  /^DEPLOYED_SHA=/ { next }
  { print }
  END { print "DEPLOYED_SHA=" sha }
' "$STATE" > "$tmp"

mv "$tmp" "$STATE"
trap - EXIT

if [ -n "$sha" ]; then
  echo "recorded deployed commit: $sha"
else
  echo "cleared the deployed baseline — autodeploy will refuse until it is reseeded"
fi
