#!/usr/bin/env bash
set -euo pipefail

# Run as the operator. As root, HOME=/root: another lock (R4 would not hold)
# and another state file (record-deployed would write a baseline nobody reads).
if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: run deploy.sh as the operator (bash deploy/deploy.sh), not as root or via sudo — it calls sudo itself, per step." >&2
  exit 1
fi

# Merge-deploy R4: a manual deploy and the merge-deploy tick exclude each other
# through the tick's own lock. While a tick watches its 10-minute rollback
# window, a manual deploy here would be undone by that tick's rollback (code
# AND database). The tick passes WBB_TICK_HOLDS_LOCK=1 to the deploy.sh it
# runs itself, because it already holds the lock.
if [ -z "${WBB_TICK_HOLDS_LOCK:-}" ]; then
  LOCK_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
  mkdir -p "$LOCK_DIR"
  exec 8>"$LOCK_DIR/lock"
  if ! flock -w "${WBB_LOCK_WAIT_S:-30}" 8; then
    echo "ERROR: a merge-deploy tick holds $LOCK_DIR/lock — it is probably watching a rollback window (up to ~12 min after its deploy). Retry when it ends. 'touch $LOCK_DIR/PAUSED' stops the NEXT tick, not the running one." >&2
    exit 1
  fi
fi

APP=/opt/warsaw-beer-bot
DATA=/var/lib/warsaw-beer-bot
ENVDIR=/etc/warsaw-beer-bot
HOMEDIR=/home/warsaw-beer-bot

sudo install -d -o warsaw-beer-bot -g warsaw-beer-bot "$APP" "$DATA" "$ENVDIR"
sudo install -d -o warsaw-beer-bot -g warsaw-beer-bot -m 750 "$HOMEDIR"

# Re-assert ownership of env files — created manually as root during first
# setup, must be owned by warsaw-beer-bot so refresh-cookie.sh can edit them.
sudo chown -R warsaw-beer-bot:warsaw-beer-bot "$ENVDIR"

sudo rsync -a --delete --delete-excluded \
  --filter='merge deploy/rsync-filter' \
  ./ "$APP"/

# rsync -a preserves source ownership (root); reset before npm runs as warsaw-beer-bot.
sudo chown -R warsaw-beer-bot:warsaw-beer-bot "$APP"

# typescript lives in devDependencies, so we need a full install for `tsc`,
# then prune dev deps once dist/ is built.
sudo -u warsaw-beer-bot bash -lc "cd $APP && npm ci && npm run build && npm prune --omit=dev"
sudo install -m 0644 deploy/warsaw-beer-bot.service /etc/systemd/system/warsaw-beer-bot.service
sudo systemctl daemon-reload
sudo systemctl enable warsaw-beer-bot
# `enable --now` is a no-op on an already-running unit, so a redeploy with new
# code would leave the old process in memory. Always restart explicitly.
sudo systemctl restart warsaw-beer-bot
# #435 — record what is now live, so the autodeploy guard can diff from it.
# A stale baseline does not just mislead, it BLOCKS autodeploy: every
# undeployed merge adds paths to the guard's diff until it leaves the
# allowlist, and then every security tag is refused — silently, because a
# refusal looks exactly like the guard working.
#
# rsync ships the TREE, not a commit, so a dirty tree corresponds to no commit
# at all. Recording HEAD in that case would be a lie the guard then trusts, so
# the baseline is CLEARED instead and autodeploy refuses until a human reseeds
# it. Fail closed.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "WARNING: working tree is dirty — clearing the autodeploy baseline"
  "$(dirname "$0")/record-deployed.sh" ''
else
  "$(dirname "$0")/record-deployed.sh" "$(git rev-parse HEAD)"
fi

# journalctl works without sudo because the operator user is in the
# systemd-journal group (see deploy/README.md → "One-time host setup").
journalctl -u warsaw-beer-bot -n 30 --no-pager
