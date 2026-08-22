# Issue 473 Rsync Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the production rsync denylist with an allowlist that excludes unknown repository paths and removes previously deployed scratch files.

**Architecture:** Keep the existing build-on-host deployment flow. Move payload membership into `deploy/rsync-filter`, make `deploy.sh` apply that filter with deletion of excluded destination paths, and keep the sudoers argv contract synchronized. Exercise the boundary through the real deploy script and real rsync binary with privileged side effects redirected by a test wrapper.

**Tech Stack:** Bash, rsync filter rules, sudoers, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-08/2026-08-22-473-rsync-allowlist-design.md`

## Global Constraints

- Preserve the existing rsync-to-`/opt` then `npm ci`/build/prune architecture.
- Deploy only `package.json`, `package-lock.json`, `tsconfig.json`, `src/***`, `scripts/***`, and `deploy/***` from the repository root.
- Remove destination paths outside the allowlist with `--delete-excluded`.
- Update `deploy.sh` and `deploy/sudoers.d/warsaw-beer-bot` together.
- Install the updated sudoers fragment before executing a deploy script with changed rsync arguments.
- Add no dependencies.

---

### Task 1: Capture the unsafe deployment payload

**Files:**

- Create: `scripts/deploy-rsync.test.ts`

**Interfaces:**

- Consumes: `deploy/deploy.sh` as the production entry point and `/usr/bin/rsync` as the payload engine.
- Produces: A regression contract over the complete destination file list.

- [ ] **Step 1: Write the failing integration test**

Create temporary source, destination, and fake-bin directories. Copy the real
`deploy/` directory into the source fixture. Add allowed build inputs and these
forbidden paths:

```ts
for (const path of [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'src/index.ts',
  'scripts/tool.ts',
  'tmp/current.db',
  '.claude/settings.json',
  '.superpowers/ledger.md',
  'extension/manifest.json',
  'docs/plan.md',
  'tests/fixture.ts',
]) {
  write(join(source, path));
}
write(join(destination, 'tmp/stale.db'));
```

Put a fake `sudo` first on `PATH`. It must delegate only the rsync invocation
to `/usr/bin/rsync` and replace the fixed `/opt` destination with the temporary
destination. Make other privileged commands no-ops. Run the real
`deploy/deploy.sh` and assert the exact destination list contains only the
approved manifests, source, scripts, and deploy files.

- [ ] **Step 2: Run the test and verify the denylist failure**

Run:

```bash
npx vitest run scripts/deploy-rsync.test.ts
```

Expected: FAIL because `.claude/settings.json`, `.superpowers/ledger.md`,
`extension/manifest.json`, and `tmp/current.db` are present in the destination.

- [ ] **Step 3: Commit the failing test**

```bash
git add scripts/deploy-rsync.test.ts
git commit -m "test(deploy): expose unbounded rsync payload"
```

### Task 2: Enforce the production payload allowlist

**Files:**

- Create: `deploy/rsync-filter`
- Modify: `deploy/deploy.sh`
- Modify: `deploy/sudoers.d/warsaw-beer-bot`
- Test: `scripts/deploy-rsync.test.ts`

**Interfaces:**

- Consumes: Repository-root paths and the existing fixed rsync source and destination.
- Produces: One rsync invocation accepted by sudoers whose output is limited by `deploy/rsync-filter`.

- [ ] **Step 1: Add the minimal filter**

Create `deploy/rsync-filter` with this ordered rule set:

```text
+ /package.json
+ /package-lock.json
+ /tsconfig.json
+ /src/***
+ /scripts/***
+ /deploy/***
- *
```

- [ ] **Step 2: Apply the filter and delete excluded destination paths**

Replace the denylist in `deploy/deploy.sh` with:

```bash
sudo rsync -a --delete --delete-excluded \
  --filter='merge deploy/rsync-filter' \
  ./ "$APP"/
```

Update `WBB_DEPLOY_FILES` with the same decoded argv. Escape the space within
the filter argument for sudoers syntax:

```text
/usr/bin/rsync -a --delete --delete-excluded --filter=merge\ deploy/rsync-filter ./ /opt/warsaw-beer-bot/
```

- [ ] **Step 3: Run the regression test**

Run:

```bash
npx vitest run scripts/deploy-rsync.test.ts
```

Expected: PASS. The exact payload contains approved paths, and neither current
nor stale `tmp/` files remain.

- [ ] **Step 4: Validate shell and sudoers syntax**

Run:

```bash
bash -n deploy/deploy.sh
visudo -cf deploy/sudoers.d/warsaw-beer-bot
```

Expected: both commands exit 0 and `visudo` reports that the fragment parsed OK.

- [ ] **Step 5: Commit the deployment boundary**

```bash
git add deploy/deploy.sh deploy/rsync-filter deploy/sudoers.d/warsaw-beer-bot scripts/deploy-rsync.test.ts
git commit -m "fix(deploy): allowlist production rsync payload"
```

### Task 3: Document the contract and rollout

**Files:**

- Modify: `deploy/README.md`
- Modify: `spec.md`

**Interfaces:**

- Consumes: The rsync and sudoers contract from Task 2.
- Produces: An operator-visible safe rollout sequence and an updated normative deployment description.

- [ ] **Step 1: Document the host sequencing rule**

Explain in `deploy/README.md` that the filter is the payload source of truth,
`--delete-excluded` cleans `/opt`, and rsync argv changes require this order:

```bash
sudo visudo -cf deploy/sudoers.d/warsaw-beer-bot
sudo install -m 0440 -o root -g root \
  deploy/sudoers.d/warsaw-beer-bot /etc/sudoers.d/warsaw-beer-bot
./deploy/deploy.sh
```

- [ ] **Step 2: Update the normative specification**

Change `spec.md` section 5.9 to describe deployment as rsync of allowlisted
build/runtime inputs rather than the unrestricted working tree.

- [ ] **Step 3: Run focused and broader verification**

Run:

```bash
npm run typecheck
npx vitest run scripts/deploy-rsync.test.ts scripts/autodeploy/*.test.ts
bash -n deploy/deploy.sh
visudo -cf deploy/sudoers.d/warsaw-beer-bot
git diff --check
```

Expected: typecheck passes, 75 deploy/autodeploy tests pass, shell and sudoers
syntax checks pass, and the diff has no whitespace errors.

- [ ] **Step 4: Commit documentation**

```bash
git add deploy/README.md spec.md docs/superpowers/specs/2026-08/2026-08-22-473-rsync-allowlist-design.md docs/superpowers/plans/2026-08/2026-08-22-473-rsync-allowlist.md
git commit -m "docs(deploy): record rsync allowlist contract"
```
