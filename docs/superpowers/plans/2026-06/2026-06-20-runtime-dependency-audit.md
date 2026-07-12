# Runtime Dependency Audit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear all production dependency advisories reported by `npm audit --omit=dev` with a minimal, semver-compatible lockfile refresh.

**Architecture:** Keep application code and declared dependency ranges unchanged. Use npm's resolver to refresh only the vulnerable `hono` and transitive `undici` lockfile entries, then prove the production audit, tests, and TypeScript build are clean.

**Tech Stack:** Node.js 20, npm 11, TypeScript, Vitest, Hono, Cheerio/Undici

---

## File map

- Modify: `package-lock.json` — resolve `hono` to at least 4.12.25 and `undici` to at least 7.28.0.
- Verify unchanged: `package.json` — existing semver ranges already permit safe resolutions; no override or range change is expected.
- Verify unchanged: application and test source — dependency refresh must not require behavior changes.

### Task 1: Establish the failing production-audit baseline

**Files:**
- Verify: `package.json`
- Verify: `package-lock.json`

- [ ] **Step 1: Install the branch's locked dependencies**

Run:

```bash
npm ci
```

Expected: installation succeeds without modifying `package.json` or `package-lock.json`.

- [ ] **Step 2: Run the production audit as the failing regression check**

Run:

```bash
npm audit --omit=dev --json
```

Expected: exit code 1 with exactly two high-severity vulnerable packages: direct `hono` below 4.12.25 and transitive `undici` below 7.28.0.

- [ ] **Step 3: Record the current resolved versions**

Run:

```bash
node -e "const p=require('./package-lock.json').packages; console.log({hono:p['node_modules/hono'].version,undici:p['node_modules/undici'].version})"
```

Expected before the fix:

```text
{ hono: '4.12.23', undici: '7.25.0' }
```

### Task 2: Refresh only the vulnerable runtime resolutions

**Files:**
- Modify: `package-lock.json`
- Verify unchanged: `package.json`

- [ ] **Step 1: Update the two affected lockfile entries within existing ranges**

Run:

```bash
npm update hono undici --package-lock-only
```

Expected: command succeeds and modifies `package-lock.json` without modifying `package.json`.

- [ ] **Step 2: Inspect the dependency diff for scope**

Run:

```bash
git diff -- package.json package-lock.json
```

Expected: `package.json` has no diff; `package-lock.json` changes are limited to `hono`, `undici`, and lockfile integrity/resolution metadata directly required for those packages.

- [ ] **Step 3: Verify the resolved versions meet advisory thresholds**

Run:

```bash
node -e "const p=require('./package-lock.json').packages; const h=p['node_modules/hono'].version; const u=p['node_modules/undici'].version; console.log({hono:h,undici:u}); if (h.localeCompare('4.12.25',undefined,{numeric:true})<0 || u.localeCompare('7.28.0',undefined,{numeric:true})<0) process.exit(1)"
```

Expected: exit code 0 with `hono` ≥4.12.25 and `undici` ≥7.28.0.

- [ ] **Step 4: Reinstall exactly from the refreshed lockfile**

Run:

```bash
npm ci
```

Expected: installation succeeds and `npm ls hono undici` reports the safe versions from `package-lock.json`.

### Task 3: Prove security and behavioral compatibility

**Files:**
- Verify: `package-lock.json`
- Verify unchanged: `package.json`
- Verify unchanged: `src/**`

- [ ] **Step 1: Run the production audit to verify GREEN**

Run:

```bash
npm audit --omit=dev
```

Expected: exit code 0 and `found 0 vulnerabilities`.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: all 83 test files and 778 tests pass with zero failures.

- [ ] **Step 3: Run the production TypeScript build**

Run:

```bash
npm run build
```

Expected: exit code 0 from `tsc`.

- [ ] **Step 4: Run final scope and whitespace checks**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD
```

Expected: no whitespace errors; only `package-lock.json` is modified relative to the committed design and plan; no application, extension, or dev-tooling files changed.

- [ ] **Step 5: Commit the dependency fix**

Run:

```bash
git add package-lock.json
git commit -m "fix(deps): clear runtime dependency advisories"
```

Expected: one focused dependency commit after the design/plan documentation commits.

### Task 4: Prepare review and deployment handoff

**Files:**
- Verify: branch history and working tree

- [ ] **Step 1: Review the complete branch diff**

Run:

```bash
git diff origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: the branch contains the approved design, this implementation plan, and the minimal runtime lockfile refresh only.

- [ ] **Step 2: Ask whether to open the pull request**

Present the verified audit result, resolved versions, test/build evidence, and branch name. Per repository policy, do not push or create the pull request until the user confirms.

- [ ] **Step 3: After merge, deploy only with explicit authorization**

Use the repository runbook:

```bash
git pull --ff-only
./deploy/deploy.sh
systemctl is-active warsaw-beer-bot
curl -fsS http://127.0.0.1:3000/health
```

Expected after an authorized deployment: active systemd service and `{"ok":true}` health response.
