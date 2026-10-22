#!/usr/bin/env bash
# One-shot: carries the flat deployer's gate keys from state.env into the image controller's
# image-state.env (spec docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md,
# amendment 4 decision 2, §7.1, §8 п.3; plan docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-core.md
# "Рішення" п.6).
#
# Run by the operator on the host, once, with the timer stopped, AFTER sudo bash deploy/install-autodeploy.sh:
#   bash deploy/migrate-state-to-image.sh
# It validates what it wrote with the INSTALLED controller's --check-state, so the validation is the
# controller's own and is never repeated here.
#
# What it does, in order; any refusal is exit 1 with nothing changed:
#   1. not root; the timer not active; the deploy lock free (held to the end); no image-state.env yet;
#      state.env a regular file, and no state.env.flat yet.
#   2. reads state.env line by line — never sourced, never run. It carries the gate keys whose sense is
#      the same in both controllers (§7.1, "чинні гейтові"); it drops the daily markers and the drift
#      keys (the new controller says its own notices again); any other key, a key twice or a value not
#      of its format is a refusal. A flat window or rollback still in the state is one too: the flat
#      deployer finishes it first.
#   3. writes image-state.env atomically (temporary file, sync, mv, sync of the directory) and asks
#      the controller --check-state; a refusal removes it again.
#   4. only then: state.env → state.env.flat, and a directory state.env/ with a README. Old copies of
#      the flat deploy.sh refuse before their first sudo when state.env is not a regular file (§8 п.3).
#
# Seams (tests): WBB_UID_CMD (default `id -u`), WBB_SYSTEMCTL_CMD (default systemctl),
# WBB_CONTROLLER (default /usr/local/bin/wbb-autodeploy). The state lives where the controller keeps
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
CONTROLLER="${WBB_CONTROLLER:-/usr/local/bin/wbb-autodeploy}"

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
if [ -e "$IMAGE" ] || [ -L "$IMAGE" ]; then
  refuse "$IMAGE already exists — the state was migrated already, or the image controller wrote it"
fi
if [ -L "$FLAT" ] || [ ! -f "$FLAT" ]; then
  refuse "$FLAT is not a regular file — nothing to carry (a directory there means it was migrated already)"
fi
if [ -e "$FLAT.flat" ] || [ -L "$FLAT.flat" ]; then
  refuse "$FLAT.flat already exists — it would be overwritten"
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
tmp="$IMAGE.migrate.tmp"
carried=()
{
  for key in "${CARRY[@]}"; do
    if [ -n "${value[$key]:-}" ]; then
      printf '%s=%s\n' "$key" "${value[$key]}"
      carried+=("$key=${value[$key]}")
    fi
  done
} > "$tmp"
sync -- "$tmp"
mv -f "$tmp" "$IMAGE"
sync -- "$STATE_DIR"
if ! verdict=$("$CONTROLLER" --check-state 2>&1); then
  rm -f "$IMAGE"
  sync -- "$STATE_DIR"
  refuse "the controller ($CONTROLLER) does not accept the carried state: $verdict"
fi

# --- 4. retire state.env -------------------------------------------------------------------------------
mv "$FLAT" "$FLAT.flat"
mkdir "$FLAT"
cat > "$FLAT/README" <<'README'
This directory stands where the flat deployer's state.env was.

The flat deployer (rsync of the tree into /opt/warsaw-beer-bot) was replaced by the image controller.
Its gate keys were carried into image-state.env (deploy/migrate-state-to-image.sh); the old file is
state.env.flat, next to this directory, for diagnosis only — nothing reads it.

A directory here makes old copies of the flat deploy.sh refuse before their first sudo.
See deploy/README.md in the repository.
README
sync -- "$FLAT/README" "$FLAT" "$STATE_DIR"

echo "Carried into $IMAGE:"
printf '  %s\n' "${carried[@]}"
echo "$verdict"
echo "Old state: $FLAT.flat (state.env is now a directory with a README)."
echo "Next: bash deploy/deploy.sh --bootstrap (deploy/README.md → The first image release)."
