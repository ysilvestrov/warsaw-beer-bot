#!/usr/bin/env bash
# One-shot: carries the flat deployer's gate keys from state.env into the image controller's
# image-state.env (spec docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md,
# amendment 4 decision 2, §7.1, §8 п.3; plan docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md
# "Рішення" п.6).
#
# Run by the operator on the host, once, with the timer stopped, BEFORE sudo bash deploy/install-autodeploy.sh
# (plan "Рішення" п.10: an unfinished flat window can then still be finished by the flat deployer):
#   bash deploy/migrate-state-to-image.sh
# It validates what it wrote with the controller of THIS checkout (deploy/autodeploy.sh --check-state,
# plan п.9), so the validation is the controller's own and is never repeated here. Not the installed
# copy: before the installer that is still the flat deployer, which ignores --check-state, finds the
# lock busy and exits 0. Success is exit 0 AND the exact line `STATE OK — <image-state.env>`.
#
# What it does, in order; any refusal is exit 1 with nothing changed:
#   1. not root; the timer not active; the deploy lock free (held to the end; the controller's child
#      does not inherit it); state.env a regular file, and no state.env.flat yet.
#   2. reads state.env line by line — never sourced, never run. It carries the gate keys whose sense is
#      the same in both controllers (§7.1, "чинні гейтові"); it drops the daily markers and the drift
#      keys (the new controller says its own notices again); any other key, a key twice or a value not
#      of its format is a refusal. A flat window or rollback still in the state is one too: the flat
#      deployer finishes it first.
#   3. writes image-state.env atomically (temporary file, sync, mv, sync of the directory) and asks
#      the controller --check-state; a refusal removes it again. An image-state.env that already holds
#      exactly what would be carried (a run killed after this step, plan п.13) is kept, not refused;
#      any other image-state.env is a refusal.
#   4. only then: a directory state.env.new/ with a README is prepared, and two renames follow back to
#      back: state.env → state.env.flat, state.env.new → state.env. Old copies of the flat deploy.sh
#      refuse before their first sudo when state.env is not a regular file (§8 п.3). What a kill
#      between the steps leaves, and how to finish it: deploy/README.md → Migrating the flat
#      deployer's state.
#
# Seams (tests): WBB_UID_CMD (default `id -u`), WBB_SYSTEMCTL_CMD (default systemctl),
# WBB_CONTROLLER (default: autodeploy.sh next to this script). The state lives where the controller keeps
# it: ${XDG_STATE_HOME:-~/.local/state}/wbb-autodeploy.
#
# Exit: 0 migrated, 1 refused, 64 usage.
set -euo pipefail

if [ "$#" -ne 0 ]; then
  echo "usage: bash deploy/migrate-state-to-image.sh   (no arguments)" >&2
  exit 64
fi

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
FLAT="$STATE_DIR/state.env"
IMAGE="$STATE_DIR/image-state.env"
LOCK="$STATE_DIR/lock"
SYSTEMCTL="${WBB_SYSTEMCTL_CMD:-systemctl}"
CONTROLLER="${WBB_CONTROLLER:-$(cd "$(dirname "$0")" && pwd)/autodeploy.sh}"

refuse() {
  printf 'REFUSED: %s\nNothing was changed.\n' "$1" >&2
  exit 1
}

# The gate keys carried, in the order the controller writes them (its STATE_KEYS).
CARRY=(DEPLOYED_SHA PREVIOUS_SHA LAST_SEEN_DEPLOYED_SHA REGRESSION_FROM_SHA REGRESSION_TO_SHA
  LAST_FAILED_SHA MAIN_SEEN_SHA MAIN_SEEN_S LAST_CI_NOTICE_SHA)
# The flat deployer's keys that are not carried (its STATE_KEYS at d8c7ff6^): its daily markers, and
# the drift keys its first write dropped.
DROP=(LAST_HOLD_NOTICE LAST_STALE_NOTICE LAST_ASSESS_NOTICE DRIFT_SINCE LAST_DRIFT_NOTICE)
# Its window and rollback: something the flat deployer was in the middle of.
UNFINISHED=(WINDOW_SHA WINDOW_OLD WINDOW_PRE WINDOW_PRE_T WINDOW_START ROLLBACK_STARTED)

_in() { # <word> <list…>
  local w="$1" e
  shift
  for e in "$@"; do
    if [ "$e" = "$w" ]; then return 0; fi
  done
  return 1
}

# --- 1. preconditions --------------------------------------------------------------------------------
# shellcheck disable=SC2086  # a command with its arguments, split on purpose
if ! uid=$(${WBB_UID_CMD:-id -u}) || [ "$uid" = 0 ]; then
  refuse "run this as the operator, not as root: the state is the operator's (~/.local/state/wbb-autodeploy)"
fi
# `is-active` prints the state and exits non-zero unless active. Only a stopped timer is stopped:
# anything else (active, activating, an unreadable answer) is a refusal.
timer=$("$SYSTEMCTL" is-active wbb-autodeploy.timer 2>/dev/null || true)
case "$timer" in
  inactive|failed) ;;
  *) refuse "the timer is not stopped (systemctl is-active wbb-autodeploy.timer: '${timer}') — sudo systemctl stop wbb-autodeploy.timer first" ;;
esac
if [ ! -d "$STATE_DIR" ]; then
  refuse "$STATE_DIR does not exist — there is no flat state to carry"
fi
exec 9>>"$LOCK"
if ! flock -n 9; then
  refuse "the deploy lock is held (a tick or a deploy.sh) — fuser -v $LOCK"
fi
if [ -L "$FLAT" ] || [ ! -f "$FLAT" ]; then
  refuse "$FLAT is not a regular file — nothing to carry (a directory there means it was migrated already)"
fi
if [ -e "$FLAT.flat" ] || [ -L "$FLAT.flat" ]; then
  refuse "$FLAT.flat already exists — it would be overwritten"
fi
if [ -L "$FLAT.new" ] || { [ -e "$FLAT.new" ] && [ ! -d "$FLAT.new" ]; }; then
  refuse "$FLAT.new exists and is not the directory this script prepares"
fi

# --- 2. read state.env: line by line, never sourced --------------------------------------------------
if ! content=$(cat "$FLAT" && printf x); then refuse "$FLAT cannot be read"; fi
content="${content%x}"
if [ -z "$content" ]; then refuse "$FLAT is empty"; fi
if [ "${content: -1}" != $'\n' ]; then refuse "$FLAT: the last line has no newline (a truncated file)"; fi
if ! tr -d '\000' < "$FLAT" | cmp -s - "$FLAT"; then refuse "$FLAT holds a NUL byte"; fi

declare -A value=()
seen=" "
n=0
while IFS= read -r line; do
  n=$(( n + 1 ))
  if ! [[ $line =~ ^([A-Z_]+)=(.*)$ ]]; then refuse "$FLAT line $n is not KEY=value"; fi
  key="${BASH_REMATCH[1]}"
  v="${BASH_REMATCH[2]}"
  case "$seen" in *" $key "*) refuse "$FLAT line $n: duplicate key $key" ;; esac
  seen+="$key "
  if _in "$key" "${DROP[@]}"; then continue; fi
  if _in "$key" "${UNFINISHED[@]}"; then
    refuse "$FLAT line $n: $key — a flat deploy window or rollback is unfinished; let the flat deployer finish it first"
  fi
  if ! _in "$key" "${CARRY[@]}"; then refuse "$FLAT line $n: unknown key $key"; fi
  # The flat deployer writes DEPLOYED_SHA and PREVIOUS_SHA even when empty: nothing to carry.
  if [ -z "$v" ]; then continue; fi
  case "$key" in
    MAIN_SEEN_S) [[ $v =~ ^(0|[1-9][0-9]{0,17})$ ]] || refuse "$FLAT line $n: $key has a value that is not of its format" ;;
    *) [[ $v =~ ^[0-9a-f]{40}$ ]] || refuse "$FLAT line $n: $key has a value that is not of its format" ;;
  esac
  value[$key]="$v"
done <<< "${content%$'\n'}"
# The first image release (bootstrap) starts from it (spec §8 п.2).
if [ -z "${value[DEPLOYED_SHA]:-}" ]; then
  refuse "$FLAT records no DEPLOYED_SHA — the first image release starts from the commit the flat tree runs"
fi

# --- 3. write image-state.env, then ask the controller ------------------------------------------------
carried=()
text=""
for key in "${CARRY[@]}"; do
  if [ -n "${value[$key]:-}" ]; then
    carried+=("$key=${value[$key]}")
    text+="$key=${value[$key]}"$'\n'
  fi
done
resumed=0
if [ -e "$IMAGE" ] || [ -L "$IMAGE" ]; then
  # Plan п.13: a run killed after it wrote image-state.env left exactly this; anything else is not ours.
  if [ -L "$IMAGE" ] || [ ! -f "$IMAGE" ] || ! existing=$(cat "$IMAGE" && printf x) || [ "${existing%x}" != "$text" ]; then
    refuse "$IMAGE already exists — the state was migrated already, or the image controller wrote it"
  fi
  resumed=1
else
  tmp="$IMAGE.migrate.tmp"
  printf '%s' "$text" > "$tmp"
  sync -- "$tmp"
  mv -f "$tmp" "$IMAGE"
  sync -- "$STATE_DIR"
fi
# The child gets no fd 9: it must not share (or meet) the lock this script holds.
rc=0
verdict=$("$CONTROLLER" --check-state 2>&1 9>&-) || rc=$?
if [ "$rc" -ne 0 ] || [ "$verdict" != "STATE OK — $IMAGE" ]; then
  if [ "$resumed" = 0 ]; then
    rm -f "$IMAGE"
    sync -- "$STATE_DIR"
  fi
  refuse "the controller ($CONTROLLER) does not accept the carried state (exit $rc, want exactly 'STATE OK — $IMAGE'): $verdict"
fi

# --- 4. retire state.env: prepared first, then two renames back to back -------------------------------
mkdir -p "$FLAT.new"
cat > "$FLAT.new/README" <<'README'
This directory stands where the flat deployer's state.env was.

The flat deployer (rsync of the tree into /opt/warsaw-beer-bot) was replaced by the image controller.
Its gate keys were carried into image-state.env (deploy/migrate-state-to-image.sh); the old file is
state.env.flat, next to this directory, for diagnosis only — nothing reads it.

A directory here makes old copies of the flat deploy.sh refuse before their first sudo.
See deploy/README.md in the repository.
README
sync -- "$FLAT.new/README" "$FLAT.new" "$STATE_DIR"
mv "$FLAT" "$FLAT.flat"
mv "$FLAT.new" "$FLAT"
sync -- "$STATE_DIR"

if [ "$resumed" = 1 ]; then
  echo "Finished an interrupted migration: $IMAGE already held exactly the carried keys."
fi
echo "Carried into $IMAGE:"
printf '  %s\n' "${carried[@]}"
echo "$verdict"
echo "Old state: $FLAT.flat (state.env is now a directory with a README)."
echo "Next: sudo bash deploy/install-autodeploy.sh, then bash deploy/deploy.sh --bootstrap (deploy/README.md → Switchover session)."
