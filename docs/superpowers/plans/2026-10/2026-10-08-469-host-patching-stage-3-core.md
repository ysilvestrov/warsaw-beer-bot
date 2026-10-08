# #469 Stage 3 core — reboot request handoff and the alert state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the mechanism of stage 3. The bot can *ask* for a reboot by writing a request file. A root handler validates that file and acts on it, so the bot never runs a root command. An hourly job alerts the admin once per pending reboot, plus once more after each snooze.

**Architecture:**
- **Root handler.** `scripts/ops/reboot_request.py` (Python, stdlib) reads the request file and validates it.
- **Bot-side writer.** `src/jobs/reboot-request.ts` writes the file atomically.
- **Decision.** `src/domain/status/reboot-alert.ts` is a pure function: given the summary and the stored state, should an alert go out.
- **Job.** `src/jobs/reboot-alert.ts` keeps the state in `job_state` and sends through an injected function.

**Out of this plan (periphery, written after this core's review):** the Telegram buttons and their admin-only callback, the systemd path and service units, extending the installer to create `/var/lib/wbb-host-patch`, the cron line, `spec.md` and the README.

**Tech Stack:** Python 3 (stdlib), TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md` — Stage 3 and claims C13, C19, C21–C23.

## Global Constraints

- **Request file.** It lives at `/var/lib/wbb-host-patch/reboot-request`, in a directory with mode `0700` owned by `warsaw-beer-bot`. Its content is exactly one line, `now <unix>` or `0400 <unix>`, plus a trailing newline.
- **Handler checks.** The handler opens the file with `O_NOFOLLOW` and requires a regular file of at most 64 bytes. The timestamp must be at most 600 s old and at most 60 s in the future. The handler **deletes the request in every case**, valid or not, and does so before it acts.
- **Handler actions.**
  - `now` runs `systemctl reboot`.
  - `0400` runs `systemd-run --unit=wbb-reboot-0400 --on-calendar=*-*-* 04:00:00 Europe/Warsaw --timer-property=AccuracySec=1min systemctl reboot`.
  - A second `0400` while one is pending fails in systemd-run with "already loaded" (C22). The handler reports that as already scheduled and exits 0.
- **Bot writer.** The bot writes the request as a temp file in the same directory, then renames it into place (`PathChanged=` fires on the rename, C21). The file mode is `0600`.
- **Alert state.** The state lives in `job_state` under `reboot_alert` as `{ since, snoozeUntil }` in unix seconds, keyed by `reboot_required.since`. An alert goes out when:
  - a new `since` is seen, or
  - a snooze has expired while the same reboot is still pending.

  A snooze lasts 3 days. An unreadable summary sends nothing and keeps the state. When no reboot is pending, the state is cleared. The state is saved only after the send succeeds, so a failed send retries on the next tick.
- **Alert text.** It names the packages and never claims kernel coverage (C19): `🔁 Хосту потрібне перезавантаження — чекає <N днів>: <packages>.` followed by a second line, `Livepatch: <state>.`.
- **Testing.** Tests run via `npm test -- <files>`; the full gate per task is `npm test && npm run typecheck`. The Python tests run with `python3 -B -m unittest discover -s scripts/ops -p '<file>'`. CLAUDE.md test rules apply. **Never run the handler against the real host: it can reboot it.**

---

### Task 1: The root handler

**Files:**
- Create: `scripts/ops/reboot_request.py`
- Create: `scripts/ops/test_reboot_request.py`

**Interfaces:**
- Produces: the script the periphery installs as `/usr/local/libexec/wbb-reboot-request`, run by `wbb-reboot-request.service` and triggered by `wbb-reboot-request.path` (`PathChanged=/var/lib/wbb-host-patch/reboot-request`).

- [ ] **Step 1: Write the failing tests**

`scripts/ops/test_reboot_request.py`:

```python
import os
from pathlib import Path
import tempfile
import unittest

import reboot_request as rr

NOW = 1_791_461_800
REBOOT = ['systemctl', 'reboot']
AT_0400 = ['systemd-run', '--unit=wbb-reboot-0400', '--on-calendar=*-*-* 04:00:00 Europe/Warsaw',
           '--timer-property=AccuracySec=1min', 'systemctl', 'reboot']


class Recorder:
    """A fake command runner: records argv, answers (code, stderr)."""
    def __init__(self, answer=(0, '')):
        self.calls, self.answer = [], answer

    def __call__(self, argv):
        self.calls.append(argv)
        return self.answer


class Handler(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.path = self.dir / 'reboot-request'

    def tearDown(self):
        self.tmp.cleanup()

    def handle(self, content=None, runner=None, now=NOW):
        if content is not None:
            self.path.write_bytes(content)
        run = runner or Recorder()
        return rr.handle(str(self.path), run, now), run

    def test_now_reboots_and_deletes_the_request(self):
        (code, message), run = self.handle(f'now {NOW}\n'.encode())
        self.assertEqual((code, message, run.calls, self.path.exists()), (0, 'reboot now', [REBOOT], False))

    def test_0400_schedules_the_fixed_name_timer(self):
        (code, message), run = self.handle(f'0400 {NOW}\n'.encode())
        self.assertEqual((code, message, run.calls), (0, 'reboot scheduled for 04:00 Europe/Warsaw', [AT_0400]))

    def test_a_second_0400_is_already_scheduled_not_a_failure(self):
        busy = Recorder((1, 'Failed to start transient timer unit: Unit wbb-reboot-0400.timer was already loaded or has a fragment file.\n'))
        (code, message), _ = self.handle(f'0400 {NOW}\n'.encode(), busy)
        self.assertEqual((code, message), (0, 'reboot already scheduled for 04:00'))

    def test_any_other_systemd_run_failure_fails(self):
        (code, message), _ = self.handle(f'0400 {NOW}\n'.encode(), Recorder((1, 'Failed to connect to bus\n')))
        self.assertEqual((code, message), (1, 'systemd-run failed: Failed to connect to bus'))

    def test_a_request_exactly_600_seconds_old_is_accepted(self):
        (code, _), run = self.handle(f'now {NOW - 600}\n'.encode())
        self.assertEqual((code, run.calls), (0, [REBOOT]))

    def test_a_request_601_seconds_old_is_refused_and_deleted(self):
        (code, message), run = self.handle(f'now {NOW - 601}\n'.encode())
        self.assertEqual((code, message, run.calls, self.path.exists()), (1, 'refused: stale or future request', [], False))

    def test_a_request_more_than_60_seconds_in_the_future_is_refused(self):
        (code, _), run = self.handle(f'now {NOW + 61}\n'.encode())
        self.assertEqual((code, run.calls), (1, []))

    def test_a_request_60_seconds_in_the_future_is_accepted(self):
        (code, _), run = self.handle(f'now {NOW + 60}\n'.encode())
        self.assertEqual((code, run.calls), (0, [REBOOT]))

    def test_unknown_content_is_refused_and_deleted(self):
        for content in (b'reboot now\n', f'now {NOW} extra\n'.encode(), f'NOW {NOW}\n'.encode(), b'', f'now {NOW}\nnow {NOW}\n'.encode()):
            with self.subTest(content=content):
                (code, message), run = self.handle(content)
                self.assertEqual((code, message, run.calls, self.path.exists()), (1, 'refused: unknown content', [], False))

    def test_a_request_over_64_bytes_is_refused_and_deleted(self):
        (code, message), run = self.handle(b'now ' + b'1' * 61 + b'\n')
        self.assertEqual((code, message, run.calls, self.path.exists()), (1, 'refused: not a small regular file', [], False))

    def test_a_symlinked_request_is_refused_its_link_removed_and_its_target_untouched(self):
        target = self.dir / 'target'
        target.write_text(f'now {NOW}\n')
        self.path.symlink_to(target)
        (code, message), run = self.handle()
        self.assertEqual((code, message, run.calls, os.path.lexists(self.path), target.read_text()),
                         (1, 'refused: not a small regular file', [], False, f'now {NOW}\n'))

    def test_a_directory_in_its_place_is_refused(self):
        self.path.mkdir()
        (code, message), run = self.handle()
        self.assertEqual((code, message, run.calls), (1, 'refused: not a small regular file', []))

    def test_no_request_is_a_quiet_no_op(self):
        # PathChanged can fire again after the handler's own delete.
        (code, message), run = self.handle()
        self.assertEqual((code, message, run.calls), (0, 'no request', []))


if __name__ == '__main__':
    unittest.main()
```

The `subTest` loop iterates over fixed content values; there is no branching on results, so the test still has one deterministic path per case.

Run: `python3 -B -m unittest discover -s scripts/ops -p 'test_reboot_request.py' -v`
Expected: ERROR — `ModuleNotFoundError: No module named 'reboot_request'`.

- [ ] **Step 2: Write the handler**

`scripts/ops/reboot_request.py`:

```python
#!/usr/bin/env python3
"""#469 stage 3: act on the bot's reboot request — the bot asks, root decides.

The bot writes /var/lib/wbb-host-patch/reboot-request ("now <unix>" or "0400 <unix>");
wbb-reboot-request.path starts this as root. The request is deleted in every case before
anything is done, so a refused or repeated request is never acted on twice. A compromised
bot can at worst reboot the host; it gains no root command.
Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 3).
"""
import argparse
import os
import re
import stat
import subprocess
import sys
import time

REQUEST = '/var/lib/wbb-host-patch/reboot-request'
MAX_BYTES = 64
MAX_AGE_SECONDS = 600
FUTURE_SKEW_SECONDS = 60
LINE = re.compile(rb'\A(now|0400) (\d{1,12})\n?\Z')
REBOOT = ['systemctl', 'reboot']
# The fixed unit name makes a second press harmless: systemd-run refuses a loaded unit (C22).
AT_0400 = ['systemd-run', '--unit=wbb-reboot-0400', '--on-calendar=*-*-* 04:00:00 Europe/Warsaw',
           '--timer-property=AccuracySec=1min', 'systemctl', 'reboot']
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}


def run(argv):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60, env=ENV)
    return result.returncode, result.stderr


def take(path):
    """The request's bytes, or None for anything but a small regular file. Deletes it either way."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return b''  # nothing there: the caller tells "no request" from "refused" by existence
    except OSError:
        fd = None  # a symlink (ELOOP), a directory, …
    try:
        if fd is None:
            return None
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            return None
        return os.read(fd, MAX_BYTES + 1)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(path)  # never follows a symlink: removes the link, not its target
        except (FileNotFoundError, IsADirectoryError, PermissionError):
            pass


def handle(path, run_command, now):
    """(exit code, journal message)."""
    if not os.path.lexists(path):
        return 0, 'no request'
    data = take(path)
    if data is None:
        return 1, 'refused: not a small regular file'
    m = LINE.match(data)
    if m is None:
        return 1, 'refused: unknown content'
    kind, at = m.group(1).decode(), int(m.group(2))
    if not (now - MAX_AGE_SECONDS <= at <= now + FUTURE_SKEW_SECONDS):
        return 1, 'refused: stale or future request'
    if kind == 'now':
        code, err = run_command(REBOOT)
        return (0, 'reboot now') if code == 0 else (1, f'systemctl reboot failed: {err.strip()}')
    code, err = run_command(AT_0400)
    if code == 0:
        return 0, 'reboot scheduled for 04:00 Europe/Warsaw'
    if 'already loaded' in err:
        return 0, 'reboot already scheduled for 04:00'
    return 1, f'systemd-run failed: {err.strip()}'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', default=REQUEST, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    code, message = handle(args.path, run, int(time.time()))
    print(f'wbb-reboot-request: {message}', file=sys.stderr if code else sys.stdout)
    return code


if __name__ == '__main__':
    raise SystemExit(main())
```

Note that `IsADirectoryError` is caught on `unlink` because a directory in the request's place cannot be unlinked; the test only asserts the refusal for that case.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `python3 -B -m unittest discover -s scripts/ops -p 'test_reboot_request.py' -v`
Expected: OK.

Mutation checks. For each one, make the change, see the named test fail, then revert:
- move the `os.unlink` out of `finally` (call it only after a successful read) → `test_a_request_over_64_bytes_is_refused_and_deleted`;
- `now - MAX_AGE_SECONDS <= at` → `<` → `test_a_request_exactly_600_seconds_old_is_accepted`;
- drop `os.O_NOFOLLOW` → `test_a_symlinked_request_is_refused_…`;
- remove the `'already loaded'` branch → `test_a_second_0400_is_already_scheduled_not_a_failure`.

- [ ] **Step 4: Full gate and commit**

Run: `npm test && npm run typecheck` (`scripts/ops.test.ts` runs every `scripts/ops/test_*.py`).

```bash
git add scripts/ops/reboot_request.py scripts/ops/test_reboot_request.py
git commit -m "feat(ops): root reboot-request handler — validates, deletes, then reboots or schedules 04:00 (#469)"
```

---

### Task 2: The bot-side writer and the alert decision

**Files:**
- Create: `src/jobs/reboot-request.ts`, `src/jobs/reboot-request.test.ts`
- Create: `src/domain/status/reboot-alert.ts`, `src/domain/status/reboot-alert.test.ts`

**Interfaces:**
- Consumes: `HostPatchRead` (`src/jobs/host-patch.ts`), `ukDays` (`src/domain/status/helpers.ts`).
- Produces:
  - `writeRebootRequest(kind: RebootKind, now: Date, dir?: string): void`, where `RebootKind = 'now' | '0400'`;
  - `REBOOT_REQUEST_DIR`;
  - `RebootAlertState = { since: number; snoozeUntil: number | null }`;
  - `decideRebootAlert(hp: HostPatchRead, prev: RebootAlertState | null, now: Date): RebootDecision`;
  - `snoozeRebootAlert(state: RebootAlertState, now: Date): RebootAlertState`;
  - `REBOOT_SNOOZE_SECONDS`.

- [ ] **Step 1: Write the failing tests**

`src/jobs/reboot-request.test.ts`:

```ts
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeRebootRequest } from './reboot-request';

/** #469 stage 3 — the bot asks; root (scripts/ops/reboot_request.py) decides. */
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wbb-reboot-request-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date(1_791_461_800_000);

describe('writeRebootRequest', () => {
  it.each(['now', '0400'] as const)('writes "%s <unix>" with a newline, mode 0600', (kind) => {
    writeRebootRequest(kind, NOW, dir);
    const file = join(dir, 'reboot-request');
    expect([readFileSync(file, 'utf8'), statSync(file).mode & 0o777]).toEqual([`${kind} 1791461800\n`, 0o600]);
  });

  it('leaves no temp file behind', () => {
    writeRebootRequest('now', NOW, dir);
    expect(readdirSync(dir)).toEqual(['reboot-request']);
  });

  it('replaces a request already waiting', () => {
    writeFileSync(join(dir, 'reboot-request'), 'now 1\n');
    writeRebootRequest('0400', NOW, dir);
    expect(readFileSync(join(dir, 'reboot-request'), 'utf8')).toBe('0400 1791461800\n');
  });

  it('throws when the directory does not exist (the caller tells the admin)', () => {
    expect(() => writeRebootRequest('now', NOW, join(dir, 'missing'))).toThrow();
  });
});
```

`src/domain/status/reboot-alert.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HostPatchFacts } from './types';
import type { HostPatchRead } from '../../jobs/host-patch';
import { decideRebootAlert, snoozeRebootAlert } from './reboot-alert';

/** #469 stage 3 — spec "Immediate alert", claims C19/C23. */
const DAY = 86_400;
const T = 1_791_461_800;
const NOW = new Date(T * 1000);
const SINCE = T - 4 * DAY;
const FACTS: HostPatchFacts = {
  timestamp: T - 600,
  kernel: { running: '6.8.0-142-generic', newestInstalled: '6.8.0-142-generic' },
  rebootRequired: { since: SINCE, packages: ['libc6', 'dbus'] },
  livepatch: { state: 'nothing-to-apply', upgradeRequiredDate: '2027-10-02' },
  staleServices: [],
  unattended: { lastRun: T - 3600, securityPending: 0 },
  packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' },
};
const ok = (patch: Partial<HostPatchFacts> = {}): HostPatchRead => ({ kind: 'ok', facts: { ...FACTS, ...patch } });
const TEXT = '🔁 Хосту потрібне перезавантаження — чекає 4 дні: libc6, dbus.\nLivepatch: nothing-to-apply.';

describe('decideRebootAlert', () => {
  it('a newly pending reboot is alerted once', () => {
    expect(decideRebootAlert(ok(), null, NOW)).toEqual({ send: true, text: TEXT, state: { since: SINCE, snoozeUntil: null } });
  });

  it('the same pending reboot is not alerted again', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: null }, NOW))
      .toEqual({ send: false, state: { since: SINCE, snoozeUntil: null } });
  });

  it('a different since is a new reboot and is alerted', () => {
    expect(decideRebootAlert(ok(), { since: SINCE - DAY, snoozeUntil: null }, NOW).send).toBe(true);
  });

  it('an expired snooze alerts again and clears the snooze', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T }, NOW))
      .toEqual({ send: true, text: TEXT, state: { since: SINCE, snoozeUntil: null } });
  });

  it('a snooze one second from expiry stays quiet', () => {
    expect(decideRebootAlert(ok(), { since: SINCE, snoozeUntil: T + 1 }, NOW))
      .toEqual({ send: false, state: { since: SINCE, snoozeUntil: T + 1 } });
  });

  it('no pending reboot clears the state', () => {
    expect(decideRebootAlert(ok({ rebootRequired: null }), { since: SINCE, snoozeUntil: null }, NOW))
      .toEqual({ send: false, state: null });
  });

  it.each([{ kind: 'stale' }, { kind: 'unavailable' }] as const)('an unreadable summary (%j) sends nothing and keeps the state', (hp) => {
    expect(decideRebootAlert(hp, { since: SINCE, snoozeUntil: null }, NOW))
      .toEqual({ send: false, state: { since: SINCE, snoozeUntil: null } });
  });

  it('says "нема даних" for an unreadable Livepatch and names no kernel', () => {
    expect(decideRebootAlert(ok({ livepatch: null, rebootRequired: { since: SINCE, packages: [] } }), null, NOW)).toEqual({
      send: true,
      text: '🔁 Хосту потрібне перезавантаження — чекає 4 дні.\nLivepatch: нема даних.',
      state: { since: SINCE, snoozeUntil: null },
    });
  });
});

describe('snoozeRebootAlert', () => {
  it('snoozes for exactly 3 days from now', () => {
    expect(snoozeRebootAlert({ since: SINCE, snoozeUntil: null }, NOW)).toEqual({ since: SINCE, snoozeUntil: T + 3 * DAY });
  });
});
```

Run: `npm test -- src/jobs/reboot-request.test.ts src/domain/status/reboot-alert.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 2: Implement**

`src/jobs/reboot-request.ts`:

```ts
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// #469 stage 3: the bot ASKS for a reboot; root acts (scripts/ops/reboot_request.py, run by
// wbb-reboot-request.path on PathChanged). Temp file + rename: the handler never sees a half
// write, and PathChanged fires on the rename (spec C21).
export const REBOOT_REQUEST_DIR = '/var/lib/wbb-host-patch';
export type RebootKind = 'now' | '0400';

export function writeRebootRequest(kind: RebootKind, now: Date, dir = REBOOT_REQUEST_DIR): void {
  const temp = join(dir, `.reboot-request.${process.pid}`);
  writeFileSync(temp, `${kind} ${Math.floor(now.getTime() / 1000)}\n`, { mode: 0o600 });
  renameSync(temp, join(dir, 'reboot-request'));
}
```

`src/domain/status/reboot-alert.ts`:

```ts
import type { HostPatchRead } from '../../jobs/host-patch';
import { ukDays } from './helpers';

// #469 stage 3 — one alert per pending reboot (keyed by reboot_required.since, which the collector
// carries forward and resets only at boot, C19/C23), and one more after each snooze expires.
export interface RebootAlertState { since: number; snoozeUntil: number | null } // unix seconds
export type RebootDecision =
  | { send: true; text: string; state: RebootAlertState }
  | { send: false; state: RebootAlertState | null };
export const REBOOT_SNOOZE_SECONDS = 3 * 86_400;

// Names the packages and never claims the kernel: under Livepatch, kernel packages do not set
// the reboot flag (C19), so what is pending here is a library such as libc6 or dbus.
function alertText(since: number, packages: string[], livepatch: string | null, nowSeconds: number): string {
  const waited = ukDays(Math.floor((nowSeconds - since) / 86_400));
  const list = packages.length === 0 ? '' : `: ${packages.join(', ')}`;
  return `🔁 Хосту потрібне перезавантаження — чекає ${waited}${list}.\nLivepatch: ${livepatch ?? 'нема даних'}.`;
}

export function decideRebootAlert(hp: HostPatchRead, prev: RebootAlertState | null, now: Date): RebootDecision {
  // Unreadable: say nothing (the daily status already reports «нема даних») and forget nothing.
  if (hp.kind !== 'ok') return { send: false, state: prev };
  const pending = hp.facts.rebootRequired;
  if (pending === null) return { send: false, state: null };
  const t = Math.floor(now.getTime() / 1000);
  const fresh = prev === null || prev.since !== pending.since;
  const snoozeOver = !fresh && prev!.snoozeUntil !== null && t >= prev!.snoozeUntil;
  if (!fresh && !snoozeOver) return { send: false, state: prev };
  return {
    send: true,
    text: alertText(pending.since, pending.packages, hp.facts.livepatch?.state ?? null, t),
    state: { since: pending.since, snoozeUntil: null },
  };
}

export function snoozeRebootAlert(state: RebootAlertState, now: Date): RebootAlertState {
  return { ...state, snoozeUntil: Math.floor(now.getTime() / 1000) + REBOOT_SNOOZE_SECONDS };
}
```

Run: `npm test -- src/jobs/reboot-request.test.ts src/domain/status/reboot-alert.test.ts`
Expected: PASS.

Mutation checks. Make each change, see the named test fail, then revert:
- `t >= prev!.snoozeUntil` → `>` → "an expired snooze alerts again and clears the snooze";
- drop the `prev.since !== pending.since` clause → "a different since is a new reboot and is alerted";
- `return { send: false, state: prev }` for unreadable → `state: null` → "an unreadable summary … keeps the state".

- [ ] **Step 3: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/jobs/reboot-request.ts src/jobs/reboot-request.test.ts src/domain/status/reboot-alert.ts src/domain/status/reboot-alert.test.ts
git commit -m "feat(status): reboot request writer and the one-alert-per-reboot decision (#469)"
```

---

### Task 3: The hourly alert job

**Files:**
- Create: `src/jobs/reboot-alert.ts`, `src/jobs/reboot-alert.test.ts`

**Interfaces:**
- Consumes:
  - `readHostPatch` (`src/jobs/host-patch.ts`);
  - `decideRebootAlert`, `snoozeRebootAlert`, `RebootAlertState` (Task 2);
  - `getJobState`, `setJobState` (`src/storage/job_state.ts`).
- Produces (the periphery wires these to cron and to the Telegram buttons):
  - `rebootAlert(deps: RebootAlertDeps): Promise<void>`;
  - `snoozeRebootAlertNow(db: DB, now: Date): boolean`;
  - `REBOOT_ALERT_KEY = 'reboot_alert'`;
  - `RebootAlertDeps = { db; log; send: (text: string) => Promise<void>; now?: () => Date; hostPatchPath?: string; hostPatchUid?: number }`.

- [ ] **Step 1: Write the failing tests**

`src/jobs/reboot-alert.test.ts`:

```ts
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../storage/db';
import { migrate } from '../storage/schema';
import { getJobState, setJobState } from '../storage/job_state';
import { REBOOT_ALERT_KEY, rebootAlert, snoozeRebootAlertNow } from './reboot-alert';

/** #469 stage 3. The summary is written to a temp dir; no test reads the real host path. */
const log = pino({ level: 'silent' });
const DAY = 86_400;
const T = 1_791_461_800;
const NOW = new Date(T * 1000);
const SINCE = T - 4 * DAY;
let db: DB;
let dir: string;
let path: string;

function summary(rebootRequired: { since: number; packages: string[] } | null) {
  writeFileSync(path, JSON.stringify({
    version: 1, timestamp: T - 600,
    kernel: { running: '6.8.0-142-generic', newest_installed: '6.8.0-142-generic' },
    reboot_required: rebootRequired,
    livepatch: { state: 'nothing-to-apply', upgrade_required_date: '2027-10-02' },
    stale_services: [], unattended: { last_run: T - 3600, security_pending: 0 },
    packages: { nodejs: '24.21.0-1nodesource1', cloudflared: '2026.10.0', litestream: '0.5.17' },
  }), { mode: 0o644 });
  chmodSync(path, 0o644);
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  dir = mkdtempSync(join(tmpdir(), 'wbb-reboot-alert-'));
  chmodSync(dir, 0o755);
  path = join(dir, 'summary.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(sent: string[], opts: { now?: Date; fail?: boolean } = {}) {
  return rebootAlert({
    db, log, now: () => opts.now ?? NOW, hostPatchPath: path, hostPatchUid: process.getuid!(),
    send: async (text) => { if (opts.fail) throw new Error('telegram down'); sent.push(text); },
  });
}

describe('rebootAlert', () => {
  it('alerts a pending reboot once across two ticks', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    const sent: string[] = [];
    await run(sent);
    await run(sent);
    expect(sent).toEqual(['🔁 Хосту потрібне перезавантаження — чекає 4 дні: libc6.\nLivepatch: nothing-to-apply.']);
  });

  it('a failed send saves nothing, so the next tick retries', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    await run([], { fail: true });
    const sent: string[] = [];
    await run(sent);
    expect([getJobState(db, REBOOT_ALERT_KEY), sent.length]).toEqual([JSON.stringify({ since: SINCE, snoozeUntil: null }), 1]);
  });

  it('a snooze silences the reboot for 3 days, then it is alerted again', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    await run([]);
    expect(snoozeRebootAlertNow(db, NOW)).toBe(true);
    const quiet: string[] = [];
    await run(quiet, { now: new Date((T + 3 * DAY - 1) * 1000) });
    const again: string[] = [];
    await run(again, { now: new Date((T + 3 * DAY) * 1000) });
    expect([quiet.length, again.length]).toEqual([0, 1]);
  });

  it('nothing to snooze when no alert is pending', () => {
    expect(snoozeRebootAlertNow(db, NOW)).toBe(false);
  });

  it('clears its state when no reboot is pending', async () => {
    setJobState(db, REBOOT_ALERT_KEY, JSON.stringify({ since: SINCE, snoozeUntil: null }));
    summary(null);
    await run([]);
    expect(getJobState(db, REBOOT_ALERT_KEY)).toBe(null);
  });

  it('a corrupt stored state reads as no state: the reboot is alerted', async () => {
    setJobState(db, REBOOT_ALERT_KEY, '{');
    summary({ since: SINCE, packages: [] });
    const sent: string[] = [];
    await run(sent);
    expect(sent.length).toBe(1);
  });
});
```

Run: `npm test -- src/jobs/reboot-alert.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 2: Implement**

`src/jobs/reboot-alert.ts`:

```ts
import type pino from 'pino';
import type { DB } from '../storage/db';
import { deleteJobState, getJobState, setJobState } from '../storage/job_state';
import { readHostPatch } from './host-patch';
import { decideRebootAlert, snoozeRebootAlert, type RebootAlertState } from '../domain/status/reboot-alert';

// #469 stage 3: hourly — alert the admin once per pending reboot (and again after a snooze).
// State is saved only after the message went out: a failed send retries on the next tick.
export const REBOOT_ALERT_KEY = 'reboot_alert';

function readState(db: DB): RebootAlertState | null {
  const raw = getJobState(db, REBOOT_ALERT_KEY);
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as { since?: unknown; snoozeUntil?: unknown };
    return Number.isSafeInteger(p.since) && (p.snoozeUntil === null || Number.isSafeInteger(p.snoozeUntil))
      ? { since: p.since as number, snoozeUntil: p.snoozeUntil as number | null }
      : null;
  } catch {
    return null; // corrupt: treat as never alerted — one extra alert beats a silent pending reboot
  }
}

function writeState(db: DB, state: RebootAlertState | null): void {
  if (state === null) deleteJobState(db, REBOOT_ALERT_KEY);
  else setJobState(db, REBOOT_ALERT_KEY, JSON.stringify(state));
}

export interface RebootAlertDeps {
  db: DB;
  log: pino.Logger;
  send: (text: string) => Promise<void>;
  now?: () => Date;
  hostPatchPath?: string;
  hostPatchUid?: number;
}

export async function rebootAlert(deps: RebootAlertDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const prev = readState(deps.db);
  const decision = decideRebootAlert(readHostPatch(now, deps.hostPatchPath, deps.hostPatchUid), prev, now);
  if (!decision.send) {
    if (decision.state !== prev) writeState(deps.db, decision.state);
    return;
  }
  await deps.send(decision.text); // throws → nothing saved → the next tick retries
  writeState(deps.db, decision.state);
}

/** The «Нагадати через 3 дні» button. False when there is no alerted reboot to snooze. */
export function snoozeRebootAlertNow(db: DB, now: Date): boolean {
  const state = readState(db);
  if (state === null) return false;
  writeState(db, snoozeRebootAlert(state, now));
  return true;
}
```

Run: `npm test -- src/jobs/reboot-alert.test.ts`
Expected: PASS.

Mutation checks. For each, make the change, see the named test fail, then revert:
- move `writeState(...)` above `await deps.send(...)` → "a failed send saves nothing, so the next tick retries";
- make `snoozeRebootAlertNow` return `true` when the state is null → "nothing to snooze when no alert is pending".

- [ ] **Step 3: Full gate and commit**

Run: `npm test && npm run typecheck`

```bash
git add src/jobs/reboot-alert.ts src/jobs/reboot-alert.test.ts
git commit -m "feat(status): hourly reboot alert job — one alert per pending reboot, snooze, retry on failed send (#469)"
```

---

## After the core: end-to-end review, then the periphery plan

The periphery covers:
- the Telegram message with three inline buttons and an admin-only callback. «Зараз» and «О 04:00» call `writeRebootRequest`; «Нагадати через 3 дні» calls `snoozeRebootAlertNow`;
- `send` wired to `bot.telegram.sendMessage` with the keyboard;
- the hourly cron line;
- `wbb-reboot-request.path` and `.service`, plus the installer creating `/var/lib/wbb-host-patch` (`0700`, `warsaw-beer-bot`) and installing `reboot_request.py` to `/usr/local/libexec/wbb-reboot-request`. The new script joins the hold paths, as the collector did;
- `spec.md` and the README;
- a `[deploy:hold]` PR.
