#!/usr/bin/env bash
# #435 — unattended deploy of a qualified dependency fix.
#
# Runs as the operator user (ysi) so it reuses the existing NOPASSWD sudoers
# scope; it requires no new privilege. It NEVER touches the operator's working
# tree at /home/ysi/warsaw-beer-bot — deploy.sh rsyncs `./`, so running from
# there would ship whatever happens to be uncommitted.
set -euo pipefail

REPO_URL=https://github.com/ysilvestrov/warsaw-beer-bot.git
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
REPO="$DATA_DIR/repo"
STATE="$STATE_DIR/state.env"
LOCK="$STATE_DIR/lock"
LAST_DRIFT_NOTICE=""
LAST_STALE_NOTICE=""
DRIFT_SINCE=""
HEALTH_TIMEOUT_S=60
NOTIFY_LIMIT=3500
# #490: drift is the normal state of the minutes between a merge and the deploy
# that follows it. What makes it worth a message is DURATION, not existence —
# so the episode has to have a beginning, and the beginning has to be storable.
DRIFT_GRACE_S=900
# The clock is a seam like every other external contact in this file: 15 minutes
# cannot be tested against the wall clock, and an untestable grace period is how
# the drift branch ended up with no tests at all.
NOW_S="${WBB_NOW_S:-$(date +%s)}"

# The guard comes from the INSTALLED copy, never from the checkout we just
# fetched into: a guard that ships with the commit it is judging is not a guard.
GUARD_BIN="${WBB_GUARD:-/usr/local/bin/wbb-autodeploy-guard}"

# I2 — this script's only points of contact with the outside world: deploy,
# health check, notify, port lookup, and the security audit. Each is a single
# swappable command that defaults to today's real behaviour, so a test can
# substitute a stub for every one of them and never touch sudo, systemd,
# /opt or the network.
_deploy_default() { ./deploy/deploy.sh; }
DEPLOY_CMD="${WBB_DEPLOY_CMD:-_deploy_default}"

_health_default() {
  local port="$1" deadline body
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    body=$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" 2>/dev/null || true)
    case "$body" in *'"ok":true'*) return 0 ;; esac
    sleep 2
  done
  return 1
}
HEALTH_CMD="${WBB_HEALTH_CMD:-_health_default}"

# Reads ONE key out of the operator env file. The parsing lives in
# deploy/read-env.sh so the SAME code that runs in production can be exercised
# by a test without sudo — see the header there for why `. file` is wrong.
# Installed alongside the deployer, like the guard: this script is a COPY in
# /usr/local/bin, so it cannot reach its sibling through its own path.
READ_ENV_BIN="${WBB_READ_ENV:-/usr/local/bin/wbb-read-env}"
# Same install-path pattern as the guard.
INSTALLED_CHECK_BIN="${WBB_INSTALLED_CHECK:-/usr/local/bin/wbb-installed-current}"
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

# npm audit talks to the registry — it belongs in this swappable set too, or
# a test exercising the deploy path would make a real network call.
_audit_default() { ( cd "$REPO" && npm audit --omit=dev --audit-level=high ); }
AUDIT_CMD="${WBB_AUDIT_CMD:-_audit_default}"

# Unprivileged emergency stop (#435 §7 amendment): arming the timer costs a
# password (sudoers pins systemctl to the warsaw-beer-bot and litestream
# units, not to wbb-autodeploy), so stopping it must not — or the brake is
# unavailable exactly when the operator is asleep. Any unprivileged process
# can create this file; see deploy/README.md. Checked before `mkdir -p` and
# well before `flock` does any real work, so a paused deployer does almost
# nothing — a journal line, no Telegram message (notify() isn't even defined
# yet at this point in the script).
if [ -f "$STATE_DIR/PAUSED" ]; then
  echo "wbb-autodeploy: paused ($STATE_DIR/PAUSED exists); exiting quietly"
  exit 0
fi

mkdir -p "$DATA_DIR" "$STATE_DIR"

# Prevents overlapping autodeploy runs. It does NOT exclude a manual
# ./deploy/deploy.sh, which takes no lock — but a manual deploy means the
# operator is present, which is the case this whole mechanism defers to.
exec 9>"$LOCK"
flock -n 9 || { echo "another autodeploy holds the lock; exiting"; exit 0; }

# I6: a guard refusal embeds the full violation list, and Telegram's
# sendMessage caps at 4096 chars — the realistic long refusal was silently
# becoming an HTTP 400 with nobody reading the journal. Truncate first, and
# never let a notify failure itself abort the run unnoticed.
notify() {
  local msg="$1"
  if [ "${#msg}" -gt "$NOTIFY_LIMIT" ]; then
    msg="${msg:0:$NOTIFY_LIMIT}"$'\n… truncated'
  fi
  "$NOTIFY_CMD" "$msg" || echo "WARNING: notify failed: $msg"
}

api_port() { "$API_PORT_CMD"; }

healthy() { "$HEALTH_CMD" "$1"; }

deploy_commit() {
  # C2: this used to run deploy.sh unconditionally even when the checkout
  # failed. Both call sites are `if deploy_commit ... && healthy; then` —
  # inside an `if` condition, `set -e` is suppressed for the ENTIRE
  # condition, including this function's body, so a failing
  # `git checkout --detach` fell straight through into deploy.sh. On the
  # rollback path that meant re-deploying the broken target while telling
  # the operator the rollback had succeeded. Check explicitly instead of
  # relying on inherited errexit.
  git -C "$REPO" checkout -q --detach "$1" || return 1
  # I5: the guard bounds the DIFF; rsync ships the TREE, and those are
  # different statements. `checkout --detach` leaves untracked files in
  # place, and deploy.sh rsyncs `./` with --delete — so anything left over
  # from a previous checkout would ship regardless of what the guard saw.
  git -C "$REPO" clean -xdff || return 1
  ( cd "$REPO" && "$DEPLOY_CMD" )
}

# C3: writes the state file, preserving DEPLOYED_SHA/PREVIOUS_SHA and setting
# (or clearing, if $3 is empty) LAST_FAILED_SHA.
#
# #497: the three daily/episode markers are NOT parameters. They used to be
# positions 4-6, carried by default (`${4:-$LAST_DRIFT_NOTICE}`), and that form
# let a LATER call in the same tick silently decide what an EARLIER one had
# persisted: report_stale_once passed its marker as argument 5 without assigning
# the variable, and report_drift_once's four-argument write moments later fell
# back to the still-empty variable and dropped the line. Reading the shell
# variables directly does not merely fix that — it makes it unwriteable. A
# caller that wants to change one of these ASSIGNS it, then calls.
write_state() {
  local deployed="$1" previous="$2" last_failed="${3:-}"
  {
    printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=%s\n' "$deployed" "$previous"
    # `if`, not `[ -n ... ] &&` — the latter, as the group's last statement,
    # would leak ITS OWN exit status (1 when last_failed is empty) out of
    # the whole `{ ... }` group and into the `||` below, tripping the
    # "failed to write state" path even though the write succeeded.
    if [ -n "$last_failed" ]; then
      printf 'LAST_FAILED_SHA=%s\n' "$last_failed"
    fi
    # Carried on every write so a deploy does not reset the once-a-day drift
    # reminder and turn a standing condition back into a siren.
    if [ -n "$LAST_DRIFT_NOTICE" ]; then
      printf 'LAST_DRIFT_NOTICE=%s\n' "$LAST_DRIFT_NOTICE"
    fi
    if [ -n "$LAST_STALE_NOTICE" ]; then
      printf 'LAST_STALE_NOTICE=%s\n' "$LAST_STALE_NOTICE"
    fi
    if [ -n "$DRIFT_SINCE" ]; then
      printf 'DRIFT_SINCE=%s\n' "$DRIFT_SINCE"
    fi
  } > "$STATE" || {
    # I6: the state write used to abort silently under set -e. A failure
    # here means the file on disk may now disagree with what is actually
    # running — that is worth waking a human for.
    notify "🔥 autodeploy: failed to write $STATE — its record of what is deployed may now disagree with production."
    exit 4
  }
}

# Drift: production behind main blocks autodeploy, and does so INVISIBLY.
# The guard diffs from the deployed commit, so every merge that is not
# deployed adds paths to that diff; once it leaves the allowlist every future
# security tag is refused, and a refusal looks exactly like the guard working
# correctly. MEASURED 2026-08-18: three merges, twelve files, autodeploy dead
# with no error anywhere.
#
# deploy.sh now records the baseline itself, so this should not happen — but
# "should not happen" is what the last two incidents had in common, and a
# deploy that bypassed deploy.sh entirely would still produce it.
#
# Called ONLY on the idle path. If a tag is pending, the guard either deploys
# it or refuses it with the offending paths listed, and a second message about
# the same condition is noise. Reported at most ONCE A DAY: drift is a standing
# condition, not an event, and a siren every five minutes is the failure mode
# this script already had to fix once.
# Is the deployer running the code that was merged? /usr/local/bin holds
# COPIES on purpose — the running deployer must not change under a
# `git checkout` — and the same property means a merged fix is not a live fix
# until someone installs it. MEASURED 2026-08-18: a guard fix was merged while
# the timer kept running the old copy, and only memory caught it.
#
# Idle: report once a day. Tag pending: REFUSE. Deploying production with
# safety logic we know is out of date is the exact risk this whole mechanism
# exists to manage — the stale copy that day was missing `--prune-tags` and
# the downgrade check.
#
# The honest limit, same as the PAUSED brake: this check lives in the very
# file it checks, so it cannot catch a copy so old it predates the check.
installed_is_stale() {
  [ -n "$INSTALLED_CHECK_BIN" ] || return 1
  [ -x "$INSTALLED_CHECK_BIN" ] || return 1
  ! STALE_REPORT=$("$INSTALLED_CHECK_BIN" "$REPO" origin/main \
      "deploy/autodeploy.sh=$0" \
      "deploy/autodeploy-guard.sh=$GUARD_BIN" \
      "deploy/read-env.sh=$READ_ENV_BIN" \
      "deploy/installed-current.sh=$INSTALLED_CHECK_BIN" 2>&1)
}

report_stale_once() {
  local today
  today=$(date -u +%Y-%m-%d)
  installed_is_stale || return 0
  [ "$LAST_STALE_NOTICE" != "$today" ] || return 0
  notify "⚠️ the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
Run: sudo bash deploy/install-autodeploy.sh"
  # #497: assign, then let write_state carry it. Passing "$today" positionally
  # left LAST_STALE_NOTICE empty, and report_drift_once's write in the same
  # tick then persisted that emptiness over the marker just written.
  LAST_STALE_NOTICE="$today"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
}

report_drift_once() {
  local main_sha today behind outside
  main_sha=$(git -C "$REPO" rev-parse origin/main 2>/dev/null || echo '')
  today=$(date -u +%Y-%m-%d)

  [ -n "$DEPLOYED_SHA" ] || return 0
  [ -n "$main_sha" ] || return 0

  # No drift. Two cases: an episode was open, or there never was one.
  if [ "$DEPLOYED_SHA" = "$main_sha" ]; then
    [ -n "$DRIFT_SINCE" ] || return 0
    # Only close out loud if we spoke. An all-clear for an alarm that never
    # sounded is noise, and it would arrive on exactly the path this change
    # exists to keep quiet: merge, deploy, done, nobody disturbed.
    if [ -n "$LAST_DRIFT_NOTICE" ]; then
      notify "✅ production has caught up with main — unattended deploys work again."
    fi
    DRIFT_SINCE=""
    LAST_DRIFT_NOTICE=""
    write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
    return 0
  fi

  # Drift, and no episode open yet: start the clock, say nothing. This is the
  # merge that just happened; the person who made it is probably deploying.
  if [ -z "$DRIFT_SINCE" ]; then
    DRIFT_SINCE="$NOW_S"
    write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
    return 0
  fi

  # Inside the grace window: still nothing.
  [ $((NOW_S - DRIFT_SINCE)) -ge "$DRIFT_GRACE_S" ] || return 0

  [ "$LAST_DRIFT_NOTICE" != "$today" ] || return 0

  behind=$(git -C "$REPO" rev-list --count "${DEPLOYED_SHA}..${main_sha}" 2>/dev/null || echo '?')
  outside=$(git -C "$REPO" diff --name-only "$DEPLOYED_SHA" "$main_sha" 2>/dev/null |
    { n=0; while read -r f; do case "$f" in package.json|package-lock.json) ;; *) n=$((n+1));; esac; done; echo "$n"; })

  if [ "$outside" != "0" ]; then
    notify "⚠️ autodeploy is BLOCKED: production is ${behind} commit(s) behind main, and ${outside} differing path(s) are outside the allowlist. Every security tag will be refused until production is deployed. Run ./deploy/deploy.sh."
  else
    notify "ℹ️ production is ${behind} commit(s) behind main, but only the manifest and lockfile differ — autodeploy still works."
  fi
  LAST_DRIFT_NOTICE="$today"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
}

# --- fetch -------------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  git clone -q "$REPO_URL" "$REPO" || { notify "⛔ autodeploy: git clone of $REPO_URL failed."; exit 1; }
fi
# --prune-tags, not just --prune: `--prune` deletes stale BRANCHES only, so a
# tag removed upstream survives in this clone forever and keeps being selected.
# MEASURED 2026-08-18, on the first unattended run: a throwaway test tag deleted
# from origin was still here, pointed at a commit OLDER than the deployed one,
# and the guard had to catch it as a downgrade. The guard did its job; this is
# the reason it was asked to.
git -C "$REPO" fetch -q --tags --prune --prune-tags origin || { notify "⛔ autodeploy: git fetch failed."; exit 1; }

# shellcheck disable=SC1090
if [ -f "$STATE" ]; then . "$STATE"; fi
DEPLOYED_SHA="${DEPLOYED_SHA:-}"
PREVIOUS_SHA="${PREVIOUS_SHA:-}"
LAST_FAILED_SHA="${LAST_FAILED_SHA:-}"
LAST_DRIFT_NOTICE="${LAST_DRIFT_NOTICE:-}"
LAST_STALE_NOTICE="${LAST_STALE_NOTICE:-}"
DRIFT_SINCE="${DRIFT_SINCE:-}"

# Minor: lightweight tags sort by the TAGGED COMMIT's committer date under
# -creatordate, not by when the tag was made — a tag on a backdated commit
# could then outrank a newer one, and the guard would accept a downgrade.
# Tag names are ISO-8601 timestamps, so lexical order is chronological.
tag=$(git -C "$REPO" for-each-ref --sort=-refname --format='%(refname:short)' \
        --count=1 'refs/tags/autodeploy-*')

# #491: what makes the deployer idle is having no WORK, not having no TAG.
# The old gate was `[ -n "$tag" ] || { ...report...; exit 0; }` — literally
# "no autodeploy-* tag has ever been pushed". Tags are permanent, so the first
# qualified merge turned the drift AND stale-deployer reports off forever, and
# they worked at all only because none had ever been pushed. The three
# diagnostic lines below are kept verbatim: they say different things and are
# read in the journal.
pending=""
target=""
if [ -z "$tag" ]; then
  echo "no autodeploy tag yet"
else
  target=$(git -C "$REPO" rev-parse "${tag}^{commit}")
  # C3: a tag that already failed once is not retried automatically — design
  # §7 calls for one attempt, then a human, and without this the state file
  # was written only on success, so the next tick saw the same tag and the
  # same DEPLOYED_SHA and did it all again — ~288 forced restarts a day.
  # Quiet on purpose ABOUT THE TAG: the operator was already paged when this
  # was first recorded (guard refusal / audit refusal / deploy failure /
  # rollback failure all notify before writing LAST_FAILED_SHA); a repeat
  # every 5 minutes forever is the outage this fixes. Drift is a different
  # statement about a different object, on a once-a-day cadence, and a stuck
  # tag WITH production behind main is autodeploy dead twice over.
  # Clear LAST_FAILED_SHA in the state file (or delete the file) to retry.
  if [ -n "$LAST_FAILED_SHA" ] && [ "$target" = "$LAST_FAILED_SHA" ]; then
    echo "tag $tag ($target) is recorded as LAST_FAILED_SHA in $STATE; skipping quietly"
  elif [ "$target" = "$DEPLOYED_SHA" ]; then
    echo "already deployed $target"
  else
    pending="$target"
  fi
fi

# Idle: nothing to deploy, so the two standing conditions get their once-a-day
# say. A PENDING tag deliberately reaches neither — it is about to be deployed
# or refused with its offending paths listed, and a second message about the
# same condition is noise.
[ -n "$pending" ] || { report_stale_once; report_drift_once; exit 0; }

# On a first run we have nothing to diff against, so compare with what is
# actually installed rather than deploying an unbounded diff blind.
if [ -z "$DEPLOYED_SHA" ]; then
  echo "no recorded deployment; refusing to autodeploy an unbounded diff"
  notify "⛔ autodeploy: no recorded baseline yet. Deploy once by hand, then this becomes automatic."
  exit 1
fi

# --- verify ------------------------------------------------------------------
# Before anything else: are we the deployer that was merged? Refusing here is
# deliberate. On the idle path staleness is a once-a-day reminder, because
# nothing is at risk; with a tag pending, the safety logic about to run is
# KNOWN to be out of date, and deploying production on logic we know is stale
# is the risk this whole mechanism exists to manage. The stale copy on
# 2026-08-18 was missing `--prune-tags` and the downgrade check — exactly the
# two things that would have mattered.
if installed_is_stale; then
  echo "$STALE_REPORT"
  notify "⛔ autodeploy REFUSED for ${tag}: the installed deployer is out of date.
${STALE_REPORT}
Run: sudo bash deploy/install-autodeploy.sh — then this tag will be retried."
  # NOT recorded as LAST_FAILED_SHA: the tag is fine, we are not. Recording it
  # would make the tag un-retryable after the install that fixes the cause.
  exit 1
fi

if ! guard_out=$("$GUARD_BIN" "$REPO" "$DEPLOYED_SHA" "$target" origin/main); then
  echo "$guard_out"
  notify "⛔ autodeploy REFUSED for ${tag}:
${guard_out}"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"
  exit 1
fi
echo "$guard_out"

# I6: this checkout (for the audit) used to abort under set -e with no
# notification.
if ! git -C "$REPO" checkout -q --detach "$target"; then
  notify "⛔ autodeploy: could not check out ${target} to audit it."
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"
  exit 1
fi
git -C "$REPO" clean -xdff || {
  notify "⛔ autodeploy: git clean failed while preparing ${target} for audit."
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"
  exit 1
}

# I3: npm audit's exit 1 means "found advisories at/above --audit-level" —
# any OTHER nonzero exit means the audit itself could not run (network,
# registry, missing lockfile, ...). Those are not the same conclusion, and
# the operator message must say which one happened.
audit_out=$("$AUDIT_CMD" 2>&1) && audit_status=0 || audit_status=$?
if [ "$audit_status" -eq 1 ]; then
  notify "⛔ autodeploy REFUSED for ${tag}: npm audit --omit=dev still reports a high or critical advisory after the fix.
${audit_out}"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"
  exit 1
elif [ "$audit_status" -ne 0 ]; then
  notify "⛔ autodeploy REFUSED for ${tag}: npm audit --omit=dev could not run (exit ${audit_status}) — this is NOT a security finding, just an inability to verify one.
${audit_out}"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"
  exit 1
fi

# --- deploy ------------------------------------------------------------------
# I4: resolved once, up front. Previously `healthy` called `api_port` itself,
# and because errexit is suppressed inside the `if` condition that calls it,
# a transient sudo/.env failure made `healthy` return non-zero WITHOUT ever
# polling /health — tearing down a perfectly good deploy. Fail closed here,
# before anything is touched, instead.
if ! PORT=$(api_port); then
  notify "⛔ autodeploy: could not resolve API_PORT from /etc/warsaw-beer-bot/.env — refusing to deploy ${tag}."
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"
  exit 1
fi

echo "deploying $target ($tag)"
if deploy_commit "$target" && healthy "$PORT"; then
  # #490: production just moved. Whatever episode the idle path was tracking
  # measured a gap that no longer exists, and the ticks after this one exit at
  # "already deployed" without ever reaching report_drift_once to close it —
  # so a stale DRIFT_SINCE would survive to fire instantly once the idle path
  # resumes (e.g. after the tag is pruned), and a stale LAST_DRIFT_NOTICE
  # would go on suppressing the daily reminder for an episode that no longer
  # exists. Clear both, not just the start time.
  DRIFT_SINCE=""
  LAST_DRIFT_NOTICE=""
  write_state "$target" "$DEPLOYED_SHA" ""
  bumped=$(git -C "$REPO" diff --stat "$DEPLOYED_SHA" "$target" -- package.json | tail -1)
  notify "✅ autodeploy ${tag} — production patched and healthy.
${bumped}"
  exit 0
fi

# C3: record the failure BEFORE attempting rollback, so even if rollback
# itself misbehaves the timer will not retry this tag again.
write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"

# --- roll back ---------------------------------------------------------------
# Deliberately not clever: one attempt, then stop and wake a human. An
# automation that keeps turning production over unattended after two failures
# is worse than one that stops and says so.
notify "⚠️ autodeploy ${tag} failed to come up healthy — rolling back to ${DEPLOYED_SHA}."
if deploy_commit "$DEPLOYED_SHA" && healthy "$PORT"; then
  notify "↩️ rollback to ${DEPLOYED_SHA} succeeded. ${tag} needs a human."
  exit 2
fi

notify "🔥 ROLLBACK FAILED. Production is DOWN at ${DEPLOYED_SHA}. Manual intervention required."
exit 3
