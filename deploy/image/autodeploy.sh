#!/usr/bin/env bash
# Merge-deploy for the OCI image — the host deploys the head of origin/main by itself, as an image.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §4, §5, §7.
# Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md ("Рішення" 1–18);
#       docs/superpowers/plans/2026-10/2026-10-21-wbb-image-transition-b2-core.md (the manual mode,
#       cited as "plan b2 п.N").
#
# Stage «б»: this file is installed NOWHERE. The timer still runs the installed copy of
# deploy/autodeploy.sh (the flat tree); stage «в» moves this file over it (`git mv`). Until then
# it lives here, so a merge of it switches nothing (plan "Рішення" п.1).
#
# The rule is the old one: production runs what was merged into main, after CI passed on THAT
# commit (`ci` AND `image`, from one check suite), unless a hold says a human must be present.
# What runs is an image: the tag <sha> resolves to a digest D, `gh attestation verify` proves CI
# built D from X on main, and the root helper wbb-image pulls it, checks it and runs it. A
# candidate whose wbb.content equals the deployed one changes nothing that runs (spec §4.1):
# it is recorded as deployed (noop) without a restart.
#
# The same file is the human's manual entry (spec §7.4): `--manual deploy --target <sha>` deploys X
# through the same state, gates (minus the ones a human's presence releases) and window, in the
# foreground; a run that is interrupted is finished by the next tick from the state.
#
# Runs as the operator user (ysi). Root steps go through `sudo -n wbb-image <verb>`, one sudoers
# rule per verb. Git runs in a private clone, only for the gates — nothing is checked out.
#
# State: $STATE_DIR/image-state.env, parsed line by line against an allowlist and VALIDATED
# before anything acts on it (plan п.3); a damaged file is STATE CORRUPT (exit 3), never a fresh
# start. state.env (the flat deployer's) is neither read nor written. The lock is shared with
# the flat deployer and deploy.sh, so they exclude each other.
#
# Exit (plan п.16): 0 idle / wait / hold / noop / settled, 1 refused, 2 rolled back (code only),
#       3 incident opened or state corrupt, 4 state write failed, 64 usage. A manual run uses the
#       same codes; every refusal, a busy lock and an open window included, is 1 (plan b2 п.6).
set -euo pipefail
# notify() cuts messages by CHARACTERS. Under systemd's default C locale bash counts bytes and
# can cut a UTF-8 character in half, which Telegram rejects.
export LC_ALL=C.UTF-8

# --- the entry (plan 2026-10-21 b2-core "Рішення" п.1) -------------------------------------------
# No arguments: the timer's tick, as it always was. `--manual …`: a human's run, through the same
# state, gates and window (spec §7.4). The target is given, never guessed: the controller does not
# know the human's checkout, its wrapper (deploy.sh) passes HEAD. Anything else is 64, before
# anything is read or written.
# Assigned here, never taken from the environment: a stray MANUAL=1 must not make a tick manual.
MANUAL=0
MANUAL_CMD=""
TARGET=""
SETTLED_ARG=""
# Plan b2 п.28: resolve-incident --flat — the old unit and the flat tree are back, nothing is settled.
FLAT=0
FORCE=0
ACK_INCOMPATIBLE=0
# The mode of the window a deploy opens (spec §7.1): the tick's is always auto.
DEPLOY_MODE=auto
usage() {
  cat >&2 <<'USAGE'
usage: autodeploy.sh                     (no arguments: the timer's tick)
       autodeploy.sh --manual deploy --target <sha> [--force] [--ack-incompatible]
       autodeploy.sh --manual bootstrap --target <sha>
       autodeploy.sh --manual resolve-incident --settled <sha>
       autodeploy.sh --manual resolve-incident --flat
USAGE
  exit 64
}
# A full commit SHA as git prints it: 40 hex, lower case.
_is_sha() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }
if [ "$#" -gt 0 ]; then
  [ "$1" = --manual ] && [ "$#" -ge 2 ] || usage
  MANUAL=1
  MANUAL_CMD="$2"
  shift 2
  case "$MANUAL_CMD" in deploy|bootstrap|resolve-incident) ;; *) usage ;; esac
  _seen=" "
  while [ "$#" -gt 0 ]; do
    # Each option once, and only where its subcommand takes it.
    case "$_seen" in *" $1 "*) usage ;; esac
    _seen+="$1 "
    case "$MANUAL_CMD:$1" in
      deploy:--target|bootstrap:--target)
        [ "$#" -ge 2 ] && _is_sha "$2" || usage
        TARGET="$2"
        shift 2 ;;
      resolve-incident:--settled)
        [ "$#" -ge 2 ] && _is_sha "$2" || usage
        SETTLED_ARG="$2"
        shift 2 ;;
      resolve-incident:--flat) FLAT=1; shift ;;
      deploy:--force) FORCE=1; shift ;;
      deploy:--ack-incompatible) ACK_INCOMPATIBLE=1; shift ;;
      *) usage ;;
    esac
  done
  unset _seen
  case "$MANUAL_CMD" in
    deploy|bootstrap) [ -n "$TARGET" ] || usage ;;
    # Exactly one of the two ways out of an incident.
    resolve-incident) { [ -n "$SETTLED_ARG" ] && [ "$FLAT" = 0 ]; } || { [ -z "$SETTLED_ARG" ] && [ "$FLAT" = 1 ]; } || usage ;;
  esac
  # Plan b2 п.9: --ack-incompatible gives up the automatic rollback, needed or not — the human
  # said a code-only rollback is not to be trusted.
  if [ "$ACK_INCOMPATIBLE" = 1 ]; then DEPLOY_MODE=manual; fi
fi

REPO_URL=https://github.com/ysilvestrov/warsaw-beer-bot.git
GH_REPO=ysilvestrov/warsaw-beer-bot
IMAGE_REPOSITORY=ghcr.io/ysilvestrov/warsaw-beer-bot
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
REPO="$DATA_DIR/repo"
STATE="$STATE_DIR/image-state.env"
LOCK="$STATE_DIR/lock"
# STATE CORRUPT cannot record its once-a-day marker in the state it cannot trust.
CORRUPT_NOTICE="$STATE_DIR/image-state-corrupt-notice"
NOTIFY_LIMIT=3500
QUIET_S=600
CI_STUCK_S=3600
# --- timeouts and the tick's budget (plan п.17) ------------------------------------------ BEGIN
# Every external call is bounded by `timeout` (or curl --max-time) with ONE of these; a timeout is
# "could not verify", never a verdict. A test checks that each is used by the code it bounds and
# that WORST_PATH_S, the worst tick built from them below, stays under TICK_BUDGET_S.
STEP_TIMEOUT_GIT_S=120          # git clone, git fetch (each)
STEP_TIMEOUT_GH_S=60            # gh api: check runs, PR labels (each call)
STEP_TIMEOUT_SCAN_S=240         # the PR labels of the whole range (no call starts after it)
STEP_TIMEOUT_INSTALLED_S=30     # installed-current.sh
STEP_TIMEOUT_RESOLVE_S=40       # token + HEAD, 2 × 20
STEP_TIMEOUT_ATTEST_S=120
STEP_TIMEOUT_PULL_S=660         # the helper: pull 600 + inspect 60
STEP_TIMEOUT_LOCAL_S=60         # the helper: inspect
STEP_TIMEOUT_CURRENT_S=90       # the helper: inspect 60 + systemctl 30
STEP_TIMEOUT_AUDIT_S=300        # the helper
STEP_TIMEOUT_TRIAL_S=900        # the helper: 180 + 150 + 150 + 3 × rm 60 + 2 × inspect 60 + the copy
STEP_TIMEOUT_ACTIVATE_S=240     # the helper: daemon-reload 60 + restart 180
STEP_TIMEOUT_PRUNE_IMAGES_S=300 # the helper: podman images + rmi
STEP_TIMEOUT_READ_ENV_S=30      # sudo -u bot read-env.sh (API_PORT, the notifier's token and chat)
STEP_TIMEOUT_SNAPSHOT_S=300     # VACUUM INTO
STEP_TIMEOUT_SNAPSHOT_OP_S=60   # db-snapshot.sh mark-rollback / discard / prune
STEP_TIMEOUT_NOTIFY_S=10        # the Telegram POST
STEP_TIMEOUT_SEAM_S=5           # one probe: /health, systemctl show
STEP_TIMEOUT_STARTUP_S=120      # ACTIVATED → /health answers X with the unit running
# The window (spec §7, plan п.11).
WINDOW_S=600
POLL_S=10
# This long without one fully read poll (current, NRestarts, the unit state) is a failed window:
# it must never hang in `watching` forever.
OBSERVE_MAX_S=300
# Plan п.13: at most two `activate S` per rollback, this far apart after a 75.
ROLLBACK_ATTEMPTS_MAX=2
ROLLBACK_RETRY_S=30
# A tick retries at most this many failed marks (each a db-snapshot.sh call), the rest the next.
PENDING_MARK_MAX_PER_TICK=2
# A settled resolve returns at most this many retained pres (each a db-snapshot.sh call) to ordinary
# retention; the rest stay retained and its notice names them. 5 × STEP_TIMEOUT_SNAPSHOT_OP_S on a
# resolve tick, which runs no pull, audit, trial, activation or rollback, is far inside WORST_PATH_S.
UNMARK_MAX_PER_RUN=5
# The worst tick, every call at the edge of its bound (plan п.17), from the loops as they are:
# - a poll is health + NRestarts + the unit state + `current`; the window settles on the first
#   clean poll at t >= WINDOW_S, or fails OBSERVE_MAX_S after the last fully read one: the last
#   poll before that, the sleep, and one more poll;
# - a rollback attempt is the fact (`current`, the unit, health) — waited for up to STARTUP_S while
#   unreadable — then `activate S`, then up to STARTUP_S for S, then the retry sleep; two attempts
#   and the last fact;
# - three messages (failed, rolled back or incident, one lost-evidence notice);
# - the check runs (one call), and the PR labels of the range: no call starts after SCAN, and the
#   last one started may run its GH;
# - the pending-mark retries at the tick's start;
# - the failed path (rollback) is the longer one: a settled tick runs the image and snapshot prunes
#   (PRUNE_IMAGES + SNAPSHOT_OP) instead of the rollback.
POLL_WORST_S=$(( 3 * STEP_TIMEOUT_SEAM_S + STEP_TIMEOUT_CURRENT_S ))
FACT_WORST_S=$(( 2 * STEP_TIMEOUT_SEAM_S + STEP_TIMEOUT_CURRENT_S ))
CHECK_WORST_S=$(( STEP_TIMEOUT_STARTUP_S + POLL_S + FACT_WORST_S ))
WINDOW_WORST_S=$(( WINDOW_S + OBSERVE_MAX_S + 2 * POLL_WORST_S + POLL_S ))
ROLLBACK_WORST_S=$(( ROLLBACK_ATTEMPTS_MAX * (CHECK_WORST_S + STEP_TIMEOUT_ACTIVATE_S + CHECK_WORST_S + ROLLBACK_RETRY_S) + CHECK_WORST_S ))
NOTIFY_WORST_S=$(( 2 * STEP_TIMEOUT_READ_ENV_S + STEP_TIMEOUT_NOTIFY_S ))
WORST_PATH_S=$(( 2 * STEP_TIMEOUT_GIT_S + STEP_TIMEOUT_INSTALLED_S + STEP_TIMEOUT_GH_S + STEP_TIMEOUT_SCAN_S + STEP_TIMEOUT_GH_S
  + STEP_TIMEOUT_RESOLVE_S + STEP_TIMEOUT_ATTEST_S + STEP_TIMEOUT_PULL_S + STEP_TIMEOUT_CURRENT_S
  + STEP_TIMEOUT_AUDIT_S + 2 * STEP_TIMEOUT_LOCAL_S + STEP_TIMEOUT_PULL_S + STEP_TIMEOUT_READ_ENV_S
  + STEP_TIMEOUT_SNAPSHOT_S + STEP_TIMEOUT_TRIAL_S + STEP_TIMEOUT_ACTIVATE_S + WINDOW_WORST_S
  + STEP_TIMEOUT_SNAPSHOT_OP_S + ROLLBACK_WORST_S + 3 * NOTIFY_WORST_S
  + PENDING_MARK_MAX_PER_TICK * STEP_TIMEOUT_SNAPSHOT_OP_S ))
# The unit's TimeoutStartSec (stage «в») must be at least this.
TICK_BUDGET_S=7500
# --- timeouts and the tick's budget ------------------------------------------------------- END
# Quadlet's Type=notify signals the container, not the application: after ACTIVATED wait this
# long for /health to answer releaseSha == X with the unit running.
STARTUP_S=$STEP_TIMEOUT_STARTUP_S
# A lock held longer than the longest legitimate tick has a holder that will not let go.
LOCK_STALL_S=$(( TICK_BUDGET_S + 300 ))
# R6: one failed probe is a stall, not a failed deploy — a run of failures is.
HEALTH_FAILS_MAX=3
# Plan п.9: a trial REFUSED (a precondition on the host) is retried after this long.
CANDIDATE_RETRY_S=3600
# F5: `activate D` gets this many tries per window; then a human looks.
ACTIVATE_ATTEMPTS_MAX=3
KEEP_SNAPSHOTS=3
SNAPSHOT_DIR="${WBB_SNAPSHOT_DIR:-/var/lib/warsaw-beer-bot/deploy-snapshots}"
DB_PATH="${WBB_DB_PATH:-/var/lib/warsaw-beer-bot/bot.db}"

READ_ENV_BIN="${WBB_READ_ENV:-/usr/local/bin/wbb-read-env}"
# Unset: the installed copy. Set but EMPTY: the check is off (a test seam, never the host's).
INSTALLED_CHECK_BIN="${WBB_INSTALLED_CHECK-/usr/local/bin/wbb-installed-current}"
SNAPSHOT_BIN="${WBB_SNAPSHOT_BIN:-/usr/local/bin/wbb-db-snapshot}"
# Where deploy/install-image.sh puts the helper (its library, template and wrapper).
IMAGE_LIB_DIR="${WBB_IMAGE_LIB:-/usr/local/lib/wbb-image}"
IMAGE_BIN="${WBB_IMAGE_BIN:-/usr/local/libexec/wbb-image}"

# --- seams ------------------------------------------------------------------------------------
# I2 (#435), kept: every contact with the outside world is ONE swappable command that defaults
# to the real thing, so a test substitutes all of them and never touches sudo, podman, systemd,
# GitHub, the registry or the network (plan п.5).
_clock_default() { date +%s; }
CLOCK_CMD="${WBB_CLOCK_CMD:-_clock_default}"
_sleep_default() { sleep "$1"; }
SLEEP_CMD="${WBB_SLEEP_CMD:-_sleep_default}"

# ONE probe, no loop. Prints /health's releaseSha; not ok, or not 40 hex → exit 1 (plan п.5).
_health_default() {
  local body sha
  body=$(curl -fsS --max-time "$STEP_TIMEOUT_SEAM_S" "http://127.0.0.1:${1}/health" 2>/dev/null) || return 1
  case "$body" in *'"ok":true'*) ;; *) return 1 ;; esac
  sha=$(printf '%s' "$body" | sed -n 's/.*"releaseSha":"\([0-9a-f]\{40\}\)".*/\1/p')
  [ -n "$sha" ] || return 1
  printf '%s\n' "$sha"
}
HEALTH_CMD="${WBB_HEALTH_CMD:-_health_default}"
_restarts_default() { timeout "$STEP_TIMEOUT_SEAM_S" systemctl show -p NRestarts --value warsaw-beer-bot; }
RESTARTS_CMD="${WBB_RESTARTS_CMD:-_restarts_default}"
# Plan п.11: "running" is ActiveState=active, SubState=running, MainPID != 0 (the operator reads it).
_unit_state_default() { timeout "$STEP_TIMEOUT_SEAM_S" systemctl show warsaw-beer-bot -p ActiveState,SubState,MainPID; }
UNIT_STATE_CMD="${WBB_UNIT_STATE_CMD:-_unit_state_default}"
_boot_id_default() { cat /proc/sys/kernel/random/boot_id; }
# Monotonic seconds since boot, for deadlines inside one tick: the wall clock may step.
_uptime_default() { local u _; read -r u _ < /proc/uptime; echo "${u%%.*}"; }
# The monotonic clock as a plain integer, or failure (#867 AI review: a broken or odd clock must
# be a hold, never an aborted tick or garbage arithmetic).
uptime_now() {
  local u
  u=$("$UPTIME_CMD" 2>/dev/null) || return 1
  [[ $u =~ ^(0|[1-9][0-9]*)$ ]] || return 1
  echo "$u"
}
UPTIME_CMD="${WBB_UPTIME_CMD:-_uptime_default}"
BOOT_ID_CMD="${WBB_BOOT_ID_CMD:-_boot_id_default}"

# The root helper (spec §5): one sudoers rule per verb, never a password prompt.
_helper_timeout() {
  case "$1" in
    pull) echo "$STEP_TIMEOUT_PULL_S" ;;
    local) echo "$STEP_TIMEOUT_LOCAL_S" ;;
    audit) echo "$STEP_TIMEOUT_AUDIT_S" ;;
    trial) echo "$STEP_TIMEOUT_TRIAL_S" ;;
    activate) echo "$STEP_TIMEOUT_ACTIVATE_S" ;;
    current) echo "$STEP_TIMEOUT_CURRENT_S" ;;
    prune) echo "$STEP_TIMEOUT_PRUNE_IMAGES_S" ;;
    *) echo "$STEP_TIMEOUT_SEAM_S" ;;
  esac
}
_image_default() { timeout "$(_helper_timeout "$1")" sudo -n "$IMAGE_BIN" "$@"; }
IMAGE_CMD="${WBB_IMAGE_CMD:-_image_default}"

# Plan п.6: tag <sha> → digest, anonymously from GHCR's registry API. Trusted for NOTHING: the
# attestation and `pull` (.Digest == D, revision == X) are what make D believable.
# Prints sha256:<64 hex>; exit 3 = no such tag (404); anything else = could not read.
_resolve_default() {
  local token headers status digest each=$(( $STEP_TIMEOUT_RESOLVE_S / 2 ))
  token=$(curl -fsS --max-time "$each" "https://ghcr.io/token?scope=repository:${GH_REPO}:pull" \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p') || return 1
  [ -n "$token" ] || return 1
  headers=$(curl -sS -I --max-time "$each" -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${GH_REPO}/manifests/$1" | tr -d '\r') || return 1
  status=$(printf '%s\n' "$headers" | awk 'NR == 1 { print $2 }')
  case "$status" in
    404) return 3 ;;
    200) ;;
    *) return 1 ;;
  esac
  digest=$(printf '%s\n' "$headers" | awk 'tolower($1) == "docker-content-digest:" { print $2 }')
  printf '%s\n' "$digest"
}
RESOLVE_CMD="${WBB_RESOLVE_CMD:-_resolve_default}"
# Spec §1 п.2: D was built by this repository's ci.yml from commit $2 on main, on a hosted runner.
_attest_default() {
  timeout "$STEP_TIMEOUT_ATTEST_S" gh attestation verify "oci://${IMAGE_REPOSITORY}@$1" \
    --repo "$GH_REPO" \
    --signer-workflow "${GH_REPO}/.github/workflows/ci.yml" \
    --source-ref refs/heads/main \
    --source-digest "$2" \
    --deny-self-hosted-runners
}
ATTEST_CMD="${WBB_ATTEST_CMD:-_attest_default}"

# GitHub, read as the operator's `gh`. One line per check run:
# name<TAB>status<TAB>conclusion<TAB>check suite id (plan п.8).
_checks_default() {
  timeout "$STEP_TIMEOUT_GH_S" gh api "repos/${GH_REPO}/commits/$1/check-runs" --paginate \
    --jq '.check_runs[] | [.name, .status, (.conclusion // ""), (.check_suite.id | tostring)] | @tsv'
}
CHECKS_CMD="${WBB_CHECKS_CMD:-_checks_default}"
# One line per PR that contains the commit: number<TAB>label,label,...
_pr_labels_default() {
  timeout "$STEP_TIMEOUT_GH_S" gh api "repos/${GH_REPO}/commits/$1/pulls" \
    --jq '.[] | "\(.number)\t\(.labels | map(.name) | join(","))"'
}
PR_LABELS_CMD="${WBB_PR_LABELS_CMD:-_pr_labels_default}"

_read_env_default() {
  timeout "$STEP_TIMEOUT_READ_ENV_S" sudo -u warsaw-beer-bot bash -lc '"$0" /etc/warsaw-beer-bot/.env "$1"' "$READ_ENV_BIN" "$1"
}
READ_ENV_CMD="${WBB_READ_ENV_CMD:-_read_env_default}"
_notify_default() {
  # Deliberately NOT via the bot: if the deploy took the bot down, the bot cannot report it.
  local tok chat
  tok=$("$READ_ENV_CMD" TELEGRAM_BOT_TOKEN)
  chat=$("$READ_ENV_CMD" ADMIN_TELEGRAM_ID)
  if [ -z "$tok" ] || [ -z "$chat" ]; then
    echo "WARNING: notifier has no token or chat id; cannot report: $1" >&2
    return 1
  fi
  # The URL carries the token: it goes to curl as a config on stdin, never in argv (ps, /proc).
  printf 'url = "%s"\n' "https://api.telegram.org/bot${tok}/sendMessage" | curl -K - -fsS --max-time "$STEP_TIMEOUT_NOTIFY_S" -X POST \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=$1" >/dev/null
}
NOTIFY_CMD="${WBB_NOTIFY_CMD:-_notify_default}"
_api_port_default() {
  local p
  # R7: a failed READ refuses the deploy; an empty VALUE is the app default.
  p=$("$READ_ENV_CMD" API_PORT) || return 1
  echo "${p:-3000}"
}
API_PORT_CMD="${WBB_API_PORT_CMD:-_api_port_default}"

# DB snapshots run as the bot user through the existing `bash -lc` rule, next to bot.db.
_as_bot() { timeout "$STEP_TIMEOUT_SNAPSHOT_OP_S" sudo -u warsaw-beer-bot bash -lc '"$0" "$@"' "$@"; }
_snapshot_default() { timeout "$STEP_TIMEOUT_SNAPSHOT_S" sudo -u warsaw-beer-bot bash -lc '"$0" "$@"' "$SNAPSHOT_BIN" snapshot "$DB_PATH" "$1"; }
SNAPSHOT_CMD="${WBB_SNAPSHOT_CMD:-_snapshot_default}"
_prune_default() { _as_bot "$SNAPSHOT_BIN" prune "$SNAPSHOT_DIR" "$KEEP_SNAPSHOTS"; }
PRUNE_CMD="${WBB_PRUNE_CMD:-_prune_default}"
_mark_default() { _as_bot "$SNAPSHOT_BIN" mark-rollback "$1"; }
MARK_CMD="${WBB_MARK_CMD:-_mark_default}"
_unmark_default() { _as_bot "$SNAPSHOT_BIN" unmark "$1"; }
UNMARK_CMD="${WBB_UNMARK_CMD:-_unmark_default}"
_discard_default() { _as_bot "$SNAPSHOT_BIN" discard "$1"; }
DISCARD_CMD="${WBB_DISCARD_CMD:-_discard_default}"

# Plan п.3: write_state makes a written state survive a reboot. coreutils `sync FILE` (8.24+;
# Ubuntu 24.04 ships 9.4) fsyncs that file, and a directory too — the rename is in the directory.
_fsync_default() { sync -- "$1"; }
FSYNC_CMD="${WBB_FSYNC_CMD:-_fsync_default}"

now() { "$CLOCK_CMD"; }
# The UTC day of the tick's clock: "once a day" follows the same clock as everything else.
today() { date -u -d "@$(now)" +%Y-%m-%d; }

# I6: Telegram caps sendMessage at 4096 chars, and a notify failure must never abort the run.
# Plan b2 п.5: a manual run says the same things, marked — the reader of the chat must know a
# human ran it, not the timer. The human in front of the run reads them too (stdout).
notify() {
  local msg="$1"
  if [ "$MANUAL" = 1 ]; then
    msg="[manual] $msg"
    printf '%s\n' "$msg"
  fi
  if [ "${#msg}" -gt "$NOTIFY_LIMIT" ]; then
    msg="${msg:0:$NOTIFY_LIMIT}"$'\n… truncated'
  fi
  "$NOTIFY_CMD" "$msg" || echo "WARNING: notify failed: $msg"
}

# "Could not verify" (or "wait"): the tick says so once a day and exits — the next tick looks again
# (exit $3, default 0). A manual run is refused at once (1): the human is in front of it and runs
# again; nothing is recorded, not even the daily marker, so the timer's own notice is not muted.
halt() { # <daily marker> <message> [the tick's exit]
  if [ "$MANUAL" = 1 ]; then
    printf '%s\n' "$(manual_text "$2")$(way_back)" >&2
    exit 1
  fi
  once_a_day "$1" "$2"
  exit "${3:-0}"
}
# Plan b2 п.21: a stop that leaves an open window (an activation not confirmed) may have changed
# production — the chat is told, as from the tick (§7.4 "the same messages"), without the daily
# marker; the window is the timer's to finish.
halt_window() { # <daily marker> <message>
  if [ "$MANUAL" = 1 ]; then
    # The window stays open and the timer finishes it, which is what the text says: no "run again".
    notify "$2"
    exit 1
  fi
  once_a_day "$1" "$2"
  exit 0
}
# The tick's text says the next tick retries; the human's says that he does (plan b2 п.21).
manual_text() {
  local m="$1"
  m="${m//; retrying next tick./}"
  m="${m// — retrying next tick./}"
  m="${m// — waiting;/ —}"
  m="${m% Waiting.}"
  m="${m%.}"
  printf '%s — run again' "$m"
}
# A manual run's own refusal: told to the human in front of it; this writes nothing, sends nothing.
manual_refuse() {
  printf '%s\n' "$1$(way_back)" >&2
  exit 1
}
# Plan b2 п.29: a refusal of the second bootstrap run leaves the old bot stopped and its unit moved
# aside — it says how to bring it back. Set only there (bootstrap_run, unit=absent and not running),
# so no other run, the tick's included, says anything more.
WAY_BACK=""
way_back() {
  [ -n "$WAY_BACK" ] || return 0
  printf '\n%s' "$WAY_BACK"
}

# --- verdict parsers (pure: no state, no seams) -------------------------------------- BEGIN
# Plan п.9: the controller branches on the helper's (exit code, line), read per action — never
# on the code alone. parse_verdict <action> <exit> <stdout> <stderr> prints ONE normalized line:
#   pull     PULLED <D> <I> <content> <revision>
#   local    LOCAL <D> <I> <content> <revision> | NOT_LOCAL <D>
#   audit    CLEAN <D> | ADVISORY <D>  (then the helper's details, one per line)
#   trial    OK <S> | FAILED <line> | COMPAT_FAILED <line>          (from the LAST stdout line)
#   activate ACTIVATED <D> | ACTIVATE_FAILED <line>
#   current  CURRENT <quadlet> <container-image> <container-digest> <unit>
#   prune    PRUNED <the rest of the helper's line>
#   any      REFUSED <reason> (exit 2) | TEMPFAIL <reason> (exit 75) — from the FIRST stderr line
#   else     UNKNOWN exit <n>: <first line of stderr, else of stdout>
# Anything outside the table is UNKNOWN ("could not verify"), never a verdict on the candidate —
# that includes exit 1 with no line, which is how `sudo -n` answers a missing rule.
_VERDICT_SHA='[0-9a-f]{40}'
_VERDICT_DIGEST='sha256:[0-9a-f]{64}'
_VERDICT_HEX='[0-9a-f]{64}'
_verdict_unknown() {
  local rc="$1" out="$2" err="$3" what
  what="${err%%$'\n'*}"
  [ -n "$what" ] || what="${out%%$'\n'*}"
  [ -n "$what" ] || what="no output"
  printf 'UNKNOWN exit %s: %s\n' "$rc" "$what"
}
parse_verdict() {
  local action="$1" rc="$2" out err first last re reason
  # Trailing newlines carry nothing; $(…) drops them.
  out=$(printf '%s' "$3")
  err=$(printf '%s' "$4")
  first="${out%%$'\n'*}"
  last="${out##*$'\n'}"
  # On 2 and 75 the helper's FIRST stderr line is its one REFUSED / TEMPFAIL line.
  reason="${err%%$'\n'*}"
  case "$rc:$reason" in
    '2:REFUSED: '*) printf 'REFUSED %s\n' "${reason#REFUSED: }"; return 0 ;;
    '75:TEMPFAIL: '*) printf 'TEMPFAIL %s\n' "${reason#TEMPFAIL: }"; return 0 ;;
  esac
  case "$action:$rc" in
    pull:0)
      re="^PULLED ($_VERDICT_DIGEST) ($_VERDICT_HEX) content=($_VERDICT_HEX) revision=($_VERDICT_SHA)\$"
      if [[ $out =~ $re ]]; then
        printf 'PULLED %s %s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
        return 0
      fi ;;
    local:0)
      re="^LOCAL ($_VERDICT_DIGEST) ($_VERDICT_HEX) content=($_VERDICT_HEX) revision=($_VERDICT_SHA)\$"
      if [[ $out =~ $re ]]; then
        printf 'LOCAL %s %s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
        return 0
      fi ;;
    local:3)
      re="^NOT LOCAL ($_VERDICT_DIGEST)\$"
      if [[ $out =~ $re ]]; then printf 'NOT_LOCAL %s\n' "${BASH_REMATCH[1]}"; return 0; fi ;;
    # The verdict is the FIRST line; npm's details follow it.
    audit:0)
      re="^AUDIT CLEAN ($_VERDICT_DIGEST)\$"
      if [[ $first =~ $re ]]; then printf 'CLEAN %s\n' "${BASH_REMATCH[1]}"; return 0; fi ;;
    audit:1)
      re="^AUDIT ADVISORY ($_VERDICT_DIGEST)\$"
      if [[ $first =~ $re ]]; then
        printf 'ADVISORY %s\n' "${BASH_REMATCH[1]}"
        if [ "$out" != "$first" ]; then printf '%s\n' "${out#*$'\n'}"; fi
        return 0
      fi ;;
    # One line per step; the verdict is the LAST one.
    trial:0)
      re="^COMPAT OK ($_VERDICT_DIGEST)\$"
      if [[ $last =~ $re ]]; then printf 'OK %s\n' "${BASH_REMATCH[1]}"; return 0; fi ;;
    trial:1)
      case "$last" in
        'TRIAL FAILED: '*|'START FAILED: '*) printf 'FAILED %s\n' "$last"; return 0 ;;
        'COMPAT FAILED: '*) printf 'COMPAT_FAILED %s\n' "$last"; return 0 ;;
      esac ;;
    activate:0)
      re="^ACTIVATED ($_VERDICT_DIGEST)\$"
      if [[ $out =~ $re ]]; then printf 'ACTIVATED %s\n' "${BASH_REMATCH[1]}"; return 0; fi ;;
    activate:1)
      if [ "$out" = "$first" ]; then
        case "$out" in 'ACTIVATE FAILED: '*) printf 'ACTIVATE_FAILED %s\n' "$out"; return 0 ;; esac
      fi ;;
    current:0)
      re="^CURRENT quadlet=(none|$_VERDICT_DIGEST) container-image=(none|$_VERDICT_HEX) container-digest=(none|$_VERDICT_DIGEST) unit=(quadlet|foreign|absent)\$"
      if [[ $out =~ $re ]]; then
        printf 'CURRENT %s %s %s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
        return 0
      fi ;;
    prune:0)
      if [ "$out" = "$first" ]; then
        case "$out" in 'PRUNED '*) printf '%s\n' "$out"; return 0 ;; esac
      fi ;;
  esac
  _verdict_unknown "$rc" "$out" "$err"
}
# --- verdict parsers ----------------------------------------------------------------- END

# --- brake, lock --------------------------------------------------------------------------------
# Unprivileged emergency stop (#435 §7). Checked before anything else; a paused tick writes
# nothing and says nothing.
if [ -f "$STATE_DIR/PAUSED" ]; then
  # A human who asked for a deploy is owed an answer (plan b2 п.2); the timer is not.
  if [ "$MANUAL" = 1 ]; then
    manual_refuse "wbb-autodeploy: paused ($STATE_DIR/PAUSED exists) — a manual run is refused; remove the file to deploy"
  fi
  echo "wbb-autodeploy: paused ($STATE_DIR/PAUSED exists); exiting quietly"
  exit 0
fi
mkdir -p "$DATA_DIR" "$STATE_DIR"
# The same lock as the flat deployer and deploy.sh: whoever holds it, the others wait.
exec 9>"$LOCK"
if ! flock -n 9; then
  # Plan b2 п.2: a manual run never waits — a tick may hold the lock for a whole window — and the
  # stall count below is the timer's: a human who found the lock busy says nothing about a stall.
  if [ "$MANUAL" = 1 ]; then
    manual_refuse "the deploy lock is held (a tick or another deploy.sh) — nothing was done; run again when it is free (fuser -v $LOCK)"
  fi
  # A holder that never lets go blocks every tick, and "another tick holds the lock" alone says
  # nothing. These two files live outside the state on purpose: state is written only under the
  # lock, and this path runs because we do not have it.
  busy="$STATE_DIR/lock-busy-since"
  # Only a plain integer is a record; anything else, or a record older than two stall periods
  # (an earlier busy period that no tick closed), starts the count afresh — written atomically.
  since=$(cat "$busy" 2>/dev/null || true)
  if ! [[ $since =~ ^(0|[1-9][0-9]{0,17})$ ]] || [ "$since" -gt "$(now)" ] \
     || [ $(( $(now) - since )) -ge $(( 2 * LOCK_STALL_S )) ]; then
    since=$(now)
    printf '%s\n' "$since" > "$busy.tmp" && mv -f "$busy.tmp" "$busy"
  fi
  held_s=$(( $(now) - since ))
  if [ "$held_s" -ge "$LOCK_STALL_S" ] && [ "$(cat "$STATE_DIR/lock-notice" 2>/dev/null)" != "$(today)" ]; then
    notify "⚠️ merge-deploy: the deploy lock has been held for $(( held_s / 60 )) min — no tick can run. A stuck manual deploy.sh? Check: fuser -v $LOCK"
    today > "$STATE_DIR/lock-notice"
  fi
  echo "another process holds the lock (${held_s}s); exiting"
  exit 0
fi
if [ "$MANUAL" = 0 ]; then rm -f "$STATE_DIR/lock-busy-since"; fi
TICK_TMP=$(mktemp -d)
trap 'rm -rf "$TICK_TMP"' EXIT

# --- state -----------------------------------------------------------------------------------------
# Plan п.4: every key, in the order write_state writes them. Nothing outside this list is ever
# read, and every key is carried from a shell variable: a caller changes one by ASSIGNING it.
STATE_KEYS=(
  DEPLOYED_SHA PREVIOUS_SHA LAST_SEEN_DEPLOYED_SHA REGRESSION_FROM_SHA REGRESSION_TO_SHA
  LAST_FAILED_SHA MAIN_SEEN_SHA MAIN_SEEN_S LAST_CI_NOTICE_SHA
  LAST_HOLD_NOTICE LAST_STALE_NOTICE LAST_ASSESS_NOTICE LAST_INCIDENT_NOTICE
  DEPLOYED_DIGEST DEPLOYED_ID DEPLOYED_CONTENT SETTLED_SHA SETTLED_DIGEST SETTLED_ID SETTLED_CONTENT
  WINDOW_SHA WINDOW_DIGEST WINDOW_ID WINDOW_CONTENT WINDOW_OLD WINDOW_PREV_DIGEST WINDOW_KIND WINDOW_MODE
  WINDOW_PHASE WINDOW_PRE WINDOW_START WINDOW_BOOT WINDOW_NRESTARTS WINDOW_FAILS WINDOW_LAST_READ
  WINDOW_REASON ROLLBACK_ATTEMPTS ACTIVATE_ATTEMPTS PENDING_PRE PENDING_MARK
  CANDIDATE_HELD CANDIDATE_HELD_WHY CANDIDATE_RETRY_X CANDIDATE_RETRY_AT
  RETAINED_PRE
  INCIDENT
)
WINDOW_KEYS=(WINDOW_SHA WINDOW_DIGEST WINDOW_ID WINDOW_CONTENT WINDOW_OLD WINDOW_PREV_DIGEST WINDOW_KIND WINDOW_MODE
  WINDOW_PHASE WINDOW_PRE WINDOW_START WINDOW_BOOT WINDOW_NRESTARTS WINDOW_FAILS WINDOW_LAST_READ WINDOW_REASON)
for _k in "${STATE_KEYS[@]}"; do printf -v "$_k" '%s' ''; done
unset _k
HOLDS=()
RANGE_PRS=()
CONTRACT_PRS=()
STEP_HOLDS=()
UNREAD=()
SCAN_UNREAD=0

is_state_key() {
  local k
  for k in "${STATE_KEYS[@]}"; do
    if [ "$k" = "$1" ]; then return 0; fi
  done
  return 1
}

# CANDIDATE_HELD="<X> <D> <S>", INCIDENT="<sha> <digest> <reason>" (spec §7.1).
_RE_CANDIDATE_HELD='^[0-9a-f]{40} sha256:[0-9a-f]{64} sha256:[0-9a-f]{64}$'
_RE_INCIDENT='^[0-9a-f]{40} sha256:[0-9a-f]{64} [^ ].*$'
# A pre snapshot's path (db-snapshot.sh names: <stamp>-<sha>-pre.db, marked -rollback-pre.db).
_RE_PRE='^/[A-Za-z0-9._/-]+-pre[.]db$'
# Which kind of pre a key may hold (#867 AI review): a pending mark or a pending pre is an UNMARKED
# snapshot (mark-rollback would otherwise rename a retained one a second time); a retained one is
# MARKED (-rollback-pre.db); WINDOW_PRE is either (retain_pre points it at the marked name).
pre_path_ok() { # <kind any|unmarked|marked> <path>
  [[ $2 =~ $_RE_PRE ]] || return 1
  case "$1" in
    unmarked) case "$2" in *-rollback-pre.db|*-unverified-pre.db) return 1 ;; esac ;;
    marked) case "$2" in *-rollback-pre.db) ;; *) return 1 ;; esac ;;
  esac
}
# A space-separated list of them, each element checked on its own; read with `read -a`, which
# neither globs nor reinterprets anything.
_all_pre_paths() { # <kind> <list>
  local -a items
  local item
  read -r -a items <<< "$2"
  [ "${#items[@]}" -gt 0 ] || return 1
  [ "$2" = "${items[*]}" ] || return 1
  for item in "${items[@]}"; do
    pre_path_ok "$1" "$item" || return 1
  done
}
# The format of each key's value. Leading zeros are refused: bash arithmetic reads 010 as 8.
value_ok() {
  local k="$1" v="$2"
  case "$k" in
    DEPLOYED_SHA|PREVIOUS_SHA|LAST_SEEN_DEPLOYED_SHA|REGRESSION_FROM_SHA|REGRESSION_TO_SHA|LAST_FAILED_SHA|\
    MAIN_SEEN_SHA|LAST_CI_NOTICE_SHA|SETTLED_SHA|WINDOW_SHA|WINDOW_OLD|CANDIDATE_RETRY_X)
      [[ $v =~ ^[0-9a-f]{40}$ ]] ;;
    DEPLOYED_DIGEST|SETTLED_DIGEST|WINDOW_DIGEST|WINDOW_PREV_DIGEST)
      [[ $v =~ ^sha256:[0-9a-f]{64}$ ]] ;;
    DEPLOYED_ID|SETTLED_ID|WINDOW_ID|DEPLOYED_CONTENT|SETTLED_CONTENT|WINDOW_CONTENT)
      [[ $v =~ ^[0-9a-f]{64}$ ]] ;;
    MAIN_SEEN_S|WINDOW_START|WINDOW_NRESTARTS|WINDOW_FAILS|WINDOW_LAST_READ|ROLLBACK_ATTEMPTS|ACTIVATE_ATTEMPTS|CANDIDATE_RETRY_AT)
      [[ $v =~ ^(0|[1-9][0-9]{0,17})$ ]] ;;
    LAST_HOLD_NOTICE|LAST_STALE_NOTICE|LAST_ASSESS_NOTICE|LAST_INCIDENT_NOTICE)
      [[ $v =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ;;
    WINDOW_MODE) [[ $v =~ ^(auto|manual)$ ]] ;;
    # Spec §7.1 (amendment 3): where the window came from — a candidate's deploy (the timer's or a
    # human's), the first image release, an incident's closing.
    WINDOW_KIND) [[ $v =~ ^(deploy|bootstrap|resolve)$ ]] ;;
    WINDOW_PHASE) [[ $v =~ ^(activating|watching|rolling-back)$ ]] ;;
    WINDOW_BOOT) [[ $v =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ;;
    CANDIDATE_HELD) [[ $v =~ $_RE_CANDIDATE_HELD ]] ;;
    INCIDENT) [[ $v =~ $_RE_INCIDENT ]] ;;
    # Free text (a path, a reason): one line by construction; it must say something.
    # Snapshot paths: no space, no glob character — a list of them splits on spaces alone.
    WINDOW_PRE) pre_path_ok any "$v" ;;
    PENDING_PRE) pre_path_ok unmarked "$v" ;;
    PENDING_MARK) _all_pre_paths unmarked "$v" ;;
    RETAINED_PRE) _all_pre_paths marked "$v" ;;
    WINDOW_REASON|CANDIDATE_HELD_WHY) [ -n "$v" ] ;;
    *) return 1 ;;
  esac
}

# All of the keys, or none of them.
_together() {
  local k have="" missing=""
  for k in "$@"; do
    if [ -n "${!k}" ]; then have="${have:-$k}"; else missing="${missing:-$k}"; fi
  done
  if [ -n "$have" ] && [ -n "$missing" ]; then
    STATE_PROBLEM="$have is set but $missing is not"
    return 1
  fi
}
# $1 set ⇒ every other key set.
_requires() {
  local k="$1" r
  shift
  [ -n "${!k}" ] || return 0
  for r in "$@"; do
    if [ -z "${!r}" ]; then
      STATE_PROBLEM="$k is set but $r is not"
      return 1
    fi
  done
}

# Plan п.3: the state is used only whole and consistent. Sets STATE_PROBLEM and returns 1 if not.
# The same check guards the reader and the writer: nothing is written that would not be read.
check_state() {
  local k w
  STATE_PROBLEM=""
  for k in "${STATE_KEYS[@]}"; do
    if [ -n "${!k}" ] && ! value_ok "$k" "${!k}"; then
      STATE_PROBLEM="$k has a value that is not of its format"
      return 1
    fi
  done
  _together SETTLED_SHA SETTLED_DIGEST SETTLED_ID || return 1
  _requires SETTLED_CONTENT SETTLED_DIGEST || return 1
  _together DEPLOYED_DIGEST DEPLOYED_ID || return 1
  _requires DEPLOYED_CONTENT DEPLOYED_DIGEST || return 1
  _together MAIN_SEEN_SHA MAIN_SEEN_S || return 1
  _together REGRESSION_FROM_SHA REGRESSION_TO_SHA || return 1
  _requires WINDOW_PHASE WINDOW_SHA WINDOW_DIGEST WINDOW_MODE WINDOW_KIND || return 1
  for w in "${WINDOW_KEYS[@]}"; do
    _requires "$w" WINDOW_PHASE || return 1
  done
  _requires ROLLBACK_ATTEMPTS WINDOW_PHASE || return 1
  _requires ACTIVATE_ATTEMPTS WINDOW_PHASE || return 1
  # What each phase stands on (a window is written whole, then grows phase by phase).
  _requires WINDOW_PHASE WINDOW_ID WINDOW_CONTENT WINDOW_OLD WINDOW_BOOT || return 1
  # Plan b2 п.15. A resolve window closes an incident: the human's image already runs, so it is
  # always manual, only watches, takes no pre snapshot, and rolls back to whatever was settled —
  # nothing, when the incident came before any settled image. Every other window has both.
  if [ "$WINDOW_KIND" = resolve ]; then
    if [ "$WINDOW_MODE" != manual ]; then
      STATE_PROBLEM="WINDOW_KIND is resolve but WINDOW_MODE is $WINDOW_MODE (a resolve window is always manual)"
      return 1
    fi
    if [ "$WINDOW_PHASE" != watching ]; then
      STATE_PROBLEM="WINDOW_KIND is resolve but WINDOW_PHASE is $WINDOW_PHASE (a resolve window only watches)"
      return 1
    fi
    if [ -n "$WINDOW_PRE" ]; then
      STATE_PROBLEM="WINDOW_KIND is resolve but WINDOW_PRE is set (closing an incident takes no snapshot)"
      return 1
    fi
    if [ -n "$SETTLED_DIGEST" ]; then
      _requires WINDOW_PHASE WINDOW_PREV_DIGEST || return 1
    elif [ -n "$WINDOW_PREV_DIGEST" ]; then
      STATE_PROBLEM="WINDOW_KIND is resolve and nothing is settled, but WINDOW_PREV_DIGEST is set"
      return 1
    fi
  elif [ "$WINDOW_KIND" = bootstrap ]; then
    # Plan b2 п.15: the first image release has nothing to roll back to, so a human watches it
    # (manual) and it has no rollback target; its window exists only while nothing is settled —
    # the settle writes SETTLED_* and clears the window in one write.
    if [ "$WINDOW_MODE" != manual ]; then
      STATE_PROBLEM="WINDOW_KIND is bootstrap but WINDOW_MODE is $WINDOW_MODE (the first image release is always manual)"
      return 1
    fi
    if [ -n "$WINDOW_PREV_DIGEST" ]; then
      STATE_PROBLEM="WINDOW_KIND is bootstrap but WINDOW_PREV_DIGEST is set (the first image release has no rollback target)"
      return 1
    fi
    if [ -n "$SETTLED_DIGEST" ]; then
      STATE_PROBLEM="WINDOW_KIND is bootstrap but SETTLED_DIGEST is set (a bootstrap window exists only while nothing is settled)"
      return 1
    fi
    _requires WINDOW_PHASE WINDOW_PRE || return 1
  else
    _requires WINDOW_PHASE WINDOW_PREV_DIGEST WINDOW_PRE || return 1
  fi
  case "$WINDOW_PHASE" in
    watching)
      _requires WINDOW_PHASE WINDOW_START WINDOW_LAST_READ WINDOW_FAILS WINDOW_NRESTARTS || return 1 ;;
    rolling-back)
      # A rollback can begin in `activating` (ACTIVATE FAILED), before any watching.
      _requires WINDOW_PHASE WINDOW_REASON ROLLBACK_ATTEMPTS || return 1
      if [ "$WINDOW_MODE" != auto ]; then
        STATE_PROBLEM="WINDOW_PHASE is rolling-back but WINDOW_MODE is $WINDOW_MODE (a manual window never rolls back)"
        return 1
      fi ;;
  esac
  _requires CANDIDATE_HELD_WHY CANDIDATE_HELD || return 1
  _together CANDIDATE_RETRY_X CANDIDATE_RETRY_AT || return 1
}

# Plan п.3: `while read`, never `. "$STATE"` — INCIDENT's value has spaces, and sourcing would
# run its second word as a command. No file is a first start (bootstrap); a file that exists but
# is damaged — empty, cut short, a stray line, a key twice — never is.
read_state() {
  local content line key value n=0 seen=" "
  STATE_PROBLEM=""
  # A symlink, even a dangling one, is not a missing file: never a first start.
  if [ -L "$STATE" ]; then STATE_PROBLEM="the path is a symlink"; return 1; fi
  [ -e "$STATE" ] || return 0
  if [ ! -f "$STATE" ]; then STATE_PROBLEM="not a regular file"; return 1; fi
  if ! tr -d '\000' < "$STATE" | cmp -s - "$STATE"; then STATE_PROBLEM="the file holds a NUL byte"; return 1; fi
  if ! content=$(cat "$STATE" && printf x); then STATE_PROBLEM="the file cannot be read"; return 1; fi
  content="${content%x}"
  if [ -z "$content" ]; then STATE_PROBLEM="the file is empty"; return 1; fi
  if [ "${content: -1}" != $'\n' ]; then STATE_PROBLEM="the last line has no newline (a truncated file)"; return 1; fi
  while IFS= read -r line; do
    n=$(( n + 1 ))
    if ! [[ $line =~ ^([A-Z_]+)=(.*)$ ]]; then STATE_PROBLEM="line $n is not KEY=value"; return 1; fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if ! is_state_key "$key"; then STATE_PROBLEM="line $n: unknown key $key"; return 1; fi
    case "$seen" in *" $key "*) STATE_PROBLEM="line $n: duplicate key $key"; return 1 ;; esac
    seen+="$key "
    printf -v "$key" '%s' "$value"
  done <<< "${content%$'\n'}"
  check_state
}

# Plan п.3: atomic and durable — a temporary file in the same directory, fsync, rename, fsync of
# the directory. A reboot after a successful write_state never brings the previous state back.
write_state() {
  local k any="" tmp="$STATE.tmp"
  for k in "${STATE_KEYS[@]}"; do
    case "${!k}" in
      *$'\n'*)
        notify "🔥 merge-deploy: refusing to write $STATE — the value of $k contains a newline, and the file holds one key per line. Its record of what is deployed may now disagree with production."
        exit 4 ;;
    esac
    any="${any}${!k}"
  done
  if ! check_state; then
    notify "🔥 merge-deploy: refusing to write an invalid state to $STATE: ${STATE_PROBLEM}. Its record of what is deployed may now disagree with production."
    exit 4
  fi
  # A state with no key at all is no state: the reader takes a missing file as the first start,
  # but an EMPTY file as damage.
  if [ -z "$any" ]; then
    if rm -f "$STATE" 2>/dev/null && "$FSYNC_CMD" "$STATE_DIR"; then return 0; fi
    notify "🔥 merge-deploy: failed to write $STATE — its record of what is deployed may now disagree with production."
    exit 4
  fi
  if ! {
    for k in "${STATE_KEYS[@]}"; do
      if [ -n "${!k}" ]; then printf '%s=%s\n' "$k" "${!k}"; fi
    done
  } > "$tmp" 2>/dev/null \
    || ! "$FSYNC_CMD" "$tmp" \
    || ! mv -f "$tmp" "$STATE" 2>/dev/null \
    || ! "$FSYNC_CMD" "$STATE_DIR"; then
    notify "🔥 merge-deploy: failed to write $STATE — its record of what is deployed may now disagree with production."
    exit 4
  fi
}

state_corrupt() {
  local d
  d=$(today)
  if [ "$(cat "$CORRUPT_NOTICE" 2>/dev/null)" != "$d" ]; then
    notify "🔥 merge-deploy: STATE CORRUPT — ${STATE}: ${STATE_PROBLEM}. Nothing runs until a human repairs the file; it is never taken for a first start."
    printf '%s\n' "$d" > "$CORRUPT_NOTICE" 2>/dev/null || echo "WARNING: could not record the notice in $CORRUPT_NOTICE"
  fi
  echo "STATE CORRUPT: ${STATE}: ${STATE_PROBLEM}" >&2
  exit 3
}

# A standing condition is reported at most once per UTC day, per marker.
once_a_day() {
  local var="$1" msg="$2" d
  d=$(today)
  [ "${!var}" != "$d" ] || return 0
  notify "$msg"
  printf -v "$var" '%s' "$d"
  write_state
}

# Plan b2 п.19: a failure is recorded against a commit only when it is the head of main (as this
# run fetched it): the tick deploys nothing else, so a record of an older commit — a manual deploy
# behind a head that already failed — would only overwrite the head's and let the tick redeploy
# it. A head that cannot be read records as before.
is_main_head() {
  local head
  head=$(git -C "$REPO" rev-parse -q --verify "origin/main^{commit}" 2>/dev/null) || return 0
  [ "$head" = "$1" ]
}

# A gate the COMMIT failed. Recorded, so the same head is never retried; the next merge is.
refuse() {
  notify "⛔ merge-deploy refused ${1:0:7}: $2$(way_back)"
  if is_main_head "$1"; then LAST_FAILED_SHA="$1"; fi
  write_state
  exit 1
}

# --- installed copies -----------------------------------------------------------------------------
# Plan п.15: what this deployer runs from outside the clone, each against the file it came from.
# All of them are readable by the operator; the sudoers file (0440) is not, and is not checked.
installed_is_stale() {
  [ -n "$INSTALLED_CHECK_BIN" ] || return 1
  # A check that is not there cannot say the copies are current: that is "cannot verify", which
  # waits like "stale" — never a silent pass.
  if [ ! -x "$INSTALLED_CHECK_BIN" ]; then
    STALE_REPORT="cannot verify the installed copies: the check ${INSTALLED_CHECK_BIN} is missing or not executable"
    return 0
  fi
  ! STALE_REPORT=$(timeout "$STEP_TIMEOUT_INSTALLED_S" "$INSTALLED_CHECK_BIN" "$REPO" origin/main \
      "deploy/image/autodeploy.sh=$0" \
      "deploy/read-env.sh=$READ_ENV_BIN" \
      "deploy/db-snapshot.sh=$SNAPSHOT_BIN" \
      "deploy/installed-current.sh=$INSTALLED_CHECK_BIN" \
      "deploy/image/helper/wbb_image.py=$IMAGE_LIB_DIR/wbb_image.py" \
      "deploy/image/helper/bounded.py=$IMAGE_LIB_DIR/bounded.py" \
      "deploy/image/helper/wbb-image.sh=$IMAGE_BIN" \
      "deploy/image/warsaw-beer-bot.container=$IMAGE_LIB_DIR/warsaw-beer-bot.container" 2>&1)
}

STALE_ADVICE="Run: sudo bash deploy/install-autodeploy.sh (the deployer) and sudo bash deploy/install-image.sh (the image helper)"
report_stale_once() {
  installed_is_stale || return 0
  once_a_day LAST_STALE_NOTICE "⚠️ merge-deploy: the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
${STALE_ADVICE}"
}

# --- holds ---------------------------------------------------------------------------------------
# Paths whose change needs a human on the host: root-installed files, units other than the bot's
# own, and every installed copy of this deployer and of the image helper (plan п.12). Changing
# this list is itself a hold (it lives here). Mirrored by isHoldPath in
# scripts/autodeploy/deploy-hold-check.ts; a parity test pins the two.
path_is_held() {
  case "$1" in
    deploy/warsaw-beer-bot.service) return 1 ;;
    deploy/sudoers.d/*|deploy/*.service|deploy/*.timer|deploy/*.path|deploy/litestream.*|deploy/install-*.sh) return 0 ;;
    deploy/rsync-filter) return 0 ;;
    deploy/autodeploy.sh|deploy/ships.sh|deploy/read-env.sh) return 0 ;;
    deploy/installed-current.sh|deploy/db-snapshot.sh|deploy/trial-migrate.cjs) return 0 ;;
    # This deployer, the root helper and the Quadlet template it renders: installed copies.
    deploy/image/autodeploy.sh|deploy/image/helper/*|deploy/image/warsaw-beer-bot.container) return 0 ;;
    scripts/ops/host_patch_collect.py) return 0 ;;
    scripts/ops/reboot_request.py) return 0 ;;
    *) return 1 ;;
  esac
}

add_unique() {
  local -n _arr="$1"
  local v="$2" e
  for e in "${_arr[@]}"; do
    if [ "$e" = "$v" ]; then return 0; fi
  done
  _arr+=("$v")
}

# Fills HOLDS (reasons) and RANGE_PRS (#n of every PR in DEPLOYED_SHA..$1).
# A failure to look is a hold, never a pass (fail closed).
# Plan b2 п.8, for a manual run, which skips the holds a human releases by running it: CONTRACT_PRS
# (the PRs whose code-only rollback is not proven safe) and SCAN_UNREAD=1 with the reasons in
# UNREAD (what could not be read could carry such a label). HOLDS keeps every reason as before;
# STEP_HOLDS is its part a human releases by running (a held path, deploy:hold), which bootstrap
# shows (plan b2 п.31).
scan_range() {
  local x="$1" paths commits back="" f start last
  HOLDS=()
  RANGE_PRS=()
  CONTRACT_PRS=()
  STEP_HOLDS=()
  UNREAD=()
  SCAN_UNREAD=0
  if ! paths=$(git -C "$REPO" -c core.quotePath=false diff --no-renames --name-only "$DEPLOYED_SHA" "$x"); then
    _unread "could not list the changed paths"
  fi
  while IFS= read -r f; do
    if [ -n "$f" ] && path_is_held "$f"; then
      HOLDS+=("path $f needs a human step")
      STEP_HOLDS+=("path $f needs a human step")
    fi
  done <<< "$paths"
  if ! commits=$(git -C "$REPO" rev-list "${DEPLOYED_SHA}..${x}"); then
    _unread "could not list the commits"
    return 0
  fi
  # Plan b2 п.20: a downgrade (forced by hand; the tick never scans one) removes the commits of
  # X..DEPLOYED_SHA, and running the old code on the database the new one migrated is exactly the
  # rollback their contract labels are about. Their labels are read too; nothing else of them counts.
  if ! git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$x" 2>/dev/null; then
    if ! back=$(git -C "$REPO" rev-list "${x}..${DEPLOYED_SHA}"); then
      _unread "could not list the commits the downgrade removes"
      return 0
    fi
  fi
  if ! start=$(uptime_now); then
    _unread "could not read the monotonic clock for the PR-label scan"
    return 0
  fi
  last=$start
  _scan_labels forward "$commits" || return 0
  _scan_labels removed "$back" || return 0
}
# The labels of one list of commits; `forward` ones are deployed (RANGE_PRS, holds), `removed` ones
# only count for CONTRACT_PRS. Shares scan_range's deadline (start, last). 1 when it ran out of time.
_scan_labels() {
  local dir="$1" commits="$2" c out pr labels l up
  while IFS= read -r c; do
    if [ -z "$c" ]; then continue; fi
    # A range too long to read in time is a hold, never a pass (a monotonic deadline).
    # Unreadable, or behind its previous reading: a clock that cannot bound the scan is a hold.
    if ! up=$(uptime_now) || [ "$up" -lt "$last" ]; then
      _unread "could not read the monotonic clock for the PR-label scan"
      return 1
    fi
    last=$up
    if [ $(( up - start )) -ge "$STEP_TIMEOUT_SCAN_S" ]; then
      _unread "could not read the PR labels of the whole range within ${STEP_TIMEOUT_SCAN_S}s"
      return 1
    fi
    if ! out=$("$PR_LABELS_CMD" "$c" 2>/dev/null); then
      _unread "could not read PR labels for ${c:0:7}"
      continue
    fi
    while IFS=$'\t' read -r pr labels; do
      if [ -z "$pr" ]; then continue; fi
      if [ "$dir" = forward ]; then
        add_unique RANGE_PRS "#$pr"
        case ",$labels," in
          *,deploy:hold,*)
            add_unique HOLDS "PR #$pr carries deploy:hold — https://github.com/${GH_REPO}/pull/$pr"
            add_unique STEP_HOLDS "PR #$pr carries deploy:hold — https://github.com/${GH_REPO}/pull/$pr" ;;
        esac
      fi
      # Spec §6.4: compatibility for a code-only rollback is not proven — a human deploys it,
      # and its window is manual (no automatic rollback).
      for l in rollback:unsafe migration:contract; do
        case ",$labels," in
          *",$l,"*)
            if [ "$dir" = forward ]; then
              add_unique HOLDS "PR #$pr carries $l — a code-only rollback is not proven safe; deploy it by hand with bash deploy/deploy.sh --ack-incompatible — https://github.com/${GH_REPO}/pull/$pr"
              add_unique CONTRACT_PRS "PR #$pr carries $l — https://github.com/${GH_REPO}/pull/$pr"
            else
              add_unique CONTRACT_PRS "PR #$pr carries $l and the downgrade removes it — https://github.com/${GH_REPO}/pull/$pr"
            fi ;;
        esac
      done
    done <<< "$out"
  done <<< "$commits"
}
# Something of the range could not be read: a hold for the timer, unknown for a manual run.
_unread() {
  add_unique HOLDS "$1"
  add_unique UNREAD "$1"
  SCAN_UNREAD=1
}

# #768: observe the recorded deployment, never infer runtime health from it. A durable recovery
# fence survives new main heads and partial recovery. Unlike daily notices, a failed transition
# notification stays pending.
observe_deployment() {
  [ -n "$DEPLOYED_SHA" ] || return 0
  local current previous kind commits c out pr labels count="unknown" pr_count="unknown" prs=() api_ok=1
  if ! current=$(git -C "$REPO" rev-parse --verify "${DEPLOYED_SHA}^{commit}" 2>/dev/null); then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: cannot assess the deployed transition — recorded production (${DEPLOYED_SHA:0:7}) is not a locally available commit. Keeping the previous observation; unattended deploys are blocked. Recover the Git history or deploy and verify intended main, then follow deploy/README.md → Operator acknowledgement of a replacement baseline."
    return 1
  fi
  if [ -z "$LAST_SEEN_DEPLOYED_SHA" ]; then
    LAST_SEEN_DEPLOYED_SHA="$current"
    write_state
  elif [ "$current" != "$LAST_SEEN_DEPLOYED_SHA" ]; then
    if ! previous=$(git -C "$REPO" rev-parse --verify "${LAST_SEEN_DEPLOYED_SHA}^{commit}" 2>/dev/null); then
      once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: cannot assess the deployed transition — previous observation (${LAST_SEEN_DEPLOYED_SHA:0:7}) is not a locally available commit. Keeping it; unattended deploys are blocked. Recover the Git history or deploy and verify intended main, then follow deploy/README.md → Operator acknowledgement of a replacement baseline."
      return 1
    fi
    if ! git -C "$REPO" merge-base --is-ancestor "$previous" "$current"; then
      kind="DIVERGED"
      if git -C "$REPO" merge-base --is-ancestor "$current" "$previous"; then
        kind="went BACKWARDS"
      fi
      REGRESSION_FROM_SHA="${REGRESSION_FROM_SHA:-$previous}"
      REGRESSION_TO_SHA="$current"
      LAST_HOLD_NOTICE=""
      # Persist the brake before GitHub or Telegram can fail.
      write_state
      if commits=$(git -C "$REPO" rev-list "${current}..${previous}" 2>/dev/null); then
        count=0
        while IFS= read -r c; do
          [ -n "$c" ] || continue
          count=$(( count + 1 ))
          if ! out=$("$PR_LABELS_CMD" "$c" 2>/dev/null); then
            api_ok=0
            continue
          fi
          while IFS=$'\t' read -r pr labels; do
            if [ -n "$pr" ]; then add_unique prs "$pr"; fi
          done <<< "$out"
        done <<< "$commits"
        if [ "$api_ok" -eq 1 ]; then pr_count=${#prs[@]}; fi
      fi
      # Bounded (short SHAs, counts, fixed prose). A successful send is required before the
      # observation advances, so this one does not go through notify().
      if ! "$NOTIFY_CMD" "⚠️ merge-deploy: production ${kind}: ${previous:0:7} → ${current:0:7} (${count} commits, ${pr_count} PRs no longer reachable) — was this a deliberate rollback? Unattended deploys are HELD. Deploy main by hand to recover."; then
        echo "WARNING: production regression notification failed; will retry next tick."
        return 1
      fi
    fi
    LAST_SEEN_DEPLOYED_SHA="$current"
    write_state
  fi
  if [ -n "$REGRESSION_FROM_SHA" ] \
     && git -C "$REPO" merge-base --is-ancestor "$REGRESSION_FROM_SHA" "$current"; then
    REGRESSION_FROM_SHA=""
    REGRESSION_TO_SHA=""
    LAST_HOLD_NOTICE=""
    write_state
  fi
}

report_regression_hold() {
  local reasons=""
  # Divergent production has no ordinary deployable range; the regression itself still holds.
  if git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$X"; then
    scan_range "$X"
    if [ "${#HOLDS[@]}" -gt 0 ]; then reasons=$(printf '\n• %s' "${HOLDS[@]}"); fi
  fi
  once_a_day LAST_HOLD_NOTICE "⏸ merge-deploy: production is HELD: observed production regression ${REGRESSION_FROM_SHA:0:7} → ${REGRESSION_TO_SHA:0:7}; currently ${DEPLOYED_SHA:0:7}. A deliberate rollback must not be overwritten automatically.${reasons}
Deploy main by hand (bash deploy/deploy.sh; --force if histories diverge) if it contains ${REGRESSION_FROM_SHA:0:7}. If main omits that commit, verify intended production and follow deploy/README.md → Operator acknowledgement of a replacement baseline."
}

# --- CI ---------------------------------------------------------------------------------------------
# PASS | WAIT | FAIL <name=conclusion ...>. Non-zero = could not read.
# Plan п.8: `ci` AND `image` must both have succeeded IN ONE check suite — the image this
# deploys was built by the run that tested this commit. Either absent, or only in different
# suites, is WAIT; a failed `image` is FAIL like any other failed check.
ci_verdict() {
  local out line name status conclusion suite pending=0 failed=() ci_suites=" " image_suites=" " s
  local re=$'^([^\t]*)\t([^\t]*)\t([^\t]*)\t([^\t]*)$'
  out=$("$CHECKS_CMD" "$1") || return 1
  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    # Exactly four fields: a line of another shape is not something to judge from.
    [[ $line =~ $re ]] || return 1
    name="${BASH_REMATCH[1]}"
    status="${BASH_REMATCH[2]}"
    conclusion="${BASH_REMATCH[3]}"
    suite="${BASH_REMATCH[4]}"
    if [ "$status" != completed ]; then pending=1; continue; fi
    case "$conclusion" in
      success|skipped|neutral) ;;
      *) failed+=("${name}=${conclusion}") ;;
    esac
    if [ "$conclusion" = success ] && [ -n "$suite" ]; then
      case "$name" in
        ci) ci_suites+="$suite " ;;
        image) image_suites+="$suite " ;;
      esac
    fi
  done <<< "$out"
  if [ "${#failed[@]}" -gt 0 ]; then echo "FAIL ${failed[*]}"; return 0; fi
  if [ "$pending" = 1 ]; then echo WAIT; return 0; fi
  for s in $ci_suites; do
    case "$image_suites" in *" $s "*) echo PASS; return 0 ;; esac
  done
  echo WAIT
}

# --- the image -------------------------------------------------------------------------------------
# One helper call: IMG_VERDICT is its normalized verdict (parse_verdict).
image_call() {
  local action="$1" out err rc errf="$TICK_TMP/helper-stderr"
  out=$("$IMAGE_CMD" "$@" 2>"$errf") && rc=0 || rc=$?
  err=$(cat "$errf" 2>/dev/null || true)
  IMG_ERR="$err"
  IMG_VERDICT=$(parse_verdict "$action" "$rc" "$out" "$err")
}

# Plan п.6: the tag is a hint, not a fact. Sets D.
resolve_digest() {
  local out rc
  out=$("$RESOLVE_CMD" "$X" 2>/dev/null) && rc=0 || rc=$?
  if [ "$rc" -eq 3 ]; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: no image is published for ${X:0:7} (no tag ${X} in ${IMAGE_REPOSITORY}) — waiting; NOT a finding against the commit."
  fi
  if [ "$rc" -ne 0 ] || ! [[ $out =~ ^sha256:[0-9a-f]{64}$ ]]; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not resolve the image of ${X:0:7} (exit ${rc}) — NOT a finding; retrying next tick."
  fi
  D="$out"
}

# Spec §1 п.2: without a passing attestation the helper is never asked to pull D. A failure
# cannot tell "not ours" from "Sigstore unreachable" (P2), so it is not a verdict on X.
attest_image() {
  local out rc
  out=$("$ATTEST_CMD" "$D" "$X" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    halt LAST_ASSESS_NOTICE "⛔ merge-deploy: the image of ${X:0:7} (${D}) did not pass attestation (exit ${rc}) — not deploying it; NOT recorded as a failed commit.
$(tail -n 5 <<< "$out")"
  fi
}

# PULLED with exactly the D and X that were asked for, or "could not verify" (plan п.9).
# Sets CAND_ID and CAND_CONTENT.
pull_candidate() {
  local kind d i c x
  image_call pull --sha "$X" --digest "$D"
  read -r kind d i c x <<< "$IMG_VERDICT"
  if [ "$kind" != PULLED ] || [ "$d" != "$D" ] || [ "$x" != "$X" ]; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: the image of ${X:0:7} (${D}) was not pulled as asked: ${IMG_VERDICT} — NOT a finding; retrying next tick."
  fi
  CAND_ID="$i"
  CAND_CONTENT="$c"
}

# Sets CUR_QUADLET, CUR_IMAGE, CUR_DIGEST, CUR_UNIT.
read_current() {
  local kind
  image_call current
  read -r kind CUR_QUADLET CUR_IMAGE CUR_DIGEST CUR_UNIT <<< "$IMG_VERDICT"
  if [ "$kind" != CURRENT ]; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not read what production runs: ${IMG_VERDICT} — not deploying ${X:0:7}; retrying next tick."
  fi
}

# What `current` read is the recorded deployment, run from our Quadlet.
production_is_record() {
  [ "$CUR_UNIT" = quadlet ] && [ "$CUR_QUADLET" = "$DEPLOYED_DIGEST" ] \
    && [ "$CUR_DIGEST" = "$DEPLOYED_DIGEST" ] && [ "$CUR_IMAGE" = "$DEPLOYED_ID" ]
}
record_mismatch() {
  printf 'expected quadlet=%s container-image=%s container-digest=%s unit=quadlet, found quadlet=%s container-image=%s container-digest=%s unit=%s' \
    "$DEPLOYED_DIGEST" "$DEPLOYED_ID" "$DEPLOYED_DIGEST" "$CUR_QUADLET" "$CUR_IMAGE" "$CUR_DIGEST" "$CUR_UNIT"
}

# Spec §4.1, plan п.7: equal wbb.content means X changes nothing that runs — but only if what
# runs IS the recorded deployment. Never returns when it decides; returns to deploy otherwise.
noop_or_continue() {
  local keeps
  [ -n "$DEPLOYED_CONTENT" ] && [ "$CAND_CONTENT" = "$DEPLOYED_CONTENT" ] || return 0
  if ! production_is_record; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: ${X:0:7} changes nothing that runs (wbb.content ${CAND_CONTENT}), but production does not match the record: $(record_mismatch). Not recording it as deployed; check the host."
  fi
  # Advancing DEPLOYED_SHA is the point: a hold released by a manual deploy of a noop commit
  # would otherwise never be released (plan п.7).
  DEPLOYED_SHA="$X"
  observed "$X"
  write_state
  keeps=(--keep "$DEPLOYED_DIGEST")
  if [ "$SETTLED_DIGEST" != "$DEPLOYED_DIGEST" ]; then keeps+=(--keep "$SETTLED_DIGEST"); fi
  image_call prune "${keeps[@]}"
  case "$IMG_VERDICT" in
    PRUNED\ *) ;;
    *) echo "WARNING: image prune: ${IMG_VERDICT}" ;;
  esac
  echo "main $X changes nothing that runs (wbb.content ${CAND_CONTENT}); recorded as deployed"
  exit 0
}

# --- the path to production (plan п.9–14) -----------------------------------------------------------
# Plan b2 п.11, п.18 (#768): LAST_SEEN_DEPLOYED_SHA records only PROVEN forward motion — a settled or
# noop X that descends from the last observation (or equals it, or there is none). Anything else —
# an activation, a rollback, a manual run, a downgrade a tick only finished, a git that cannot
# answer — leaves it, and the next tick's observe_deployment judges the transition: forward
# quietly, backwards with the fence. So a downgrade forced by hand is fenced even when its window
# was interrupted and the timer settled it.
observed() {
  [ "$MANUAL" = 0 ] || return 0
  if [ -z "$LAST_SEEN_DEPLOYED_SHA" ] || [ "$LAST_SEEN_DEPLOYED_SHA" = "$1" ] \
     || git -C "$REPO" merge-base --is-ancestor "$LAST_SEEN_DEPLOYED_SHA" "$1" 2>/dev/null; then
    LAST_SEEN_DEPLOYED_SHA="$1"
  fi
}
# Every key of an open window (spec §7.1). Cleared together when the window ends in any way.
clear_window() {
  local k
  for k in "${WINDOW_KEYS[@]}"; do printf -v "$k" '%s' ''; done
  ROLLBACK_ATTEMPTS=""
  ACTIVATE_ATTEMPTS=""
}

# Plan п.11: "running" is ActiveState=active, SubState=running and MainPID != 0 — `current` reads
# the container's ids, which a stopped container keeps. 0 running, 1 not running, 2 could not read.
unit_running() {
  local out line as="" ss="" pid=""
  out=$("$UNIT_STATE_CMD" 2>/dev/null) || return 2
  while IFS= read -r line; do
    case "$line" in
      ActiveState=*) as="${line#*=}" ;;
      SubState=*) ss="${line#*=}" ;;
      MainPID=*) pid="${line#*=}" ;;
    esac
  done <<< "$out"
  if [ -z "$as" ] || [ -z "$ss" ] || ! [[ $pid =~ ^[0-9]+$ ]]; then return 2; fi
  if [ "$as" = active ] && [ "$ss" = running ] && [ "$pid" != 0 ]; then return 0; fi
  return 1
}
# /health's releaseSha, or exit 1.
read_health() {
  local sha
  sha=$("$HEALTH_CMD" "$PORT" 2>/dev/null) || return 1
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s\n' "$sha"
}
# systemd's NRestarts, or exit 1.
read_restarts() {
  local r
  r=$("$RESTARTS_CMD" 2>/dev/null) || return 1
  [[ $r =~ ^(0|[1-9][0-9]{0,17})$ ]] || return 1
  printf '%s\n' "$r"
}

# Plan п.14: the pre snapshot of a failed window is evidence for a human. mark-rollback RENAMES it
# and prints the new name; that name — not the old WINDOW_PRE — is what is retained. Only stdout
# counts, and only the one name the rename can produce. A tick that died between the rename and
# its write left exactly that: the expected name exists and the original is gone. Sets PRE_NOTE.
# Marks $1 with mark-rollback; 0 and MARKED=<the new name> when that is exactly the rename's name
# (or the rename already happened: the original gone, the new name there), 1 otherwise.
mark_pre() {
  local out
  MARKED="${1%-pre.db}-rollback-pre.db"
  if [ ! -e "$1" ] && [ -e "$MARKED" ]; then
    echo "the pre snapshot was already marked: $MARKED"
    return 0
  fi
  out=$("$MARK_CMD" "$1" 2>/dev/null) && [ "$(tail -n 1 <<< "$out")" = "$MARKED" ]
}
# Appends $2 to the list variable named $1 unless it is in it (element by element, no globbing).
_list_add() {
  local -a items
  local item
  read -r -a items <<< "${!1}"
  for item in "${items[@]}"; do
    if [ "$item" = "$2" ]; then return 0; fi
  done
  items+=("$2")
  printf -v "$1" '%s' "${items[*]}"
}
retain() { _list_add RETAINED_PRE "$1"; }
retain_pre() {
  case "$WINDOW_PRE" in
    '') PRE_NOTE="none (the window had no pre snapshot)"; return 0 ;;
    *-rollback-pre.db) PRE_NOTE="$WINDOW_PRE (kept until a human removes it: rm $WINDOW_PRE $WINDOW_PRE.sha256)"; return 0 ;;
  esac
  if ! mark_pre "$WINDOW_PRE"; then
    # The evidence must not be lost to a failed mark: it is remembered, retried by every tick
    # before anything else, and no snapshot prune runs until it is marked.
    _list_add PENDING_MARK "$WINDOW_PRE"
    PRE_NOTE="NOT marked yet (mark-rollback did not answer ${MARKED}); retried every tick, and snapshots are not pruned until it is: $WINDOW_PRE"
    return 0
  fi
  WINDOW_PRE="$MARKED"
  retain "$MARKED"
  PRE_NOTE="$MARKED (kept until a human removes it: rm $MARKED $MARKED.sha256)"
}
# Every tick, first: a pre whose mark failed is marked now, if it can be.
retry_pending_marks() {
  local -a items left=()
  local p changed=0 tried=0
  [ -n "$PENDING_MARK" ] || return 0
  read -r -a items <<< "$PENDING_MARK"
  for p in "${items[@]}"; do
    # Bounded per tick (plan п.17): the rest waits for the next tick.
    if [ "$tried" -ge "$PENDING_MARK_MAX_PER_TICK" ]; then
      left+=("$p")
      continue
    fi
    tried=$(( tried + 1 ))
    if mark_pre "$p"; then
      retain "$MARKED"
      if [ "$WINDOW_PRE" = "$p" ]; then WINDOW_PRE="$MARKED"; fi
      changed=1
    else
      left+=("$p")
      echo "WARNING: could not mark $p yet; snapshot pruning waits for it"
    fi
  done
  if [ "$changed" = 1 ]; then
    PENDING_MARK="${left[*]:-}"
    write_state
  fi
}

# Spec §7.3: production needs a human. The FIRST write is the incident itself (and, when X is to
# blame, LAST_FAILED_SHA), with the window still in the state — so nothing after it, a kill
# included, can let the window settle or roll back. Then the pre is marked, and the second write
# keeps it and clears the window. $1: 1 when the failure is X's (a failed window, a failed
# rollback); 0 when it is the host's (a foreign unit, an unknown Quadlet, activations that never
# complete). Never returns.
open_incident() {
  local blame="$1" reason="${2//$'\n'/ }" x="$WINDOW_SHA" d="$WINDOW_DIGEST" mode="$WINDOW_MODE" out
  # Plan b2 п.28: after a failed first image release there may be nothing of ours to settle — the
  # human may have brought the old unit and the flat tree back instead.
  out="bash deploy/deploy.sh --resolve-incident --settled <sha>"
  if [ "$WINDOW_KIND" = bootstrap ]; then
    out="bash deploy/deploy.sh --resolve-incident --settled <sha> (an image of ours runs from the Quadlet file), or bash deploy/deploy.sh --resolve-incident --flat (the old unit and the flat tree run again)"
  fi
  if [ "$blame" = 1 ] && is_main_head "$x"; then LAST_FAILED_SHA="$x"; fi
  INCIDENT="$x $d $reason"
  write_state
  retain_pre
  clear_window
  write_state
  notify "🔥 merge-deploy INCIDENT: ${x:0:7} (${d}) — ${reason}. Nothing was rolled back automatically$([ "$mode" = manual ] && printf ' (a manual window)'); the database is untouched.
Pre-deploy snapshot: ${PRE_NOTE}
Nothing deploys until a human restores production and runs: ${out}"
  exit 3
}

# What `current`, the unit and /health say about the settled image S: 0 it runs and answers,
# 1 it does not, 2 could not be read (`current` or the unit state), 3 the unit is not our Quadlet.
settled_is_running() {
  local kind q i d u urc=0
  image_call current
  read -r kind q i d u <<< "$IMG_VERDICT"
  [ "$kind" = CURRENT ] || return 2
  if [ "$u" = foreign ]; then return 3; fi
  [ "$u" = quadlet ] && [ "$q" = "$SETTLED_DIGEST" ] && [ "$d" = "$SETTLED_DIGEST" ] && [ "$i" = "$SETTLED_ID" ] || return 1
  unit_running || urc=$?
  if [ "$urc" = 2 ]; then return 2; fi
  [ "$urc" = 0 ] || return 1
  [ "$(read_health || true)" = "$SETTLED_SHA" ] || return 1
}
# The fact before an attempt: an unreadable answer is neither "S runs" nor "S does not run" — it is
# waited for, up to STARTUP_S, without counting an attempt. Returns as settled_is_running.
settled_fact() {
  local start rc
  start=$(now)
  while :; do
    rc=0
    settled_is_running || rc=$?
    if [ "$rc" != 2 ]; then return "$rc"; fi
    if [ $(( $(now) - start )) -ge "$STARTUP_S" ]; then return 2; fi
    "$SLEEP_CMD" "$POLL_S"
  done
}

# Up to STARTUP_S for S to run and answer. 0 yes, 1 no; the unit turning foreign is an incident.
wait_for_settled() {
  local start rc
  start=$(now)
  while :; do
    rc=0
    settled_is_running || rc=$?
    if [ "$rc" = 0 ]; then return 0; fi
    if [ "$rc" = 3 ]; then open_incident 0 "the unit is no longer our Quadlet (unit=foreign) during the rollback"; fi
    if [ $(( $(now) - start )) -ge "$STARTUP_S" ]; then return 1; fi
    "$SLEEP_CMD" "$POLL_S"
  done
}

# Spec §1 п.5: the settled image runs again on the same database. Never returns.
rolled_back() {
  local x="$WINDOW_SHA" old="$WINDOW_OLD" reason="$WINDOW_REASON" pre="${PRE_NOTE:-$WINDOW_PRE}"
  DEPLOYED_SHA="$old"
  DEPLOYED_DIGEST="$SETTLED_DIGEST"
  DEPLOYED_ID="$SETTLED_ID"
  DEPLOYED_CONTENT="$SETTLED_CONTENT"
  clear_window
  write_state
  notify "🔥 merge-deploy ROLLED BACK ${x:0:7} → ${SETTLED_SHA:0:7} (code only, DB untouched): ${reason}.
Whatever ${x:0:7} migrated or wrote is still in the database.
Pre-deploy snapshot: ${pre}"
  exit 2
}

# Plan п.13 steps 3–5: before EVERY attempt, the fact first — S already running and answering
# finishes the rollback without restarting it again. The attempt counter is in the state and
# written BEFORE each `activate S`, so no interruption lets S be restarted more than twice.
rollback_loop() {
  local rc
  while :; do
    rc=0
    settled_fact || rc=$?
    if [ "$rc" = 3 ]; then open_incident 0 "the unit is no longer our Quadlet (unit=foreign) during the rollback"; fi
    if [ "$rc" = 0 ]; then rolled_back; fi
    if [ "$rc" = 2 ]; then
      open_incident 1 "could not read whether ${SETTLED_SHA:0:7} runs for ${STARTUP_S}s during the rollback (${WINDOW_REASON})"
    fi
    if [ "${ROLLBACK_ATTEMPTS:-0}" -ge "$ROLLBACK_ATTEMPTS_MAX" ]; then
      open_incident 1 "the rollback to ${SETTLED_SHA:0:7} did not bring it up after ${ROLLBACK_ATTEMPTS} attempts (${WINDOW_REASON})"
    fi
    ROLLBACK_ATTEMPTS=$(( ${ROLLBACK_ATTEMPTS:-0} + 1 ))
    write_state
    image_call activate --digest "$SETTLED_DIGEST"
    if [ "$IMG_VERDICT" = "ACTIVATED $SETTLED_DIGEST" ]; then
      if wait_for_settled; then rolled_back; fi
    else
      echo "activate ${SETTLED_DIGEST}: ${IMG_VERDICT}"
      "$SLEEP_CMD" "$ROLLBACK_RETRY_S"
    fi
  done
}

# Plan п.13: the window failed. auto → code-only rollback; manual → incident. Never returns.
window_failed() {
  local reason="${1//$'\n'/ }"
  # Plan b2 п.13: a resolve window watches the image the human named, not a candidate — its failure
  # is an incident again, and no commit is to blame for it.
  if [ "$WINDOW_KIND" = resolve ]; then open_incident 0 "the resolve window failed: ${reason}"; fi
  if [ "$WINDOW_MODE" = manual ]; then open_incident 1 "the manual window failed: ${reason}"; fi
  # The FIRST write: whatever happens below, X is not retried.
  if is_main_head "$WINDOW_SHA"; then LAST_FAILED_SHA="$WINDOW_SHA"; fi
  WINDOW_PHASE=rolling-back
  WINDOW_REASON="$reason"
  ROLLBACK_ATTEMPTS=0
  write_state
  notify "⚠️ merge-deploy ${WINDOW_SHA:0:7} failed inside its window: ${reason} — rolling back to ${SETTLED_SHA:0:7} (code only; the database is not touched)."
  retain_pre
  write_state
  rollback_loop
}

# The window's start or a fresh one: lost evidence is neither a pass nor a failure (plan п.11).
# A watched window stands on an NRestarts base (F7): it is read before `watching` is written,
# and a base that cannot be read for OBSERVE_MAX_S is a window that cannot be observed.
# $1 = compare: the start after an activation. `activate` always ends in `systemctl restart`, and a
# restart resets NRestarts to 0 while daemon-reload leaves it alone (spec V14), so from here on the
# counter counts the candidate's own restarts: above 0 means it already restarted.
start_watching() {
  local r start
  start=$(now)
  until r=$(read_restarts); do
    if [ $(( $(now) - start )) -ge "$OBSERVE_MAX_S" ]; then
      window_failed "could not observe production: NRestarts unreadable for $(( $(now) - start ))s at the start of the window"
    fi
    "$SLEEP_CMD" "$POLL_S"
  done
  if [ "${1:-}" = compare ] && [ "$r" -gt 0 ]; then
    window_failed "the candidate restarted during startup (NRestarts ${r} since its activation)"
  fi
  WINDOW_PHASE=watching
  WINDOW_START=$(now)
  WINDOW_LAST_READ="$WINDOW_START"
  WINDOW_FAILS=0
  WINDOW_NRESTARTS="$r"
  write_state
}
new_window() {
  start_watching
  notify "⚠️ merge-deploy ${WINDOW_SHA:0:7}: the window lost its evidence ($1) — watching a full ${WINDOW_S}s window again from now."
}

# Spec §7.1: settled — D becomes the rollback target. Never returns.
settle() {
  local x="$WINDOW_SHA" d="$WINDOW_DIGEST" prs="${RANGE_PRS[*]:-}" kind="$WINDOW_KIND"
  PREVIOUS_SHA="$WINDOW_OLD"
  DEPLOYED_SHA="$x"
  # What runs is the window's image — after an activation already recorded, after a resolve not.
  DEPLOYED_DIGEST="$d"
  DEPLOYED_ID="$WINDOW_ID"
  DEPLOYED_CONTENT="$WINDOW_CONTENT"
  if [ "$kind" = resolve ]; then
    # Plan b2 п.13: the human just named the base — the one transition recorded as observed without
    # proof of forward motion (#768 would only fence what he decided). Keyed on the window, not on
    # MANUAL: a tick that finishes an interrupted resolve records it the same.
    LAST_SEEN_DEPLOYED_SHA="$x"
    # Plan b2 п.24: a pre whose mark never succeeded is an ordinary unmarked snapshot, and the
    # incident it was evidence for is closed — it is no longer pending, and pruning resumes.
    PENDING_MARK=""
  else
    observed "$x"
  fi
  # Plan b2 п.12: X that failed before has now passed a full window — the record is no longer
  # true of it. (Only a manual run deploys a failed SHA; a tick that finishes its window clears it too.)
  if [ "$LAST_FAILED_SHA" = "$x" ]; then LAST_FAILED_SHA=""; fi
  SETTLED_SHA="$x"
  SETTLED_DIGEST="$d"
  SETTLED_ID="$WINDOW_ID"
  SETTLED_CONTENT="$WINDOW_CONTENT"
  clear_window
  write_state
  image_call prune --keep "$d"
  case "$IMG_VERDICT" in PRUNED\ *) ;; *) echo "WARNING: image prune: ${IMG_VERDICT}" ;; esac
  # Spec §7.3: the incident is closed, its evidence is no longer needed — only now, after the
  # settled write, never before (a failed resolve window keeps every pre retained).
  if [ "$kind" = resolve ]; then release_retained; fi
  local skipped=""
  if [ -n "$PENDING_MARK" ]; then
    skipped=" Snapshot pruning skipped: not yet marked ${PENDING_MARK}."
  else
    "$PRUNE_CMD" || echo "WARNING: snapshot pruning failed"
  fi
  if [ "$kind" = resolve ]; then
    notify "✅ merge-deploy: the incident is resolved — ${x:0:7} is live and settled.${skipped}${RELEASE_NOTE}"
  elif [ "$kind" = bootstrap ]; then
    notify "✅ merge-deploy: the first image release ${x:0:7} is live and settled — from now on the timer deploys main against it.${skipped}"
  else
    notify "✅ merge-deploy ${x:0:7} is live and settled${prs:+ — $prs}.${skipped}"
  fi
  exit 0
}

# Plan b2 п.13: each RETAINED_PRE back to ordinary retention with db-snapshot.sh unmark. Only the
# one name the rename can produce counts (as mark_pre); a rename that already happened (the
# original gone, the new name there) counts too. What is not unmarked stays retained, and is named.
# Sets RELEASE_NOTE.
release_retained() {
  local -a items back=() left=() gone=()
  local p want out n=0
  RELEASE_NOTE=""
  [ -n "$RETAINED_PRE" ] || return 0
  read -r -a items <<< "$RETAINED_PRE"
  for p in "${items[@]}"; do
    want="${p%-rollback-pre.db}-pre.db"
    # Plan b2 п.23: what is not there any more — removed by the human, as the incident notice
    # suggests — leaves the list without a call, and without eating the limit.
    if [ ! -e "$p" ] && [ ! -e "$want" ]; then
      gone+=("$p")
      continue
    fi
    if [ ! -e "$p" ] && [ -e "$want" ]; then
      back+=("$want")
      continue
    fi
    if [ "$n" -ge "$UNMARK_MAX_PER_RUN" ]; then
      left+=("$p")
      continue
    fi
    n=$(( n + 1 ))
    if out=$("$UNMARK_CMD" "$p" 2>/dev/null) && [ "$(tail -n 1 <<< "$out")" = "$want" ]; then
      echo "returned to ordinary retention: $want"
      back+=("$want")
    else
      left+=("$p")
    fi
  done
  RETAINED_PRE="${left[*]:-}"
  write_state
  if [ "${#back[@]}" -gt 0 ]; then RELEASE_NOTE+=$'\n'"Back in ordinary retention: ${back[*]}"; fi
  if [ "${#gone[@]}" -gt 0 ]; then RELEASE_NOTE+=$'\n'"Already removed: ${gone[*]}"; fi
  if [ "${#left[@]}" -gt 0 ]; then
    RELEASE_NOTE+=$'\n'"Still retained — not unmarked; by hand: db-snapshot.sh unmark <path>: ${left[*]}"
  fi
}

# Plan п.11: a poll every POLL_S reads health, NRestarts, the unit state and `current`, and its
# outcome is in the state before the next one (WINDOW_FAILS, WINDOW_LAST_READ), so a killed tick
# loses none of it. $1: 1 when the application has already been seen up. Never returns.
watch_window() {
  local started="$1" t_now t hs hok r urc kind q i d u cur full sick
  while :; do
    t_now=$(now)
    if [ "$t_now" -lt "$WINDOW_START" ] || [ "$t_now" -lt "$WINDOW_LAST_READ" ]; then
      new_window "the clock went back: now ${t_now}, window start ${WINDOW_START}, last read ${WINDOW_LAST_READ}"
      continue
    fi
    t=$(( t_now - WINDOW_START ))
    hs=$(read_health) && hok=1 || hok=0
    r=$(read_restarts) || r=""
    urc=0
    unit_running || urc=$?
    image_call current
    read -r kind q i d u <<< "$IMG_VERDICT"
    cur=0
    if [ "$kind" = CURRENT ]; then cur=1; fi
    # A poll is read in full when current, NRestarts and the unit state all answered — whatever
    # they say; recorded before any verdict, so the state says what this poll saw.
    full=0
    if [ -n "$r" ] && [ "$urc" != 2 ] && [ "$cur" = 1 ]; then full=1; WINDOW_LAST_READ="$t_now"; fi
    if [ "$cur" = 1 ] && [ "$u" = foreign ]; then
      open_incident 0 "the unit is no longer our Quadlet (unit=foreign) at +${t}s of the window of ${WINDOW_SHA:0:7}"
    fi
    if [ "$cur" = 1 ] && { [ "$q" != "$WINDOW_DIGEST" ] || { [ "$d" != none ] && { [ "$d" != "$WINDOW_DIGEST" ] || [ "$i" != "$WINDOW_ID" ]; }; }; }; then
      window_failed "production runs another image (quadlet=${q} container-image=${i} container-digest=${d}) at +${t}s"
    fi
    if [ -n "$r" ]; then
      if [ -z "$WINDOW_NRESTARTS" ]; then
        WINDOW_NRESTARTS="$r"
      elif [ "$r" -gt "$WINDOW_NRESTARTS" ]; then
        window_failed "service restarted (NRestarts ${WINDOW_NRESTARTS} -> ${r}) at +${t}s"
      elif [ "$r" -lt "$WINDOW_NRESTARTS" ]; then
        new_window "NRestarts went down in the same boot (${WINDOW_NRESTARTS} -> ${r})"
        continue
      fi
    fi
    # A failed health: no answer, the unit not running, or no container at all.
    sick=0
    if [ "$hok" = 0 ] || [ "$urc" = 1 ] || { [ "$cur" = 1 ] && [ "$d" = none ]; }; then sick=1; fi
    if [ "$sick" = 1 ]; then
      if [ "$started" = 1 ]; then WINDOW_FAILS=$(( WINDOW_FAILS + 1 )); fi
    elif [ "$hs" != "$WINDOW_SHA" ]; then
      if [ "$started" = 1 ]; then window_failed "/health answers releaseSha ${hs:0:7}, not ${WINDOW_SHA:0:7}, at +${t}s"; fi
    elif [ "$urc" = 0 ]; then
      started=1
      WINDOW_FAILS=0
    fi
    if [ "$started" = 0 ] && [ "$t" -ge "$STARTUP_S" ]; then
      window_failed "not healthy within ${STARTUP_S}s"
    fi
    if [ "$WINDOW_FAILS" -ge "$HEALTH_FAILS_MAX" ]; then
      window_failed "health check failed ${WINDOW_FAILS} times in a row (last at +${t}s)"
    fi
    write_state
    if [ $(( t_now - WINDOW_LAST_READ )) -ge "$OBSERVE_MAX_S" ]; then
      window_failed "could not observe production for $(( t_now - WINDOW_LAST_READ ))s (current, NRestarts or the unit state unreadable)"
    fi
    # Settled only on a poll that was read in full and is clean, at t >= WINDOW_S.
    if [ "$t" -ge "$WINDOW_S" ] && [ "$full" = 1 ] && [ "$started" = 1 ] && [ "$sick" = 0 ] \
       && [ "$hs" = "$WINDOW_SHA" ] && [ "$urc" = 0 ]; then
      settle
    fi
    "$SLEEP_CMD" "$POLL_S"
  done
}

# The window was written but nothing changed production: it is cancelled, the pre discarded.
# $2 = loud (plan b2 п.27): the tick cancelled a first image release — the old bot is stopped and
# nothing of ours runs, so production may be down: told every time, never muted by the daily marker.
cancel_window() {
  local pre="$WINDOW_PRE"
  "$DISCARD_CMD" "$pre" >/dev/null 2>&1 || echo "WARNING: could not discard $pre"
  clear_window
  write_state
  if [ "${2:-}" = loud ] && [ "$MANUAL" = 0 ]; then
    notify "$1"
    exit 0
  fi
  halt LAST_ASSESS_NOTICE "$1"
}

# Plan п.9, the activate rows. Each `activate D` is counted in the state BEFORE it runs: a window
# whose activation never completes (75 after 75, or REFUSED with the Quadlet file naming D) stops
# at ACTIVATE_ATTEMPTS_MAX and is a human's — what runs is unknown, not X's fault.
activate_candidate() {
  local kind q i d u why
  if [ "${ACTIVATE_ATTEMPTS:-0}" -ge "$ACTIVATE_ATTEMPTS_MAX" ]; then
    image_call current
    read -r kind q i d u <<< "$IMG_VERDICT"
    if [ "$kind" = CURRENT ]; then
      open_incident 0 "the activation of ${X:0:7} did not complete after ${ACTIVATE_ATTEMPTS} attempts; production: quadlet=${q} container-digest=${d} unit=${u}"
    fi
    open_incident 0 "the activation of ${X:0:7} did not complete after ${ACTIVATE_ATTEMPTS} attempts; what production runs could not be read (${IMG_VERDICT})"
  fi
  ACTIVATE_ATTEMPTS=$(( ${ACTIVATE_ATTEMPTS:-0} + 1 ))
  write_state
  image_call activate --digest "$D"
  case "$IMG_VERDICT" in
    "ACTIVATED $D")
      DEPLOYED_SHA="$X"
      DEPLOYED_DIGEST="$D"
      DEPLOYED_ID="$CAND_ID"
      DEPLOYED_CONTENT="$CAND_CONTENT"
      start_watching compare
      watch_window 0
      ;;
    ACTIVATE_FAILED\ *)
      window_failed "the activation failed: ${IMG_VERDICT#ACTIVATE_FAILED }"
      ;;
    REFUSED\ *)
      # Cancelled only when production is provably S, as before the window.
      why="${IMG_VERDICT#REFUSED }"
      image_call current
      read -r kind q i d u <<< "$IMG_VERDICT"
      if [ "$kind" != CURRENT ]; then
        halt_window LAST_ASSESS_NOTICE "⚠️ merge-deploy: the activation of ${X:0:7} was refused (${why}) and what production runs could not be read: ${IMG_VERDICT}. The window stays open; the next tick looks again."
      fi
      if [ "$u" = foreign ]; then
        open_incident 0 "the unit is not our Quadlet (unit=foreign); the activation was refused"
      fi
      # Before a bootstrap window nothing ran from a Quadlet file: "unchanged" is none (plan b2 п.16).
      if [ "$q" = "${WINDOW_PREV_DIGEST:-none}" ] && [ "$d" = "${WINDOW_PREV_DIGEST:-none}" ]; then
        # Plan b2 п.27: the tick that re-activates a first image release (row 2) cannot retry it — only
        # the human can, and the old bot is stopped. A manual run says "run again" (and the way back).
        if [ "$WINDOW_KIND" = bootstrap ] && [ "$MANUAL" = 0 ]; then
          cancel_window "⚠️ merge-deploy: the activation of ${X:0:7} was refused and changed nothing: ${why} — production may be down — run bash deploy/deploy.sh --bootstrap again." loud
        fi
        cancel_window "⚠️ merge-deploy: the activation of ${X:0:7} was refused and changed nothing: ${why} — retrying next tick."
      fi
      if [ "$q" = "$WINDOW_DIGEST" ]; then
        halt_window LAST_ASSESS_NOTICE "⚠️ merge-deploy: the activation of ${X:0:7} was refused (${why}), but the Quadlet file already names it; the window stays activating and the next tick activates again."
      fi
      open_incident 0 "the activation of ${X:0:7} was refused and the Quadlet file names ${q}, neither ${X:0:7} nor the settled image"
      ;;
    *)
      # 75 or anything else: whether production changed is not known. The window stays
      # `activating`; the next tick looks at what runs (spec §7.2 rows 1–3).
      halt_window LAST_ASSESS_NOTICE "⚠️ merge-deploy: the activation of ${X:0:7} (${D}) could not be confirmed: ${IMG_VERDICT}. The next tick looks at what runs and finishes or cancels it."
      ;;
  esac
}

# Plan п.10: the rollback target S is local and is what the state says it is — checked without
# the network; only when it is missing is it pulled (the network is up: D was just pulled).
settled_is_local() {
  local kind d i c x
  image_call local --digest "$SETTLED_DIGEST"
  if [ "${IMG_VERDICT%% *}" = NOT_LOCAL ]; then
    image_call pull --sha "$SETTLED_SHA" --digest "$SETTLED_DIGEST"
    read -r kind d i c x <<< "$IMG_VERDICT"
    if [ "$kind" != PULLED ] || [ "$d" != "$SETTLED_DIGEST" ] || [ "$x" != "$SETTLED_SHA" ]; then return 1; fi
    image_call local --digest "$SETTLED_DIGEST"
  fi
  read -r kind d i c x <<< "$IMG_VERDICT"
  [ "$kind" = LOCAL ] && [ "$d" = "$SETTLED_DIGEST" ] && [ "$i" = "$SETTLED_ID" ] && [ "$x" = "$SETTLED_SHA" ]
}

# Spec §4.2: the advisory is a verdict on X; anything else is "could not verify".
audit_candidate() {
  image_call audit --digest "$D"
  case "$IMG_VERDICT" in
    "CLEAN $D") ;;
    "ADVISORY $D"|"ADVISORY $D"$'\n'*)
      refuse "$X" "npm audit --omit=dev in its image reports a high or critical advisory.
$(tail -n +2 <<< "$IMG_VERDICT")" ;;
    *)
      halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: the audit of ${X:0:7} (${D}) could not run: ${IMG_VERDICT%%$'\n'*} — NOT a finding; retrying next tick." ;;
  esac
}

# The trial runs on a pre snapshot of production, by NAME (the helper takes no paths). Sets
# PRE_PATH and PRE_NAME. Named in the state BEFORE it exists: a tick that dies before the window is
# written leaves a pre no settled window owns, and the next tick discards it.
take_pre() {
  local err
  PRE_NAME="$(date -u -d "@$(now)" +%Y%m%dT%H%M%SZ)-${X:0:7}-pre.db"
  PRE_PATH="${SNAPSHOT_DIR}/${PRE_NAME}"
  PENDING_PRE="$PRE_PATH"
  write_state
  if ! err=$("$SNAPSHOT_CMD" "$PRE_PATH" 2>&1); then
    discard_pending "$PRE_PATH"
    halt LAST_ASSESS_NOTICE "⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying ${X:0:7}.
${err}"
  fi
}
# No deploy happened: this pre must not count among the settled ones.
discard_pending() {
  "$DISCARD_CMD" "$1" >/dev/null 2>&1 || echo "WARNING: could not discard $1"
  PENDING_PRE=""
  write_state
}

# The candidate is past every gate and is not a noop: audit, S local, pre, trial, the window,
# activate, the window watched. Never returns.
deploy_pipeline() {
  local pre name boot kind acked why
  if ! production_is_record; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: production does not match the record: $(record_mismatch). Not deploying ${X:0:7}; check the host."
  fi
  audit_candidate
  if ! settled_is_local; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: the settled image ${SETTLED_DIGEST} is not usable as the rollback target: ${IMG_VERDICT%%$'\n'*} (expected id ${SETTLED_ID}, revision ${SETTLED_SHA}). Not deploying ${X:0:7}; retrying next tick."
  fi
  if ! PORT=$("$API_PORT_CMD"); then
    halt LAST_ASSESS_NOTICE "⛔ merge-deploy: could not resolve API_PORT — not deploying ${X:0:7}."
  fi
  if ! boot=$("$BOOT_ID_CMD" 2>/dev/null) || ! value_ok WINDOW_BOOT "$boot"; then
    halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not read the boot id — not deploying ${X:0:7}; retrying next tick."
  fi

  take_pre
  pre="$PRE_PATH"
  name="$PRE_NAME"
  image_call trial --digest "$D" --previous "$SETTLED_DIGEST" --snapshot "$name"
  kind="${IMG_VERDICT%% *}"
  # Plan b2 п.10, spec §6.4: a human who acknowledged the incompatibility deploys it anyway, in a
  # manual window — no automatic rollback, which is exactly what COMPAT FAILED rules out.
  acked=0
  if [ "$kind" = COMPAT_FAILED ] && [ "$MANUAL" = 1 ] && [ "$ACK_INCOMPATIBLE" = 1 ]; then acked=1; fi
  if [ "$IMG_VERDICT" != "OK $SETTLED_DIGEST" ] && [ "$acked" = 0 ]; then discard_pending "$pre"; fi
  case "$kind:$IMG_VERDICT" in
    "OK:OK $SETTLED_DIGEST") ;;
    FAILED:*)
      refuse "$X" "the trial on a copy of production failed: ${IMG_VERDICT#FAILED }
$(tail -n 20 <<< "$IMG_ERR")" ;;
    COMPAT_FAILED:*)
      if [ "$acked" = 1 ]; then
        echo "${IMG_VERDICT#COMPAT_FAILED } — acknowledged (--ack-incompatible): deploying in a manual window"
      else
        # Spec §6.3: proven incompatibility — a hold, not a failed SHA. It concerns exactly this
        # pair of images: a new head or a new settled image clears it. A manual run records the
        # same proven fact (plan b2 п.10), and is refused: 1, where the tick holds with 0 — but
        # only for main's head (п.19): a hold of an older commit would replace the head's.
        why="${IMG_VERDICT#COMPAT_FAILED }"
        if ! is_main_head "$X"; then
          manual_refuse "${X:0:7} is not deployable without an automatic rollback — the settled ${SETTLED_SHA:0:7} does not start on the database ${X:0:7} migrated: ${why}
$(tail -n 20 <<< "$IMG_ERR")
It is not main's head, so nothing is held. Deploy it anyway, without an automatic rollback: run again with --ack-incompatible"
        fi
        CANDIDATE_HELD="$X $D $SETTLED_DIGEST"
        CANDIDATE_HELD_WHY="$why"
        LAST_HOLD_NOTICE=$(today)
        write_state
        notify "⏸ merge-deploy: ${X:0:7} is HELD — the settled ${SETTLED_SHA:0:7} does not start on the database ${X:0:7} migrated, so a code-only rollback is not possible: ${why}
$(tail -n 20 <<< "$IMG_ERR")
Deploy it by hand, without an automatic rollback: bash deploy/deploy.sh --ack-incompatible"
        exit "$MANUAL"
      fi ;;
    REFUSED:*)
      # A precondition (rights, the snapshot, an old S) is fixed on the host, not by a commit:
      # not a hold of X, just not before an hour has passed.
      if [ "$MANUAL" = 1 ]; then
        # Plan b2 п.10: the human fixes the host and runs again — no retry is scheduled for him.
        manual_refuse "the trial of ${X:0:7} was refused: ${IMG_VERDICT#REFUSED }
$(tail -n 20 <<< "$IMG_ERR")
Nothing is recorded against the commit; fix the host and run again."
      fi
      CANDIDATE_RETRY_X="$X"
      CANDIDATE_RETRY_AT=$(( $(now) + CANDIDATE_RETRY_S ))
      write_state
      once_a_day LAST_HOLD_NOTICE "⏸ merge-deploy: the trial of ${X:0:7} was refused: ${IMG_VERDICT#REFUSED }
$(tail -n 20 <<< "$IMG_ERR")
It is tried again in $(( CANDIDATE_RETRY_S / 60 )) min; nothing is recorded against the commit."
      exit 0 ;;
    *)
      halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: the trial of ${X:0:7} could not judge it: ${IMG_VERDICT} — NOT a finding; retrying next tick." ;;
  esac

  # Spec §7.1: the window is in the state BEFORE anything changes production.
  WINDOW_SHA="$X"
  WINDOW_DIGEST="$D"
  WINDOW_ID="$CAND_ID"
  WINDOW_CONTENT="$CAND_CONTENT"
  WINDOW_OLD="$DEPLOYED_SHA"
  WINDOW_PREV_DIGEST="$SETTLED_DIGEST"
  WINDOW_KIND=deploy
  WINDOW_MODE="$DEPLOY_MODE"
  WINDOW_PHASE=activating
  WINDOW_PRE="$pre"
  WINDOW_BOOT="$boot"
  PENDING_PRE=""
  write_state
  activate_candidate
}

# Plan п.9: a candidate held for COMPAT FAILED stays held only for the exact pair it was proven
# on — head X, its digest D, the settled S. Quietly, with a reminder once a day.
candidate_held() {
  [ -n "$CANDIDATE_HELD" ] || return 0
  if [ "$CANDIDATE_HELD" != "$X $D $SETTLED_DIGEST" ]; then
    CANDIDATE_HELD=""
    CANDIDATE_HELD_WHY=""
    write_state
    return 0
  fi
  once_a_day LAST_HOLD_NOTICE "⏸ merge-deploy: ${X:0:7} is still HELD: ${CANDIDATE_HELD_WHY}. Deploy it by hand, without an automatic rollback: bash deploy/deploy.sh --ack-incompatible"
  echo "main $X is held (COMPAT FAILED against ${SETTLED_DIGEST})"
  exit 0
}

# Plan п.9: a trial REFUSED for X waits CANDIDATE_RETRY_S, then X is tried afresh.
candidate_retry() {
  [ -n "$CANDIDATE_RETRY_X" ] || return 0
  if [ "$CANDIDATE_RETRY_X" = "$X" ] && [ "$NOW" -lt "$CANDIDATE_RETRY_AT" ]; then
    echo "the trial of $X was refused; retrying after ${CANDIDATE_RETRY_AT}"
    exit 0
  fi
  CANDIDATE_RETRY_X=""
  CANDIDATE_RETRY_AT=""
  write_state
}

# Spec §7.2: a tick that finds a window finishes what its predecessor started, before anything
# else. A decision from the state (phase, mode, attempts) and the live facts (`current`, the boot
# id, then — inside the window — health, NRestarts and the unit state); nothing is remembered
# outside the state, and nothing is guessed: what the facts do not settle waits for the next tick.
# Never returns while a window is open.
resume_window() {
  [ -n "$WINDOW_PHASE" ] || return 0
  local kind q i d u boot started
  X="$WINDOW_SHA"
  D="$WINDOW_DIGEST"
  CAND_ID="$WINDOW_ID"
  CAND_CONTENT="$WINDOW_CONTENT"
  if ! PORT=$("$API_PORT_CMD"); then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not resolve API_PORT — the ${WINDOW_PHASE} window of ${X:0:7} waits; retrying next tick."
    exit 0
  fi
  image_call current
  read -r kind q i d u <<< "$IMG_VERDICT"
  if [ "$kind" != CURRENT ]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not read what production runs: ${IMG_VERDICT} — the ${WINDOW_PHASE} window of ${X:0:7} waits; retrying next tick."
    exit 0
  fi
  # Row 10: whatever the phase, a unit that is not our Quadlet is a human's.
  if [ "$u" = foreign ]; then
    open_incident 0 "the unit is not our Quadlet (unit=foreign) in the ${WINDOW_PHASE} window"
  fi
  case "$WINDOW_PHASE" in
    activating)
      # Plan b2 п.16: a bootstrap interrupted before its activation — no Quadlet file, no unit — is
      # cancelled like row 1; the human runs it again (there is no settled image the tick could use).
      if [ "$WINDOW_KIND" = bootstrap ] && [ "$q" = none ] && [ "$u" = absent ]; then
        cancel_window "⚠️ merge-deploy: the first image release ${X:0:7} was interrupted before its activation; nothing runs from the Quadlet file, so the window is cancelled — production may be down — run bash deploy/deploy.sh --bootstrap again." loud
      fi
      # Row 1: the Quadlet file still names S — activate never ran, production is unchanged.
      if [ -n "$WINDOW_PREV_DIGEST" ] && [ "$q" = "$WINDOW_PREV_DIGEST" ]; then
        cancel_window "⚠️ merge-deploy: the deploy of ${X:0:7} was interrupted before its activation; production still runs the settled ${SETTLED_SHA:0:7}, so the window is cancelled and ${X:0:7} is tried again next tick."
      fi
      if [ "$q" != "$WINDOW_DIGEST" ]; then
        open_incident 0 "the Quadlet file names ${q}, neither ${X:0:7} nor the settled image, in an activating window"
      fi
      # Row 3: D already runs — no second restart; the window starts now.
      if [ "$d" = "$WINDOW_DIGEST" ] && [ "$i" = "$WINDOW_ID" ]; then
        DEPLOYED_SHA="$X"
        DEPLOYED_DIGEST="$D"
        DEPLOYED_ID="$CAND_ID"
        DEPLOYED_CONTENT="$CAND_CONTENT"
        start_watching compare
        watch_window 0
      fi
      # Row 2: the Quadlet file names D, S (or nothing) runs — D never started; activate again.
      activate_candidate
      ;;
    watching)
      if ! boot=$("$BOOT_ID_CMD" 2>/dev/null) || ! value_ok WINDOW_BOOT "$boot"; then
        once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not read the boot id — the window of ${X:0:7} waits; retrying next tick."
        exit 0
      fi
      # Row 5: a reboot is itself a restart, so the old NRestarts says nothing: a full window
      # from now with a new base. The mode is in the state: manual stays manual.
      if [ "$boot" != "$WINDOW_BOOT" ]; then
        WINDOW_BOOT="$boot"
        new_window "a reboot: the boot id changed"
        watch_window 0
      fi
      # F2: a gap with no fully read poll as long as OBSERVE_MAX_S is lost evidence — nobody
      # watched — neither a pass nor a failure: a full window from now.
      if [ $(( $(now) - WINDOW_LAST_READ )) -ge "$OBSERVE_MAX_S" ]; then
        new_window "nobody watched for $(( $(now) - WINDOW_LAST_READ ))s"
        watch_window 0
      fi
      # Row 4: the same boot — the window goes on from its recorded start; past the start-up
      # time a failed health counts at once.
      started=0
      if [ $(( $(now) - WINDOW_START )) -ge "$STARTUP_S" ]; then started=1; fi
      watch_window "$started"
      ;;
    rolling-back)
      # Row 7: LAST_FAILED_SHA is already recorded; the pre is marked if the dead tick had not.
      retain_pre
      write_state
      # An `activate S` may have been under way when the tick died: S gets its start-up time
      # before another attempt is spent (F4).
      if [ "${ROLLBACK_ATTEMPTS:-0}" -ge 1 ] && wait_for_settled; then rolled_back; fi
      rollback_loop
      ;;
  esac
}

# --- the gates --------------------------------------------------------------------------------------
# The timer's gates, between the fetch and the candidate's path. Each one that stops exits.
tick_gates() {
  local verdict
  observe_deployment || exit 0
  if [ -n "$REGRESSION_FROM_SHA" ]; then
    report_regression_hold
    exit 0
  fi

  # Plan п.10: the rollback target is the last settled image; without one there is nothing to roll
  # back to, so the first image release is a human's (spec §8 п.2).
  if [ -z "$DEPLOYED_SHA" ] || [ -z "$SETTLED_DIGEST" ]; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: there is no settled image yet — the first image release is deployed by hand (manual window, spec §8 п.2); until then nothing deploys automatically."
    exit 0
  fi
  if [ "$X" = "$DEPLOYED_SHA" ]; then
    report_stale_once
    echo "up to date at $X"
    exit 0
  fi
  if ! git -C "$REPO" rev-parse -q --verify "${DEPLOYED_SHA}^{commit}" >/dev/null \
     || ! git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$X"; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: production (${DEPLOYED_SHA:0:7}) is not an ancestor of main (${X:0:7}) — refusing what could be a downgrade. Deploy main by hand to reseed."
    exit 0
  fi
  if [ "$X" = "$LAST_FAILED_SHA" ]; then
    report_stale_once
    echo "main $X is recorded as LAST_FAILED_SHA; waiting for the next merge"
    exit 0
  fi
  # D1: ten minutes of quiet, measured from the first tick that saw this head.
  if [ "$MAIN_SEEN_SHA" != "$X" ]; then
    MAIN_SEEN_SHA="$X"
    MAIN_SEEN_S="$NOW"
    write_state
    echo "new main head $X; waiting ${QUIET_S}s of quiet"
    exit 0
  fi
  if [ $(( NOW - MAIN_SEEN_S )) -lt "$QUIET_S" ]; then
    echo "main moved $(( NOW - MAIN_SEEN_S ))s ago; waiting"
    exit 0
  fi
  if installed_is_stale; then
    echo "$STALE_REPORT"
    once_a_day LAST_STALE_NOTICE "⚠️ merge-deploy is waiting: the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
${STALE_ADVICE}"
    exit 0
  fi
  # Plan п.7: holds BEFORE the noop — a change outside the image (sudoers, a unit) is not "nothing".
  scan_range "$X"
  if [ "${#HOLDS[@]}" -gt 0 ]; then
    printf '%s\n' "${HOLDS[@]}"
    once_a_day LAST_HOLD_NOTICE "⏸ merge-deploy: production is behind main and HELD:
$(printf '• %s\n' "${HOLDS[@]}")
Do the steps, then run bash deploy/deploy.sh on the host — that releases the hold."
    exit 0
  fi
  if ! verdict=$(ci_verdict "$X"); then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy cannot read CI status for ${X:0:7} (gh api failed). Waiting."
    exit 0
  fi
  case "$verdict" in
    PASS) ;;
    WAIT)
      if [ $(( NOW - MAIN_SEEN_S )) -ge "$CI_STUCK_S" ]; then
        once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: CI has not concluded on ${X:0:7} after $(( (NOW - MAIN_SEEN_S) / 60 )) min (the required 'ci' and 'image' checks of one run are pending or absent)."
      fi
      echo "CI not concluded on $X"
      exit 0
      ;;
    FAIL*)
      if [ "$LAST_CI_NOTICE_SHA" != "$X" ]; then
        notify "⛔ merge-deploy: CI failed on ${X:0:7} — not deploying. ${verdict#FAIL }
Re-running the failed job releases it; nothing else to do here."
        LAST_CI_NOTICE_SHA="$X"
        write_state
      fi
      exit 0
      ;;
  esac
}

# Spec §7.4, plan b2 п.7–8: a human's deploy of X. No quiet main (the human is there), no observation
# of production and no regression fence (#768: "deploy main by hand" IS its resolution), LAST_FAILED_SHA
# allowed, path holds and deploy:hold released by the run itself. What stays: a settled image to roll
# back to, ancestry (unless --force), the installed copies, CI. A range whose code-only rollback is
# not proven safe — or whose labels could not be read — needs --ack-incompatible. Nothing here writes
# the state: every stop is a refusal (1) or "up to date" (0).
manual_gates() {
  if [ -z "$DEPLOYED_SHA" ] || [ -z "$SETTLED_DIGEST" ]; then
    manual_refuse "there is no settled image yet — the first image release is bash deploy/deploy.sh --bootstrap"
  fi
  if [ "$X" = "$DEPLOYED_SHA" ]; then
    echo "up to date at $X"
    exit 0
  fi
  if [ "$FORCE" = 0 ] && { ! git -C "$REPO" rev-parse -q --verify "${DEPLOYED_SHA}^{commit}" >/dev/null \
       || ! git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$X"; }; then
    manual_refuse "production (${DEPLOYED_SHA:0:7}) is not an ancestor of ${X:0:7} — a downgrade or a jump across histories; if it is deliberate, run again with --force"
  fi
  manual_stale_gate
  scan_range "$X"
  if [ "$ACK_INCOMPATIBLE" = 0 ] && { [ "${#CONTRACT_PRS[@]}" -gt 0 ] || [ "$SCAN_UNREAD" = 1 ]; }; then
    manual_refuse "a code-only rollback of ${DEPLOYED_SHA:0:7}..${X:0:7} is not proven safe:
$(printf '• %s\n' "${CONTRACT_PRS[@]}" "${UNREAD[@]}")
Run again with --ack-incompatible: the window is then manual — no automatic rollback; a failure is an incident."
  fi
  manual_ci_gate
}
manual_stale_gate() {
  if installed_is_stale; then
    manual_refuse "the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
${STALE_ADVICE}"
  fi
}
# Spec §7.4: without a published, tested image there is nothing to deploy — a WAIT of the timer is
# a refusal with its reason for the human.
manual_ci_gate() {
  local verdict
  if ! verdict=$(ci_verdict "$X"); then
    manual_refuse "cannot read CI status for ${X:0:7} (gh api failed)"
  fi
  case "$verdict" in
    PASS) ;;
    WAIT) manual_refuse "CI has not concluded on ${X:0:7} — the required 'ci' and 'image' checks of one run are pending or absent; there is no image to deploy yet" ;;
    FAIL*) manual_refuse "CI failed on ${X:0:7} — not deploying: ${verdict#FAIL }" ;;
  esac
}

# --- bootstrap (plan b2 п.14, 26, 29–32; spec §7.4 "Bootstrap", §8 п.2) ------------------------------------
# The first image release: production still runs the flat tree, there is no settled image, so no
# compat check can prove anything (trial against itself: START is the positive control) and there is
# nothing to roll back to — the window is manual, and its failure is an incident. What production runs
# is read first: it says which of the two runs this is, and the second one's refusals must say how to
# bring the old bot back (п.29). The first run (the old unit, the bot running) gates X, trials it dry
# on a snapshot of the live database that is then discarded (п.30: a bad X never stops the bot), and
# prints the root steps; nothing is recorded. The run after them (no unit, the bot stopped) deploys.
BOOTSTRAP_STEPS="The bot still runs from the old unit (unit=foreign). The first image release needs these root steps first:
  sudo systemctl stop warsaw-beer-bot
  sudo systemctl disable warsaw-beer-bot
  sudo mv /etc/systemd/system/warsaw-beer-bot.service /etc/systemd/system/warsaw-beer-bot.service.flat
  sudo systemctl daemon-reload
Then run again: bash deploy/deploy.sh --bootstrap
Nothing was changed."
# Plan b2 п.29, the steps above undone (enable: the steps disabled it).
BOOTSTRAP_WAY_BACK="The old bot is stopped and its unit moved aside. To bring it back:
  sudo mv /etc/systemd/system/warsaw-beer-bot.service.flat /etc/systemd/system/warsaw-beer-bot.service
  sudo systemctl daemon-reload
  sudo systemctl enable warsaw-beer-bot
  sudo systemctl start warsaw-beer-bot"
# Plan b2 п.31: the holds and contract PRs of DEPLOYED_SHA..X, shown, never a gate — running bootstrap
# is the confirmation, but the human must see what he confirms.
bootstrap_range() {
  scan_range "$X"
  [ "${#STEP_HOLDS[@]}" -gt 0 ] || [ "${#CONTRACT_PRS[@]}" -gt 0 ] || [ "$SCAN_UNREAD" = 1 ] || return 0
  printf 'The range %s..%s — shown, not a gate (this run is the confirmation):\n' "${DEPLOYED_SHA:0:7}" "${X:0:7}"
  printf '• %s\n' "${STEP_HOLDS[@]}" "${CONTRACT_PRS[@]}" "${UNREAD[@]}"
  if [ "${#CONTRACT_PRS[@]}" -gt 0 ]; then echo "A fallback to the flat tree needs the pre snapshot restored."; fi
}
# The trial of D against itself, both runs (plan b2 п.30): returns only on OK D.
bootstrap_verdict() {
  case "$IMG_VERDICT" in
    "OK $D") return 0 ;;
    FAILED\ *)
      refuse "$X" "the trial on a copy of production failed: ${IMG_VERDICT#FAILED }
$(tail -n 20 <<< "$IMG_ERR")" ;;
    COMPAT_FAILED\ *)
      # Plan b2 п.32: against itself, COMPAT is X's own START on the database X migrated.
      manual_refuse "the trial of ${X:0:7} against itself failed: ${IMG_VERDICT#COMPAT_FAILED } — a defect of ${X:0:7}: it would not start again on the database it migrated
$(tail -n 20 <<< "$IMG_ERR")
Nothing is recorded against the commit." ;;
    REFUSED\ *)
      manual_refuse "the trial of ${X:0:7} was refused: ${IMG_VERDICT#REFUSED }
$(tail -n 20 <<< "$IMG_ERR")
Nothing is recorded against the commit; fix the host and run again." ;;
    *)
      halt LAST_ASSESS_NOTICE "⚠️ merge-deploy: the trial of ${X:0:7} could not judge it: ${IMG_VERDICT} — NOT a finding; retrying next tick." ;;
  esac
}
bootstrap_run() {
  local boot first=0 urc=0
  if [ -n "$SETTLED_DIGEST" ]; then
    manual_refuse "an image is already settled (${SETTLED_SHA:0:7}) — the first image release is done; deploy with bash deploy/deploy.sh"
  fi
  if [ -z "$DEPLOYED_SHA" ]; then
    manual_refuse "the state records no deployed commit — the first image release starts from the flat tree's DEPLOYED_SHA, which stage «в» carries over from state.env"
  fi
  # X == DEPLOYED_SHA is allowed: the first image of the code that already runs.
  if [ "$X" != "$DEPLOYED_SHA" ] && { ! git -C "$REPO" rev-parse -q --verify "${DEPLOYED_SHA}^{commit}" >/dev/null \
       || ! git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$X"; }; then
    manual_refuse "production (${DEPLOYED_SHA:0:7}) is not an ancestor of ${X:0:7} — the first image release does not go backwards"
  fi
  bootstrap_range
  read_current
  case "$CUR_UNIT" in
    # Plan b2 п.14: the old unit in /etc would override the Quadlet-generated one.
    foreign) first=1 ;;
    quadlet)
      manual_refuse "a Quadlet unit exists but nothing is settled — check by hand (quadlet=${CUR_QUADLET} container-digest=${CUR_DIGEST})" ;;
  esac
  if [ "$first" = 0 ]; then
    if [ "$CUR_QUADLET" != none ] || [ "$CUR_DIGEST" != none ]; then
      manual_refuse "no unit, but a Quadlet file or a container is there (quadlet=${CUR_QUADLET} container-digest=${CUR_DIGEST}) and nothing is settled — check by hand"
    fi
    # Plan b2 п.26: unit=absent does not prove the bot stopped — systemd keeps a running unit whose
    # file was moved as not-found/active. The snapshot is of a database at rest only if it is.
    unit_running || urc=$?
    case "$urc" in
      0) manual_refuse "the old bot still runs (unit=absent but active) — sudo systemctl stop warsaw-beer-bot, then run again" ;;
      2) manual_refuse "could not read whether the old bot runs (systemctl show warsaw-beer-bot) — run again" ;;
    esac
    WAY_BACK="$BOOTSTRAP_WAY_BACK"
  fi
  manual_stale_gate
  manual_ci_gate
  resolve_digest
  attest_image
  pull_candidate
  audit_candidate
  if [ "$first" = 1 ]; then
    # Plan b2 п.30: the dry trial — the snapshot is discarded whatever the verdict; nothing is
    # recorded unless the trial failed (refuse, п.19), and the bot keeps running either way.
    take_pre
    image_call trial --digest "$D" --previous "$D" --snapshot "$PRE_NAME"
    discard_pending "$PRE_PATH"
    bootstrap_verdict
    printf 'A dry trial of %s on a snapshot of the live database passed; the snapshot is discarded.\n%s\n' "${X:0:7}" "$BOOTSTRAP_STEPS"
    exit 1
  fi
  if ! PORT=$("$API_PORT_CMD"); then
    manual_refuse "could not resolve API_PORT — run again"
  fi
  if ! boot=$("$BOOT_ID_CMD" 2>/dev/null) || ! value_ok WINDOW_BOOT "$boot"; then
    manual_refuse "could not read the boot id — run again"
  fi
  # The bot is stopped: the pre is a snapshot of a database at rest.
  take_pre
  image_call trial --digest "$D" --previous "$D" --snapshot "$PRE_NAME"
  if [ "$IMG_VERDICT" != "OK $D" ]; then
    discard_pending "$PRE_PATH"
    bootstrap_verdict
  fi
  # Spec §7.1: the window is in the state BEFORE anything changes production.
  WINDOW_SHA="$X"
  WINDOW_DIGEST="$D"
  WINDOW_ID="$CAND_ID"
  WINDOW_CONTENT="$CAND_CONTENT"
  WINDOW_OLD="$DEPLOYED_SHA"
  WINDOW_PREV_DIGEST=""
  WINDOW_KIND=bootstrap
  WINDOW_MODE=manual
  WINDOW_PHASE=activating
  WINDOW_PRE="$PRE_PATH"
  WINDOW_BOOT="$boot"
  PENDING_PRE=""
  write_state
  activate_candidate
}

# --- resolve-incident --flat (plan b2 п.28, spec §7.4 "Уточнення bootstrap") -----------------------------
# A failed first image release that the human undid: the old unit and the flat tree run again, and
# there is no image of ours to settle. Proven before anything is written: nothing settled, the old
# unit (unit=foreign) running, /health answering R, R on origin/main. Then ONE write closes the
# incident and records R as deployed (and observed — the human named it), with no digest: nothing of
# ours runs. No window: the controller does not watch the flat tree. The next step is --bootstrap.
resolve_flat() {
  local kind q i d u urc=0 r
  if [ -n "$SETTLED_DIGEST" ]; then
    manual_refuse "an image is settled (${SETTLED_SHA:0:7}) — --flat closes only an incident of the first image release; restore an image and run: bash deploy/deploy.sh --resolve-incident --settled <sha>"
  fi
  image_call current
  read -r kind q i d u <<< "$IMG_VERDICT"
  if [ "$kind" != CURRENT ]; then
    manual_refuse "could not read what production runs: ${IMG_VERDICT} — run again"
  fi
  if [ "$u" != foreign ]; then
    manual_refuse "the old unit is not there (unit=${u}) — --flat closes the incident only when the old unit runs the flat tree again"
  fi
  unit_running || urc=$?
  case "$urc" in
    1) manual_refuse "the old unit does not run — start it (sudo systemctl start warsaw-beer-bot), then run again" ;;
    2) manual_refuse "could not read whether the old unit runs (systemctl show warsaw-beer-bot) — run again" ;;
  esac
  if ! PORT=$("$API_PORT_CMD"); then
    manual_refuse "could not resolve API_PORT — run again"
  fi
  if ! r=$(read_health); then
    manual_refuse "/health does not answer — the flat tree is not up; run again when it answers"
  fi
  if [ ! -d "$REPO/.git" ] && ! timeout "$STEP_TIMEOUT_GIT_S" git clone -q "$REPO_URL" "$REPO"; then
    manual_refuse "git clone of $REPO_URL failed — run again"
  fi
  if ! timeout "$STEP_TIMEOUT_GIT_S" git -C "$REPO" fetch -q --prune origin; then
    manual_refuse "git fetch failed — run again"
  fi
  if ! git -C "$REPO" merge-base --is-ancestor "$r" origin/main 2>/dev/null; then
    manual_refuse "/health answers releaseSha ${r:0:7}, which is not on origin/main — it cannot be recorded as deployed"
  fi
  # An incident whose second write never happened still carries its window (open_incident).
  if [ -n "$WINDOW_PHASE" ]; then
    retain_pre
    clear_window
    echo "the incident's window was still in the state; its pre: ${PRE_NOTE}"
  fi
  INCIDENT=""
  DEPLOYED_SHA="$r"
  LAST_SEEN_DEPLOYED_SHA="$r"
  DEPLOYED_DIGEST=""
  DEPLOYED_ID=""
  DEPLOYED_CONTENT=""
  # Plan b2 п.24: the incident these pres were evidence for is closed.
  PENDING_MARK=""
  write_state
  release_retained
  notify "✅ merge-deploy: the incident is closed — the old unit runs the flat tree at ${r:0:7}, recorded as deployed; nothing is settled. Next: bash deploy/deploy.sh --bootstrap${RELEASE_NOTE}"
  exit 0
}

# --- resolve-incident (plan b2 п.13, spec §7.3) -------------------------------------------------------
# The human restored production and names what runs: S. It is proven to be S — the tag's digest D,
# attested; local as a build of S; the Quadlet file and the container are D, from our unit; /health
# answers S — before anything is written; any difference refuses with what differed, and the state
# is not touched. Then ONE write clears the incident and opens a watching resolve window, so an
# interruption leaves either the incident or a window the timer finishes (the incident gate stands
# before resume_window), never both and never neither. Never returns.
resolve_incident() {
  local kind d i c rev h boot
  # A refusal leaves the state as it is (plan b2 п.25): this check comes before anything is written.
  if [ -z "$DEPLOYED_SHA" ]; then
    manual_refuse "the state records no deployed commit — there is nothing a resolve window could start from"
  fi
  # An incident whose second write never happened still carries its window (open_incident): what
  # that write would have done — the pre kept, the window cleared — comes first.
  if [ -n "$WINDOW_PHASE" ]; then
    retain_pre
    clear_window
    write_state
    echo "the incident's window was still in the state; its pre: ${PRE_NOTE}"
  fi
  X="$SETTLED_ARG"
  resolve_digest
  attest_image
  image_call local --digest "$D"
  read -r kind d i c rev <<< "$IMG_VERDICT"
  if [ "$kind" != LOCAL ] || [ "$d" != "$D" ] || [ "$rev" != "$X" ]; then
    manual_refuse "the local image ${D} is not a build of ${X:0:7}: local answered ${IMG_VERDICT}"
  fi
  CAND_ID="$i"
  CAND_CONTENT="$c"
  read_current
  if [ "$CUR_UNIT" != quadlet ] || [ "$CUR_QUADLET" != "$D" ] || [ "$CUR_DIGEST" != "$D" ] || [ "$CUR_IMAGE" != "$CAND_ID" ]; then
    manual_refuse "production does not run ${X:0:7} from our Quadlet: expected quadlet=${D} container-image=${CAND_ID} container-digest=${D} unit=quadlet, found quadlet=${CUR_QUADLET} container-image=${CUR_IMAGE} container-digest=${CUR_DIGEST} unit=${CUR_UNIT}"
  fi
  if ! PORT=$("$API_PORT_CMD"); then
    manual_refuse "could not resolve API_PORT — run again"
  fi
  h=$(read_health) || h=""
  if [ "$h" != "$X" ]; then
    manual_refuse "/health answers releaseSha $([ -n "$h" ] && printf '%s' "${h:0:7}" || printf '(no answer)'), not ${X:0:7} — production does not run what --settled names"
  fi
  if ! boot=$("$BOOT_ID_CMD" 2>/dev/null) || ! value_ok WINDOW_BOOT "$boot"; then
    manual_refuse "could not read the boot id — run again"
  fi
  # Plan b2 п.22: the window's base is read before the write that clears the incident — a counter
  # that cannot be read now is the human's to retry, not a window that fails before it exists.
  if ! read_restarts >/dev/null; then
    manual_refuse "could not read NRestarts — run again"
  fi
  INCIDENT=""
  WINDOW_SHA="$X"
  WINDOW_DIGEST="$D"
  WINDOW_ID="$CAND_ID"
  WINDOW_CONTENT="$CAND_CONTENT"
  WINDOW_OLD="$DEPLOYED_SHA"
  WINDOW_PREV_DIGEST="$SETTLED_DIGEST"
  WINDOW_KIND=resolve
  WINDOW_MODE=manual
  WINDOW_PRE=""
  WINDOW_BOOT="$boot"
  # No activation: the base is the counter as it is (spec §7.3). S was just seen up and answering.
  start_watching
  watch_window 1
}

# --- the run -----------------------------------------------------------------------------------------
read_state || state_corrupt
retry_pending_marks
# Spec §7.3: an open incident blocks everything but PAUSED and the lock — before the window,
# before git, before CI.
if [ -n "$INCIDENT" ]; then
  if [ "$MANUAL_CMD" = resolve-incident ] && [ "$FLAT" = 1 ]; then resolve_flat; fi
  if [ "$MANUAL_CMD" = resolve-incident ]; then resolve_incident; fi
  read -r _inc_sha _inc_digest _inc_reason <<< "$INCIDENT"
  if [ "$MANUAL" = 1 ]; then
    manual_refuse "an INCIDENT is open — ${_inc_sha:0:7} (${_inc_digest}): ${_inc_reason}
Nothing deploys until it is resolved: bash deploy/deploy.sh --resolve-incident --settled <sha>"
  fi
  once_a_day LAST_INCIDENT_NOTICE "🔥 merge-deploy: an INCIDENT is open — ${_inc_sha:0:7} (${_inc_digest}): ${_inc_reason}
Nothing deploys until a human resolves it: bash deploy/deploy.sh --resolve-incident --settled <sha>."
  echo "incident open; nothing to do"
  exit 0
fi
if [ "$MANUAL_CMD" = resolve-incident ]; then
  manual_refuse "no INCIDENT is open — there is nothing to resolve"
fi
# Plan b2 п.2: an open window is the timer's to finish (spec §7.2) — a manual run never takes it
# over, nor opens a second one.
if [ "$MANUAL" = 1 ] && [ -n "$WINDOW_PHASE" ]; then
  manual_refuse "a window of ${WINDOW_SHA:0:7} is open (${WINDOW_PHASE}) — the timer finishes it; run again after it"
fi
resume_window
# F10: a pre snapshot whose window was never written was never trialled into a deploy.
if [ -n "$PENDING_PRE" ]; then
  "$DISCARD_CMD" "$PENDING_PRE" >/dev/null 2>&1 || echo "WARNING: could not discard $PENDING_PRE"
  PENDING_PRE=""
  write_state
fi
if [ ! -d "$REPO/.git" ]; then
  timeout "$STEP_TIMEOUT_GIT_S" git clone -q "$REPO_URL" "$REPO" || halt LAST_ASSESS_NOTICE "⛔ merge-deploy: git clone of $REPO_URL failed." 1
fi
if ! timeout "$STEP_TIMEOUT_GIT_S" git -C "$REPO" fetch -q --prune origin; then
  halt LAST_ASSESS_NOTICE "⛔ merge-deploy: git fetch failed." 1
fi

if [ "$MANUAL" = 1 ]; then
  X="$TARGET"
  # Plan b2 п.4: the attestation requires refs/heads/main (spec §1 п.2) — a commit that is not on
  # main has no image this controller would ever trust.
  if ! git -C "$REPO" merge-base --is-ancestor "$X" origin/main 2>/dev/null; then
    manual_refuse "${X:0:7} is not on origin/main — only a commit of main is deployed (its image's attestation requires refs/heads/main)"
  fi
else
  X=$(git -C "$REPO" rev-parse origin/main)
fi
NOW=$(now)

if [ "$MANUAL_CMD" = bootstrap ]; then bootstrap_run; fi
if [ "$MANUAL" = 1 ]; then manual_gates; else tick_gates; fi

# Plan b2 п.7: a retried or held candidate waits for the timer; a human's run is the retry, and
# its COMPAT FAILED is answered in the pipeline (refused, or deployed in a manual window).
if [ "$MANUAL" = 0 ]; then candidate_retry; fi
resolve_digest
if [ "$MANUAL" = 0 ]; then candidate_held; fi
attest_image
pull_candidate
read_current
noop_or_continue
deploy_pipeline
