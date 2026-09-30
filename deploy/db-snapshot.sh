#!/usr/bin/env bash
# Merge-deploy — the DB snapshots behind the rollback window.
# Spec: docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md (P1–P3).
#
# In production this runs as warsaw-beer-bot through the existing
# `(warsaw-beer-bot) NOPASSWD: /usr/bin/bash -lc *` rule, so everything it
# writes is owned by the bot user and lives next to bot.db, outside rsync's
# reach (/var/lib, not /opt). Installed as /usr/local/bin/wbb-db-snapshot.
#
#   db-snapshot.sh snapshot <db> <out.db>      VACUUM INTO + <out.db>.sha256
#   db-snapshot.sh post <db> <out-dir>         file copy of db, -wal, -shm (bot STOPPED)
#   db-snapshot.sh mark-rollback <x-pre.db>    rename to x-rollback-pre.db, print it
#   db-snapshot.sh restore <snap.db> <db>      verify sha256, atomic replace, drop -wal/-shm
#   db-snapshot.sh prune <dir> <keep>          keep the newest <keep> settled *-pre.db
#
# Exit: 0 ok, 1 refused or failed (reason on stderr), 64 usage.
set -euo pipefail

usage() { echo "usage: db-snapshot.sh snapshot|post|mark-rollback|restore|prune ..." >&2; exit 64; }
die() { echo "db-snapshot: $*" >&2; exit 1; }

# P1: VACUUM INTO, never the backup API. The backup API restarts on every
# foreign write; against a steady writer it finished only when the writer
# stopped (18.5 s in the probe). VACUUM INTO runs inside ONE read transaction,
# so it is one point in time and cannot be starved.
# The target is spliced into SQL, so a quote in it is refused, not escaped.
cmd_snapshot() {
  local db="$1" out="$2" tmp
  case "$out" in *"'"*) die "refusing a path containing a quote: $out" ;; esac
  [ -f "$db" ] || die "no database at $db"
  [ ! -e "$out" ] || die "refusing to overwrite $out"
  mkdir -p "$(dirname "$out")"
  tmp="$out.partial"
  rm -f "$tmp"
  if ! sqlite3 "file:${db}?mode=ro" "VACUUM INTO '${tmp}'"; then
    rm -f "$tmp"
    die "VACUUM INTO failed for $db"
  fi
  sha256sum < "$tmp" | cut -d' ' -f1 > "$out.sha256"
  mv "$tmp" "$out"
  echo "$out"
}

# The bot is STOPPED when this runs (rollback step 3), so a plain file copy is
# consistent, and -wal holds the writes that exist nowhere else.
cmd_post() {
  local db="$1" dir="$2" f
  [ -f "$db" ] || die "no database at $db"
  [ ! -e "$dir" ] || die "refusing to overwrite $dir"
  mkdir -p "$dir"
  for f in "$db" "$db-wal" "$db-shm"; do
    if [ -f "$f" ]; then
      cp -p "$f" "$dir/" || die "copy of $f failed"
    fi
  done
  echo "$dir"
}

# Marked BEFORE the restore, so a rollback that dies half-way never leaves an
# unmarked pre snapshot for prune to delete.
cmd_mark() {
  local pre="$1" marked
  case "$pre" in
    *-rollback-pre.db) die "already marked: $pre" ;;
    *-pre.db) ;;
    *) die "not a pre snapshot: $pre" ;;
  esac
  [ -f "$pre" ] || die "no snapshot at $pre"
  [ -f "$pre.sha256" ] || die "no checksum for $pre"
  marked="${pre%-pre.db}-rollback-pre.db"
  mv "$pre" "$marked"
  mv "$pre.sha256" "$marked.sha256"
  echo "$marked"
}

# P2: litestream picks a replaced file up by itself (no `litestream reset`),
# PROVIDED no stale -wal/-shm is left next to it. P3: a temp file in the same
# directory + mv is atomic and needs no chown when run as the bot user.
cmd_restore() {
  local snap="$1" db="$2" want got tmp
  [ -f "$snap" ] || die "no snapshot at $snap"
  [ -f "$snap.sha256" ] || die "no checksum for $snap"
  want=$(tr -d '[:space:]' < "$snap.sha256")
  got=$(sha256sum < "$snap" | cut -d' ' -f1)
  [ "$want" = "$got" ] || die "checksum mismatch for $snap: want $want, got $got"
  tmp="$db.restore-partial"
  cp "$snap" "$tmp"
  mv -f "$tmp" "$db"
  rm -f "$db-wal" "$db-shm"
  echo "restored $db from $snap"
}

# Settled pre snapshots only. A rollback pair is evidence a human has to
# reconcile; this script never deletes one. Names start with a UTC stamp, so
# byte order is chronological.
cmd_prune() {
  local dir="$1" keep="$2" all=() listing f i n
  case "$keep" in ''|*[!0-9]*) die "keep must be a non-negative integer: $keep" ;; esac
  [ "$keep" -ge 1 ] || die "keep must be at least 1"
  [ -d "$dir" ] || return 0
  listing=$(find "$dir" -maxdepth 1 -type f -name '*-pre.db' ! -name '*-rollback-pre.db' | LC_ALL=C sort) \
    || die "cannot list $dir"
  while IFS= read -r f; do
    if [ -n "$f" ]; then all+=("$f"); fi
  done <<< "$listing"
  n=${#all[@]}
  i=0
  while [ "$i" -lt $(( n - keep )) ]; do
    rm -f "${all[$i]}" "${all[$i]}.sha256"
    echo "pruned ${all[$i]}"
    i=$((i + 1))
  done
}

[ $# -ge 1 ] || usage
sub=$1
shift
case "$sub" in
  snapshot)      [ $# -eq 2 ] || usage; cmd_snapshot "$@" ;;
  post)          [ $# -eq 2 ] || usage; cmd_post "$@" ;;
  mark-rollback) [ $# -eq 1 ] || usage; cmd_mark "$@" ;;
  restore)       [ $# -eq 2 ] || usage; cmd_restore "$@" ;;
  prune)         [ $# -eq 2 ] || usage; cmd_prune "$@" ;;
  *)             usage ;;
esac
