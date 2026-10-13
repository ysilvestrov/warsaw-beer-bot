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
# Exit: 0 idle / wait / noop / settled, 1 refused, 2 rolled back, 3 incident opened or state
#       corrupt, 4 state write failed, 64 usage, 70 not implemented yet (plan Tasks 2–3).
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
# Plan п.17: per-step timeouts of the steps this file runs itself (the helper bounds its own).
STEP_TIMEOUT_RESOLVE_S=40
STEP_TIMEOUT_ATTEST_S=120
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
  body=$(curl -fsS --max-time 5 "http://127.0.0.1:${1}/health" 2>/dev/null) || return 1
  case "$body" in *'"ok":true'*) ;; *) return 1 ;; esac
  sha=$(printf '%s' "$body" | sed -n 's/.*"releaseSha":"\([0-9a-f]\{40\}\)".*/\1/p')
  [ -n "$sha" ] || return 1
  printf '%s\n' "$sha"
}
HEALTH_CMD="${WBB_HEALTH_CMD:-_health_default}"
_restarts_default() { systemctl show -p NRestarts --value warsaw-beer-bot; }
RESTARTS_CMD="${WBB_RESTARTS_CMD:-_restarts_default}"
# Plan п.11: "running" is ActiveState=active, SubState=running, MainPID != 0 (the operator reads it).
_unit_state_default() { systemctl show warsaw-beer-bot -p ActiveState,SubState,MainPID; }
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
_snapshot_default() { _as_bot "$SNAPSHOT_BIN" snapshot "$DB_PATH" "$1"; }
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

# Spec §4.1, plan п.7: equal wbb.content means X changes nothing that runs — but only if what
# runs IS the recorded deployment. Never returns when it decides; returns to deploy otherwise.
noop_or_continue() {
  local keeps
  [ -n "$DEPLOYED_CONTENT" ] && [ "$CAND_CONTENT" = "$DEPLOYED_CONTENT" ] || return 0
  if [ "$CUR_UNIT" != quadlet ] || [ "$CUR_QUADLET" != "$DEPLOYED_DIGEST" ] \
     || [ "$CUR_DIGEST" != "$DEPLOYED_DIGEST" ] || [ "$CUR_IMAGE" != "$DEPLOYED_ID" ]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: ${X:0:7} changes nothing that runs (wbb.content ${CAND_CONTENT}), but production does not match the record: expected quadlet=${DEPLOYED_DIGEST} container-image=${DEPLOYED_ID} container-digest=${DEPLOYED_DIGEST} unit=quadlet, found quadlet=${CUR_QUADLET} container-image=${CUR_IMAGE} container-digest=${CUR_DIGEST} unit=${CUR_UNIT}. Not recording it as deployed; check the host."
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

# Plan Task 2 replaces this stub: audit, the settled image local, pre, trial, window, activate.
deploy_pipeline() {
  echo "deploy_pipeline: Task 2 — not implemented yet; ${X:0:7} (${D}) is not deployed" >&2
  exit 70
}

# Plan Task 3 replaces this stub: a tick that finds a window finishes it first (spec §7.2).
resume_window() {
  [ -n "$WINDOW_PHASE" ] || return 0
  echo "resume_window: Task 3 — not implemented yet; a ${WINDOW_PHASE} window is open" >&2
  exit 70
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

resolve_digest
attest_image
pull_candidate
read_current
noop_or_continue
deploy_pipeline
