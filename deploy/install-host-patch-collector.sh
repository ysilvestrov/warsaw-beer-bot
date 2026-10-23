#!/usr/bin/env bash
# #469 stage 2 — install the hourly root host-patch collector.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 2)
#
# Run from the repo root:   sudo bash deploy/install-host-patch-collector.sh
#
# Installs scripts/ops/host_patch_collect.py as /usr/local/libexec/wbb-host-patch-collect,
# wbb-host-patch.service + .timer, creates /var/tmp/wbb-host-patch (root, 0755), enables the
# timer and runs the collector once so the first summary exists before the bot reads it.
# The operator is whoever ran sudo (SUDO_USER, as install-autodeploy.sh): the drop-in
# wbb-host-patch.service.d/image-state.conf names its image-state.env, whose DEPLOYED_DIGEST the
# collector writes to image.json next to the summary, with the running image (spec 2026-10-11 §10). Without an operator the drop-in is
# left as it is.
# Idempotent. A refused run changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-host-patch-collector.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

OUT=/var/tmp/wbb-host-patch
# /var/tmp is world-writable: anyone could pre-create the summary directory and make root write
# (and the bot trust) a file they control. Refuse anything but a directory owned like the root.
# The root-owner comparison cannot be tested as non-root; the collector (st_uid != geteuid) and the
# reader (dir uid 0) re-enforce it.
want_uid=$(stat -c %u "${R:-/}")
if [ -L "$R$OUT" ] || { [ -e "$R$OUT" ] && { [ ! -d "$R$OUT" ] || [ "$(stat -c %u "$R$OUT")" != "$want_uid" ]; }; }; then
  echo "ERROR: $OUT exists and is not a root-owned directory — remove it (sudo rm -rf $OUT) and re-run. Nothing was changed." >&2
  exit 1
fi

# The operator's image-state.env, where install-autodeploy.sh looks for it. It goes into a systemd
# value: a character systemd would expand (%, $, a space, a quote) is refused, never escaped.
op_home=""
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  op_home=$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)
fi
image_state=""
if [ -n "$op_home" ]; then
  image_state="$op_home/.local/state/wbb-autodeploy/image-state.env"
  if ! [[ $image_state =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "ERROR: the operator's image-state.env path $image_state has a character a unit value cannot hold. Nothing was changed." >&2
    exit 1
  fi
fi
DROPIN=/etc/systemd/system/wbb-host-patch.service.d
# The controller writes the image-state.env of the user its unit runs as. Another operator here names a
# file nothing updates: warned, not refused — the installer cannot tell which of the two is wrong.
if [ -n "$image_state" ]; then
  autodeploy_user=$(systemctl show -p User --value wbb-autodeploy.service 2>/dev/null || true)
  if [ -n "$autodeploy_user" ] && [ "$autodeploy_user" != "$SUDO_USER" ]; then
    echo "WARNING: wbb-autodeploy.service runs as $autodeploy_user, but this install names the image-state.env of $SUDO_USER ($image_state): the status will show the deployed image of a state nobody writes. Re-run as $autodeploy_user (sudo from that account) if that is the operator." >&2
  fi
fi

install -d "$R/usr/local/libexec" "$R/etc/systemd/system"
install -m 0755 scripts/ops/host_patch_collect.py "$R/usr/local/libexec/wbb-host-patch-collect"
install -m 0644 deploy/wbb-host-patch.service     "$R/etc/systemd/system/wbb-host-patch.service"
install -m 0644 deploy/wbb-host-patch.timer       "$R/etc/systemd/system/wbb-host-patch.timer"
if [ -n "$image_state" ]; then
  install -d -m 0755 "$R$DROPIN"
  conf=$(mktemp)
  trap 'rm -f "$conf"' EXIT
  printf '# install-host-patch-collector.sh: the image-state.env of the operator who ran it.\n[Service]\nEnvironment=WBB_IMAGE_STATE=%s\n' \
    "$image_state" > "$conf"
  install -m 0644 "$conf" "$R$DROPIN/image-state.conf"
fi
# mkdir does not follow a final symlink and fails if anything appeared there since the check (set -e).
[ -e "$R$OUT" ] || mkdir -m 0755 "$R$OUT"

systemctl daemon-reload
systemctl enable --now wbb-host-patch.timer
# enable --now does not re-arm an already active timer: a changed timer needs the restart.
systemctl restart wbb-host-patch.timer
# Synchronous for a oneshot: the first summary exists when this returns.
systemctl start wbb-host-patch.service

echo
echo "== installed =="
echo "  /usr/local/libexec/wbb-host-patch-collect"
echo "  /etc/systemd/system/wbb-host-patch.{service,timer}"
if [ -n "$image_state" ]; then
  echo "  $DROPIN/image-state.conf (image-state.env: $image_state)"
elif [ -e "$R$DROPIN/image-state.conf" ]; then
  echo "  the operator cannot be told (SUDO_USER is not set, or has no home): $DROPIN/image-state.conf kept as it was"
else
  echo "  the operator cannot be told (SUDO_USER is not set, or has no home): no image-state.env, the status shows the deployed image as unknown"
fi
echo "  $OUT"
echo
echo "Check the first summary before deploying the wiring (livepatch must not be null):"
echo "  python3 -m json.tool $OUT/summary.json"
