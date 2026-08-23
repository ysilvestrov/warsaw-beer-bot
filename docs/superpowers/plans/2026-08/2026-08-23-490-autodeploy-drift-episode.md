# #490 — Drift Episode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the deployer's drift alarm from a one-directional per-tick condition check into an episode with a start, a 15-minute grace period, a daily reminder, and a closing message.

**Architecture:** `deploy/autodeploy.sh` gains one state field (`DRIFT_SINCE`, epoch seconds) and one seam (`WBB_NOW_S`). `report_drift_once` becomes an explicit five-transition state machine. `LAST_DRIFT_NOTICE` keeps its name and date format but changes meaning: "we reminded during *this* episode today". Both fields clear when the episode closes.

**Tech Stack:** Bash (the deployer), Vitest + `execFileSync` (the test harness in `scripts/autodeploy/autodeploy.test.ts`, which runs the real script against throwaway git repos with every external contact stubbed via `WBB_*` env vars).

**Spec:** `docs/superpowers/specs/2026-08/2026-08-23-autodeploy-drift-signal-design.md`

## Global Constraints

- **`DRIFT_GRACE_S=900`** (15 minutes), declared beside `HEALTH_TIMEOUT_S` near the top of `deploy/autodeploy.sh`.
- **No new positional argument on `write_state`.** It already carries three of its five arguments by default (`${4:-$LAST_DRIFT_NOTICE}` and friends); `DRIFT_SINCE` joins them the same way, so callers assign the shell variable and let the default carry it. **None of the ten existing `write_state` call sites may change.** Converting `write_state` to read shell variables was considered and rejected in the spec — do not do it.
- **The clock is a seam:** `NOW_S="${WBB_NOW_S:-$(date +%s)}"`, following the existing `WBB_*` override pattern (`WBB_GUARD`, `WBB_DEPLOY_CMD`, `WBB_HEALTH_CMD`, `WBB_NOTIFY_CMD`, `WBB_AUDIT_CMD`, `WBB_INSTALLED_CHECK`, `WBB_READ_ENV`).
- **No all-clear for an alarm that never sounded.** The recovery message fires only when the episode was announced — i.e. `LAST_DRIFT_NOTICE` is non-empty. A merge followed by a deploy inside the grace window must produce **no notify call at all**, at either end.
- **`report_drift_once` is only reachable on the idle path** — `autodeploy.sh` calls it only when no `autodeploy-*` tag exists (`[ -n "$tag" ] || { echo "no autodeploy tag yet"; report_stale_once; report_drift_once; exit 0; }`). Every test in this plan therefore needs a remote with **no** `autodeploy-*` tag. The file's shared `remoteDir` fixture HAS one, so drift tests build their own.
- **The allowlist is `package.json` and `package-lock.json` only.** A drift that touches only those produces the "ℹ️ … autodeploy still works" message; anything else produces the blocking one. The shared fixture's two commits differ only in `package.json`, so drift tests must commit a path outside the allowlist (e.g. `src/x.ts`) to exercise the blocking branch.
- Every new test must be **mutation-proven**: revert the production change, watch the test go red, restore.
- Shell style follows the file: `local` declarations, `[ ]` tests, comments explaining *why*.
- Full suite: `npm test`. The autodeploy tests alone: `npx vitest run scripts/autodeploy/autodeploy.test.ts`.

---

### Task 1: The clock seam, the episode's start, and silence inside it

**Files:**
- Modify: `deploy/autodeploy.sh` — add `DRIFT_GRACE_S` and `NOW_S` near the other constants (~lines 10-20); add `DRIFT_SINCE` to the state defaults (~line 260) and to `write_state`'s carried parameters (~line 143); rewrite `report_drift_once` (~lines 221-241)
- Test: `scripts/autodeploy/autodeploy.test.ts` — a new `describe('drift episode')` block at the end of the file

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `DRIFT_SINCE` (state field, epoch seconds, empty when no episode is open); `DRIFT_GRACE_S` (constant); `WBB_NOW_S` (test seam); and the test helpers `driftRemote()` and `seedDriftState()` described below, which Tasks 2 and 3 reuse verbatim.

- [ ] **Step 1: Write the test fixture and the first failing test**

Append to `scripts/autodeploy/autodeploy.test.ts`. `driftRemote` builds a remote with **no** `autodeploy-*` tag (so the idle path runs) whose two commits differ in a path **outside** the allowlist (so the blocking branch is the one under test):

```typescript
/**
 * #490. `report_drift_once` runs only on the idle path — when no autodeploy-*
 * tag exists — so these tests need their own remote, not the shared one, which
 * carries a tag. The two commits differ in `src/x.ts`, outside the
 * package.json/package-lock.json allowlist, so drift here is the blocking kind.
 */
function driftRemote(): { dir: string; oldSha: string; newSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wbb-drift-remote-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  const seed = mkdtempSync(join(tmpdir(), 'wbb-drift-seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', dir);
  const oldSha = commit(seed, { 'src/x.ts': 'export const x = 1;\n' }, 'old');
  git(seed, 'push', '-q', 'origin', 'main');
  const newSha = commit(seed, { 'src/x.ts': 'export const x = 2;\n' }, 'new');
  git(seed, 'push', '-q', 'origin', 'main');
  return { dir, oldSha, newSha };
}

/** A harness cloned from a drift remote, plus arbitrary state fields. */
function driftHarness(remote: string, state: Record<string, string>): Harness {
  const home = mkdtempSync(join(tmpdir(), 'wbb-ad-home-'));
  const dataDir = join(home, 'data');
  const stateDir = join(home, 'state');
  const repoParent = join(dataDir, 'wbb-autodeploy');
  mkdirSync(repoParent, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['clone', '-q', remote, join(repoParent, 'repo')]);
  const dir = join(stateDir, 'wbb-autodeploy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.env'),
    Object.entries(state).map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
  );
  return { home, dataDir, stateDir, repo: join(repoParent, 'repo'), bin: mkdtempSync(join(tmpdir(), 'wbb-ad-bin-')) };
}

describe('#490 drift episode', () => {
  it('records the episode start and says nothing inside the grace window', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, { DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '' });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    const out = run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '1000000' });

    expect(out.code).toBe(0);
    // The episode is recorded...
    expect(readState(h.stateDir).DRIFT_SINCE).toBe('1000000');
    // ...and nobody is told yet. A merge is not an incident.
    expect(existsSync(notifyLog)).toBe(false);
  });

  it('still says nothing one second before the grace period expires', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 899) });

    expect(existsSync(notifyLog)).toBe(false);
    // ...and the start is not moved forward by a tick that stayed silent.
    expect(readState(h.stateDir).DRIFT_SINCE).toBe('1000000');
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail for the right reason**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "drift episode"`

Expected: both FAIL. The first because `DRIFT_SINCE` is never written; the second because today's code notifies immediately (the notify log exists). If the first fails because the script exited non-zero, read `out.out` — the idle path may not have been reached, which means the fixture accidentally has a tag.

- [ ] **Step 3: Add the constant and the clock seam**

In `deploy/autodeploy.sh`, beside `HEALTH_TIMEOUT_S=60` (~line 18):

```bash
# #490: drift is the normal state of the minutes between a merge and the deploy
# that follows it. What makes it worth a message is DURATION, not existence —
# so the episode has to have a beginning, and the beginning has to be storable.
DRIFT_GRACE_S=900
# The clock is a seam like every other external contact in this file: 15 minutes
# cannot be tested against the wall clock, and an untestable grace period is how
# the drift branch ended up with no tests at all.
NOW_S="${WBB_NOW_S:-$(date +%s)}"
```

- [ ] **Step 4: Carry `DRIFT_SINCE` through the state file**

Add the default beside the other state defaults (~line 16, next to `LAST_DRIFT_NOTICE=""`):

```bash
DRIFT_SINCE=""
```

In `write_state`, add it as a carried parameter — **appended to the signature, never passed by the existing call sites**:

```bash
write_state() {
  local deployed="$1" previous="$2" last_failed="${3:-}" drift_notice="${4:-$LAST_DRIFT_NOTICE}" stale_notice="${5:-$LAST_STALE_NOTICE}" drift_since="${6:-$DRIFT_SINCE}"
```

and inside the `{ ... }` group, following the same `if` form the others use (the comment above them explains why `if` and not `&&` — do not switch forms):

```bash
    if [ -n "$drift_since" ]; then
      printf 'DRIFT_SINCE=%s\n' "$drift_since"
    fi
```

Add it to the state defaults read after sourcing (~line 260, beside `LAST_DRIFT_NOTICE="${LAST_DRIFT_NOTICE:-}"`):

```bash
DRIFT_SINCE="${DRIFT_SINCE:-}"
```

- [ ] **Step 5: Rewrite `report_drift_once`'s opening transitions**

Replace the body's first guards so the function records the episode and stays silent inside the window. The full five-transition body lands across Tasks 1-3; this task implements the first three rows:

```bash
report_drift_once() {
  local main_sha today behind outside
  main_sha=$(git -C "$REPO" rev-parse origin/main 2>/dev/null || echo '')
  today=$(date -u +%Y-%m-%d)

  [ -n "$DEPLOYED_SHA" ] || return 0
  [ -n "$main_sha" ] || return 0

  # No drift. The closing half of the episode lands in Task 3.
  if [ "$DEPLOYED_SHA" = "$main_sha" ]; then
    return 0
  fi

  # Drift, and no episode open yet: start the clock, say nothing. This is the
  # merge that just happened; the person who made it is probably deploying.
  if [ -z "$DRIFT_SINCE" ]; then
    DRIFT_SINCE="$NOW_S"
    write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
    return 0
  fi

  # Inside the grace window: still nothing.
  [ $((NOW_S - DRIFT_SINCE)) -ge "$DRIFT_GRACE_S" ] || return 0

  [ "$LAST_DRIFT_NOTICE" != "$today" ] || return 0

  behind=$(git -C "$REPO" rev-list --count "${DEPLOYED_SHA}..${main_sha}" 2>/dev/null || echo '?')
  outside=$(git -C "$REPO" diff --name-only "$DEPLOYED_SHA" "$main_sha" 2>/dev/null |
    { n=0; while read -r f; do case "$f" in package.json|package-lock.json) ;; *) n=$((n+1));; esac; done; echo "$n"; })

  if [ "$outside" != "0" ]; then
    notify "⚠️ autodeploy is BLOCKED: production is ${behind} commit(s) behind main, and ${outside} differing path(s) are outside the allowlist. Every security tag will be refused until production is deployed. Run ./deploy/deploy.sh."
  else
    notify "ℹ️ production is ${behind} commit(s) behind main, but only the manifest and lockfile differ — autodeploy still works."
  fi
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA" "$today"
}
```

Note the `write_state` calls pass three arguments, exactly as before — `DRIFT_SINCE` rides along through the `${6:-$DRIFT_SINCE}` default.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: the two new tests PASS and every pre-existing test in the file still passes.

Run: `npm test`
Expected: clean.

- [ ] **Step 7: Mutation-prove**

Temporarily delete the `[ $((NOW_S - DRIFT_SINCE)) -ge "$DRIFT_GRACE_S" ] || return 0` line.
Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "one second before"`
Expected: FAIL. Restore the line and confirm it passes again.

- [ ] **Step 8: Commit**

```bash
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "fix(#490): a drift episode starts silently and waits out its grace period"
```

---

### Task 2: The announcement and the daily reminder

**Files:**
- Test: `scripts/autodeploy/autodeploy.test.ts` — three tests added to the `#490 drift episode` describe block

**Interfaces:**
- Consumes: `driftRemote()`, `driftHarness()`, `DRIFT_SINCE`, `DRIFT_GRACE_S`, `WBB_NOW_S` from Task 1.
- Produces: nothing later tasks depend on.

Task 1 already implements the announcement (it is the tail of `report_drift_once`). This task proves it, and proves the two things about it that were never tested: that it happens **once**, and that it comes back **the next day**.

- [ ] **Step 1: Write the tests**

```typescript
  it('announces once the drift has outlived the grace period', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 900) });

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
    // The reminder marker is what stops the repeat, and what Task 3 reads to
    // decide whether a closing message is owed.
    expect(readState(h.stateDir).LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not repeat on the next tick of the same day', () => {
    const r = driftRemote();
    const today = new Date().toISOString().slice(0, 10);
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '',
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: today,
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 100000) });

    expect(existsSync(notifyLog)).toBe(false);
  });

  it('reminds again on a later day while the episode is still open', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '',
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: '2000-01-01',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 100000) });

    expect(countLines(notifyLog)).toBe(1);
  });
```

Note the second test seeds `LAST_DRIFT_NOTICE` with **today's real date**, because `report_drift_once` computes `today` from the real clock (`date -u`), not from `WBB_NOW_S` — `WBB_NOW_S` drives the grace arithmetic only. Do not "fix" that by routing `today` through the seam; the daily reminder is a calendar concept and the grace period is a duration, and conflating them would make the reminder test depend on epoch arithmetic nobody can read.

- [ ] **Step 2: Run them**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "drift episode"`
Expected: all five PASS (Task 1 already implements this behaviour).

- [ ] **Step 3: Mutation-prove the "no repeat" test**

Temporarily delete `[ "$LAST_DRIFT_NOTICE" != "$today" ] || return 0` from `report_drift_once`.
Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "does not repeat"`
Expected: FAIL. Restore, confirm green.

- [ ] **Step 4: Commit**

```bash
git add scripts/autodeploy/autodeploy.test.ts
git commit -m "test(#490): the announcement happens once and returns the next day"
```

---

### Task 3: The closing message, and the regression this issue is named for

**Files:**
- Modify: `deploy/autodeploy.sh` — the "no drift" branch of `report_drift_once` added in Task 1 Step 5
- Test: `scripts/autodeploy/autodeploy.test.ts` — three tests added to the `#490 drift episode` describe block

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

```typescript
  it('closes an announced episode with one recovery message and clears both fields', () => {
    const r = driftRemote();
    // production has caught up: DEPLOYED_SHA === origin/main
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha,
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: '2026-08-23',
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 100000) });

    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/caught up|in sync/i);
    const state = readState(h.stateDir);
    expect(state.DRIFT_SINCE ?? '').toBe('');
    expect(state.LAST_DRIFT_NOTICE ?? '').toBe('');
  });

  it('says nothing at all when an unannounced episode closes inside the grace window', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha,
      DRIFT_SINCE: '1000000',           // started, never announced
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(1000000 + 60) });

    // An all-clear for an alarm that never sounded is pure noise, and it would
    // land on exactly the happy path this change exists to keep quiet.
    expect(existsSync(notifyLog)).toBe(false);
    expect(readState(h.stateDir).DRIFT_SINCE ?? '').toBe('');
  });

  it('#490 regression: a second merge the same day is announced, not swallowed', () => {
    const r = driftRemote();
    // The state the OLD code left behind after merge → BLOCKED → deploy:
    // caught up, but LAST_DRIFT_NOTICE still holds today, so the old code
    // would stay silent for the rest of the day however far production fell
    // behind. Here the episode closes first, clearing the marker.
    const today = new Date().toISOString().slice(0, 10);
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha,
      DRIFT_SINCE: '1000000', LAST_DRIFT_NOTICE: today,
    });
    const notifyLog = join(h.bin, 'notify.log');
    const notify = stub(h.bin, 'notify', `cat >> "${notifyLog}" <<< "$1"`);

    // tick 1: production is level → the episode closes and the marker clears
    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '2000000' });
    expect(readState(h.stateDir).LAST_DRIFT_NOTICE ?? '').toBe('');

    // a second merge lands: roll production back to the older commit
    writeFileSync(
      join(h.stateDir, 'wbb-autodeploy', 'state.env'),
      `DEPLOYED_SHA=${r.oldSha}\nPREVIOUS_SHA=\n`,
    );

    // tick 2 starts a fresh episode silently; tick 3, past the grace, announces
    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: '3000000' });
    run(h, { WBB_NOTIFY_CMD: notify, WBB_NOW_S: String(3000000 + 900) });

    // one recovery + one fresh announcement — under the old code the second
    // merge produced nothing at all.
    expect(countLines(notifyLog)).toBe(2);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "drift episode"`
Expected: the three new tests FAIL — Task 1's "no drift" branch is a bare `return 0`, so nothing is sent and nothing is cleared.

- [ ] **Step 3: Implement the closing transition**

Replace the placeholder branch from Task 1 Step 5:

```bash
  # No drift. Two cases: an episode was open, or there never was one.
  if [ "$DEPLOYED_SHA" = "$main_sha" ]; then
    [ -n "$DRIFT_SINCE" ] || return 0
    # Only close out loud if we spoke. An all-clear for an alarm that never
    # sounded is noise, and it would arrive on exactly the path this change
    # exists to keep quiet: merge, deploy, done, nobody disturbed.
    if [ -n "$LAST_DRIFT_NOTICE" ]; then
      notify "✅ production has caught up with main — unattended deploys work again."
    fi
    DRIFT_SINCE=""
    LAST_DRIFT_NOTICE=""
    write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
    return 0
  fi
```

`write_state` omits both fields' arguments, so its `${4:-$LAST_DRIFT_NOTICE}` and `${6:-$DRIFT_SINCE}` defaults read the now-empty shell variables, and the `if [ -n … ]` guards inside it skip writing them. That is how they clear.

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: all eight drift tests PASS, every pre-existing test still passes.

Run: `npm test`
Expected: clean.

- [ ] **Step 5: Mutation-prove**

Temporarily change `if [ -n "$LAST_DRIFT_NOTICE" ]; then` to `if true; then`.
Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "says nothing at all"`
Expected: FAIL. Restore, confirm green.

Then temporarily delete the two `DRIFT_SINCE=""` / `LAST_DRIFT_NOTICE=""` assignments.
Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t "regression"`
Expected: FAIL. Restore, confirm green.

- [ ] **Step 6: Commit**

```bash
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "fix(#490): an announced drift episode gets a closing message"
```

---

### Task 4: The documentation says what the signal now does

**Files:**
- Modify: `deploy/README.md:184-185`

**Interfaces:**
- Consumes: the behaviour built in Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Rewrite the drift paragraph**

`deploy/README.md` currently says:

> `autodeploy.sh` also reports drift on its idle path — once a day, not once a
> tick — if production has fallen behind `main` in ways that would block it.

That describes the old per-day condition check. Replace it with:

```markdown
`autodeploy.sh` also watches for drift on its idle path — production falling
behind `main` in ways that would block it. Drift is treated as an **episode**,
not a per-tick condition: nothing is reported for the first 15 minutes
(`DRIFT_GRACE_S`), because a merge followed by a deploy is ordinary work and
needs no message at either end. Past that, one message goes out, repeated at
most once a day while the episode stays open, and one closing message when
production catches up — the closing message only if the episode was announced.
`DRIFT_SINCE` in the state file holds the episode's start; both it and
`LAST_DRIFT_NOTICE` clear when it ends.
```

- [ ] **Step 2: Check nothing else documents the old behaviour**

Run: `grep -rn "once a day, not once a tick\|reports drift" deploy/ spec.md docs/ --include=*.md | grep -v superpowers`
Expected: no hits outside the paragraph you just rewrote. (`spec.md` does not document the deployer's drift signal — verified 2026-08-23 — so it needs no change here.)

- [ ] **Step 3: Commit**

```bash
git add deploy/README.md
git commit -m "docs(#490): the README describes drift as an episode"
```
