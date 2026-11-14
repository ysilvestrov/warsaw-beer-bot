#!/usr/bin/env bash
# The human's manual entry into the image controller (spec
# docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §7.4; plan
# docs/superpowers/plans/2026-10/2026-10-22-wbb-image-transition-b2-harness.md, "Рішення" п.1–4).
#
# A thin wrapper: it checks the checkout and execs the INSTALLED controller with `--manual …`. It is
# run from a checkout and installed nowhere (so it is no hold path). Stage «в» moved it here from
# deploy/image/, together with the controller (deploy/autodeploy.sh, its sibling). The
# installed copy (/usr/local/bin/wbb-autodeploy) is put there by deploy/install-autodeploy.sh; until
# a human runs that installer on the host, it is still the old flat deployer, so this refuses every
# time — by design (owner's decision №8).
#
#   deploy.sh [--force] [--ack-incompatible]   → --manual deploy --target <HEAD> [--force] [--ack-incompatible]
#   deploy.sh --bootstrap                      → --manual bootstrap --target <HEAD>
#   deploy.sh --resolve-incident --settled <sha> → --manual resolve-incident --settled <sha>
#   deploy.sh --resolve-incident --flat        → --manual resolve-incident --flat
#
# The final grammar is the controller's; this only never passes what it would reject.
# No lock and no state: both belong to the controller. A second lock here, with another timeout,
# would give two different refusals for the same fact (plan п.3).
#
# Seams (tests): WBB_INSTALLED_CONTROLLER (default /usr/local/bin/wbb-autodeploy), WBB_UID_CMD
# (default `id -u`). Nothing else from outside, besides git.
#
# Exit: 64 usage; 1 a refusal here; otherwise the controller's own code (exec).
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: bash deploy/deploy.sh [--force] [--ack-incompatible]   deploy HEAD of this checkout
       bash deploy/deploy.sh --bootstrap                         the first image release, of HEAD
       bash deploy/deploy.sh --resolve-incident --settled <sha>  close an incident: the image <sha> was restored
       bash deploy/deploy.sh --resolve-incident --flat           close an incident: the old unit and the flat tree are back
USAGE
  exit 64
}

# --- the grammar (plan п.1): parsed before anything is checked ---------------------------------------
BOOTSTRAP=0
RESOLVE=0
FORCE=0
ACK_INCOMPATIBLE=0
FLAT=0
SETTLED=""
_seen=" "
while [ "$#" -gt 0 ]; do
  # Each flag once: the controller rejects a repeat, so it is rejected here first.
  case "$_seen" in *" $1 "*) usage ;; esac
  _seen+="$1 "
  case "$1" in
    --bootstrap) BOOTSTRAP=1; shift ;;
    --resolve-incident) RESOLVE=1; shift ;;
    --force) FORCE=1; shift ;;
    --ack-incompatible) ACK_INCOMPATIBLE=1; shift ;;
    --flat) FLAT=1; shift ;;
    --settled)
      # A full commit SHA as git prints it, as the controller requires.
      [ "$#" -ge 2 ] && [[ $2 =~ ^[0-9a-f]{40}$ ]] || usage
      SETTLED="$2"
      shift 2 ;;
    *) usage ;;
  esac
done
unset _seen
if [ "$RESOLVE" = 1 ]; then
  # Exactly one of the two ways out of an incident, and nothing of a deploy.
  [ "$BOOTSTRAP$FORCE$ACK_INCOMPATIBLE" = 000 ] || usage
  { [ -n "$SETTLED" ] && [ "$FLAT" = 0 ]; } || { [ -z "$SETTLED" ] && [ "$FLAT" = 1 ]; } || usage
  CMD=resolve-incident
else
  [ -z "$SETTLED" ] && [ "$FLAT" = 0 ] || usage
  if [ "$BOOTSTRAP" = 1 ]; then
    [ "$FORCE$ACK_INCOMPATIBLE" = 00 ] || usage
    CMD=bootstrap
  else
    CMD=deploy
  fi
fi

# --- 1. not root -------------------------------------------------------------------------------------
# The controller keeps its state and lock under the operator's $HOME and calls sudo per step; as root
# HOME=/root — another state, another lock, and the timer's run would not exclude this one.
# shellcheck disable=SC2086  # a command with its arguments, split on purpose
if ! _uid=$(${WBB_UID_CMD:-id -u}) || [ "$_uid" = 0 ]; then
  echo "ERROR: run deploy.sh as the operator (bash deploy/deploy.sh), not as root or via sudo: the controller keeps its state and lock in the operator's \$HOME and calls sudo itself, per step." >&2
  exit 1
fi

# --- 2. the checkout this file lives in (not the cwd) ------------------------------------------------
HERE=$(cd "$(dirname "$0")" && pwd)
if ! TOP=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null); then
  echo "ERROR: $HERE is not inside a git checkout — run deploy.sh from a checkout of the repo (bash deploy/deploy.sh)." >&2
  exit 1
fi

# --- 3. deploy and bootstrap: the target is HEAD, and HEAD is on main ------------------------------
# The human deploys what they see: a clean tree at HEAD, and HEAD merged into main. The controller
# repeats the main check against its own clone; this one tells the human before anything starts.
# resolve-incident names its target (--settled) or the controller finds it (--flat): no check here.
ARGS=(--manual "$CMD")
if [ "$CMD" != resolve-incident ]; then
  if ! _dirty=$(git -C "$TOP" status --porcelain --untracked-files=no) || [ -n "$_dirty" ]; then
    printf 'ERROR: %s has tracked changes — the target is HEAD, and the tree is not HEAD. Commit or stash them:\n%s\n' "$TOP" "$_dirty" >&2
    exit 1
  fi
  if ! timeout 120 git -C "$TOP" fetch -q origin main; then
    echo "ERROR: cannot fetch origin main — without it, nothing proves HEAD is on main. Refusing." >&2
    exit 1
  fi
  HEAD_SHA=$(git -C "$TOP" rev-parse --verify 'HEAD^{commit}')
  if ! git -C "$TOP" merge-base --is-ancestor "$HEAD_SHA" refs/remotes/origin/main; then
    echo "ERROR: HEAD ($HEAD_SHA) is not on origin/main — only what was merged into main is deployed. Check out a commit of main (git switch main && git pull) and run this again." >&2
    exit 1
  fi
  ARGS+=(--target "$HEAD_SHA")
  if [ "$FORCE" = 1 ]; then ARGS+=(--force); fi
  if [ "$ACK_INCOMPATIBLE" = 1 ]; then ARGS+=(--ack-incompatible); fi
elif [ -n "$SETTLED" ]; then
  ARGS+=(--settled "$SETTLED")
else
  ARGS+=(--flat)
fi

# --- 4. the installed controller IS this checkout's controller (spec §14: manual = the timer's code) -
INSTALLED=${WBB_INSTALLED_CONTROLLER:-/usr/local/bin/wbb-autodeploy}
OURS="$HERE/autodeploy.sh"
_what=""
if [ ! -f "$INSTALLED" ]; then
  _what="does not exist, so it is not"
elif ! cmp -s "$INSTALLED" "$OURS"; then
  _what="differs from"
fi
if [ -n "$_what" ]; then
  echo "ERROR: the installed controller $INSTALLED $_what this checkout's $OURS. A manual run must execute the controller the timer runs, so nothing is started. Until the switchover session the installed copy is the old flat deployer and this always refuses; follow deploy/README.md → Switchover session (stage «в»), not the installer alone." >&2
  exit 1
fi

# --- 5. hand over: the exit code is the controller's -------------------------------------------------
exec "$INSTALLED" "${ARGS[@]}"
