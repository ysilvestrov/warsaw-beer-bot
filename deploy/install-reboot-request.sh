#!/usr/bin/env bash
# #469 stage 3 — install the root handler for the bot's reboot request.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 3)
#
# Run from anywhere:   sudo bash deploy/install-reboot-request.sh
#
# Installs scripts/ops/reboot_request.py as /usr/local/libexec/wbb-reboot-request,
# wbb-reboot-request.path + .service, creates /var/lib/wbb-host-patch (0700, owned by the bot
# user, which writes the request into it) and enables the path unit. Idempotent. A refused run
# changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-reboot-request.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

DIR=/var/lib/wbb-host-patch
# /var/lib is root-only, so nobody else can plant this path; still, never chown or chmod
# through a symlink or onto a file.
if [ -L "$R$DIR" ] || { [ -e "$R$DIR" ] && [ ! -d "$R$DIR" ]; }; then
  echo "ERROR: $DIR exists and is not a directory — remove it (sudo rm -rf $DIR) and re-run. Nothing was changed." >&2
  exit 1
fi

install -d "$R/usr/local/libexec" "$R/etc/systemd/system"
install -m 0755 scripts/ops/reboot_request.py       "$R/usr/local/libexec/wbb-reboot-request"
install -m 0644 deploy/wbb-reboot-request.path      "$R/etc/systemd/system/wbb-reboot-request.path"
install -m 0644 deploy/wbb-reboot-request.service   "$R/etc/systemd/system/wbb-reboot-request.service"
[ -e "$R$DIR" ] || mkdir "$R$DIR"
chmod 0700 "$R$DIR"
chown warsaw-beer-bot:warsaw-beer-bot "$R$DIR"

systemctl daemon-reload
systemctl enable --now wbb-reboot-request.path
# enable --now does not re-arm an already active unit: a changed path unit needs the restart.
systemctl restart wbb-reboot-request.path

echo
echo "== installed =="
echo "  /usr/local/libexec/wbb-reboot-request"
echo "  /etc/systemd/system/wbb-reboot-request.{path,service}"
echo "  $DIR (0700, warsaw-beer-bot)"
