#!/usr/bin/env bash
# Install (or RE-install) merge-deploy: the image controller and what it calls, and its unit and timer.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §4, §8 п.2.
# Plan: docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md, "Рішення" п.4–5.
#
# Run from a CLEAN checkout of main:   sudo bash deploy/install-autodeploy.sh
#
# Safe to re-run: it never enables or disables the timer, it only refreshes the copies.
#
# RE-RUN THIS AFTER EVERY MERGE THAT TOUCHES AN INSTALLED FILE. The deployer says so itself — daily
# when idle, and it REFUSES to deploy while stale. /usr/local/bin holds COPIES, deliberately, so the
# running deployer does not change under a `git checkout`; the same property means a merged fix is
# NOT live until this script has put it there.
#
# What is installed are the bytes of HEAD (git objects), never the worktree, and the checkout must be
# clean, as in deploy/install-image.sh: what the human sees in the checkout is what root installs.
#
# Before anything is installed, `bash deploy/install-image.sh --check` must pass: the controller calls
# the root helper wbb-image, and against a stale helper it would only wait. wbb-ships and
# wbb-trial-migrate are no longer installed (the image controller calls neither); their old copies on
# the host are left alone — stage В2 removes them.
#
# Seams (tests only): WBB_AUTODEPLOY_DESTDIR — prefix of every target path; then no root, no -o root,
# no clean-checkout requirement (the bytes still come from HEAD). WBB_SYSTEMCTL_CMD (default
# systemctl). WBB_IMAGE_CHECK_CMD — an executable run instead of `bash deploy/install-image.sh --check`.
#
# Exit: 0 installed, 1 refused, 64 usage.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)

if [ "$#" -ne 0 ]; then
  echo "usage: sudo bash deploy/install-autodeploy.sh   (no arguments)" >&2
  exit 64
fi

DEST=${WBB_AUTODEPLOY_DESTDIR:-}
SYSTEMCTL=${WBB_SYSTEMCTL_CMD:-systemctl}

if [ -z "$DEST" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root: sudo bash deploy/install-autodeploy.sh" >&2
  exit 1
fi

GIT=(git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null)
if [ -z "$DEST" ] && [ -n "$("${GIT[@]}" status --porcelain)" ]; then
  echo "ERROR: the checkout is not clean (git status --porcelain); install from a clean checkout of main" >&2
  exit 1
fi
head=$("${GIT[@]}" rev-parse --verify 'HEAD^{commit}')

# HEAD's bytes of these are installed; the install lines below name them in install order.
SOURCES=(deploy/db-snapshot.sh deploy/read-env.sh deploy/installed-current.sh deploy/autodeploy.sh
  deploy/wbb-autodeploy.service deploy/wbb-autodeploy.timer)

echo "== installing from $root =="
echo "   HEAD: $("${GIT[@]}" log --oneline -1 "$head")"
echo

# 1. The image helper's installed copies are current, or nothing is installed.
if [ -n "${WBB_IMAGE_CHECK_CMD:-}" ]; then
  check=("$WBB_IMAGE_CHECK_CMD")
else
  check=(bash deploy/install-image.sh --check)
fi
if ! out=$("${check[@]}" 2>&1); then
  printf 'ERROR: the image helper is not installed as this checkout has it — the controller would only wait for it. Nothing was installed.\n%s\nRun: sudo bash deploy/install-image.sh, then this again.\n' "$out" >&2
  exit 1
fi
echo "$out"

# 2. HEAD's bytes of each source, staged in a private directory: a regular file in git, never a
# symlink or a submodule.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
for src in "${SOURCES[@]}"; do
  kind=$("${GIT[@]}" ls-tree "$head" -- "$src" | cut -d' ' -f1-2)
  if [ "$kind" != "100644 blob" ] && [ "$kind" != "100755 blob" ]; then
    echo "ERROR: HEAD ${head:0:7} does not track $src as a regular file ('$kind'). Nothing was installed." >&2
    exit 1
  fi
  mkdir -p "$stage/$(dirname "$src")"
  "${GIT[@]}" cat-file blob "$head:$src" > "$stage/$src"
done

# 3. Install from the staged copy (same relative paths). Copies, not symlinks: the running deployer
# must not change under a checkout. M2 (#527): DEPENDENCIES FIRST — the deployer calls the other
# three, so they are installed before it (a consumer first leaves a window in which a tick finds a new
# deployer and an old helper; it fails closed, but the window is free to remove). The unit and the
# timer last. One `install -m <mode> <repo path> …` line per copy: deploy/release/gates.py's test of
# the installed copies, and install-invariant.test.ts, read these lines.
if [ -n "$DEST" ]; then
  OWNER=()
  mkdir -p "$DEST/usr/local/bin" "$DEST/etc/systemd/system"
else
  OWNER=(-o root -g root)
fi
cd "$stage"
install -m 0755 deploy/db-snapshot.sh         "${OWNER[@]}" "$DEST/usr/local/bin/wbb-db-snapshot"
install -m 0755 deploy/read-env.sh            "${OWNER[@]}" "$DEST/usr/local/bin/wbb-read-env"
install -m 0755 deploy/installed-current.sh   "${OWNER[@]}" "$DEST/usr/local/bin/wbb-installed-current"
install -m 0755 deploy/autodeploy.sh          "${OWNER[@]}" "$DEST/usr/local/bin/wbb-autodeploy"
install -m 0644 deploy/wbb-autodeploy.service "${OWNER[@]}" "$DEST/etc/systemd/system/wbb-autodeploy.service"
install -m 0644 deploy/wbb-autodeploy.timer   "${OWNER[@]}" "$DEST/etc/systemd/system/wbb-autodeploy.timer"
cd "$root"
"$SYSTEMCTL" daemon-reload

echo
echo "== installed =="
ls -l "$DEST/usr/local/bin/wbb-db-snapshot" "$DEST/usr/local/bin/wbb-read-env" "$DEST/usr/local/bin/wbb-installed-current" \
      "$DEST/usr/local/bin/wbb-autodeploy" \
      "$DEST/etc/systemd/system/wbb-autodeploy.service" "$DEST/etc/systemd/system/wbb-autodeploy.timer"

# 4. The image controller's state. The installer runs as root: the operator is whoever ran sudo.
echo
op_home=""
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  op_home=$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)
fi
if [ -z "$op_home" ]; then
  echo "Cannot tell the operator (SUDO_USER is not set, or has no home): check that the operator's"
  echo "~/.local/state/wbb-autodeploy/image-state.env exists. If it does not, migrate the state"
  echo "(bash deploy/migrate-state-to-image.sh, as the operator) and run the bootstrap; until then the timer deploys nothing."
else
  image_state="$op_home/.local/state/wbb-autodeploy/image-state.env"
  if [ ! -e "$DEST$image_state" ]; then
    echo "No $image_state yet: migrate the state (bash deploy/migrate-state-to-image.sh, as $SUDO_USER, with the"
    echo "timer stopped) and run the bootstrap (bash deploy/deploy.sh --bootstrap); until then the timer deploys nothing."
  fi
fi

# 5. The timer: reported, never enabled or disabled.
echo
echo "== timer state =="
state=$("$SYSTEMCTL" is-enabled wbb-autodeploy.timer 2>&1 || true)
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
