#!/usr/bin/env bash
# #435 — the only thing standing between a pushed tag and a production restart.
#
# A tag is a SIGNAL, never a permission: anyone can read the design and learn
# its name. This script re-derives the decision locally, so it holds even if
# every GitHub-side control is wrong.
#
# Usage: autodeploy-guard.sh <repo_dir> <deployed_sha> <target_ref> <main_ref>
# Exit:  0 = ACCEPT, 1 = REFUSE (reason on stdout)
set -euo pipefail

repo=${1:?repo_dir required}
deployed=${2:?deployed_sha required}
target=${3:?target_ref required}
main_ref=${4:?main_ref required}

# #527 — the predicate lives in its own installed copy, like the guard itself;
# a flat /usr/local/bin means this script cannot reach its sibling through $0.
SHIPS_BIN="${WBB_SHIPS:-/usr/local/bin/wbb-ships}"

# C1: a `deployed` sha that does not resolve in this checkout is the ordinary
# first-run case (deploy/README.md seeds it from `git rev-parse origin/main`
# in the OPERATOR's own clone, not this one) — not exotic. `git diff` on an
# unresolvable rev fails, but run through a process substitution neither
# `set -e` nor `pipefail` see that exit status, and `mapfile` reads zero
# lines from the resulting empty pipe: a "fatal: bad object" therefore turns
# into zero changed paths, zero violations, and ACCEPT. Verify both revisions
# resolve before doing anything with them, and fail closed if either does not.
for rev in "$deployed" "$target"; do
  if ! git -C "$repo" rev-parse --verify -q "${rev}^{commit}" >/dev/null 2>&1; then
    echo "REFUSE: $rev does not resolve to a commit in $repo"
    exit 1
  fi
done

if ! git -C "$repo" merge-base --is-ancestor "$target" "$main_ref"; then
  echo "REFUSE: $target is not an ancestor of $main_ref — not merged"
  exit 1
fi

# A tag pointing at or behind what is already deployed is a DOWNGRADE, not a
# fix. It has to be refused by name: MEASURED 2026-08-18, on the first
# unattended run, a stale tag left behind by --prune (which prunes branches,
# not tags) pointed at an older commit, and the allowlist caught it only
# incidentally — because rolling back happened to touch 20 unrelated files. A
# downgrade whose diff HAPPENS to be lockfile-only would have sailed through
# and quietly reinstalled the vulnerable versions this system exists to remove.
# STRICT ancestor: `--is-ancestor` calls a commit its own ancestor, and
# target == deployed is "nothing to do", not a downgrade — autodeploy.sh
# already exits before reaching here in that case, but the guard is also run
# on its own and must not disagree with itself.
if [ "$(git -C "$repo" rev-parse "$target")" != "$(git -C "$repo" rev-parse "$deployed")" ] \
   && git -C "$repo" merge-base --is-ancestor "$target" "$deployed"; then
  echo "REFUSE: $target is already contained in the deployed commit $deployed — that is a downgrade, not a fix"
  exit 1
fi

# #527 — the allowlist question is really two questions, and this script used
# to hold only the second one.
#
#   1. Can this path affect production AT ALL?  deploy/rsync-filter answers
#      that, and it is the only thing that can: it is what rsync executes.
#   2. Of the paths that can, which may an unattended deploy change?  The root
#      manifests, and nothing else.
#
# Collapsing them into one two-name list made an extension-only merge — which
# cannot touch /opt — refuse every security tag. MEASURED 2026-08-28: seven
# paths, zero of them shipped, autodeploy dead for three and a half days.
#
# The filter is read from the TARGET, not from the clone's working tree and
# not from the deployed commit. A wrong ACCEPT would need a path that ships
# under target's filter to be classified as non-shipping; reading target's
# filter makes that impossible by definition, in one step, without relying on
# `deploy/***` staying inside the filter forever.
#
# `-c core.quotePath=false`: without it git C-quotes a non-ASCII path (e.g.
# `"src/\303\251.ts"`), which ships.sh refuses on sight (the quoted form is
# not the path it names) — a real shipping file would needlessly refuse a
# safe deploy. Captured into a variable rather than through a process
# substitution, so a failing `git diff` is caught here instead of silently
# yielding zero lines (see the C1 note above) — every failure path in this
# script prints REFUSE and exits 1.
if ! diff_out=$(git -C "$repo" -c core.quotePath=false diff --name-only "$deployed" "$target"); then
  echo "REFUSE: git diff between $deployed and $target failed"
  exit 1
fi

filter_file=$(mktemp) || { echo "REFUSE: could not create a temporary file for the rsync filter"; exit 1; }
trap 'rm -f "$filter_file"' EXIT

if ! git -C "$repo" show "${target}:deploy/rsync-filter" > "$filter_file" 2>/dev/null; then
  echo "REFUSE: $target carries no deploy/rsync-filter — there is no way to tell what would ship"
  exit 1
fi

if ! classified=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$filter_file" 2>&1); then
  echo "REFUSE: could not classify the diff against ${target}:deploy/rsync-filter"
  echo "$classified"
  exit 1
fi

violations=()
ignored=()
while IFS=' ' read -r verdict path; do
  if [ -z "$path" ]; then continue; fi
  case "$verdict" in
    SHIP)
      case "$path" in
        package.json|package-lock.json) ;;
        *) violations+=("$path") ;;
      esac
      ;;
    SKIP) ignored+=("$path") ;;
    *)
      echo "REFUSE: unexpected classification '$verdict' for $path"
      exit 1
      ;;
  esac
done <<< "$classified"

if [ "${#violations[@]}" -gt 0 ]; then
  echo "REFUSE: ${#violations[@]} path(s) that ship to the server and are not the root manifests:"
  printf '  %s\n' "${violations[@]}"
  exit 1
fi

echo "ACCEPT: nothing outside the root manifests ships, merged into $main_ref"
if [ "${#ignored[@]}" -gt 0 ]; then
  echo "  ${#ignored[@]} changed path(s) do not ship and were ignored:"
  printf '    %s\n' "${ignored[@]}"
fi
exit 0
