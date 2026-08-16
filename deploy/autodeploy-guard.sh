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

if ! git -C "$repo" merge-base --is-ancestor "$target" "$main_ref"; then
  echo "REFUSE: $target is not an ancestor of $main_ref — not merged"
  exit 1
fi

# The allowlist. NOT extension/** — the extension never ships to the server.
mapfile -t changed < <(git -C "$repo" diff --name-only "$deployed" "$target")

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
