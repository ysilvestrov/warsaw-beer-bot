# #435 — automated reaction to production dependency vulnerabilities

Date: 2026-08-16
Status: agreed
Issue: #435
Related: `2026-08-14-411-runtime-dependency-upgrades-design.md` (the fourth manual round this
design exists to stop repeating)

## The model

> A fix may reach production without a human only when the machine that runs production can prove,
> by itself, that the change is a lockfile-only remedy for a live runtime advisory.

Every clause of that sentence is load-bearing and each one becomes a control below. "By itself"
rejects trusting a label, a tag, or a workflow's word. "Lockfile-only" is what makes the automated
path unable to carry our code. "Live" means measured against this repository's own audit, not
inferred from advisory metadata. "Runtime" is the dev/prod split that keeps the signal from
drowning in noise.

The design owns two streams that must never merge:

1. **Runtime** — an advisory in a package that is actually installed on the server. Automated all
   the way to a restarted service.
2. **Development** — an advisory in build or test tooling. Notification only, human hands, no
   automation whatsoever.

## Measured 2026-08-16 — why this exists

```
npm audit                            → 4 advisories (root: nanoid, postcss; extension: nanoid, postcss)
npm audit --omit=dev                 → 0 vulnerabilities
gh api .../vulnerability-alerts      → 404  (Dependabot alerts DISABLED)
gh api .../automated-security-fixes  → {"enabled":false}
gh api .../branches/main/protection  → 404  (no protection); rulesets → []
repo visibility                      → PUBLIC, collaborators: ysilvestrov (admin) only
workflows running vitest             → none
```

Four rounds of reactive cleanup are already in the history — `#182`, `#102`/`#103`, `#258`/`#273`,
`#415` — every one of them phrased as "clear advisories". The pattern is stable: a vulnerability
lives until somebody happens to run `npm audit` by hand. Four advisories are open right now and
were found the same way.

Two facts from that block set the whole shape of the design:

- **The dev/prod split costs one flag and is exact.** `deploy.sh` ends in `npm prune --omit=dev`,
  so the server physically holds only `dependencies`. `extension/package.json` declares *no*
  `dependencies` at all — the extension is build-time by construction and cannot produce a runtime
  advisory. Today's four advisories are therefore all development-stream, and a design that did not
  separate the streams would have opened with four false alarms.
- **There is no test gate.** `codex-review.yml` (paid AI review) and `pages.yml` are the only
  workflows. Merging a dependency bump today is merging blind, and any automation built on top of
  that is automation of blindness.

## Constraint discovered on the host

`deploy/deploy.sh` rsyncs `./` — the *current working tree* — into `/opt/warsaw-beer-bot`.
Production is this same host; GitHub has no route into it (no runner, no webhook receiver, no
inbound SSH). Three consequences, all binding:

1. **Autodeploy must never use the operator's working tree.** A timer firing mid-task would ship
   uncommitted work in progress. It gets its own checkout of an exact commit.
2. **`sudoers` needs no change.** `/etc/sudoers.d/warsaw-beer-bot` pins
   `rsync -a --delete … ./ /opt/warsaw-beer-bot/` relative to the *current directory*, so a run
   from any clean checkout satisfies the existing rule. A security feature that began by widening
   `sudo` would be self-defeating; this one does not touch it.
3. **The notifier cannot be the bot.** If a deploy takes the bot down, the bot cannot report that
   it is down. Notification is a direct Telegram API call from the deploy script.

## Design

### 1. Repository settings

- Enable Dependabot alerts and Dependabot security updates (`PUT .../vulnerability-alerts`,
  `PUT .../automated-security-fixes`).
- Protect `main`: require the `ci` status check; **do not require approving reviews**. Requiring a
  review would deadlock auto-merge forever — Dependabot cannot approve its own pull request — and
  the whole mechanism would silently degrade into a queue of open PRs.
- `required_status_checks.strict` stays **true**, and the qualify workflow is responsible for the
  consequence. See below.

**`strict` is a stall, and the design owns it.** Measured 2026-08-16, minutes after protection went
on: two green pull requests with auto-merge armed sat in `BEHIND` and did not move. `strict: true`
requires a branch to be current, **auto-merge does not update the branch** — it only waits — and
every merge makes every other open pull request stale. With a queue of them the state is a livelock,
and it is worst exactly when activity is highest.

Left alone this defeats the goal: a qualified `critical` fix could wait indefinitely inside a
mechanism built so that it would not wait. Dependabot does rebase when the base moves, but on its own
schedule, which is not ours to control.

Two alternatives were rejected. **`strict: false`** removes the stall but also removes the protection
against two pull requests that are each green alone and broken together — precisely the concurrent
dependency-bump case this system generates by design. **Relying on Dependabot's own rebase** keeps a
delay we neither bound nor observe.

So: `strict` stays, and the qualify workflow calls `gh pr update-branch` when a qualified pull request
is `BEHIND` (§4). The protection is kept and the unbounded wait is removed; the cost is one extra `ci`
run per update, which is the cheap half of the trade.

### 2. `ci.yml` — the gate that does not exist yet

Trigger: `pull_request` and `push: main`. Two jobs, root and `extension/`, each `npm ci` +
`npm run typecheck` + `npm test`. This is a prerequisite for everything else in the document;
without it "merge fast" means "merge blind".

### 3. `dependabot.yml`

Two `npm` ecosystems (`/` and `/extension`), weekly grouped version updates for the upkeep half of
the goal, `cooldown` configured for those. Security updates are opened by GitHub independently of
this file and are not subject to its schedule, its `open-pull-requests-limit`, or its `cooldown`.

### 4. Qualification — measured, not declared

**Verified 2026-08-16 against GitHub's documentation:** "The `cooldown` option is only available
for *version* updates, not *security* updates." The 48-hour hold therefore cannot be delegated to
`dependabot.yml` and is implemented here.

A pull request qualifies for the automated path when **all** of:

| condition | how it is decided |
|---|---|
| runtime scope, live advisory | `npm audit --omit=dev --audit-level=high` is **non-empty on the base** and **empty on the head** |
| author is Dependabot | `pull_request.user.login == 'dependabot[bot]'` |
| branch is not a fork | `pull_request.head.repo.full_name == 'ysilvestrov/warsaw-beer-bot'` |
| severity `critical` | no hold |
| severity `high` | fixing version published ≥ 48 h ago (npm registry `time` field) |
| `ci` green | required status check |

Severity is read from the **base** `npm audit --omit=dev --json` report, not from Dependabot
metadata or the alerts API. It is already in hand from the audit-diff, it needs no second source,
and it keeps the whole rule measured from one artifact. Where the base reports several severities,
the highest governs.

The publish time is that of the package version that both **changed in this PR's lockfile** and
appears in the base report's vulnerability set. If more than one qualifies, the **most recently
published** one governs — the hold is only as strong as its youngest component.

**Un-stalling a qualified pull request.** After arming auto-merge, the workflow checks
`mergeStateStatus`; on `BEHIND` it calls `gh pr update-branch` and stops there. It does not loop or
wait: updating the branch pushes a commit, which re-runs `ci`, which re-triggers this workflow — and
the hourly `schedule` run is the backstop if that chain is ever broken. Severity does not enter this;
a `hold` verdict has no auto-merge to un-stall, and re-basing a pull request that is not going to
merge yet only burns CI.

This step is the one piece of the design that acts on a pull request for a reason other than its
verdict, so it is deliberately the last thing the workflow does and it changes no label.

The audit-diff is the core of it. Dependabot's `dependency-type` metadata cannot distinguish
production from development for **transitive** packages — and both of today's advisories are
transitive, so a metadata-based rule would have been wrong on 100% of the available evidence. The
diff measures the property we actually care about ("this PR removes a production vulnerability")
instead of inferring it.

A qualifying PR gets label `autodeploy` and auto-merge (squash) enabled. A non-qualifying one gets
`deps-manual` and a notification. A `high` still inside its hold gets `autodeploy-pending`; an
hourly scheduled re-evaluation promotes it when the version ages out. That re-evaluation runs on
`schedule`, which executes `main`'s code with a full token and is unreachable from any pull
request — the promotion step therefore never runs code a PR author controls (§5, Layer 3).

### 5. Trust anchors — four layers, and the tag is not one of them

The tag is a *signal*, never a permission. Anyone can read this design and learn the tag's name.

**Layer 1 — identity cannot be forged.** GitHub assigns `dependabot[bot]`, and the login is
unregisterable by construction: GitHub usernames permit only alphanumerics and hyphens, never
square brackets. The head-repo check is stronger still — Dependabot pushes its branch *into* the
repository, and no outsider can push a branch to a public repository they lack write access to. A
fork PR fails it immediately.

**Layer 2 — a fork PR holds no rights.** GitHub issues fork-triggered runs a read-only
`GITHUB_TOKEN` and withholds secrets. A hostile PR cannot label itself, push a tag, or merge
itself. This is enforced by GitHub, not by our logic, which is why it is worth more than our logic.

**Layer 3 — never `pull_request_target` over head code.** That trigger grants a *write* token to a
fork PR's run; checking out the PR's code under it and executing anything (`npm ci` suffices —
install scripts run) hands repository write access to the author. It is the standard way schemes
like this are broken, and GitHub's own Dependabot troubleshooting page recommends it as one of
three workarounds. **This design takes a different one of the three.**

**Verified 2026-08-16 against GitHub's documentation:** runs triggered by Dependabot get "a
read-only `GITHUB_TOKEN` and do not have access to any secrets that are normally available". A
read-only token cannot apply a label or arm auto-merge, so qualification needs elevation — and the
documented third option is to raise scope with the `permissions` key rather than to change trigger.
Therefore:

- the qualify workflow runs on `pull_request` and declares `permissions: { contents: read,
  pull-requests: write }`. GitHub honours that elevation for Dependabot-triggered runs and still
  caps **fork** PRs at read-only, so the fork case stays powerless without us reasoning about it;
- the job is additionally gated on `user.login == 'dependabot[bot]'` **and**
  `head.repo.full_name == github.repository` (§5 Layer 1);
- **the workflow checks out `main`, not the pull request.** The PR's `package.json` and
  `package-lock.json` are fetched as *data* (`git show <head-sha>:<path>`) into a scratch directory.
  `npm audit` reads a lockfile without installing, so no package's install scripts run, and every
  line of tooling that executes comes from `main`. Nothing the PR author controls is ever executed
  by a job holding a write token;
- the tag is pushed by a **separate** workflow on `push: main` after the merge, likewise from
  `main`'s code and unreachable from any PR.

**Layer 4 — the host re-verifies everything, independently.** This is the anchor, because it holds
even if every layer above is wrong. Before deploying, `autodeploy.sh` checks:

- the tagged commit is an ancestor of `origin/main` — genuinely merged, not sitting on some branch;
- the diff from the currently-deployed commit to the target touches **only** `package.json` and
  `package-lock.json` at the repository root. Anything under `src/`, `deploy/`, `.github/`,
  `scripts/`, or `extension/` → refuse, deploy nothing, alert with the offending paths;
- `npm audit --omit=dev --audit-level=high` in the clean checkout confirms the advisory is gone.
  **Verified 2026-08-16: this runs from the lockfile alone, with no `node_modules` present**, so it
  costs nothing and happens strictly before anything is written to `/opt`.

The consequence worth stating plainly: **our code cannot reach production down the automated path.**
Even granting an attacker a tag on an arbitrary commit, the allowlist rejects it. Code ships only
by hand, exactly as it does today.

The host needs no credentials for any of this — `git fetch` against a public repository is
anonymous. Nothing on the production host holds a GitHub token.

*Rejected: requiring a signed tag.* It would add a fifth layer whose key would have to live in
GitHub Actions secrets, and it defends the layer that is already the weakest reason to trust the
tag. The allowlist is the control that matters, and it is verified locally.

### 6. Residual risk, stated rather than buried

A lockfile-only change is still arbitrary code: `npm ci` executes install scripts, and the package
then runs in production. The real trust boundary of this automation is **npm registry + GitHub
Advisory DB**, not this repository. Choosing to patch dependencies automatically *is* choosing to
trust that supply chain quickly, and the dominant contemporary attack — maintainer compromise
followed by a poisoned release — aims exactly there.

What narrows it: the automated path accepts only the version the Advisory DB names as the fix for a
specific CVE, which is far narrower than "latest release", plus the 48-hour hold on `high`, which
outlives most poisoned packages (they are typically pulled within hours). What remains: a
compromised package could publish a "fix" for its own advisory, and `critical` deploys with no
hold. That is an accepted trade — for `critical`, the risk of waiting was judged to exceed the risk
of a poisoned fix.

`npm ci` runs as the unprivileged `warsaw-beer-bot` user; install scripts inherit that and nothing
more.

### 7. The host-side deployer

A systemd timer (5 min, randomized delay) runs `deploy/autodeploy.sh` as `ysi` — the user the
existing `sudoers` fragment is pinned to. Under `flock`, so it can neither overlap itself nor
collide with a manual deploy.

1. `git fetch --tags` in a dedicated checkout at `${XDG_DATA_HOME:-~/.local/share}/wbb-autodeploy/repo`.
2. Newest `autodeploy-*` tag; exit if its commit already equals the deployed sha in the state file.
3. Run the Layer-4 checks. Any failure → alert, deploy nothing, exit non-zero.
4. `git checkout --detach <tag>` — clean by construction — then `./deploy/deploy.sh` from there.
5. Health check: poll `http://127.0.0.1:${API_PORT}/health` (`src/api/index.ts:41`, `API_PORT`
   default 3000) for `{"ok":true}`, with retries, up to 60 s.
6. Success → record the new sha, notify. Failure → roll back.

State lives in `${XDG_STATE_HOME:-~/.local/state}/wbb-autodeploy/state.json` and holds the deployed
sha and the previous one.

**Rollback** re-checks-out the previous recorded sha and re-runs `deploy.sh`. It deliberately does
exactly one thing and is not clever: if the rollback itself fails to come up healthy, the script
stops and pages the operator rather than attempting further repair. An automation that keeps
turning production over unattended after two failures is worse than one that stops and says so.

Note that a mid-deploy failure is partially self-limiting already: `dist/` is excluded from the
rsync and `set -e` aborts before the restart, so a failed `npm ci` or build leaves the old process
serving. The rollback exists for the case where the new code installs, builds, restarts, and *then*
fails to become healthy.

### 8. Notification

A `notify()` helper in `autodeploy.sh` calls the Telegram API with `curl`, reading
`TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_ID` from `/etc/warsaw-beer-bot/.env` via
`sudo -u warsaw-beer-bot` (already NOPASSWD). Independent of the bot process by design — see the
host constraint above.

Notified: a successful autodeploy (what was bumped, from which advisory); a refusal by any Layer-4
check, with paths; a health-check failure and the rollback outcome; a `deps-manual` PR awaiting
hands.

### 9. AI review does not run on Dependabot pull requests

`codex-review.yml` gains `if: github.event.pull_request.user.login != 'dependabot[bot]'`.

The reason is not cost. **Measured 2026-08-16:** `IGNORE_PATTERNS` at `scripts/ai-pr-review.ts:22`
already excludes `package-lock.json`, `*.md` and `docs/**`, so the 116 KB lockfile never enters the
context, and `#415` — a real dependency bump — produced a 24-line lockfile diff and ~2.7 KB total.
The marginal bill is negligible.

The reason is that there is nothing to review and nobody to read it:

- **No logic in scope.** After the ignore patterns, exactly one file survives on a Dependabot PR:
  `package.json`, whose diff is version-range strings. A reviewer built to find correctness bugs in
  code is handed a diff that contains no code. Measured fabrication rate is ~2% and recall on
  escaped bugs 0/4 — on real source. Here the numerator has nothing to be about.
- **No reader.** With auto-merge armed, the PR merges the moment the *required* checks pass. The AI
  review is not a required check and must not become one — it is paid and non-deterministic. Its
  comments therefore arrive on a pull request that is already merged and deployed. "How do we react
  to review comments on the automated path" has no answer because the path structurally has no
  point at which a reaction could occur.

What replaces it are four deterministic checks that cover what one would actually want inspected on
such a PR — manifest scope and semver-range style (below), plus `ci` and the audit-diff (§4). All
four are free, reproducible, and fail the same way every time.

On the `deps-manual` path a human is required by definition, and any code written to adapt to a
breaking change lands in a **separate, human-authored** pull request that gets an ordinary review.
So no dependency PR needs a comment-reaction protocol at either end.

**Manifest-scope check** (part of qualification, §4): the PR changes only `package.json` and
`package-lock.json`, and for every dependency the semver *range operator* is unchanged from base —
`^` stays `^`; only the numbers move. This is the caret-range policy from
`2026-08-14-411-runtime-dependency-upgrades-design.md`, enforced instead of remembered. It is also
the check most likely to be asked of an LLM by habit, which is exactly why it is written as code.

### 10. Independent daily audit

`prod-audit.yml`, scheduled daily: `npm audit --omit=dev --audit-level=high`. If production is
vulnerable, open or update an issue.

This exists because **Dependabot cannot always act**. When a transitive advisory needs a parent
package bumped, it opens no PR at all — and silence is indistinguishable from safety. This check
makes the system's knowledge of production independent of whether Dependabot managed to do
anything, which is what "Dependabot is a proposal, not a constant" requires.

## Interfaces

- `.github/dependabot.yml` — new.
- `.github/workflows/ci.yml` — new. Jobs `ci (root)`, `ci (extension)`; `ci` is the required check.
- `.github/workflows/dependabot-qualify.yml` — new. `pull_request` + hourly `schedule`.
  `permissions: { contents: read, pull-requests: write }`; checks out `main` and reads the PR's two
  files as data (§5, Layer 3).
- `.github/workflows/autodeploy-tag.yml` — new. `push: main`. Pushes `autodeploy-<utc-timestamp>`.
- `.github/workflows/prod-audit.yml` — new. Daily schedule.
- `scripts/autodeploy/qualify.ts` — new. Pure functions, no I/O, so they are unit-testable; the
  workflow does the fetching.
  - `qualify(base: AuditReport, head: AuditReport, severity, publishedAt, now) → { verdict: 'autodeploy' | 'hold' | 'manual', reason }`
  - `manifestScope(changedPaths: string[], base: PackageJson, head: PackageJson) → { ok: boolean, violations: string[] }`
    — enforces the two-file scope and the unchanged semver range operator (§9).
- `.github/workflows/codex-review.yml` — **modified**: the job gains
  `if: github.event.pull_request.user.login != 'dependabot[bot]'`. The only change to an existing
  workflow in this design.
- `deploy/autodeploy.sh` — new. Exit codes: `0` deployed or nothing to do, `1` guard refused,
  `2` deploy failed and rollback succeeded, `3` rollback failed (operator required).
- `deploy/wbb-autodeploy.service` / `.timer` — new.
- `deploy/README.md` — extended with the one-time timer install.
- Labels: `autodeploy`, `autodeploy-pending`, `deps-manual`.
- `deploy/deploy.sh`, `deploy/sudoers.d/warsaw-beer-bot`, `deploy/warsaw-beer-bot.service` —
  **unchanged**.

## Constraints

- **The autodeploy allowlist is exactly `package.json` and `package-lock.json` at the root.** Not
  `extension/**` — the extension is not deployed and cannot produce a runtime advisory, so an
  extension bump has no business restarting the server.
- **No `pull_request_target` anywhere in this repository.**
- **No job holding a write token may check out or execute pull-request code.** The qualify workflow
  checks out `main` and consumes the PR's manifest and lockfile as data only.
- **Branch protection must not require approving reviews** (§1).
- **No change to `sudoers`.** If an implementation step appears to need one, the step is wrong.
- **Autodeploy never reads the operator's working tree.**
- **The bot is never the notifier for deploy outcomes.**
- **No credentials on the production host** beyond what already exists.

## Testing

Most of this is bash and YAML, which Vitest does not see, so the deciding logic is moved into two
places that can be tested — and both tests must be mutation-proven, because a test here that cannot
fail is worse than no test at all.

1. `qualify()` unit tests: base clean → `manual` (nothing to fix); head still vulnerable →
   `manual`; `critical` fresh → `autodeploy`; `high` at 47 h → `hold`; `high` at 49 h →
   `autodeploy`. Mutation proof: drop the age comparison and the 47 h case goes green.
2. Allowlist guard integration test: Vitest builds throwaway git repositories in a temp dir and
   invokes `autodeploy.sh`'s guard, asserting **refusal** for a diff touching `src/`, for one
   touching `extension/package-lock.json`, and for a tag whose commit is not an ancestor of `main`;
   and **acceptance** for a root-lockfile-only diff. Mutation proof: widen the allowlist to `**` and
   the refusal cases go green.
3. `manifestScope()` unit tests: accepts a bump that moves only numbers under `^`; rejects a changed
   range operator (`^` → `~` or a pin); rejects a changed path outside the two files. Mutation proof:
   compare only the resolved versions instead of the operator and the range case goes green.
4. Rollback path: force the health check to fail and assert the previous sha is redeployed and exit
   code `2` is returned.
5. `ci.yml` proves itself by running on the pull request that introduces it.

The end-to-end path (alert → PR → merge → tag → timer → restart) is verified once, manually, by
letting the first real security PR run and watching it, not by a synthetic harness.

## Out of scope

- **Clearing the four current development advisories.** They are the dev stream: a notification and
  a separate ordinary PR. This design deliberately ships without fixing them, so that the first
  thing it does is demonstrate the split rather than obscure it.
- **`extension/` autodeploy.** The extension ships to the Chrome Web Store through
  `release:store`, an entirely different path with its own review latency.
- **Deploying anything but a lockfile automatically.** Feature and fix merges keep going out by
  hand.
- **Retiring `codex-review.yml`.** It keeps running, unchanged, on every human pull request. Only
  the Dependabot exclusion in §9 is in scope.
- **Litestream / database concerns.** A dependency bump does not touch schema.
