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
# The filter is read from BOTH SIDES — the deployed commit and the target —
# and a path counts as shipping if EITHER filter ships it. The design's first
# answer was "read the target's filter, and a wrong ACCEPT is impossible by
# definition, in one step". That argument considered only a WIDENED filter, and
# it is wrong for a NARROWED one, because deploy/deploy.sh runs
#
#     rsync -a --delete --delete-excluded --filter='merge deploy/rsync-filter'
#
# so a path that STOPS shipping is DELETED from /opt. A commit that narrows the
# filter — in the limit to just `- *` — therefore cloaks itself and everything
# it drops: read against the target alone, `deploy/rsync-filter` and every
# `src/**` file riding with it classify SKIP, the guard ACCEPTs, and the deploy
# that follows empties /opt, unattended. The old two-name allowlist refused
# that by name; this predicate must not lose it. The deployed filter's set is
# material precisely because `--delete` acts on it, so the SHIP set is the
# UNION of the two sides, and a missing or unparseable filter on EITHER side
# is a REFUSE.
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

# The exact question put to the classifier, in order. ships.sh emits one line
# per NON-EMPTY input line, in input order, so this array is what the answers
# are checked AGAINST — not merely counted against. An empty diff leaves it
# empty and every loop below a no-op.
input_paths=()
while IFS= read -r _line; do
  if [ -n "$_line" ]; then input_paths+=("$_line"); fi
done <<< "$diff_out"
expected=${#input_paths[@]}

target_filter=$(mktemp) || { echo "REFUSE: could not create a temporary file for the rsync filter"; exit 1; }
deployed_filter=$(mktemp) || { echo "REFUSE: could not create a temporary file for the rsync filter"; exit 1; }
trap 'rm -f "$target_filter" "$deployed_filter"' EXIT

if ! git -C "$repo" show "${target}:deploy/rsync-filter" > "$target_filter" 2>/dev/null; then
  echo "REFUSE: $target carries no deploy/rsync-filter — there is no way to tell what would ship"
  exit 1
fi

if ! git -C "$repo" show "${deployed}:deploy/rsync-filter" > "$deployed_filter" 2>/dev/null; then
  echo "REFUSE: $deployed carries no deploy/rsync-filter — there is no way to tell what is on the server today, and rsync --delete acts on that set"
  exit 1
fi

if ! classified_target=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$target_filter" 2>&1); then
  echo "REFUSE: could not classify the diff against ${target}:deploy/rsync-filter"
  echo "$classified_target"
  exit 1
fi

if ! classified_deployed=$(printf '%s\n' "$diff_out" | "$SHIPS_BIN" "$deployed_filter" 2>&1); then
  echo "REFUSE: could not classify the diff against ${deployed}:deploy/rsync-filter"
  echo "$classified_deployed"
  exit 1
fi

# I2 — the classifier's stdout is trusted neither to be COMPLETE nor to be ABOUT
# THE QUESTION ASKED. A $SHIPS_BIN that exits 0 and prints nothing yields zero
# violations and a clean ACCEPT: silence read as "nothing ships". Counting the
# answers is not enough either — a classifier that emits the right NUMBER of
# lines for FABRICATED paths passes a count check and waves every real shipping
# path through (reproduced in re-review: 15 src/** paths to ACCEPT). So the
# verdicts are collected in input order and each one's path is compared against
# `input_paths` position by position below. The real ships.sh cannot do either
# of these things, but this script is also run standalone with an arbitrary
# $WBB_SHIPS, and the branch's rule is that every failure path REFUSEs.
target_verdicts=()
target_paths=()
while IFS=' ' read -r verdict path; do
  if [ -z "$path" ]; then continue; fi
  case "$verdict" in
    SHIP|SKIP) ;;
    *)
      echo "REFUSE: unexpected classification '$verdict' for $path"
      exit 1
      ;;
  esac
  target_verdicts+=("$verdict")
  target_paths+=("$path")
done <<< "$classified_target"

deployed_verdicts=()
deployed_paths=()
while IFS=' ' read -r verdict path; do
  if [ -z "$path" ]; then continue; fi
  case "$verdict" in
    SHIP|SKIP) ;;
    *)
      echo "REFUSE: unexpected classification '$verdict' for $path"
      exit 1
      ;;
  esac
  deployed_verdicts+=("$verdict")
  deployed_paths+=("$path")
done <<< "$classified_deployed"

if [ "${#target_paths[@]}" -ne "$expected" ] || [ "${#deployed_paths[@]}" -ne "$expected" ]; then
  echo "REFUSE: the ships predicate answered for ${#target_paths[@]} (target) and ${#deployed_paths[@]} (deployed) of $expected changed path(s) — an incomplete classification is not the statement 'nothing ships'"
  exit 1
fi

# CORRESPONDENCE, not just arity: every answer must be about the path that was
# asked about, at the same position. Without this the count check above is
# satisfied by N verdicts for N invented paths.
c=0
while [ "$c" -lt "$expected" ]; do
  if [ "${target_paths[$c]}" != "${input_paths[$c]}" ]; then
    echo "REFUSE: the ships predicate answered about '${target_paths[$c]}' where '${input_paths[$c]}' was asked (target, path $((c + 1))) — that is not a classification of this diff"
    exit 1
  fi
  if [ "${deployed_paths[$c]}" != "${input_paths[$c]}" ]; then
    echo "REFUSE: the ships predicate answered about '${deployed_paths[$c]}' where '${input_paths[$c]}' was asked (deployed, path $((c + 1))) — that is not a classification of this diff"
    exit 1
  fi
  c=$((c + 1))
done

violations=()
ignored=()
i=0
while [ "$i" -lt "$expected" ]; do
  # Safe by the correspondence check above: both classifications are known to
  # be about input_paths[i], so all three names agree at this index.
  path=${input_paths[$i]}
  # The union: a path reaches production if it can be WRITTEN under the
  # target's filter, or DELETED under the deployed one.
  #
  # INVARIANT this rests on: the union covers the paths in the DIFF, so a
  # narrowing that ships under NEITHER filter, with nothing else changed, would
  # not be seen. That is unreachable only because the DEPLOYED filter contains
  # `+ /deploy/***` — which makes any change to deploy/rsync-filter itself a
  # SHIP on the deployed side, hence a violation, hence a REFUSE. Induction:
  # every deployed filter descends from one that was accepted under this rule,
  # so it still carries the rule. Removing `+ /deploy/***` from the filter
  # breaks the induction and this reasoning must be redone before it merges.
  if [ "${target_verdicts[$i]}" = SHIP ] || [ "${deployed_verdicts[$i]}" = SHIP ]; then
    case "$path" in
      package.json|package-lock.json) ;;
      *) violations+=("$path") ;;
    esac
  else
    ignored+=("$path")
  fi
  i=$((i + 1))
done

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
