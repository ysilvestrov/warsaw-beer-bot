#!/usr/bin/env bash
# Install (or RE-install) merge-deploy: the image controller and what it calls, and its unit and timer.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §4, §8 п.2.
# Plan: docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md, "Рішення" п.4–5.
#
# Run from a CLEAN checkout of main:   sudo bash deploy/install-autodeploy.sh
# At the switchover it runs AFTER bash deploy/migrate-state-to-image.sh (plan "Рішення" п.10).
#
# Safe to re-run: it never enables or disables the timer, it only refreshes the copies. It refuses,
# installing nothing, while the timer is active and the operator's image-state.env is missing (or the
# operator cannot be told): the first tick of the new controller would write an image-state.env of its
# own (a daily marker only), and the migration would then refuse for good (plan п.11).
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
# WBB_INSTALLED_CURRENT_CMD — run instead of the just-installed wbb-installed-current (plan п.14).
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

# 0. The operator's image-state.env and the timer. The installer runs as root: the operator is whoever
# ran sudo.
op_home=""
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  op_home=$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)
fi
image_state=""
have_state=0
if [ -n "$op_home" ]; then
  image_state="$op_home/.local/state/wbb-autodeploy/image-state.env"
  if [ -e "$DEST$image_state" ]; then have_state=1; fi
fi
active=$("$SYSTEMCTL" is-active wbb-autodeploy.timer 2>/dev/null || true)
if [ "$have_state" = 0 ] && [ "$active" = active ]; then
  if [ -n "$image_state" ]; then
    why="there is no $image_state"
  else
    why="the operator cannot be told (SUDO_USER), so its image-state.env cannot be checked"
  fi
  printf 'ERROR: the timer is active and %s — the first tick of the new controller would write its own image-state.env, and the migration would then refuse for good. Nothing was installed.\nStop it (sudo systemctl disable --now wbb-autodeploy.timer), migrate the state (bash deploy/migrate-state-to-image.sh, as the operator), install the helper (sudo bash deploy/install-image.sh), then run this again (deploy/README.md → Switchover session, steps 2–7).\n' \
    "$why" >&2
  exit 1
fi

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

# Plan п.14: the proof the timer runs what was installed — the controller's own staleness check, with
# the pairs of its installed_is_stale, against HEAD (what was installed).
echo
echo "== installed copies =="
current=${WBB_INSTALLED_CURRENT_CMD:-$DEST/usr/local/bin/wbb-installed-current}
if ! out=$("$current" "$root" "$head" \
    "deploy/autodeploy.sh=$DEST/usr/local/bin/wbb-autodeploy" \
    "deploy/read-env.sh=$DEST/usr/local/bin/wbb-read-env" \
    "deploy/db-snapshot.sh=$DEST/usr/local/bin/wbb-db-snapshot" \
    "deploy/installed-current.sh=$DEST/usr/local/bin/wbb-installed-current" \
    "deploy/image/helper/wbb_image.py=$DEST/usr/local/lib/wbb-image/wbb_image.py" \
    "deploy/image/helper/bounded.py=$DEST/usr/local/lib/wbb-image/bounded.py" \
    "deploy/image/helper/wbb-image.sh=$DEST/usr/local/libexec/wbb-image" \
    "deploy/image/warsaw-beer-bot.container=$DEST/usr/local/lib/wbb-image/warsaw-beer-bot.container" 2>&1); then
  printf 'ERROR: the installed copies do not match HEAD %s after the install:\n%s\n' "${head:0:7}" "$out" >&2
  exit 1
fi
echo "$out"

# 4. The image controller's state.
echo
if [ -z "$op_home" ]; then
  echo "Cannot tell the operator (SUDO_USER is not set, or has no home): check that the operator's"
  echo "~/.local/state/wbb-autodeploy/image-state.env exists. If it does not, migrate the state first"
  echo "(bash deploy/migrate-state-to-image.sh, as the operator, with the timer stopped), then the bootstrap; until then the timer deploys nothing."
elif [ "$have_state" = 0 ]; then
  echo "No $image_state yet: the migration comes first (bash deploy/migrate-state-to-image.sh, as $SUDO_USER, with the"
  echo "timer stopped), then the bootstrap (bash deploy/deploy.sh --bootstrap); until then the timer deploys nothing."
fi

# 5. The timer: reported, never enabled, disabled, started or stopped.
echo
echo "== timer state =="
enabled=$("$SYSTEMCTL" is-enabled wbb-autodeploy.timer 2>&1 || true)
echo "wbb-autodeploy.timer: ${enabled}, ${active:-unknown}"
echo
if [ "$active" = active ]; then
  echo "The timer is ARMED and now runs the newly installed copy."
  echo "Emergency stop, no password needed:"
  echo "  touch ~/.local/state/wbb-autodeploy/PAUSED"
elif [ "$enabled" = enabled ]; then
  echo "The timer is enabled but not running: nothing deploys until"
  echo "  sudo systemctl start wbb-autodeploy.timer"
else
  echo "The timer is not armed. Nothing will deploy until:"
  echo "  sudo systemctl enable --now wbb-autodeploy.timer"
fi
echo
echo "Done."
