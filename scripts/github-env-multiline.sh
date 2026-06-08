#!/usr/bin/env bash
set -euo pipefail

name="${1:?usage: github-env-multiline.sh NAME}"
env_file="${GITHUB_ENV:?GITHUB_ENV is not set}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

cat > "$tmp"

delimiter="GITHUB_ENV_${name}_$$"
i=0
while grep -qxF "$delimiter" "$tmp"; do
  i=$((i + 1))
  delimiter="GITHUB_ENV_${name}_$$_$i"
done

{
  printf '%s<<%s\n' "$name" "$delimiter"
  cat "$tmp"
  printf '\n%s\n' "$delimiter"
} >> "$env_file"
