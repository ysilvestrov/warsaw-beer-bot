#!/usr/bin/env bash
# The read-only check before the switchover session of stage «в»: is the host where the runbook
# (deploy/README.md → Switchover session (stage «в»)) expects it, step 4, before the rehearsal?
#
# Plan: docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md, "Рішення" п.4, п.6, Task 4.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §7.4, §8 п.2–5.
#
#   sudo -v && bash scripts/ops/switchover-preflight.sh
#
# Run as the operator (not root) from the checkout the session deploys. It changes nothing: no state, no
# lock, no unit, no git ref (origin's head is read with `git ls-remote`, not fetched). Root reads go through
# `sudo -n` on the ticket of `sudo -v`: without a ticket it refuses before any check.
#
# Every check runs, independent of the others, and prints one line:
#   PASS      <check> — what was found
#   FAIL      <check> — what was found, and what to do
#   EXPECTED  <check> — the one state that is not PASS and still right before step 7: the installed helper
#             predates the checkout's (core decision 15, `reset-failed` in activate), and step 7 reinstalls it
# then the summary `RESULT: PASS|FAIL (<n> PASS, <n> EXPECTED, <n> FAIL)`.
#
# What it reuses rather than repeats: the migration's key lists (deploy/migrate-state-to-image.sh) for the flat
# state.env; the controller's own resolve and attestation calls (deploy/autodeploy.sh, _resolve_default and
# _attest_default, taken from the file as they are); install-image.sh --check as it is; the kit root from the
# rehearsal shim; the rehearsal's names and its precondition texts.
#
# Seams (tests only; each defaults to the real thing): PREFLIGHT_SUDO, PREFLIGHT_SYSTEMCTL, PREFLIGHT_DF,
# PREFLIGHT_PODMAN, PREFLIGHT_EUID, PREFLIGHT_GIT_DIR, PREFLIGHT_ETC, PREFLIGHT_CONTAINERS_ROOT,
# PREFLIGHT_INSTALL_IMAGE, PREFLIGHT_SHIM, PREFLIGHT_CHECKOUT_ROOTS (space-separated). `gh` and `curl` are
# taken from PATH, as the controller's functions call them.
#
# Exit: 0 every check PASS or EXPECTED; 1 a FAIL, or a refusal before the checks; 64 usage.
set -uo pipefail
export LC_ALL=C.UTF-8

if [ "$#" -ne 0 ]; then
  echo "usage: sudo -v && bash scripts/ops/switchover-preflight.sh   (no arguments)" >&2
  exit 64
fi

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

SUDO="${PREFLIGHT_SUDO:-sudo}"
SYSTEMCTL="${PREFLIGHT_SYSTEMCTL:-systemctl}"
DF="${PREFLIGHT_DF:-df}"
PODMAN="${PREFLIGHT_PODMAN:-podman}"
RUN_EUID="${PREFLIGHT_EUID:-$EUID}"
GIT_DIR_="${PREFLIGHT_GIT_DIR:-$ROOT}"
ETC="${PREFLIGHT_ETC:-/etc}"
CONTAINERS_ROOT="${PREFLIGHT_CONTAINERS_ROOT:-/var/lib/containers}"
INSTALL_IMAGE="${PREFLIGHT_INSTALL_IMAGE:-$ROOT/deploy/install-image.sh}"
SHIM="${PREFLIGHT_SHIM:-$ROOT/scripts/ops/rehearsal/wbb_image_rehearsal.py}"
read -r -a CHECKOUT_ROOTS <<< "${PREFLIGHT_CHECKOUT_ROOTS:-$HOME /root}"

CONTROLLER_SRC="$ROOT/deploy/autodeploy.sh"
MIGRATE_SRC="$ROOT/deploy/migrate-state-to-image.sh"
# Where the old (flat) controller and the new one keep the state and the lock: the same directory.
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
FLAT="$STATE_DIR/state.env"
IMAGE_STATE="$STATE_DIR/image-state.env"
LOCK="$STATE_DIR/lock"
PROD_QUADLET="$ETC/containers/systemd/warsaw-beer-bot.container"
# The rehearsal kit's names (scripts/ops/rehearsal/run.sh).
KIT_UNIT=wbb-rehearsal.service
KIT_CONTAINER=wbb-rehearsal
KIT_QUADLET="$ETC/containers/systemd/wbb-rehearsal.container"
KIT_UNIT_FILE="$ETC/systemd/system/wbb-rehearsal.service"
MIN_FREE_KIB=$(( 5 * 1024 * 1024 ))
# install-image.sh --check of a helper that only predates the checkout (core decision 15): exactly this.
STALE_HELPER=$'DIFFERS: /usr/local/lib/wbb-image/wbb_image.py (content)\n1 difference(s): sudo bash deploy/install-image.sh'

refuse() {
  printf 'REFUSED: %s\nNo check was run.\n' "$1" >&2
  exit 1
}
[ "$RUN_EUID" != 0 ] || refuse "run as the operator, not as root: the deploy state is the operator's (~/.local/state/wbb-autodeploy)"
"$SUDO" -n true 2>/dev/null || refuse "no sudo credentials are cached — run sudo -v first (the checks read root-only files through sudo -n)"

N_PASS=0
N_EXPECTED=0
N_FAIL=0
pass() { printf 'PASS      %s — %s\n' "$1" "$2"; N_PASS=$(( N_PASS + 1 )); }
fail() { printf 'FAIL      %s — %s\n' "$1" "$2"; N_FAIL=$(( N_FAIL + 1 )); }
expected() { printf 'EXPECTED  %s — %s\n' "$1" "$2"; N_EXPECTED=$(( N_EXPECTED + 1 )); }
git_() { git --no-optional-locks -C "$GIT_DIR_" "$@"; }
_in() { # <word> <list…>
  local w="$1" e
  shift
  for e in "$@"; do
    if [ "$e" = "$w" ]; then return 0; fi
  done
  return 1
}
# One array of another script, as that script declares it (NAME=(…), on one or more lines).
read_array() { # <file> <name>
  local text
  text=$(awk -v n="$2" 'index($0, n "=(") == 1 { on = 1 } on { print } on && /\)/ { exit }' "$1") || return 1
  [ -n "$text" ] || return 1
  eval "$text"
}
# One function of another script, verbatim: from `name() {` to the first `}` alone on a line.
read_function() { # <file> <name>
  local text
  text=$(awk -v n="$2" '$0 == n "() {" { on = 1 } on { print } on && $0 == "}" { exit }' "$1") || return 1
  case "$text" in *$'\n}') ;; *) return 1 ;; esac
  eval "$text"
}
# One NAME=value constant of the controller (a trailing comment dropped).
read_const() { # <name>
  sed -n "s/^$1=\\([A-Za-z0-9._/-]*\\)\\( .*\\)\\{0,1\\}\$/\\1/p" "$CONTROLLER_SRC" | head -n 1
}

echo "=== switchover preflight: $GIT_DIR_ ==="

# --- 1. the deploy timer and its service are stopped, the timer disabled (runbook step 2) ----------------------
enabled=$("$SYSTEMCTL" is-enabled wbb-autodeploy.timer 2>/dev/null)
active=$("$SYSTEMCTL" is-active wbb-autodeploy.timer 2>/dev/null)
case "$active" in inactive|failed) a_ok=1 ;; *) a_ok=0 ;; esac
if [ "$enabled" = disabled ] && [ "$a_ok" = 1 ]; then
  pass timer "wbb-autodeploy.timer is disabled and $active"
else
  fail timer "wbb-autodeploy.timer is ${enabled:-?} and ${active:-?} — sudo systemctl disable --now wbb-autodeploy.timer"
fi
svc=$("$SYSTEMCTL" is-active wbb-autodeploy.service 2>/dev/null)
case "$svc" in
  inactive|failed) pass service "wbb-autodeploy.service is $svc" ;;
  *) fail service "wbb-autodeploy.service is ${svc:-?} — a tick is running; wait until it ends (systemctl status wbb-autodeploy.service)" ;;
esac

# --- 2. the deploy lock is free: opened read-only, never created ----------------------------------------------
if [ ! -e "$LOCK" ]; then
  pass lock "no lock file at $LOCK"
elif ! exec {lockfd}<"$LOCK"; then
  fail lock "$LOCK cannot be opened for reading"
elif flock -n "$lockfd"; then
  flock -u "$lockfd"
  exec {lockfd}<&-
  pass lock "$LOCK is free"
else
  exec {lockfd}<&-
  fail lock "$LOCK is held (a tick or a deploy.sh) — fuser -v $LOCK; wait until it is free"
fi

# --- 3. the flat state.env, as the migration (step 6) will read it ---------------------------------------------
# The key lists are the migration's own; the rules are its rules (line by line, never sourced).
deployed=""
state_check() {
  local CARRY=() DROP=() UNFINISHED=() content line key v n=0 seen=" "
  read_array "$MIGRATE_SRC" CARRY && read_array "$MIGRATE_SRC" DROP && read_array "$MIGRATE_SRC" UNFINISHED \
    || { echo "cannot read the key lists of $MIGRATE_SRC"; return 1; }
  if [ -L "$FLAT" ] || [ ! -f "$FLAT" ]; then
    echo "$FLAT is not a regular file (a directory there means the migration ran already)"; return 1
  fi
  content=$(cat "$FLAT" && printf x) || { echo "$FLAT cannot be read"; return 1; }
  content="${content%x}"
  [ -n "$content" ] || { echo "$FLAT is empty"; return 1; }
  [ "${content: -1}" = $'\n' ] || { echo "$FLAT: the last line has no newline (a truncated file)"; return 1; }
  tr -d '\000' < "$FLAT" | cmp -s - "$FLAT" || { echo "$FLAT holds a NUL byte"; return 1; }
  while IFS= read -r line; do
    n=$(( n + 1 ))
    [[ $line =~ ^([A-Z_]+)=(.*)$ ]] || { echo "$FLAT line $n is not KEY=value"; return 1; }
    key="${BASH_REMATCH[1]}"
    v="${BASH_REMATCH[2]}"
    case "$seen" in *" $key "*) echo "$FLAT line $n: duplicate key $key"; return 1 ;; esac
    seen+="$key "
    if _in "$key" "${DROP[@]}"; then continue; fi
    if _in "$key" "${UNFINISHED[@]}"; then
      echo "$FLAT line $n: $key — a flat deploy window or rollback is unfinished; let the flat deployer finish it first (sudo systemctl enable --now wbb-autodeploy.timer until the window is gone, then step 2 again)"
      return 1
    fi
    _in "$key" "${CARRY[@]}" || { echo "$FLAT line $n: unknown key $key"; return 1; }
    [ -n "$v" ] || continue
    case "$key" in
      MAIN_SEEN_S) [[ $v =~ ^(0|[1-9][0-9]{0,17})$ ]] || { echo "$FLAT line $n: $key has a value that is not of its format"; return 1; } ;;
      *) [[ $v =~ ^[0-9a-f]{40}$ ]] || { echo "$FLAT line $n: $key has a value that is not of its format"; return 1; } ;;
    esac
    if [ "$key" = DEPLOYED_SHA ]; then deployed="$v"; fi
  done <<< "${content%$'\n'}"
  echo "$FLAT is a regular file the migration accepts, with no flat window or rollback"
}
why=$(state_check) && st_rc=0 || st_rc=$?
if [ "$st_rc" = 0 ]; then
  pass state "$why"
  # state_check ran in a subshell: DEPLOYED_SHA is read again, by the same rule, from the file it accepted.
  deployed=$(sed -n 's/^DEPLOYED_SHA=\([0-9a-f]\{40\}\)$/\1/p' "$FLAT")
else
  fail state "$why — the migration (step 6) would refuse"
fi

# --- 4. origin/main's head: read, not fetched ------------------------------------------------------------------
main=$(timeout 60 git -C "$GIT_DIR_" ls-remote origin refs/heads/main 2>/dev/null | awk '$2 == "refs/heads/main" { print $1 }')
[[ $main =~ ^[0-9a-f]{40}$ ]] || main=""
head=$(git_ rev-parse --verify -q 'HEAD^{commit}' 2>/dev/null) || head=""

# --- 5. DEPLOYED_SHA is there and on main (the bootstrap starts from it) ---------------------------------------
if [ "$st_rc" != 0 ]; then
  fail deployed "no DEPLOYED_SHA read: the state check failed"
elif [ -z "$deployed" ]; then
  fail deployed "$FLAT records no DEPLOYED_SHA — the first image release starts from the commit the flat tree runs"
elif [ -z "$main" ]; then
  fail deployed "cannot read origin's main (git ls-remote origin main) — nothing to compare DEPLOYED_SHA ${deployed:0:12} with"
elif ! git_ cat-file -e "${main}^{commit}" 2>/dev/null; then
  fail deployed "origin's main ${main:0:12} is not in this checkout — git pull, then run this again"
elif ! git_ merge-base --is-ancestor "$deployed" "$main" 2>/dev/null; then
  fail deployed "DEPLOYED_SHA ${deployed:0:12} is not an ancestor of origin/main ${main:0:12} (or not in this checkout)"
else
  pass deployed "DEPLOYED_SHA ${deployed:0:12} is an ancestor of origin/main ${main:0:12}"
fi

# --- 6. the image controller's state does not exist yet ---------------------------------------------------------
if [ -e "$IMAGE_STATE" ] || [ -L "$IMAGE_STATE" ]; then
  fail image-state "$IMAGE_STATE exists — the migration refuses a different one; find out who wrote it (deploy/README.md → Migrating the flat deployer's state)"
else
  pass image-state "no $IMAGE_STATE"
fi

# --- 7. the root helper: current, or exactly the one difference step 7 reinstalls ------------------------------
helper=$("$SUDO" -n bash "$INSTALL_IMAGE" --check 2>&1) && h_rc=0 || h_rc=$?
if [ "$h_rc" = 0 ]; then
  pass helper "$(tail -n 1 <<< "$helper")"
elif [ "$h_rc" = 1 ] && [ "$helper" = "$STALE_HELPER" ]; then
  expected helper "the installed wbb_image.py predates this checkout's; step 7 reinstalls it (sudo bash deploy/install-image.sh)"
else
  fail helper "sudo bash deploy/install-image.sh --check (exit $h_rc): $(tr '\n' ';' <<< "$helper" | sed 's/;$//; s/;/; /g')"
fi

# --- 8. gh knows the flags the controller's attestation passes ---------------------------------------------------
help=$(timeout 30 gh attestation verify --help 2>&1) || help=""
missing=()
for f in --source-digest --deny-self-hosted-runners; do
  grep -q -- "$f" <<< "$help" || missing+=("$f")
done
if [ "${#missing[@]}" = 0 ]; then
  pass gh "gh attestation verify knows --source-digest and --deny-self-hosted-runners"
else
  fail gh "gh attestation verify --help has no ${missing[*]} — upgrade gh"
fi

# --- 9. the checkout is clean and at origin/main's head ----------------------------------------------------------
dirty=$(git_ status --porcelain 2>&1) && g_rc=0 || g_rc=$?
if [ "$g_rc" != 0 ]; then
  fail checkout "git status failed in $GIT_DIR_: $dirty"
elif [ -n "$dirty" ]; then
  fail checkout "$GIT_DIR_ is not clean (git status --porcelain: $(head -n 3 <<< "$dirty" | tr '\n' ' ')) — install-image.sh refuses it"
elif [ -z "$main" ]; then
  fail checkout "cannot read origin's main (git ls-remote origin main)"
elif [ "$head" != "$main" ]; then
  fail checkout "HEAD ${head:0:12} is not origin/main ${main:0:12} — git switch main && git pull"
else
  pass checkout "clean, HEAD = origin/main ${main:0:12}"
fi

# --- 10. HEAD has a published image that passes the controller's own attestation --------------------------------
image_check() {
  local GH_REPO IMAGE_REPOSITORY STEP_TIMEOUT_RESOLVE_S STEP_TIMEOUT_ATTEST_S d rc out
  GH_REPO=$(read_const GH_REPO)
  IMAGE_REPOSITORY=$(read_const IMAGE_REPOSITORY)
  STEP_TIMEOUT_RESOLVE_S=$(read_const STEP_TIMEOUT_RESOLVE_S)
  STEP_TIMEOUT_ATTEST_S=$(read_const STEP_TIMEOUT_ATTEST_S)
  if [ -z "$GH_REPO" ] || [ -z "$IMAGE_REPOSITORY" ] || [ -z "$STEP_TIMEOUT_RESOLVE_S" ] || [ -z "$STEP_TIMEOUT_ATTEST_S" ] \
    || ! read_function "$CONTROLLER_SRC" _resolve_default || ! read_function "$CONTROLLER_SRC" _attest_default; then
    echo "cannot read the resolve and attestation calls of $CONTROLLER_SRC"; return 1
  fi
  [ -n "$head" ] || { echo "no HEAD in $GIT_DIR_"; return 1; }
  d=$(_resolve_default "$head" 2>/dev/null) && rc=0 || rc=$?
  case "$rc" in
    0) ;;
    3) echo "no image is published for HEAD ${head:0:12} (no tag $head in $IMAGE_REPOSITORY) — wait for CI's image job"; return 1 ;;
    *) echo "could not resolve the image of HEAD ${head:0:12} (exit $rc)"; return 1 ;;
  esac
  [[ $d =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "the tag $head resolved to '$d', not a digest"; return 1; }
  out=$(_attest_default "$d" "$head" 2>&1) && rc=0 || rc=$?
  if [ "$rc" != 0 ]; then
    echo "the image of HEAD ${head:0:12} ($d) does not pass the controller's attestation (exit $rc): $(tail -n 2 <<< "$out" | tr '\n' ' ')"
    return 1
  fi
  echo "HEAD ${head:0:12} → $d, attested (the controller's gh attestation verify)"
}
why=$(image_check) && pass image "$why" || fail image "$why"

# --- 11. production's Quadlet file does not exist: activate writes it at the bootstrap --------------------------
if [ -e "$PROD_QUADLET" ] || [ -L "$PROD_QUADLET" ]; then
  fail quadlet "$PROD_QUADLET exists — the bootstrap requires that it does not (deploy/README.md → The first image release)"
else
  pass quadlet "no $PROD_QUADLET"
fi

# --- 12. free space where the images and the rehearsal kit go -----------------------------------------------------
KIT_ROOT=$(python3 -I -B "$SHIM" --kit-root 2>/dev/null) || KIT_ROOT=""
if ! [[ $KIT_ROOT =~ ^(/[A-Za-z0-9._-]+)+/wbb-rehearsal$ ]] || [[ $KIT_ROOT == *'/..'* ]] || [[ $KIT_ROOT == *'/./'* ]]; then
  KIT_ROOT=""
fi
space=()
space_ok=1
for p in "$CONTAINERS_ROOT" "${KIT_ROOT:+$(dirname "$KIT_ROOT")}"; do
  [ -n "$p" ] || continue
  avail=$("$DF" -Pk "$p" 2>/dev/null | awk 'NR == 2 { print $4 }')
  if ! [[ $avail =~ ^[0-9]+$ ]]; then
    space+=("$p: cannot read"); space_ok=0
  elif [ "$avail" -lt "$MIN_FREE_KIB" ]; then
    space+=("$p: $(( avail / 1024 )) MiB, need 5 GiB"); space_ok=0
  else
    space+=("$p: $(( avail / 1024 / 1024 )) GiB")
  fi
done
if [ "$space_ok" = 1 ]; then
  pass space "$(printf '%s, ' "${space[@]}" | sed 's/, $//')"
else
  fail space "$(printf '%s, ' "${space[@]}" | sed 's/, $//')"
fi

# --- 13. no old checkout whose flat deploy.sh lacks the state.env guard (spec §8 п.3, V15) ----------------------
# A flat deploy.sh rsyncs the tree to /opt and reinstalls the old unit over the Quadlet one. Versions from #767 on
# read state.env with `[ ! -f "$STATE" ]` and refuse once the migration made it a directory; older ones do not.
# Searched as root (copies live in /root too); node_modules and caches skipped.
# shellcheck disable=SC2016  # the script runs under sudo, its variables are its own
FIND_OLD='for r in "$@"; do
  [ -d "$r" ] || continue
  find "$r" -xdev \( -name node_modules -o -name .git -o -name .cache -o -name .npm \) -prune -o -type f -path "*/deploy/deploy.sh" -print 2>/dev/null
done | sort -u | while IFS= read -r f; do
  grep -q rsync "$f" 2>/dev/null || continue
  if grep -qF "[ ! -f \"\$STATE\" ]" "$f"; then echo "protected $f"; else echo "unprotected $f"; fi
done'
old=$("$SUDO" -n bash -c "$FIND_OLD" _ "${CHECKOUT_ROOTS[@]}" 2>/dev/null) && o_rc=0 || o_rc=$?
unprotected=$(sed -n 's/^unprotected \(.*\)\/deploy\/deploy\.sh$/\1/p' <<< "$old")
protected=$(sed -n 's/^protected \(.*\)\/deploy\/deploy\.sh$/\1/p' <<< "$old")
if [ "$o_rc" != 0 ]; then
  fail old-checkouts "the search in ${CHECKOUT_ROOTS[*]} failed (exit $o_rc)"
elif [ -n "$unprotected" ]; then
  fail old-checkouts "a flat deploy.sh without the state.env guard in: $(tr '\n' ' ' <<< "$unprotected")— update (git pull) or remove each before the bootstrap"
else
  pass old-checkouts "none unprotected in ${CHECKOUT_ROOTS[*]}${protected:+ (with the guard: $(tr '\n' ' ' <<< "$protected" | sed 's/ $//'))}"
fi

# --- 14. nothing of a rehearsal is left (scripts/ops/rehearsal/run.sh, its preconditions) ------------------------
left=()
if [ -z "$KIT_ROOT" ]; then
  left+=("cannot read the kit root from $SHIM")
elif [ -e "$KIT_ROOT" ] || [ -L "$KIT_ROOT" ]; then
  left+=("$KIT_ROOT")
fi
for f in "$KIT_QUADLET" "$KIT_UNIT_FILE"; do
  if [ -e "$f" ] || [ -L "$f" ]; then left+=("$f"); fi
done
unit_show=$("$SYSTEMCTL" show "$KIT_UNIT" -p LoadState,ActiveState 2>/dev/null) || unit_show="(systemctl show failed)"
if [ "$unit_show" != $'LoadState=not-found\nActiveState=inactive' ]; then
  left+=("the unit $KIT_UNIT (${unit_show//$'\n'/ })")
fi
"$SUDO" -n "$PODMAN" container exists "$KIT_CONTAINER" 2>/dev/null
case "$?" in
  1) ;;
  0) left+=("the container $KIT_CONTAINER") ;;
  *) left+=("podman container exists $KIT_CONTAINER failed") ;;
esac
if [ "${#left[@]}" = 0 ]; then
  pass rehearsal "nothing of wbb-rehearsal is left (kit root, Quadlet file, unit, container)"
else
  fail rehearsal "left over: $(printf '%s; ' "${left[@]}" | sed 's/; $//') — remove it as the rehearsal's cleanup does (deploy/README.md → Switchover session, step 5)"
fi

# --- the summary ---------------------------------------------------------------------------------------------------
counts="$N_PASS PASS, $N_EXPECTED EXPECTED, $N_FAIL FAIL"
if [ "$N_FAIL" = 0 ]; then
  echo "RESULT: PASS ($counts)"
  exit 0
fi
echo "RESULT: FAIL ($counts)"
exit 1
