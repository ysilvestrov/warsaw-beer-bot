# Design: make orphan-ops tools prod-reachable via `dist` (#328)

**Date:** 2026-07-20
**Issue:** [#328](https://github.com/…/issues/328) — *ops: make `scripts/*.ts` tools runnable in prod (compile to dist / NOPASSWD wrapper) instead of hand-written SQL*
**Related memory:** `feedback_ops_tooling_reachability`, `reference_prod_deploy_and_db_ops`

## Problem

The routine DB-writing ops tools under `scripts/` — `rearm-aliased-orphans`,
`rearm-matcher-bug-orphans`, `retire-resolved-orphans` — cannot be run against
production as-is:

- They execute via `tsx` (a devDependency). `deploy.sh` runs
  `npm prune --omit=dev`, so `tsx` is **absent** from `/opt/warsaw-beer-bot`.
- `tsconfig` builds only `src/` (`rootDir: "src"`, `include: ["src/**/*"]`), so
  nothing in `scripts/` lands in `dist/`. The `.ts` source *is* rsynced into
  `/opt` (scripts is not excluded), but there is no runtime to execute it.
- The prod DB (`/var/lib/warsaw-beer-bot/bot.db`) is owned by `warsaw-beer-bot`;
  `/home/ysi` is `0750`, so the bot user cannot run `tsx` from the dev checkout
  either.

Net: to run one of these tools in prod today, its DB write must be replicated as
hand-written SQL via the bot-user path. That works but can **drift** from the
tool's real selection logic and skips its dry-run / logging safeguards.

### Key finding: the sudo reach already exists

`deploy/sudoers.d/warsaw-beer-bot` (item 3) already grants:

```
ysi ALL=(warsaw-beer-bot) NOPASSWD: /usr/bin/bash -lc *
```

So Claude can already run **any** command as the bot user against the prod DB.
The *only* real blocker is compilation: there is TypeScript source in `/opt`
with nothing to run it. Therefore the fix is simply **to get the ops entrypoints
emitted into `dist/`** — at which point they are immediately reachable with
plain `node`, with **no new sudoers file and no new one-time host setup**.

## Goal

Make the routine orphan-ops tools runnable in production by the blessed
(compiled) code path, so a follow-up like "rearm after an alias batch" is a
single reachable command — no ad-hoc SQL.

## Approach (chosen)

**Compile the ops entrypoints into `dist` by relocating them under `src/ops/`.**

`src/ops/**` is already covered by the existing tsconfig
(`include: ["src/**/*"]`, `rootDir: "src"`), so `tsc` emits `dist/ops/*.js` with
no config change. Plain `node dist/ops/*.js` then runs in `/opt` after the
dev-prune, via the existing `bash -lc *` rule.

Rejected alternatives (recorded for the "why"):

- **Dedicated NOPASSWD ops wrapper** (`deploy/bin/ops.sh` + new
  `deploy/sudoers.d/…`). Adds a new one-time host-setup step and is **redundant
  while the broad `bash -lc *` rule stands** — it would only earn its keep if we
  later chose to *narrow* that rule (a separate follow-up).
- **Keep `tsx` in prod** (move it to `dependencies` / stop pruning it). Lowest
  churn — existing `npm run rearm-…` scripts would just work — but it bloats prod
  `node_modules` and runs uncompiled TS in prod, against the team's deliberate
  prune-and-compile posture.

## Scope

**Move set** (each with its co-located `.test.ts`):

| From | To |
| --- | --- |
| `scripts/operator-env.ts` | `src/ops/operator-env.ts` |
| `scripts/rearm-aliased-orphans.ts` | `src/ops/rearm-aliased-orphans.ts` |
| `scripts/rearm-matcher-bug-orphans.ts` | `src/ops/rearm-matcher-bug-orphans.ts` |
| `scripts/retire-resolved-orphans.ts` | `src/ops/retire-resolved-orphans.ts` |

**Stays in `scripts/`** (CI / dev / build; no prod-DB-write need):
`ai-pr-review`, `bench-match`, `brewery-alias-key`, `render-docs`,
`publish-extension-release`, `apply-extension-release`, `set-env`,
`github-env-multiline`.

`operator-env` is imported **only** by the three ops tools, and
`brewery-alias-key` is pure (no env/DB) — so the move set is self-contained with
no cross-boundary import left behind.

## Mechanics

- **Import paths flip** from `../src/…` to `../…` inside the moved files
  (e.g. `../config/env`, `../storage/db`, `../domain/matcher`,
  `../storage/enrich_failures`, `../sources/ontap/non-beer`). Sibling imports
  (`./operator-env`, `./rearm-aliased-orphans`) are unchanged.
- **No tsconfig change.** tsc already emits `src/**/*.test.ts` into `dist`, so
  co-located ops tests emitting to `dist/ops/*.test.js` is consistent with
  existing convention (harmless; never executed).
- **Runtime deps only.** The tools import `better-sqlite3`, `dotenv`, and
  `src/**` domain code — all prod dependencies — so `node dist/ops/*.js` runs
  clean after `npm prune --omit=dev`.
- **npm script names unchanged** (`rearm-aliased-orphans`,
  `rearm-matcher-bug-orphans`, `retire-resolved-orphans`), just repointed to
  `tsx src/ops/…ts` for local dev. Preserves muscle memory and existing doc
  references; existing `--apply` / dry-run defaults are untouched.

## Prod invocation (the payoff)

Reachable via the existing sudoers rule — no new host setup:

```bash
# dry-run (default)
sudo -u warsaw-beer-bot bash -lc \
  'cd /opt/warsaw-beer-bot && node dist/ops/rearm-matcher-bug-orphans.js'

# write
sudo -u warsaw-beer-bot bash -lc \
  'cd /opt/warsaw-beer-bot && node dist/ops/rearm-matcher-bug-orphans.js --apply'
```

The same shape applies to `rearm-aliased-orphans.js` and
`retire-resolved-orphans.js` (the latter keeps its `--ids <csv> --reason "<text>"`
escape hatch).

## Doc updates (same PR)

- **`deploy/README.md`** (~lines 87–89): currently documents
  `npm run rearm-matcher-bug-orphans` as the prod command — **that path is
  broken** (`tsx` pruned). Rewrite to the `node dist/ops/…` form above.
- **`spec.md`** (ops-runbook section, ~line 1114): add the prod
  `node dist/ops/…` invocation alongside the dev `npm run` note. Tool names and
  behavior are otherwise unchanged; the `retire-resolved-orphans` / `retired_at`
  schema text stays as-is. Add a one-line note that the ops tools live under
  `src/ops/` and compile to `dist/ops/`.
- **`docs/debug-orphan-matching.md`**: dev `npm run rearm-aliased-orphans`
  commands stay valid — no change.
- **No `extension/**` touch** → no `docs/extension-install-uk.md` update.

## Testing / verification

- Tests move alongside their tools with sibling imports intact; vitest
  `include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']` already covers the new
  location. Full `npm test` must stay green.
- `npm run typecheck` / `npm run build` must succeed (proves the relocated
  imports resolve and `dist/ops/*.js` is emitted).
- **End-to-end smoke:** after `npm run build`, run
  `DOTENV_CONFIG_PATH=/dev/null DATABASE_PATH=/tmp/ops-smoke.db node dist/ops/rearm-aliased-orphans.js`
  against a throwaway migrated DB and confirm the dry-run prints and writes
  nothing — proving the compiled prod path works without `tsx`.

## Out of scope

- No dedicated NOPASSWD wrapper / new sudoers file (reach already exists).
  Narrowing the broad `bash -lc *` rule is a possible **future** follow-up.
- `brewery-alias-key` / `bench-match` stay in `scripts/` (read-only / dev).
