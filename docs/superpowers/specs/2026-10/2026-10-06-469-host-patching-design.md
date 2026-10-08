# #469 — the host patches itself, and the report says when it cannot

## Problem

#469 was filed as "nothing watches the Node runtime's EOL — `npm audit` cannot see it".
Probing the host on 2026-10-06 showed the blind spot is the whole layer under the app,
not only Node:

| Layer | Who patches it today | State 2026-10-06 |
|---|---|---|
| Kernel | unattended-upgrades installs to disk | running **6.8.0-90** since **2026-04-22** (uptime); **6.8.0-142** installed. `/var/run/reboot-required` present; `.pkgs` lists 10 kernel images and `libc6` three times |
| libc6 and other shared libs | unattended-upgrades | upgraded on disk; long-lived processes keep the old mapping until restarted |
| Ubuntu `-security` pocket | unattended-upgrades | healthy: 0 security upgrades pending (54 non-security `-updates` pending, by design) |
| Node (`nodesource`, `node_24.x`) | **nobody** — not in `Unattended-Upgrade::Allowed-Origins` | 24.19.0 installed, 24.21.0 candidate. No security release pending today (24.18.1 was the last, already covered), but the next one will not arrive by itself |
| cloudflared | **nobody** — a `.deb` with no apt source (candidate = installed) | 2026.3.0; upstream 2026.10.0. Internet-facing |
| litestream | **nobody** — a manual `.deb` | 0.5.11; upstream v0.5.17 |
| Runtime / distro EOL | nobody | Node 24 maintenance 2026-10-20, EOL 2028-04-30; Ubuntu 24.04 standard support to 2029-05 |

Public exposure: `sshd` on `0.0.0.0:22`; everything else listens on loopback and reaches
the internet through cloudflared.

None of this reaches any signal: `npm audit` and Dependabot read the dependency tree,
and the daily status "Інфраструктура" row reads only disk and inodes.

## Decisions (brainstorm 2026-10-06)

- **Patch and monitor**, not monitor alone: a monitor whose only remedy is a human
  would show a daily 🟡 that someone has to act on.
- **Reboot policy 1**: Canonical Livepatch for the kernel, plus a reboot **on the
  admin's button**. No automatic reboot: a reboot kills `code-server` and every
  terminal and agent session in it — the same trade-off already settled in
  `/etc/needrestart/conf.d/90-code-server.conf` (2026-09-03: lost work costs more than
  an editor on an old library). Policies "reboot at 04:00 if nobody is working" and
  "reboot at 04:00 unconditionally" were rejected: the first needs a fragile "idle"
  detector (an overnight background agent looks idle), the second brings back the
  09-03 outage.
- **Ubuntu Pro is attached** (free personal tier). It brings Livepatch and the
  `esm-infra` / `esm-apps` security pockets, which the existing `Allowed-Origins`
  already lists.
- **Third-party packages**: Node and cloudflared are patched by unattended-upgrades
  from their vendor apt repos; litestream is monitored only, because it is what writes
  the backup and should not change silently.

## Design

Three stages, one spec. Each stage gets its own plan, written after the previous
stage is reviewed (CLAUDE.md, "велика зміна йде стадіями").

### Stage 1 — the host patches itself

All host steps are root, so the PR is `[deploy:hold]` and lists them for the human.
The configuration lives in the repo and is installed by one idempotent script,
`deploy/install-host-patching.sh` (run with `sudo`), so the host state is
reproducible and reviewable:

1. **Ubuntu Pro + Livepatch** — human, once: `sudo pro attach <token>`, then
   `sudo pro enable livepatch` (the token is personal; it never enters the repo or `.env`).
2. **`/etc/apt/apt.conf.d/52wbb-unattended-upgrades`** (installed by the script):
   ```
   Unattended-Upgrade::Origins-Pattern {
     "site=deb.nodesource.com,n=nodistro";
     "site=pkg.cloudflare.com,o=cloudflared";
   };
   ```
   `Origins-Pattern` and not `Allowed-Origins`, because nodesource publishes
   `Origin: . nodistro` — not something `${origin}:${archive}` can name. The existing
   Ubuntu origins are untouched (the file is additive; apt merges lists).
   Node cannot jump majors this way: the source is the `node_24.x` repo, which only
   carries 24.x.
3. **cloudflared from Cloudflare's apt repo** — the script adds
   `/usr/share/keyrings/cloudflare-public-v2.gpg` (the probed v2 key, primary
   fingerprint `CC94B39C77AE7342A68B89628A682D308D4E5E73`, checked before anything is
   written) and `/etc/apt/sources.list.d/cloudflared.list`
   (`deb [signed-by=…] https://pkg.cloudflare.com/cloudflared any main`), then
   `apt-get install cloudflared`, which upgrades the orphaned `.deb` in place. The
   tunnel unit and its credentials are untouched.
4. **needrestart stays in automatic mode.** It already restarts services under
   unattended-upgrades (evidence in the claims table). The script reads the live
   (uncommented) lines of `needrestart.conf` and `conf.d/*.conf` and refuses, changing
   nothing, on any `qr(...)` rule naming one of the four units (`warsaw-beer-bot`,
   `cloudflared`, `litestream`, `ssh`), on a restart mode other than `a`, on a
   configured `$nrconf{ui}` (it disables the automatic APT-hook default), and when
   needrestart is not installed. Known limit: the guard is a text match, so it cannot
   see alternations or prefixes (`qr(^(cron|litestream))`, `qr(^cloud)`) or
   `$nrconf{blacklist}` binary rules.
5. **One manual reboot** — human, after steps 1–4, to move from 6.8.0-90 to the
   installed kernel so Livepatch has a supported base. This also clears today's
   backlog.

Node patch upgrades restart the bot through needrestart (the `node` binary is replaced
on disk). `better-sqlite3` is built against the Node **major's** ABI
(`NODE_MODULE_VERSION`), which is fixed for the whole 24.x line, so a patch upgrade does
not invalidate `node_modules`.

### Stage 2 — the collector and the traffic-light rules

**Collector (root, local facts only).** `deploy/wbb-host-patch-collect` (installed to
`/usr/local/libexec/`), run by `wbb-host-patch.timer` hourly. It never touches the
network: the root part stays minimal and its output depends only on the host. It writes
`/var/tmp/wbb-host-patch/summary.json` (kernel fields from needrestart's `KCUR`/`KEXP`) atomically (temp file + rename), directory
`0755` owned by root, file `0644` owned by root:

```jsonc
{
  "version": 1,
  "timestamp": 1791000000,                 // unix seconds
  "kernel": { "running": "6.8.0-142-generic", "newest_installed": "6.8.0-142-generic" },
  "reboot_required": { "since": 1790500000, "packages": ["libc6", "linux-image-…"] } | null,
  "livepatch": { "state": "applied" | "nothing-to-apply" | "unsupported-kernel" | "unknown", "upgrade_required_date": "2027-10-02" | null },
  "stale_services": [{ "unit": "litestream.service", "since": 1790900000 }], // needrestart -b -r l (list only — never restarts)
  "unattended": { "last_run": 1790990000, "security_pending": 0 },
  "packages": { "nodejs": "24.21.0-1nodesource1", "cloudflared": "2026.10.0", "litestream": "0.5.11" }
}
```

`reboot_required.since` is when the reboot **first** became pending, not the flag's mtime:
`notify-reboot-required` rewrites `/var/run/reboot-required` (`>`) for every package that
asks for a reboot, so the raw mtime is the *latest* request and would reset the "чекає N днів"
clock on every libc6/dbus update — the 🔴 at 14 days could then never fire. The collector
carries it forward like `stale_services[].since`: `min(previous.since, mtime)` while the flag
exists; a previous `since` older than boot time (`btime` in `/proc/stat`) is dropped, because
`/run` is emptied on reboot. Under Livepatch, kernel packages exit `notify-reboot-required`
early, so the flag tracks non-kernel packages; a pending kernel shows only as
`kernel.running ≠ kernel.newest_installed`, which no rule reads — `upgrade_required_date`
covers the kernel. `unattended.last_run`
is the mtime of `/var/lib/apt/periodic/unattended-upgrades-stamp`. `security_pending`
counts lines of `apt list --upgradable` whose archive list names a `-security` pocket
(`noble-security`, `noble-apps-security`, `noble-infra-security`). Package versions come
from `dpkg-query -W`. A field the collector could not read is written as `null`, never
guessed. Two facts are exceptions because their `null` already means something:
`reboot_required: null` is "no reboot pending" and `unattended.last_run: null` is "never ran"
(the rule prints «ще не запускався»). For those, a read error other than "file not found"
aborts the run without writing; the summary then ages into 🟡 `нема даних` after 3 h —
honest, where a `null` would print a false answer.

needrestart is called as `needrestart -b -r l`: batch output, **list-only** restart
mode. Without `-r l` the hourly collector would itself restart services.

**Livepatch mapping** (from `canonical-livepatch status --format json`, `Status[0]` is the
running kernel): `Supported` ≠ `"supported"` → `unsupported-kernel`; else
`Livepatch.State` ∈ {`applied`, `nothing-to-apply`} is kept as is; any other value →
`unknown`. A failing command or unparsable output → `livepatch: null`.
`upgrade_required_date` is copied from `Status[0].UpgradeRequiredDate`.

**The collector must run as its own systemd unit.** Snap CLIs (`canonical-livepatch`, and
`pro`, which calls it) refuse to start inside another service's cgroup — probed from a
code-server terminal: `…code-server@ysi.service is not a snap cgroup`. They work under
`systemd-run --wait --pipe`, i.e. in their own unit (C15).

**Bot-side upstream facts (unprivileged; the bot already has network).** Once a day,
the daily-status collector fetches:

- `https://nodejs.org/dist/index.json` — the newest `v24.*` with `security: true` and
  its `date`;
- `https://raw.githubusercontent.com/nodejs/Release/main/schedule.json` — `v24`
  `maintenance` and `end`;
- `https://api.github.com/repos/benbjohnson/litestream/releases/latest` — `tag_name`,
  `published_at`.

Ubuntu 24.04's end of standard support is a constant in `rules.ts` (2029-05-31): there
is no machine-readable source worth a fetch for a date that does not move.

A fetch that fails is `Avail { ok: false }` → 🟡 `нема даних: …` for that line only.

**Reading the summary.** Same hardening as `readTestDiagnostics`
(`src/jobs/test-diagnostics.ts`): `O_NOFOLLOW`, directory mode `0755`, file `0644`,
`nlink 1`, size cap, schema-validated, trusted owner = **uid 0** here. Older than
3 hours → `нема даних: збирач патчів мовчить`.

**Rules (Інфраструктура row, `src/domain/status/rules.ts`).** The host-patch findings
are computed **independently** of the disk findings: today `evaluateInfra` returns early
when the disk summary is unreadable, and that early return must not hide a red reboot
line.

| Fact | 🟡 | 🔴 |
|---|---|---|
| reboot pending (`now − reboot_required.since`) | > 3 days | > 14 days |
| Livepatch `state` ∉ {`applied`, `nothing-to-apply`} | always | — |
| Livepatch `upgrade_required_date` (kernel leaves Livepatch support; the date's own day counts as past) | < 30 days | past |
| a **watched** unit in `stale_services` (needrestart did not restart it) | `now − since` > 1 day | — |
| newest Node 24.x security release > installed `nodejs` | — | release `date` > 3 days ago |
| `security_pending > 0` | unattended-upgrades last run > 2 days ago | — |
| Node 24 `end` | < 180 days | < 30 days |
| Ubuntu 24.04 end of standard support | < 180 days | < 30 days |
| litestream `latest` > installed | `published_at` > 30 days ago | — |
| summary missing / unreadable / > 3 h old | `нема даних` | — |

The "stale service" rule needs the age of the staleness, which one summary cannot
give. Only the watched units count — `warsaw-beer-bot.service`, `cloudflared.service`,
`litestream.service`, `ssh.service`. needrestart deliberately defers the rest
(`code-server@*` by our override, `dbus`, `systemd-logind`, `getty@*`, … by its defaults;
probe P2 lists exactly these); they refresh only on reboot, which the reboot rule already
covers, so counting them would make the line permanently 🟡. The collector therefore records `stale_services` as
`[{ "unit": "…", "since": <first hourly run that saw it> }]`, keeping `since` across
runs from its previous summary (a unit that disappears is dropped). 🟡 when
`now − since > 1 day`.

Lines are Ukrainian, one per finding, e.g. `ядро: перезавантаження чекає 17 днів (libc6, linux-image-…)`,
`Node 24.21.0 < безпековий 24.22.0 (з 2026-11-03)`, `litestream 0.5.11 < v0.5.17`.

### Stage 3 — the reboot button and the immediate alert

**Immediate alert.** An hourly bot job reads the summary. When `reboot_required` turns
non-null (or a snooze expires while it still is), the bot sends the admin one message:
the reason (packages), how long it has waited, and the Livepatch state — with three
inline buttons: **«Зараз»**, **«О 04:00»**, **«Нагадати через 3 дні»**. The state
(`notified_since`, `snooze_until`) lives in `job_state`, keyed by `reboot_required.since`,
so one pending reboot produces one alert, not one per hour. Only `ADMIN_TELEGRAM_ID` can
press the buttons; anyone else gets the standard "admins only" answer.

**The bot cannot reboot the host — by design.** The button writes a request file; root
acts on it:

- The bot writes `/var/lib/wbb-host-patch/reboot-request` (directory `0700`, owned by
  `warsaw-beer-bot`; root reads it regardless) containing one line: `now` or `0400`,
  followed by the request's unix time.
- `wbb-reboot-request.path` (`PathChanged=`) starts `wbb-reboot-request.service`
  (root). It opens the file with `O_NOFOLLOW`, rejects anything over 64 bytes, any
  content other than the two forms, or a timestamp older than 10 minutes, **deletes the
  file**, and then:
  - `now` → `systemctl reboot`;
  - `0400` → `systemd-run --on-calendar='*-*-* 04:00:00 Europe/Warsaw' --timer-property=AccuracySec=1min systemctl reboot`
    (host is `Etc/UTC`; the calendar spec carries the timezone, so DST is not our arithmetic).
- A compromised bot can, at worst, reboot the host. It gains no root command.

`systemctl reboot` stops units in order: the bot's SIGTERM handler (`src/shutdown.ts`)
and litestream's flush run as on any `systemctl stop`.

## Claims → evidence

| # | Claim the system records or relies on | Evidence | Strength |
|---|---|---|---|
| C1 | needrestart restarts services automatically under unattended-upgrades | `unattended-upgrades-dpkg.log*`: "Restarting services… systemctl restart ssh.service …" and "systemctl restart code-server@root.service" (the 09-03 incident) | strong (log) |
| C2 | `/var/run/reboot-required` + `.pkgs` mean "a reboot is pending, for these packages" | probed: present, mtime 2026-09-26, `.pkgs` lists kernels + `libc6`; running 6.8.0-90 vs installed 6.8.0-142 | strong (probe) |
| C3 | Livepatch covers the kernel the host runs after the stage-1 reboot | P1 2026-10-07 (`systemd-run`, after `pro attach` + `enable livepatch`): `Status[0]` `Kernel 6.8.0-142.142-generic`, `Supported: "supported"`, `UpgradeRequiredDate: 2027-10-02` | strong (probe) |
| C4 | `canonical-livepatch status --format json` gives a state the collector can map | P1: `Status[0].Livepatch.State: "nothing-to-apply"`, `CheckState: "checked"`; the JSON is the collector's fixture. Only this one state value was observed | strong for the shape; other state strings map to `unknown` (🟡), so an unseen string cannot read as healthy |
| C5 | `needrestart -b` (root) prints `NEEDRESTART-SVC: <unit>` lines for stale services | probed 2026-10-06 (P2, `needrestart -b -r l` as root): `NEEDRESTART-SVC: <unit>` lines, plus `NEEDRESTART-KCUR`/`KEXP` (running/expected kernel); the deferred set was code-server, dbus, getty, logind, unattended-upgrades; prod processes had 0 deleted mappings | strong (probe) |
| C6 | `Origins-Pattern` `site=deb.nodesource.com,n=nodistro` and `site=pkg.cloudflare.com,o=cloudflared` match the repos | Release files probed (`Origin: . nodistro`, `Origin: cloudflared`, `Codename: any`); P3 2026-10-07 (`unattended-upgrade --dry-run -d`): "Allowed origins" lists both patterns, `nodejs` 24.19 → 24.21 selected. Live: the 2026-10-08 06:03 run installed nodejs 24.21.0 and needrestart restarted `warsaw-beer-bot` (deferring `code-server@ysi`) | strong (probe + live run) |
| C7 | nodejs.org `index.json` flags security releases | probed: `v24.18.1 security=true`, others `false` | strong (probe) |
| C8 | `schedule.json` carries `v24.maintenance` / `v24.end` | probed: 2026-10-20 / 2028-04-30 | strong (probe) |
| C9 | GitHub `releases/latest` gives litestream's tag | probed: `v0.5.17` | strong (probe); unauthenticated limit 60/h, we call once a day |
| C10 | the nodesource repo never offers another major | probed: source URL is `node_24.x`; its `Packages` carries only 24.x | strong (probe) |
| C11 | a Node patch upgrade keeps `better-sqlite3` loadable | `NODE_MODULE_VERSION` is fixed per Node major (Node ABI policy) | medium — watched by C1's restart + `/health`; if it fails, the bot is down and the existing monitors fire |
| C12 | the summary is the host's, not forged by the bot user | owner uid 0, dir `0755` root, read with the `readTestDiagnostics` checks | strong (own code, tested) |
| C13 | `systemd-run --on-calendar … Europe/Warsaw` fires at 04:00 Warsaw on a UTC host | probed 2026-10-06 on systemd 255: `systemd-analyze calendar '*-*-* 04:00:00 Europe/Warsaw'` → next elapse `02:00:00 UTC` (CEST) | strong (probe) |
| C14 | the services come back after a reboot | probed: `warsaw-beer-bot`, `cloudflared`, `litestream`, `wbb-autodeploy.timer` are `enabled` | services: strong (re-checked by the stage-1 reboot 2026-10-06 — all came back). **Not** `wbb-autodeploy.timer`: enabled but never fired after a slow boot (#798, Persistent stamp + passed `OnBootSec`; fixed by #799) — "enabled" did not prove "will run" |
| C15 | the collector can read Livepatch state | snap CLIs fail inside code-server's cgroup (`is not a snap cgroup`); the same command under `systemd-run --wait --pipe` returned the P1 JSON | strong (probe) → the collector is its own unit |
| C16 | `unattended.last_run` = mtime of `/var/lib/apt/periodic/unattended-upgrades-stamp` | probed 2026-10-08: mtime 06:03:49; the run in `unattended-upgrades-dpkg.log` ended 06:03:48 | strong (probe) |
| C17 | `apt list --upgradable` marks security candidates by a `-security` archive | format `pkg/<archive>[,<archive>…] <ver> <arch> [upgradable from: …]` seen 2026-10-08 on 53 lines; **no** live security line (0 pending: u-u had applied them) | medium — the positive case is a fixture, not a live line; the rule fires only 🟡 and only when u-u is also > 2 days stale. Also only as fresh as the apt lists: if `apt update` keeps failing while u-u runs, the count stays 0 and nothing shows |
| C19 | `reboot_required.since` = when the reboot first became pending | read 2026-10-08: `/usr/share/update-notifier/notify-reboot-required` writes the flag with `>` per package (so mtime = latest request); C2's own probe showed it — mtime 2026-09-26 against a kernel pending since April. Hence carried forward from the previous summary, reset at boot (`btime`) | strong (source) for the defect; the carry-forward is the collector's own logic, tested |
| C20 | `stale_services[].since` = first hourly run that saw the unit stale | the collector's own carry-forward (precision: one timer period). A `since` from before the last boot (`btime`) is dropped — `/var/tmp` survives a reboot, but the reboot proves every process fresh — and with no readable boot time nothing is carried. Lost if the previous summary is unreadable — then it restarts at "now", which can only *delay* a 🟡, never invent one | medium — under-reports after a lost summary, never over-reports |
| C18 | package versions come from `dpkg-query -W` | probed 2026-10-08 unprivileged: `nodejs 24.21.0-1nodesource1`, `cloudflared 2026.10.0`, `litestream 0.5.11` | strong (probe) |

P1–P4 passed (P1/P3 on 2026-10-07, after stage 1's host steps). A claim that fails its probe is redesigned, not written into code.

## Out of scope

- Moving to Node 26 or Ubuntu 26.04 — the EOL lines only say when.
- Patching `gh` (developer tool, not production) and the 54 non-security `-updates`.
- An "idle host" detector for unattended reboots (rejected policy 2).
- The SSH hardening question (`0.0.0.0:22`) — noted, separate issue if wanted.

## spec.md

- §5.9 (Інфраструктура / деплой): the host-patching layer — what is patched
  automatically, what only reported, and the reboot button with its file handoff.
- `dailyStatus` row: the Інфраструктура row also reads the host-patch summary and the
  upstream facts; its "не виміряно" footer is unchanged (stage 2 of the traffic light is a
  different stage 2).
- Stage 3: the reboot alert job and its buttons.

## Testing

- Collector: a shell test with stub commands (`needrestart`, `canonical-livepatch`,
  `apt`, `dpkg-query`) and fixture files, asserting the exact JSON, the `null` on a
  failing command, and that `stale_services[].since` survives across runs.
- Reader: the `readTestDiagnostics` test matrix (owner, mode, symlink, size, stale, bad
  schema), with uid 0 as the trusted owner.
- Rules: each row of the rules table at its threshold and one unit either side; the
  disk-unreadable + reboot-red case returns red (the early return is gone).
- Upstream parsers: fixtures captured from the three URLs (C7–C9).
- Reboot request: the root handler as a shell test — accepts `now`/`0400` fresh,
  rejects stale, oversized, symlinked and unknown content, deletes the file in every
  case; the bot side — callback from a non-admin is refused, the file has the exact
  content, one alert per `since`.
