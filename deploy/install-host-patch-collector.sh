#!/usr/bin/env bash
# #469 stage 2 — install the hourly root host-patch collector.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 2)
#
# Run from the repo root:   sudo bash deploy/install-host-patch-collector.sh
#
# Installs scripts/ops/host_patch_collect.py as /usr/local/libexec/wbb-host-patch-collect,
# wbb-host-patch.service + .timer, creates /var/tmp/wbb-host-patch (root, 0755), enables the
# timer and runs the collector once so the first summary exists before the bot reads it.
# Idempotent. A refused run changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-host-patch-collector.sh" >&2
  exit 1
fi

OUT=/var/tmp/wbb-host-patch
# /var/tmp is world-writable: anyone could pre-create the summary directory and make root write
# (and the bot trust) a file they control. Refuse anything but a directory owned like the root.
want_uid=$(stat -c %u "${R:-/}")
if [ -L "$R$OUT" ] || { [ -e "$R$OUT" ] && { [ ! -d "$R$OUT" ] || [ "$(stat -c %u "$R$OUT")" != "$want_uid" ]; }; }; then
  echo "ERROR: $OUT exists and is not a root-owned directory — remove it (sudo rm -rf $OUT) and re-run. Nothing was changed." >&2
  exit 1
fi

install -d "$R/usr/local/libexec" "$R/etc/systemd/system"
install -m 0755 scripts/ops/host_patch_collect.py "$R/usr/local/libexec/wbb-host-patch-collect"
install -m 0644 deploy/wbb-host-patch.service     "$R/etc/systemd/system/wbb-host-patch.service"
install -m 0644 deploy/wbb-host-patch.timer       "$R/etc/systemd/system/wbb-host-patch.timer"
install -d -m 0755 "$R$OUT"
chmod 0755 "$R$OUT"

systemctl daemon-reload
systemctl enable --now wbb-host-patch.timer
# Synchronous for a oneshot: the first summary exists when this returns.
systemctl start wbb-host-patch.service

echo
echo "== installed =="
echo "  /usr/local/libexec/wbb-host-patch-collect"
echo "  /etc/systemd/system/wbb-host-patch.{service,timer}"
echo "  $OUT"
echo
echo "Check the first summary before deploying the wiring (livepatch must not be null):"
echo "  python3 -m json.tool $OUT/summary.json"
