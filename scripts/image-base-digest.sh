#!/usr/bin/env bash
# The runtime base digest of deploy/image/Dockerfile: the literal in its one
# `FROM …node:24-bookworm-slim@sha256:<64 hex>` line. CI passes it as RUNTIME_BASE_DIGEST so
# wbb.content follows the base Dependabot bumps (image spec 2026-10-11 §4.1).
# Usage: image-base-digest.sh <Dockerfile>   Exit: 0 digest printed, 1 not exactly one such line, 64 usage.
set -euo pipefail
[ "$#" -eq 1 ] || { echo "usage: image-base-digest.sh <Dockerfile>" >&2; exit 64; }
found=$(grep -E '^FROM [^ ]*/node:24-bookworm-slim@sha256:[0-9a-f]{64}( |$)' "$1" | sed -E 's/^FROM [^@]*@(sha256:[0-9a-f]{64}).*/\1/') || true
if [ "$(printf '%s' "$found" | grep -c .)" != 1 ]; then
  echo "image-base-digest: expected exactly one pinned node:24-bookworm-slim FROM in $1" >&2
  exit 1
fi
printf '%s\n' "$found"
