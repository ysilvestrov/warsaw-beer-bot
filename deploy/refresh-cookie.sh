#!/usr/bin/env bash
# Usage: ./deploy/refresh-cookie.sh <untappd_user_v3_e cookie value>
#
# Replaces (or appends) UNTAPPD_SESSION_COOKIE in /etc/warsaw-beer-bot/.env
# and restarts the service. No sudo password required — covered by the
# existing NOPASSWD sudoers fragment (deploy/sudoers.d/warsaw-beer-bot).
set -euo pipefail

NEW_VAL=${1:?Usage: $0 <untappd_user_v3_e cookie value>}
ENV_FILE=/etc/warsaw-beer-bot/.env

sudo -u warsaw-beer-bot bash -lc "
  if grep -q '^UNTAPPD_SESSION_COOKIE=' '$ENV_FILE'; then
    sed -i 's|^UNTAPPD_SESSION_COOKIE=.*|UNTAPPD_SESSION_COOKIE=$NEW_VAL|' '$ENV_FILE'
    echo 'Cookie line updated.'
  else
    printf '\nUNTAPPD_SESSION_COOKIE=%s\n' '$NEW_VAL' >> '$ENV_FILE'
    echo 'Cookie line appended.'
  fi
"

sudo systemctl restart warsaw-beer-bot
echo 'Service restarted.'
echo 'Check logs: journalctl -u warsaw-beer-bot -n 30 --no-pager'
