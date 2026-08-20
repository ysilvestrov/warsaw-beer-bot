# #458 — upgrade the production host from Node 20 to Node 24

Date: 2026-08-20
Status: agreed
Issue: #458
Related: `2026-08-16-435-dependency-security-autofix-design.md` (the mechanism this upgrade must not
disturb, and whose blind spot it exposed), `2026-08-14-411-runtime-dependency-upgrades-design.md`
Spawned: #467 (`stream-json` 3 migration), #468 (`jsdom` 30 conformance test), #469 (nothing watches
the runtime's own EOL)

## The model

> The dangerous interval is not the upgrade. It is the window between `apt` and `npm ci`, when a
> native module compiled for the old ABI is still on disk and `Restart=on-failure` is still armed.

Everything below is arranged around that one sentence. The runtime swap itself is a package install
that either works or does not, and we find out in the rehearsal, before anything system-wide moves.
What needs design is the interval in which production is *inconsistent with itself* — new
interpreter, old `better_sqlite3.node` — because in that interval systemd is willing to restart the
bot into a runtime that cannot load its database driver, and it will do so unattended.

We do not shrink that interval with cleverness. We cross it with both services deliberately stopped,
so that nothing can restart into it.

## Measured 2026-08-20 — why this is not "worth doing eventually"

```
node -v                                  → v20.20.2   (nodejs 20.20.2-1nodesource1, apt, /usr/bin/node)
nodejs release schedule, v20 "Iron"      → end: 2026-04-30
```

**Production has been running an end-of-life runtime for four months**, and nothing in this
repository was capable of saying so. The issue frames the upgrade as "worth doing deliberately, not
urgently"; that framing was written before the EOL date was checked.

The blind spot is structural, and it is the floor #435 stands on: `npm audit` reads the dependency
tree, Dependabot reads manifests, and #435's daily `prod-audit.yml` reads the same tree — the Node
runtime is in none of them. A V8 or OpenSSL CVE fixed upstream and never backported to our line
produces zero signal here. That is #469, split out deliberately: this design fixes the instance, not
the blind spot.

The rest of the host, measured the same day:

| fact | consequence |
|---|---|
| `/usr/bin/node` is a system-wide NodeSource apt package | one runtime serves every consumer on the host |
| `48-hours-trip.service` is a **second live service** on `/usr/bin/node`, separate unix user, `active` 23 days | it is inside the blast radius and must be handled explicitly, not left to discover the new runtime at its next unattended restart |
| `better-sqlite3` in `/opt/warsaw-beer-bot/node_modules` is **compiled from source** (`obj.target/`, `sqlite3.a`) | the host has a toolchain; `npm ci` rebuilds it against the new ABI with no upstream prebuild to wait for |
| NodeSource publishes `24.19.0-1nodesource1` for the same `nodistro` suite | the switch is one URI in `/etc/apt/sources.list.d/nodesource.sources` |
| `nodejs_20.20.2-1nodesource1_amd64.deb` is fetchable now; `/var/cache/apt/archives` holds no copy | the rollback anchor must be downloaded **before** the sources file changes, or it leaves the index with it |
| prod DB is 17 MB with a **26 MB live WAL** | a rehearsal copy must be `VACUUM INTO`, never `cp` |
| five workflows pin `node-version: 20`, not one | `ci.yml`, `codex-review.yml`, `dependabot-qualify.yml`, `prod-audit.yml`, `pages.yml` |

### Global tooling on this host — checked, not assumed

| package | where | declares | verdict |
|---|---|---|---|
| claude-code 2.1.234 | `~/.local/share/claude/versions/…`, an **ELF binary** from the native installer | its npm build declares `node>=22` | does not use `/usr/bin/node` at all — outside the blast radius |
| `@openai/codex` 0.147.0 | `/usr/lib/node_modules` | `engines: node>=16` | satisfied; the agent itself is a vendored Rust musl binary, Node is only the launcher shim |
| `@anthropic-ai/sdk` 0.111.0 (ours: `^0.116.0`) | global + our `dependencies` | **no `engines` field in any version** | unconstrained |

Nothing in the tooling blocks the move. Incidentally, the npm build of claude-code requires `>=22`,
so Node 20 was already out of support there too.

## Why 24 and not 22

The issue says 22, because that is the floor the three blocked packages declare
(`better-sqlite3` 13 → `node>=22`, `undici` 8 → `node>=22.19`). Neither declares an upper bound, so
24 satisfies them equally.

| line | status | EOL |
|---|---|---|
| v20 (current) | **EOL** | 2026-04-30 |
| v22 "Jod" | maintenance since 2025-10-21 | 2027-04-30 (~8 months) |
| v24 "Krypton" | **active LTS** | 2028-04-30 (~20 months) |
| v26 | LTS from 2026-10-28 | 2029-04-30 |

The procedure — rehearsal, stop window, native rebuild, rollback — is identical for 22 and 24. The
only difference is when we do it again: spring, or a year and a half out. 24 also makes `jsdom` 30
reproducible on this host, which is what #468 needs.

The honest cost: `better-sqlite3` 13 and `undici` 8 state ">= 22", not "tested on 24", so we are the
first here to run that pair on 24. The rehearsal exists to find that out while nothing system-wide
has changed, and falling back to 22 at that point costs one edited URI.

Node 26 is not a candidate: it becomes LTS on 2026-10-28, two months out.

## Design

### 1. Preflight — nothing system-wide changes

**1.1 The rollback anchor, first.** `apt-get download nodejs=20.20.2-1nodesource1`, stored under
`/var/backups/`. Ordering is load-bearing: rewriting the sources file to `node_24.x` removes 20.x
from the apt index, and there is no `.deb` in the local cache. Fetch it while the old repo is still
configured, or the rollback path becomes "find a `.deb` on the internet during an incident".

**1.2 The rehearsal.** The official `node-v24.19.0-linux-x64` tarball is unpacked into a throwaway
prefix under `./tmp/`. `/usr/bin/node` is untouched, no apt transaction runs, no service is stopped.
In a scratch clone of the repo at `HEAD`, with that prefix first on `PATH`:

- `npm ci && npm run build && npm test` (root), then the same for `extension/`;
- an explicit `better-sqlite3` probe: `require()` it, open `:memory:`, run one statement. The
  segfault in the issue happened at `require()` itself, so *loading* is an assertion worth making
  separately from the suite — a green `npm ci && npm run build` is exactly what preceded exit 139
  last time;
- a **consistent** copy of the prod DB via `VACUUM INTO` (the 26 MB WAL is why `cp` is wrong), then
  our own code against that copy: migrations plus a handful of real queries;
- a boot of `dist/index.js` against the copy with a deliberately invalid Telegram token, killed on a
  timer. It proves module load, DB open and migrations under the new runtime. It must **not** use
  the real token: a second instance would fight the live bot for `getUpdates`.

The rehearsal's output is evidence and goes into the pull request.

**1.3 The sibling service.** `48-hours-trip` is inspected under root — dependencies, `engines`, and
whether any `.node` binaries exist in its `node_modules`. Decision rule: native modules present →
it needs its own `npm ci` rebuild inside the cutover window; pure JS → a restart is enough. It is
not this repository's code, so the design states the rule rather than the outcome.

### 2. Cutover — one sitting, both services down

1. `touch ~/.local/state/wbb-autodeploy/PAUSED` — #435's unprivileged brake, so no security tag can
   land mid-flight.
2. `systemctl stop warsaw-beer-bot` **and** `48-hours-trip`. Stopping the sibling is deliberate: a
   running process survives `apt` on its deleted inode, then adopts the new runtime at whatever
   unattended restart comes next, which is precisely the failure we refuse to schedule for later.
3. Rewrite `/etc/apt/sources.list.d/nodesource.sources` to `node_24.x`; `apt update`;
   `apt install nodejs`; assert `node -v`.
4. `bash deploy/deploy.sh`. It already does exactly the right thing in the right order:
   `npm ci` (rebuilds `better-sqlite3` against the new ABI) → `npm run build` →
   `npm prune --omit=dev` → `systemctl restart` → record the #435 baseline.
5. Rebuild if required, then start and verify `48-hours-trip`.
6. Verify both journals, confirm the bot answers, then `rm PAUSED`.

### 3. Rollback

Trigger: step 4 fails, or the bot does not come up healthy.

`dpkg -i /var/backups/nodejs_20.20.2-1nodesource1_amd64.deb`, restore the sources URI to `node_20.x`,
re-run `deploy.sh` (the same `npm ci` rebuilds the native module back to the Node 20 ABI), start both
services. The repo pull request has not merged at this point, so nothing needs reverting in git.

### 4. The repository change — a pull request that merges *after* the host is on 24

- `package.json`: `engines.node` `>=20` → `>=24`. It should state what we run and test, not a floor
  nobody checks.
- All five workflows pinning `node-version: 20` move to 24, both `ci.yml` legs included. The issue
  named only `ci.yml`; `prod-audit.yml` (the #435 daily audit, which is supposed to reflect
  production) and `dependabot-qualify.yml` (which decides what deploys unattended) matter more.
- `.github/dependabot.yml`: drop the `better-sqlite3` and `undici` ignores. `stream-json` stays
  (#467 — a code migration, unrelated to Node). `jsdom` stays, **with its comment rewritten**: it was
  held partly because the failure could not be reproduced on a Node 20 host, and that excuse dies
  here while the defect does not (#468).
- `deploy/README.md`: the one-time host setup section names NodeSource; it gains 24.x and the
  rollback-anchor step.

### 5. A guard instead of a comment

`ci.yml` explains in prose that the root leg pins the version "because that is what production
runs". Prose does not go red. This design adds a test that parses `.github/workflows/*.yml` and
asserts every `node-version` equals the major in `engines.node`.

This is cheap, and it is the third time in two weeks that a green-looking check turned out to be
checking nothing (#435's CI gate, the vacuous test seeds, now this). Mutation proof: set one
workflow back to 20 and the test must fail.

## Interfaces

| touched | by whom | when |
|---|---|---|
| `/etc/apt/sources.list.d/nodesource.sources` | operator, once | cutover step 3 |
| `/var/backups/nodejs_20.20.2-1nodesource1_amd64.deb` | operator, once | preflight 1.1 |
| `~/.local/state/wbb-autodeploy/PAUSED` | operator | held for the whole cutover |
| `deploy/deploy.sh` | **unchanged** — it is invoked, not modified | cutover step 4 |
| `package.json` → `engines.node` | pull request | after the host is on 24 |
| `.github/workflows/{ci,codex-review,dependabot-qualify,prod-audit,pages}.yml` | pull request | same |
| `.github/dependabot.yml` | pull request | same |
| `deploy/README.md` | pull request | same |

## Constraints

- **The host moves first, the repository second.** CI must never claim to test a runtime production
  is not running. That is why the pull request merges after the cutover, not before.
- **`deploy.sh` is not modified by this work.** If a step appears to need a change there, the step is
  wrong: the rebuild-then-restart order it already implements is what makes the ABI window safe.
- **The rehearsal never touches `/usr/bin/node`, the live database, or the real bot token.**
- **Both services are stopped across the ABI window.** Neither may be left running to "probably be
  fine".
- **The rollback anchor is downloaded before the sources file changes.** Non-negotiable ordering.
- **No second Node on the host.** Approach (B), a private runtime for our service only, was
  considered and rejected: it taxes every future script that writes `node` or `npm`, and a wrong
  `npm ci` under the wrong runtime reproduces the exact segfault this issue is about.

## Testing

There is no unit test for "the host runs the right runtime", so the evidence is layered:

1. **The rehearsal** (preflight 1.2) is the real gate, and it runs before anything system-wide
   changes. Its output — test results, the `better-sqlite3` load probe, migrations against a copy of
   the production database — is pasted into the pull request.
2. **CI on the pull request** runs the full suite on 24 for both legs. Until the workflows move, no
   check in this repository has ever executed our code on 24.
3. **The workflow/engines guard** (§5), with the mutation proof stated above.
4. **Post-cutover verification**: both journals clean, the bot answers, and #435's timer resumes with
   `DEPLOYED_SHA` equal to `main`.

## Out of scope

Each has its own issue, so that none of them survives as a comment in a YAML file:

- **#467** — `stream-json` 3 migration. Held for an unrelated reason and still blocked after Node 24.
- **#468** — `jsdom` 30's conformance failure. The upgrade removes the excuse, not the defect.
- **#469** — nothing watches the runtime's own EOL. The reason this issue was found by a segfault
  rather than by a monitor.
- **Node 26.** LTS on 2026-10-28; revisiting before then would be churn.
