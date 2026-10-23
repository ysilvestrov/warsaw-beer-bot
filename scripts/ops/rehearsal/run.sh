#!/usr/bin/env bash
# The rehearsal of the image deploy on this host: the checkout's controller (deploy/autodeploy.sh) and the
# checkout's root helper (through wbb_image_rehearsal.py, as the unit wbb-rehearsal) go through the scenarios
# (а)–(ґ) against the real podman, systemd, GHCR and attestation, on a copy of the production database, and
# everything the kit made is removed again. Production — warsaw-beer-bot, its unit, its Quadlet file, its
# database, its .env — is read, never changed, and what `current` says of it before and after must be equal.
#
# Plan: docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-v-harness.md, "Рішення" п.1–4, Task 2.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md, поправка 4, §6.3, §7.2.
#
#   sudo -v && bash scripts/ops/rehearsal/run.sh <S-sha> <D-sha>
#
# Run as the operator (not root), from a checkout of origin/main, with the deploy timer stopped. S and D are
# commits of main with published images and green CI (`ci` and `image` in one check suite, as the controller's
# own ci_verdict judges it: its manual runs refuse anything else), S an ancestor of D and at or after e480463
# (start-check --leave-running: the helper refuses an older image as a COMPAT target), with different
# wbb.content; the range S..D must hold no migration:contract / rollback:unsafe PR (the controller would refuse
# both directions without --ack-incompatible, and a manual window never rolls back). About an hour: four 600 s
# windows.
#
# The scenarios, in this order (each one stands on the state the previous one left):
#   (а)  --manual bootstrap --target S                          → exit 0, S settled and running
#   (б)  --manual deploy --target D (an auto window)            → exit 0, D settled and running
#   (в)  --manual deploy --target S --force, S's digest "sick"  → exit 2, rolled back: D running and settled
#   (г1) the same, killed before `activate` runs (activating)   → the next tick cancels the window (§7.2 row 1)
#   (г2) the same, killed after `activate`, before `watching`   → the next tick watches a full window (row 3)
#   (г3) --manual deploy --target D, killed while watching      → the next tick goes on with it (row 4)
#   (ґ)  deploy S killed before `activate`, then a unit file of ours is shadowed → the tick opens an INCIDENT
# A scenario that fails stops the run: the later ones would stand on a state nobody expected.
# P3: how long pull, audit and trial took in (а), from the kit's own events around each helper call.
#
# Exit: 0 every scenario PASS, production unchanged and everything removed; 1 anything else (a refusal
# included: then nothing was created); 64 usage; 129 / 130 / 143 hung up / interrupted / terminated (after
# the cleanup).
#
# Seams (tests only; each defaults to the real thing): REHEARSAL_SUDO, REHEARSAL_SYSTEMCTL, REHEARSAL_PODMAN,
# REHEARSAL_CURL, REHEARSAL_DF, REHEARSAL_CLOCK, REHEARSAL_CONTROLLER, REHEARSAL_SHIM, REHEARSAL_GIT_DIR,
# REHEARSAL_ETC, REHEARSAL_PROD_DB, REHEARSAL_CONTAINERS_ROOT, REHEARSAL_EUID, REHEARSAL_POLL_S,
# REHEARSAL_KEEPALIVE_S, REHEARSAL_TERM_GRACE_S, REHEARSAL_CLEANUP_STEP_S, REHEARSAL_PR_LABELS_CMD, REHEARSAL_CHECKS_CMD,
# REHEARSAL_COMPAT_BASE.
#
# Every sudo is `sudo -n`: a ticket that lapsed is a loud failure, never a password prompt from a background
# process group (which would stop it on SIGTTIN and hang the hour).
set -uo pipefail
export LC_ALL=C.UTF-8

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)

SUDO="${REHEARSAL_SUDO:-sudo}"
SYSTEMCTL="${REHEARSAL_SYSTEMCTL:-systemctl}"
PODMAN="${REHEARSAL_PODMAN:-podman}"
CURL="${REHEARSAL_CURL:-curl}"
DF="${REHEARSAL_DF:-df}"
CLOCK="${REHEARSAL_CLOCK:-}"
CONTROLLER="${REHEARSAL_CONTROLLER:-$ROOT/deploy/autodeploy.sh}"
SHIM="${REHEARSAL_SHIM:-$HERE/wbb_image_rehearsal.py}"
GIT_DIR_="${REHEARSAL_GIT_DIR:-$ROOT}"
ETC="${REHEARSAL_ETC:-/etc}"
PROD_DB="${REHEARSAL_PROD_DB:-/var/lib/warsaw-beer-bot/bot.db}"
CONTAINERS_ROOT="${REHEARSAL_CONTAINERS_ROOT:-/var/lib/containers}"
RUN_EUID="${REHEARSAL_EUID:-$EUID}"
POLL_S="${REHEARSAL_POLL_S:-2}"
KEEPALIVE_S="${REHEARSAL_KEEPALIVE_S:-60}"
# How long a TERMed controller gets to go (its helper call ends with it) before the KILL.
TERM_GRACE_S="${REHEARSAL_TERM_GRACE_S:-30}"
# The cleanup ignores INT/TERM/HUP (a second Ctrl-C must not cut it short), so each of its commands has a
# limit of its own: a hung systemctl or podman becomes a CLEANUP FAILED line and the recipe, never a
# rehearsal that only SIGKILL ends (#911 AI review).
CLEANUP_STEP_S="${REHEARSAL_CLEANUP_STEP_S:-180}"
bounded() { timeout --kill-after=10 "$CLEANUP_STEP_S" "$@"; }
PR_LABELS_CMD="${REHEARSAL_PR_LABELS_CMD:-}"
CHECKS_SEAM="${REHEARSAL_CHECKS_CMD:-}"
# The first commit whose start-check knows --leave-running (README → Root helper `wbb-image`): S's image is the
# COMPAT target of (б), and the helper refuses one that predates the flag.
COMPAT_BASE="${REHEARSAL_COMPAT_BASE:-e480463f7437ea538009e30d0fb65e3571cf6889}"
# The operator's own values must not steer a scenario: these are set per scenario, nowhere else.
unset REHEARSAL_SICK_DIGEST REHEARSAL_PAUSE REHEARSAL_EVENTS REHEARSAL_NOTIFY_FILE

# The checkout's controller is the source of its constants, whatever runs as REHEARSAL_CONTROLLER.
CONTROLLER_SRC="$ROOT/deploy/autodeploy.sh"
GH_REPO=$(sed -n 's/^GH_REPO=\([A-Za-z0-9._/-]*\)$/\1/p' "$CONTROLLER_SRC")
STEP_TIMEOUT_GH_S=$(sed -n 's/^STEP_TIMEOUT_GH_S=\([0-9][0-9]*\)\( .*\)\{0,1\}$/\1/p' "$CONTROLLER_SRC")
WINDOW_S=$(sed -n 's/^WINDOW_S=\([0-9][0-9]*\)$/\1/p' "$CONTROLLER_SRC")
HELPER_DIR="$ROOT/deploy/image/helper"
SNAPSHOT_SRC="$ROOT/deploy/db-snapshot.sh"

# The kit's names (the shim's CONTAINER and UNIT; its tests hold them apart from production's).
KIT_UNIT=wbb-rehearsal.service
KIT_CONTAINER=wbb-rehearsal
QUADLET="$ETC/containers/systemd/wbb-rehearsal.container"
UNIT_FILE="$ETC/systemd/system/wbb-rehearsal.service"
# Production's, read only.
PROD_UNIT=warsaw-beer-bot.service
PROD_QUADLET="$ETC/containers/systemd/warsaw-beer-bot.container"
BOT_USER=warsaw-beer-bot

MIN_FREE_KIB=$(( 5 * 1024 * 1024 ))
# How far into the watched window (г3) is killed: past the controller's STARTUP_S (120 s), so the tick that
# goes on with it counts a failed health at once, and far enough from WINDOW_S that a tick which went on with
# the window ends measurably before a full one.
KILL_IN_WATCHING_S=180
ACCEPT='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
# Production's `current`, from the checkout's helper (read only: podman inspect and systemctl show).
PROD_CURRENT_PY='import sys; sys.dont_write_bytecode = True; sys.path.insert(0, sys.argv[1]); import wbb_image; sys.exit(wbb_image.main(["current"]))'

now() { if [ -n "$CLOCK" ]; then "$CLOCK"; else date +%s; fi; }
nap() { sleep "$POLL_S"; }

# What a human runs when the kit was not (or not fully) removed: the same steps as the cleanup.
manual_recipe() {
  printf '  sudo systemctl stop %s\n' "$KIT_UNIT"
  printf '  sudo rm -f %s %s\n' "$QUADLET" "$UNIT_FILE"
  printf '  sudo systemctl daemon-reload\n'
  printf '  sudo systemctl reset-failed %s\n' "$KIT_UNIT"
  printf '  sudo podman rm -f --ignore %s\n' "$KIT_CONTAINER"
  printf '  sudo rm -rf %s\n' "${KIT_ROOT:-/var/lib/wbb-rehearsal}"
}

# --- preconditions: reads only; each refusal leaves nothing behind (п.4) ------------------------------------
refuse() {
  printf 'REFUSED: %s\nNothing was created.\n' "$1" >&2
  exit 1
}
usage() {
  echo "usage: bash scripts/ops/rehearsal/run.sh <S-sha> <D-sha>   (40 hex each; S an ancestor of D on main)" >&2
  exit 64
}
[ "$#" -eq 2 ] || usage
S="$1"
D="$2"
[[ $S =~ ^[0-9a-f]{40}$ && $D =~ ^[0-9a-f]{40}$ ]] || usage
[ -n "$GH_REPO" ] && [ -n "$WINDOW_S" ] && [ -n "$STEP_TIMEOUT_GH_S" ] \
  || refuse "cannot read GH_REPO, WINDOW_S and STEP_TIMEOUT_GH_S from $CONTROLLER_SRC"
# One function of the controller, verbatim: from `name() {` to the first `}` alone on a line (as
# scripts/ops/switchover-preflight.sh reads it).
read_function() { # <file> <name>
  local text
  text=$(awk -v n="$2" '$0 == n "() {" { on = 1 } on { print } on && $0 == "}" { exit }' "$1") || return 1
  case "$text" in *$'\n}') ;; *) return 1 ;; esac
  eval "$text"
}
# The controller's CI read and verdict, as its manual_ci_gate uses them.
read_function "$CONTROLLER_SRC" _checks_default && read_function "$CONTROLLER_SRC" ci_verdict \
  || refuse "cannot read _checks_default and ci_verdict from $CONTROLLER_SRC"
CHECKS_CMD="${CHECKS_SEAM:-_checks_default}"

[ "$RUN_EUID" != 0 ] || refuse "run as the operator, not as root (the controller runs as the operator; sudo is asked for each root step)"
"$SUDO" -n true 2>/dev/null || refuse "no sudo credentials are cached — run sudo -v first"

KIT_ROOT=$(python3 -I "$SHIM" --kit-root) || refuse "cannot read the kit root from $SHIM"
KIT_PORT=$(python3 -I "$SHIM" --kit-port) || refuse "cannot read the kit port from $SHIM"
# It is removed with rm -rf as root at the end: nothing but an absolute .../wbb-rehearsal is accepted.
if ! [[ $KIT_ROOT =~ ^(/[A-Za-z0-9._-]+)+/wbb-rehearsal$ ]] || [[ $KIT_ROOT == *'/..'* ]] || [[ $KIT_ROOT == *'/./'* ]]; then
  refuse "the kit root from the shim is not an absolute path ending in /wbb-rehearsal: $KIT_ROOT"
fi
if ! [[ $KIT_PORT =~ ^[1-9][0-9]{0,4}$ ]] || [ "$KIT_PORT" -gt 65535 ]; then
  refuse "the kit port from the shim is not a port: $KIT_PORT"
fi

if [ -e "$KIT_ROOT" ] || [ -L "$KIT_ROOT" ]; then
  refuse "the kit root $KIT_ROOT exists — a previous rehearsal did not clean up. Look at it, then remove what it left:
$(manual_recipe)"
fi
if [ -e "$PROD_QUADLET" ] || [ -L "$PROD_QUADLET" ]; then
  refuse "production's Quadlet file $PROD_QUADLET exists — the rehearsal is run before the switchover, never after"
fi
for f in "$QUADLET" "$UNIT_FILE"; do
  if [ -e "$f" ] || [ -L "$f" ]; then refuse "$f exists — the rehearsal unit is not ours to replace"; fi
done
unit_show=$("$SYSTEMCTL" show "$KIT_UNIT" -p LoadState,ActiveState 2>/dev/null) \
  || refuse "systemctl show $KIT_UNIT failed"
if [ "$unit_show" != $'LoadState=not-found\nActiveState=inactive' ]; then
  refuse "systemd knows $KIT_UNIT (${unit_show//$'\n'/ }) — it must not exist before the rehearsal"
fi
"$SUDO" -n "$PODMAN" container exists "$KIT_CONTAINER" 2>/dev/null
rc=$?
case "$rc" in
  1) ;;
  0) refuse "a container named $KIT_CONTAINER exists" ;;
  *) refuse "podman container exists $KIT_CONTAINER failed (exit $rc)" ;;
esac
# The deploy timer is stopped for the whole session (runbook step 2): a production tick must not run beside it.
for u in wbb-autodeploy.timer wbb-autodeploy.service; do
  st=$("$SYSTEMCTL" is-active "$u" 2>/dev/null)
  case "$st" in
    inactive|failed) ;;
    '') refuse "systemctl is-active $u said nothing" ;;
    *) refuse "$u is $st — stop it first: sudo systemctl disable --now wbb-autodeploy.timer, and wait for wbb-autodeploy.service" ;;
  esac
done
if timeout 2 bash -c 'exec 3<>"/dev/tcp/127.0.0.1/$1"' _ "$KIT_PORT" 2>/dev/null; then
  refuse "the kit port $KIT_PORT is in use"
fi
for p in "$(dirname "$KIT_ROOT")" "$CONTAINERS_ROOT"; do
  avail=$("$DF" -Pk "$p" 2>/dev/null | awk 'NR == 2 { print $4 }')
  [[ $avail =~ ^[0-9]+$ ]] || refuse "cannot read the free space of $p"
  if [ "$avail" -lt "$MIN_FREE_KIB" ]; then
    refuse "$(( avail / 1024 )) MiB free on $p, the rehearsal needs 5 GiB"
  fi
done

git_() { git -C "$GIT_DIR_" "$@"; }
for c in "$S" "$D"; do
  git_ cat-file -e "${c}^{commit}" 2>/dev/null || refuse "${c:0:12} is not a commit of $GIT_DIR_ (git fetch first)"
done
[ "$S" != "$D" ] || refuse "S and D are the same commit"
git_ merge-base --is-ancestor "$S" "$D" 2>/dev/null || refuse "S ${S:0:12} is not an ancestor of D ${D:0:12}"
git_ merge-base --is-ancestor "$D" origin/main 2>/dev/null || refuse "D ${D:0:12} is not on origin/main (git fetch first)"
git_ cat-file -e "${COMPAT_BASE}^{commit}" 2>/dev/null \
  || refuse "${COMPAT_BASE:0:12} (start-check --leave-running) is not a commit of $GIT_DIR_ (git fetch first)"
git_ merge-base --is-ancestor "$COMPAT_BASE" "$S" 2>/dev/null \
  || refuse "S ${S:0:12} is older than ${COMPAT_BASE:0:12}: its start-check predates --leave-running, and the helper refuses its image as a COMPAT target — pick S at or after ${COMPAT_BASE:0:12}"

# The PRs of S..D, read as the controller reads them (its _pr_labels_default: one line per PR, number<TAB>labels).
# A contract label in the range makes the controller refuse both directions without --ack-incompatible, and with
# it every window is manual — (б)–(ґ) would prove nothing of the automatic rollback.
_pr_labels_default() {
  timeout 60 gh api "repos/${GH_REPO}/commits/$1/pulls" --jq '.[] | "\(.number)\t\(.labels | map(.name) | join(","))"'
}
[ -n "$PR_LABELS_CMD" ] || PR_LABELS_CMD=_pr_labels_default
commits=$(git_ rev-list "${S}..${D}") || refuse "git rev-list ${S:0:12}..${D:0:12} failed"
contract=()
while IFS= read -r c; do
  [ -n "$c" ] || continue
  out=$("$PR_LABELS_CMD" "$c" 2>/dev/null) || refuse "could not read the PR labels of ${c:0:12} (gh api)"
  while IFS=$'\t' read -r pr labels; do
    [ -n "$pr" ] || continue
    for l in rollback:unsafe migration:contract; do
      case ",$labels," in *",$l,"*) contract+=("#$pr $l") ;; esac
    done
  done <<< "$out"
done <<< "$commits"
if [ "${#contract[@]}" -gt 0 ]; then
  refuse "the range ${S:0:12}..${D:0:12} holds $(printf '%s, ' "${contract[@]}" | sed 's/, $//') — the controller deploys it only with --ack-incompatible, in manual windows; pick S and D with no contract PR between them"
fi

# CI on S and D, read and judged by the controller's own functions: every manual run of it (bootstrap S, deploy D,
# deploy S --force) passes manual_ci_gate first, which refuses anything but PASS — an hour into the session.
for c in S D; do
  verdict=$(ci_verdict "${!c}" 2>/dev/null) || refuse "cannot read CI status for $c ${!c:0:12} (gh api failed)"
  case "$verdict" in
    PASS) ;;
    WAIT) refuse "CI has not concluded on $c ${!c:0:12} — the required 'ci' and 'image' checks of one run are pending or absent; the controller would refuse to deploy it" ;;
    FAIL*) refuse "CI failed on $c ${!c:0:12}: ${verdict#FAIL } — the controller would refuse to deploy it; pick another $c" ;;
    *) refuse "the controller's CI verdict for $c ${!c:0:12} is '$verdict'" ;;
  esac
done

# The tag <sha> → digest, as the controller resolves it, and the image's wbb.content from its config —
# all anonymous registry reads; nothing is pulled. Prints "<digest> <content>"; 3 = no such tag.
image_of() {
  local token headers status digest manifest cfg content base="https://ghcr.io/v2/${GH_REPO}"
  token=$("$CURL" -fsS --max-time 20 "https://ghcr.io/token?scope=repository:${GH_REPO}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || return 1
  [ -n "$token" ] || return 1
  headers=$("$CURL" -sS -I --max-time 20 -H "Authorization: Bearer ${token}" -H "Accept: ${ACCEPT}" \
    "${base}/manifests/$1" | tr -d '\r') || return 1
  status=$(awk 'NR == 1 { print $2 }' <<< "$headers")
  case "$status" in
    404) return 3 ;;
    200) ;;
    *) return 1 ;;
  esac
  digest=$(awk 'tolower($1) == "docker-content-digest:" { print $2 }' <<< "$headers")
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  manifest=$("$CURL" -fsS --max-time 20 -H "Authorization: Bearer ${token}" -H "Accept: ${ACCEPT}" \
    "${base}/manifests/${digest}") || return 1
  cfg=$(python3 -I -c 'import json, sys; print(json.load(sys.stdin)["config"]["digest"])' <<< "$manifest" 2>/dev/null) \
    || return 1
  [[ $cfg =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  content=$("$CURL" -fsSL --max-time 60 -H "Authorization: Bearer ${token}" "${base}/blobs/${cfg}" \
    | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["config"]["Labels"]["wbb.content"])' 2>/dev/null) \
    || return 1
  [[ $content =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s %s\n' "$digest" "$content"
}
for c in S D; do
  out=$(image_of "${!c}")
  rc=$?
  case "$rc" in
    0) read -r "DIG_$c" "CONTENT_$c" <<< "$out" ;;
    3) refuse "$c ${!c:0:12} has no published image (no tag ${!c} in ghcr.io/${GH_REPO})" ;;
    *) refuse "could not read the image of $c ${!c:0:12} from ghcr.io (exit $rc)" ;;
  esac
done
if [ "$CONTENT_S" = "$CONTENT_D" ]; then
  refuse "S and D have the same wbb.content ($CONTENT_S): deploying one over the other is a noop and proves nothing"
fi

# Production as `current` and systemd see it: the same text before and after, or the rehearsal FAILS. No MainPID:
# the flat bot restarting on its own during the hour (Restart=, a crash) is not the rehearsal's doing.
prod_fingerprint() {
  local cur unit
  cur=$("$SUDO" -n python3 -I -c "$PROD_CURRENT_PY" "$HELPER_DIR" 2>/dev/null) || return 1
  unit=$("$SYSTEMCTL" show "$PROD_UNIT" -p LoadState,ActiveState,SubState 2>/dev/null) || return 1
  [ -n "$cur" ] && [ -n "$unit" ] || return 1
  printf '%s\n%s\n' "$cur" "$unit"
}
PROD_BEFORE=$(prod_fingerprint) || refuse "could not read what production runs (the helper's current, systemctl show $PROD_UNIT)"

# --- from here on, everything made is undone on the way out (п.3) ------------------------------------------
SCENARIOS=(a b c d1 d2 d3 e)
declare -A TITLE=(
  [a]="(а) bootstrap S"
  [b]="(б) deploy D"
  [c]="(в) a sick candidate (S) is rolled back to D"
  [d1]="(г) killed before the activation: the next tick cancels the window"
  [d2]="(г) killed after the activation, before watching: the next tick watches a full window"
  [d3]="(г) killed while watching: the next tick goes on with the window"
  [e]="(ґ) a unit that is not ours: the next tick opens an incident"
)
declare -A VERDICT=()
CURRENT_SC=""
INTERRUPTED=""
CTL_PID=""
KEEPALIVE_PID=""
CLEANED=0
P3_TEXT=""
P3_EVENTS=""
WORK=""
SETUP_FAILED=""

# Kills a controller run still going: TERM to its process group (sudo passes it on to the helper), then KILL.
stop_controller() {
  local pid="$CTL_PID" waited=0 killer
  [ -n "$pid" ] || return 0
  CTL_PID=""
  if ! kill -TERM -- "-$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null
    return 0
  fi
  # A member stopped (SIGTTIN, SIGTSTP) takes its TERM only once it runs again.
  kill -CONT -- "-$pid" 2>/dev/null
  # The leader is reaped here (a zombie would keep its group alive); a leader that ignores TERM gets the KILL.
  set -m
  ( sleep "$TERM_GRACE_S"; kill -KILL -- "-$pid" ) </dev/null >/dev/null 2>&1 &
  killer=$!
  set +m
  wait "$pid" 2>/dev/null
  # What is left of its group (sudo and the helper it passed the TERM to) gets the same grace.
  while kill -0 -- "-$pid" 2>/dev/null && [ "$waited" -lt "$TERM_GRACE_S" ]; do
    sleep 1
    waited=$(( waited + 1 ))
  done
  kill -KILL -- "-$pid" 2>/dev/null
  kill -KILL -- "-$killer" 2>/dev/null
  wait "$killer" 2>/dev/null
}

# The controller bounds its own calls with `timeout`, and timeout makes each one a process group of its own: the
# group kill above misses them — the snapshot under `timeout sudo -u warsaw-beer-bot … db-snapshot.sh`, a git
# clone into the work directory. Whatever still names the kit root or the work directory in its argv is the
# kit's: TERM (and CONT), the same grace, then KILL — as root, since some of it runs as the bot.
# A pkill -f regex for a path that never matches the argv of the pkill (or of its sudo) that carries it.
argv_pattern() {
  local p="$1"
  printf '[%s]%s' "${p:0:1}" "$(printf '%s' "${p:1}" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
}
# A pgrep that found nothing says 1. Any other answer — found (0), refused, or cut at its limit (124) — is
# not proof that nothing is left, so the cleanup goes on as if something were (#911 AI review).
stray_left() { # <pattern>
  bounded "$SUDO" -n pgrep -f -- "$1" >/dev/null 2>&1
  [ "$?" != 1 ]
}
kill_strays() {
  local pats=() p waited=0 left
  if [ -n "$KIT_ROOT" ]; then pats+=("$(argv_pattern "$KIT_ROOT")"); fi
  if [ -n "$WORK" ]; then pats+=("$(argv_pattern "$WORK")"); fi
  for p in "${pats[@]}"; do
    bounded "$SUDO" -n pkill -TERM -f -- "$p" 2>/dev/null
    bounded "$SUDO" -n pkill -CONT -f -- "$p" 2>/dev/null
  done
  while :; do
    left=0
    for p in "${pats[@]}"; do
      if stray_left "$p"; then left=1; fi
    done
    [ "$left" = 1 ] && [ "$waited" -lt "$TERM_GRACE_S" ] || break
    sleep 1
    waited=$(( waited + 1 ))
  done
  [ "$left" = 1 ] || return 0
  for p in "${pats[@]}"; do bounded "$SUDO" -n pkill -KILL -f -- "$p" 2>/dev/null; done
  sleep 1
  for p in "${pats[@]}"; do
    if stray_left "$p"; then return 1; fi
  done
}

CLEANUP_PROBLEMS=()
cleanup_failed() { # <what> <the command a human runs instead>
  CLEANUP_PROBLEMS+=("$1")
  echo "CLEANUP FAILED: $1 — $2"
}
cleanup() {
  local rc
  [ "$CLEANED" = 0 ] || return 0
  CLEANED=1
  stop_controller
  # The events are in the work directory, which goes below.
  P3_TEXT="$(p3_line pull; p3_line audit; p3_line trial)"$'\n'
  if [ -n "$KEEPALIVE_PID" ]; then kill -KILL -- "-$KEEPALIVE_PID" 2>/dev/null; wait "$KEEPALIVE_PID" 2>/dev/null; fi
  echo "==> cleanup"
  bounded "$SUDO" -n "$SYSTEMCTL" stop "$KIT_UNIT" 2>/dev/null
  rc=$?
  # 5: the unit is not loaded — nothing to stop.
  if [ "$rc" != 0 ] && [ "$rc" != 5 ]; then cleanup_failed "systemctl stop $KIT_UNIT (exit $rc)" "sudo systemctl stop $KIT_UNIT"; fi
  kill_strays || cleanup_failed "processes naming $KIT_ROOT or $WORK survived the KILL" "sudo pgrep -af $KIT_ROOT; sudo pgrep -af $WORK"
  bounded "$SUDO" -n rm -f "$QUADLET" "$UNIT_FILE" || cleanup_failed "rm -f $QUADLET $UNIT_FILE" "sudo rm -f $QUADLET $UNIT_FILE"
  bounded "$SUDO" -n "$SYSTEMCTL" daemon-reload || cleanup_failed "systemctl daemon-reload" "sudo systemctl daemon-reload"
  bounded "$SUDO" -n "$SYSTEMCTL" reset-failed "$KIT_UNIT" 2>/dev/null
  bounded "$SUDO" -n "$PODMAN" rm -f --ignore "$KIT_CONTAINER" >/dev/null \
    || cleanup_failed "podman rm -f $KIT_CONTAINER" "sudo podman rm -f --ignore $KIT_CONTAINER"
  bounded "$SUDO" -n rm -rf "$KIT_ROOT" || cleanup_failed "rm -rf $KIT_ROOT" "sudo rm -rf $KIT_ROOT"
  if [ -n "$WORK" ]; then bounded rm -rf "$WORK" || cleanup_failed "rm -rf $WORK" "rm -rf $WORK"; fi
  # What is left is checked, not assumed. The images S and D are not the kit's: the settles' prune already
  # removed all but the last settled one, and the next prune of production removes that.
  for f in "$QUADLET" "$UNIT_FILE" "$KIT_ROOT"; do
    if [ -e "$f" ] || [ -L "$f" ]; then cleanup_failed "$f is still there" "sudo rm -rf $f"; fi
  done
  bounded "$SUDO" -n "$PODMAN" container exists "$KIT_CONTAINER" 2>/dev/null
  if [ "$?" != 1 ]; then
    cleanup_failed "the container $KIT_CONTAINER is still there (or podman could not say)" "sudo podman rm -f --ignore $KIT_CONTAINER"
  fi
  if [ "$(bounded "$SYSTEMCTL" show "$KIT_UNIT" -p LoadState,ActiveState 2>/dev/null)" != $'LoadState=not-found\nActiveState=inactive' ]; then
    cleanup_failed "systemd still knows $KIT_UNIT" "sudo systemctl stop $KIT_UNIT; sudo systemctl daemon-reload; sudo systemctl reset-failed $KIT_UNIT"
  fi
  if [ "${#CLEANUP_PROBLEMS[@]}" -gt 0 ]; then
    echo "CLEANUP FAILED — what the cleanup does, to run by hand:"
    manual_recipe
  fi
}

p3_line() { # <verb>: its duration in (а), from the first start/end pair of the kit's events
  local verb="$1" f="$P3_EVENTS" t0 t1
  t0=$(awk -v v="$verb" '$2 == "start" && $3 == v { print $1; exit }' "$f" 2>/dev/null)
  t1=$(awk -v v="$verb" '$2 == "end" && $3 == v { print $1; exit }' "$f" 2>/dev/null)
  if [[ $t0 =~ ^[0-9]+$ && $t1 =~ ^[0-9]+$ ]]; then
    printf 'P3 %s: %ss\n' "$verb" "$(( t1 - t0 ))"
  else
    printf 'P3 %s: not measured\n' "$verb"
  fi
}

summary() {
  local sc v pass=0 total=0 ok=1 prod_after
  if [ -n "$INTERRUPTED" ] && [ -n "$CURRENT_SC" ] && [ -z "${VERDICT[$CURRENT_SC]:-}" ]; then
    VERDICT[$CURRENT_SC]="FAIL — interrupted (SIG$INTERRUPTED)"
  fi
  prod_after=$(prod_fingerprint) || prod_after=""
  echo "=== rehearsal summary ==="
  echo "S=$S D=$D"
  if [ -n "$SETUP_FAILED" ]; then
    echo "FAIL  setup — $SETUP_FAILED"
    ok=0
  fi
  for sc in "${SCENARIOS[@]}"; do
    v="${VERDICT[$sc]:-SKIP — not run}"
    total=$(( total + 1 ))
    case "$v" in
      PASS) pass=$(( pass + 1 )); printf 'PASS  %s\n' "${TITLE[$sc]}" ;;
      *) ok=0; printf '%s  %s — %s\n' "${v%% — *}" "${TITLE[$sc]}" "${v#* — }" ;;
    esac
  done
  total=$(( total + 2 ))
  if [ "${#CLEANUP_PROBLEMS[@]}" = 0 ]; then
    pass=$(( pass + 1 ))
    echo "PASS  cleanup"
  else
    ok=0
    echo "FAIL  cleanup — $(IFS=';'; printf '%s' "${CLEANUP_PROBLEMS[*]}" | sed 's/;/; /g')"
  fi
  if [ -z "$prod_after" ]; then
    ok=0
    echo "FAIL  production unchanged — could not read production after the rehearsal"
    echo "!!! COULD NOT READ PRODUCTION AFTER THE REHEARSAL — look at $PROD_UNIT now !!!"
    echo "before:"
    sed 's/^/  /' <<< "$PROD_BEFORE"
  elif [ "$prod_after" = "$PROD_BEFORE" ]; then
    pass=$(( pass + 1 ))
    echo "PASS  production unchanged"
  else
    ok=0
    echo "FAIL  production unchanged — PRODUCTION CHANGED"
    echo "!!! PRODUCTION CHANGED DURING THE REHEARSAL — look at $PROD_UNIT now !!!"
    echo "before:"
    sed 's/^/  /' <<< "$PROD_BEFORE"
    echo "after:"
    sed 's/^/  /' <<< "$prod_after"
  fi
  printf '%s' "$P3_TEXT"
  if [ -n "$INTERRUPTED" ]; then
    echo "RESULT: FAIL — interrupted by SIG$INTERRUPTED ($pass/$total)"
  elif [ "$ok" = 1 ]; then
    echo "RESULT: PASS ($pass/$total)"
  else
    echo "RESULT: FAIL ($pass/$total)"
  fi
  [ "$ok" = 1 ] && [ -z "$INTERRUPTED" ]
}

on_exit() {
  local code=1
  # A second Ctrl-C must not cut the cleanup short.
  trap - EXIT
  trap '' INT TERM HUP
  cleanup
  if summary; then code=0; fi
  case "$INTERRUPTED" in HUP) code=129 ;; INT) code=130 ;; TERM) code=143 ;; esac
  exit "$code"
}
on_signal() {
  INTERRUPTED="$1"
  exit 1
}

echo "==> the rehearsal takes about an hour: run it inside tmux or screen — a dropped SSH session hangs it up,"
echo "    and it then only cleans up and fails"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wbb-rehearsal.XXXXXX") || refuse "mktemp -d failed"
trap on_exit EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP
P3_EVENTS="$WORK/events-a"

# One ticket-refreshing loop for the hour: the controller's sudo calls must never meet a password prompt.
# It looks every second whether run.sh is still there, so even a run.sh killed with -9 leaves no loop behind.
RUN_PID=$$
set -m
(
  n=0
  while sleep 1; do
    kill -0 "$RUN_PID" 2>/dev/null || exit 0
    n=$(( n + 1 ))
    if [ "$n" -ge "$KEEPALIVE_S" ]; then
      n=0
      "$SUDO" -n -v 2>/dev/null
    fi
  done
) </dev/null >/dev/null 2>&1 &
KEEPALIVE_PID=$!
set +m

# --- setup (п.1) ---------------------------------------------------------------------------------------------
setup() {
  local bin="$WORK/bin" q
  echo "==> setup: $KIT_ROOT, a copy of $PROD_DB, the controller's state in $WORK"
  "$SUDO" -n install -d -m 0755 -o root -g root "$KIT_ROOT" "$KIT_ROOT/bin" || return 1
  "$SUDO" -n install -d -m 0700 -o root -g root "$KIT_ROOT/scratch" || return 1
  "$SUDO" -n install -d -m 0750 -o "$BOT_USER" -g "$BOT_USER" "$KIT_ROOT/data" "$KIT_ROOT/data/deploy-snapshots" || return 1
  # The bot cannot read the operator's checkout: the snapshot script runs from a root-owned copy in the kit.
  "$SUDO" -n install -m 0755 -o root -g root "$SNAPSHOT_SRC" "$KIT_ROOT/bin/db-snapshot.sh" || return 1
  "$SUDO" -n -u "$BOT_USER" bash -lc '"$0" "$@"' "$KIT_ROOT/bin/db-snapshot.sh" snapshot "$PROD_DB" "$KIT_ROOT/data/bot.db" \
    >/dev/null || return 1

  mkdir -p "$bin" "$WORK/state/wbb-autodeploy" "$WORK/data" "$WORK/tmp" "$WORK/logs" || return 1
  # WBB_IMAGE_CMD: the shim under sudo (the operator's ticket, no NOPASSWD rule), one event line around each
  # call (P3), and a pause before or after one verb where a scenario kills the run.
  {
    echo '#!/usr/bin/env bash'
    echo '# The rehearsal kit'"'"'s WBB_IMAGE_CMD, written by scripts/ops/rehearsal/run.sh.'
    printf 'SUDO=%q\nSHIM=%q\nCLOCK=%q\nPAUSED=%q\nOUT=%q\nLAPSED=%q\n' "$SUDO" "$SHIM" "$CLOCK" "$WORK/paused" "$WORK/tmp" \
      "$WORK/sudo-lapsed"
    cat <<'WRAPPER'
set -u
verb="${1:-}"
now() { if [ -n "$CLOCK" ]; then "$CLOCK"; else date +%s; fi; }
printf '%s start %s\n' "$(now)" "$verb" >> "$REHEARSAL_EVENTS"
if [ "${REHEARSAL_PAUSE:-}" = "before-$verb" ]; then
  printf 'before-%s\n' "$verb" > "$PAUSED"
  exec sleep 86400
fi
cmd=("$SUDO" -n)
# sudo resets the environment: the sick digest goes on its command line, and only when a scenario set it.
if [ -n "${REHEARSAL_SICK_DIGEST:-}" ]; then cmd+=("REHEARSAL_SICK_DIGEST=$REHEARSAL_SICK_DIGEST"); fi
cmd+=(python3 -I "$SHIM" "$@")
# No `timeout` around it, unlike the controller's own default: timeout makes itself a process group of its own,
# and the group kill of a scenario would then miss the helper. A hung call is the human's Ctrl-C.
out=$(mktemp "$OUT/helper.XXXXXX")
err=$(mktemp "$OUT/helper.XXXXXX")
"${cmd[@]}" > "$out" 2> "$err"
rc=$?
printf '%s end %s %s\n' "$(now)" "$verb" "$rc" >> "$REHEARSAL_EVENTS"
# sudo -n refused for want of a ticket: the scenario FAILs with that reason, not as a verdict of the controller's.
if [ "$rc" != 0 ] && grep -q 'a password is required' "$err"; then : > "$LAPSED"; fi
if [ "${REHEARSAL_PAUSE:-}" = "after-$verb" ]; then
  printf 'after-%s\n' "$verb" > "$PAUSED"
  exec sleep 86400
fi
cat "$out"
cat "$err" >&2
rm -f "$out" "$err"
exit "$rc"
WRAPPER
  } > "$bin/wbb-image" || return 1
  q=$(printf '%q' "$SYSTEMCTL")
  printf '#!/usr/bin/env bash\nexec %s show -p NRestarts --value %s\n' "$q" "$KIT_UNIT" > "$bin/restarts" || return 1
  printf '#!/usr/bin/env bash\nexec %s show %s -p ActiveState,SubState,MainPID\n' "$q" "$KIT_UNIT" > "$bin/unit-state" || return 1
  printf '#!/usr/bin/env bash\necho %s\n' "$KIT_PORT" > "$bin/api-port" || return 1
  # Nothing reaches Telegram: every message goes to the scenario's file.
  printf '#!/usr/bin/env bash\nprintf '"'"'%%s\\n---\\n'"'"' "$1" >> "$REHEARSAL_NOTIFY_FILE"\n' > "$bin/notify" || return 1
  # Production's .env is never read: the seams above replace everything that would read it.
  printf '#!/usr/bin/env bash\nexit 1\n' > "$bin/read-env" || return 1
  chmod 0755 "$bin"/* || return 1

  # The state the first image release starts from (stage «в» carries DEPLOYED_SHA over from state.env).
  printf 'DEPLOYED_SHA=%s\nLAST_SEEN_DEPLOYED_SHA=%s\n' "$S" "$S" > "$WORK/state/wbb-autodeploy/image-state.env" || return 1
  CTL_ENV=(
    XDG_STATE_HOME="$WORK/state" XDG_DATA_HOME="$WORK/data" TMPDIR="$WORK/tmp"
    WBB_IMAGE_CMD="$bin/wbb-image" WBB_RESTARTS_CMD="$bin/restarts" WBB_UNIT_STATE_CMD="$bin/unit-state"
    WBB_API_PORT_CMD="$bin/api-port" WBB_NOTIFY_CMD="$bin/notify" WBB_READ_ENV_CMD="$bin/read-env"
    WBB_INSTALLED_CHECK=
    WBB_DB_PATH="$KIT_ROOT/data/bot.db" WBB_SNAPSHOT_DIR="$KIT_ROOT/data/deploy-snapshots"
    WBB_SNAPSHOT_BIN="$KIT_ROOT/bin/db-snapshot.sh"
  )
  # No other WBB_* of the operator's environment reaches the controller.
  CTL_UNSET=()
  local v
  for v in $(compgen -e); do
    case "$v" in WBB_*) CTL_UNSET+=(-u "$v") ;; esac
  done
  if ! env "${CTL_UNSET[@]}" "${CTL_ENV[@]}" "$CONTROLLER" --check-state >/dev/null 2>&1; then
    echo "the controller does not accept the seeded state" >&2
    return 1
  fi
}
STATE_FILE="$WORK/state/wbb-autodeploy/image-state.env"
state_get() { sed -n "s/^$1=//p" "$STATE_FILE" 2>/dev/null; }

# --- one controller run ---------------------------------------------------------------------------------------
# In its own process group (job control for this one fork) so that a kill reaches all of it, on the operator's
# terminal session so that sudo finds the ticket. Its output goes to $WORK/logs/<run>.log.
ctl_start() { # <run> <pause|""> <sick digest|""> [controller arguments]
  local run="$1" pause="$2" sick="$3"
  shift 3
  CTL_RUN="$run"
  rm -f "$WORK/paused"
  : > "$WORK/notify-$run"
  echo "==> $run: autodeploy.sh $*${pause:+ (pause $pause)}${sick:+ (sick $sick)}"
  set -m
  env "${CTL_UNSET[@]}" "${CTL_ENV[@]}" REHEARSAL_EVENTS="$WORK/events-$run" REHEARSAL_NOTIFY_FILE="$WORK/notify-$run" \
    REHEARSAL_PAUSE="$pause" REHEARSAL_SICK_DIGEST="$sick" \
    "$CONTROLLER" "$@" </dev/null >"$WORK/logs/$run.log" 2>&1 &
  CTL_PID=$!
  set +m
}
ctl_wait() {
  wait "$CTL_PID"
  CTL_RC=$?
  CTL_PID=""
}
# The controller as it stands at the pause: killed. 0 paused and killed; 1 it ended first (CTL_RC).
ctl_kill_at_pause() {
  while [ ! -e "$WORK/paused" ]; do
    if ! kill -0 "$CTL_PID" 2>/dev/null; then ctl_wait; return 1; fi
    nap
  done
  ctl_kill
}
ctl_kill() {
  kill -KILL -- "-$CTL_PID" 2>/dev/null
  wait "$CTL_PID" 2>/dev/null
  CTL_PID=""
}

# --- verdicts ----------------------------------------------------------------------------------------------------
WHY=()
check() { # <what> <actual> <expected>
  if [ "$2" != "$3" ]; then WHY+=("$1: expected ${3:-(empty)}, got ${2:-(empty)}"); fi
}
# What the kit's unit runs, as the helper and systemd say: "<quadlet> <container digest> <unit> <Active>/<Sub>".
kit_facts() {
  local cur kind q i d u act sub line
  cur=$("$SUDO" -n python3 -I "$SHIM" current 2>/dev/null) || { echo "current-failed"; return 0; }
  read -r kind q i d u <<< "$cur"
  while IFS= read -r line; do
    case "$line" in ActiveState=*) act="${line#*=}" ;; SubState=*) sub="${line#*=}" ;; esac
  done <<< "$("$SYSTEMCTL" show "$KIT_UNIT" -p ActiveState,SubState 2>/dev/null)"
  printf '%s %s %s %s/%s\n' "${q#quadlet=}" "${d#container-digest=}" "${u#unit=}" "${act:-?}" "${sub:-?}"
}
runs() { printf '%s %s quadlet active/running' "$1" "$1"; }
settled_on() { # <sha> <digest>: the state after a settled (or rolled back to) deployment of it
  check "DEPLOYED_SHA" "$(state_get DEPLOYED_SHA)" "$1"
  check "SETTLED_SHA" "$(state_get SETTLED_SHA)" "$1"
  check "SETTLED_DIGEST" "$(state_get SETTLED_DIGEST)" "$2"
  check "WINDOW_PHASE" "$(state_get WINDOW_PHASE)" ""
  check "INCIDENT" "$(state_get INCIDENT)" ""
  check "what runs" "$(kit_facts)" "$(runs "$2")"
}
count() { # <file> <fixed text>: how many lines carry it
  grep -cF -- "$2" "$1" 2>/dev/null
}
verdict() {
  if [ -e "$WORK/sudo-lapsed" ]; then
    WHY+=("the sudo ticket lapsed (sudo -n refused a helper call) — run sudo -v and the rehearsal again")
  fi
  if [ "${#WHY[@]}" = 0 ]; then
    VERDICT[$CURRENT_SC]=PASS
  else
    VERDICT[$CURRENT_SC]="FAIL — $(printf '%s; ' "${WHY[@]}" | sed 's/; $//')"
    echo "--- $CURRENT_SC failed; the end of the controller's output (${CTL_RUN}):"
    tail -n 30 "$WORK/logs/$CTL_RUN.log" 2>/dev/null
  fi
}

# --- the scenarios (п.2) ----------------------------------------------------------------------------------------
sc_a() {
  ctl_start a "" "" --manual bootstrap --target "$S"
  ctl_wait
  check exit "$CTL_RC" 0
  settled_on "$S" "$DIG_S"
}
sc_b() {
  ctl_start b "" "" --manual deploy --target "$D"
  ctl_wait
  check exit "$CTL_RC" 0
  settled_on "$D" "$DIG_D"
  check "the settled notice" "$(count "$WORK/notify-b" "is live and settled")" 1
}
sc_c() {
  ctl_start c "" "$DIG_S" --manual deploy --target "$S" --force
  ctl_wait
  check exit "$CTL_RC" 2
  settled_on "$D" "$DIG_D"
  # The controller records a failed X only when X is main's head (window_failed, is_main_head); S, an
  # ancestor of D, never is.
  check "LAST_FAILED_SHA" "$(state_get LAST_FAILED_SHA)" ""
  check "the rollback notice" "$(count "$WORK/notify-c" "ROLLED BACK ${S:0:7} → ${D:0:7}")" 1
}
sc_d1() {
  ctl_start d1 before-activate "" --manual deploy --target "$S" --force
  if ! ctl_kill_at_pause; then
    check "the run reached activate" "exited $CTL_RC" "paused"
    return 0
  fi
  check "WINDOW_PHASE at the kill" "$(state_get WINDOW_PHASE)" activating
  check "what runs at the kill" "$(kit_facts)" "$(runs "$DIG_D")"
  # A run that was not where the scenario needs it proves nothing more: no tick on top of it.
  [ "${#WHY[@]}" = 0 ] || return 0
  ctl_start d1-tick "" ""
  ctl_wait
  check "the tick's exit" "$CTL_RC" 0
  settled_on "$D" "$DIG_D"
  check "LAST_FAILED_SHA" "$(state_get LAST_FAILED_SHA)" ""
}
sc_d2() {
  local t0 t1
  ctl_start d2 after-activate "" --manual deploy --target "$S" --force
  if ! ctl_kill_at_pause; then
    check "the run reached activate" "exited $CTL_RC" "paused"
    return 0
  fi
  check "WINDOW_PHASE at the kill" "$(state_get WINDOW_PHASE)" activating
  check "what runs at the kill" "$(kit_facts)" "$(runs "$DIG_S")"
  # A run that was not where the scenario needs it proves nothing more: no tick on top of it.
  [ "${#WHY[@]}" = 0 ] || return 0
  t0=$(now)
  ctl_start d2-tick "" ""
  ctl_wait
  t1=$(now)
  check "the tick's exit" "$CTL_RC" 0
  settled_on "$S" "$DIG_S"
  check "a full window from now (the tick took >= ${WINDOW_S}s)" "$([ $(( t1 - t0 )) -ge "$WINDOW_S" ] && echo yes || echo "no: $(( t1 - t0 ))s")" yes
  check "the settled notice" "$(count "$WORK/notify-d2-tick" "is live and settled")" 1
}
sc_d3() {
  local start t0 t1
  ctl_start d3 "" "" --manual deploy --target "$D"
  while :; do
    if ! kill -0 "$CTL_PID" 2>/dev/null; then
      ctl_wait
      check "the run reached watching" "exited $CTL_RC" "killed while watching"
      return 0
    fi
    start=$(state_get WINDOW_START)
    if [ "$(state_get WINDOW_PHASE)" = watching ] && [[ $start =~ ^[0-9]+$ ]] \
       && [ $(( $(now) - start )) -ge "$KILL_IN_WATCHING_S" ]; then
      break
    fi
    nap
  done
  ctl_kill
  check "what runs at the kill" "$(kit_facts)" "$(runs "$DIG_D")"
  # A run that was not where the scenario needs it proves nothing more: no tick on top of it.
  [ "${#WHY[@]}" = 0 ] || return 0
  t0=$(now)
  ctl_start d3-tick "" ""
  ctl_wait
  t1=$(now)
  check "the tick's exit" "$CTL_RC" 0
  settled_on "$D" "$DIG_D"
  check "the window went on (the tick took < ${WINDOW_S}s)" "$([ $(( t1 - t0 )) -lt "$WINDOW_S" ] && echo yes || echo "no: $(( t1 - t0 ))s")" yes
  check "a new window" "$(count "$WORK/notify-d3-tick" "the window lost its evidence")" 0
  check "the settled notice" "$(count "$WORK/notify-d3-tick" "is live and settled")" 1
}
sc_e() {
  local incident
  ctl_start e before-activate "" --manual deploy --target "$S" --force
  if ! ctl_kill_at_pause; then
    check "the run reached activate" "exited $CTL_RC" "paused"
    return 0
  fi
  check "WINDOW_PHASE at the kill" "$(state_get WINDOW_PHASE)" activating
  # A run that was not where the scenario needs it proves nothing more: no tick on top of it.
  [ "${#WHY[@]}" = 0 ] || return 0
  # A unit file in /etc/systemd/system shadows the one Quadlet generates: not our unit any more.
  printf '[Unit]\nDescription=rehearsal (scenario ґ): a unit that is not the Quadlet one\n\n[Service]\nExecStart=/bin/sleep infinity\n' \
    | "$SUDO" -n tee "$UNIT_FILE" >/dev/null
  "$SUDO" -n "$SYSTEMCTL" daemon-reload
  check "what current says of the unit" "$(kit_facts | awk '{ print $3 }')" foreign
  ctl_start e-tick "" ""
  ctl_wait
  check "the tick's exit" "$CTL_RC" 3
  incident=$(state_get INCIDENT)
  check "INCIDENT" "$(case "$incident" in "$S $DIG_S "*"(unit=foreign)"*) echo "open, unit=foreign" ;; *) echo "$incident" ;; esac)" "open, unit=foreign"
  "$SUDO" -n rm -f "$UNIT_FILE"
  "$SUDO" -n "$SYSTEMCTL" daemon-reload
}

if ! setup; then
  SETUP_FAILED="the kit could not be set up (see above)"
  exit 1
fi
for sc in "${SCENARIOS[@]}"; do
  # Nothing of the previous scenario's run is left running when the next one starts.
  stop_controller
  rm -f "$WORK/paused"
  CURRENT_SC="$sc"
  WHY=()
  CTL_RUN="$sc"
  "sc_$sc"
  verdict
  [ "${VERDICT[$sc]}" = PASS ] || break
done
CURRENT_SC=""
exit 0
