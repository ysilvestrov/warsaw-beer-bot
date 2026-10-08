# #469 Host patching — Stage 3 periphery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the stage-3 core (PR #807) into the host and the bot: root units + installer for the reboot-request handler, the admin's three Telegram buttons, and the hourly alert tick.

**Architecture:** Root side — `wbb-reboot-request.path` (`PathChanged=`) starts the oneshot `wbb-reboot-request.service`, which runs the installed copy of `scripts/ops/reboot_request.py`; `deploy/install-reboot-request.sh` installs both and creates the bot-owned `0700` request directory. Bot side — a `rb:<kind>:<since>` callback composer decides each press with a pure function, and an in-flight-guarded hourly tick runs `rebootAlert`, whose `send` now receives the `since` so the keyboard can carry it.

**Tech Stack:** TypeScript, Telegraf, Vitest, bash, systemd.

**Spec:** `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md` (§Stage 3, claims C21–C24). Core plan: `docs/superpowers/plans/2026-10/2026-10-08-469-host-patching-stage-3-core.md`.

## Global Constraints

- Callback data: `rb:now:<since>`, `rb:0400:<since>`, `rb:snooze:<since>`; `<since>` is the unix-seconds `reboot_required.since` (≤ 12 digits; whole string < 64 bytes).
- Button labels: «Зараз», «О 04:00», «Нагадати через 3 дні».
- The admin check runs FIRST: `ctx.chat?.type === 'private' && String(ctx.from.id) === ctx.deps.env.ADMIN_TELEGRAM_ID`. A non-admin gets the toast «Лише для адміністратора.» and nothing else happens.
- «Зараз»/«О 04:00» write a request ONLY when the press's `since` equals the current ok summary's `reboot_required.since`. Replies say «запит надіслано», never «перезавантажуюсь» (root may refuse).
- Request directory `/var/lib/wbb-host-patch`: `0700`, owned `warsaw-beer-bot:warsaw-beer-bot`.
- Installed handler: `/usr/local/libexec/wbb-reboot-request` (0755); units `/etc/systemd/system/wbb-reboot-request.{path,service}` (0644).
- `wbb-reboot-request.service`: `Type=oneshot`, `TimeoutStartSec=2min`, runs `/usr/bin/python3 -I -B /usr/local/libexec/wbb-reboot-request`.
- `scripts/ops/reboot_request.py` becomes a hold path in BOTH `deploy/autodeploy.sh` `path_is_held` and `scripts/autodeploy/deploy-hold-check.ts` `HELD_EXACT` (a parity test pins them).
- Hourly alert tick at `'10 * * * *'`, scheduled only when `ADMIN_TELEGRAM_ID` is set, with an in-flight guard; a thrown `rebootAlert` is caught and logged.
- The PR is `[deploy:hold]` + label `deploy:hold`.
- Tests: `npm test -- <files>`; full gate per task: `npm test && npm run typecheck`. Exact asserts, no conditionals, no tautologies.

---

### Task 1: Root side — units, installer, hold path

**Files:**
- Create: `deploy/wbb-reboot-request.path`
- Create: `deploy/wbb-reboot-request.service`
- Create: `deploy/install-reboot-request.sh`
- Create: `scripts/autodeploy/install-reboot-request.test.ts`
- Modify: `deploy/autodeploy.sh` (`path_is_held`, after the `host_patch_collect.py` line)
- Modify: `scripts/autodeploy/deploy-hold-check.ts` (`HELD_EXACT`)
- Modify: `scripts/autodeploy/deploy-hold-check.test.ts` (`TABLE`)

**Interfaces:**
- Consumes: `scripts/ops/reboot_request.py` (exists; default request path `/var/lib/wbb-host-patch/reboot-request`).
- Produces: the installer and unit names used by Task 3's README/host steps.

- [ ] **Step 1: Write the units**

`deploy/wbb-reboot-request.path`:
```ini
[Unit]
Description=#469 stage 3: watch for the bot's reboot request

[Path]
# Fires on a direct write and on the bot's temp+rename, and re-arms after each request (spec C21).
PathChanged=/var/lib/wbb-host-patch/reboot-request
Unit=wbb-reboot-request.service

[Install]
WantedBy=paths.target
```

`deploy/wbb-reboot-request.service`:
```ini
[Unit]
Description=#469 stage 3: act on the bot's reboot request (the bot asks, root decides)

[Service]
Type=oneshot
# The handler deletes the request first, validates it, and acts only while /run/reboot-required
# exists (spec C24). Its own delete re-fires PathChanged; that run finds no request and exits 0.
ExecStart=/usr/bin/python3 -I -B /usr/local/libexec/wbb-reboot-request
TimeoutStartSec=2min
```

- [ ] **Step 2: Write the failing installer test**

`scripts/autodeploy/install-reboot-request.test.ts`:
```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** #469 stage 3 periphery — spec 2026-10-06-469-host-patching-design.md (Stage 3). */
const REPO = resolve(__dirname, '../..');
const SCRIPT = join(REPO, 'deploy/install-reboot-request.sh');

interface Host { root: string; bin: string; log: string }

function host(opts: { uid?: string } = {}): Host {
  const dir = makeTempDirectory('wbb-reboot-request-');
  const root = join(dir, 'root');
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  mkdirSync(join(root, 'var/lib'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub('id', `echo ${opts.uid ?? '0'}`);
  stub('systemctl', `echo "systemctl $*" >> "${log}"`);
  // chown needs root; the stub records the call (as `chown <owner> <path relative to the host root>`).
  stub('chown', `echo "chown $1 \${2#${root}}" >> "${log}"`);
  return { root, bin, log };
}

function run(h: Host, opts: { hostRoot?: boolean; cwd?: string } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${h.bin}:${process.env.PATH}`, WBB_HOST_ROOT: h.root };
  if (opts.hostRoot === false) delete env.WBB_HOST_ROOT;
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env, cwd: opts.cwd ?? REPO });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const calls = (h: Host) => readFileSync(h.log, 'utf8').trim().split('\n').filter((l) => l !== '');
const at = (h: Host, p: string) => join(h.root, p);
const mode = (p: string) => statSync(p).mode & 0o7777;

const HANDLER = 'usr/local/libexec/wbb-reboot-request';
const PATH_UNIT = 'etc/systemd/system/wbb-reboot-request.path';
const SERVICE = 'etc/systemd/system/wbb-reboot-request.service';
const DIR = 'var/lib/wbb-host-patch';

describe('install-reboot-request — a clean host', () => {
  it('installs the handler 0755 and both units 0644, byte for byte', () => {
    const h = host();
    expect(run(h).code).toBe(0);
    expect(readFileSync(at(h, HANDLER))).toEqual(readFileSync(join(REPO, 'scripts/ops/reboot_request.py')));
    expect(readFileSync(at(h, PATH_UNIT))).toEqual(readFileSync(join(REPO, 'deploy/wbb-reboot-request.path')));
    expect(readFileSync(at(h, SERVICE))).toEqual(readFileSync(join(REPO, 'deploy/wbb-reboot-request.service')));
    expect([mode(at(h, HANDLER)), mode(at(h, PATH_UNIT)), mode(at(h, SERVICE))]).toEqual([0o755, 0o644, 0o644]);
  });

  it('creates the request directory 0700 and hands it to the bot user', () => {
    const h = host();
    run(h);
    expect([statSync(at(h, DIR)).isDirectory(), mode(at(h, DIR))]).toEqual([true, 0o700]);
    expect(calls(h)[0]).toBe('chown warsaw-beer-bot:warsaw-beer-bot /var/lib/wbb-host-patch');
  });

  it('chowns, reloads, enables and re-arms the path unit, in that order', () => {
    const h = host();
    run(h);
    expect(calls(h)).toEqual([
      'chown warsaw-beer-bot:warsaw-beer-bot /var/lib/wbb-host-patch',
      'systemctl daemon-reload',
      'systemctl enable --now wbb-reboot-request.path',
      'systemctl restart wbb-reboot-request.path',
    ]);
  });

  it('runs from any directory, not only the repo root', () => {
    const h = host();
    const elsewhere = makeTempDirectory('wbb-reboot-request-cwd-');
    expect(run(h, { cwd: elsewhere }).code).toBe(0);
    expect(readFileSync(at(h, HANDLER))).toEqual(readFileSync(join(REPO, 'scripts/ops/reboot_request.py')));
  });

  it('re-asserts 0700 on an existing directory (a widened mode is repaired)', () => {
    const h = host();
    mkdirSync(at(h, DIR));
    chmodSync(at(h, DIR), 0o755);
    expect(run(h).code).toBe(0);
    expect(mode(at(h, DIR))).toBe(0o700);
  });

  it('is idempotent', () => {
    const h = host();
    expect([run(h).code, run(h).code]).toEqual([0, 0]);
    expect(mode(at(h, DIR))).toBe(0o700);
  });
});

describe('install-reboot-request — refusals change nothing', () => {
  it('refuses without root', () => {
    const h = host({ uid: '1000' });
    const r = run(h, { hostRoot: false });
    expect([r.code, r.err.includes('run as root'), existsSync(at(h, HANDLER)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a request directory that is a symlink', () => {
    const h = host();
    mkdirSync(at(h, 'elsewhere'));
    symlinkSync(at(h, 'elsewhere'), at(h, DIR));
    const r = run(h);
    expect([r.code, r.err.includes('/var/lib/wbb-host-patch'), existsSync(at(h, HANDLER)), calls(h)]).toEqual([1, true, false, []]);
  });

  it('refuses a request directory that is a plain file', () => {
    const h = host();
    writeFileSync(at(h, DIR), 'x');
    const r = run(h);
    expect([r.code, r.err.includes('/var/lib/wbb-host-patch'), existsSync(at(h, HANDLER)), calls(h)]).toEqual([1, true, false, []]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- scripts/autodeploy/install-reboot-request.test.ts`
Expected: FAIL (the installer does not exist; `code` is 127).

- [ ] **Step 4: Write the installer**

`deploy/install-reboot-request.sh`:
```bash
#!/usr/bin/env bash
# #469 stage 3 — install the root handler for the bot's reboot request.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md (Stage 3)
#
# Run from anywhere:   sudo bash deploy/install-reboot-request.sh
#
# Installs scripts/ops/reboot_request.py as /usr/local/libexec/wbb-reboot-request,
# wbb-reboot-request.path + .service, creates /var/lib/wbb-host-patch (0700, owned by the bot
# user, which writes the request into it) and enables the path unit. Idempotent. A refused run
# changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-reboot-request.sh" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

DIR=/var/lib/wbb-host-patch
# /var/lib is root-only, so nobody else can plant this path; still, never chown or chmod
# through a symlink or onto a file.
if [ -L "$R$DIR" ] || { [ -e "$R$DIR" ] && [ ! -d "$R$DIR" ]; }; then
  echo "ERROR: $DIR exists and is not a directory — remove it (sudo rm -rf $DIR) and re-run. Nothing was changed." >&2
  exit 1
fi

install -d "$R/usr/local/libexec" "$R/etc/systemd/system"
install -m 0755 scripts/ops/reboot_request.py       "$R/usr/local/libexec/wbb-reboot-request"
install -m 0644 deploy/wbb-reboot-request.path      "$R/etc/systemd/system/wbb-reboot-request.path"
install -m 0644 deploy/wbb-reboot-request.service   "$R/etc/systemd/system/wbb-reboot-request.service"
[ -e "$R$DIR" ] || mkdir "$R$DIR"
chmod 0700 "$R$DIR"
chown warsaw-beer-bot:warsaw-beer-bot "$R$DIR"

systemctl daemon-reload
systemctl enable --now wbb-reboot-request.path
# enable --now does not re-arm an already active unit: a changed path unit needs the restart.
systemctl restart wbb-reboot-request.path

echo
echo "== installed =="
echo "  /usr/local/libexec/wbb-reboot-request"
echo "  /etc/systemd/system/wbb-reboot-request.{path,service}"
echo "  $DIR (0700, warsaw-beer-bot)"
```

- [ ] **Step 5: Run the installer test to verify it passes**

Run: `npm test -- scripts/autodeploy/install-reboot-request.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Make the handler a hold path (failing test first)**

In `scripts/autodeploy/deploy-hold-check.test.ts`, add to `TABLE` right after `['scripts/ops/host_patch_collect.py', true],`:
```ts
  ['scripts/ops/reboot_request.py', true],
```
Run: `npm test -- scripts/autodeploy/deploy-hold-check.test.ts` → FAIL on both `%s → %s` and the parity row for the new path.

In `scripts/autodeploy/deploy-hold-check.ts` `HELD_EXACT`, after the `host_patch_collect.py` entry:
```ts
  // #469 stage 3: root runs the installed copy; re-run deploy/install-reboot-request.sh
  'scripts/ops/reboot_request.py',
```
In `deploy/autodeploy.sh` `path_is_held`, after the `scripts/ops/host_patch_collect.py) return 0 ;;` line:
```bash
    # #469 stage 3: root runs the installed copy; re-run deploy/install-reboot-request.sh
    scripts/ops/reboot_request.py) return 0 ;;
```
Run: `npm test -- scripts/autodeploy/deploy-hold-check.test.ts` → PASS.

- [ ] **Step 7: Full gate and commit**

Run: `npm test && npm run typecheck` → all green.
```bash
git add deploy/wbb-reboot-request.path deploy/wbb-reboot-request.service deploy/install-reboot-request.sh \
  scripts/autodeploy/install-reboot-request.test.ts deploy/autodeploy.sh \
  scripts/autodeploy/deploy-hold-check.ts scripts/autodeploy/deploy-hold-check.test.ts
git commit -m "feat(#469): reboot-request path/service units, installer, handler as a hold path"
```

---

### Task 2: Bot side — the buttons and the guarded alert tick

**Files:**
- Create: `src/bot/commands/reboot.ts`
- Create: `src/bot/commands/reboot.test.ts`
- Modify: `src/jobs/reboot-alert.ts` (`send` receives `since`; add `createRebootAlertTick`)
- Modify: `src/jobs/reboot-alert.test.ts`

**Interfaces:**
- Consumes: `writeRebootRequest(kind: RebootKind, now: Date, dir?)` and `type RebootKind = 'now' | '0400'` from `src/jobs/reboot-request.ts`; `snoozeRebootAlertNow(db, since, now): boolean` and `rebootAlert(deps)` from `src/jobs/reboot-alert.ts`; `readHostPatch(now, path?, uid?): HostPatchRead` from `src/jobs/host-patch.ts`.
- Produces (used by Task 3's `src/index.ts` wiring):
  - `rebootKeyboard(since: number)` — Telegraf `Markup.inlineKeyboard` extra.
  - `currentRebootSince(read: HostPatchRead): number | null | 'unknown'`.
  - `createRebootCommand(deps: RebootCommandDeps): Composer<BotContext>` with `RebootCommandDeps = { now: () => Date; currentSince: (now: Date) => number | null | 'unknown'; request: (kind: RebootKind, now: Date) => void; snooze: (since: number, now: Date) => boolean; log: { error: (obj: object, msg: string) => void } }`.
  - `RebootAlertDeps.send: (text: string, since: number) => Promise<void>`.
  - `createRebootAlertTick(deps: RebootAlertDeps): () => void`.

- [ ] **Step 1: Write the failing tests for the press decision and the composer**

`src/bot/commands/reboot.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { Telegraf } from 'telegraf';
import type { Update, UserFromGetMe } from '@telegraf/types';
import type { BotContext } from '../index';
import type { RebootKind } from '../../jobs/reboot-request';
import { createRebootCommand, currentRebootSince, decideRebootPress, rebootKeyboard, PRESS_TEXT } from './reboot';

/** #469 stage 3 periphery. */
const SINCE = 1_791_100_000;
const NOW = new Date(1_791_461_800_000);
const ADMIN = 42;
const BOT_INFO: UserFromGetMe = {
  id: 1, is_bot: true, first_name: 'B', username: 'BeerBot', can_join_groups: true,
  can_read_all_group_messages: false, supports_inline_queries: false,
};

describe('rebootKeyboard', () => {
  it('carries the since in every button, under Telegram’s 64-byte limit', () => {
    const rows = rebootKeyboard(SINCE).reply_markup.inline_keyboard;
    expect(rows).toEqual([[
      { text: 'Зараз', callback_data: `rb:now:${SINCE}`, hide: false },
      { text: 'О 04:00', callback_data: `rb:0400:${SINCE}`, hide: false },
      { text: 'Нагадати через 3 дні', callback_data: `rb:snooze:${SINCE}`, hide: false },
    ]]);
  });
});

describe('currentRebootSince', () => {
  it('an ok summary with a pending reboot gives its since', () => {
    expect(currentRebootSince({ kind: 'ok', facts: { rebootRequired: { since: SINCE, packages: [] } } } as never)).toBe(SINCE);
  });
  it('an ok summary with nothing pending gives null', () => {
    expect(currentRebootSince({ kind: 'ok', facts: { rebootRequired: null } } as never)).toBe(null);
  });
  it('a stale or unavailable summary is unknown', () => {
    expect([currentRebootSince({ kind: 'stale' }), currentRebootSince({ kind: 'unavailable' })]).toEqual(['unknown', 'unknown']);
  });
});

describe('decideRebootPress', () => {
  it('a reboot press for the pending since is a request', () => {
    expect(decideRebootPress({ action: 'now', since: SINCE, current: SINCE })).toBe('request');
  });
  it('a reboot press for another since is stale', () => {
    expect(decideRebootPress({ action: '0400', since: SINCE, current: SINCE + 3600 })).toBe('stale');
  });
  it('a reboot press when nothing is pending is stale', () => {
    expect(decideRebootPress({ action: 'now', since: SINCE, current: null })).toBe('stale');
  });
  it('a reboot press with an unreadable summary is unknown', () => {
    expect(decideRebootPress({ action: 'now', since: SINCE, current: 'unknown' })).toBe('unknown');
  });
  it('a snooze does not consult the summary: its binding is the alert state', () => {
    expect(decideRebootPress({ action: 'snooze', since: SINCE, current: 'unknown' })).toBe('snooze');
  });
});

function callback(updateId: number, from: number, data: string, chatType: 'private' | 'supergroup' = 'private') {
  return { update_id: updateId, callback_query: { id: `cb-${updateId}`, chat_instance: 'x', data,
    from: { id: from, is_bot: false, first_name: 'Test' },
    message: { message_id: 5, date: 1, chat: chatType === 'private'
      ? { id: from, type: 'private' as const, first_name: 'Test' }
      : { id: -100, type: 'supergroup' as const, title: 'G' } } } };
}

function setup(opts: { current?: number | null | 'unknown'; snoozeOk?: boolean; requestThrows?: boolean } = {}) {
  const requests: Array<[RebootKind, number]> = [];
  const snoozes: number[] = [];
  const answers: (string | undefined)[] = [];
  const replies: string[] = [];
  const edits: unknown[] = [];
  const errors: string[] = [];
  const bot = new Telegraf<BotContext>('123456:FAKE');
  bot.botInfo = BOT_INFO;
  bot.use((ctx, next) => {
    ctx.deps = { db: {}, env: { ADMIN_TELEGRAM_ID: String(ADMIN) }, log: {} } as never;
    ctx.answerCbQuery = (async (text?: string) => { answers.push(text); return true; }) as never;
    ctx.reply = (async (m: string) => { replies.push(m); return { message_id: 9 }; }) as never;
    ctx.editMessageReplyMarkup = (async (m: unknown) => { edits.push(m); return true; }) as never;
    return next();
  });
  bot.use(createRebootCommand({
    now: () => NOW,
    currentSince: () => (opts.current === undefined ? SINCE : opts.current),
    request: (kind, now) => {
      if (opts.requestThrows) throw new Error('EACCES');
      requests.push([kind, now.getTime()]);
    },
    snooze: (since) => { snoozes.push(since); return opts.snoozeOk ?? true; },
    log: { error: (_o, msg) => { errors.push(msg); } },
  }));
  return { bot, requests, snoozes, answers, replies, edits, errors };
}

const press = (bot: Telegraf<BotContext>, from: number, data: string, chatType?: 'private' | 'supergroup') =>
  bot.handleUpdate(callback(1, from, data, chatType) as unknown as Update);

describe('createRebootCommand', () => {
  it('«Зараз» for the pending reboot writes a now request, drops the keyboard and says the request was sent', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:now:${SINCE}`);
    expect([s.requests, s.answers, s.replies, s.edits]).toEqual([
      [['now', NOW.getTime()]], [PRESS_TEXT.requested_now], [PRESS_TEXT.requested_now], [undefined],
    ]);
  });

  it('«О 04:00» writes a 0400 request', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:0400:${SINCE}`);
    expect([s.requests, s.replies]).toEqual([[['0400', NOW.getTime()]], [PRESS_TEXT.requested_0400]]);
  });

  it('a non-admin press does nothing but the admins-only toast', async () => {
    const s = setup();
    await press(s.bot, ADMIN + 1, `rb:now:${SINCE}`);
    expect([s.requests, s.snoozes, s.answers, s.replies, s.edits]).toEqual([[], [], [PRESS_TEXT.not_admin], [], []]);
  });

  it('the admin pressing in a group is treated as not-admin', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:now:${SINCE}`, 'supergroup');
    expect([s.requests, s.answers]).toEqual([[], [PRESS_TEXT.not_admin]]);
  });

  it('an old message’s button writes nothing and says it is stale', async () => {
    const s = setup({ current: SINCE + 3600 });
    await press(s.bot, ADMIN, `rb:now:${SINCE}`);
    expect([s.requests, s.answers, s.replies, s.edits]).toEqual([[], [PRESS_TEXT.stale], [PRESS_TEXT.stale], [undefined]]);
  });

  it('an unreadable summary writes nothing and keeps the keyboard for a retry', async () => {
    const s = setup({ current: 'unknown' });
    await press(s.bot, ADMIN, `rb:0400:${SINCE}`);
    expect([s.requests, s.answers, s.replies, s.edits]).toEqual([[], [PRESS_TEXT.unknown], [], []]);
  });

  it('a failed request write is logged, reported, and keeps the keyboard', async () => {
    const s = setup({ requestThrows: true });
    await press(s.bot, ADMIN, `rb:now:${SINCE}`);
    expect([s.errors, s.answers, s.replies, s.edits]).toEqual([['reboot request write failed'], [PRESS_TEXT.failed], [], []]);
  });

  it('«Нагадати через 3 дні» snoozes that since', async () => {
    const s = setup();
    await press(s.bot, ADMIN, `rb:snooze:${SINCE}`);
    expect([s.snoozes, s.requests, s.replies, s.edits]).toEqual([[SINCE], [], [PRESS_TEXT.snoozed], [undefined]]);
  });

  it('a snooze the alert state refuses is stale', async () => {
    const s = setup({ snoozeOk: false });
    await press(s.bot, ADMIN, `rb:snooze:${SINCE}`);
    expect([s.snoozes, s.replies]).toEqual([[SINCE], [PRESS_TEXT.stale]]);
  });

  it('callback data that is not rb:<kind>:<digits> is not handled', async () => {
    const s = setup();
    await press(s.bot, ADMIN, 'rb:reboot:1');
    await press(s.bot, ADMIN, `rb:now:${SINCE}x`);
    expect([s.requests, s.answers]).toEqual([[], []]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- src/bot/commands/reboot.test.ts`
Expected: FAIL (module `./reboot` not found).

- [ ] **Step 3: Write the composer**

`src/bot/commands/reboot.ts`:
```ts
import { Composer, Markup } from 'telegraf';
import type { BotContext } from '../index';
import type { HostPatchRead } from '../../domain/status/types';
import type { RebootKind } from '../../jobs/reboot-request';

// #469 stage 3: the admin's three buttons under the reboot alert. Each carries the since of the
// reboot it was sent for, so an old message's buttons do nothing. The bot only ASKS: root acts,
// and only while a reboot is pending (spec C24) — so the replies say «запит надіслано».
export type RebootAction = RebootKind | 'snooze';
export type PressOutcome = 'request' | 'snooze' | 'stale' | 'unknown';

export const PRESS_TEXT = {
  not_admin: 'Лише для адміністратора.',
  requested_now: 'Запит надіслано: перезавантаження зараз.',
  requested_0400: 'Запит надіслано: перезавантаження о 04:00 (Варшава).',
  snoozed: 'Нагадаю через 3 дні.',
  stale: 'Застаріло: ця кнопка від іншого перезавантаження, або воно вже не потрібне.',
  unknown: 'Стан хоста зараз невідомий — спробуй пізніше.',
  failed: 'Не вдалося записати запит — дивись лог бота.',
} as const;

const CALLBACK = /^rb:(now|0400|snooze):(\d{1,12})$/;

export function rebootKeyboard(since: number) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('Зараз', `rb:now:${since}`),
    Markup.button.callback('О 04:00', `rb:0400:${since}`),
    Markup.button.callback('Нагадати через 3 дні', `rb:snooze:${since}`),
  ]]);
}

export function currentRebootSince(read: HostPatchRead): number | null | 'unknown' {
  if (read.kind !== 'ok') return 'unknown';
  return read.facts.rebootRequired?.since ?? null;
}

export function decideRebootPress(p: { action: RebootAction; since: number; current: number | null | 'unknown' }): PressOutcome {
  if (p.action === 'snooze') return 'snooze';
  if (p.current === 'unknown') return 'unknown';
  return p.current === p.since ? 'request' : 'stale';
}

export interface RebootCommandDeps {
  now: () => Date;
  currentSince: (now: Date) => number | null | 'unknown';
  request: (kind: RebootKind, now: Date) => void;
  snooze: (since: number, now: Date) => boolean;
  log: { error: (obj: object, msg: string) => void };
}

export function createRebootCommand(deps: RebootCommandDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>();
  composer.action(CALLBACK, async (ctx) => {
    if (ctx.chat?.type !== 'private' || String(ctx.from.id) !== ctx.deps.env.ADMIN_TELEGRAM_ID) {
      await ctx.answerCbQuery(PRESS_TEXT.not_admin);
      return;
    }
    const action = ctx.match[1] as RebootAction;
    const since = Number(ctx.match[2]);
    const now = deps.now();
    const outcome = decideRebootPress({ action, since, current: action === 'snooze' ? 'unknown' : deps.currentSince(now) });
    if (outcome === 'unknown') {
      await ctx.answerCbQuery(PRESS_TEXT.unknown);
      return;
    }
    let text: string;
    if (outcome === 'request') {
      const kind = action as RebootKind;
      try {
        deps.request(kind, now);
      } catch (e) {
        deps.log.error({ err: e }, 'reboot request write failed');
        await ctx.answerCbQuery(PRESS_TEXT.failed);
        return;
      }
      text = kind === 'now' ? PRESS_TEXT.requested_now : PRESS_TEXT.requested_0400;
    } else if (outcome === 'snooze') {
      text = deps.snooze(since, now) ? PRESS_TEXT.snoozed : PRESS_TEXT.stale;
    } else {
      text = PRESS_TEXT.stale;
    }
    await ctx.answerCbQuery(text);
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply(text);
  });
  return composer;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- src/bot/commands/reboot.test.ts`
Expected: PASS (19 tests). Mutation check: change `!== ctx.deps.env.ADMIN_TELEGRAM_ID` to `=== '0'` → the not-admin and group tests fail; restore.

- [ ] **Step 5: Write the failing tests for `send(text, since)` and the guarded tick**

In `src/jobs/reboot-alert.test.ts`:
1. Change the import to `import { REBOOT_ALERT_KEY, createRebootAlertTick, rebootAlert, snoozeRebootAlertNow } from './reboot-alert';`.
2. Append:
```ts
describe('rebootAlert — the keyboard’s since', () => {
  it('hands send the since of the alerted reboot', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    const got: number[] = [];
    await rebootAlert({ db, log, now: () => NOW, hostPatchPath: path, hostPatchUid: process.getuid!(),
      send: async (_text, since) => { got.push(since); } });
    expect(got).toEqual([SINCE]);
  });
});

describe('createRebootAlertTick', () => {
  it('a tick while the previous run is still sending starts no second run', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sends = 0;
    const tick = createRebootAlertTick({ db, log, now: () => NOW, hostPatchPath: path, hostPatchUid: process.getuid!(),
      send: async () => { sends += 1; await gate; } });
    tick();
    tick();
    release();
    await new Promise((r) => setImmediate(r));
    expect(sends).toBe(1);
  });

  it('a failed run is logged, not thrown, and frees the guard for the next tick', async () => {
    summary({ since: SINCE, packages: ['libc6'] });
    const errors: string[] = [];
    const errLog = { ...log, error: (_o: unknown, msg: string) => { errors.push(msg); } } as unknown as typeof log;
    let calls = 0;
    const tick = createRebootAlertTick({ db, log: errLog, now: () => NOW, hostPatchPath: path, hostPatchUid: process.getuid!(),
      send: async () => { calls += 1; if (calls === 1) throw new Error('telegram down'); } });
    tick();
    await new Promise((r) => setImmediate(r));
    tick();
    await new Promise((r) => setImmediate(r));
    expect([errors, calls, getJobState(db, REBOOT_ALERT_KEY)]).toEqual([
      ['reboot-alert cron'], 2, JSON.stringify({ since: SINCE, snoozeUntil: null }),
    ]);
  });
});
```

Run: `npm test -- src/jobs/reboot-alert.test.ts` → FAIL (`createRebootAlertTick` is not exported; the `since` test gets `undefined`).

- [ ] **Step 6: Implement**

In `src/jobs/reboot-alert.ts`:
- `RebootAlertDeps.send` becomes `send: (text: string, since: number) => Promise<void>;` with the comment `// since: the reboot this alert is for — the keyboard's buttons carry it`.
- In `rebootAlert`, `await deps.send(decision.text);` becomes `await deps.send(decision.text, decision.state.since);` (keep the existing trailing comment).
- Append:
```ts
/**
 * The hourly cron's body. A run can outlast the tick (Telegraf caps a call at 500 s and a
 * failed send is retried next hour), and two overlapping runs would both alert the same
 * reboot — so a tick while one is in flight is skipped. A throw is logged: the state stays
 * unsaved and the next tick retries.
 */
export function createRebootAlertTick(deps: RebootAlertDeps): () => void {
  let inFlight = false;
  return () => {
    if (inFlight) {
      deps.log.warn('reboot-alert: previous run still in flight, skipping this tick');
      return;
    }
    inFlight = true;
    rebootAlert(deps)
      .catch((e) => deps.log.error({ err: e }, 'reboot-alert cron'))
      .finally(() => { inFlight = false; });
  };
}
```

Run: `npm test -- src/jobs/reboot-alert.test.ts` → PASS. Mutation check: delete the `if (inFlight) {…}` block → the overlap test fails with `sends` = 2; restore.

- [ ] **Step 7: Full gate and commit**

Run: `npm test && npm run typecheck` → green.
```bash
git add src/bot/commands/reboot.ts src/bot/commands/reboot.test.ts src/jobs/reboot-alert.ts src/jobs/reboot-alert.test.ts
git commit -m "feat(#469): reboot buttons bound to their since; in-flight-guarded alert tick"
```

---

### Task 3: Wiring, source guard, docs

**Files:**
- Modify: `src/index.ts`
- Create: `src/bot/commands/reboot.wiring.test.ts`
- Modify: `spec.md` (the #469 bullet and the cron table)
- Modify: `deploy/README.md` (Host patching, new step 6)
- Modify: `docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md` (the "admins only" sentence)

**Interfaces:**
- Consumes: everything Task 2 produces; `writeRebootRequest` (`src/jobs/reboot-request.ts`); `readHostPatch` (`src/jobs/host-patch.ts`).

- [ ] **Step 1: Write the failing source guard**

`src/bot/commands/reboot.wiring.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// #469 stage 3: the composer and the tick are tested on their own (reboot.test.ts,
// reboot-alert.test.ts); this pins that src/index.ts actually wires them — a dropped line
// would leave the buttons dead and the alert silent with every other test green.
const INDEX = readFileSync(path.resolve(__dirname, '../../index.ts'), 'utf8');

describe('src/index.ts wires #469 stage 3', () => {
  it('registers the reboot composer inside bot.use(...)', () => {
    // Search for the end marker AFTER the start: createRefreshCommand is also named in the imports.
    const start = INDEX.indexOf('bot.use(\n    cityGate,');
    const use = INDEX.slice(start, INDEX.indexOf('createRefreshCommand(', start));
    expect(start > 0).toBe(true);
    expect(use.includes('createRebootCommand({')).toBe(true);
  });

  it('schedules the guarded tick hourly at :10, only when an admin is configured', () => {
    expect(INDEX.includes("...(env.ADMIN_TELEGRAM_ID ? [cron.schedule('10 * * * *', rebootAlertTick)] : []),")).toBe(true);
  });

  it('sends the alert with the keyboard bound to its since', () => {
    expect(INDEX.includes('sendMessage(env.ADMIN_TELEGRAM_ID!, text, rebootKeyboard(since))')).toBe(true);
  });
});
```
Run: `npm test -- src/bot/commands/reboot.wiring.test.ts` → FAIL (3).

- [ ] **Step 2: Wire `src/index.ts`**

Imports (next to the other job/command imports):
```ts
import { createRebootCommand, currentRebootSince, rebootKeyboard } from './bot/commands/reboot';
import { createRebootAlertTick, snoozeRebootAlertNow } from './jobs/reboot-alert';
import { writeRebootRequest } from './jobs/reboot-request';
import { readHostPatch } from './jobs/host-patch';
```
(If `readHostPatch` is already imported, do not duplicate it.)

In `bot.use(` right after `cityGate,`:
```ts
    // #469 stage 3: the admin's reboot buttons (rb:<kind>:<since>); admin check first.
    createRebootCommand({
      now: () => new Date(),
      currentSince: (now) => currentRebootSince(readHostPatch(now)),
      request: (kind, now) => writeRebootRequest(kind, now),
      snooze: (since, now) => snoozeRebootAlertNow(db, since, now),
      log,
    }),
```

Before the cron array (next to `let announceInFlight = false;`):
```ts
  // #469 stage 3: one alert per pending reboot; the tick carries its own in-flight guard.
  const rebootAlertTick = createRebootAlertTick({
    db, log,
    send: (text, since) => bot.telegram.sendMessage(env.ADMIN_TELEGRAM_ID!, text, rebootKeyboard(since)).then(() => {}),
  });
```
In the cron array, right after the `hostUpstream` entry:
```ts
    // #469 stage 3: tell the admin a reboot is pending (and again after a snooze). Hourly;
    // the collector also runs hourly, so the alert lags the flag by at most ~2 h.
    ...(env.ADMIN_TELEGRAM_ID ? [cron.schedule('10 * * * *', rebootAlertTick)] : []),
```
Run: `npm test -- src/bot/commands/reboot.wiring.test.ts` → PASS. Run `npm run typecheck` → clean.

- [ ] **Step 3: Docs**

`docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md`, §Stage 3, replace
`Only `ADMIN_TELEGRAM_ID` can
press the buttons; anyone else gets the standard "admins only" answer.`
with
`Only `ADMIN_TELEGRAM_ID`, in the private chat, can press the buttons; anyone else gets the
toast «Лише для адміністратора.» and nothing happens. A reboot press while the summary is
unreadable writes nothing and keeps the buttons («стан хоста невідомий»).`
(re-wrap to the surrounding line width).

`spec.md`, end of the «Патчі хоста (#469 …)» bullet (after `… `нема даних: збирач патчів мовчить`.`), append:
```
  Коли хост чекає перезавантаження, бот раз на це перезавантаження (і ще раз після кожного
  «Нагадати через 3 дні») пише адміну з кнопками «Зараз» / «О 04:00» / «Нагадати через 3 дні».
  Кнопки несуть `since` свого перезавантаження; кнопка старого повідомлення нічого не робить.
  Бот не перезавантажує хост сам: він пише запит у `/var/lib/wbb-host-patch/reboot-request`, а
  root-юніт `wbb-reboot-request.path` (`deploy/install-reboot-request.sh`) виконує його лише поки
  існує `/run/reboot-required`. «О 04:00» — за Варшавою; повторне натискання не планує другого.
```
`spec.md` cron table, add a row after `hostUpstream`:
```
| `rebootAlert` | `10 * * * *` (лише з `ADMIN_TELEGRAM_ID`) | #469: якщо в підсумку збирача є `reboot_required`, шле адміну одне повідомлення на це перезавантаження (ключ — його `since`) з кнопками; повтор — лише після закінчення відкладання на 3 дні. Стан у `job_state.reboot_alert` пишеться лише після успішної відправки; запуск, поки попередній ще шле, пропускається. |
```

`deploy/README.md`, in «Host patching (#469)», after step 5 add:
```
6. Stage 3 — the reboot button (`[deploy:hold]` PR): `sudo bash deploy/install-reboot-request.sh`.
   It installs `wbb-reboot-request.path`/`.service` and creates `/var/lib/wbb-host-patch` (0700,
   owned by `warsaw-beer-bot`). Prove the chain without rebooting: as the bot user write an invalid
   request (`sudo -u warsaw-beer-bot sh -c 'echo bogus > /var/lib/wbb-host-patch/reboot-request'`),
   then `journalctl -u wbb-reboot-request.service -n 5` must show the handler refusing it and the
   file must be gone. Only then `bash deploy/deploy.sh`. Re-run the installer after any merge that
   changes `scripts/ops/reboot_request.py` or the units.
```

- [ ] **Step 4: Full gate and commit**

Run: `npm test && npm run typecheck` → green.
```bash
git add src/index.ts src/bot/commands/reboot.wiring.test.ts spec.md deploy/README.md docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md
git commit -m "feat(#469): wire the reboot buttons and the hourly alert; spec, README host step"
```
