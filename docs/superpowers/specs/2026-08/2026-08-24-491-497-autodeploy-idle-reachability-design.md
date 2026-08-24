# #491 + #497 — the deployer reports when it has no work, and remembers that it did

Date: 2026-08-24
Status: agreed
Issues: #491 (the idle reports go dark once any `autodeploy-*` tag exists), #497 (the staleness
marker is erased by the drift write in the same tick)
Related: `2026-08-23-autodeploy-drift-signal-design.md` (#490 — the episode this signal lives in),
`2026-08-16-435-dependency-security-autofix-design.md` (the deployer both defects live in)
Spawned: #498 (a deployed tag becomes pending again once production moves past it)
Measured from: production state on 2026-08-24, `DEPLOYED_SHA=2c4b1bb`, no `autodeploy-*` tag in origin

## The model

> A watchdog has two failure modes that look identical from the outside: never barking because
> nothing is wrong, and never barking because it is asleep. `autodeploy.sh` currently guarantees the
> second — permanently, from the first tag it ever sees — and the one message it does manage to send
> erases its own record of having sent it.

Both defects are the same mistake in two places: **a condition that names something adjacent to what
it means.** #491 asks "has a tag ever existed?" when it means "is there work to do?". #497 hands a
value to a later writer positionally when it means "this is now true, keep it true".

Neither is about what the deployer says. Both are about whether it can say it, and whether it
remembers afterwards. Message texts, the 15-minute grace, and the once-a-day cadence are all
unchanged by this design.

## Measured 2026-08-24

### 1. The idle reports are alive today only by accident

```
$ git ls-remote origin 'refs/tags/autodeploy-*'
(empty)
```

`autodeploy.sh:306-308` selects the newest `autodeploy-*` tag and calls both idle reporters only when
that selection came back empty. No such tag has ever been pushed — `.github/workflows/autodeploy-tag.yml`
pushes one only on a merge carrying the exact `autodeploy` label, and no dependency PR has qualified
yet. The three currently open Dependabot PRs (#493, #494, #495) all carry `deps-manual`, so none of
them will push one either.

That emptiness is the only reason #490's drift episode could be measured at all on the #489 merge,
and the only reason the "installed deployer is out of date" reminder has ever fired. Tags are never
pruned once pushed (`--prune-tags` removes only what was deleted upstream), so the first qualified
merge turns both signals off forever.

### 2. The state file is missing a key it should be holding

Production state after the 10:17:57 tick on the #496 merge, which sent **two** notifications:

```
PREVIOUS_SHA=4af4f995…
LAST_DRIFT_NOTICE=2026-08-24
DEPLOYED_SHA=2c4b1bb…
```

`report_stale_once` had just sent its message. `LAST_STALE_NOTICE` is absent. `report_stale_once`
passes `$today` as argument 5 without assigning the shell variable, and `report_drift_once`'s
four-argument write later in the same tick therefore falls back to `${5:-$LAST_STALE_NOTICE}` — the
still-empty variable — and `write_state`'s `if [ -n … ]` guard drops the line.

Honest limit, carried over from the issue: only one tick fell inside the window where both conditions
held (merge ~10:16, deploy 10:20), so the **repetition** is proven by code reading and by the missing
key, not by observation. Section "Verification in production" below closes that gap deliberately.

### 3. The two defects multiply

Today `report_stale_once` and `report_drift_once` run back to back on one rare path. #491's fix makes
that pair run on **every** tick where a tag exists and is already handled — which, once tags exist, is
almost every tick. Fixing #491 without #497 does not leave the erasure where it is; it makes it the
normal case. That is why they are one change.

## The design

### D1 — `write_state` stops accepting carry-fields positionally

```
write_state <deployed> <previous> [last_failed]
```

`LAST_DRIFT_NOTICE`, `LAST_STALE_NOTICE` and `DRIFT_SINCE` are no longer parameters at all. The
function reads the shell variables directly, and every writer that wants to change one assigns it
first.

This is not tidiness. While the positional form exists, a *later* call in the same tick silently
decides what an *earlier* one persisted — a defect that is invisible at both call sites and only
appears when you read them together, in order, knowing the default. Deleting the parameters does not
fix #497; it removes the mechanism that caused it — bash still accepts and silently discards a fourth
argument at a call site, so the shape stays possible, but nothing in the file can any longer *reach*
it through the positional-carry path, and a source-guard test pins that no call site tries. #490
already chose assign-then-carry for `DRIFT_SINCE` for this reason; this finishes the choice.

**This overturns a decision #490 made three weeks earlier, on purpose.** That design considered
converting `write_state` to read shell variables and rejected it: *"it would touch all eleven call
sites in the highest-blast-radius file in the repository, and its failure mode — a call site that
silently stops persisting a field — corrupts the deployer's record of what production is running."*
Two things have changed.

First, the risk it named has now **happened** — via the pattern it kept. #497 is precisely "a call
site that silently stops persisting a field", and the positional carry is the mechanism. The argument
was not wrong about the danger; it was wrong about which form carried it.

Second, the blast radius was overstated. `deploy/autodeploy.sh` has **twelve** `write_state` call
sites, and exactly **two** of them (`:230`, `:278`) pass anything beyond the third argument. Deleting
parameters 4-6 leaves the other ten byte-identical — a `git diff` that shows two changed call sites,
not twelve. The 2026-08-23 estimate counted call sites rather than call sites *that pass the
arguments being removed*.

The three-argument callers (`write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$target"` on the refusal
paths, `write_state "$target" "$DEPLOYED_SHA" ""` on success) are unchanged. `last_failed` stays
positional because it is genuinely an argument: each caller passes a different value, and clearing it
is a deliberate act, not a carry.

### D2 — the two markers are assigned before they are written

`report_stale_once`:

```bash
LAST_STALE_NOTICE="$today"
write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
```

`report_drift_once`, announcement branch:

```bash
LAST_DRIFT_NOTICE="$today"
write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
```

**The invariant this establishes, and the one the tests pin:** the order in which the two reporters
run within a tick affects nothing that is persisted. Today it decides it.

### D3 — "idle" becomes one named predicate

`tag` and `target` are computed, the three diagnostic `echo` lines are kept verbatim — they say
different things and are read in the journal — but instead of three separate `exit 0` statements they
simply fail to set `pending`:

```bash
pending=""
if [ -z "$tag" ]; then
  echo "no autodeploy tag yet"
else
  target=$(git -C "$REPO" rev-parse "${tag}^{commit}")
  if [ -n "$LAST_FAILED_SHA" ] && [ "$target" = "$LAST_FAILED_SHA" ]; then
    echo "tag $tag ($target) is recorded as LAST_FAILED_SHA in $STATE; skipping quietly"
  elif [ "$target" = "$DEPLOYED_SHA" ]; then
    echo "already deployed $target"
  else
    pending="$target"
  fi
fi

[ -n "$pending" ] || { report_stale_once; report_drift_once; exit 0; }
```

Why a predicate rather than three added call sites: the bug was not a forgotten call, it was a
condition naming the wrong concept. Three call sites leave the rule as an emergent property of three
scattered branches, and the fourth `exit 0` added next year re-creates the defect exactly as it was
born. One predicate states the rule in one place.

**What does not change.** A *pending* tag still never reaches the reporters — it is deployed or
refused with its offending paths listed, and a second message about the same condition is the noise
the original comment was protecting against. The `[ -z "$DEPLOYED_SHA" ]` refusal ("no recorded
baseline") stays on the pending path only: an empty `DEPLOYED_SHA` never equals a resolved `target`,
so it remains reachable exactly where it is today.

**Why `LAST_FAILED_SHA` counts as idle.** That branch is quiet on purpose about the *failed tag* —
the operator was already paged when the failure was recorded, and a repeat every five minutes is the
outage the quiet was added to fix. Drift is a different statement about a different object, on a
once-a-day cadence. A stuck tag *and* production behind `main` is autodeploy dead twice over, and it
is the state in which nobody finds out.

## Out of scope, deliberately

- **Message texts, `DRIFT_GRACE_S`, the daily cadence.** Reachability and persistence only.
- **The guard's downgrade rule.** See below — it gets its own issue.
- **`spec.md`.** Autodeploy does not appear in it; this is operational machinery, not product
  behaviour. `deploy/README.md` does describe the idle path ("watches for drift on its idle path")
  and must be updated in the same PR, or it will document the old bug.

## The adjacent defect this design refuses to absorb

`autodeploy-guard.sh:48-52` refuses a tag that is an ancestor of the deployed commit — "a downgrade,
not a fix". `autodeploy.sh` treats any tag with `target ≠ DEPLOYED_SHA` and `target ≠ LAST_FAILED_SHA`
as work. Together: **a successfully deployed tag becomes "pending" again the moment production moves
past it** — an ordinary merge plus `deploy.sh` — and the next tick asks the guard to deploy it, is
refused as a downgrade, sends a ⛔, and records that ancient commit as `LAST_FAILED_SHA` permanently.

It does not block future tags (tag names are timestamps, so the newest always wins the `--sort=-refname`
selection), so the cost is one spurious ⛔ per tag, once.

A tempting single predicate would fix all three at once: *work is a tag strictly ahead of
`DEPLOYED_SHA`*. It is rejected here. It would silently delete a live, documented, **measured** alarm —
the 2026-08-18 incident in which a throwaway tag on an older commit was caught precisely as a
downgrade — and it would move the guard's threat model, not merely the reachability of a report. A
tag is a signal, never a permission; deciding that some tags are beneath the guard's notice is a
security argument and deserves its own spec. Filed as **#498**.

## Verification in production

Tests pin the logic. These three steps establish that the fix is live and that the defect was real,
using the open Dependabot PRs as the moving parts.

**V1 — #497 observed before the fix.** Merging this PR makes the installed deployer stale *and* puts
production behind `main`, while the **old** copy in `/usr/local/bin` is still the one running. That
is exactly the pair of conditions under which #497 sirens. Expect ⚠️ "the installed deployer is out
of date" repeating on every 5-minute tick until `deploy.sh` and `install-autodeploy.sh` run — roughly
three or four messages. This converts the issue's "proven by code reading" into an observation, and it
is the only opportunity: after installation the deployer is no longer stale, so the condition cannot
be reproduced honestly again.

**V2 — #497 after the fix, rehearsed on a throwaway prefix.** The post-fix state cannot be observed
live for the reason just given, and manufacturing a fault in production to watch it is not acceptable.
Instead the new `autodeploy.sh` runs with `XDG_STATE_HOME`/`XDG_DATA_HOME` under `./tmp/`, `notify`
stubbed to a file, `WBB_INSTALLED_CHECK` stubbed to report STALE, and state seeded behind `main`. Two
consecutive ticks must produce exactly one stale message, and the throwaway state file must hold both
`LAST_STALE_NOTICE` and `LAST_DRIFT_NOTICE`. Nothing real is touched.

**V3 — #491 observed after the fix.** Push `autodeploy-<UTC timestamp>` at the deployed SHA: a tag now
exists, `target = DEPLOYED_SHA`, and the guard is never consulted. Merge one Dependabot PR and do not
deploy for more than 15 minutes. A ⚠️ drift message must arrive **with a tag present** — a message
that is impossible under today's code. Then `deploy.sh`, and ✅ "caught up" must close the episode.

The same step demonstrates the adjacent defect live: once production moves past the hand-pushed tag,
one ⛔ downgrade refusal follows. That cost is not incurred by choosing to verify — the *first real
tag* pays it identically. Paying it now, watched, is better than at 03:00.

## Success criteria

1. With an `autodeploy-*` tag present and already deployed, drift past the grace window is announced.
2. With a tag recorded as `LAST_FAILED_SHA`, drift past the grace window is announced.
3. With a tag present, a stale installed deployer is reported once a day.
4. A pending tag produces exactly one message — the guard's verdict — and no idle report.
5. A tick in which both reporters speak leaves **both** markers in the state file, and the next tick
   the same day is silent.
6. `write_state` has three parameters; a source-guard test fails the suite if any call site in
   `deploy/autodeploy.sh` passes it a fourth.
7. `deploy/README.md` states what "idle" now means.
8. Every new test is mutation-proven: delete the line it defends, show it fail.
