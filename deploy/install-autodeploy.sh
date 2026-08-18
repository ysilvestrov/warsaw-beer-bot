#!/usr/bin/env bash
# #435 Gate 3 — one-time host install of the autodeploy deployer.
#
# Run from the repo root:   sudo bash deploy/install-autodeploy.sh
#
# Installs (or RE-installs) the scripts and the systemd units. Safe to re-run:
# it never enables or disables the timer, it only refreshes the copies.
#
# RE-RUN THIS AFTER EVERY MERGE THAT TOUCHES deploy/*.sh. The deployer now
# says so itself — daily when idle, and it REFUSES to deploy while stale — /usr/local/bin holds
# COPIES, deliberately, so the running deployer does not change under a
# `git checkout`. The same property means a merged fix is NOT live until this
# script has put it there.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

if [ ! -f deploy/autodeploy.sh ]; then
  echo "ERROR: run this from the warsaw-beer-bot repo (no deploy/autodeploy.sh here: $root)" >&2
  exit 1
fi

echo "== installing from $root =="
echo "   HEAD: $(git log --oneline -1)"
echo

# Copies, not symlinks, deliberately: the running deployer must not change
# under a `git checkout` in the operator's working tree.
install -m 0755 deploy/autodeploy.sh          /usr/local/bin/wbb-autodeploy
install -m 0755 deploy/autodeploy-guard.sh    /usr/local/bin/wbb-autodeploy-guard
install -m 0755 deploy/read-env.sh            /usr/local/bin/wbb-read-env
install -m 0755 deploy/installed-current.sh   /usr/local/bin/wbb-installed-current
install -m 0644 deploy/wbb-autodeploy.service /etc/systemd/system/wbb-autodeploy.service
install -m 0644 deploy/wbb-autodeploy.timer   /etc/systemd/system/wbb-autodeploy.timer
systemctl daemon-reload

echo
echo "== installed =="
ls -l /usr/local/bin/wbb-autodeploy /usr/local/bin/wbb-autodeploy-guard \
      /usr/local/bin/wbb-read-env /usr/local/bin/wbb-installed-current
ls -l /etc/systemd/system/wbb-autodeploy.service /etc/systemd/system/wbb-autodeploy.timer

echo
echo "== timer state =="
state=$(systemctl is-enabled wbb-autodeploy.timer 2>&1 || true)
echo "wbb-autodeploy.timer: $state"
echo
if [ "$state" = "enabled" ]; then
  echo "The timer is ARMED and now runs the newly installed copy."
  echo "Emergency stop, no password needed:"
  echo "  touch ~/.local/state/wbb-autodeploy/PAUSED"
else
  echo "The timer is not armed. Nothing will deploy until:"
  echo "  sudo systemctl enable --now wbb-autodeploy.timer"
fi
echo
echo "Done."
