#!/usr/bin/env bash
# #435 — read ONE key out of an operator env file WITHOUT letting the shell
# evaluate it.
#
# `set -a; . file` looks equivalent and is not. The file is not a shell script:
# a value containing shell metacharacters is a SYNTAX ERROR that aborts the
# sourcing partway through, leaving the keys above it set and everything below
# it unset. Measured 2026-08-18 on the live host —
# `NOMINATIM_USER_AGENT=warsaw-beer-bot (yuriy@silvestrov.com)` on line 4 killed
# it, so TELEGRAM_BOT_TOKEN (line 1) was set and ADMIN_TELEGRAM_ID (line 13)
# never was. Every autodeploy notification then posted to a valid bot URL with
# an empty chat_id, got HTTP 400, and died in `|| echo WARNING` in the journal:
# the deployer would have run, failed, rolled back and told nobody.
#
# systemd's EnvironmentFile= parses this file rather than executing it, so the
# bot itself was never affected — which is exactly why this stayed invisible.
#
# Usage: read-env.sh <file> <key>   → prints the raw value, or nothing.
set -euo pipefail

file=${1:?env file required}
key=${2:?key required}

[ -r "$file" ] || exit 0

# Surrounding quotes are stripped the way systemd's EnvironmentFile does, so a
# quoted and an unquoted value behave the same.
awk -v k="$key" '
  index($0, k "=") == 1 {
    v = substr($0, length(k) + 2)
    if (v ~ /^".*"$/ || v ~ /^'"'"'.*'"'"'$/) v = substr(v, 2, length(v) - 2)
    print v
    exit
  }
' "$file"
