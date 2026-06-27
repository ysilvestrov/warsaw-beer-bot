#!/usr/bin/env bash
# Idempotent single-key upsert for a dotenv file, preserving all other lines.
# Usage: set-env.sh <KEY> <VALUE> <FILE>
# - replaces an existing `^KEY=` line, else appends `KEY=VALUE`
# - backs up FILE to FILE.bak.<UTC timestamp> before writing
# - VALUE is written literally (safe for =, spaces, parens, slashes)
set -euo pipefail

KEY=${1:-}
VALUE=${2:-}
FILE=${3:-}

if [ -z "$KEY" ] || [ -z "$FILE" ] || [ "$#" -lt 3 ]; then
  echo "usage: set-env.sh <KEY> <VALUE> <FILE>" >&2
  exit 2
fi
if ! printf '%s' "$KEY" | grep -qE '^[A-Z_][A-Z0-9_]*$'; then
  echo "invalid key: $KEY (must match ^[A-Z_][A-Z0-9_]*$)" >&2
  exit 2
fi
if [ ! -f "$FILE" ]; then
  echo "no such file: $FILE" >&2
  exit 2
fi

cp -a "$FILE" "${FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"

tmp=$(mktemp)
KEY="$KEY" VALUE="$VALUE" awk '
  BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VALUE"]; done = 0 }
  {
    if (!done && $0 ~ ("^[ \t]*" k "[ \t]*=")) { print k "=" v; done = 1 }
    else { print }
  }
  END { if (!done) print k "=" v }
' "$FILE" > "$tmp"

mv "$tmp" "$FILE"
