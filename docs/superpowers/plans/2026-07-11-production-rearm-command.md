# Production Re-arm Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deployed re-arm npm commands runnable after `npm prune --omit=dev` and able to load the systemd environment file automatically.

**Architecture:** A shared script helper resolves the dotenv path with precedence `DOTENV_CONFIG_PATH` → readable `/etc/warsaw-beer-bot/.env` → local `.env`. Both database-backed re-arm CLIs call it before `loadEnv()`, while `tsx` becomes a runtime dependency so production pruning retains the command runner.

**Tech Stack:** Node.js 20+, TypeScript, dotenv, tsx, Vitest.

---

### Task 1: Add tested operator environment resolution

**Files:**
- Create: `scripts/operator-env.ts`
- Create: `scripts/operator-env.test.ts`
- Modify: `scripts/rearm-aliased-orphans.ts`
- Modify: `scripts/rearm-matcher-bug-orphans.ts`

- [ ] Write failing tests proving an explicit dotenv path wins, the readable production path is selected next, and `.env` is the local fallback.
- [ ] Run `npx vitest run scripts/operator-env.test.ts` and verify the missing module fails.
- [ ] Implement `resolveOperatorEnvPath(env, readable)` as a pure function and `loadOperatorEnv()` as a thin `dotenv.config({ path })` wrapper.
- [ ] Replace `import 'dotenv/config'` in both re-arm scripts with `loadOperatorEnv();` before `loadEnv()` can execute.
- [ ] Run `npx vitest run scripts/operator-env.test.ts scripts/rearm-aliased-orphans.test.ts scripts/rearm-matcher-bug-orphans.test.ts` and verify all pass.

### Task 2: Preserve the command runner in production

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `deploy/README.md`
- Modify: `spec.md`

- [ ] Move `tsx` from `devDependencies` to `dependencies` using npm so the lockfile remains consistent.
- [ ] Document that deployed database maintenance commands run as `warsaw-beer-bot`, automatically use `/etc/warsaw-beer-bot/.env`, and remain available after production pruning.
- [ ] Run `npm prune --omit=dev` and verify `node_modules/.bin/tsx --version` succeeds.
- [ ] Restore the full local install with `npm install`.
- [ ] Run `npm test`, `npm run typecheck`, and `git diff --check`.
- [ ] Commit the focused fix with `fix(ops): keep re-arm commands runnable after deploy (#274)`.

### Task 3: Ship

- [ ] Push the branch and open a PR related to #274 with the production failure and verification evidence.
- [ ] Wait for checks and review feedback; address valid findings before reporting final status.
