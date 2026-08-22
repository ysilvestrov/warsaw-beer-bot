#!/usr/bin/env bash
set -euo pipefail

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
