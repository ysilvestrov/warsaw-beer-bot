#!/usr/bin/env bash
# #435 — is the INSTALLED deployer the one that was merged?
#
# /usr/local/bin holds COPIES, deliberately: the running deployer must not
# change under a `git checkout` in the operator's working tree. The same
# property means a merged fix is NOT a live fix until it is installed there,
# and nothing said so. MEASURED 2026-08-18: a fix for the guard was merged and
# the timer kept running the old copy; it was noticed by memory, not by the
# system.
#
# Usage: installed-current.sh <repo> <ref> <name=path> [<name=path> ...]
#   <name> is the path inside the repo, e.g. deploy/autodeploy.sh
#   <path> is where its installed copy lives
#
# Exit: 0 = every copy matches <ref>
#       1 = at least one differs or is missing; the names are printed
set -euo pipefail

repo=${1:?repo required}
ref=${2:?ref required}
shift 2

divergent=()
for pair in "$@"; do
  name=${pair%%=*}
  path=${pair#*=}

  if [ ! -f "$path" ]; then
    divergent+=("$name (not installed at $path)")
    continue
  fi

  # A path missing from the ref is named as such. This is about the MESSAGE,
  # not about safety: `set -o pipefail` above is what makes the case fail
  # closed, because it propagates `git show`'s failure out of the pipeline
  # instead of letting cmp judge an empty stream. Removing this block still
  # refuses (proven by mutation — both tests below go red on the wording, not
  # the verdict); removing `pipefail` is what would turn "absent" into
  # "identical to an empty file". Do not treat `pipefail` here as decorative.
  if ! git -C "$repo" cat-file -e "${ref}:${name}" 2>/dev/null; then
    divergent+=("$name (absent from $ref)")
    continue
  fi

  if ! git -C "$repo" show "${ref}:${name}" | cmp -s - "$path"; then
    divergent+=("$name")
  fi
done

if [ "${#divergent[@]}" -gt 0 ]; then
  printf 'STALE: %s\n' "${#divergent[@]} installed file(s) differ from ${ref}:"
  printf '  %s\n' "${divergent[@]}"
  exit 1
fi

echo "CURRENT: installed copies match ${ref}"
