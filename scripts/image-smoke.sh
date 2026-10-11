#!/usr/bin/env bash
# Smoke of the bot's runtime image before CI labels or publishes it (spec
# docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §3.1, §6.3).
# It replaces verify_payload.py for the image: the same probes, run against the
# finished image instead of an unpacked archive.
#
# Every container runs as the host will run it: read-only root, no network, a tmpfs
# /tmp (tsx and the substitute database write there), a numeric non-root UID, and no
# real .env. Steps:
#   start   deploy/image/start-check.cjs with the substitute environment (§6.3): the bot
#           reaches `api listening`, /health answers, its releaseSha is <sha>;
#   trial   a database made by the image's own openDb+migrate, then trial-migrate.cjs;
#   probes  deploy/release/payload-probe.cjs native | migrate | assets | ops (mounted
#           read-only, not in the image), WBB_PAYLOAD=/app, an empty dotenv;
#   audit   audit-verdict-cli.ts on scripts/autodeploy/fixtures/npm-audit/*: 0 / 10 / 2;
#   readonly  `touch /app/x` fails.
#
# Usage: scripts/image-smoke.sh <image> <expected source sha (40 hex)>
# Exit:  0 `SMOKE OK` as the last line, 1 `SMOKE FAILED <step>: <reason>` then the
#        output tail, 64 usage. $DOCKER names the client (default docker).
set -uo pipefail

DOCKER=${DOCKER:-docker}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FIXTURES="$REPO/scripts/autodeploy/fixtures/npm-audit"
PROBE="$REPO/deploy/release/payload-probe.cjs"

if [ $# -ne 2 ] || [ -z "$1" ] || ! [[ $2 =~ ^[0-9a-f]{40}$ ]]; then
  echo 'usage: image-smoke.sh <image> <expected source sha (40 hex)>' >&2
  exit 64
fi
IMAGE=$1
SHA=$2

# The confinement every step runs under; tests assert it on each container.
CONFINED=(--rm --read-only --network=none --tmpfs /tmp --user 999:999)
# The substitute environment of the host's compat check (§6.3): required keys only,
# fake but well-formed; every optional feature stays off.
FAKE_ENV=(-e TELEGRAM_BOT_TOKEN=123456:abcdefghij -e OSRM_BASE_URL=http://x
  -e NOMINATIM_USER_AGENT=x -e DATABASE_PATH=/tmp/app.db -e WBB_RELEASE_REQUIRED=true
  -e API_PORT=3000)
PROBE_ENV=(-e WBB_PAYLOAD=/app -e DOTENV_CONFIG_PATH=/dev/null -v "$PROBE:/probe/payload-probe.cjs:ro" -w /tmp)

fail() { # <step> <reason> [output]
  echo "SMOKE FAILED $1: $2"
  local tail=${3:-}
  [ ${#tail} -gt 4000 ] && tail=${tail:${#tail}-4000}
  [ -n "$tail" ] && printf '%s\n' "$tail"
  exit 1
}

# start: the first line is the verdict.
out=$("$DOCKER" run "${CONFINED[@]}" "${FAKE_ENV[@]}" "$IMAGE" node deploy/image/start-check.cjs 2>&1)
code=$?
first=${out%%$'\n'*}
[ "$code" -eq 0 ] && [ "$first" = "START OK $SHA" ] \
  || fail start "expected exit 0 and 'START OK $SHA', got exit $code and '$first'" "$out"
echo "SMOKE OK start: $first"

# trial: one container, so the database made in it survives until the trial reads it.
make_db='const { openDb } = require("/app/dist/storage/db.js");
const { migrate } = require("/app/dist/storage/schema.js");
const db = openDb(process.env.TRIAL_DB); migrate(db); db.close();'
out=$("$DOCKER" run "${CONFINED[@]}" -e TRIAL_DB=/tmp/trial.db -e "MAKE_DB=$make_db" "$IMAGE" \
  sh -c 'node -e "$MAKE_DB" && node deploy/trial-migrate.cjs /app "$TRIAL_DB"' 2>&1)
code=$?
[ "$code" -eq 0 ] && [[ $out == 'TRIAL OK'* ]] || fail trial "expected exit 0 and 'TRIAL OK', got exit $code" "$out"
echo "SMOKE OK trial: ${out%%$'\n'*}"

# probes: the ops entrypoints come from the image's own package.json through the
# packer's allowlist, exactly as verify_payload.py gets them.
pkg=$("$DOCKER" run "${CONFINED[@]}" "$IMAGE" cat /app/package.json 2>&1) || fail probes 'cannot read /app/package.json' "$pkg"
ops=$(printf '%s' "$pkg" | python3 -I -B -c '
import json, sys
sys.path.insert(0, sys.argv[1])
from package_runtime import ops_entrypoints
print(" ".join(ops_entrypoints(json.load(sys.stdin))))' "$REPO/deploy/release" 2>&1) \
  || fail probes 'ops entrypoints from /app/package.json' "$ops"
read -ra ops_list <<<"$ops"
for probe in native migrate assets ops; do
  extra=()
  [ "$probe" = ops ] && extra=("${ops_list[@]}")
  out=$("$DOCKER" run "${CONFINED[@]}" "${PROBE_ENV[@]}" "$IMAGE" node /probe/payload-probe.cjs "$probe" "${extra[@]}" 2>&1)
  code=$?
  [ "$code" -eq 0 ] && [[ $out == "PROBE OK $probe:"* ]] \
    || fail probes "expected exit 0 and 'PROBE OK $probe:', got exit $code" "$out"
  echo "SMOKE OK probe: ${out%%$'\n'*}"
done

# audit: the verdict CLI in the image tells the three outcomes apart.
for case in clean.json:0 advisory.json:10 enolock.json:2 registry-down.json:2; do
  file=${case%%:*}
  want=${case##*:}
  [ -f "$FIXTURES/$file" ] || fail audit "fixture $file is missing"
  out=$("$DOCKER" run "${CONFINED[@]}" -i "$IMAGE" node_modules/.bin/tsx scripts/autodeploy/audit-verdict-cli.ts <"$FIXTURES/$file" 2>&1)
  code=$?
  [ "$code" -eq "$want" ] || fail audit "$file: expected exit $want, got $code" "$out"
  echo "SMOKE OK audit: $file -> $code"
done

# readonly: the code cannot be changed from inside.
out=$("$DOCKER" run "${CONFINED[@]}" "$IMAGE" touch /app/x 2>&1) && fail readonly 'touch /app/x succeeded' "$out"
echo 'SMOKE OK readonly: touch /app/x refused'

echo "SMOKE OK $IMAGE"
