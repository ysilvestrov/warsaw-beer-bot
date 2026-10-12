#!/usr/bin/env bash
# Install the root helper `wbb-image` — switching nothing.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §5.
# Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, Task 4.
#
# Run from a CLEAN checkout of main:   sudo bash deploy/install-image.sh [--check]
#
# Installs deploy/image/helper/{wbb_image.py,bounded.py} and the Quadlet template into /usr/local/lib/wbb-image,
# the wrapper as /usr/local/libexec/wbb-image, /etc/sudoers.d/wbb-image (after `visudo -cf`) and the scratch
# directory /var/lib/wbb-image (root, 0700). Before writing anything it renders the template with a dummy digest
# and the bot's ids and runs podman's `quadlet -dryrun` on it: a key this podman does not know (Quadlet's
# StopTimeout= in 4.9, spec §3.2) refuses the install. The sudoers file goes last, so a rule never points at a
# helper that is not there yet. Never enables, starts or stops a unit and never touches
# /etc/containers/systemd: only `wbb-image activate` writes the Quadlet file.
#
# --check writes nothing: exit 0 when every installed copy matches this checkout (content, mode, root:root),
# 1 with the differences listed.
#
# WBB_IMAGE_DESTDIR (tests only): prefix of every target path; then no root, no -o root, and `visudo` and
# `quadlet` come from PATH.
set -euo pipefail

cd "$(dirname "$0")/.."

DEST=${WBB_IMAGE_DESTDIR:-}
CHECK=0
if [ $# -gt 1 ] || { [ $# -eq 1 ] && [ "$1" != --check ]; }; then
  echo "usage: sudo bash deploy/install-image.sh [--check]" >&2
  exit 64
fi
[ $# -eq 1 ] && CHECK=1

if [ -z "$DEST" ] && [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root: sudo bash deploy/install-image.sh $*" >&2
  exit 1
fi

LIB=/usr/local/lib/wbb-image
SCRATCH=/var/lib/wbb-image
# source  target  mode — in install order: the library and the template, the wrapper, the sudoers rules last.
FILES=(
  "deploy/image/helper/bounded.py            $LIB/bounded.py                  0644"
  "deploy/image/helper/wbb_image.py          $LIB/wbb_image.py                0644"
  "deploy/image/warsaw-beer-bot.container    $LIB/warsaw-beer-bot.container   0644"
  "deploy/image/helper/wbb-image.sh          /usr/local/libexec/wbb-image     0755"
  "deploy/sudoers.d/wbb-image                /etc/sudoers.d/wbb-image         0440"
)

if [ "$CHECK" -eq 1 ]; then
  diffs=0
  report() { echo "DIFFERS: $1"; diffs=$((diffs + 1)); }
  for entry in "${FILES[@]}"; do
    read -r src target mode <<<"$entry"
    t="$DEST$target"
    if [ ! -f "$t" ] || [ -L "$t" ]; then report "$target (not installed)"; continue; fi
    cmp -s "$src" "$t" || report "$target (content)"
    [ "$(stat -c %a "$t")" = "${mode#0}" ] || report "$target (mode $(stat -c %a "$t"), want ${mode#0})"
    if [ -z "$DEST" ] && [ "$(stat -c %U:%G "$t")" != root:root ]; then report "$target (owner $(stat -c %U:%G "$t"))"; fi
  done
  if [ ! -d "$DEST$SCRATCH" ] || [ "$(stat -c %a "$DEST$SCRATCH")" != 700 ]; then report "$SCRATCH (missing or not 0700)"; fi
  if [ "$diffs" -gt 0 ]; then
    echo "$diffs difference(s): sudo bash deploy/install-image.sh"
    exit 1
  fi
  echo "wbb-image: every installed copy matches $(git log --oneline -1 2>/dev/null || echo 'this checkout')"
  exit 0
fi

if [ -n "$DEST" ]; then
  VISUDO=visudo
  QUADLET=quadlet
  OWNER=()
else
  VISUDO=/usr/sbin/visudo
  QUADLET=/usr/libexec/podman/quadlet
  OWNER=(-o root -g root)
fi

# 1. The sudoers rules parse.
"$VISUDO" -cf deploy/sudoers.d/wbb-image

# 2. This podman's Quadlet accepts the template as activate will fill it.
if ! uid=$(id -u warsaw-beer-bot 2>/dev/null) || ! gid=$(id -g warsaw-beer-bot 2>/dev/null); then
  if [ -z "$DEST" ]; then
    echo "ERROR: no user warsaw-beer-bot on this host" >&2
    exit 1
  fi
  uid=999 gid=988
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/units"
sed -e "s|@@DIGEST@@|sha256:$(printf '0%.0s' {1..64})|" -e "s|@@UID@@|$uid|" -e "s|@@GID@@|$gid|" \
  deploy/image/warsaw-beer-bot.container > "$work/units/warsaw-beer-bot.container"
if grep -q '@@' "$work/units/warsaw-beer-bot.container"; then
  echo "ERROR: the template has a placeholder besides @@DIGEST@@, @@UID@@ and @@GID@@" >&2
  exit 1
fi
if ! QUADLET_UNIT_DIRS="$work/units" "$QUADLET" -dryrun > "$work/out" 2> "$work/err" \
  || grep -qi 'unsupported key' "$work/err" || ! grep -q -- '---warsaw-beer-bot.service---' "$work/out"; then
  echo "ERROR: quadlet -dryrun does not accept deploy/image/warsaw-beer-bot.container on this host:" >&2
  cat "$work/err" >&2
  exit 1
fi

# 3. Install.
install -d -m 0755 "${OWNER[@]}" "$DEST$LIB" "$DEST/usr/local/libexec" "$DEST/etc/sudoers.d"
install -d -m 0700 "${OWNER[@]}" "$DEST$SCRATCH"
for entry in "${FILES[@]}"; do
  read -r src target mode <<<"$entry"
  install -m "$mode" "${OWNER[@]}" "$src" "$DEST$target"
done

echo "installed:"
for entry in "${FILES[@]}"; do
  read -r _ target _ <<<"$entry"
  echo "  $target"
done
echo "  $SCRATCH/"
echo "Nothing was enabled, started or activated. Check later with: sudo bash deploy/install-image.sh --check"
