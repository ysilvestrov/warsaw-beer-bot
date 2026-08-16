#!/usr/bin/env bash
# #435 — unattended deploy of a qualified dependency fix.
#
# Runs as the operator user (ysi) so it reuses the existing NOPASSWD sudoers
# scope; it requires no new privilege. It NEVER touches the operator's working
# tree at /home/ysi/warsaw-beer-bot — deploy.sh rsyncs `./`, so running from
# there would ship whatever happens to be uncommitted.
set -euo pipefail

REPO_URL=https://github.com/ysilvestrov/warsaw-beer-bot.git
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
REPO="$DATA_DIR/repo"
STATE="$STATE_DIR/state.env"
LOCK="$STATE_DIR/lock"
GUARD_HEALTH_TRIES=30
# The guard comes from the INSTALLED copy, never from the checkout we just
# fetched into: a guard that ships with the commit it is judging is not a guard.
GUARD_BIN="${WBB_GUARD:-/usr/local/bin/wbb-autodeploy-guard}"

mkdir -p "$DATA_DIR" "$STATE_DIR"

# Prevents overlapping autodeploy runs. It does NOT exclude a manual
# ./deploy/deploy.sh, which takes no lock — but a manual deploy means the
# operator is present, which is the case this whole mechanism defers to.
exec 9>"$LOCK"
flock -n 9 || { echo "another autodeploy holds the lock; exiting"; exit 0; }

notify() {
  # Deliberately NOT via the bot: if the deploy took the bot down, the bot
  # cannot report that it is down.
  sudo -u warsaw-beer-bot bash -lc '
    set -a; . /etc/warsaw-beer-bot/.env; set +a
    curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ADMIN_TELEGRAM_ID}" \
      --data-urlencode "text=$1" >/dev/null
  ' _ "$1" || echo "WARNING: notify failed: $1"
}

api_port() {
  sudo -u warsaw-beer-bot bash -lc 'set -a; . /etc/warsaw-beer-bot/.env; set +a; echo "${API_PORT:-3000}"'
}

healthy() {
  local port tries=0 body
  port=$(api_port)
  while [ "$tries" -lt "$GUARD_HEALTH_TRIES" ]; do
    body=$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" 2>/dev/null || true)
    case "$body" in *'"ok":true'*) return 0 ;; esac
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

deploy_commit() {
  git -C "$REPO" checkout -q --detach "$1"
  ( cd "$REPO" && ./deploy/deploy.sh )
}

# --- fetch -------------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  git clone -q "$REPO_URL" "$REPO"
fi
git -C "$REPO" fetch -q --tags --prune origin

tag=$(git -C "$REPO" for-each-ref --sort=-creatordate --format='%(refname:short)' \
        --count=1 'refs/tags/autodeploy-*')
[ -n "$tag" ] || { echo "no autodeploy tag yet"; exit 0; }

target=$(git -C "$REPO" rev-parse "${tag}^{commit}")

# shellcheck disable=SC1090
[ -f "$STATE" ] && . "$STATE"
DEPLOYED_SHA="${DEPLOYED_SHA:-}"

if [ "$target" = "$DEPLOYED_SHA" ]; then
  echo "already deployed $target"
  exit 0
fi

# On a first run we have nothing to diff against, so compare with what is
# actually installed rather than deploying an unbounded diff blind.
if [ -z "$DEPLOYED_SHA" ]; then
  echo "no recorded deployment; refusing to autodeploy an unbounded diff"
  notify "⛔ autodeploy: no recorded baseline yet. Deploy once by hand, then this becomes automatic."
  exit 1
fi

# --- verify ------------------------------------------------------------------
if ! guard_out=$("$GUARD_BIN" "$REPO" "$DEPLOYED_SHA" "$target" origin/main); then
  echo "$guard_out"
  notify "⛔ autodeploy REFUSED for ${tag}:
${guard_out}"
  exit 1
fi
echo "$guard_out"

git -C "$REPO" checkout -q --detach "$target"
if ! ( cd "$REPO" && npm audit --omit=dev --audit-level=high >/dev/null 2>&1 ); then
  notify "⛔ autodeploy REFUSED for ${tag}: npm audit --omit=dev still reports a high or critical advisory after the fix."
  exit 1
fi

# --- deploy ------------------------------------------------------------------
echo "deploying $target ($tag)"
if deploy_commit "$target" && healthy; then
  printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=%s\n' "$target" "$DEPLOYED_SHA" > "$STATE"
  bumped=$(git -C "$REPO" diff --stat "$DEPLOYED_SHA" "$target" -- package.json | tail -1)
  notify "✅ autodeploy ${tag} — production patched and healthy.
${bumped}"
  exit 0
fi

# --- roll back ---------------------------------------------------------------
# Deliberately not clever: one attempt, then stop and wake a human. An
# automation that keeps turning production over unattended after two failures
# is worse than one that stops and says so.
notify "⚠️ autodeploy ${tag} failed to come up healthy — rolling back to ${DEPLOYED_SHA}."
if deploy_commit "$DEPLOYED_SHA" && healthy; then
  notify "↩️ rollback to ${DEPLOYED_SHA} succeeded. ${tag} needs a human."
  exit 2
fi

notify "🔥 ROLLBACK FAILED. Production is DOWN at ${DEPLOYED_SHA}. Manual intervention required."
exit 3
