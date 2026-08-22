# #473 — Allowlisted production rsync payload

Date: 2026-08-22
Status: agreed
Issue: https://github.com/ysilvestrov/warsaw-beer-bot/issues/473

## Problem

`deploy/deploy.sh` sends the repository working tree to `/opt/warsaw-beer-bot`
and excludes a finite list of known non-production paths. Any new path is
therefore deployed by default. This has already copied `tmp/`, `.superpowers/`,
and `.claude/` to production. During the #458 rehearsal, `tmp/` briefly held
962 MB of database and Node runtime artifacts that would have been transferred
inside the outage window.

The rsync command is also pinned by arguments in
`deploy/sudoers.d/warsaw-beer-bot`. Changing only `deploy.sh` breaks the
NOPASSWD command match, so the script and sudoers rule form one operational
contract.

## Requirements

- R1. A path not explicitly approved as a production build or runtime input
  must not be copied to `/opt/warsaw-beer-bot`.
- R2. The deployed source must contain everything required by `npm ci`,
  `npm run build`, the systemd installation step, and documented operational
  scripts.
- R3. Files already present under `/opt/warsaw-beer-bot` but outside the
  allowlist must be removed during deployment.
- R4. The rsync arguments in `deploy.sh` and the sudoers command rule must
  remain compatible.
- R5. A host must receive the updated sudoers fragment before it runs a
  deploy script with changed rsync arguments.
- R6. The payload policy must be exercised through the real deploy script and
  real rsync behavior in an automated regression test.

## Approaches considered

### 1. Repository-root allowlist filter — chosen

Store rsync filter rules in `deploy/rsync-filter`. Permit only the package
manifests, the build tsconfig, `src/`, `scripts/`, and `deploy/`. Reject every
other root path. Pass the filter through one stable rsync argument and use
`--delete-excluded` so old scratch files do not survive the transition.

This fixes the failure class: a newly created root directory is rejected until
someone deliberately adds it to the production contract. The filter remains
plain data and can evolve without growing the sudoers command line.

### 2. Extend the existing exclude list — rejected

Adding `tmp`, `.superpowers`, and `.claude` would remove today's examples but
would preserve the unsafe default for the next unanticipated directory.

### 3. Build a separate staging artifact — rejected for this issue

Constructing a fresh release directory before rsync would also provide an
allowlist boundary, but it would add a second build/deployment phase and change
the existing operational architecture. The filter provides the required
boundary with a smaller change.

## Design

`deploy/deploy.sh` invokes rsync with `--delete`, `--delete-excluded`, and a
merged `deploy/rsync-filter`. The filter admits these repository-root paths:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `src/***`
- `scripts/***`
- `deploy/***`

The final catch-all rule rejects everything else, including `tmp/`, agent
workspaces, documentation, browser-extension sources, tests, existing
`node_modules`, and existing `dist`. `npm ci` and `npm run build` recreate the
last two in the deployed tree.

The sudoers fragment pins the corresponding rsync arguments. The deployment
guide treats an rsync-argument change as a two-step rollout: validate and
install the new fragment, then execute the updated deploy script.

## Failure behavior

- A missing or invalid filter makes rsync fail under `set -e`; deployment does
  not continue to the build or service restart.
- A source path outside the allowlist is omitted and any matching destination
  path is removed by `--delete-excluded`.
- A stale sudoers fragment rejects the updated rsync invocation. The documented
  rollout order prevents this expected compatibility break.

## Testing

The regression test runs the real `deploy/deploy.sh` with a fake `sudo` wrapper
that delegates only its rsync command to the real `/usr/bin/rsync` and redirects
the fixed production destination to a temporary directory. Its source fixture
contains allowed build inputs plus `tmp/`, `.claude/`, `.superpowers/`,
`extension/`, `docs/`, and `tests/`. The destination begins with a stale scratch
file. The assertion checks the exact resulting payload, proving both default
rejection and stale-file deletion.

Verification also includes TypeScript typechecking, the deploy/autodeploy test
group, `bash -n deploy/deploy.sh`, `visudo -cf` for the sudoers fragment, and
`git diff --check`.

## Rollout

1. Validate the repository sudoers fragment with `visudo -cf`.
2. Install it at `/etc/sudoers.d/warsaw-beer-bot` with mode `0440`.
3. Run `deploy/deploy.sh`.
4. Confirm the service restarts and `/opt/warsaw-beer-bot` contains only the
   allowlisted payload plus newly generated `node_modules` and `dist`.

## Out of scope

- Replacing rsync or the existing build-on-host deployment architecture.
- Moving mutable application data; it already lives outside `/opt`.
- Reducing test files nested inside an otherwise allowlisted source directory.
- Changing autodeploy qualification rules.
