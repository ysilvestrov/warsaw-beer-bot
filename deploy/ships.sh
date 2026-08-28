#!/usr/bin/env bash
# #527 — does this path reach production?
#
# The autodeploy guard used to answer that with a two-name list of its own,
# while the actual answer lives in deploy/rsync-filter — the file rsync
# executes. The two lists were never the same list, and the guard held the
# wrong one: an extension-only merge, which cannot change anything in /opt,
# refused every security tag (MEASURED 2026-08-28, seven paths, none shipped).
#
# So there is one predicate, and it is derived from the filter rather than
# restated beside it.
#
# Usage:  ships.sh <filter-file>   paths on stdin, one per line
# Output: `SHIP <path>` or `SKIP <path>`, one line per non-empty input line
# Exit:   0 = the filter parsed;  1 = it did not (reason on stderr, NO stdout)
#
# This re-derives rsync's matching in a second engine, which is a debt. It is
# paid two ways: the grammar implements a small subset EXACTLY and refuses
# everything else rather than guessing, and scripts/autodeploy/ships.test.ts
# proves the result against real rsync, path for path.
set -euo pipefail

filter=${1:?filter file required}

if [ ! -r "$filter" ]; then
  echo "ships: cannot read filter file: $filter" >&2
  exit 1
fi

files=()          # exact root paths, from `+ /NAME`
dirs=()           # root directories WITH a trailing slash, from `+ /DIR/***`
seen_catchall=0

while IFS= read -r raw || [ -n "$raw" ]; do
  # Trim both ends; the filter is data written by hand.
  line=${raw#"${raw%%[![:space:]]*}"}
  line=${line%"${line##*[![:space:]]}"}

  if [ -z "$line" ]; then continue; fi
  case "$line" in '#'*) continue ;; esac

  # rsync takes the FIRST matching rule, so nothing after the catch-all can
  # ever match. A rule there means the file no longer says what we read it to
  # say — refuse rather than ignore it.
  if [ "$seen_catchall" -eq 1 ]; then
    echo "ships: rule after the terminal '- *': $line" >&2
    exit 1
  fi

  if [ "$line" = '- *' ]; then
    seen_catchall=1
    continue
  fi

  case "$line" in
    '+ /'*) rule=${line#'+ /'} ;;
    *)
      echo "ships: unsupported filter rule: $line" >&2
      exit 1
      ;;
  esac

  case "$rule" in
    */'***')
      dir=${rule%/'***'}
      # Single segment only, and no globbing. Extending this grammar is a
      # deliberate act with its own test, not something a parser guesses at.
      case "$dir" in
        *[*?\[]* | */* | '')
          echo "ships: unsupported directory rule: $line" >&2
          exit 1
          ;;
      esac
      dirs+=("$dir/")
      ;;
    *)
      case "$rule" in
        *[*?\[]* | */* | '')
          echo "ships: unsupported file rule: $line" >&2
          exit 1
          ;;
      esac
      files+=("$rule")
      ;;
  esac
done < "$filter"

# The predicate concludes "did not match ⇒ does not ship". That is sound ONLY
# because the last rule excludes everything else. Without it rsync's default is
# the opposite, and every verdict below would be backwards.
if [ "$seen_catchall" -ne 1 ]; then
  echo "ships: filter has no terminal '- *' rule; its default is 'everything ships', which this predicate cannot express" >&2
  exit 1
fi

while IFS= read -r path || [ -n "$path" ]; do
  if [ -z "$path" ]; then continue; fi

  verdict=SKIP

  # `if` blocks, not `&&` chains: under `set -e` a false `[ ... ] && { ... }`
  # as the last command of a loop body aborts the whole script.
  for f in ${files[@]+"${files[@]}"}; do
    if [ "$path" = "$f" ]; then
      verdict=SHIP
      break
    fi
  done

  if [ "$verdict" = SKIP ]; then
    for d in ${dirs[@]+"${dirs[@]}"}; do
      case "$path" in
        "$d"*)
          verdict=SHIP
          break
          ;;
      esac
    done
  fi

  printf '%s %s\n' "$verdict" "$path"
done
