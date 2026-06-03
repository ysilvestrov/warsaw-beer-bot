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

sudo rsync -a --delete \
  --exclude node_modules \
  --exclude tests \
  --exclude docs \
  --exclude .git \
  --exclude .worktrees \
  --exclude dist \
  --exclude '*.png' \
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
# journalctl works without sudo because the operator user is in the
# systemd-journal group (see deploy/README.md → "One-time host setup").
journalctl -u warsaw-beer-bot -n 30 --no-pager
