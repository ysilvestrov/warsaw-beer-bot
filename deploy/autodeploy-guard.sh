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

# The allowlist. NOT extension/** — the extension never ships to the server.
# Captured into a variable rather than through a process substitution, so a
# failing `git diff` is caught here instead of silently yielding zero lines
# (see the C1 note above) — every failure path in this script prints REFUSE
# and exits 1.
if ! diff_out=$(git -C "$repo" diff --name-only "$deployed" "$target"); then
  echo "REFUSE: git diff between $deployed and $target failed"
  exit 1
fi
mapfile -t changed <<< "$diff_out"

violations=()
for path in "${changed[@]:-}"; do
  [ -n "$path" ] || continue
  case "$path" in
    package.json|package-lock.json) ;;
    *) violations+=("$path") ;;
  esac
done

if [ "${#violations[@]}" -gt 0 ]; then
  echo "REFUSE: ${#violations[@]} path(s) outside the allowlist:"
  printf '  %s\n' "${violations[@]}"
  exit 1
fi

echo "ACCEPT: lockfile-only change, merged into $main_ref"
exit 0
