#!/usr/bin/env bash
# Merge-deploy — the host deploys the head of origin/main by itself.
# Spec: docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md
#
# The rule: production runs what was merged into main (by a human, or by the
# Dependabot qualifier's auto-merge), after CI passed on THAT commit, unless a
# hold says a human must be present. A merge is the permission; everything
# else is re-derived here before production is touched.
#
# Runs as the operator user (ysi) from wbb-autodeploy.timer and reuses the
# existing NOPASSWD sudoers scope. It NEVER touches the operator's working
# tree: deploy.sh rsyncs `./`, so it runs from a private clone.
#
# Exit: 0 idle/waiting/settled, 1 refused, 2 rolled back, 3 rollback failed,
#       4 state write failed.
set -euo pipefail
# notify() cuts messages by CHARACTERS. Under systemd's default C locale bash
# counts bytes and can cut a UTF-8 character in half, which Telegram rejects.
export LC_ALL=C.UTF-8

REPO_URL=https://github.com/ysilvestrov/warsaw-beer-bot.git
GH_REPO=ysilvestrov/warsaw-beer-bot
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
REPO="$DATA_DIR/repo"
STATE="$STATE_DIR/state.env"
LOCK="$STATE_DIR/lock"
NOTIFY_LIMIT=3500
QUIET_S=600
CI_STUCK_S=3600
STARTUP_S=60
WINDOW_S=600
POLL_S=10
KEEP_SNAPSHOTS=3
SNAPSHOT_DIR="${WBB_SNAPSHOT_DIR:-/var/lib/warsaw-beer-bot/deploy-snapshots}"
DB_PATH="${WBB_DB_PATH:-/var/lib/warsaw-beer-bot/bot.db}"

SHIPS_BIN="${WBB_SHIPS:-/usr/local/bin/wbb-ships}"
READ_ENV_BIN="${WBB_READ_ENV:-/usr/local/bin/wbb-read-env}"
INSTALLED_CHECK_BIN="${WBB_INSTALLED_CHECK:-/usr/local/bin/wbb-installed-current}"
# Merge-deploy — the snapshot helper, installed like the guard and the predicate.
SNAPSHOT_BIN="${WBB_SNAPSHOT_BIN:-/usr/local/bin/wbb-db-snapshot}"
TRIAL_BIN="${WBB_TRIAL_BIN:-/usr/local/bin/wbb-trial-migrate}"

# --- seams --------------------------------------------------------------------
# I2 (#435), kept: every contact with the outside world is ONE swappable
# command that defaults to the real thing, so a test substitutes all of them
# and never touches sudo, systemd, /opt, GitHub or the network.
_clock_default() { date +%s; }
CLOCK_CMD="${WBB_CLOCK_CMD:-_clock_default}"
_sleep_default() { sleep "$1"; }
SLEEP_CMD="${WBB_SLEEP_CMD:-_sleep_default}"

# ONE probe, no loop: wait_healthy and the watch window own the timing.
_health_default() {
  local body
  body=$(curl -fsS --max-time 3 "http://127.0.0.1:${1}/health" 2>/dev/null) || return 1
  case "$body" in *'"ok":true'*) return 0 ;; esac
  return 1
}
HEALTH_CMD="${WBB_HEALTH_CMD:-_health_default}"
_restarts_default() { systemctl show -p NRestarts --value warsaw-beer-bot; }
RESTARTS_CMD="${WBB_RESTARTS_CMD:-_restarts_default}"

_deploy_default() { ./deploy/deploy.sh; }
DEPLOY_CMD="${WBB_DEPLOY_CMD:-_deploy_default}"
_build_default() { npm ci --no-audit --no-fund && npm run build; }
BUILD_CMD="${WBB_BUILD_CMD:-_build_default}"
# npm audit's exit 1 = advisories at/above the level; any other non-zero = it
# could not run (I3). Callers keep the two apart.
_audit_default() { npm audit --omit=dev --audit-level=high; }
AUDIT_CMD="${WBB_AUDIT_CMD:-_audit_default}"

# GitHub, read as the operator's `gh` (P3: works under the unit's environment).
# One line per check run: name<TAB>status<TAB>conclusion.
_checks_default() {
  gh api "repos/${GH_REPO}/commits/$1/check-runs" --paginate \
    --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'
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
  # Deliberately NOT via the bot: if the deploy took the bot down, the bot
  # cannot report that it is down.
  local tok chat
  tok=$("$READ_ENV_CMD" TELEGRAM_BOT_TOKEN)
  chat=$("$READ_ENV_CMD" ADMIN_TELEGRAM_ID)
  if [ -z "$tok" ] || [ -z "$chat" ]; then
    echo "WARNING: notifier has no token or chat id; cannot report: $1" >&2
    return 1
  fi
  curl -fsS -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=$1" >/dev/null
}
NOTIFY_CMD="${WBB_NOTIFY_CMD:-_notify_default}"
_api_port_default() {
  local p
  p=$("$READ_ENV_CMD" API_PORT)
  echo "${p:-3000}"
}
API_PORT_CMD="${WBB_API_PORT_CMD:-_api_port_default}"

# DB helpers run as the bot user through the existing `bash -lc` rule (P3), so
# snapshots are owned by warsaw-beer-bot and live next to bot.db.
_as_bot() { sudo -u warsaw-beer-bot bash -lc '"$0" "$@"' "$@"; }
_snapshot_default() { _as_bot "$SNAPSHOT_BIN" snapshot "$DB_PATH" "$1"; }
SNAPSHOT_CMD="${WBB_SNAPSHOT_CMD:-_snapshot_default}"
_prune_default() { _as_bot "$SNAPSHOT_BIN" prune "$SNAPSHOT_DIR" "$KEEP_SNAPSHOTS"; }
PRUNE_CMD="${WBB_PRUNE_CMD:-_prune_default}"
_trial_default() { node "$TRIAL_BIN" "$REPO" "$1"; }
TRIAL_CMD="${WBB_TRIAL_CMD:-_trial_default}"

now() { "$CLOCK_CMD"; }

# --- brake, lock --------------------------------------------------------------
# Unprivileged emergency stop (#435 §7): arming the timer costs a password, so
# stopping it must not. Checked before anything else; a paused tick writes
# nothing and says nothing.
if [ -f "$STATE_DIR/PAUSED" ]; then
  echo "wbb-autodeploy: paused ($STATE_DIR/PAUSED exists); exiting quietly"
  exit 0
fi
mkdir -p "$DATA_DIR" "$STATE_DIR"
# Excludes overlapping ticks — a tick can now last the whole 10-min window.
# It does NOT exclude a manual deploy.sh; a manual deploy means a human is
# present, which is the case this mechanism defers to.
exec 9>"$LOCK"
flock -n 9 || { echo "another tick holds the lock; exiting"; exit 0; }

# --- state ----------------------------------------------------------------------
DEPLOYED_SHA=""
PREVIOUS_SHA=""
LAST_FAILED_SHA=""
MAIN_SEEN_SHA=""
MAIN_SEEN_S=""
LAST_CI_NOTICE_SHA=""
LAST_HOLD_NOTICE=""
LAST_STALE_NOTICE=""
LAST_ASSESS_NOTICE=""
# shellcheck disable=SC1090
if [ -f "$STATE" ]; then . "$STATE"; fi

# I6: Telegram caps sendMessage at 4096 chars, and a notify failure must never
# abort the run unnoticed.
notify() {
  local msg="$1"
  if [ "${#msg}" -gt "$NOTIFY_LIMIT" ]; then
    msg="${msg:0:$NOTIFY_LIMIT}"$'\n… truncated'
  fi
  "$NOTIFY_CMD" "$msg" || echo "WARNING: notify failed: $msg"
}

# #497, kept: every key is carried from a shell variable, so a caller changes
# one by ASSIGNING it, never by passing it. Keys not listed here — the old
# DRIFT_SINCE / LAST_DRIFT_NOTICE — are dropped by the first write.
STATE_KEYS=(LAST_FAILED_SHA MAIN_SEEN_SHA MAIN_SEEN_S LAST_CI_NOTICE_SHA LAST_HOLD_NOTICE LAST_STALE_NOTICE LAST_ASSESS_NOTICE)
write_state() {
  local k
  if ! {
    printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=%s\n' "$DEPLOYED_SHA" "$PREVIOUS_SHA"
    for k in "${STATE_KEYS[@]}"; do
      if [ -n "${!k}" ]; then printf '%s=%s\n' "$k" "${!k}"; fi
    done
  } > "$STATE.tmp" 2>/dev/null || ! mv "$STATE.tmp" "$STATE" 2>/dev/null; then
    notify "🔥 merge-deploy: failed to write $STATE — its record of what is deployed may now disagree with production."
    exit 4
  fi
}

# A standing condition is reported at most once per UTC day, per marker.
once_a_day() {
  local var="$1" msg="$2" today
  today=$(date -u +%Y-%m-%d)
  [ "${!var}" != "$today" ] || return 0
  notify "$msg"
  printf -v "$var" '%s' "$today"
  write_state
}

# A gate the COMMIT failed. Recorded, so the same head is never retried; the
# next merge is.
refuse() {
  notify "⛔ merge-deploy refused ${1:0:7}: $2"
  LAST_FAILED_SHA="$1"
  write_state
  exit 1
}

# --- installed copies -------------------------------------------------------------
# /usr/local/bin holds COPIES on purpose; a merged fix is not live until
# installed. The honest limit: this check lives in the file it checks.
installed_is_stale() {
  [ -n "$INSTALLED_CHECK_BIN" ] || return 1
  [ -x "$INSTALLED_CHECK_BIN" ] || return 1
  ! STALE_REPORT=$("$INSTALLED_CHECK_BIN" "$REPO" origin/main \
      "deploy/autodeploy.sh=$0" \
      "deploy/read-env.sh=$READ_ENV_BIN" \
      "deploy/ships.sh=$SHIPS_BIN" \
      "deploy/db-snapshot.sh=$SNAPSHOT_BIN" \
      "deploy/trial-migrate.cjs=$TRIAL_BIN" \
      "deploy/installed-current.sh=$INSTALLED_CHECK_BIN" 2>&1)
}

report_stale_once() {
  installed_is_stale || return 0
  once_a_day LAST_STALE_NOTICE "⚠️ merge-deploy: the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
Run: sudo bash deploy/install-autodeploy.sh"
}

# #527 — the paths of diff(DEPLOYED_SHA, $1) that actually reach production,
# one per line on stdout.
#
# Non-zero exit means WE COULD NOT TELL. That is not the same statement as
# "nothing ships", and the caller must not collapse them: the quiet branch in
# report_drift_once is quieter than #499's reassuring message, so a failure
# folded into it would be an outage nobody hears about.
#
# The filter is read from BOTH sides — DEPLOYED_SHA and $1 — and the SHIP set
# is their UNION, for the reason spelled out in autodeploy-guard.sh: deploy.sh
# rsyncs with `--delete --delete-excluded`, so a path that stops shipping is
# DELETED from /opt. Reading only the target's filter lets a narrowing commit
# cloak itself and everything it drops. Here the consequence is silence rather
# than a deploy, but the same rule applies, and a short or missing answer is
# "cannot assess" (return 1), never "nothing ships".
shipping_paths() {
  local main_sha="$1" target_filter deployed_filter diff_out c_target c_deployed
  local expected=0 line i verdict path
  target_filter=$(mktemp) || return 1
  deployed_filter=$(mktemp) || { rm -f "$target_filter"; return 1; }

  if ! git -C "$REPO" show "${main_sha}:deploy/rsync-filter" > "$target_filter" 2>/dev/null; then
    rm -f "$target_filter" "$deployed_filter"
    return 1
  fi
  if ! git -C "$REPO" show "${DEPLOYED_SHA}:deploy/rsync-filter" > "$deployed_filter" 2>/dev/null; then
    rm -f "$target_filter" "$deployed_filter"
    return 1
  fi
  # `-c core.quotePath=false`: without it git C-quotes a non-ASCII path (e.g.
  # `"src/\303\251.ts"`), which ships.sh refuses on sight (the quoted form is
  # not the path it names) — an ordinary merge would needlessly report
  # "cannot assess".
  if ! diff_out=$(git -C "$REPO" -c core.quotePath=false diff --name-only "$DEPLOYED_SHA" "$main_sha" 2>/dev/null); then
    rm -f "$target_filter" "$deployed_filter"
    return 1
  fi
  if ! c_target=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$target_filter" 2>/dev/null); then
    rm -f "$target_filter" "$deployed_filter"
    return 1
  fi
  if ! c_deployed=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$deployed_filter" 2>/dev/null); then
    rm -f "$target_filter" "$deployed_filter"
    return 1
  fi
  rm -f "$target_filter" "$deployed_filter"

  local in_paths=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then in_paths+=("$line"); fi
  done <<< "$diff_out"
  expected=${#in_paths[@]}

  local t_verdicts=() t_paths=() d_verdicts=() d_paths=()
  while IFS=' ' read -r verdict path; do
    if [ -z "$path" ]; then continue; fi
    case "$verdict" in SHIP|SKIP) ;; *) return 1 ;; esac
    t_verdicts+=("$verdict")
    t_paths+=("$path")
  done <<< "$c_target"
  while IFS=' ' read -r verdict path; do
    if [ -z "$path" ]; then continue; fi
    case "$verdict" in SHIP|SKIP) ;; *) return 1 ;; esac
    d_verdicts+=("$verdict")
    d_paths+=("$path")
  done <<< "$c_deployed"

  # I2 — a classifier that answered for fewer lines than it was handed has told
  # us nothing, and "nothing" must not read as "nothing ships". Nor is the count
  # sufficient: N verdicts about N INVENTED paths also counts to N, and would
  # report "nothing ships" for a diff full of src/**. Both answers must be about
  # the paths that were asked about, at the same positions — otherwise this is
  # "cannot assess" (return 1), never silence.
  if [ "${#t_paths[@]}" -ne "$expected" ] || [ "${#d_paths[@]}" -ne "$expected" ]; then
    return 1
  fi

  i=0
  while [ "$i" -lt "$expected" ]; do
    if [ "${t_paths[$i]}" != "${in_paths[$i]}" ]; then return 1; fi
    if [ "${d_paths[$i]}" != "${in_paths[$i]}" ]; then return 1; fi
    i=$((i + 1))
  done

  i=0
  while [ "$i" -lt "$expected" ]; do
    if [ "${t_verdicts[$i]}" = SHIP ] || [ "${d_verdicts[$i]}" = SHIP ]; then
      printf '%s\n' "${in_paths[$i]}"
    fi
    i=$((i + 1))
  done
}

# --- holds ------------------------------------------------------------------------
# Paths whose change needs a human on the host: root-installed files, units
# other than the bot's own (deploy.sh installs that one), and every installed
# copy of this deployer. Changing this list is itself a hold (it lives here).
path_is_held() {
  case "$1" in
    deploy/warsaw-beer-bot.service) return 1 ;;
    deploy/sudoers.d/*|deploy/*.service|deploy/*.timer|deploy/litestream.*|deploy/install-*.sh) return 0 ;;
    deploy/autodeploy.sh|deploy/autodeploy-guard.sh|deploy/ships.sh|deploy/read-env.sh) return 0 ;;
    deploy/installed-current.sh|deploy/db-snapshot.sh|deploy/trial-migrate.cjs) return 0 ;;
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
  local x="$1" paths commits c out pr labels f
  HOLDS=()
  RANGE_PRS=()
  if ! paths=$(git -C "$REPO" -c core.quotePath=false diff --name-only "$DEPLOYED_SHA" "$x"); then
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
    done <<< "$out"
  done <<< "$commits"
}

# --- CI ---------------------------------------------------------------------------
# PASS | WAIT | FAIL <name=conclusion ...>. Non-zero = could not read.
# The required `ci` must be present AND successful; its absence is WAIT.
ci_verdict() {
  local out name status conclusion ci_ok=0 pending=0 failed=()
  out=$("$CHECKS_CMD" "$1") || return 1
  while IFS=$'\t' read -r name status conclusion; do
    if [ -z "$name" ]; then continue; fi
    if [ "$status" != completed ]; then pending=1; continue; fi
    case "$conclusion" in
      success|skipped|neutral) ;;
      *) failed+=("${name}=${conclusion}") ;;
    esac
    if [ "$name" = ci ] && [ "$conclusion" = success ]; then ci_ok=1; fi
  done <<< "$out"
  if [ "${#failed[@]}" -gt 0 ]; then echo "FAIL ${failed[*]}"; return 0; fi
  if [ "$pending" = 1 ] || [ "$ci_ok" = 0 ]; then echo WAIT; return 0; fi
  echo PASS
}

# --- deploy primitives ----------------------------------------------------------------
# C2 (#435), kept: check explicitly — inside an `if`, set -e is off.
# I5, kept: `clean -xdff` because rsync ships the TREE, not the diff.
checkout_clean() {
  git -C "$REPO" checkout -q --detach "$1" || return 1
  git -C "$REPO" clean -xdffq || return 1
}

wait_healthy() {
  local port="$1" limit="$2" start
  start=$(now)
  while :; do
    if "$HEALTH_CMD" "$port"; then return 0; fi
    if [ $(( $(now) - start )) -ge "$limit" ]; then return 1; fi
    "$SLEEP_CMD" 2
  done
}

# D5/D6: ten minutes after the deploy, anything that goes wrong is the
# deploy's fault and is rolled back; after that, it is an ordinary incident.
# Polls /health and NRestarts (a crash loop can look healthy between polls).
watch_window() {
  local port="$1" start r0 r t
  start=$(now)
  r0=$("$RESTARTS_CMD" 2>/dev/null) || r0=""
  while :; do
    t=$(( $(now) - start ))
    if [ "$t" -ge "$WINDOW_S" ]; then return 0; fi
    if ! "$HEALTH_CMD" "$port"; then
      WATCH_REASON="health check failed at +${t}s"
      return 1
    fi
    r=$("$RESTARTS_CMD" 2>/dev/null) || r=""
    if [ -n "$r0" ] && [ "$r" != "$r0" ]; then
      WATCH_REASON="service restarted (NRestarts ${r0} -> ${r}) at +${t}s"
      return 1
    fi
    "$SLEEP_CMD" "$POLL_S"
  done
}

settle() {
  local prs="${RANGE_PRS[*]}"
  PREVIOUS_SHA="$2"
  DEPLOYED_SHA="$1"
  write_state
  notify "✅ merge-deploy ${1:0:7} is live and settled${prs:+ — $prs}."
  exit 0
}

# Code-only until Task 5.
roll_back() {
  LAST_FAILED_SHA="$1"
  write_state
  notify "⚠️ merge-deploy ${1:0:7} failed: $2 — rolling back to ${DEPLOYED_SHA:0:7}."
  if checkout_clean "$DEPLOYED_SHA" && ( cd "$REPO" && "$DEPLOY_CMD" ) && wait_healthy "$PORT" "$STARTUP_S"; then
    notify "↩️ rollback to ${DEPLOYED_SHA:0:7} succeeded. ${1:0:7} needs a human."
    exit 2
  fi
  notify "🔥 ROLLBACK FAILED. Production is DOWN at ${DEPLOYED_SHA:0:7}. Manual intervention required."
  exit 3
}

deploy_pipeline() {
  local x="$1" old="$DEPLOYED_SHA" out status pre pre_t trial
  if ! checkout_clean "$x"; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not check out ${x:0:7}."
    exit 1
  fi
  if ! out=$(cd "$REPO" && "$BUILD_CMD" 2>&1); then
    refuse "$x" "the build failed.
$(tail -n 20 <<< "$out")"
  fi
  out=$(cd "$REPO" && "$AUDIT_CMD" 2>&1) && status=0 || status=$?
  if [ "$status" -eq 1 ]; then
    refuse "$x" "npm audit --omit=dev reports a high or critical advisory.
$out"
  elif [ "$status" -ne 0 ]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: npm audit could not run (exit ${status}) for ${x:0:7} — NOT a finding, just no verification. Retrying next tick.
$out"
    exit 1
  fi

  # D4 + P1: VACUUM INTO, one point in time. A failed snapshot is the host's
  # problem, not the commit's: no LAST_FAILED_SHA, retried next tick.
  pre="${SNAPSHOT_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${x:0:7}-pre.db"
  pre_t=$(date -u +%H:%M:%S)
  if ! out=$("$SNAPSHOT_CMD" "$pre" 2>&1); then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying ${x:0:7}.
$out"
    exit 1
  fi

  # The trial runs on a COPY of pre, in the operator's own data dir.
  trial="$DATA_DIR/trial.db"
  rm -f "$trial" "$trial-wal" "$trial-shm"
  if ! cp "$pre" "$trial"; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not copy the snapshot for the trial migration — not deploying ${x:0:7}."
    exit 1
  fi
  out=$("$TRIAL_CMD" "$trial" 2>&1) && status=0 || status=$?
  rm -f "$trial" "$trial-wal" "$trial-shm"
  if [ "$status" -ne 0 ]; then
    refuse "$x" "the trial migration on a copy of production failed.
$out"
  fi
  echo "$out"

  echo "deploying $x"
  if ! ( cd "$REPO" && "$DEPLOY_CMD" ); then
    roll_back "$x" "deploy.sh failed" "$pre" "$pre_t"
  fi
  if ! wait_healthy "$PORT" "$STARTUP_S"; then
    roll_back "$x" "not healthy within ${STARTUP_S}s" "$pre" "$pre_t"
  fi
  if ! watch_window "$PORT"; then
    roll_back "$x" "$WATCH_REASON" "$pre" "$pre_t"
  fi
  "$PRUNE_CMD" || echo "WARNING: snapshot pruning failed"
  settle "$x" "$old"
}

# --- the tick ---------------------------------------------------------------------
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

if [ -z "$DEPLOYED_SHA" ]; then
  once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: no recorded baseline. Deploy once by hand (bash deploy/deploy.sh), then this becomes automatic."
  exit 0
fi
if [ "$X" = "$DEPLOYED_SHA" ]; then
  report_stale_once
  echo "up to date at $X"
  exit 0
fi
# The downgrade check that used to live in the guard.
if ! git -C "$REPO" rev-parse -q --verify "${DEPLOYED_SHA}^{commit}" >/dev/null \
   || ! git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$X"; then
  once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: production (${DEPLOYED_SHA:0:7}) is not an ancestor of main (${X:0:7}) — refusing what could be a downgrade. Deploy main by hand to reseed."
  exit 0
fi
# #527, kept: "could not tell" is its own state, never "nothing ships".
if ! shipping=$(shipping_paths "$X"); then
  once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy cannot tell whether production is behind main: classifying diff(${DEPLOYED_SHA:0:7}, ${X:0:7}) against deploy/rsync-filter failed. Treat deploys as blocked until this is understood."
  exit 0
fi
if [ -z "$shipping" ]; then
  report_stale_once
  echo "nothing that ships differs between $DEPLOYED_SHA and $X"
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
Run: sudo bash deploy/install-autodeploy.sh"
  exit 0
fi
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
      once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: CI has not concluded on ${X:0:7} after $(( (NOW - MAIN_SEEN_S) / 60 )) min (the required 'ci' check is pending or absent)."
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
if ! PORT=$("$API_PORT_CMD"); then
  once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not resolve API_PORT — not deploying ${X:0:7}."
  exit 1
fi

deploy_pipeline "$X"
