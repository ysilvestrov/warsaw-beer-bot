# Merge-deploy — periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything around the merge-deploy core: the PR-side hold check, operability fixes the core review deferred, removal of the #435 tag path, and the documentation and rules that make `[deploy:hold]` a practice rather than a feature.

**Architecture:** The core (`deploy/autodeploy.sh`, `db-snapshot.sh`, `trial-migrate.cjs`) is done and reviewed twice on branch `feat/merge-deploy`. This plan adds a TypeScript hold check run by a new workflow, and pins it to the deployer's own bash predicate by a parity test. It teaches the tick to report a lock held too long, makes `deploy.sh` refuse root, deletes the tag machinery, and writes the docs.

**Tech Stack:** bash 5.2, TypeScript + tsx, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`. The sections "Holds", "What is deleted", "`spec.md` and docs" and "Amendments after the core review" (the "Deferred to the periphery" bullet) are this plan's requirements. The core plan is `2026-09-30-merge-deploy-core.md`.

## Global Constraints

- The code beats this plan: where the plan disagrees with a file, the file wins, and the report says so.
- Every task ends with the FULL gate `npm test && npm run typecheck`, never a scoped run.
- CLAUDE.md test rules: exact asserts, no conditional logic in tests, no tautologies, boundaries and failures covered, and each task mutation-checks its central line (delete it, name the test that goes red, restore it).
- Hold label is exactly `deploy:hold`. The title marker is exactly `[deploy:hold]` at the **start** of the title.
- The hold path set is the one in `path_is_held()` in `deploy/autodeploy.sh`. Any second copy of it must be pinned to it by a test.
- The ⏸ hold message links the PR and does not quote its body (decided 2026-09-30; the spec's notification table is corrected in Task 4).
- `read-env.sh` exiting 0 on an unreadable `.env` is NOT fixed here. It becomes its own issue (Rollout step 7).

---

### Task 1: the PR-side `deploy-hold` check

**Files:**
- Create: `scripts/autodeploy/deploy-hold-check.ts`
- Create: `scripts/autodeploy/deploy-hold-check.test.ts`
- Create: `.github/workflows/deploy-hold.yml`
- Modify: `deploy/autodeploy.sh` (drop `deploy/autodeploy-guard.sh` from `path_is_held`; Task 3 deletes the file)

**Interfaces:**
- Produces: `isHoldPath(path: string): boolean`, `checkHold(i: { title: string; labels: string[]; paths: string[] }): { ok: boolean; held: string[]; problems: string[] }`, and a CLI that reads `PR_TITLE`, `PR_LABELS` (a JSON array of names) and the changed paths on stdin, then exits 1 on any problem.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isHoldPath, checkHold } from './deploy-hold-check';

const AUTODEPLOY = resolve(__dirname, '../../deploy/autodeploy.sh');
const CLI = resolve(__dirname, 'deploy-hold-check.ts');

const TABLE: Array<[string, boolean]> = [
  ['deploy/sudoers.d/warsaw-beer-bot', true],
  ['deploy/litestream.yml', true],
  ['deploy/litestream.service', true],
  ['deploy/wbb-autodeploy.service', true],
  ['deploy/wbb-autodeploy.timer', true],
  ['deploy/install-autodeploy.sh', true],
  ['deploy/install-resource-monitor.sh', true],
  ['deploy/rsync-filter', true],
  ['deploy/autodeploy.sh', true],
  ['deploy/ships.sh', true],
  ['deploy/read-env.sh', true],
  ['deploy/installed-current.sh', true],
  ['deploy/db-snapshot.sh', true],
  ['deploy/trial-migrate.cjs', true],
  ['deploy/warsaw-beer-bot.service', false],
  ['deploy/deploy.sh', false],
  ['deploy/record-deployed.sh', false],
  ['deploy/README.md', false],
  ['src/index.ts', false],
  ['docs/x.md', false],
];

describe('isHoldPath', () => {
  it.each(TABLE)('%s → %s', (path, held) => {
    expect(isHoldPath(path)).toBe(held);
  });

  // The deployer's bash predicate is the authority; this copy exists only so
  // the merger sees the hold before pressing the button. Two lists that drift
  // apart make the title lie, so every row is asked of both.
  it.each(TABLE)('agrees with path_is_held in deploy/autodeploy.sh for %s', (path) => {
    const fn = execFileSync('sed', ['-n', '/^path_is_held() {/,/^}/p', AUTODEPLOY], { encoding: 'utf8' });
    const verdict = spawnSync('bash', ['-c', `${fn}\npath_is_held "$1" && echo HOLD || echo PASS`, '_', path],
      { encoding: 'utf8' }).stdout.trim();
    expect(verdict).toBe(isHoldPath(path) ? 'HOLD' : 'PASS');
  });
});

describe('checkHold', () => {
  it('passes an ordinary PR', () => {
    expect(checkHold({ title: 'feat: x', labels: [], paths: ['src/a.ts'] }))
      .toEqual({ ok: true, held: [], problems: [] });
  });

  it('passes a marked and labelled PR that touches a hold path', () => {
    expect(checkHold({ title: '[deploy:hold] fix(deploy): x', labels: ['deploy:hold'], paths: ['deploy/rsync-filter'] }))
      .toEqual({ ok: true, held: ['deploy/rsync-filter'], problems: [] });
  });

  it('fails a hold path without the title marker, naming the paths', () => {
    const r = checkHold({ title: 'fix(deploy): x', labels: ['deploy:hold'], paths: ['src/a.ts', 'deploy/sudoers.d/warsaw-beer-bot'] });
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'the title has no [deploy:hold] marker but the label is set',
      'hold paths changed without a [deploy:hold] title: deploy/sudoers.d/warsaw-beer-bot — prefix the title with [deploy:hold], add the deploy:hold label, and list the host steps in the PR body',
    ]);
  });

  it('fails a marker without the label', () => {
    expect(checkHold({ title: '[deploy:hold] x', labels: [], paths: [] }).problems)
      .toEqual(['the title carries [deploy:hold] but the deploy:hold label is missing']);
  });

  it('fails a label without the marker, even when no hold path changed', () => {
    expect(checkHold({ title: 'x', labels: ['deploy:hold'], paths: [] }).problems)
      .toEqual(['the title has no [deploy:hold] marker but the label is set']);
  });

  it('accepts a hold with no hold path (an .env key or a preflight has no path)', () => {
    expect(checkHold({ title: '[deploy:hold] feat: needs NEW_KEY in .env', labels: ['deploy:hold'], paths: ['src/a.ts'] }))
      .toEqual({ ok: true, held: [], problems: [] });
  });

  it('only a marker at the very start counts', () => {
    expect(checkHold({ title: 'fix [deploy:hold] x', labels: ['deploy:hold'], paths: [] }).ok).toBe(false);
  });
});

describe('deploy-hold-check CLI', () => {
  function cli(title: string, labels: string[], paths: string): { code: number | null; out: string } {
    const r = spawnSync('npx', ['tsx', CLI], {
      input: paths, encoding: 'utf8',
      env: { ...process.env, PR_TITLE: title, PR_LABELS: JSON.stringify(labels) },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }

  it('exits 1 and prints the problems', () => {
    const r = cli('fix: x', [], 'deploy/rsync-filter\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('hold paths changed without a [deploy:hold] title: deploy/rsync-filter');
  });

  it('exits 0 for a correctly held PR', () => {
    expect(cli('[deploy:hold] x', ['deploy:hold'], 'deploy/rsync-filter\n').code).toBe(0);
  });

  it('exits 2 when PR_LABELS is not a JSON array of strings', () => {
    const r = spawnSync('npx', ['tsx', CLI], { input: '', encoding: 'utf8', env: { ...process.env, PR_TITLE: 'x', PR_LABELS: 'nope' } });
    expect(r.status).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail** — `npx vitest run scripts/autodeploy/deploy-hold-check.test.ts`. They fail because the module does not exist yet.

- [ ] **Step 3: Implement `scripts/autodeploy/deploy-hold-check.ts`**

```ts
/**
 * Merge-deploy — the PR-side hold check (spec 2026-09-30, "Holds").
 *
 * The deployer on the host decides holds by itself (path_is_held in
 * deploy/autodeploy.sh, plus the deploy:hold label) and does not rely on this.
 * This check exists so that whoever presses merge SEES that the deploy will
 * not be unattended: the title carries [deploy:hold] exactly when the label
 * does, and every PR touching a hold path carries both.
 */
import { readFileSync } from 'node:fs';

export const HOLD_LABEL = 'deploy:hold';
export const HOLD_MARKER = '[deploy:hold]';

const HELD_EXACT = new Set([
  'deploy/rsync-filter',
  'deploy/autodeploy.sh',
  'deploy/ships.sh',
  'deploy/read-env.sh',
  'deploy/installed-current.sh',
  'deploy/db-snapshot.sh',
  'deploy/trial-migrate.cjs',
]);

/** Mirrors path_is_held() in deploy/autodeploy.sh; a parity test pins the two. */
export function isHoldPath(path: string): boolean {
  if (path === 'deploy/warsaw-beer-bot.service') return false;
  if (path.startsWith('deploy/sudoers.d/')) return true;
  if (/^deploy\/.*\.(service|timer)$/.test(path)) return true;
  if (path.startsWith('deploy/litestream.')) return true;
  if (/^deploy\/install-.*\.sh$/.test(path)) return true;
  return HELD_EXACT.has(path);
}

export function checkHold(i: { title: string; labels: string[]; paths: string[] }): {
  ok: boolean; held: string[]; problems: string[];
} {
  const marked = i.title.startsWith(HOLD_MARKER);
  const labelled = i.labels.includes(HOLD_LABEL);
  const held = i.paths.filter(isHoldPath);
  const problems: string[] = [];
  if (marked && !labelled) problems.push(`the title carries ${HOLD_MARKER} but the ${HOLD_LABEL} label is missing`);
  if (!marked && labelled) problems.push(`the title has no ${HOLD_MARKER} marker but the label is set`);
  if (held.length > 0 && !marked) {
    problems.push(`hold paths changed without a ${HOLD_MARKER} title: ${held.join(', ')} — prefix the title with ${HOLD_MARKER}, add the ${HOLD_LABEL} label, and list the host steps in the PR body`);
  }
  return { ok: problems.length === 0, held, problems };
}

function main(): number {
  let labels: unknown;
  try {
    labels = JSON.parse(process.env.PR_LABELS ?? '[]');
  } catch {
    console.error('PR_LABELS must be a JSON array of label names');
    return 2;
  }
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    console.error('PR_LABELS must be a JSON array of label names');
    return 2;
  }
  const paths = readFileSync(0, 'utf8').split('\n').filter((p) => p !== '');
  const r = checkHold({ title: process.env.PR_TITLE ?? '', labels, paths });
  for (const p of r.problems) console.log(`✗ ${p}`);
  if (r.ok) console.log(r.held.length > 0 ? `OK: held for ${r.held.join(', ')}` : 'OK');
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
```

In `deploy/autodeploy.sh`, `path_is_held`: change `deploy/autodeploy.sh|deploy/autodeploy-guard.sh|deploy/ships.sh|deploy/read-env.sh) return 0 ;;` to `deploy/autodeploy.sh|deploy/ships.sh|deploy/read-env.sh) return 0 ;;`.

- [ ] **Step 4: Add `.github/workflows/deploy-hold.yml`**

```yaml
name: Deploy hold

# Merge-deploy: the title of a PR says whether its deploy will be unattended.
# Re-runs when the title or the labels change, not only on pushes. Not a
# required check at first; the host re-derives holds on its own.
on:
  pull_request:
    types: [opened, synchronize, reopened, edited, labeled, unlabeled]

permissions:
  contents: read

jobs:
  deploy-hold:
    name: deploy-hold
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - name: Install
        run: npm ci --no-audit --no-fund
      - name: Title marker, label and hold paths agree
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
          PR_LABELS: ${{ toJSON(github.event.pull_request.labels.*.name) }}
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: git diff --name-only "$BASE_SHA"...HEAD | npx tsx scripts/autodeploy/deploy-hold-check.ts
```

`scripts/workflow-node-version.test.ts` scans every workflow. The numeric `node-version: 24` pin is what it requires.

- [ ] **Step 5: Mutation check, full gate, commit.** Delete the `deploy/warsaw-beer-bot.service` line from `isHoldPath`: both the table row and the parity row must go red. Restore the line, then run `npm test && npm run typecheck`, then commit `feat(deploy): PR-side deploy-hold check, pinned to the deployer's predicate`.

---

### Task 2: operability — a stalled lock is reported, and `deploy.sh` refuses root

**Files:** Modify `deploy/autodeploy.sh` and `deploy/deploy.sh`. Modify `scripts/autodeploy/autodeploy.test.ts` and `scripts/autodeploy/deploy-lock.test.ts`.

**Why:** Core review round 2, finding 5. A manual `deploy.sh` left suspended (Ctrl-Z) or hung in `npm ci` holds the tick's lock indefinitely, and every tick exits quietly with "another tick holds the lock". `sudo bash deploy/deploy.sh` runs with `HOME=/root`, so it takes a *different* lock and records into root's state. It has also always been wrong (see the operator notes: the per-command NOPASSWD rules do not match `sudo bash`).

- [ ] **Step 1: Failing tests.** In `autodeploy.test.ts`, add a `describe('merge-deploy: a stalled lock')` with the `holdLock` helper copied from `deploy-lock.test.ts` (target: `join(w.stateDir, 'wbb-autodeploy', 'lock')`). Cases:
  - (a) With the lock held: `tick` → code 0, `notes` `[]`. `advance(w, 2099)`, tick → still `[]`. `advance(w, 1)`, tick → exactly one note matching `/^⚠️ merge-deploy: the deploy lock has been held for 35 min/`. Another tick → still one.
  - (b) After the holder is killed, a tick removes `wbb-autodeploy/lock-busy-since`: `existsSync(...)` is `false`.

  In `deploy-lock.test.ts`, add: with a fake `id` on PATH printing `0`, `deploy()` → code 1, stderr matches `/^ERROR: run deploy\.sh as the operator/`, and there is no sudo log.

- [ ] **Step 2: Implement in `autodeploy.sh`.**
  - Add the constant `LOCK_STALL_S=2100`, with a comment. It is longer than the longest legitimate tick: `TimeoutStartSec=30min` kills a tick at 1800 s.
  - Move the `notify()` definition above the lock, unchanged. Only `NOTIFY_CMD` and `NOTIFY_LIMIT` are needed there.
  - Replace the `flock -n 9 || …` line with:

```bash
if ! flock -n 9; then
  # A holder that never lets go (a suspended manual deploy.sh, a hung npm ci)
  # blocks every tick, and "another tick holds the lock" alone says nothing.
  # These two files live outside state.env on purpose: state is written only
  # under the lock, and this path runs because we do not have it.
  busy="$STATE_DIR/lock-busy-since"
  [ -s "$busy" ] || now > "$busy"
  held_s=$(( $(now) - $(cat "$busy") ))
  if [ "$held_s" -ge "$LOCK_STALL_S" ] && [ "$(cat "$STATE_DIR/lock-notice" 2>/dev/null)" != "$(date -u +%Y-%m-%d)" ]; then
    notify "⚠️ merge-deploy: the deploy lock has been held for $(( held_s / 60 )) min — no tick can run. A stuck manual deploy.sh? Check: fuser -v $LOCK"
    date -u +%Y-%m-%d > "$STATE_DIR/lock-notice"
  fi
  echo "another process holds the lock (${held_s}s); exiting"
  exit 0
fi
rm -f "$STATE_DIR/lock-busy-since"
```

- [ ] **Step 3: Implement in `deploy.sh`.** As the first statement after `set -euo pipefail`:

```bash
# Run as the operator. As root, HOME=/root: another lock (R4 would not hold)
# and another state file (record-deployed would write a baseline nobody reads).
if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: run deploy.sh as the operator (bash deploy/deploy.sh), not as root or via sudo — it calls sudo itself, per step." >&2
  exit 1
fi
```

- [ ] **Step 4: Mutation check, full gate, commit.** Remove `rm -f "$STATE_DIR/lock-busy-since"`: case (b) must go red. Restore it, run the gate, and commit `fix(deploy): report a stalled deploy lock; deploy.sh refuses root`.

---

### Task 3: delete the #435 tag path

**Files:**
- Delete: `.github/workflows/autodeploy-tag.yml`, `deploy/autodeploy-guard.sh`, `scripts/autodeploy/guard.test.ts`
- Modify: `deploy/install-autodeploy.sh` (the guard `install` line and its `ls` entry), `deploy/wbb-autodeploy.service` (the `SuccessExitStatus` comment), `deploy/autodeploy.sh` (the `shipping_paths` comment that cites `autodeploy-guard.sh`), `scripts/deploy-rsync.test.ts` (the payload list), `.github/workflows/dependabot-qualify.yml`

- [ ] **Step 1.** Delete the three files. Run `grep -rn "autodeploy-guard\|autodeploy-tag" --exclude-dir=node_modules --exclude-dir=docs .` and fix every remaining hit:
  - `install-autodeploy.sh`: remove the `install … deploy/autodeploy-guard.sh …` line and `/usr/local/bin/wbb-autodeploy-guard` from `ls`.
  - `deploy-rsync.test.ts`: remove `'deploy/autodeploy-guard.sh'` from the expected payload.
  - `autodeploy.sh`, `shipping_paths` comment: replace "for the reason spelled out in autodeploy-guard.sh:" with "for the reason spelled out in #527's spec (docs/superpowers/specs/2026-08/…527…): ", using the real file name from `ls docs/superpowers/specs/2026-08 | grep 527`.
  - `workflow-node-version.test.ts`: if its comment names `autodeploy-tag.yml` only as an example, change the example to another workflow without Node. If it lists the file as data, remove it.
- [ ] **Step 2.** In `wbb-autodeploy.service`, change the comment `# 1 = guard refused, 2 = rolled back …` to `# 1 = refused, 2 = rolled back — both are reported to Telegram by the script itself and are not systemd failures worth restarting. 3 = rollback failed and 4 = state write failed ARE failures.`
- [ ] **Step 3.** `dependabot-qualify.yml`: the labels become `automerge` (was `autodeploy`) and `automerge-pending` (was `autodeploy-pending`). Rename them in the label `case`, in the `--remove-label` list, and in the comments; the verdict string `autodeploy` from `qualify.ts` is unchanged (internal). Delete the comment that says the tag workflow fires on the label. The `autodeploy` verdict now only arms auto-merge, and the merge deploys by the common path.
- [ ] **Step 4.** Full gate. Commit `chore(deploy): delete the autodeploy-* tag path — merge-deploy replaces it`.

---

### Task 4: docs and rules

**Files:** `deploy/README.md`, `spec.md` (§5.9), `CLAUDE.md`, `AGENTS.md`, `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md` (notification table).

- [ ] **Step 1. `deploy/README.md`.** Replace the whole `## Unattended security autodeploy (#435)` section, down to the line before `## Backup: Litestream → Cloudflare R2`, with a `## Merge-deploy (unattended deploy of main)` section containing:
  - what triggers a deploy: the head of main, 10 min quiet, CI green on that SHA, no hold;
  - what a hold is and how it is released (`bash deploy/deploy.sh`);
  - the snapshot directory and its file names;
  - reading the state file (`~/.local/state/wbb-autodeploy/state.env`: `DEPLOYED_SHA`, `PREVIOUS_SHA`, `LAST_FAILED_SHA` with how to clear it, `MAIN_SEEN_*`, `WINDOW_*`, `ROLLBACK_STARTED`);
  - every Telegram message from the spec's notification table with the action it asks for;
  - after a 🔥 rollback: stop, compare `post` with the live DB, and reconcile. Nothing is automatic;
  - the emergency stop (`PAUSED`, unchanged text) and the rule that it does not stop a running tick;
  - install/upgrade: `sudo bash deploy/install-autodeploy.sh`, `sudo systemctl daemon-reload`.

  Keep the existing `### Emergency stop — no password required` text verbatim inside the new section. In `## Deploy`, add one line: "`deploy.sh` waits up to 30 s for the merge-deploy lock and refuses while a tick watches a rollback window."
- [ ] **Step 2. `spec.md` §5.9.** Replace the `- Деплой:` bullet with:

```markdown
- Деплой — **merge-deploy** (`deploy/autodeploy.sh`, таймер кожні 5 хв, спека
  `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`): хост сам деплоїть голову
  `main`, коли вона 10 хв не рухалась, CI зелений саме на цьому SHA і в діапазоні немає hold.
  Мердж — це дозвіл: право писати в `main` означає прод. Перед деплоєм: збірка й `npm audit` у
  клоні, знімок БД `VACUUM INTO` і пробна міграція на копії. Протягом 10 хв після рестарту збій
  (3 невдалі `/health` поспіль, старт довше 120 с, зміна `NRestarts`) відкочує **код і БД** до
  знімка, зберігаючи `post` для людини. Hold: шлях, що потребує root (sudoers, юніти, litestream,
  `install-*.sh`, `rsync-filter`, встановлені копії деплоєра), або PR з міткою `deploy:hold` і
  маркером `[deploy:hold]` на початку заголовка. Hold знімає ручний `bash deploy/deploy.sh`.
  Сам `deploy.sh`: rsync allowlist build/runtime-файлів → `/opt` → `npm ci` → `npm run build` →
  `npm prune --omit=dev` → `systemctl enable` + явний **`restart`**.
```

- [ ] **Step 3. `CLAUDE.md` and `AGENTS.md`**: add the same rule to both (see the operator rule "rules go in both agent files"). In CLAUDE.md, write it in Ukrainian, after the "PR створюється за замовчуванням" bullet:

```markdown
- **Змерджено = задеплоєно, крім `[deploy:hold]`** (дизайн: `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`): хост сам деплоїть `main` після мерджу (merge-deploy), тож мердж — це деплой без людини. Якщо зміна потребує кроку на хості — root (sudoers, юніти, litestream, `install-*.sh`, `rsync-filter`, встановлені копії деплоєра), нового ключа в `.env`, preflight міграції з незворотним переписуванням даних (як #611) — PR **обов'язково** несе маркер `[deploy:hold]` на початку заголовка **і** мітку `deploy:hold`, а в описі перелічує кроки для людини. CI-перевірка `deploy-hold` ловить шляхи й розбіжність маркера з міткою, але не `.env` і не preflight — їх називає автор. Hold знімається тим, що людина виконує кроки й запускає `bash deploy/deploy.sh`.
```

  In AGENTS.md, add the same rule in English, next to "create the pull request by default".
- [ ] **Step 4. The spec's notification table.** Change the `held` row's message to `⏸ production is behind main and HELD: <reasons, each PR linked> — do the steps, then bash deploy/deploy.sh`. Add a sentence under the table: "The PR body is not quoted: it is free-form and long; the link is exact (decided 2026-09-30)."
- [ ] **Step 5.** Full gate, commit `docs: merge-deploy in README, spec.md and the agent rules`.

---

## Rollout (after the user merges — this PR is itself `[deploy:hold]`)

1. **Before merge:** create the labels on GitHub. Run `gh label create deploy:hold --color B60205 --description "Deploy needs a human on the host; see the PR body"`, then `gh label edit autodeploy --name automerge` and `gh label edit autodeploy-pending --name automerge-pending`. Renaming keeps the labels on existing PRs. Title the PR `[deploy:hold] feat(deploy): merge-deploy …`, add the label, and put these steps in the body.
2. After merge, on the host, as the user in a code-server terminal: `sudo bash deploy/install-autodeploy.sh` (put it in `./tmp/rollout.sh` per CLAUDE.md), `sudo systemctl daemon-reload`, `sudo rm /usr/local/bin/wbb-autodeploy-guard`.
3. Claude: `wbb-installed-current` → CURRENT, then `bash deploy/deploy.sh` from the main checkout. That releases the hold, and `DEPLOYED_SHA` becomes the merge.
4. Remove the stale key from state: `sed -i '/^LAST_FAILED_SHA=72448d9/d' ~/.local/state/wbb-autodeploy/state.env` (the #498 residue). Delete the last tag: `git push origin :refs/tags/autodeploy-20260825T073442Z`. Ask the user first; deleting a remote tag is not reversible from here.
5. Close #498 and #499, referencing the spec (both are moot: the tag path and the drift report are gone).
6. **Pre-registered live test:** before the next real merge that ships, write down the expected journal lines and messages (first-seen → +10 min → CI → build → snapshot → trial → deploy → +10 min ✅). Then compare, the way #527's live test did.
7. Open an issue: "`read-env.sh` exits 0 on an unreadable `.env`" (Severity-4, effort/S). It is an installed copy, notify depends on it too, and R7 only covers a failed read.
