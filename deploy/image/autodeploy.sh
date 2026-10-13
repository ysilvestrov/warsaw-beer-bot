#!/usr/bin/env bash
# Merge-deploy for the OCI image — the host deploys the head of origin/main by itself, as an image.
# Spec: docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §4, §5, §7.
# Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-b-core.md ("Рішення" 1–18).
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
# Runs as the operator user (ysi). Root steps go through `sudo -n wbb-image <verb>`, one sudoers
# rule per verb. Git runs in a private clone, only for the gates — nothing is checked out.
#
# State: $STATE_DIR/image-state.env, parsed line by line against an allowlist and VALIDATED
# before anything acts on it (plan п.3); a damaged file is STATE CORRUPT (exit 3), never a fresh
# start. state.env (the flat deployer's) is neither read nor written. The lock is shared with
# the flat deployer and deploy.sh, so they exclude each other.
#
# Exit (plan п.16): 0 idle / wait / hold / noop / settled, 1 refused, 2 rolled back (code only),
#       3 incident opened or state corrupt, 4 state write failed, 64 usage.
set -euo pipefail
# notify() cuts messages by CHARACTERS. Under systemd's default C locale bash counts bytes and
# can cut a UTF-8 character in half, which Telegram rejects.
export LC_ALL=C.UTF-8

# Plan п.18: the manual entry (deploy.sh) is a later stage; until it exists, no interface.
if [ "$#" -ne 0 ]; then
  echo "usage: autodeploy.sh   (no arguments; the timer runs it)" >&2
  exit 64
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
# Plan п.17: the worst tick of this deployer is ~88 min (TICK_BUDGET_S=5400 with the unit's
# TimeoutStartSec=90min, stage «в»); a lock held longer than that has a holder that will not let go.
LOCK_STALL_S=5700
# Plan п.17: the tick's budget is the sum of the nested timeouts of its worst path, each call at
# the edge of its own bound — ONE source for each, and a test sums them against TICK_BUDGET_S
# (stage «в» sets the unit's TimeoutStartSec=90min to match).
TICK_BUDGET_S=5400
STEP_TIMEOUT_RESOLVE_S=40       # token + HEAD, 2 × 20
STEP_TIMEOUT_ATTEST_S=120
STEP_TIMEOUT_PULL_S=660         # the helper: pull 600 + inspect 60
STEP_TIMEOUT_CURRENT_S=90       # the helper: inspect 60 + systemctl 30
STEP_TIMEOUT_AUDIT_S=300        # the helper
STEP_TIMEOUT_SETTLED_LOCAL_S=780  # local S + pull S + local S
STEP_TIMEOUT_SNAPSHOT_S=300     # VACUUM INTO
STEP_TIMEOUT_TRIAL_S=900        # the helper: 180 + 150 + 150 + 3 × rm 60 + 2 × inspect 60 + the copy
STEP_TIMEOUT_ACTIVATE_S=240     # the helper: daemon-reload 60 + restart 180
STEP_TIMEOUT_STARTUP_S=120
STEP_TIMEOUT_WINDOW_S=705       # 600 + the last poll (health 5, systemctl 5 + 5, current 90)
STEP_TIMEOUT_ROLLBACK_S=950     # 2 × (check 100 + activate 240 + start 120) + 30
STEP_TIMEOUT_FINISH_S=60        # incident, notify, state writes
# The window (spec §7, plan п.11).
WINDOW_S=600
POLL_S=10
# Quadlet's Type=notify signals the container, not the application: after ACTIVATED wait this
# long for /health to answer releaseSha == X with the unit running.
STARTUP_S=$STEP_TIMEOUT_STARTUP_S
# R6: one failed probe is a stall, not a failed deploy — a run of failures is.
HEALTH_FAILS_MAX=3
# This long without one fully read poll (current, NRestarts, the unit state) is a failed window:
# it must never hang in `watching` forever.
OBSERVE_MAX_S=300
# Plan п.13: at most two `activate S` per rollback, this far apart after a 75.
ROLLBACK_ATTEMPTS_MAX=2
ROLLBACK_RETRY_S=30
# Plan п.9: a trial REFUSED (a precondition on the host) is retried after this long.
CANDIDATE_RETRY_S=3600
SEAM_TIMEOUT_S=5
KEEP_SNAPSHOTS=3
SNAPSHOT_DIR="${WBB_SNAPSHOT_DIR:-/var/lib/warsaw-beer-bot/deploy-snapshots}"
DB_PATH="${WBB_DB_PATH:-/var/lib/warsaw-beer-bot/bot.db}"

READ_ENV_BIN="${WBB_READ_ENV:-/usr/local/bin/wbb-read-env}"
INSTALLED_CHECK_BIN="${WBB_INSTALLED_CHECK:-/usr/local/bin/wbb-installed-current}"
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
  body=$(curl -fsS --max-time "$SEAM_TIMEOUT_S" "http://127.0.0.1:${1}/health" 2>/dev/null) || return 1
  case "$body" in *'"ok":true'*) ;; *) return 1 ;; esac
  sha=$(printf '%s' "$body" | sed -n 's/.*"releaseSha":"\([0-9a-f]\{40\}\)".*/\1/p')
  [ -n "$sha" ] || return 1
  printf '%s\n' "$sha"
}
HEALTH_CMD="${WBB_HEALTH_CMD:-_health_default}"
_restarts_default() { timeout "$SEAM_TIMEOUT_S" systemctl show -p NRestarts --value warsaw-beer-bot; }
RESTARTS_CMD="${WBB_RESTARTS_CMD:-_restarts_default}"
# Plan п.11: "running" is ActiveState=active, SubState=running, MainPID != 0 (the operator reads it).
_unit_state_default() { timeout "$SEAM_TIMEOUT_S" systemctl show warsaw-beer-bot -p ActiveState,SubState,MainPID; }
UNIT_STATE_CMD="${WBB_UNIT_STATE_CMD:-_unit_state_default}"
_boot_id_default() { cat /proc/sys/kernel/random/boot_id; }
BOOT_ID_CMD="${WBB_BOOT_ID_CMD:-_boot_id_default}"

# The root helper (spec §5): one sudoers rule per verb, never a password prompt.
_image_default() { sudo -n "$IMAGE_BIN" "$@"; }
IMAGE_CMD="${WBB_IMAGE_CMD:-_image_default}"

# Plan п.6: tag <sha> → digest, anonymously from GHCR's registry API. Trusted for NOTHING: the
# attestation and `pull` (.Digest == D, revision == X) are what make D believable.
# Prints sha256:<64 hex>; exit 3 = no such tag (404); anything else = could not read.
_resolve_default() {
  local token headers status digest each=$(( STEP_TIMEOUT_RESOLVE_S / 2 ))
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
  gh api "repos/${GH_REPO}/commits/$1/check-runs" --paginate \
    --jq '.check_runs[] | [.name, .status, (.conclusion // ""), (.check_suite.id | tostring)] | @tsv'
}
CHECKS_CMD="${WBB_CHECKS_CMD:-_checks_default}"
# One line per PR that contains the commit: number<TAB>label,label,...
_pr_labels_default() {
  gh api "repos/${GH_REPO}/commits/$1/pulls" \
    --jq '.[] | "\(.number)\t\(.labels | map(.name) | join(","))"'
}
PR_LABELS_CMD="${WBB_PR_LABELS_CMD:-_pr_labels_default}"

_read_env_default() {
  sudo -u warsaw-beer-bot bash -lc '"$0" /etc/warsaw-beer-bot/.env "$1"' "$READ_ENV_BIN" "$1"
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
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
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
_as_bot() { sudo -u warsaw-beer-bot bash -lc '"$0" "$@"' "$@"; }
_snapshot_default() { timeout "$STEP_TIMEOUT_SNAPSHOT_S" sudo -u warsaw-beer-bot bash -lc '"$0" "$@"' "$SNAPSHOT_BIN" snapshot "$DB_PATH" "$1"; }
SNAPSHOT_CMD="${WBB_SNAPSHOT_CMD:-_snapshot_default}"
_prune_default() { _as_bot "$SNAPSHOT_BIN" prune "$SNAPSHOT_DIR" "$KEEP_SNAPSHOTS"; }
PRUNE_CMD="${WBB_PRUNE_CMD:-_prune_default}"
_mark_default() { _as_bot "$SNAPSHOT_BIN" mark-rollback "$1"; }
MARK_CMD="${WBB_MARK_CMD:-_mark_default}"
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
notify() {
  local msg="$1"
  if [ "${#msg}" -gt "$NOTIFY_LIMIT" ]; then
    msg="${msg:0:$NOTIFY_LIMIT}"$'\n… truncated'
  fi
  "$NOTIFY_CMD" "$msg" || echo "WARNING: notify failed: $msg"
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
  echo "wbb-autodeploy: paused ($STATE_DIR/PAUSED exists); exiting quietly"
  exit 0
fi
mkdir -p "$DATA_DIR" "$STATE_DIR"
# The same lock as the flat deployer and deploy.sh: whoever holds it, the others wait.
exec 9>"$LOCK"
if ! flock -n 9; then
  # A holder that never lets go blocks every tick, and "another tick holds the lock" alone says
  # nothing. These two files live outside the state on purpose: state is written only under the
  # lock, and this path runs because we do not have it.
  busy="$STATE_DIR/lock-busy-since"
  # A record older than two stall periods belongs to an earlier busy period that no tick closed.
  if [ ! -s "$busy" ] || [ $(( $(now) - $(cat "$busy") )) -ge $(( 2 * LOCK_STALL_S )) ]; then
    now > "$busy"
  fi
  held_s=$(( $(now) - $(cat "$busy") ))
  if [ "$held_s" -ge "$LOCK_STALL_S" ] && [ "$(cat "$STATE_DIR/lock-notice" 2>/dev/null)" != "$(today)" ]; then
    notify "⚠️ merge-deploy: the deploy lock has been held for $(( held_s / 60 )) min — no tick can run. A stuck manual deploy.sh? Check: fuser -v $LOCK"
    today > "$STATE_DIR/lock-notice"
  fi
  echo "another process holds the lock (${held_s}s); exiting"
  exit 0
fi
rm -f "$STATE_DIR/lock-busy-since"
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
  WINDOW_SHA WINDOW_DIGEST WINDOW_ID WINDOW_CONTENT WINDOW_OLD WINDOW_PREV_DIGEST WINDOW_MODE
  WINDOW_PHASE WINDOW_PRE WINDOW_START WINDOW_BOOT WINDOW_NRESTARTS WINDOW_FAILS WINDOW_LAST_READ
  WINDOW_REASON ROLLBACK_ATTEMPTS
  CANDIDATE_HELD CANDIDATE_HELD_WHY CANDIDATE_RETRY_X CANDIDATE_RETRY_AT
  RETAINED_PRE
  INCIDENT
)
WINDOW_KEYS=(WINDOW_SHA WINDOW_DIGEST WINDOW_ID WINDOW_CONTENT WINDOW_OLD WINDOW_PREV_DIGEST WINDOW_MODE
  WINDOW_PHASE WINDOW_PRE WINDOW_START WINDOW_BOOT WINDOW_NRESTARTS WINDOW_FAILS WINDOW_LAST_READ WINDOW_REASON)
for _k in "${STATE_KEYS[@]}"; do printf -v "$_k" '%s' ''; done
unset _k
HOLDS=()
RANGE_PRS=()

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
    MAIN_SEEN_S|WINDOW_START|WINDOW_NRESTARTS|WINDOW_FAILS|WINDOW_LAST_READ|ROLLBACK_ATTEMPTS|CANDIDATE_RETRY_AT)
      [[ $v =~ ^(0|[1-9][0-9]{0,17})$ ]] ;;
    LAST_HOLD_NOTICE|LAST_STALE_NOTICE|LAST_ASSESS_NOTICE|LAST_INCIDENT_NOTICE)
      [[ $v =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ;;
    WINDOW_MODE) [[ $v =~ ^(auto|manual)$ ]] ;;
    WINDOW_PHASE) [[ $v =~ ^(activating|watching|rolling-back)$ ]] ;;
    WINDOW_BOOT) [[ $v =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] ;;
    CANDIDATE_HELD) [[ $v =~ $_RE_CANDIDATE_HELD ]] ;;
    INCIDENT) [[ $v =~ $_RE_INCIDENT ]] ;;
    # Free text (a path, a reason): one line by construction; it must say something.
    WINDOW_PRE|WINDOW_REASON|CANDIDATE_HELD_WHY|RETAINED_PRE) [ -n "$v" ] ;;
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
  _requires WINDOW_PHASE WINDOW_SHA WINDOW_DIGEST WINDOW_MODE || return 1
  for w in "${WINDOW_KEYS[@]}"; do
    _requires "$w" WINDOW_PHASE || return 1
  done
  _requires ROLLBACK_ATTEMPTS WINDOW_PHASE || return 1
  _requires CANDIDATE_HELD_WHY CANDIDATE_HELD || return 1
  _together CANDIDATE_RETRY_X CANDIDATE_RETRY_AT || return 1
}

# Plan п.3: `while read`, never `. "$STATE"` — INCIDENT's value has spaces, and sourcing would
# run its second word as a command. No file is a first start (bootstrap); a file that exists but
# is damaged — empty, cut short, a stray line, a key twice — never is.
read_state() {
  local content line key value n=0 seen=" "
  STATE_PROBLEM=""
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

# A gate the COMMIT failed. Recorded, so the same head is never retried; the next merge is.
refuse() {
  notify "⛔ merge-deploy refused ${1:0:7}: $2"
  LAST_FAILED_SHA="$1"
  write_state
  exit 1
}

# --- installed copies -----------------------------------------------------------------------------
# Plan п.15: what this deployer runs from outside the clone, each against the file it came from.
# All of them are readable by the operator; the sudoers file (0440) is not, and is not checked.
installed_is_stale() {
  [ -n "$INSTALLED_CHECK_BIN" ] || return 1
  [ -x "$INSTALLED_CHECK_BIN" ] || return 1
  ! STALE_REPORT=$("$INSTALLED_CHECK_BIN" "$REPO" origin/main \
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
scan_range() {
  local x="$1" paths commits c out pr labels f l
  HOLDS=()
  RANGE_PRS=()
  if ! paths=$(git -C "$REPO" -c core.quotePath=false diff --no-renames --name-only "$DEPLOYED_SHA" "$x"); then
    HOLDS+=("could not list the changed paths")
  fi
  while IFS= read -r f; do
    if [ -n "$f" ] && path_is_held "$f"; then HOLDS+=("path $f needs a human step"); fi
  done <<< "$paths"
  if ! commits=$(git -C "$REPO" rev-list "${DEPLOYED_SHA}..${x}"); then
    HOLDS+=("could not list the commits")
    return 0
  fi
  while IFS= read -r c; do
    if [ -z "$c" ]; then continue; fi
    if ! out=$("$PR_LABELS_CMD" "$c" 2>/dev/null); then
      add_unique HOLDS "could not read PR labels for ${c:0:7}"
      continue
    fi
    while IFS=$'\t' read -r pr labels; do
      if [ -z "$pr" ]; then continue; fi
      add_unique RANGE_PRS "#$pr"
      case ",$labels," in
        *,deploy:hold,*) add_unique HOLDS "PR #$pr carries deploy:hold — https://github.com/${GH_REPO}/pull/$pr" ;;
      esac
      # Spec §6.4: compatibility for a code-only rollback is not proven — a human deploys it,
      # and its window is manual (no automatic rollback).
      for l in rollback:unsafe migration:contract; do
        case ",$labels," in
          *",$l,"*) add_unique HOLDS "PR #$pr carries $l — a code-only rollback is not proven safe; deploy it by hand with bash deploy/deploy.sh --ack-incompatible — https://github.com/${GH_REPO}/pull/$pr" ;;
        esac
      done
    done <<< "$out"
  done <<< "$commits"
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
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: no image is published for ${X:0:7} (no tag ${X} in ${IMAGE_REPOSITORY}) — waiting; NOT a finding against the commit."
    exit 0
  fi
  if [ "$rc" -ne 0 ] || ! [[ $out =~ ^sha256:[0-9a-f]{64}$ ]]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not resolve the image of ${X:0:7} (exit ${rc}) — NOT a finding; retrying next tick."
    exit 0
  fi
  D="$out"
}

# Spec §1 п.2: without a passing attestation the helper is never asked to pull D. A failure
# cannot tell "not ours" from "Sigstore unreachable" (P2), so it is not a verdict on X.
attest_image() {
  local out rc
  out=$("$ATTEST_CMD" "$D" "$X" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: the image of ${X:0:7} (${D}) did not pass attestation (exit ${rc}) — not deploying it; NOT recorded as a failed commit.
$(tail -n 5 <<< "$out")"
    exit 0
  fi
}

# PULLED with exactly the D and X that were asked for, or "could not verify" (plan п.9).
# Sets CAND_ID and CAND_CONTENT.
pull_candidate() {
  local kind d i c x
  image_call pull --sha "$X" --digest "$D"
  read -r kind d i c x <<< "$IMG_VERDICT"
  if [ "$kind" != PULLED ] || [ "$d" != "$D" ] || [ "$x" != "$X" ]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: the image of ${X:0:7} (${D}) was not pulled as asked: ${IMG_VERDICT} — NOT a finding; retrying next tick."
    exit 0
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
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not read what production runs: ${IMG_VERDICT} — not deploying ${X:0:7}; retrying next tick."
    exit 0
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
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: ${X:0:7} changes nothing that runs (wbb.content ${CAND_CONTENT}), but production does not match the record: $(record_mismatch). Not recording it as deployed; check the host."
    exit 0
  fi
  # Advancing DEPLOYED_SHA is the point: a hold released by a manual deploy of a noop commit
  # would otherwise never be released (plan п.7).
  DEPLOYED_SHA="$X"
  LAST_SEEN_DEPLOYED_SHA="$X"
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
# Every key of an open window (spec §7.1). Cleared together when the window ends in any way.
clear_window() {
  local k
  for k in "${WINDOW_KEYS[@]}"; do printf -v "$k" '%s' ''; done
  ROLLBACK_ATTEMPTS=""
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
# and prints the new name; that name — not the old WINDOW_PRE — is what is retained. Sets PRE_NOTE.
retain_pre() {
  local out marked
  case "$WINDOW_PRE" in
    '') PRE_NOTE="none (the window had no pre snapshot)"; return 0 ;;
    *-rollback-pre.db) PRE_NOTE="$WINDOW_PRE (kept until a human removes it: rm $WINDOW_PRE $WINDOW_PRE.sha256)"; return 0 ;;
  esac
  if out=$("$MARK_CMD" "$WINDOW_PRE" 2>&1) && marked=$(tail -n 1 <<< "$out") && [ -n "$marked" ] \
     && [[ $marked != *' '* ]]; then
    WINDOW_PRE="$marked"
    RETAINED_PRE="${RETAINED_PRE:+$RETAINED_PRE }$marked"
    PRE_NOTE="$marked (kept until a human removes it: rm $marked $marked.sha256)"
  else
    PRE_NOTE="NOT marked (${out//$'\n'/ }) — prune may delete $WINDOW_PRE"
  fi
}

# Spec §7.3: production needs a human. ONE write, before the window is cleared: LAST_FAILED_SHA,
# INCIDENT and the retained pre together (plan п.13). Never returns.
open_incident() {
  local reason="${1//$'\n'/ }" x="$WINDOW_SHA" d="$WINDOW_DIGEST" mode="$WINDOW_MODE"
  retain_pre
  LAST_FAILED_SHA="$x"
  INCIDENT="$x $d $reason"
  write_state
  clear_window
  write_state
  notify "🔥 merge-deploy INCIDENT: ${x:0:7} (${d}) — ${reason}. Nothing was rolled back automatically$([ "$mode" = manual ] && printf ' (a manual window)'); the database is untouched.
Pre-deploy snapshot: ${PRE_NOTE}
Nothing deploys until a human restores production and runs: bash deploy/deploy.sh --resolve-incident --settled <sha>"
  exit 3
}

# What `current`, the unit and /health say about the settled image S: 0 it runs and answers,
# 1 it does not, 3 the unit is not our Quadlet.
settled_is_running() {
  local kind q i d u urc=0
  image_call current
  read -r kind q i d u <<< "$IMG_VERDICT"
  [ "$kind" = CURRENT ] || return 1
  if [ "$u" = foreign ]; then return 3; fi
  [ "$u" = quadlet ] && [ "$q" = "$SETTLED_DIGEST" ] && [ "$d" = "$SETTLED_DIGEST" ] && [ "$i" = "$SETTLED_ID" ] || return 1
  unit_running || urc=$?
  [ "$urc" = 0 ] || return 1
  [ "$(read_health || true)" = "$SETTLED_SHA" ] || return 1
}

# Up to STARTUP_S for S to run and answer. 0 yes, 1 no; the unit turning foreign is an incident.
wait_for_settled() {
  local start rc
  start=$(now)
  while :; do
    rc=0
    settled_is_running || rc=$?
    if [ "$rc" = 0 ]; then return 0; fi
    if [ "$rc" = 3 ]; then open_incident "the unit is no longer our Quadlet (unit=foreign) during the rollback"; fi
    if [ $(( $(now) - start )) -ge "$STARTUP_S" ]; then return 1; fi
    "$SLEEP_CMD" "$POLL_S"
  done
}

# Spec §1 п.5: the settled image runs again on the same database. Never returns.
rolled_back() {
  local x="$WINDOW_SHA" old="$WINDOW_OLD" reason="$WINDOW_REASON" pre="$WINDOW_PRE"
  DEPLOYED_SHA="$old"
  LAST_SEEN_DEPLOYED_SHA="$old"
  DEPLOYED_DIGEST="$SETTLED_DIGEST"
  DEPLOYED_ID="$SETTLED_ID"
  DEPLOYED_CONTENT="$SETTLED_CONTENT"
  clear_window
  write_state
  notify "🔥 merge-deploy ROLLED BACK ${x:0:7} → ${SETTLED_SHA:0:7} (code only, DB untouched): ${reason}.
Whatever ${x:0:7} migrated or wrote is still in the database.
Pre-deploy snapshot kept: ${pre} (remove it by hand once reconciled: rm ${pre} ${pre}.sha256)"
  exit 2
}

# Plan п.13 steps 3–5: before EVERY attempt, the fact first — S already running and answering
# finishes the rollback without restarting it again. The attempt counter is in the state and
# written BEFORE each `activate S`, so no interruption lets S be restarted more than twice.
rollback_loop() {
  local rc
  while :; do
    rc=0
    settled_is_running || rc=$?
    if [ "$rc" = 3 ]; then open_incident "the unit is no longer our Quadlet (unit=foreign) during the rollback"; fi
    if [ "$rc" = 0 ]; then rolled_back; fi
    if [ "${ROLLBACK_ATTEMPTS:-0}" -ge "$ROLLBACK_ATTEMPTS_MAX" ]; then
      open_incident "the rollback to ${SETTLED_SHA:0:7} did not bring it up after ${ROLLBACK_ATTEMPTS} attempts (${WINDOW_REASON})"
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
  if [ "$WINDOW_MODE" = manual ]; then open_incident "the manual window failed: ${reason}"; fi
  # The FIRST write: whatever happens below, X is not retried.
  LAST_FAILED_SHA="$WINDOW_SHA"
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
start_watching() {
  WINDOW_PHASE=watching
  WINDOW_START=$(now)
  WINDOW_LAST_READ="$WINDOW_START"
  WINDOW_FAILS=0
  WINDOW_NRESTARTS=$(read_restarts || true)
  write_state
}
new_window() {
  start_watching
  notify "⚠️ merge-deploy ${WINDOW_SHA:0:7}: the window lost its evidence ($1) — watching a full ${WINDOW_S}s window again from now."
}

# Spec §7.1: settled — D becomes the rollback target. Never returns.
settle() {
  local x="$WINDOW_SHA" d="$WINDOW_DIGEST" prs="${RANGE_PRS[*]:-}"
  PREVIOUS_SHA="$WINDOW_OLD"
  DEPLOYED_SHA="$x"
  LAST_SEEN_DEPLOYED_SHA="$x"
  SETTLED_SHA="$x"
  SETTLED_DIGEST="$d"
  SETTLED_ID="$WINDOW_ID"
  SETTLED_CONTENT="$WINDOW_CONTENT"
  clear_window
  write_state
  image_call prune --keep "$d"
  case "$IMG_VERDICT" in PRUNED\ *) ;; *) echo "WARNING: image prune: ${IMG_VERDICT}" ;; esac
  "$PRUNE_CMD" || echo "WARNING: snapshot pruning failed"
  notify "✅ merge-deploy ${x:0:7} is live and settled${prs:+ — $prs}."
  exit 0
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
      open_incident "the unit is no longer our Quadlet (unit=foreign) at +${t}s of the window of ${WINDOW_SHA:0:7}"
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
cancel_window() {
  local pre="$WINDOW_PRE"
  "$DISCARD_CMD" "$pre" >/dev/null 2>&1 || echo "WARNING: could not discard $pre"
  clear_window
  write_state
  once_a_day LAST_ASSESS_NOTICE "$1"
  exit 0
}

# Plan п.9, the activate rows.
activate_candidate() {
  local kind q i d u why
  image_call activate --digest "$D"
  case "$IMG_VERDICT" in
    "ACTIVATED $D")
      DEPLOYED_SHA="$X"
      LAST_SEEN_DEPLOYED_SHA="$X"
      DEPLOYED_DIGEST="$D"
      DEPLOYED_ID="$CAND_ID"
      DEPLOYED_CONTENT="$CAND_CONTENT"
      start_watching
      watch_window 0
      ;;
    ACTIVATE_FAILED\ *)
      window_failed "the activation failed: ${IMG_VERDICT#ACTIVATE_FAILED }"
      ;;
    REFUSED\ *)
      why="${IMG_VERDICT#REFUSED }"
      image_call current
      read -r kind q i d u <<< "$IMG_VERDICT"
      if [ "$kind" = CURRENT ] && [ "$u" = foreign ]; then
        open_incident "the unit is not our Quadlet (unit=foreign); the activation was refused"
      fi
      cancel_window "⚠️ merge-deploy: the activation of ${X:0:7} was refused and changed nothing: ${why} — retrying next tick."
      ;;
    *)
      # 75 or anything else: whether production changed is not known. The window stays
      # `activating`; the next tick looks at what runs (spec §7.2 rows 1–3).
      notify "⚠️ merge-deploy: the activation of ${X:0:7} (${D}) could not be confirmed: ${IMG_VERDICT}. The next tick looks at what runs and finishes or cancels it."
      exit 0
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

# The candidate is past every gate and is not a noop: audit, S local, pre, trial, the window,
# activate, the window watched. Never returns.
deploy_pipeline() {
  local pre name boot kind err
  if ! production_is_record; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: production does not match the record: $(record_mismatch). Not deploying ${X:0:7}; check the host."
    exit 0
  fi
  # Spec §4.2: the advisory is a verdict on X; anything else is "could not verify".
  image_call audit --digest "$D"
  case "$IMG_VERDICT" in
    "CLEAN $D") ;;
    "ADVISORY $D"|"ADVISORY $D"$'\n'*)
      refuse "$X" "npm audit --omit=dev in its image reports a high or critical advisory.
$(tail -n +2 <<< "$IMG_VERDICT")" ;;
    *)
      once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: the audit of ${X:0:7} (${D}) could not run: ${IMG_VERDICT%%$'\n'*} — NOT a finding; retrying next tick."
      exit 0 ;;
  esac
  if ! settled_is_local; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: the settled image ${SETTLED_DIGEST} is not usable as the rollback target: ${IMG_VERDICT%%$'\n'*} (expected id ${SETTLED_ID}, revision ${SETTLED_SHA}). Not deploying ${X:0:7}; retrying next tick."
    exit 0
  fi
  if ! PORT=$("$API_PORT_CMD"); then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not resolve API_PORT — not deploying ${X:0:7}."
    exit 0
  fi
  if ! boot=$("$BOOT_ID_CMD" 2>/dev/null) || ! value_ok WINDOW_BOOT "$boot"; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: could not read the boot id — not deploying ${X:0:7}; retrying next tick."
    exit 0
  fi

  # The trial runs on a pre snapshot of production, by NAME (the helper takes no paths).
  name="$(date -u -d "@$(now)" +%Y%m%dT%H%M%SZ)-${X:0:7}-pre.db"
  pre="${SNAPSHOT_DIR}/${name}"
  if ! err=$("$SNAPSHOT_CMD" "$pre" 2>&1); then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying ${X:0:7}.
${err}"
    exit 0
  fi
  image_call trial --digest "$D" --previous "$SETTLED_DIGEST" --snapshot "$name"
  kind="${IMG_VERDICT%% *}"
  if [ "$IMG_VERDICT" != "OK $SETTLED_DIGEST" ]; then
    # No deploy happened: this pre must not count among the settled ones.
    "$DISCARD_CMD" "$pre" >/dev/null 2>&1 || echo "WARNING: could not discard $pre"
  fi
  case "$kind:$IMG_VERDICT" in
    "OK:OK $SETTLED_DIGEST") ;;
    FAILED:*)
      refuse "$X" "the trial on a copy of production failed: ${IMG_VERDICT#FAILED }
$(tail -n 20 <<< "$IMG_ERR")" ;;
    COMPAT_FAILED:*)
      # Spec §6.3: proven incompatibility — a hold, not a failed SHA. It concerns exactly this
      # pair of images: a new head or a new settled image clears it.
      CANDIDATE_HELD="$X $D $SETTLED_DIGEST"
      CANDIDATE_HELD_WHY="${IMG_VERDICT#COMPAT_FAILED }"
      LAST_HOLD_NOTICE=$(today)
      write_state
      notify "⏸ merge-deploy: ${X:0:7} is HELD — the settled ${SETTLED_SHA:0:7} does not start on the database ${X:0:7} migrated, so a code-only rollback is not possible: ${CANDIDATE_HELD_WHY}
$(tail -n 20 <<< "$IMG_ERR")
Deploy it by hand, without an automatic rollback: bash deploy/deploy.sh --ack-incompatible"
      exit 0 ;;
    REFUSED:*)
      # A precondition (rights, the snapshot, an old S) is fixed on the host, not by a commit:
      # not a hold of X, just not before an hour has passed.
      CANDIDATE_RETRY_X="$X"
      CANDIDATE_RETRY_AT=$(( $(now) + CANDIDATE_RETRY_S ))
      write_state
      once_a_day LAST_HOLD_NOTICE "⏸ merge-deploy: the trial of ${X:0:7} was refused: ${IMG_VERDICT#REFUSED }
$(tail -n 20 <<< "$IMG_ERR")
It is tried again in $(( CANDIDATE_RETRY_S / 60 )) min; nothing is recorded against the commit."
      exit 0 ;;
    *)
      once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: the trial of ${X:0:7} could not judge it: ${IMG_VERDICT} — NOT a finding; retrying next tick."
      exit 0 ;;
  esac

  # Spec §7.1: the window is in the state BEFORE anything changes production.
  WINDOW_SHA="$X"
  WINDOW_DIGEST="$D"
  WINDOW_ID="$CAND_ID"
  WINDOW_CONTENT="$CAND_CONTENT"
  WINDOW_OLD="$DEPLOYED_SHA"
  WINDOW_PREV_DIGEST="$SETTLED_DIGEST"
  WINDOW_MODE=auto
  WINDOW_PHASE=activating
  WINDOW_PRE="$pre"
  WINDOW_BOOT="$boot"
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
    open_incident "the unit is not our Quadlet (unit=foreign) in the ${WINDOW_PHASE} window"
  fi
  case "$WINDOW_PHASE" in
    activating)
      # Row 1: the Quadlet file still names S — activate never ran, production is unchanged.
      if [ "$q" = "$WINDOW_PREV_DIGEST" ]; then
        cancel_window "⚠️ merge-deploy: the deploy of ${X:0:7} was interrupted before its activation; production still runs the settled ${SETTLED_SHA:0:7}, so the window is cancelled and ${X:0:7} is tried again next tick."
      fi
      if [ "$q" != "$WINDOW_DIGEST" ]; then
        open_incident "the Quadlet file names ${q}, neither ${X:0:7} nor the settled image, in an activating window"
      fi
      # Row 3: D already runs — no second restart; the window starts now.
      if [ "$d" = "$WINDOW_DIGEST" ] && [ "$i" = "$WINDOW_ID" ]; then
        DEPLOYED_SHA="$X"
        LAST_SEEN_DEPLOYED_SHA="$X"
        DEPLOYED_DIGEST="$D"
        DEPLOYED_ID="$CAND_ID"
        DEPLOYED_CONTENT="$CAND_CONTENT"
        start_watching
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
      rollback_loop
      ;;
  esac
}

# --- the tick ----------------------------------------------------------------------------------------
read_state || state_corrupt
# Spec §7.3: an open incident blocks everything but PAUSED and the lock — before the window,
# before git, before CI.
if [ -n "$INCIDENT" ]; then
  read -r _inc_sha _inc_digest _inc_reason <<< "$INCIDENT"
  once_a_day LAST_INCIDENT_NOTICE "🔥 merge-deploy: an INCIDENT is open — ${_inc_sha:0:7} (${_inc_digest}): ${_inc_reason}
Nothing deploys until a human resolves it: bash deploy/deploy.sh --resolve-incident --settled <sha>."
  echo "incident open; nothing to do"
  exit 0
fi
resume_window
if [ ! -d "$REPO/.git" ]; then
  git clone -q "$REPO_URL" "$REPO" || {
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: git clone of $REPO_URL failed."
    exit 1
  }
fi
if ! git -C "$REPO" fetch -q --prune origin; then
  once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: git fetch failed."
  exit 1
fi

X=$(git -C "$REPO" rev-parse origin/main)
NOW=$(now)

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

candidate_retry
resolve_digest
candidate_held
attest_image
pull_candidate
read_current
noop_or_continue
deploy_pipeline
