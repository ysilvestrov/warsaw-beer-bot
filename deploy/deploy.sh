#!/usr/bin/env bash
set -euo pipefail

APP=/opt/warsaw-beer-bot
DATA=/var/lib/warsaw-beer-bot
ENVDIR=/etc/warsaw-beer-bot
HOMEDIR=/home/warsaw-beer-bot

sudo install -d -o warsaw-beer-bot -g warsaw-beer-bot "$APP" "$DATA" "$ENVDIR"
sudo install -d -o warsaw-beer-bot -g warsaw-beer-bot -m 750 "$HOMEDIR"

sudo rsync -a --delete \
  --exclude node_modules \
  --exclude tests \
  --exclude docs \
  --exclude .git \
  --exclude .worktrees \
  --exclude dist \
  ./ "$APP"/

# rsync -a preserves source ownership (root); reset before npm runs as warsaw-beer-bot.
sudo chown -R warsaw-beer-bot:warsaw-beer-bot "$APP"

sudo -u warsaw-beer-bot bash -lc "cd $APP && npm ci --omit=dev && npm run build"
sudo install -m 0644 deploy/warsaw-beer-bot.service /etc/systemd/system/warsaw-beer-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now warsaw-beer-bot
sudo journalctl -u warsaw-beer-bot -n 30 --no-pager
