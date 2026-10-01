# Prevent and report production regressions (#767, #768)

Approved in chat on 2026-10-01. This extends the merge-deploy design of
2026-09-30 without changing its build, migration or health gates.

## Evidence and cause

The 2026-09-30 incident deployed `29afe80` over `a003b94` from a stale
checkout. A local Git replay before this design confirmed both are commits,
`git merge-base --is-ancestor 29afe80 a003b94` exits 0, and
`git rev-list --count 29afe80..a003b94` returns 81. The current manual script
does no ancestry check before rsync. The tick compares production with main,
but records no prior observation, so it cannot distinguish a backwards move
from an ordinary lag behind main. `record-deployed.sh` preserves other state
keys; the tick's writer explicitly lists the keys it preserves.

## Decisions

1. Under the existing shared lock, before any privileged command, manual
   `deploy.sh` checks that recorded `DEPLOYED_SHA` resolves to a commit and
   is an ancestor of HEAD. Equality and forward deployments pass. An unknown
   commit, backwards move or divergent history refuses without touching
   production. No recorded baseline allows first deployment/reseeding. An
   unreadable or malformed existing state refuses. Unknown CLI options refuse.
2. `--force` explicitly bypasses the ancestry restriction, logging the
   recorded and target SHA to stderr before deploying. It does not bypass the
   operator/root restriction or lock. No network freshness check is added:
   locally cached origin/main cannot prove freshness, and requiring a fetch
   would make manual recovery depend on network availability.
3. The tick records `LAST_SEEN_DEPLOYED_SHA`: the last resolved deployed
   commit it observed or successfully recorded itself. Initial observation
   seeds it without inventing history. An empty deployed baseline preserves
   the previous observation. A changed resolved SHA is forward only when
   the previous observation is its ancestor. A strict ancestor is backwards;
   otherwise it is divergent. Unknown commits are reported as unassessable,
   never silently classified as regressions or used to erase history.
4. On regression, persist `REGRESSION_FROM_SHA` (the pre-regression recovery
   point) and `REGRESSION_TO_SHA` (the latest regressed observation). These
   block unattended deployment across ticks, even if main moves. The initial
   recovery point is retained across further regressions or partial forward
   recovery. Clear only when the recorded production SHA contains that point.
   A human deploys main to recover when it contains that point (with `--force`
   if histories diverge). If main cannot contain it (a squash-merged feature
   deployment), or an observation's Git object is lost, the operator can
   explicitly acknowledge verified intended production: back up state and,
   under the shared lock, remove only LAST_SEEN_DEPLOYED_SHA, REGRESSION_*
   and LAST_HOLD_NOTICE. The next tick reseeds from the resolved deployed
   record. No automatic acknowledgement; failed/window keys stay intact.
5. Send a bounded standalone warning for each observed regression transition:
   old/new short SHAs, backwards vs divergent, number of commits in new..old,
   and the number of distinct PRs associated with those commits. These counts
   describe commits no longer reachable, not verified runtime features. If
   the PR API fails, say the PR count is unknown. Notification failure keeps
   the observation pending for retry; the deployment brake is already durable.
   Further ticks send the usual daily HELD message with regression context.
   Ordinary path/PR holds are included where the range can be assessed.
6. Own successful deployments update the observation in the same state write
   as DEPLOYED_SHA. The automatic rollback passes `--force` to deploy.sh and
   records its resulting observation itself, avoiding a second manual-regression
   alert after the existing rollback notification. Interrupted rollback/window
   handling remains authoritative; if interrupted rollback already recorded
   its intended old SHA, its handler accepts that as its own observation
   while retaining the existing unknown-health warning.

## Claims and their evidence

| Recorded fact | Claim | Evidence / limit |
|---|---|---|
| DEPLOYED_SHA (existing) | Clean tree copied and service restarted at this commit | deploy.sh records after restart; dirty tree clears it; not a health claim |
| LAST_SEEN_DEPLOYED_SHA | This resolved deployed record was observed, or successfully written by this tick | state read + local commit resolution; own deployment result; never proof of health or all intermediate deploys |
| REGRESSION_FROM_SHA / REGRESSION_TO_SHA | Observed transition lost ancestry and recovery has not regained its original point | resolved commits + real Git ancestry checks; current SHA checked against FROM each tick |
| Warning commit count | These commits were reachable from old but not new | successful git rev-list new..old; no feature-removal claim |
| Warning PR count | Distinct PRs returned for those lost commits | successful per-commit PR API responses; failures explicitly yield unknown |
| Advanced observation after warning | Notification command accepted this event | successful notifier exit; Telegram acceptance is not human acknowledgement |
| Observation after operator acknowledgement | A human chose to discard the previous recovery requirement | explicit locked state reset after manual verification, backed-up prior state; next tick resolves current recorded SHA; not an automatic ancestry/health claim |

## Scope, tests and rollout

Change only the existing deploy scripts, their focused tests, spec.md and
deployment documentation. No dependencies, database migrations or new service.
Tests use real temporary Git histories and stub only privileged/external I/O.
Cover equality, descendants, ancestors, divergence, unknown SHA, missing/empty
baseline, unreadable state, --force, lock/root/CLI restrictions; first observation,
durable regression blocking, recovery, repeated/further transitions, missing
objects, notification/API failures and the existing automatic rollback path.

One PR closes both issues. It carries `[deploy:hold]` and `deploy:hold` because
autodeploy.sh is an installed copy. After merge, update every manual deployment
checkout, install the new deployer from current main with
`sudo bash deploy/install-autodeploy.sh`, then run `bash deploy/deploy.sh` from
current main. Old script copies cannot enforce the new rule. First observation
cannot diagnose a rollback that occurred before this version began observing.

## Cross-review clarifications (2026-10-01)

The approved ancestry guard deliberately checks HEAD and keeps the existing
dirty-tree policy (clear baseline). It does not prove ancestry of uncommitted
files. An empty baseline permits reseeding, so clean deployments are required
for persistent commit identity. Human acknowledgement is an operational escape
for unverifiable/replaced history, not permission for the tick to forget it.
