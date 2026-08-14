# Issue #411 Runtime Dependency Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the three vulnerable direct production dependencies to their minimum patched releases and prove security and runtime compatibility.

**Architecture:** Keep the application architecture and source unchanged. Update only the three direct dependency ranges and their lockfile records, using the production audit as the proof-first regression check and the existing API, HTTP, proxy, and shutdown tests as compatibility coverage.

**Tech Stack:** Node.js 20, npm 11, TypeScript, Vitest, Hono, `@hono/node-server`, Undici

---

## File map

- Modify: `package.json` — raise only the three direct dependency minimums.
- Modify: `package-lock.json` — resolve exactly the agreed patched versions and required integrity metadata.
- Verify unchanged: `src/**`, `extension/**`, and test sources — no behavior change is expected.

### Task 1: Capture the vulnerable baseline and update the dependency contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Run the failing production audit**

Run:

```bash
npm audit --omit=dev
```

Expected: exit code `1`, with advisories rooted in `undici@7.28.0`,
`hono@4.12.26`, and `@hono/node-server@2.0.4`.

- [ ] **Step 2: Install only the agreed minimum patched releases**

Run:

```bash
npm install --save-prod --save-prefix='^' undici@7.29.0 hono@4.12.34 @hono/node-server@2.0.10
```

Expected manifest entries:

```json
{
  "@hono/node-server": "^2.0.10",
  "hono": "^4.12.34",
  "undici": "^7.29.0"
}
```

- [ ] **Step 3: Verify exact lockfile resolutions and narrow scope**

Run:

```bash
node -e "const p=require('./package-lock.json').packages; console.log({nodeServer:p['node_modules/@hono/node-server'].version,hono:p['node_modules/hono'].version,undici:p['node_modules/undici'].version})"
git diff -- package.json package-lock.json
```

Expected versions:

```text
{ nodeServer: '2.0.10', hono: '4.12.34', undici: '7.29.0' }
```

The diff must contain no other direct dependency change or unrelated lockfile
resolution.

- [ ] **Step 4: Run the production audit as the green regression check**

Run:

```bash
npm audit --omit=dev
```

Expected: exit code `0` and `found 0 vulnerabilities`.

- [ ] **Step 5: Run focused compatibility tests**

Run:

```bash
npx vitest run src/api/index.test.ts src/api/middleware/payload-limit.test.ts src/sources/proxy-rotator.test.ts src/sources/http.test.ts src/shutdown.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 6: Commit the dependency update**

Run:

```bash
git add package.json package-lock.json
git commit -m "fix(#411): upgrade vulnerable runtime dependencies"
```

Expected: one focused implementation commit containing only the manifest and
lockfile changes.

### Task 2: Prove full compatibility and lifecycle behavior

**Files:**
- Verify: `package.json`
- Verify: `package-lock.json`
- Verify unchanged: `src/**`, `extension/**`

- [ ] **Step 1: Reinstall exactly from the committed lockfile**

Run:

```bash
npm ci
npm ls undici hono @hono/node-server --depth=0
```

Expected: install succeeds and reports `undici@7.29.0`, `hono@4.12.34`, and
`@hono/node-server@2.0.10`.

- [ ] **Step 2: Run the complete automated verification set**

Run:

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Expected: every command exits `0`; all tests pass and the audit reports zero
production vulnerabilities.

- [ ] **Step 3: Smoke-test API startup, health, and clean shutdown**

Run:

```bash
npx tsx -e "import { once } from 'node:events'; import type { Server } from 'node:http'; import pino from 'pino'; import { createApiApp, createApiServer } from './src/api'; import { openDb } from './src/storage/db'; import { migrate } from './src/storage/schema'; async function main(){ const db=openDb(':memory:'); migrate(db); const log=pino({level:'silent'}); const app=createApiApp({db,env:{} as never,log}); const server=createApiServer(app,{API_PORT:0} as never,log) as Server; try { if(!server.listening) await once(server,'listening'); const address=server.address(); if(!address || typeof address==='string') throw new Error('missing TCP address'); const response=await fetch('http://127.0.0.1:'+address.port+'/health'); const body=await response.text(); if(response.status!==200 || body!=='{\"ok\":true}') throw new Error('unexpected health response: '+response.status+' '+body); console.log('health',response.status,body); } finally { await new Promise<void>((resolve,reject)=>server.close((error)=>error?reject(error):resolve())); db.close(); } console.log('shutdown ok'); } main().catch((error)=>{ console.error(error); process.exitCode=1; });"
```

Expected:

```text
health 200 {"ok":true}
shutdown ok
```

- [ ] **Step 4: Review final scope and branch state**

Run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
git log --oneline origin/main..HEAD
```

Expected: no whitespace errors, a clean worktree, and only the design, plan,
`package.json`, and `package-lock.json` changed on the branch.

- [ ] **Step 5: Request pull-request authorization**

Report the audit, test, typecheck, build, smoke, and scope evidence. Do not push
or open a pull request until the user confirms.
