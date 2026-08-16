# #435 Dependency Security Autofix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect production dependency vulnerabilities automatically and carry a fix all the way to a restarted service without a human, while development-tooling advisories get a notification only.

**Architecture:** GitHub detects and proposes; a CI workflow gates; a qualification workflow decides using measurements rather than metadata; a systemd timer on the production host re-verifies everything locally and deploys only a change that touches nothing but the root lockfile. The deciding logic lives in two pure TypeScript functions and one hermetic bash guard, all unit-tested; the YAML and the deploy script are thin wrappers around them.

**Tech Stack:** GitHub Actions, Dependabot, TypeScript, Vitest, bash, systemd. Run tests with `npx vitest run <path>`; typecheck with `npx tsc --noEmit && npx tsc -p tsconfig.scripts.json`.

**Spec:** `docs/superpowers/specs/2026-08/2026-08-16-435-dependency-security-autofix-design.md`

## Global Constraints

- **The autodeploy allowlist is exactly `package.json` and `package-lock.json` at the repository root.** Not `extension/**`, not `docs/**`, not anything else. The extension is never deployed to the server.
- **No `pull_request_target` anywhere in this repository.**
- **No job holding a write token may check out or execute pull-request code.** The qualify workflow checks out `main` and reads the PR's two files as data via `git show <sha>:<path>`.
- **No change to `deploy/deploy.sh`, `deploy/sudoers.d/warsaw-beer-bot`, or `deploy/warsaw-beer-bot.service`.** If a step appears to need one, the step is wrong — stop and report.
- **Autodeploy never reads the operator's working tree** (`/home/ysi/warsaw-beer-bot`). It uses its own checkout under `${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy/repo`.
- **The bot process is never the notifier for deploy outcomes.** `curl` to the Telegram API directly, or the failure that matters most goes unreported.
- **Never use `grep` in host-side scripts.** On this host `grep` is a ugrep shim that OOMs; use bash `case` matching instead.
- **Branch protection must require the `ci` check and must NOT require approving reviews.** Requiring a review deadlocks auto-merge permanently — Dependabot cannot approve its own pull request.
- **Repo commit convention:** subject `feat(#435): …`, `test(#435): …`, `chore(#435): …`, and every commit message ends with the two trailer lines shown in Part 1 Task 1 Step 5.
- **Worktree guard — run before your first commit in every part:** `git rev-parse --show-toplevel` must print the worktree path named in that part's heading (NOT `/home/ysi/warsaw-beer-bot`), and `git branch --show-current` must print that part's branch. If either is wrong, STOP and report — do not commit.

## Staging — five parts, four gates

Each part is its own branch, worktree, and pull request. **A part may not begin until the previous part's gate has been observed in production**, because each gate produces evidence the next part depends on. This is the whole reason for the split: arming automation on top of an unproven gate would repeat the failure this work exists to prevent.

| Part | Delivers | Gate before the next part |
|---|---|---|
| 1 | `ci.yml`, Dependabot turned on, branch protection | Real Dependabot PRs exist and `ci` runs red-and-green on them. Nothing merges by itself. |
| 2 | Qualification, **label-only** | Every open Dependabot PR carries a verdict label, and the four dev-stream advisories are all labelled `deps-manual`. |
| 3 | Host deployer, **timer disabled** | Guard tests green; a manual dry run accepts a synthetic lockfile-only tag and refuses a synthetic `src/` tag. |
| 4 | Auto-merge + tagging + timer enabled | First real runtime advisory travels the whole path. |
| 5 | Independent daily audit | — |

Part 5 depends on nothing and may be done at any point after Part 1.

---

# Part 1 — the gate

Branch `worktree-435-ci-gate`, worktree `/home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-435-ci-gate`.

Nothing here is automated. This part only makes the repository able to observe itself: tests run on every PR, and Dependabot starts telling us what it sees.

### Task 1: `ci.yml` — the test gate

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a required status check named exactly **`ci`**, aggregating a matrix job named `build`. Part 1 Task 4 and Part 4 Task 2 both depend on that exact name.

- [ ] **Step 1: Write the workflow**

The matrix job is named `build` and a separate one-line job named `ci` aggregates it. This exists so the required-check name stays `ci` even if the matrix later grows an entry — a required check pinned to `build (root)` would silently stop being required the day someone renames a matrix leg.

Root runs on Node 20 because that is what production runs (`deploy/warsaw-beer-bot.service` calls `/usr/bin/node`, and `package.json` declares `engines.node >= 20`). The extension runs on Node 22 because it never reaches the server and its toolchain (Vite 8) targets newer Node.

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: build (${{ matrix.name }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - name: root
            dir: .
            node: 20
          - name: extension
            dir: extension
            node: 22
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
          cache-dependency-path: ${{ matrix.dir }}/package-lock.json

      - name: Install
        run: npm ci
        working-directory: ${{ matrix.dir }}

      - name: Typecheck
        run: npm run typecheck
        working-directory: ${{ matrix.dir }}

      - name: Test
        run: npm test
        working-directory: ${{ matrix.dir }}

  # Single stable name for branch protection and auto-merge to depend on.
  # `if: always()` so this job runs even when `build` failed — otherwise a
  # failed matrix leg would leave the required check *pending* forever and
  # every PR would hang instead of going red.
  ci:
    name: ci
    runs-on: ubuntu-latest
    needs: [build]
    if: always()
    steps:
      - name: Report matrix result
        run: |
          echo "build result: ${{ needs.build.result }}"
          [ "${{ needs.build.result }}" = "success" ]
```

- [ ] **Step 2: Verify the root leg passes locally before pushing**

Run: `npm ci && npm run typecheck && npm test`
Expected: PASS. If it fails locally it will fail in CI; fix the cause before opening the PR, and report it — a pre-existing broken test is information, not something to paper over.

- [ ] **Step 3: Verify the extension leg passes locally**

Run: `cd extension && npm ci && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Prove the gate can go red (mutation proof)**

A gate that cannot fail is not a gate, and this one guards everything else in the plan.

Temporarily break one assertion, e.g. in `src/config/env.test.ts` change an expected value to a wrong one. Commit it on the branch, push, and confirm on the PR that `build (root)` fails **and** that the aggregate `ci` check reports failure rather than staying pending.

Then revert the break with `git revert` (keep both commits in the history — the proof is worth reading later) and confirm `ci` goes green.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(#435): CI runs the test suite on every pull request

The repository had no workflow running vitest — codex-review.yml and
pages.yml were the only two — so every dependency bump merged so far
merged blind. Everything else in #435 is built on this gate.

Root runs Node 20 to match production; the extension runs Node 22 since
it never reaches the server. A one-line `ci` job aggregates the matrix so
branch protection has a stable name to require.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 2: exclude Dependabot from the AI review

**Files:**
- Modify: `.github/workflows/codex-review.yml` (the `review:` job, ~line 16)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks read.

- [ ] **Step 1: Add the condition**

After the `review:` job's `runs-on: ubuntu-latest`, add:

```yaml
    # #435: a Dependabot PR leaves exactly one file in review scope —
    # package.json, whose diff is version-range strings (IGNORE_PATTERNS at
    # scripts/ai-pr-review.ts:22 already drops package-lock.json). A reviewer
    # built to find correctness bugs in code gets a diff with no code. And with
    # auto-merge armed the PR merges on the required checks, so any comment
    # lands on something already merged and deployed — there is no point at
    # which a reaction could occur. Replaced by deterministic checks: ci, the
    # audit-diff, and manifestScope().
    if: github.event.pull_request.user.login != 'dependabot[bot]'
```

- [ ] **Step 2: Verify the YAML parses**

Run: `npx tsx -e "const y=require('fs').readFileSync('.github/workflows/codex-review.yml','utf8'); if(!y.includes(\"dependabot[bot]\")) throw new Error('condition missing'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/codex-review.yml
git commit -m "$(cat <<'EOF'
chore(#435): AI review does not run on Dependabot pull requests

Not a cost decision — IGNORE_PATTERNS already drops the lockfile and #415's
real bump was ~2.7 KB. There is simply nothing to review (one file in scope,
whose diff is version strings) and nobody to read it (auto-merge lands the PR
on the required checks, so comments arrive post-merge).

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 3: `dependabot.yml` and turning detection on

**Files:**
- Create: `.github/dependabot.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: Dependabot pull requests, which Part 2 classifies.

- [ ] **Step 1: Write the config**

`cooldown` here governs only the weekly *version* updates. Security updates ignore it entirely (verified against GitHub's docs: "The `cooldown` option is only available for *version* updates, not *security* updates"), which is exactly why Part 2 implements the 48-hour hold itself.

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    cooldown:
      default-days: 7
    groups:
      root-dev:
        dependency-type: development
      root-prod:
        dependency-type: production

  - package-ecosystem: npm
    directory: "/extension"
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 3
    cooldown:
      default-days: 7
    groups:
      extension-dev:
        dependency-type: development

  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: monthly
```

- [ ] **Step 2: Commit**

```bash
git add .github/dependabot.yml
git commit -m "$(cat <<'EOF'
feat(#435): Dependabot config for both npm projects and the actions

Weekly grouped version updates with a 7-day cooldown. Security updates are
opened by GitHub independently of this file and are subject to neither its
schedule, its open-pull-requests-limit, nor its cooldown — the 48h hold for
`high` is enforced in the qualification step instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

- [ ] **Step 3: Enable alerts and security updates (ops step, after the PR merges)**

Both are currently off — `vulnerability-alerts` returns 404 and `automated-security-fixes` returns `{"enabled":false}`.

```bash
gh api -X PUT repos/ysilvestrov/warsaw-beer-bot/vulnerability-alerts
gh api -X PUT repos/ysilvestrov/warsaw-beer-bot/automated-security-fixes
```

- [ ] **Step 4: Verify both are on**

```bash
gh api repos/ysilvestrov/warsaw-beer-bot/vulnerability-alerts -i | head -1   # expect: HTTP/2.0 204
gh api repos/ysilvestrov/warsaw-beer-bot/automated-security-fixes            # expect: {"enabled":true,...}
```

### Task 4: branch protection

**Files:** none — repository settings.

**Interfaces:**
- Consumes: the check name `ci` from Task 1.
- Produces: the merge gate Part 4's auto-merge relies on.

- [ ] **Step 1: Wait until `ci` has completed at least once on a PR**

A status check that has never reported cannot be selected as required. Task 1's own PR satisfies this.

- [ ] **Step 2: Apply protection**

`required_pull_request_reviews` is `null` deliberately. See Global Constraints.

```bash
gh api -X PUT repos/ysilvestrov/warsaw-beer-bot/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": { "strict": true, "contexts": ["ci"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

- [ ] **Step 3: Verify**

```bash
gh api repos/ysilvestrov/warsaw-beer-bot/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, reviews: .required_pull_request_reviews}'
```
Expected: `{"checks":["ci"],"reviews":null}`. If `reviews` is anything but `null`, auto-merge will deadlock in Part 4 — fix it now.

## Gate 1 — observe before continuing

Do not start Part 2 until all of these are true. Record the numbers; Part 2's gate compares against them.

```bash
gh pr list --author 'app/dependabot' --json number,title,labels
gh api repos/ysilvestrov/warsaw-beer-bot/dependabot/alerts --jq '[.[] | select(.state=="open") | {ghsa: .security_advisory.ghsa_id, sev: .security_advisory.severity, scope: .dependency.scope, pkg: .dependency.package.name}]'
```

- [ ] Dependabot has opened at least one pull request.
- [ ] `ci` reports on those pull requests, and has been observed both red (Task 1 Step 4) and green.
- [ ] No pull request merged by itself.
- [ ] The open alerts include the four known development-scope advisories (`nanoid`, `postcss` in both projects) and **no** `runtime`-scope advisory. If a runtime one appears, say so — it is the first real customer of this work and it must be fixed by hand now, not held until Part 4.

### Gate 1 — PASSED 2026-08-16

Dependabot opened 10 pull requests within minutes of alerts going on. `ci` was observed RED on #441,
#442 and #444 and GREEN on the rest — on real traffic, not only the synthetic proof. `review`
reported `skipping` on every Dependabot pull request. All open alerts were `scope: development`;
none runtime.

Three findings carried forward:

1. **`strict: true` livelocks a queue.** Auto-merge does not update a stale branch, and every merge
   makes every other open pull request stale. Two green PRs with auto-merge armed sat in `BEHIND`
   until updated by hand. Remedied in Part 4 Task 2 Step 2 — see the design's §1.
2. **npm and GitHub disagree on severity.** `GHSA-fxqj-rqcc-2cmp` is `medium` in GitHub's alert and
   `high` in `npm audit`. Nothing breaks — `qualify()` reads severity from the audit report by design
   — but do NOT "improve" Part 2 by switching to the alerts API.
3. **Three bumps fail the gate for real reasons**, one of them (`#444`) a *production* group. `#441`
   is split out as issue #446 (TypeScript removed `moduleResolution=node10`). None of them blocks
   Part 2.

---

# Part 2 — qualification, label only

Branch `worktree-435-qualify`, worktree `/home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-435-qualify`.

This part decides but never acts. Auto-merge is armed in Part 4, after the verdicts have been watched against real traffic.

### Task 1: `qualify()` — the verdict

**Files:**
- Create: `scripts/autodeploy/qualify.ts`
- Test: `scripts/autodeploy/qualify.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `qualify(params) → Verdict`, `HOLD_HOURS`, and the types `Severity`, `AuditReport`, `Verdict`. Part 2 Task 3 (`qualify-cli.ts`) calls it.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { qualify, HOLD_HOURS, type AuditReport } from './qualify';

const NOW = new Date('2026-08-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const report = (v: Record<string, 'low' | 'moderate' | 'high' | 'critical'>): AuditReport => ({
  vulnerabilities: Object.fromEntries(Object.entries(v).map(([k, s]) => [k, { severity: s }])),
});

describe('qualify', () => {
  it('refuses when the base has no production advisory at all', () => {
    const r = qualify({ base: report({}), head: report({}), publishedAt: hoursAgo(999), now: NOW });
    expect(r.verdict).toBe('manual');
    expect(r.reason).toMatch(/no high or critical/i);
  });

  it('refuses when the base is vulnerable only below the threshold', () => {
    const r = qualify({
      base: report({ postcss: 'moderate' }), head: report({}),
      publishedAt: hoursAgo(999), now: NOW,
    });
    expect(r.verdict).toBe('manual');
  });

  it('refuses when the head is still vulnerable', () => {
    const r = qualify({
      base: report({ undici: 'high' }), head: report({ undici: 'high' }),
      publishedAt: hoursAgo(999), now: NOW,
    });
    expect(r.verdict).toBe('manual');
    expect(r.reason).toMatch(/still/i);
  });

  it('deploys a critical immediately, with no hold', () => {
    const r = qualify({
      base: report({ undici: 'critical' }), head: report({}),
      publishedAt: hoursAgo(0), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });

  it('holds a high whose fix is younger than the hold', () => {
    const r = qualify({
      base: report({ undici: 'high' }), head: report({}),
      publishedAt: hoursAgo(HOLD_HOURS - 1), now: NOW,
    });
    expect(r.verdict).toBe('hold');
    expect(r.reason).toMatch(/48/);
  });

  it('deploys a high whose fix has aged past the hold', () => {
    const r = qualify({
      base: report({ undici: 'high' }), head: report({}),
      publishedAt: hoursAgo(HOLD_HOURS + 1), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });

  it('takes the highest base severity, so one critical lifts the hold off a mixed batch', () => {
    const r = qualify({
      base: report({ undici: 'high', hono: 'critical' }), head: report({}),
      publishedAt: hoursAgo(1), now: NOW,
    });
    expect(r.verdict).toBe('autodeploy');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/qualify.test.ts`
Expected: FAIL — `Cannot find module './qualify'`.

- [ ] **Step 3: Implement**

```ts
/**
 * #435 — the qualification verdict for a Dependabot pull request.
 *
 * Everything here is measured from two `npm audit --omit=dev --json` reports,
 * never from Dependabot metadata: `dependency-type` cannot tell production from
 * development for TRANSITIVE packages, and both advisories open when this was
 * written were transitive. A metadata rule would have been wrong on 100% of the
 * available evidence.
 *
 * Pure by design — the workflow does the fetching, so every branch is testable.
 */

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

/** The shape we consume from `npm audit --json` (`.vulnerabilities`). */
export interface AuditReport {
  vulnerabilities: Record<string, { severity: Severity }>;
}

export type Verdict =
  | { verdict: 'autodeploy'; reason: string }
  | { verdict: 'hold'; reason: string }
  | { verdict: 'manual'; reason: string };

/** How long a `high` fix must have been published before it may deploy unattended. */
export const HOLD_HOURS = 48;

const ACTIONABLE: Severity[] = ['high', 'critical'];

function actionable(r: AuditReport): { name: string; severity: Severity }[] {
  return Object.entries(r.vulnerabilities)
    .filter(([, v]) => ACTIONABLE.includes(v.severity))
    .map(([name, v]) => ({ name, severity: v.severity }));
}

export function qualify(params: {
  base: AuditReport;
  head: AuditReport;
  /** Publish time of the YOUNGEST fixing version in this PR. */
  publishedAt: Date;
  now: Date;
}): Verdict {
  const { base, head, publishedAt, now } = params;

  const before = actionable(base);
  if (before.length === 0) {
    return { verdict: 'manual', reason: 'base has no high or critical production advisory' };
  }

  const after = actionable(head);
  if (after.length > 0) {
    const names = after.map((v) => v.name).join(', ');
    return { verdict: 'manual', reason: `head is still vulnerable: ${names}` };
  }

  // Severity comes from the base report — already in hand, one artifact, no
  // second source to disagree with. Highest wins.
  const critical = before.some((v) => v.severity === 'critical');
  const fixed = before.map((v) => v.name).join(', ');

  if (critical) {
    return { verdict: 'autodeploy', reason: `critical production advisory cleared: ${fixed}` };
  }

  const ageHours = (now.getTime() - publishedAt.getTime()) / 3600_000;
  if (ageHours < HOLD_HOURS) {
    const left = Math.ceil(HOLD_HOURS - ageHours);
    return {
      verdict: 'hold',
      reason: `high advisory cleared (${fixed}) but the fixing version is ${Math.floor(ageHours)}h old; ${HOLD_HOURS}h hold, ~${left}h left`,
    };
  }

  return { verdict: 'autodeploy', reason: `high production advisory cleared: ${fixed}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/qualify.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-prove the hold**

Delete the `if (ageHours < HOLD_HOURS)` block and re-run. Expected: the "holds a high whose fix is younger" test goes RED and nothing else changes. Restore it.

Then delete the `if (after.length > 0)` block and re-run. Expected: "refuses when the head is still vulnerable" goes RED. Restore it.

If either mutation leaves the suite green, the test is vacuous — fix the test, not the code.

- [ ] **Step 6: Commit**

```bash
git add scripts/autodeploy/qualify.ts scripts/autodeploy/qualify.test.ts
git commit -m "$(cat <<'EOF'
feat(#435): qualify() decides from measured audit reports, not metadata

dependency-type cannot separate production from development for transitive
packages, and both advisories open when this was written were transitive —
so the rule is the audit diff: vulnerable on base, clean on head. critical
deploys at once; high waits out a 48h hold because Dependabot's own cooldown
does not apply to security updates.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 2: `manifestScope()` — the caret policy, enforced

**Files:**
- Create: `scripts/autodeploy/manifest-scope.ts`
- Test: `scripts/autodeploy/manifest-scope.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `manifestScope(params) → { ok: boolean; violations: string[] }` and `ALLOWED_PATHS`. Part 2 Task 3 calls it.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { manifestScope } from './manifest-scope';

const deps = (d: Record<string, string>) => d;

describe('manifestScope', () => {
  it('accepts a bump that moves only the numbers under a caret', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '^7.29.0' }),
    });
    expect(r).toEqual({ ok: true, violations: [] });
  });

  it('rejects a changed range operator even when the version moved forward', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '~7.29.0' }),
    });
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/undici.*\^.*~/);
  });

  it('rejects a pin that drops the range operator entirely', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '7.29.0' }),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects a path outside the two allowed files', () => {
    const r = manifestScope({
      changedPaths: ['package.json', 'package-lock.json', 'src/index.ts'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '^7.29.0' }),
    });
    expect(r.ok).toBe(false);
    expect(r.violations.join(' ')).toMatch(/src\/index\.ts/);
  });

  it('rejects an extension lockfile, which is not deployed to the server', () => {
    const r = manifestScope({
      changedPaths: ['extension/package-lock.json'],
      base: deps({}),
      head: deps({}),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an added or removed direct dependency', () => {
    const added = manifestScope({
      changedPaths: ['package.json'],
      base: deps({ undici: '^7.28.0' }),
      head: deps({ undici: '^7.29.0', 'left-pad': '^1.0.0' }),
    });
    expect(added.ok).toBe(false);
    expect(added.violations.join(' ')).toMatch(/left-pad/);

    const removed = manifestScope({
      changedPaths: ['package.json'],
      base: deps({ undici: '^7.28.0', hono: '^4.12.26' }),
      head: deps({ undici: '^7.29.0' }),
    });
    expect(removed.ok).toBe(false);
    expect(removed.violations.join(' ')).toMatch(/hono/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/manifest-scope.test.ts`
Expected: FAIL — `Cannot find module './manifest-scope'`.

- [ ] **Step 3: Implement**

```ts
/**
 * #435 — the manifest-scope check.
 *
 * Two rules: the pull request touches only the root manifest and lockfile, and
 * every dependency keeps the range OPERATOR it had. The caret policy comes from
 * the #411 design ("preserve the repository's existing caret-range policy"),
 * where it lived only as a sentence somebody had to remember.
 *
 * This is also the check one would reach for an LLM to eyeball, which is exactly
 * why it is code: it must fail the same way every time.
 */

/** The only paths an unattended deploy may carry. Not `extension/**` — the extension never ships to the server. */
export const ALLOWED_PATHS = ['package.json', 'package-lock.json'];

/** The leading non-digit run of a semver spec: `^`, `~`, `>=`, or `` for a pin. */
export function rangeOperator(spec: string): string {
  const m = /^[^0-9]*/.exec(spec);
  return m ? m[0].trim() : '';
}

export function manifestScope(params: {
  changedPaths: string[];
  /** Merged `dependencies` + `devDependencies` of the base `package.json`. */
  base: Record<string, string>;
  head: Record<string, string>;
}): { ok: boolean; violations: string[] } {
  const { changedPaths, base, head } = params;
  const violations: string[] = [];

  for (const p of changedPaths) {
    if (!ALLOWED_PATHS.includes(p)) violations.push(`path outside the allowlist: ${p}`);
  }

  for (const name of Object.keys(head)) {
    if (!(name in base)) violations.push(`dependency added: ${name}`);
  }
  for (const name of Object.keys(base)) {
    if (!(name in head)) violations.push(`dependency removed: ${name}`);
  }

  for (const [name, headSpec] of Object.entries(head)) {
    const baseSpec = base[name];
    if (baseSpec === undefined) continue;
    const a = rangeOperator(baseSpec);
    const b = rangeOperator(headSpec);
    if (a !== b) {
      violations.push(`range operator changed for ${name}: "${a || '(pinned)'}" → "${b || '(pinned)'}"`);
    }
  }

  return { ok: violations.length === 0, violations };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/manifest-scope.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-prove the operator check**

Replace the operator comparison with a comparison of the full specs (`if (baseSpec !== headSpec)`) and re-run. Expected: the accepting test ("moves only the numbers") goes RED, proving the test distinguishes an operator change from any change. Restore.

Then widen `ALLOWED_PATHS` to include `'src/index.ts'` and re-run. Expected: the path test goes RED. Restore.

- [ ] **Step 6: Commit**

```bash
git add scripts/autodeploy/manifest-scope.ts scripts/autodeploy/manifest-scope.test.ts
git commit -m "$(cat <<'EOF'
feat(#435): manifestScope() enforces the two-file scope and the caret policy

#411's design asked that the caret-range policy be preserved; until now that
was a sentence somebody had to remember. It is the check one would otherwise
ask an LLM to eyeball, which is the reason it is written as a tested function.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 3: `qualify-cli.ts` — the thin I/O wrapper

**Files:**
- Create: `scripts/autodeploy/qualify-cli.ts`

**Interfaces:**
- Consumes: `qualify()` from Task 1, `manifestScope()` from Task 2.
- Produces: a CLI that prints `verdict=<autodeploy|hold|manual>` and `reason=<text>` to `$GITHUB_OUTPUT`. Part 2 Task 4's workflow reads those outputs.

- [ ] **Step 1: Implement**

All I/O lives here so the deciding functions stay pure. It reads files that the workflow has already extracted as data — it never checks out or executes pull-request code.

```ts
/**
 * #435 — I/O wrapper around qualify() and manifestScope().
 *
 * Usage: tsx scripts/autodeploy/qualify-cli.ts <baseDir> <headDir> <changedPathsFile>
 *
 * <baseDir> and <headDir> each hold a package.json, a package-lock.json and an
 * audit.json produced by `npm audit --omit=dev --json`. The workflow extracts
 * them with `git show`; nothing here installs anything, so no package's install
 * scripts ever run.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { qualify, type AuditReport } from './qualify';
import { manifestScope } from './manifest-scope';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function auditReport(dir: string): AuditReport {
  // `npm audit --json` exits non-zero when it finds anything, so the workflow
  // captures stdout regardless; an empty file means "clean".
  const raw = readFileSync(join(dir, 'audit.json'), 'utf8').trim();
  if (raw === '') return { vulnerabilities: {} };
  const parsed = JSON.parse(raw) as { vulnerabilities?: AuditReport['vulnerabilities'] };
  return { vulnerabilities: parsed.vulnerabilities ?? {} };
}

function directDeps(dir: string): Record<string, string> {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(dir, 'package.json'),
  );
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

/** Resolved version of a package in a v3 lockfile, or null if it is absent. */
function resolvedVersion(dir: string, name: string): string | null {
  const lock = readJson<{ packages?: Record<string, { version?: string }> }>(join(dir, 'package-lock.json'));
  return lock.packages?.[`node_modules/${name}`]?.version ?? null;
}

async function publishedAt(name: string, version: string): Promise<Date | null> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  const meta = (await res.json()) as { time?: Record<string, string> };
  const t = meta.time?.[version];
  return t ? new Date(t) : null;
}

async function main(): Promise<void> {
  const [baseDir, headDir, changedPathsFile] = process.argv.slice(2);
  if (!baseDir || !headDir || !changedPathsFile) {
    throw new Error('usage: qualify-cli.ts <baseDir> <headDir> <changedPathsFile>');
  }

  const changedPaths = readFileSync(changedPathsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const scope = manifestScope({
    changedPaths,
    base: directDeps(baseDir),
    head: directDeps(headDir),
  });

  let verdict: string;
  let reason: string;

  if (!scope.ok) {
    verdict = 'manual';
    reason = `manifest scope: ${scope.violations.join('; ')}`;
  } else {
    const base = auditReport(baseDir);
    const head = auditReport(headDir);

    // The hold is only as strong as its YOUNGEST component, so take the max
    // publish time across every package the base reported as vulnerable.
    let youngest: Date | null = null;
    for (const name of Object.keys(base.vulnerabilities)) {
      const version = resolvedVersion(headDir, name);
      if (!version) continue;
      const when = await publishedAt(name, version);
      if (when && (youngest === null || when > youngest)) youngest = when;
    }

    const result = qualify({
      base,
      head,
      // Unknown publish time must never shorten the hold: treat it as just published.
      publishedAt: youngest ?? new Date(),
      now: new Date(),
    });
    verdict = result.verdict;
    reason = result.reason;
  }

  console.log(`verdict=${verdict}`);
  console.log(`reason=${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\nreason=${reason}\n`);
  }
}

main().catch((err) => {
  console.error(`::error::qualify-cli failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test it against the current repository state**

This proves the wiring on real data. The repository's production audit is currently clean, so the expected verdict is `manual`.

```bash
mkdir -p /tmp/q/base /tmp/q/head
cp package.json package-lock.json /tmp/q/base/
cp package.json package-lock.json /tmp/q/head/
(cd /tmp/q/base && npm audit --omit=dev --json > audit.json || true)
(cd /tmp/q/head && npm audit --omit=dev --json > audit.json || true)
printf 'package.json\npackage-lock.json\n' > /tmp/q/changed.txt
npx tsx scripts/autodeploy/qualify-cli.ts /tmp/q/base /tmp/q/head /tmp/q/changed.txt
```
Expected: `verdict=manual` and `reason=base has no high or critical production advisory`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.scripts.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/autodeploy/qualify-cli.ts
git commit -m "$(cat <<'EOF'
feat(#435): qualify-cli reads the data the workflow extracted

All I/O lives here so qualify() and manifestScope() stay pure and testable.
An unknown npm publish time is treated as "just published", so a registry
hiccup can only lengthen the hold, never shorten it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 4: `dependabot-qualify.yml` — label only

**Files:**
- Create: `.github/workflows/dependabot-qualify.yml`

**Interfaces:**
- Consumes: `qualify-cli.ts` outputs `verdict` and `reason`.
- Produces: labels `autodeploy`, `autodeploy-pending`, `deps-manual`. Part 4 Task 1 reads the `autodeploy` label; Part 4 Task 2 adds auto-merge to this same workflow.

- [ ] **Step 1: Create the three labels**

```bash
gh label create autodeploy         --color 0E8A16 --description "#435: qualified for unattended deploy"
gh label create autodeploy-pending --color FBCA04 --description "#435: qualified but inside the 48h hold"
gh label create deps-manual        --color D93F0B --description "#435: dependency PR needing human hands"
```

- [ ] **Step 2: Write the workflow**

Note the deliberate shape, which is the whole security argument in YAML form: `actions/checkout` takes `ref: main`, so every line of tooling that runs comes from the default branch. The pull request contributes two files, fetched as data. `npm audit` reads a lockfile without installing, so no package's install scripts execute.

```yaml
name: Qualify Dependabot PR

on:
  pull_request:
  schedule:
    # Re-evaluates open `autodeploy-pending` PRs so a `high` promotes itself
    # when its fixing version ages past the hold. Runs from main with a full
    # token and is unreachable from any pull request.
    - cron: '17 * * * *'

# Dependabot-triggered runs get a read-only token by default; the `permissions`
# key is the documented way to raise it. GitHub still caps FORK pull requests at
# read-only regardless of what is written here, so the fork case is powerless
# without us reasoning about it.
permissions:
  contents: read
  pull-requests: write

jobs:
  qualify:
    runs-on: ubuntu-latest
    if: >-
      github.event_name == 'schedule' ||
      (github.event.pull_request.user.login == 'dependabot[bot]' &&
       github.event.pull_request.head.repo.full_name == github.repository)
    steps:
      # Tooling comes from main. NEVER check out the pull request here — this
      # job holds a write token.
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Collect the pull requests to evaluate
        id: prs
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            echo "${{ github.event.pull_request.number }}" > prs.txt
          else
            gh pr list --author 'app/dependabot' --state open --json number \
              --jq '.[].number' > prs.txt
          fi
          echo "count=$(wc -l < prs.txt)" >> "$GITHUB_OUTPUT"
          cat prs.txt

      - name: Qualify each pull request
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -uo pipefail
          # NOT `set -e`: one pull request must never abort the others. The
          # `schedule` run evaluates every open Dependabot PR, and qualify-cli
          # deliberately THROWS on a malformed audit report (an absent report
          # must be an error, never a pass) — so a transient registry failure on
          # one PR would otherwise kill the qualification of all the rest.
          failed=0

          qualify_one() {
            local pr=$1 base_ref out verdict reason label

            base_ref=$(gh pr view "$pr" --json baseRefName --jq .baseRefName) || return 1

            # pull/N/head works for any PR without needing the branch name, and
            # the checkout above fetched only `main`.
            git fetch -q origin "pull/${pr}/head" "$base_ref" || return 1

            rm -rf /tmp/q && mkdir -p /tmp/q/base /tmp/q/head

            # Data only — NEVER a checkout. This job holds a write token.
            for f in package.json package-lock.json; do
              git show "origin/${base_ref}:${f}" > "/tmp/q/base/${f}" || return 1
              git show "FETCH_HEAD:${f}"         > "/tmp/q/head/${f}" || return 1
            done
            git diff --name-only "origin/${base_ref}" FETCH_HEAD > /tmp/q/changed.txt || return 1

            # `npm audit` exits non-zero when it FINDS something, so `|| true` is
            # required — but stderr is deliberately NOT silenced: after the C1 fix
            # a malformed report stops the run, and the reason must be readable.
            (cd /tmp/q/base && npm audit --omit=dev --json > audit.json || true)
            (cd /tmp/q/head && npm audit --omit=dev --json > audit.json || true)

            # `env -u GITHUB_OUTPUT`: the CLI appends its verdict there, which is
            # meaningless in a loop over N pull requests — the loop reads stdout.
            out=$(env -u GITHUB_OUTPUT npx tsx scripts/autodeploy/qualify-cli.ts \
                    /tmp/q/base /tmp/q/head /tmp/q/changed.txt) || return 1
            verdict=$(printf '%s\n' "$out" | sed -n 's/^verdict=//p')
            reason=$(printf '%s\n' "$out" | sed -n 's/^reason=//p')

            case "$verdict" in
              autodeploy) label=autodeploy ;;
              hold)       label=autodeploy-pending ;;
              manual)     label=deps-manual ;;
              # An unrecognised verdict is a bug in our own tooling, not a
              # judgement about the PR. Fail closed and say so.
              *)          echo "::error::unrecognised verdict '${verdict}' for PR #${pr}"; return 1 ;;
            esac

            gh pr edit "$pr" \
              --remove-label autodeploy \
              --remove-label autodeploy-pending \
              --remove-label deps-manual >/dev/null 2>&1 || true
            gh pr edit "$pr" --add-label "$label" || return 1

            echo "PR #${pr}: ${label} — ${reason}" >> "$GITHUB_STEP_SUMMARY"
          }

          while read -r pr; do
            [ -n "$pr" ] || continue
            if ! qualify_one "$pr"; then
              failed=1
              echo "::warning::qualification failed for PR #${pr}"
              echo "PR #${pr}: **qualification FAILED** — see the log" >> "$GITHUB_STEP_SUMMARY"
            fi
          done < prs.txt

          # A failure is reported, but only after every other PR has been given
          # its verdict.
          exit "$failed"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/dependabot-qualify.yml
git commit -m "$(cat <<'EOF'
feat(#435): qualify Dependabot PRs — label only, no merging yet

Checks out main and takes the PR's manifest and lockfile as data, so no job
holding a write token ever executes pull-request code. npm audit reads a
lockfile without installing, so no install scripts run either.

Auto-merge is deliberately absent: the verdicts get watched against real
traffic first (gate 2). Arming comes in part 4.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

## Gate 2 — watch the verdicts before arming anything

- [ ] Every open Dependabot pull request carries exactly one of the three labels.
- [ ] The four development-stream advisories are labelled `deps-manual`, with reason `base has no high or critical production advisory`. **If any of them is labelled `autodeploy`, stop** — the dev/prod split is broken and Part 4 must not be built on it.
- [ ] The hourly `schedule` run has fired at least once and re-labelled without error.
- [ ] Confirm no pull request merged by itself.

---

# Part 3 — the host deployer, disarmed

Branch `worktree-435-autodeploy`, worktree `/home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-435-autodeploy`.

Everything here is installed but inert: the timer is not enabled until Part 4.

### Task 1: the guard — hermetic git logic

**Files:**
- Create: `deploy/autodeploy-guard.sh`
- Test: `scripts/autodeploy/guard.test.ts`

**Why the test lives under `scripts/`:** `vitest.config.ts` declares
`include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']`. A test placed in `tests/` (which holds only
`fixtures/`) would never be collected — green and vacuous. Do not "fix" this by widening the include.

**Interfaces:**
- Consumes: nothing.
- Produces: `deploy/autodeploy-guard.sh <repo_dir> <deployed_sha> <target_ref> <main_ref>` — exit `0` accept (prints `ACCEPT`), exit `1` refuse (prints `REFUSE: …`). Part 3 Task 2's `autodeploy.sh` calls it with `origin/main` as `<main_ref>`.

The main ref is a parameter rather than hardcoded `origin/main` precisely so the test can drive it with a local branch and stay hermetic — no network, no remote.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(__dirname, '../../deploy/autodeploy-guard.sh');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function guard(repo: string, deployed: string, target: string, mainRef: string) {
  try {
    const out = execFileSync('bash', [GUARD, repo, deployed, target, mainRef], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
}

describe('autodeploy-guard.sh', () => {
  let repo: string;
  let basec: string;
  let lockOnly: string;
  let withSrc: string;
  let offMain: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'wbb-guard-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');

    basec = commit(repo, {
      'package.json': '{"name":"x","dependencies":{"undici":"^7.28.0"}}',
      'package-lock.json': '{"lockfileVersion":3}',
      'src/index.ts': 'export const a = 1;\n',
    }, 'base');

    lockOnly = commit(repo, {
      'package.json': '{"name":"x","dependencies":{"undici":"^7.29.0"}}',
      'package-lock.json': '{"lockfileVersion":3,"bumped":true}',
    }, 'bump');

    withSrc = commit(repo, { 'src/index.ts': 'export const a = 2;\n' }, 'code change');

    git(repo, 'checkout', '-q', '-b', 'side', basec);
    offMain = commit(repo, { 'package-lock.json': '{"lockfileVersion":3,"evil":true}' }, 'off main');
    git(repo, 'checkout', '-q', 'main');
  });

  it('accepts a lockfile-only diff that is on main', () => {
    const r = guard(repo, basec, lockOnly, 'main');
    expect(r.code).toBe(0);
    expect(r.out).toContain('ACCEPT');
  });

  it('refuses a diff that touches src/', () => {
    const r = guard(repo, basec, withSrc, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toContain('src/index.ts');
  });

  it('refuses a commit that is not an ancestor of main', () => {
    const r = guard(repo, basec, offMain, 'main');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ancestor/i);
  });

  it('accepts an empty diff (nothing to deploy is not a violation)', () => {
    const r = guard(repo, lockOnly, lockOnly, 'main');
    expect(r.code).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/autodeploy/guard.test.ts`
Expected: FAIL — the guard script does not exist.

- [ ] **Step 3: Implement the guard**

No `grep` anywhere: on this host `grep` is a ugrep shim that OOMs. `case` matching does the same job with no process.

```bash
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

if ! git -C "$repo" merge-base --is-ancestor "$target" "$main_ref"; then
  echo "REFUSE: $target is not an ancestor of $main_ref — not merged"
  exit 1
fi

# The allowlist. NOT extension/** — the extension never ships to the server.
mapfile -t changed < <(git -C "$repo" diff --name-only "$deployed" "$target")

violations=()
for path in "${changed[@]:-}"; do
  [ -n "$path" ] || continue
  case "$path" in
    package.json|package-lock.json) ;;
    *) violations+=("$path") ;;
  esac
done

if [ "${#violations[@]}" -gt 0 ]; then
  echo "REFUSE: ${#violations[@]} path(s) outside the allowlist:"
  printf '  %s\n' "${violations[@]}"
  exit 1
fi

echo "ACCEPT: lockfile-only change, merged into $main_ref"
exit 0
```

- [ ] **Step 4: Make it executable and run the test**

```bash
chmod +x deploy/autodeploy-guard.sh
npx vitest run scripts/autodeploy/guard.test.ts
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-prove the allowlist**

Change the `case` arm to `*)` (accept everything) and re-run. Expected: the `src/` test goes RED. Restore.

Delete the `merge-base --is-ancestor` block and re-run. Expected: the off-main test goes RED. Restore.

- [ ] **Step 6: Commit**

```bash
git add deploy/autodeploy-guard.sh scripts/autodeploy/guard.test.ts
git commit -m "$(cat <<'EOF'
feat(#435): the host-side guard, and its hermetic test

The tag is a signal, not a permission, so the host re-derives the decision:
the commit must be an ancestor of main and the diff must touch nothing but
the root manifest and lockfile. Our own code therefore cannot reach prod
down the automated path.

The main ref is a parameter so the test can drive it with a local branch —
no network, no remote. No grep: it is a ugrep shim on this host and OOMs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 2: `autodeploy.sh` — fetch, verify, deploy, verify again

**Files:**
- Create: `deploy/autodeploy.sh`

**Interfaces:**
- Consumes: `deploy/autodeploy-guard.sh` from Task 1; `deploy/deploy.sh` unchanged.
- Produces: exit codes `0` deployed or nothing to do, `1` guard refused, `2` deploy failed and rollback succeeded, `3` rollback failed. Part 3 Task 3's systemd unit runs it.

- [ ] **Step 1: Implement**

```bash
#!/usr/bin/env bash
# #435 — unattended deploy of a qualified dependency fix.
#
# Runs as the operator user (ysi) so it reuses the existing NOPASSWD sudoers
# scope; it requires no new privilege. It NEVER touches the operator's working
# tree at /home/ysi/warsaw-beer-bot — deploy.sh rsyncs `./`, so running from
# there would ship whatever happens to be uncommitted.
set -euo pipefail

REPO_URL=https://github.com/ysilvestrov/warsaw-beer-bot.git
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
REPO="$DATA_DIR/repo"
STATE="$STATE_DIR/state.env"
LOCK="$STATE_DIR/lock"
GUARD_HEALTH_TRIES=30
# The guard comes from the INSTALLED copy, never from the checkout we just
# fetched into: a guard that ships with the commit it is judging is not a guard.
GUARD_BIN="${WBB_GUARD:-/usr/local/bin/wbb-autodeploy-guard}"

mkdir -p "$DATA_DIR" "$STATE_DIR"

# Prevents overlapping autodeploy runs. It does NOT exclude a manual
# ./deploy/deploy.sh, which takes no lock — but a manual deploy means the
# operator is present, which is the case this whole mechanism defers to.
exec 9>"$LOCK"
flock -n 9 || { echo "another autodeploy holds the lock; exiting"; exit 0; }

notify() {
  # Deliberately NOT via the bot: if the deploy took the bot down, the bot
  # cannot report that it is down.
  sudo -u warsaw-beer-bot bash -lc '
    set -a; . /etc/warsaw-beer-bot/.env; set +a
    curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ADMIN_TELEGRAM_ID}" \
      --data-urlencode "text=$1" >/dev/null
  ' _ "$1" || echo "WARNING: notify failed: $1"
}

api_port() {
  sudo -u warsaw-beer-bot bash -lc 'set -a; . /etc/warsaw-beer-bot/.env; set +a; echo "${API_PORT:-3000}"'
}

healthy() {
  local port tries=0 body
  port=$(api_port)
  while [ "$tries" -lt "$GUARD_HEALTH_TRIES" ]; do
    body=$(curl -fsS --max-time 3 "http://127.0.0.1:${port}/health" 2>/dev/null || true)
    case "$body" in *'"ok":true'*) return 0 ;; esac
    tries=$((tries + 1))
    sleep 2
  done
  return 1
}

deploy_commit() {
  git -C "$REPO" checkout -q --detach "$1"
  ( cd "$REPO" && ./deploy/deploy.sh )
}

# --- fetch -------------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  git clone -q "$REPO_URL" "$REPO"
fi
git -C "$REPO" fetch -q --tags --prune origin

tag=$(git -C "$REPO" for-each-ref --sort=-creatordate --format='%(refname:short)' \
        --count=1 'refs/tags/autodeploy-*')
[ -n "$tag" ] || { echo "no autodeploy tag yet"; exit 0; }

target=$(git -C "$REPO" rev-parse "${tag}^{commit}")

# shellcheck disable=SC1090
[ -f "$STATE" ] && . "$STATE"
DEPLOYED_SHA="${DEPLOYED_SHA:-}"

if [ "$target" = "$DEPLOYED_SHA" ]; then
  echo "already deployed $target"
  exit 0
fi

# On a first run we have nothing to diff against, so compare with what is
# actually installed rather than deploying an unbounded diff blind.
if [ -z "$DEPLOYED_SHA" ]; then
  echo "no recorded deployment; refusing to autodeploy an unbounded diff"
  notify "⛔ autodeploy: no recorded baseline yet. Deploy once by hand, then this becomes automatic."
  exit 1
fi

# --- verify ------------------------------------------------------------------
if ! guard_out=$("$GUARD_BIN" "$REPO" "$DEPLOYED_SHA" "$target" origin/main); then
  echo "$guard_out"
  notify "⛔ autodeploy REFUSED for ${tag}:
${guard_out}"
  exit 1
fi
echo "$guard_out"

git -C "$REPO" checkout -q --detach "$target"
if ! ( cd "$REPO" && npm audit --omit=dev --audit-level=high >/dev/null 2>&1 ); then
  notify "⛔ autodeploy REFUSED for ${tag}: npm audit --omit=dev still reports a high or critical advisory after the fix."
  exit 1
fi

# --- deploy ------------------------------------------------------------------
echo "deploying $target ($tag)"
if deploy_commit "$target" && healthy; then
  printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=%s\n' "$target" "$DEPLOYED_SHA" > "$STATE"
  bumped=$(git -C "$REPO" diff --stat "$DEPLOYED_SHA" "$target" -- package.json | tail -1)
  notify "✅ autodeploy ${tag} — production patched and healthy.
${bumped}"
  exit 0
fi

# --- roll back ---------------------------------------------------------------
# Deliberately not clever: one attempt, then stop and wake a human. An
# automation that keeps turning production over unattended after two failures
# is worse than one that stops and says so.
notify "⚠️ autodeploy ${tag} failed to come up healthy — rolling back to ${DEPLOYED_SHA}."
if deploy_commit "$DEPLOYED_SHA" && healthy; then
  notify "↩️ rollback to ${DEPLOYED_SHA} succeeded. ${tag} needs a human."
  exit 2
fi

notify "🔥 ROLLBACK FAILED. Production is DOWN at ${DEPLOYED_SHA}. Manual intervention required."
exit 3
```

- [ ] **Step 2: Shell-check it**

Run: `bash -n deploy/autodeploy.sh && chmod +x deploy/autodeploy.sh`
Expected: no syntax errors.

- [ ] **Step 3: Verify the notifier reaches Telegram, in isolation**

The notifier is the component whose failure hides every other failure, so prove it before trusting it.

```bash
sudo -u warsaw-beer-bot bash -lc '
  set -a; . /etc/warsaw-beer-bot/.env; set +a
  curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${ADMIN_TELEGRAM_ID}" \
    --data-urlencode "text=$1" >/dev/null
' _ "#435 autodeploy notifier test — ignore"
```
Expected: the message arrives in Telegram. If it does not, stop and fix this before continuing.

- [ ] **Step 4: Commit**

```bash
git add deploy/autodeploy.sh
git commit -m "$(cat <<'EOF'
feat(#435): unattended deploy with guard, health check and one rollback

Runs as the operator user so it reuses the existing NOPASSWD sudoers scope —
no new privilege. Uses its own checkout, never the operator's working tree,
because deploy.sh rsyncs `./` and would otherwise ship uncommitted work.

Refuses when there is no recorded baseline: a first run has nothing to diff
against, and an unbounded diff is exactly what the guard exists to prevent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 3: systemd units and the operator documentation

**Files:**
- Create: `deploy/wbb-autodeploy.service`
- Create: `deploy/wbb-autodeploy.timer`
- Modify: `deploy/README.md` (append a section after "Operate")

**Interfaces:**
- Consumes: `deploy/autodeploy.sh` from Task 2.
- Produces: an installed-but-disabled timer. Part 4 Task 3 enables it.

- [ ] **Step 1: Write the service unit**

```ini
[Unit]
Description=#435 unattended deploy of qualified dependency security fixes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=ysi
Environment=HOME=/home/ysi
ExecStart=/usr/local/bin/wbb-autodeploy
# 1 = guard refused, 2 = rolled back — both are reported to Telegram by the
# script itself and are not systemd failures worth restarting.
SuccessExitStatus=0 1 2
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 2: Write the timer unit**

```ini
[Unit]
Description=#435 check for a qualified dependency fix to deploy

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Document the one-time install in `deploy/README.md`**

Append after the "Operate" section:

````markdown
## Unattended security autodeploy (#435)

A timer checks for an `autodeploy-*` tag and deploys it only if the change
touches nothing but the root `package.json` and `package-lock.json`. See
`docs/superpowers/specs/2026-08/2026-08-16-435-dependency-security-autofix-design.md`.

One-time install (as root):

```bash
# The scripts are installed to a fixed path rather than run from the operator's
# working tree: that tree is rsynced wholesale by deploy.sh and may hold
# uncommitted work at any moment.
install -m 0755 deploy/autodeploy.sh       /usr/local/bin/wbb-autodeploy
install -m 0755 deploy/autodeploy-guard.sh /usr/local/bin/wbb-autodeploy-guard
install -m 0644 deploy/wbb-autodeploy.service /etc/systemd/system/wbb-autodeploy.service
install -m 0644 deploy/wbb-autodeploy.timer   /etc/systemd/system/wbb-autodeploy.timer
systemctl daemon-reload
```

Re-run the two `install` lines whenever either script changes — they are copies,
not symlinks, deliberately: the running deployer must not change under a
`git checkout`.

The timer stays **disabled** until the mechanism has been exercised by hand:

```bash
# dry run — the guard refuses anything that is not a lockfile-only change
/usr/local/bin/wbb-autodeploy

# arm it
systemctl enable --now wbb-autodeploy.timer
systemctl list-timers wbb-autodeploy.timer
```

The first run refuses with "no recorded baseline". Seed it with the commit
currently deployed:

```bash
mkdir -p ~/.local/state/wbb-autodeploy
printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=\n' "$(git -C /home/ysi/warsaw-beer-bot rev-parse origin/main)" \
  > ~/.local/state/wbb-autodeploy/state.env
```
````

- [ ] **Step 4: Install the units and verify they are inert**

```bash
sudo install -m 0755 deploy/autodeploy.sh        /usr/local/bin/wbb-autodeploy
sudo install -m 0755 deploy/autodeploy-guard.sh  /usr/local/bin/wbb-autodeploy-guard
sudo install -m 0644 deploy/wbb-autodeploy.service /etc/systemd/system/wbb-autodeploy.service
sudo install -m 0644 deploy/wbb-autodeploy.timer   /etc/systemd/system/wbb-autodeploy.timer
sudo systemctl daemon-reload
systemctl is-enabled wbb-autodeploy.timer || true
```

Note: `install` to `/usr/local/bin` and `/etc/systemd/system` is **not** in the
NOPASSWD sudoers scope, so these four lines will prompt for a password. That is
correct — they are one-time host setup, not routine ops, and widening `sudoers`
for them is explicitly forbidden by the Global Constraints.
Expected: `disabled`. If it reports `enabled`, disable it — Part 3 must ship inert.

- [ ] **Step 5: Commit**

```bash
git add deploy/wbb-autodeploy.service deploy/wbb-autodeploy.timer deploy/README.md
git commit -m "$(cat <<'EOF'
feat(#435): systemd timer for the autodeploy check, shipped disabled

SuccessExitStatus covers 1 (guard refused) and 2 (rolled back): both are
reported to Telegram by the script and are not systemd failures. The timer
is not enabled here — part 4 arms it, after the mechanism has been exercised.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

## Gate 3 — exercise the mechanism by hand

- [ ] `npx vitest run scripts/autodeploy/guard.test.ts` is green, and both mutations were observed red.
- [ ] The Telegram notifier test message arrived (Task 2 Step 3).
- [ ] `/usr/local/bin/wbb-autodeploy` runs and exits `0` with "no autodeploy tag yet".
- [ ] Seed the state file, push a **throwaway** tag `autodeploy-manualtest` on the current `origin/main`, run the script, and confirm it reports `ACCEPT` and deploys cleanly, ending healthy. Then delete the tag: `git push origin :refs/tags/autodeploy-manualtest`.
- [ ] `systemctl is-enabled wbb-autodeploy.timer` reports `disabled`.

---

# Part 4 — arm it

Branch `worktree-435-arm`, worktree `/home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-435-arm`.

This is the only part that changes what happens without a human.

### Task 1: `autodeploy-tag.yml`

**Files:**
- Create: `.github/workflows/autodeploy-tag.yml`

**Interfaces:**
- Consumes: the `autodeploy` label from Part 2 Task 4.
- Produces: tags matching `autodeploy-*`, which Part 3's `autodeploy.sh` consumes.

- [ ] **Step 1: Write the workflow**

The label match must be exact. A `case` on the whole label list would match `autodeploy-pending` too, and a held `high` would deploy the moment it merged — defeating the hold entirely.

```yaml
name: Tag an autodeploy merge

on:
  push:
    branches: [main]

permissions:
  contents: write
  pull-requests: read

jobs:
  tag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Tag when the merged PR carried the autodeploy label
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          # Exact match only: `autodeploy-pending` must NOT qualify, or a held
          # `high` would deploy the instant it merged.
          match=$(gh api "repos/${{ github.repository }}/commits/${{ github.sha }}/pulls" \
                    --jq '[.[] | .labels[] | select(.name == "autodeploy")] | length')
          if [ "$match" -eq 0 ]; then
            echo "not an autodeploy merge; nothing to tag"
            exit 0
          fi
          tag="autodeploy-$(date -u +%Y%m%dT%H%M%SZ)"
          git tag "$tag" "${{ github.sha }}"
          git push origin "$tag"
          echo "tagged ${{ github.sha }} as $tag" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/autodeploy-tag.yml
git commit -m "$(cat <<'EOF'
feat(#435): tag a merged autodeploy PR for the host timer to find

Exact label match — a substring match would also catch autodeploy-pending
and a held `high` would deploy the instant it merged, defeating the hold.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 2: arm auto-merge

**Files:**
- Modify: `.github/workflows/dependabot-qualify.yml` (the "Qualify each pull request" step)

**Interfaces:**
- Consumes: the `verdict` computed in Part 2 Task 4.
- Produces: merged pull requests, which Task 1 tags.

- [ ] **Step 1: Enable auto-merge on the repository**

**Already done 2026-08-16** while landing the first batch of Dependabot pull requests. Verify only:

```bash
gh api repos/ysilvestrov/warsaw-beer-bot --jq '.allow_auto_merge'   # expect: true
```

- [ ] **Step 2: Add the arming block**

Immediately after the `gh pr edit "$pr" --add-label "$label"` line, add:

```bash
            # Auto-merge waits for the required `ci` check; it does not bypass it.
            if [ "$verdict" = "autodeploy" ]; then
              gh pr merge "$pr" --auto --squash
              echo "  auto-merge armed" >> "$GITHUB_STEP_SUMMARY"

              # Branch protection sets strict=true, and auto-merge does NOT update a
              # stale branch — it only waits. Every merge makes every other open PR
              # stale, so a queue of them livelocks. MEASURED 2026-08-16: two green
              # PRs with auto-merge armed sat in BEHIND and did not move until the
              # branch was updated by hand. Without this, a qualified `critical` fix
              # can wait forever inside a mechanism built so that it would not wait.
              #
              # No loop and no sleep: update-branch pushes a commit, which re-runs
              # `ci`, which re-triggers this workflow. The hourly schedule is the
              # backstop if that chain ever breaks.
              if [ "$(gh pr view "$pr" --json mergeStateStatus --jq .mergeStateStatus)" = "BEHIND" ]; then
                gh pr update-branch "$pr" || true
                echo "  branch was BEHIND — updated" >> "$GITHUB_STEP_SUMMARY"
              fi
            fi
```

Note this is inside the `autodeploy` branch deliberately. A `hold` verdict has no auto-merge to
un-stall, and rebasing a pull request that is not going to merge yet only burns CI.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/dependabot-qualify.yml
git commit -m "$(cat <<'EOF'
feat(#435): arm auto-merge for qualified pull requests

Auto-merge waits on the required `ci` check rather than bypassing it, so a
red test suite still stops the whole chain.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

### Task 3: enable the timer

**Files:** none — host state.

- [ ] **Step 1: Seed the baseline state file**

```bash
mkdir -p ~/.local/state/wbb-autodeploy
printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=\n' \
  "$(git -C /home/ysi/warsaw-beer-bot rev-parse origin/main)" \
  > ~/.local/state/wbb-autodeploy/state.env
cat ~/.local/state/wbb-autodeploy/state.env
```

- [ ] **Step 2: Enable**

```bash
sudo systemctl enable --now wbb-autodeploy.timer
systemctl list-timers wbb-autodeploy.timer --no-pager
```
Expected: the timer is listed with a next elapse within 5 minutes.

- [ ] **Step 3: Watch one cycle**

```bash
journalctl -u wbb-autodeploy.service -n 30 --no-pager
```
Expected: `already deployed <sha>` or `no autodeploy tag yet`. Any other output means stop and read it.

## Gate 4 — the first real customer

- [ ] A runtime-scope `high` or `critical` advisory has travelled the whole path: alert → PR → `ci` green → label `autodeploy` → merge → tag → timer → restart → Telegram confirmation.
- [ ] The Telegram message arrived and `systemctl is-active warsaw-beer-bot` reports `active`.
- [ ] `npm audit --omit=dev` on the host reports 0.

Until such an advisory appears, the system is armed and idle. That is the correct state — do not manufacture a fake advisory to exercise it.

---

# Part 5 — the independent audit

Branch `worktree-435-prod-audit`, worktree `/home/ysi/warsaw-beer-bot/.claude/worktrees/worktree-435-prod-audit`.

Depends only on Part 1. May be done at any point after it.

### Task 1: `prod-audit.yml`

**Files:**
- Create: `.github/workflows/prod-audit.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: a GitHub issue titled `Production dependency advisory` when production is vulnerable.

- [ ] **Step 1: Write the workflow**

This exists because Dependabot **cannot always act**: when a transitive advisory needs a parent package bumped, it opens no pull request at all, and silence is indistinguishable from safety.

```yaml
name: Production dependency audit

on:
  schedule:
    - cron: '40 5 * * *'
  workflow_dispatch:

permissions:
  contents: read
  issues: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Audit production dependencies
        id: audit
        run: |
          set -uo pipefail
          # No install: `npm audit` reads the lockfile, so no install scripts run.
          if npm audit --omit=dev --audit-level=high > audit.txt 2>&1; then
            echo "vulnerable=false" >> "$GITHUB_OUTPUT"
          else
            echo "vulnerable=true" >> "$GITHUB_OUTPUT"
          fi
          cat audit.txt

      - name: Open or update the issue
        if: steps.audit.outputs.vulnerable == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          title="Production dependency advisory"
          body=$'`npm audit --omit=dev --audit-level=high` is failing on `main`.\n\n```\n'"$(cat audit.txt)"$'\n```\n\nIf no Dependabot pull request exists for this, the fix needs a parent package bumped by hand — see #435.'
          existing=$(gh issue list --state open --search "$title in:title" --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            gh issue comment "$existing" --body "$body"
          else
            gh issue create --title "$title" --label orphan-triage --body "$body" || \
              gh issue create --title "$title" --body "$body"
          fi

      - name: Close the issue when production is clean
        if: steps.audit.outputs.vulnerable == 'false'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          existing=$(gh issue list --state open --search "Production dependency advisory in:title" --json number --jq '.[0].number // empty')
          if [ -n "$existing" ]; then
            gh issue close "$existing" --comment "npm audit --omit=dev --audit-level=high is clean again."
          fi
```

- [ ] **Step 2: Run it once by hand**

```bash
gh workflow run prod-audit.yml
sleep 45 && gh run list --workflow=prod-audit.yml --limit 1
```
Expected: success, and no issue opened — production audit is currently clean.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/prod-audit.yml
git commit -m "$(cat <<'EOF'
feat(#435): daily production audit, independent of Dependabot

Dependabot opens no PR when a transitive advisory needs a parent package
bumped, and silence then looks exactly like safety. This makes the system's
knowledge of production independent of whether Dependabot managed to act.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Wq4mzyfGiYhaVtBqpqbvXp
EOF
)"
```

---

## Documentation checks before each PR merges

- [ ] `spec.md` — reviewed for whether this changes it. This work adds no bot behaviour, no command, and no API surface, so the expected answer is **no change**; say so explicitly in the PR rather than leaving it unstated.
- [ ] `docs/extension-install-uk.md` — not applicable; nothing under `extension/**` changes in any part.
- [ ] `deploy/README.md` — updated in Part 3 Task 3.
- [ ] `./tmp/` — cleared when the whole task is done.
