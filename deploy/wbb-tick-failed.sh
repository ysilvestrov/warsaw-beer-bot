#!/usr/bin/env bash
# Installed as /usr/local/libexec/wbb-tick-failed (root:root 0755) by deploy/install-release.sh; run as the
# operator by wbb-tick-failed.service, which wbb-tick.service starts through OnFailure=.
# Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.7.
#
# Tells the admin about a failed tick the tick did not report itself. Bash, not Python: it must speak when the
# Python library is broken or missing. systemd hands the failed unit's outcome over in the environment:
#
#   MONITOR_SERVICE_RESULT  exit-code | timeout | signal | core-dump | ...   anything but exit-code -> report
#   MONITOR_EXIT_STATUS     with exit-code: the tick's exit status
#       3, 4, 70   the tick sent its own notice (tick.py "Exit codes")       -> silent
#       0, 1, 2    SuccessExitStatus, never a failure                        -> silent
#       64, 71     usage / not started: nobody was told                      -> report
#       any other  a status the tick does not define                         -> report
#
# Once per UTC day per text (${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy/tick-failed-notice): a tick
# that fails every 5 minutes says so once a day, not 288 times. The mark is written only after Telegram
# accepted the message, so a notice that could not be sent is tried again on the next failure.
#
# Like merge-deploy's _notify_default: TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID through wbb-read-env as the bot
# user (the operator cannot read the bot's .env), curl straight to the Bot API, never through a proxy. The token
# goes to curl on stdin (-K -), never in argv, output or a message. Exit 0: reported, deduplicated or nothing to
# report; 1: a report was due and was not sent (one line on stderr says why).
set -uo pipefail

READ_ENV_BIN=/usr/local/bin/wbb-read-env
BOT_ENV_FILE=/etc/warsaw-beer-bot/.env
NOTICE="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy/tick-failed-notice"

result=${MONITOR_SERVICE_RESULT:-}
status=${MONITOR_EXIT_STATUS:-}

if [ "$result" = exit-code ]; then
  case "$status" in
    0 | 1 | 2 | 3 | 4 | 70) exit 0 ;;
    64) why="exit 64: refused to run (usage, or started as root)" ;;
    71) why="exit 71: did not start (the library is missing or failed to import)" ;;
    *) why="exit ${status:-?}, a status the tick does not define" ;;
  esac
else
  why="${result:-no result from systemd} (${MONITOR_EXIT_CODE:-?} ${status:-?})"
fi
text="🔥 wbb-tick failed and reported nothing itself: ${why}. See: journalctl -u wbb-tick.service"

mark="$(date -u +%F) $(printf '%s' "$text" | sha256sum | cut -d' ' -f1)"
if [ -f "$NOTICE" ] && [ "$(cat "$NOTICE" 2>/dev/null)" = "$mark" ]; then
  echo "wbb-tick-failed: already reported today: $text" >&2
  exit 0
fi

read_env() {
  sudo -n -u warsaw-beer-bot bash -lc '"$0" "$@"' "$READ_ENV_BIN" "$BOT_ENV_FILE" "$1"
}

if ! tok=$(read_env TELEGRAM_BOT_TOKEN) || ! chat=$(read_env ADMIN_TELEGRAM_ID); then
  echo "wbb-tick-failed: cannot read the bot's .env through wbb-read-env; not reported: $text" >&2
  exit 1
fi
if [ -z "$tok" ] || [ -z "$chat" ]; then
  echo "wbb-tick-failed: no TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID; not reported: $text" >&2
  exit 1
fi
# What BotFather issues (notify_telegram.TOKEN); anything else never reaches curl's config.
if ! [[ "$tok" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo "wbb-tick-failed: TELEGRAM_BOT_TOKEN is not a bot token; not reported: $text" >&2
  exit 1
fi

# curl's own error text is dropped: it may quote the URL, which holds the token.
printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$tok" |
  curl -K - -fsS --noproxy '*' --proto '=https' --max-time 10 -X POST \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=${text}" >/dev/null 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "wbb-tick-failed: Telegram did not accept the notice (curl exit $rc): $text" >&2
  exit 1
fi

mkdir -p "$(dirname "$NOTICE")" && printf '%s\n' "$mark" > "$NOTICE" ||
  echo "wbb-tick-failed: WARNING: could not record the notice in $NOTICE" >&2
echo "wbb-tick-failed: reported: $text"
exit 0
