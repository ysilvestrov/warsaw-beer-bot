# #491 + #497 — Autodeploy Idle Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployer's two idle reports (drift, stale installed deployer) reachable whenever it has no work — not merely when no `autodeploy-*` tag has ever existed — and make the daily markers they write survive each other.

**Architecture:** Three changes to `deploy/autodeploy.sh`, in dependency order. (1) `write_state` loses positional parameters 4-6; `LAST_DRIFT_NOTICE`, `LAST_STALE_NOTICE` and `DRIFT_SINCE` are read from shell variables only, so a later call in a tick can no longer decide what an earlier one persisted. (2) The two writers that used those positions assign the variable first. (3) The tag gate becomes one named predicate — `pending` — instead of three scattered `exit 0` branches, and the reporters run whenever `pending` is empty.

**Tech Stack:** Bash (the deployer), Vitest + `execFileSync` (the harness in `scripts/autodeploy/autodeploy.test.ts`, which runs the real script against throwaway git repos with every external contact stubbed through `WBB_*` env vars).

**Spec:** `docs/superpowers/specs/2026-08/2026-08-24-491-497-autodeploy-idle-reachability-design.md`

## Global Constraints

- **`write_state` ends with exactly three parameters:** `write_state <deployed> <previous> [last_failed]`. `LAST_DRIFT_NOTICE`, `LAST_STALE_NOTICE`, `DRIFT_SINCE` MUST NOT be parameters. This deliberately overturns a constraint written in `docs/superpowers/plans/2026-08/2026-08-23-490-autodeploy-drift-episode.md` ("No new positional argument on `write_state` … Converting `write_state` to read shell variables was considered and rejected"). The spec's D1 section explains the reversal; do not restore the positional form.
- **Ten of the twelve `write_state` call sites must be byte-identical after this change.** Only `deploy/autodeploy.sh:230` (in `report_stale_once`) and `:278` (in `report_drift_once`) pass arguments beyond the third. If `git diff` shows a third call site changed, that is a defect.
- **Message texts do not change.** Not the ⚠️ blocking text, not the ℹ️ manifest-only text, not the ✅ recovery text, not the stale-deployer text. This change alters reachability and persistence only.
- **`DRIFT_GRACE_S=900` and the once-a-day cadence do not change.**
- **The guard is not touched.** `deploy/autodeploy-guard.sh` is out of scope; the adjacent defect it participates in is filed as **#498** and must not be fixed here. In particular: do NOT make "a tag that is an ancestor of `DEPLOYED_SHA`" idle. Only exact equality with `DEPLOYED_SHA` or `LAST_FAILED_SHA` counts as handled.
- **A *pending* tag must still reach zero idle reports.** It is deployed or refused; a second message about the same condition is the noise the original comment protected. Task 3 has a test that fails if this is broken.
- **`[ -z "$DEPLOYED_SHA" ]` ("no recorded baseline", exit 1) stays reachable on the pending path only.** An empty `DEPLOYED_SHA` never equals a resolved 40-character `target`, so the existing check needs no change — but do not move it above the `pending` gate.
- **Shell style follows the file:** `local` declarations, `[ ]` tests, comments that explain *why* rather than *what*.
- **Every new test is mutation-proven:** revert the production line it defends, watch it go red, restore. A step in each task requires this and names the exact line.
- **`spec.md` is not touched** — autodeploy does not appear in it. `deploy/README.md` IS touched, in Task 4.
- Full suite: `npm test`. This file alone: `npx vitest run scripts/autodeploy/autodeploy.test.ts`.
- **Commit location guard.** Before the first commit in any task, run `git rev-parse --show-toplevel && git branch --show-current` and confirm the toplevel is the worktree for this feature, not `/home/ysi/warsaw-beer-bot`.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `deploy/autodeploy.sh` | The deployer. `write_state` (persistence), `report_stale_once` / `report_drift_once` (the two idle reports), the tag gate (what counts as work). | 1, 2, 3 |
| `scripts/autodeploy/autodeploy.test.ts` | Every test. Existing helpers `git`, `commit`, `stub`, `readState`, `countLines`, `setup`, `seedState`, `run`, `driftRemote`, `driftHarness` are reused; `driftRemote` gains an optional tag. | 1, 2, 3 |
| `deploy/README.md` | Operator documentation. Its "watches for drift on its idle path" paragraph describes the old, narrower meaning of *idle*. | 4 |

---

### Task 1: `write_state` stops accepting carry-fields positionally

Pure refactor with a behaviour-pinning test. Nothing about *when* reports fire changes here; this task exists so Task 2's fix is expressible and Task 3's fix cannot resurrect the erasure.

**Files:**
- Modify: `deploy/autodeploy.sh:152-181` (`write_state`), `:230` (`report_stale_once`'s write), `:278` (`report_drift_once`'s write)
- Test: `scripts/autodeploy/autodeploy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `write_state <deployed> <previous> [last_failed]` — three parameters, no more. `LAST_DRIFT_NOTICE`, `LAST_STALE_NOTICE`, `DRIFT_SINCE` are carried from the shell variables of the same name on every call. Tasks 2 and 3 rely on this signature.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block at the end of `scripts/autodeploy/autodeploy.test.ts`. It reuses `driftRemote()` and `driftHarness()`, which already exist in the file.

This test drives the *observable* consequence of the erasure: a tick in which both reporters speak must leave **both** markers behind. `WBB_INSTALLED_CHECK` is stubbed to report STALE so `report_stale_once` actually sends; `DRIFT_SINCE` is seeded far in the past so the drift branch is past its grace window and announces in the same tick.

```typescript
describe('#497 the daily markers survive each other', () => {
  it('a tick where both reporters speak leaves BOTH markers in the state file', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    // One line per CALL, not per line of message. `countLines` counts lines,
    // and the stale-deployer and guard-refusal messages are multi-line — a
    // plain `cat` stub would make "how many notifications" unmeasurable.
    const notify = stub(h.bin, 'notify', `head -n1 <<< "$1" >> "${notifyLog}"`);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    });

    // A non-zero exit before the notify point would leave the log absent and
    // the state untouched — indistinguishable from the silence being tested.
    expect(out.code).toBe(0);
    // Two distinct messages, one from each reporter.
    expect(countLines(notifyLog)).toBe(2);
    const log = readFileSync(notifyLog, 'utf8');
    expect(log).toMatch(/out of date/);
    expect(log).toMatch(/BLOCKED/);

    // The defect: report_drift_once's write dropped the marker
    // report_stale_once had just persisted.
    const state = readState(h.stateDir);
    expect(state.LAST_STALE_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(state.LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the same day is silent on the next tick — neither warning repeats', () => {
    const r = driftRemote();
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    // One line per CALL, not per line of message. `countLines` counts lines,
    // and the stale-deployer and guard-refusal messages are multi-line — a
    // plain `cat` stub would make "how many notifications" unmeasurable.
    const notify = stub(h.bin, 'notify', `head -n1 <<< "$1" >> "${notifyLog}"`);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );
    const env = {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    };

    expect(run(h, env).code).toBe(0);
    expect(countLines(notifyLog)).toBe(2);

    // Second tick, same day: both markers must still be suppressing.
    expect(run(h, env).code).toBe(0);
    expect(countLines(notifyLog)).toBe(2); // unchanged — the siren #497 describes
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t '#497'`

Expected: both FAIL. The first on `state.LAST_STALE_NOTICE` being `undefined`; the second on the notify log growing to 3 lines (the stale warning re-firing on the second tick) — which is the repetition the issue could not observe in production.

- [ ] **Step 3: Delete the positional carry-fields from `write_state`**

Replace the `local` line and the three `if` blocks that read the removed parameters. Full replacement for `deploy/autodeploy.sh:152-181`:

```bash
# C3: writes the state file, preserving DEPLOYED_SHA/PREVIOUS_SHA and setting
# (or clearing, if $3 is empty) LAST_FAILED_SHA.
#
# #497: the three daily/episode markers are NOT parameters. They used to be
# positions 4-6, carried by default (`${4:-$LAST_DRIFT_NOTICE}`), and that form
# let a LATER call in the same tick silently decide what an EARLIER one had
# persisted: report_stale_once passed its marker as argument 5 without assigning
# the variable, and report_drift_once's four-argument write moments later fell
# back to the still-empty variable and dropped the line. Reading the shell
# variables directly does not merely fix that — it makes it unwriteable. A
# caller that wants to change one of these ASSIGNS it, then calls.
write_state() {
  local deployed="$1" previous="$2" last_failed="${3:-}"
  {
    printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=%s\n' "$deployed" "$previous"
    # `if`, not `[ -n ... ] &&` — the latter, as the group's last statement,
    # would leak ITS OWN exit status (1 when last_failed is empty) out of
    # the whole `{ ... }` group and into the `||` below, tripping the
    # "failed to write state" path even though the write succeeded.
    if [ -n "$last_failed" ]; then
      printf 'LAST_FAILED_SHA=%s\n' "$last_failed"
    fi
    # Carried on every write so a deploy does not reset the once-a-day drift
    # reminder and turn a standing condition back into a siren.
    if [ -n "$LAST_DRIFT_NOTICE" ]; then
      printf 'LAST_DRIFT_NOTICE=%s\n' "$LAST_DRIFT_NOTICE"
    fi
    if [ -n "$LAST_STALE_NOTICE" ]; then
      printf 'LAST_STALE_NOTICE=%s\n' "$LAST_STALE_NOTICE"
    fi
    if [ -n "$DRIFT_SINCE" ]; then
      printf 'DRIFT_SINCE=%s\n' "$DRIFT_SINCE"
    fi
  } > "$STATE" || {
    # I6: the state write used to abort silently under set -e. A failure
    # here means the file on disk may now disagree with what is actually
    # running — that is worth waking a human for.
    notify "🔥 autodeploy: failed to write $STATE — its record of what is deployed may now disagree with production."
    exit 4
  }
}
```

- [ ] **Step 4: Convert the only two call sites that passed the removed arguments**

In `report_stale_once` (`deploy/autodeploy.sh:230`), replace:

```bash
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA" "$LAST_DRIFT_NOTICE" "$today"
```

with:

```bash
  # #497: assign, then let write_state carry it. Passing "$today" positionally
  # left LAST_STALE_NOTICE empty, and report_drift_once's write in the same
  # tick then persisted that emptiness over the marker just written.
  LAST_STALE_NOTICE="$today"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
```

In `report_drift_once`'s announcement branch (`deploy/autodeploy.sh:278`), replace:

```bash
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA" "$today"
```

with:

```bash
  LAST_DRIFT_NOTICE="$today"
  write_state "$DEPLOYED_SHA" "$PREVIOUS_SHA" "$LAST_FAILED_SHA"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`

Expected: PASS, all of them — the two new `#497` tests plus every pre-existing test in the file. The pre-existing `#490 drift episode` tests are the regression net for the refactor: they assert `LAST_DRIFT_NOTICE` and `DRIFT_SINCE` are written and cleared at the right moments, and they exercise ten of the twelve call sites.

- [ ] **Step 6: Prove the blast radius**

Run: `git diff -U0 deploy/autodeploy.sh | grep -c '^[-+] *write_state '`

Expected: `4` — two removed lines and two added lines, i.e. exactly the two call sites named in the constraints. Any higher number means a call site changed that should not have.

- [ ] **Step 7: Mutation-prove both tests**

Revert `LAST_STALE_NOTICE="$today"` (delete that one line) in `report_stale_once`, run `npx vitest run scripts/autodeploy/autodeploy.test.ts -t '#497'`, confirm **both** tests fail, restore the line. Record the observed failure messages in the commit body.

- [ ] **Step 8: Commit**

```bash
git rev-parse --show-toplevel && git branch --show-current   # must be the worktree
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "fix(#497): the daily markers are assigned, not passed positionally"
```

---

### Task 2: The idle predicate — "no work", not "no tag"

**Files:**
- Modify: `deploy/autodeploy.sh:302-330` (the tag selection, the `LAST_FAILED_SHA` skip, and the "already deployed" exit)
- Test: `scripts/autodeploy/autodeploy.test.ts`

**Interfaces:**
- Consumes: `write_state <deployed> <previous> [last_failed]` from Task 1.
- Produces: shell variable `pending` — empty when the deployer has no work, otherwise the resolved 40-character target commit. `target` remains defined and unchanged for every line below the gate; nothing after the gate is edited.

- [ ] **Step 1: Teach `driftRemote` to place a tag**

`driftRemote()` currently builds a remote with no `autodeploy-*` tag. These tests need one. Change its signature — the four existing call sites in the `#490 drift episode` block pass no argument and keep working:

```typescript
/**
 * #490. `report_drift_once` runs only on the idle path, so these tests need
 * their own remote rather than the shared one. The two commits differ in
 * `src/x.ts`, outside the package.json/package-lock.json allowlist, so drift
 * here is the blocking kind.
 *
 * #491. `tagAt` places an `autodeploy-*` tag on one of the two commits. The
 * idle path used to be reachable ONLY when no such tag existed anywhere, which
 * is why every #490 test above leaves this argument off.
 */
function driftRemote(tagAt?: 'old' | 'new'): {
  dir: string; oldSha: string; newSha: string; tag: string;
} {
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
  const tag = 'autodeploy-20260824T120000Z';
  if (tagAt) {
    git(seed, 'tag', tag, tagAt === 'old' ? oldSha : newSha);
    git(seed, 'push', '-q', 'origin', tag);
  }
  return { dir, oldSha, newSha, tag };
}
```

- [ ] **Step 2: Write the failing tests**

Append a new `describe` block at the end of the file:

```typescript
describe('#491 the idle reports survive the existence of a tag', () => {
  it('drift is announced when the newest tag is already deployed', () => {
    // The tag sits on the deployed commit, so there is nothing to do — but
    // `main` has moved on. Under the old gate ("has a tag ever existed?") this
    // tick exited at "already deployed" and said nothing, forever.
    const r = driftRemote('old');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    // One line per CALL, not per line of message. `countLines` counts lines,
    // and the stale-deployer and guard-refusal messages are multi-line — a
    // plain `cat` stub would make "how many notifications" unmeasurable.
    const notify = stub(h.bin, 'notify', `head -n1 <<< "$1" >> "${notifyLog}"`);
    // The guard must never be consulted on this path; a marker proves it.
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_GUARD: guard,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(0);
    expect(out.out).toMatch(/already deployed/); // the diagnostic line is kept
    expect(existsSync(guardMarker)).toBe(false);
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
    expect(readState(h.stateDir).LAST_DRIFT_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('drift is announced when the newest tag is recorded as LAST_FAILED_SHA', () => {
    // The tag failed once and is not retried — that is idle, and it is the
    // state in which drift matters most: autodeploy is dead twice over.
    const r = driftRemote('new');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '',
      LAST_FAILED_SHA: r.newSha, DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    // One line per CALL, not per line of message. `countLines` counts lines,
    // and the stale-deployer and guard-refusal messages are multi-line — a
    // plain `cat` stub would make "how many notifications" unmeasurable.
    const notify = stub(h.bin, 'notify', `head -n1 <<< "$1" >> "${notifyLog}"`);
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo ACCEPT; exit 0`);

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_GUARD: guard,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(0);
    expect(out.out).toMatch(/LAST_FAILED_SHA/); // the diagnostic line is kept
    expect(existsSync(guardMarker)).toBe(false);
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/BLOCKED/);
  });

  it('the stale-deployer reminder is reachable with a tag present', () => {
    // Same dark branch, the other reporter. Production is level with main, so
    // report_drift_once has nothing to say and the ONLY message can be this one.
    const r = driftRemote('new');
    const h = driftHarness(r.dir, { DEPLOYED_SHA: r.newSha, PREVIOUS_SHA: r.oldSha });
    const notifyLog = join(h.bin, 'notify.log');
    // One line per CALL, not per line of message. `countLines` counts lines,
    // and the stale-deployer and guard-refusal messages are multi-line — a
    // plain `cat` stub would make "how many notifications" unmeasurable.
    const notify = stub(h.bin, 'notify', `head -n1 <<< "$1" >> "${notifyLog}"`);
    const installedCheck = stub(
      h.bin,
      'installed-check',
      'echo "STALE: 1 installed file(s) differ from origin/main:"; echo "  deploy/autodeploy.sh"; exit 1',
    );

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: '2000000',
    });

    expect(out.code).toBe(0);
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/out of date/);
    expect(readState(h.stateDir).LAST_STALE_NOTICE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a PENDING tag still produces the guard verdict and NO idle report', () => {
    // The tiredness this whole gate was protecting. A tag that is real work
    // gets deployed or refused with its paths listed; a second message about
    // the same condition is noise. Without this test, "always report" passes.
    const r = driftRemote('new');
    const h = driftHarness(r.dir, {
      DEPLOYED_SHA: r.oldSha, PREVIOUS_SHA: '', DRIFT_SINCE: '1000000',
    });
    const notifyLog = join(h.bin, 'notify.log');
    // One line per CALL, not per line of message. `countLines` counts lines,
    // and the stale-deployer and guard-refusal messages are multi-line — a
    // plain `cat` stub would make "how many notifications" unmeasurable.
    const notify = stub(h.bin, 'notify', `head -n1 <<< "$1" >> "${notifyLog}"`);
    const guardMarker = join(h.bin, 'guard-invoked');
    const guard = stub(h.bin, 'guard', `touch "${guardMarker}"; echo "REFUSE: stub refusal"; exit 1`);
    const deployLog = join(h.bin, 'deploy.log');
    const deploy = stub(h.bin, 'deploy', `echo called >> "${deployLog}"`);
    // Reachable only if the refusal is skipped; stubbed so this test can never
    // touch real production even then.
    const health = stub(h.bin, 'health', 'exit 0');
    const apiPort = stub(h.bin, 'api-port', 'echo 3000');
    const audit = stub(h.bin, 'audit', 'exit 0');
    // CURRENT, and it must be: a STALE verdict on the pending path is its own
    // REFUSAL (autodeploy.sh:348), which exits before the guard is consulted —
    // a different branch from the one under test. With CURRENT, any second
    // message in the log can only be an idle report that leaked onto the
    // pending path, which is exactly what this test forbids.
    const installedCheck = stub(h.bin, 'ic', 'echo "CURRENT: ok"; exit 0');

    const out = run(h, {
      WBB_NOTIFY_CMD: notify,
      WBB_GUARD: guard,
      WBB_DEPLOY_CMD: deploy,
      WBB_HEALTH_CMD: health,
      WBB_API_PORT_CMD: apiPort,
      WBB_AUDIT_CMD: audit,
      WBB_INSTALLED_CHECK: installedCheck,
      WBB_NOW_S: String(1000000 + 100000),
    });

    expect(out.code).toBe(1);
    expect(existsSync(guardMarker)).toBe(true);   // it WAS treated as work
    expect(countLines(deployLog)).toBe(0);
    // Exactly one message: the guard's verdict. No drift report, though the
    // episode is well past its grace window and would otherwise announce.
    expect(countLines(notifyLog)).toBe(1);
    expect(readFileSync(notifyLog, 'utf8')).toMatch(/REFUSED/);
    expect(readFileSync(notifyLog, 'utf8')).not.toMatch(/BLOCKED/);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts -t '#491'`

Expected: the first three FAIL (`countLines(notifyLog)` is `0` — the run exits at "already deployed" / "skipping quietly" without reporting anything). The fourth PASSES already: it pins behaviour that must survive, not behaviour that is missing.

- [ ] **Step 4: Replace the tag gate with the `pending` predicate**

Replace `deploy/autodeploy.sh:302-330` — from the `# Minor: lightweight tags sort by...` comment through the closing `fi` of the `already deployed` block — with:

```bash
# Minor: lightweight tags sort by the TAGGED COMMIT's committer date under
# -creatordate, not by when the tag was made — a tag on a backdated commit
# could then outrank a newer one, and the guard would accept a downgrade.
# Tag names are ISO-8601 timestamps, so lexical order is chronological.
tag=$(git -C "$REPO" for-each-ref --sort=-refname --format='%(refname:short)' \
        --count=1 'refs/tags/autodeploy-*')

# #491: what makes the deployer idle is having no WORK, not having no TAG.
# The old gate was `[ -n "$tag" ] || { ...report...; exit 0; }` — literally
# "no autodeploy-* tag has ever been pushed". Tags are permanent, so the first
# qualified merge turned the drift AND stale-deployer reports off forever, and
# they worked at all only because none had ever been pushed. The three
# diagnostic lines below are kept verbatim: they say different things and are
# read in the journal.
pending=""
target=""
if [ -z "$tag" ]; then
  echo "no autodeploy tag yet"
else
  target=$(git -C "$REPO" rev-parse "${tag}^{commit}")
  # C3: a tag that already failed once is not retried automatically — design
  # §7 calls for one attempt, then a human, and without this the state file
  # was written only on success, so the next tick saw the same tag and the
  # same DEPLOYED_SHA and did it all again — ~288 forced restarts a day.
  # Quiet on purpose ABOUT THE TAG: the operator was already paged when this
  # was first recorded (guard refusal / audit refusal / deploy failure /
  # rollback failure all notify before writing LAST_FAILED_SHA); a repeat
  # every 5 minutes forever is the outage this fixes. Drift is a different
  # statement about a different object, on a once-a-day cadence, and a stuck
  # tag WITH production behind main is autodeploy dead twice over.
  # Clear LAST_FAILED_SHA in the state file (or delete the file) to retry.
  if [ -n "$LAST_FAILED_SHA" ] && [ "$target" = "$LAST_FAILED_SHA" ]; then
    echo "tag $tag ($target) is recorded as LAST_FAILED_SHA in $STATE; skipping quietly"
  elif [ "$target" = "$DEPLOYED_SHA" ]; then
    echo "already deployed $target"
  else
    pending="$target"
  fi
fi

# Idle: nothing to deploy, so the two standing conditions get their once-a-day
# say. A PENDING tag deliberately reaches neither — it is about to be deployed
# or refused with its offending paths listed, and a second message about the
# same condition is noise.
[ -n "$pending" ] || { report_stale_once; report_drift_once; exit 0; }
```

Everything below this point — starting at the `# On a first run we have nothing to diff against` comment and its `[ -z "$DEPLOYED_SHA" ]` check — is unchanged and continues to use `$target`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`

Expected: PASS, all of them. Pay attention to the pre-existing `a tag equal to LAST_FAILED_SHA is skipped with exit 0 and no deploy` test: it asserts `existsSync(notifyLog)` is `false`, and it uses the shared `remoteDir` where `origin/main` IS the deployed commit's descendant. If it now fails, the drift report is firing where the old test expected silence — read the failure before changing the test; the shared fixture's `base`/`target` relationship decides whether that silence is still correct.

- [ ] **Step 6: Mutation-prove each new test**

One at a time, restore the old gate line in place of the `pending` block:

```bash
[ -n "$tag" ] || { echo "no autodeploy tag yet"; report_stale_once; report_drift_once; exit 0; }
```

Confirm the first three `#491` tests go red. Then, separately, mutate in the other direction — delete `[ -n "$pending" ] || ` so the reporters run unconditionally — and confirm the fourth test (`a PENDING tag still produces the guard verdict and NO idle report`) goes red. Restore. Record both failure messages in the commit body.

- [ ] **Step 7: Commit**

```bash
git rev-parse --show-toplevel && git branch --show-current   # must be the worktree
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "fix(#491): the deployer reports when it has no work, not when it has no tag"
```

---

### Task 3: Full suite, shellcheck, and the operator documentation

**Files:**
- Modify: `deploy/README.md:185-192` (the "watches for drift on its idle path" paragraph)

**Interfaces:**
- Consumes: the behaviour established in Tasks 1 and 2.
- Produces: nothing code depends on.

- [ ] **Step 1: Run the full suite**

Run: `npm test`

Expected: PASS. Paste the summary line into the commit body. If anything outside `scripts/autodeploy/` fails, stop and report — this change touches one shell script and one test file, so an unrelated failure is either pre-existing or a real surprise, and both need to be said out loud rather than absorbed.

- [ ] **Step 2: Lint the shell script**

Run: `shellcheck deploy/autodeploy.sh || true`

Expected: no NEW findings relative to `git stash && shellcheck deploy/autodeploy.sh; git stash pop`. If `shellcheck` is not installed, say so in the commit body rather than claiming it passed. Note `pending` and `target` are both assigned before use on every path, so `set -u` is satisfied.

- [ ] **Step 3: Update the operator documentation**

In `deploy/README.md`, the paragraph beginning "`autodeploy.sh` also watches for drift on its idle path" describes the old, narrower meaning of *idle*. Replace that paragraph's opening sentence and append a sentence naming the new definition:

```markdown
`autodeploy.sh` also watches for drift on its idle path — production falling
behind `main` in ways that would block it. **Idle means it has no work**: no
`autodeploy-*` tag exists, or the newest one is already deployed, or the newest
one is recorded as `LAST_FAILED_SHA`. It does NOT mean "no tag has ever been
pushed", which is what the condition said until #491 — and since tags are never
pruned, that turned both this report and the stale-deployer reminder off
permanently the first time one was pushed. A tag that is genuine work still
reaches neither report: it is deployed, or refused with its offending paths
listed. Drift is treated as an **episode**, not a per-tick condition: nothing is
reported for the first 15 minutes (`DRIFT_GRACE_S`), because a merge followed by
a deploy is ordinary work and needs no message at either end. Past that, one
message goes out, repeated at most once a day while the episode stays open, and
one closing message when production catches up — the closing message only if the
episode was announced. `DRIFT_SINCE` in the state file holds the episode's
start; both it and `LAST_DRIFT_NOTICE` clear when it ends. `LAST_STALE_NOTICE`
does the same job for the stale-deployer reminder.
```

- [ ] **Step 4: Verify the documentation claim against the code**

Run: `grep -n 'pending=\|\[ -n "$pending" \]' deploy/autodeploy.sh`

Expected: the three lines the README now describes (`pending=""`, `pending="$target"`, and the gate). A README that describes a predicate the code does not have is worse than the one that described the bug.

- [ ] **Step 5: Commit**

```bash
git rev-parse --show-toplevel && git branch --show-current   # must be the worktree
git add deploy/README.md
git commit -m "docs(#491): say what the deployer's idle path now means"
```

---

## Verification after merge (operator, not implementer)

Not part of the branch. Recorded here so the plan and the spec agree, and so the
step is not improvised later. The spec's "Verification in production" section is
authoritative.

- **V1** — merge this PR and let the OLD installed deployer run for ~15 minutes: the ⚠️ stale
  warning should repeat every 5 minutes. That is #497 observed, and it is the only chance to see it —
  after `install-autodeploy.sh` the deployer is no longer stale.
- **V2** — rehearse the fixed behaviour on a throwaway prefix under `./tmp/` (`XDG_STATE_HOME`,
  `XDG_DATA_HOME`, stubbed `notify`, `WBB_INSTALLED_CHECK` reporting STALE), two ticks, one message.
- **V3** — after `./deploy/deploy.sh` **and** `sudo bash deploy/install-autodeploy.sh`, push
  `autodeploy-<UTC>` at the deployed SHA, merge one Dependabot PR (#493/#494/#495), wait past the
  15-minute grace: a ⚠️ drift message must arrive **with a tag present**. Then deploy and expect
  ✅ "caught up" — and, per **#498**, one ⛔ downgrade refusal once production passes the tag.
