# Deployment regression implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline; the repository
> maps subagent dispatch to sequential work in the main thread.

**Goal:** Refuse accidental manual downgrades and report/block observed production regressions.

**Architecture:** Extend the current shared-lock shell scripts and state.env.
Keep Git real in tests; privileged commands, notification and GitHub remain
at existing external seams. No new runtime module.

**Tech Stack:** Bash, Git, TypeScript/Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-01-767-768-deploy-regression-design.md`

## Global constraints

- No dependencies, database migrations or new service.
- No network freshness check in manual deploy.sh.
- --force bypasses ancestry only, never root or locking restrictions.
- Regression blocks unattended deployment until the original recovery point is regained.
- Claim counts only when Git/API evidence succeeds.
- Full gate: `npm test && npm run typecheck`; Claude cross-review before PR.

## Task 1: Manual admission and rollback compatibility

Files: `deploy/deploy.sh`, `deploy/autodeploy.sh`,
`scripts/autodeploy/deploy-lock.test.ts`, new
`scripts/autodeploy/deploy-ancestry.test.ts`.

Interface: deploy.sh accepts only zero arguments or `--force`;
`_deploy_default` forwards arguments; rollback calls the deployment seam with
`--force`. State location remains `${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy/state.env`.

- [ ] Write integration fixtures with a real base commit, descendant and sibling,
  recording the descendant while checking out base. Assert refusal code 1,
  no sudo log, unchanged state; run to see failure.
- [ ] Add equality/forward/unknown/empty/first-deploy/force/root/lock/CLI cases.
- [ ] Before sudo, read the baseline under lock and apply:
  ```bash
  git rev-parse --verify "${recorded}^{commit}" >/dev/null 2>&1 &&
    git merge-base --is-ancestor "$recorded" HEAD
  ```
  Refuse failed resolution/ancestry unless --force; log force before proceeding.
  Preserve first-deploy behavior but refuse unreadable/malformed state.
- [ ] Forward arguments in `_deploy_default() { ./deploy/deploy.sh "$@"; }`;
  pass --force only in roll_back's deployment call. Assert the existing rollback
  test sees --force, and run the real deploy.sh against a regressed Git fixture
  with that flag.
- [ ] Run focused tests then the full gate; commit the deliverable.

## Task 2: Observe, report and hold regressions

Files: `deploy/autodeploy.sh`, `scripts/autodeploy/autodeploy.test.ts`,
`scripts/autodeploy/record-deployed.test.ts`.

Interface: add LAST_SEEN_DEPLOYED_SHA, REGRESSION_FROM_SHA,
REGRESSION_TO_SHA to the existing state writer. record-deployed preserves them.

- [ ] Add tests: initial up-to-date tick seeds observation; a real manual record
  from descendant to base emits a warning and performs no deployment even after
  ten minutes and further main merges. Repeated tick emits no second transition
  warning. Observe the failing tests before implementation.
- [ ] After fetch, before ordinary early exits, resolve both observations and
  compare ancestry. Seed only resolved initial state. On regression persist FROM
  (retaining any existing fence) and TO before notifying. Count lost commits
  with `git rev-list "${DEPLOYED_SHA}..${LAST_SEEN_DEPLOYED_SHA}"` and distinct
  PRs with the existing PR_LABELS_CMD. API errors produce unknown PR count.
- [ ] Keep LAST_SEEN unchanged on failed notification; advance after successful
  notification. Unknown commit objects block assessment without erasing the
  previous observation. Missing baseline preserves it too.
- [ ] Before the ordinary deploy decision, if FROM is set and is not an
  ancestor of production, send daily HELD with the regression SHAs; include
  ordinary hold reasons when production..main can be assessed, then exit 0.
  Clear the fence only after Git proves FROM is regained.
- [ ] Update LAST_SEEN in the existing successful own-deploy/rollback writes.
  Cover further backwards transitions, partial and full recovery, divergence,
  failed notifier/PR API, missing objects, state-write failure and automatic
  rollback without a false new regression warning. Assert real state/effects.
- [ ] Run focused tests and the full gate; commit the deliverable.

## Task 3: Documentation and shipping

Files: `spec.md`, `deploy/README.md`, this plan.

- [ ] Document manual ancestry admission/--force and tick observation/recovery
  fence, their limits, messages and state keys. Mark plan steps completed.
- [ ] Review the complete diff for claim/evidence alignment and rollback
  compatibility; run the full gate and shell syntax checks.
- [ ] Fetch main and rebase if moved; rerun the gate after any rebase.
- [ ] Run `npm run cross-review -- --reviewer claude`, allow its internal
  15-minute timeout to finish, evaluate every finding, fix or reject with
  evidence, rerun the gate after fixes.
- [ ] Push and create a `[deploy:hold]` PR labelled deploy:hold, closing #767
  and #768 with host steps and the cross-review receipt. Wait for checks and
  review; address valid findings before reporting completion. Do not merge.
