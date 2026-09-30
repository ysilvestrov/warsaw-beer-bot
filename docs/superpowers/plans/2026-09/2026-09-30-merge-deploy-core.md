# Merge-deploy — core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host deploys the head of `origin/main` by itself. It waits for 10 min of quiet, for CI to pass on that exact commit, and for no hold to be present; it takes a DB snapshot and runs a trial migration before the deploy, then watches a 10-min window and rolls back code **and** database inside it.

**Architecture:** `deploy/autodeploy.sh` (run by the existing `wbb-autodeploy.timer` as `ysi`) is rewritten from "deploy the newest `autodeploy-*` tag" to "deploy `origin/main`". Two new installed helpers do the risky parts. `deploy/db-snapshot.sh` handles snapshot, post, mark, restore and prune, and runs as `warsaw-beer-bot`. `deploy/trial-migrate.cjs` runs the new build's `migrate()` on a copy. Every external contact of the tick is a `WBB_*` seam, so the tests never touch sudo, systemd, `/opt`, GitHub or the network (the I2 discipline of #435).

**Tech Stack:** bash 5.2, sqlite3 CLI, Node 24 + better-sqlite3, vitest, git, `gh api`.

**Spec:** `docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md`. Read it first: it holds the decisions D1–D9, the claim → evidence table and the probe results P1–P4. The plan argues from it.

**Scope — this is the CORE plan only** (CLAUDE.md: a large change is staged). The periphery is a **separate plan, written after the end-to-end review of this one**: the PR-side `deploy-hold` CI job, the deletion of `autodeploy-tag.yml` / `autodeploy-guard.sh` / tags, the `automerge` rename in `dependabot-qualify.yml`, `deploy/README.md`, `spec.md`, the `CLAUDE.md`/`AGENTS.md` `[deploy:hold]` rule, and closing #498/#499. Nothing in this plan edits those files, except that Task 3 removes the guard **pair** from `installed_is_stale`, because the new tick no longer calls the guard.

**Worktree note:** the spec commits (`f2cccf6`, `85de7a1`, `27c7c88`) and this plan exist only on local `main`. After `EnterWorktree` (which branches from `origin/main`), cherry-pick them in first.

## Global Constraints

- The code beats this plan. Where a claim here about existing code disagrees with the file, the file wins: say so in the report and do not bend the code to match the plan.
- Every task ends with the **full** gate: `npm test && npm run typecheck`, never a scoped run.
- Test-quality rules from CLAUDE.md apply: exact `toBe`/`toEqual`, no `if`/early return in tests, no tautologies, cover boundaries and failures, and no expected values computed by repeating production logic.
- Stubs must return **visible** values (a `null`/empty stub makes "ignored" and "used" look identical).
- Snapshots are taken with `VACUUM INTO` from a `mode=ro` connection, **never** the SQLite backup API (spec P1: it starved for 18.5 s under a writer).
- Quiet period `600` s, rollback window `600` s, poll `10` s, startup health limit `60` s, CI-stuck notice after `3600` s, keep the newest `3` settled `pre` snapshots. A rollback pair is **never** deleted by the machine.
- Snapshot directory: `/var/lib/warsaw-beer-bot/deploy-snapshots`. Snapshot name: `<UTC %Y%m%dT%H%M%SZ>-<sha7>-pre.db` plus `<name>.sha256` (the hash only). After a rollback: `…-rollback-pre.db` and a `…-rollback-post/` directory.
- Hold label: exactly `deploy:hold`. Required CI check name: exactly `ci`.
- Telegram is reached by the deployer directly, never via the bot (unchanged #435 principle).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `deploy/db-snapshot.sh` (new; installed as `/usr/local/bin/wbb-db-snapshot`) | snapshot / post / mark-rollback / restore / prune of the production DB | 1 |
| `scripts/autodeploy/db-snapshot.test.ts` (new) | real sqlite3 against temp DBs | 1 |
| `deploy/trial-migrate.cjs` (new; installed as `/usr/local/bin/wbb-trial-migrate`) | the new build's `migrate()` twice on a copy, then the pragmas | 2 |
| `scripts/autodeploy/trial-migrate.test.ts` (new) | fake clone with a real better-sqlite3 | 2 |
| `deploy/autodeploy.sh` (rewritten) | the tick: select, qualify, build, snapshot, trial, deploy, watch, settle, roll back | 3, 4, 5 |
| `scripts/autodeploy/autodeploy.test.ts` (rewritten) | every branch of the tick, with stubs | 3, 4, 5 |
| `deploy/install-autodeploy.sh` | installs the two new helpers, dependencies first | 1, 2 |
| `scripts/autodeploy/install-invariant.test.ts` | pins the installed-copy pair list | 1, 2, 3 |
| `deploy/wbb-autodeploy.service` | `TimeoutStartSec=30min`, so a tick can outlive the window | 4 |

---

### Task 1: `db-snapshot.sh` — the snapshots behind the rollback

**Files:**
- Create: `deploy/db-snapshot.sh`
- Create: `scripts/autodeploy/db-snapshot.test.ts`
- Modify: `deploy/install-autodeploy.sh` (install line + `ls` line)
- Modify: `deploy/autodeploy.sh` (the `installed_is_stale` pair list, plus a `SNAPSHOT_BIN` line beside `SHIPS_BIN`)
- Modify: `scripts/autodeploy/install-invariant.test.ts`

**Interfaces:**
- Produces: `db-snapshot.sh snapshot <db> <out.db>` → exit 0, prints `<out.db>`; `post <db> <dir>` → exit 0, prints `<dir>`; `mark-rollback <x-pre.db>` → exit 0, prints the new `x-rollback-pre.db` path; `restore <snap.db> <db>` → exit 0; `prune <dir> <keep>` → exit 0. Refusal = exit 1 with the reason on stderr; usage = exit 64. Task 4 calls `snapshot` and `prune`, Task 5 calls `mark-rollback`, `post` and `restore`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/autodeploy/db-snapshot.test.ts`:

```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Merge-deploy (spec 2026-09-30, P1–P3). The rollback window is only as good
 * as these five operations, so every one runs against REAL SQLite files.
 */
const SCRIPT = resolve(__dirname, '../../deploy/db-snapshot.sh');

function snap(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function tags(p: string): string[] {
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare('SELECT tag FROM t ORDER BY id').all() as { tag: string }[]).map((r) => r.tag);
  } finally {
    db.close();
  }
}

/** A DB file whose rows are committed but still ONLY in the WAL. */
function walOnlyDb(dir: string, rows: string[]): { path: string; db: Database.Database } {
  const path = join(dir, 'bot.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, tag TEXT)');
  const ins = db.prepare('INSERT INTO t(tag) VALUES (?)');
  for (const r of rows) ins.run(r);
  return { path, db };
}

/** A closed, checkpointed DB with the given rows. */
function plainDb(path: string, rows: string[]): void {
  const db = new Database(path);
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, tag TEXT)');
  const ins = db.prepare('INSERT INTO t(tag) VALUES (?)');
  for (const r of rows) ins.run(r);
  db.close();
}

describe('db-snapshot.sh snapshot', () => {
  it('captures rows that are committed only to the WAL, and writes a matching checksum', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const { path, db } = walOnlyDb(dir, ['a', 'b']);
    // Premise: the main file alone does NOT hold the table yet — otherwise
    // this test would pass for a snapshot that ignores the WAL.
    copyFileSync(path, join(dir, 'main-only.db'));
    // Read-write on purpose: a read-only open of a WAL file without its -shm fails.
    const mainOnly = new Database(join(dir, 'main-only.db'));
    const inMain = mainOnly.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 't'").get() as { n: number };
    mainOnly.close();
    expect(inMain.n).toBe(0);

    const out = join(dir, 'snaps', '20260930T120000Z-abc1234-pre.db');
    const r = snap('snapshot', path, out);
    db.close();

    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(out);
    expect(tags(out)).toEqual(['a', 'b']);
    expect(readFileSync(`${out}.sha256`, 'utf8').trim()).toBe(sha(out));
    expect(existsSync(`${out}.partial`)).toBe(false);
  });

  it('refuses to overwrite an existing snapshot', () => {
    const dir = makeTempDirectory('wbb-snap-');
    plainDb(join(dir, 'bot.db'), ['a']);
    const out = join(dir, 'x-pre.db');
    writeFileSync(out, 'keep me');

    const r = snap('snapshot', join(dir, 'bot.db'), out);

    expect(r.code).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe('keep me');
  });

  it('refuses a target path containing a quote instead of splicing it into SQL', () => {
    const dir = makeTempDirectory('wbb-snap-');
    plainDb(join(dir, 'bot.db'), ['a']);
    const out = join(dir, "it's-pre.db");

    const r = snap('snapshot', join(dir, 'bot.db'), out);

    expect(r.code).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe('db-snapshot.sh post', () => {
  it('copies the database with its -wal and -shm byte for byte', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const { path, db } = walOnlyDb(dir, ['a']);
    const post = join(dir, 'x-rollback-post');

    const r = snap('post', path, post);
    const walSha = sha(`${path}-wal`); // before close(): closing checkpoints and deletes the WAL
    db.close();

    expect(r.code).toBe(0);
    expect(readdirSync(post).sort()).toEqual(['bot.db', 'bot.db-shm', 'bot.db-wal']);
    expect(sha(join(post, 'bot.db-wal'))).toBe(walSha);
  });
});

describe('db-snapshot.sh mark-rollback', () => {
  it('renames the snapshot and its checksum and prints the new path', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const pre = join(dir, '20260930T120000Z-abc1234-pre.db');
    writeFileSync(pre, 'db');
    writeFileSync(`${pre}.sha256`, 'h\n');

    const r = snap('mark-rollback', pre);

    const marked = join(dir, '20260930T120000Z-abc1234-rollback-pre.db');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(marked);
    expect(readdirSync(dir).sort()).toEqual([
      '20260930T120000Z-abc1234-rollback-pre.db',
      '20260930T120000Z-abc1234-rollback-pre.db.sha256',
    ]);
  });

  it('refuses a file that is not a pre snapshot, and leaves it alone', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const other = join(dir, 'bot.db');
    writeFileSync(other, 'db');

    const r = snap('mark-rollback', other);

    expect(r.code).toBe(1);
    expect(readdirSync(dir)).toEqual(['bot.db']);
  });
});

describe('db-snapshot.sh restore', () => {
  it('replaces the database with the snapshot and removes the stale -wal/-shm', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const live = join(dir, 'bot.db');
    plainDb(live, ['new']);
    writeFileSync(`${live}-wal`, 'stale wal');
    writeFileSync(`${live}-shm`, 'stale shm');
    plainDb(join(dir, 'old.db'), ['old']);
    const pre = join(dir, 's', '20260930T120000Z-abc1234-rollback-pre.db');
    expect(snap('snapshot', join(dir, 'old.db'), pre).code).toBe(0);

    const r = snap('restore', pre, live);

    expect(r.code).toBe(0);
    expect(tags(live)).toEqual(['old']);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
    expect(existsSync(`${live}.restore-partial`)).toBe(false);
  });

  it('refuses a snapshot whose checksum does not match, leaving the database untouched', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const live = join(dir, 'bot.db');
    plainDb(live, ['new']);
    plainDb(join(dir, 'old.db'), ['old']);
    const pre = join(dir, 's', 'x-rollback-pre.db');
    expect(snap('snapshot', join(dir, 'old.db'), pre).code).toBe(0);
    writeFileSync(`${pre}.sha256`, '0'.repeat(64) + '\n');

    const r = snap('restore', pre, live);

    expect(r.code).toBe(1);
    expect(tags(live)).toEqual(['new']);
  });
});

describe('db-snapshot.sh prune', () => {
  it('keeps the newest N settled snapshots and never touches a rollback pair', () => {
    const dir = makeTempDirectory('wbb-snap-');
    const names = [
      '20260901T000000Z-aaaaaaa-rollback-pre.db',
      '20260902T000000Z-bbbbbbb-pre.db',
      '20260903T000000Z-ccccccc-pre.db',
      '20260904T000000Z-ddddddd-pre.db',
      '20260905T000000Z-eeeeeee-pre.db',
      '20260906T000000Z-fffffff-pre.db',
    ];
    for (const n of names) {
      writeFileSync(join(dir, n), n);
      writeFileSync(join(dir, `${n}.sha256`), 'h\n');
    }

    const r = snap('prune', dir, '3');

    expect(r.code).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([
      '20260901T000000Z-aaaaaaa-rollback-pre.db',
      '20260901T000000Z-aaaaaaa-rollback-pre.db.sha256',
      '20260904T000000Z-ddddddd-pre.db',
      '20260904T000000Z-ddddddd-pre.db.sha256',
      '20260905T000000Z-eeeeeee-pre.db',
      '20260905T000000Z-eeeeeee-pre.db.sha256',
      '20260906T000000Z-fffffff-pre.db',
      '20260906T000000Z-fffffff-pre.db.sha256',
    ]);
  });

  it('refuses keep=0 and deletes nothing', () => {
    const dir = makeTempDirectory('wbb-snap-');
    writeFileSync(join(dir, '20260902T000000Z-bbbbbbb-pre.db'), 'x');

    const r = snap('prune', dir, '0');

    expect(r.code).toBe(1);
    expect(readdirSync(dir)).toEqual(['20260902T000000Z-bbbbbbb-pre.db']);
  });
});

describe('db-snapshot.sh usage', () => {
  it('exits 64 on an unknown subcommand', () => {
    expect(snap('frobnicate').code).toBe(64);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run scripts/autodeploy/db-snapshot.test.ts`
Expected: FAIL. Every case fails because `deploy/db-snapshot.sh` does not exist (bash exits 127).

- [ ] **Step 3: Implement `deploy/db-snapshot.sh`**

```bash
#!/usr/bin/env bash
# Merge-deploy — the DB snapshots behind the rollback window.
# Spec: docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md (P1–P3).
#
# In production this runs as warsaw-beer-bot through the existing
# `(warsaw-beer-bot) NOPASSWD: /usr/bin/bash -lc *` rule, so everything it
# writes is owned by the bot user and lives next to bot.db, outside rsync's
# reach (/var/lib, not /opt). Installed as /usr/local/bin/wbb-db-snapshot.
#
#   db-snapshot.sh snapshot <db> <out.db>      VACUUM INTO + <out.db>.sha256
#   db-snapshot.sh post <db> <out-dir>         file copy of db, -wal, -shm (bot STOPPED)
#   db-snapshot.sh mark-rollback <x-pre.db>    rename to x-rollback-pre.db, print it
#   db-snapshot.sh restore <snap.db> <db>      verify sha256, atomic replace, drop -wal/-shm
#   db-snapshot.sh prune <dir> <keep>          keep the newest <keep> settled *-pre.db
#
# Exit: 0 ok, 1 refused or failed (reason on stderr), 64 usage.
set -euo pipefail

usage() { echo "usage: db-snapshot.sh snapshot|post|mark-rollback|restore|prune ..." >&2; exit 64; }
die() { echo "db-snapshot: $*" >&2; exit 1; }

# P1: VACUUM INTO, never the backup API. The backup API restarts on every
# foreign write; against a steady writer it finished only when the writer
# stopped (18.5 s in the probe). VACUUM INTO runs inside ONE read transaction,
# so it is one point in time and cannot be starved.
# The target is spliced into SQL, so a quote in it is refused, not escaped.
cmd_snapshot() {
  local db="$1" out="$2" tmp
  case "$out" in *"'"*) die "refusing a path containing a quote: $out" ;; esac
  [ -f "$db" ] || die "no database at $db"
  [ ! -e "$out" ] || die "refusing to overwrite $out"
  mkdir -p "$(dirname "$out")"
  tmp="$out.partial"
  rm -f "$tmp"
  if ! sqlite3 "file:${db}?mode=ro" "VACUUM INTO '${tmp}'"; then
    rm -f "$tmp"
    die "VACUUM INTO failed for $db"
  fi
  sha256sum < "$tmp" | cut -d' ' -f1 > "$out.sha256"
  mv "$tmp" "$out"
  echo "$out"
}

# The bot is STOPPED when this runs (rollback step 3), so a plain file copy is
# consistent, and -wal holds the writes that exist nowhere else.
cmd_post() {
  local db="$1" dir="$2" f
  [ -f "$db" ] || die "no database at $db"
  [ ! -e "$dir" ] || die "refusing to overwrite $dir"
  mkdir -p "$dir"
  for f in "$db" "$db-wal" "$db-shm"; do
    if [ -f "$f" ]; then
      cp -p "$f" "$dir/" || die "copy of $f failed"
    fi
  done
  echo "$dir"
}

# Marked BEFORE the restore, so a rollback that dies half-way never leaves an
# unmarked pre snapshot for prune to delete.
cmd_mark() {
  local pre="$1" marked
  case "$pre" in
    *-rollback-pre.db) die "already marked: $pre" ;;
    *-pre.db) ;;
    *) die "not a pre snapshot: $pre" ;;
  esac
  [ -f "$pre" ] || die "no snapshot at $pre"
  [ -f "$pre.sha256" ] || die "no checksum for $pre"
  marked="${pre%-pre.db}-rollback-pre.db"
  mv "$pre" "$marked"
  mv "$pre.sha256" "$marked.sha256"
  echo "$marked"
}

# P2: litestream picks a replaced file up by itself (no `litestream reset`),
# PROVIDED no stale -wal/-shm is left next to it. P3: a temp file in the same
# directory + mv is atomic and needs no chown when run as the bot user.
cmd_restore() {
  local snap="$1" db="$2" want got tmp
  [ -f "$snap" ] || die "no snapshot at $snap"
  [ -f "$snap.sha256" ] || die "no checksum for $snap"
  want=$(tr -d '[:space:]' < "$snap.sha256")
  got=$(sha256sum < "$snap" | cut -d' ' -f1)
  [ "$want" = "$got" ] || die "checksum mismatch for $snap: want $want, got $got"
  tmp="$db.restore-partial"
  cp "$snap" "$tmp"
  mv -f "$tmp" "$db"
  rm -f "$db-wal" "$db-shm"
  echo "restored $db from $snap"
}

# Settled pre snapshots only. A rollback pair is evidence a human has to
# reconcile; this script never deletes one. Names start with a UTC stamp, so
# byte order is chronological.
cmd_prune() {
  local dir="$1" keep="$2" all=() listing f i n
  case "$keep" in ''|*[!0-9]*) die "keep must be a non-negative integer: $keep" ;; esac
  [ "$keep" -ge 1 ] || die "keep must be at least 1"
  [ -d "$dir" ] || return 0
  listing=$(find "$dir" -maxdepth 1 -type f -name '*-pre.db' ! -name '*-rollback-pre.db' | LC_ALL=C sort) \
    || die "cannot list $dir"
  while IFS= read -r f; do
    if [ -n "$f" ]; then all+=("$f"); fi
  done <<< "$listing"
  n=${#all[@]}
  i=0
  while [ "$i" -lt $(( n - keep )) ]; do
    rm -f "${all[$i]}" "${all[$i]}.sha256"
    echo "pruned ${all[$i]}"
    i=$((i + 1))
  done
}

[ $# -ge 1 ] || usage
sub=$1
shift
case "$sub" in
  snapshot)      [ $# -eq 2 ] || usage; cmd_snapshot "$@" ;;
  post)          [ $# -eq 2 ] || usage; cmd_post "$@" ;;
  mark-rollback) [ $# -eq 1 ] || usage; cmd_mark "$@" ;;
  restore)       [ $# -eq 2 ] || usage; cmd_restore "$@" ;;
  prune)         [ $# -eq 2 ] || usage; cmd_prune "$@" ;;
  *)             usage ;;
esac
```

- [ ] **Step 4: Register the installed copy**

In `deploy/install-autodeploy.sh`, add this line directly **after** `install -m 0755 deploy/ships.sh /usr/local/bin/wbb-ships`. It is a dependency, so it goes before the consumer:

```bash
install -m 0755 deploy/db-snapshot.sh         /usr/local/bin/wbb-db-snapshot
```

Also add `/usr/local/bin/wbb-db-snapshot` to the `ls -l` line under `== installed ==`.

In `deploy/autodeploy.sh`, add after the `SHIPS_BIN=` line:

```bash
# Merge-deploy — the snapshot helper, installed like the guard and the predicate.
SNAPSHOT_BIN="${WBB_SNAPSHOT_BIN:-/usr/local/bin/wbb-db-snapshot}"
```

In `installed_is_stale()`, add to the pair list (before the `installed-current.sh` pair):

```bash
      "deploy/db-snapshot.sh=$SNAPSHOT_BIN" \
```

In `scripts/autodeploy/install-invariant.test.ts`, add inside the pinned test `names the four original scripts and ships.sh`:

```ts
    expect(declared).toContain('deploy/db-snapshot.sh');
```

- [ ] **Step 5: Run the new tests, then the full gate**

Run: `npx vitest run scripts/autodeploy/db-snapshot.test.ts`
Expected: PASS (12 tests).

Mutation check (required, then revert): delete the line `rm -f "$db-wal" "$db-shm"` in `cmd_restore`. Run again: the test `replaces the database … removes the stale -wal/-shm` must FAIL. Restore the line.

Run: `npm test && npm run typecheck`
Expected: all green. The existing `autodeploy.test.ts` must stay green: its `WBB_INSTALLED_CHECK` stub means the new pair is never read.

- [ ] **Step 6: Commit**

```bash
git add deploy/db-snapshot.sh scripts/autodeploy/db-snapshot.test.ts deploy/install-autodeploy.sh deploy/autodeploy.sh scripts/autodeploy/install-invariant.test.ts
git commit -m "feat(deploy): db-snapshot helper — VACUUM INTO snapshots, restore, prune

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `trial-migrate.cjs` — the new build's migration on a copy

**Files:**
- Create: `deploy/trial-migrate.cjs`
- Create: `scripts/autodeploy/trial-migrate.test.ts`
- Modify: `deploy/install-autodeploy.sh`, `deploy/autodeploy.sh` (`TRIAL_BIN` + pair), `scripts/autodeploy/install-invariant.test.ts`

**Interfaces:**
- Consumes: the clone's `dist/storage/schema.js` exporting `migrate(db)` (true of the real build, see `src/storage/schema.ts:949`) and the clone's `node_modules/better-sqlite3`.
- Produces: `node trial-migrate.cjs <clone_dir> <db_copy>` → exit 0 with stdout `TRIAL OK: schema <before> -> <after>`; exit 1 with the first stdout line `TRIAL FAILED: <reason>`; exit 64 on usage. Task 4 calls it through `WBB_TRIAL_CMD`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/autodeploy/trial-migrate.test.ts`:

```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/**
 * Merge-deploy step 5: the NEW build's migrate() on a COPY of production,
 * twice, then foreign_key_check and integrity_check. The clone here is fake —
 * a dist/storage/schema.js written per test — but SQLite is real.
 */
const SCRIPT = resolve(__dirname, '../../deploy/trial-migrate.cjs');
const NODE_MODULES = resolve(__dirname, '../../node_modules');

function fakeClone(schemaJs: string | null): string {
  const clone = makeTempDirectory('wbb-trial-clone-');
  symlinkSync(NODE_MODULES, join(clone, 'node_modules'));
  if (schemaJs !== null) {
    mkdirSync(join(clone, 'dist', 'storage'), { recursive: true });
    writeFileSync(join(clone, 'dist', 'storage', 'schema.js'), schemaJs);
  }
  return clone;
}

/** A copy "of production": schema_version at 1, plus whatever `extra` adds. */
function dbAtV1(extra = ''): string {
  const p = join(makeTempDirectory('wbb-trial-db-'), 'trial.db');
  const db = new Database(p);
  db.exec('CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (1);');
  db.pragma('foreign_keys = OFF');
  if (extra) db.exec(extra);
  db.close();
  return p;
}

function trial(...args: string[]): { code: number | null; first: string } {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, first: r.stdout.split('\n')[0] };
}

const TO_V2 = `exports.migrate = (db) => {
  db.exec('CREATE TABLE IF NOT EXISTS t2(id INTEGER PRIMARY KEY)');
  db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (2)');
};`;

describe('trial-migrate.cjs', () => {
  it('reports the schema move of a sound, idempotent migration', () => {
    const r = trial(fakeClone(TO_V2), dbAtV1());
    expect(r.code).toBe(0);
    expect(r.first).toBe('TRIAL OK: schema 1 -> 2');
  });

  it('fails when migrate() throws', () => {
    const r = trial(fakeClone(`exports.migrate = () => { throw new Error('boom v2'); };`), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toBe('TRIAL FAILED: boom v2');
  });

  it('fails when a second migrate() moves the schema again', () => {
    const bumpEveryCall = `exports.migrate = (db) => {
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(v + 1);
    };`;
    const r = trial(fakeClone(bumpEveryCall), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toBe('TRIAL FAILED: a second migrate() moved the schema: 2 -> 3');
  });

  it('fails when the migrated database has a foreign-key violation', () => {
    const orphanChild = `CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      INSERT INTO child VALUES (1, 99);`;
    const r = trial(fakeClone(TO_V2), dbAtV1(orphanChild));
    expect(r.code).toBe(1);
    expect(r.first).toMatch(/^TRIAL FAILED: foreign_key_check: 1 violation\(s\), first /);
  });

  it('fails, not crashes, when the clone has no build', () => {
    const r = trial(fakeClone(null), dbAtV1());
    expect(r.code).toBe(1);
    expect(r.first).toMatch(/^TRIAL FAILED: Cannot find module /);
  });

  it('exits 64 without both arguments', () => {
    expect(trial('only-one').code).toBe(64);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run scripts/autodeploy/trial-migrate.test.ts`
Expected: FAIL. `node` exits 1 with `Cannot find module …/deploy/trial-migrate.cjs`, so the first lines and codes do not match.

- [ ] **Step 3: Implement `deploy/trial-migrate.cjs`**

```js
#!/usr/bin/env node
'use strict';
// Merge-deploy step 5 — the trial migration.
// Spec: docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md
//
// Runs the NEW build's migrate() against a COPY of production twice, then asks
// SQLite whether the result is sound. What it cannot see — a migration that
// rewrites data wrongly but validly — is why such a PR carries [deploy:hold].
// Installed as /usr/local/bin/wbb-trial-migrate (no extension; CommonJS is
// node's default there).
//
// Usage: trial-migrate <clone_dir> <db_copy>
// Exit:  0 TRIAL OK, 1 TRIAL FAILED (reason on the first stdout line), 64 usage.
const path = require('node:path');

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: trial-migrate <clone_dir> <db_copy>');
    return 64;
  }
  const [clone, dbPath] = argv;
  let db;
  try {
    // Both from the CLONE: the build under judgement, and the driver it ships
    // with. Inside the try, so a missing build is a TRIAL FAILED, not a crash.
    const Database = require(path.join(clone, 'node_modules', 'better-sqlite3'));
    const { migrate } = require(path.join(clone, 'dist', 'storage', 'schema.js'));
    db = new Database(dbPath);
    const version = () => db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    const before = version();
    migrate(db);
    const after = version();
    migrate(db);
    const again = version();
    if (again !== after) throw new Error(`a second migrate() moved the schema: ${after} -> ${again}`);
    const fk = db.pragma('foreign_key_check');
    if (fk.length > 0) {
      throw new Error(`foreign_key_check: ${fk.length} violation(s), first ${JSON.stringify(fk[0])}`);
    }
    const ic = db.pragma('integrity_check');
    if (ic.length !== 1 || ic[0].integrity_check !== 'ok') {
      throw new Error(`integrity_check: ${JSON.stringify(ic)}`);
    }
    console.log(`TRIAL OK: schema ${before} -> ${after}`);
    return 0;
  } catch (e) {
    console.log(`TRIAL FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    if (db) db.close();
  }
}

process.exitCode = main(process.argv.slice(2));
```

- [ ] **Step 4: Register the installed copy**

In `deploy/install-autodeploy.sh`, directly after the `wbb-db-snapshot` line:

```bash
install -m 0755 deploy/trial-migrate.cjs      /usr/local/bin/wbb-trial-migrate
```

Also add `/usr/local/bin/wbb-trial-migrate` to the `ls -l` line.

In `deploy/autodeploy.sh`, after the `SNAPSHOT_BIN=` line:

```bash
TRIAL_BIN="${WBB_TRIAL_BIN:-/usr/local/bin/wbb-trial-migrate}"
```

In the `installed_is_stale` pair list, after the `db-snapshot.sh` pair:

```bash
      "deploy/trial-migrate.cjs=$TRIAL_BIN" \
```

In `install-invariant.test.ts`, in the pinned test:

```ts
    expect(declared).toContain('deploy/trial-migrate.cjs');
```

- [ ] **Step 5: Run the new tests, then the full gate**

Run: `npx vitest run scripts/autodeploy/trial-migrate.test.ts`
Expected: PASS (6 tests).

Mutation check (then revert): comment out the second `migrate(db);`. The test `fails when a second migrate() moves the schema again` must FAIL.

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add deploy/trial-migrate.cjs scripts/autodeploy/trial-migrate.test.ts deploy/install-autodeploy.sh deploy/autodeploy.sh scripts/autodeploy/install-invariant.test.ts
git commit -m "feat(deploy): trial-migrate — the new build's migrate() twice on a copy

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: the tick — deploy `origin/main` when it is quiet, green and unheld

This task **rewrites** `deploy/autodeploy.sh` and `scripts/autodeploy/autodeploy.test.ts`. The tag path, the guard call and the drift episode go away. Task 4 adds the snapshot, the trial migration and the window; Task 5 adds the database rollback. At the end of this task, a failed deploy rolls back **code only**, as today.

**Files:**
- Rewrite: `deploy/autodeploy.sh`
- Rewrite: `scripts/autodeploy/autodeploy.test.ts`
- Modify: `scripts/autodeploy/install-invariant.test.ts` (the guard pair is gone)

**Interfaces:**
- Consumes: `SNAPSHOT_BIN`, `TRIAL_BIN` (Tasks 1–2, used by the seam defaults added in Tasks 4–5), `wbb-ships` (#527), `wbb-installed-current`.
- Produces, for Tasks 4–5: shell functions `now`, `notify`, `write_state`, `once_a_day <VAR> <msg>`, `refuse <sha> <msg>` (never returns, exit 1), `checkout_clean <sha>`, `wait_healthy <port> <limit_s>`, `settle <new> <old>` (never returns, exit 0), `deploy_pipeline <sha>` (Task 4 replaces it), `roll_back <sha> <reason> [pre] [pre_time]` (Task 5 replaces it); globals `PORT`, `RANGE_PRS`, `DEPLOYED_SHA`, `PREVIOUS_SHA`; seams listed in the script header. Test helpers `world`, `push`, `tick`, `ready`, `events`, `notes`, `advance`, `readState`, `seedState`, `stub`.

- [ ] **Step 1: Write the new test file (replacing the old one entirely)**

The old file tests the tag path, which no longer exists. The behaviours it pinned that survive — PAUSED, stale deployer, notify truncation, state-write failure, "cannot assess" — are re-tested below against the new flow.

Replace `scripts/autodeploy/autodeploy.test.ts` with:

```ts
import { makeTempDirectory } from '../test-temp';
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Merge-deploy (spec docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md).
 *
 * Every external contact of the tick is a WBB_* seam and is stubbed here, so
 * nothing touches sudo, systemd, /opt, GitHub or the network. Only git runs for
 * real, against a throwaway bare "origin" per test. The clock is a file: the
 * clock stub reads it and the sleep stub advances it, so 600 s of quiet or a
 * 10-minute window cost no wall time.
 */
const SCRIPT = resolve(__dirname, '../../deploy/autodeploy.sh');
const SHIPS = resolve(__dirname, '../../deploy/ships.sh');
const QUIET_S = 600;

const REAL_FILTER = [
  '+ /package.json',
  '+ /package-lock.json',
  '+ /tsconfig.json',
  '+ /src/***',
  '+ /scripts/***',
  '+ /deploy/***',
  '- *',
  '',
].join('\n');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commitIn(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, body] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** Writes an executable stub script; `body` is its shell body. */
function stub(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

interface World {
  home: string;
  dataDir: string;
  stateDir: string;
  repo: string;
  bin: string;
  seed: string;
  base: string;
  clock: string;
  eventsLog: string;
  notesLog: string;
}

/** A bare origin with one base commit, a clone of it, and production at base. */
function world(): World {
  const remote = makeTempDirectory('wbb-md-remote-');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = makeTempDirectory('wbb-md-seed-');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 'T');
  git(seed, 'remote', 'add', 'origin', remote);
  const base = commitIn(seed, {
    'package.json': '{"name":"x","version":"1.0.0"}',
    'deploy/rsync-filter': REAL_FILTER,
    'src/a.ts': 'export const a = 1;\n',
  }, 'base');
  git(seed, 'push', '-q', 'origin', 'main');

  const home = makeTempDirectory('wbb-md-home-');
  const dataDir = join(home, 'data');
  const stateDir = join(home, 'state');
  const repo = join(dataDir, 'wbb-autodeploy', 'repo');
  mkdirSync(join(dataDir, 'wbb-autodeploy'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  execFileSync('git', ['clone', '-q', remote, repo]);
  const bin = makeTempDirectory('wbb-md-bin-');
  const clock = join(bin, 'clock');
  writeFileSync(clock, '100000');
  const w: World = {
    home, dataDir, stateDir, repo, bin, seed, base, clock,
    eventsLog: join(bin, 'events.log'),
    notesLog: join(bin, 'notify.log'),
  };
  seedState(w, { DEPLOYED_SHA: base, PREVIOUS_SHA: '' });
  return w;
}

function push(w: World, files: Record<string, string>, message: string): string {
  const sha = commitIn(w.seed, files, message);
  git(w.seed, 'push', '-q', 'origin', 'main');
  return sha;
}

function seedState(w: World, kv: Record<string, string>): void {
  const dir = join(w.stateDir, 'wbb-autodeploy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.env'), Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

function readState(w: World): Record<string, string> {
  const p = join(w.stateDir, 'wbb-autodeploy', 'state.env');
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function advance(w: World, s: number): void {
  writeFileSync(w.clock, String(Number(readFileSync(w.clock, 'utf8')) + s));
}

/** Every recorded side effect, in order. */
function events(w: World): string[] {
  return existsSync(w.eventsLog) ? readFileSync(w.eventsLog, 'utf8').split('\n').filter((l) => l !== '') : [];
}

/** One entry per notify call, full text. */
function notes(w: World): string[] {
  return existsSync(w.notesLog)
    ? readFileSync(w.notesLog, 'utf8').split('\n<<END>>\n').filter((m) => m !== '')
    : [];
}

const short = (sha: string) => sha.slice(0, 7);

function stubs(w: World): Record<string, string> {
  const b = w.bin;
  const ev = w.eventsLog;
  const clk = w.clock;
  return {
    WBB_CLOCK_CMD: stub(b, 'clock-cmd', `cat "${clk}"`),
    WBB_SLEEP_CMD: stub(b, 'sleep-cmd', `echo $(( $(cat "${clk}") + $1 )) > "${clk}"`),
    WBB_NOTIFY_CMD: stub(b, 'notify', `printf '%s\\n<<END>>\\n' "$1" >> "${w.notesLog}"`),
    WBB_API_PORT_CMD: stub(b, 'port', 'echo 3000'),
    WBB_BUILD_CMD: stub(b, 'build', `echo "build $(git rev-parse HEAD)" >> "${ev}"`),
    WBB_AUDIT_CMD: stub(b, 'audit', `echo audit >> "${ev}"`),
    WBB_DEPLOY_CMD: stub(b, 'deploy', `echo "deploy $(git rev-parse HEAD)" >> "${ev}"; cat "${clk}" > "${b}/deployed_at"`),
    WBB_HEALTH_CMD: stub(b, 'health', 'exit 0'),
    WBB_RESTARTS_CMD: stub(b, 'restarts', 'echo 0'),
    WBB_CHECKS_CMD: stub(b, 'checks', `echo "checks $1" >> "${ev}"; printf 'ci\\tcompleted\\tsuccess\\n'`),
    WBB_PR_LABELS_CMD: stub(b, 'labels', `printf '7\\t\\n'`),
    WBB_SNAPSHOT_CMD: stub(b, 'snapshot', `echo "snapshot $(basename "$1")" >> "${ev}"; mkdir -p "$(dirname "$1")"; echo pre > "$1"`),
    WBB_TRIAL_CMD: stub(b, 'trial', `[ -f "$1" ] && echo "trial $(cat "$1")" >> "${ev}"`),
    WBB_PRUNE_CMD: stub(b, 'prune', `echo prune >> "${ev}"`),
    WBB_SERVICE_CMD: stub(b, 'service', `echo "service $1 $2" >> "${ev}"`),
    WBB_MARK_CMD: stub(b, 'mark', `echo "mark $(basename "$1")" >> "${ev}"; echo "\${1%-pre.db}-rollback-pre.db"`),
    WBB_POST_CMD: stub(b, 'post', `echo "post $(basename "$1")" >> "${ev}"`),
    WBB_RESTORE_CMD: stub(b, 'restore', `echo "restore $(basename "$1")" >> "${ev}"`),
    WBB_SNAPSHOT_DIR: join(w.home, 'snapshots'),
    WBB_INSTALLED_CHECK: stub(b, 'installed', 'echo "CURRENT: stub"; exit 0'),
    WBB_SHIPS: SHIPS,
  };
}

function tick(w: World, over: Record<string, string> = {}): { code: number; out: string } {
  const env = {
    ...process.env,
    HOME: w.home,
    XDG_DATA_HOME: w.dataDir,
    XDG_STATE_HOME: w.stateDir,
    ...stubs(w),
    ...over,
  };
  try {
    return { code: 0, out: execFileSync('bash', [SCRIPT], { encoding: 'utf8', env }) };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

/** The tick that first sees the head, then QUIET_S of quiet: the next tick decides. */
function ready(w: World, over: Record<string, string> = {}): void {
  tick(w, over);
  advance(w, QUIET_S);
}

describe('merge-deploy: what gets deployed, and when', () => {
  it('deploys the head of main once it has been quiet for ten minutes and CI passed on it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': 'export const a = 2;\n' }, 'feat');

    const first = tick(w);
    expect(first.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(readState(w).MAIN_SEEN_SHA).toBe(x);
    expect(readState(w).MAIN_SEEN_S).toBe('100000');

    advance(w, QUIET_S);
    const second = tick(w);

    expect(second.code).toBe(0);
    expect(events(w)).toEqual([`checks ${x}`, `build ${x}`, 'audit', `deploy ${x}`]);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
    expect(readState(w).PREVIOUS_SHA).toBe(w.base);
    expect(notes(w)).toEqual([`✅ merge-deploy ${short(x)} is live and settled — #7.`]);
  });

  it('does not deploy 599 s after main moved, and does at 600 s', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    tick(w);
    advance(w, 599);
    tick(w);
    expect(events(w)).toEqual([]);

    advance(w, 1);
    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('restarts the quiet period when main moves again, and deploys only the newest head', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'one');
    tick(w);
    advance(w, 300);
    const x2 = push(w, { 'src/a.ts': '3' }, 'two');
    tick(w);
    expect(readState(w).MAIN_SEEN_SHA).toBe(x2);
    expect(readState(w).MAIN_SEEN_S).toBe('100300');
    advance(w, 300);
    tick(w);
    expect(events(w)).toEqual([]);

    advance(w, 300);
    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x2}`]);
  });

  it('does nothing, silently, when production is main', () => {
    const w = world();
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });

  it('does not deploy a merge that ships nothing, and says nothing about it', () => {
    const w = world();
    push(w, { 'docs/x.md': 'hello' }, 'docs');
    ready(w);
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });

  it('skips main quietly when it is recorded as LAST_FAILED_SHA', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', LAST_FAILED_SHA: x });
    ready(w);
    tick(w);
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });
});

describe('merge-deploy: CI on the exact commit', () => {
  it('waits, silently, while ci is still running', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const checks = stub(w.bin, 'checks-pending', `printf 'ci\\tin_progress\\t\\n'`);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual([]);
    expect(notes(w)).toEqual([]);
  });

  it('waits while the required ci check has not appeared, even if others passed', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const checks = stub(w.bin, 'checks-no-ci', `printf 'build (root)\\tcompleted\\tsuccess\\n'`);
    ready(w, { WBB_CHECKS_CMD: checks });
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(events(w)).toEqual([]);
  });

  it('reports CI that has not concluded after an hour, once a day', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const checks = stub(w.bin, 'checks-pending', `printf 'ci\\tqueued\\t\\n'`);
    tick(w, { WBB_CHECKS_CMD: checks });
    advance(w, 3599);
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w)).toEqual([]);

    advance(w, 1);
    tick(w, { WBB_CHECKS_CMD: checks });
    advance(w, 300);
    tick(w, { WBB_CHECKS_CMD: checks });
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy: CI has not concluded on [0-9a-f]{7} after 60 min/);
  });

  it('reports a failed check once, does not record LAST_FAILED_SHA, and a green re-run releases it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const red = stub(w.bin, 'checks-red', `printf 'ci\\tcompleted\\tfailure\\nbuild (root)\\tcompleted\\tsuccess\\n'`);
    ready(w, { WBB_CHECKS_CMD: red });
    tick(w, { WBB_CHECKS_CMD: red });
    tick(w, { WBB_CHECKS_CMD: red });

    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(new RegExp(`^⛔ merge-deploy: CI failed on ${short(x)} — not deploying\\. ci=failure`));
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(readState(w).LAST_CI_NOTICE_SHA).toBe(x);
    expect(events(w)).toEqual([]);

    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('does not let skipped or neutral checks block', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const mixed = stub(w.bin, 'checks-mixed',
      `printf 'ci\\tcompleted\\tsuccess\\nclaude\\tcompleted\\tskipped\\nnote\\tcompleted\\tneutral\\n'`);
    ready(w, { WBB_CHECKS_CMD: mixed });
    tick(w, { WBB_CHECKS_CMD: mixed });
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('treats a cancelled check as a failure', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const cancelled = stub(w.bin, 'checks-cancelled', `printf 'ci\\tcompleted\\tsuccess\\nbuild (root)\\tcompleted\\tcancelled\\n'`);
    ready(w, { WBB_CHECKS_CMD: cancelled });
    tick(w, { WBB_CHECKS_CMD: cancelled });
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toMatch(/CI failed on .* build \(root\)=cancelled/);
  });

  it('waits and says so once a day when CI status cannot be read', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const broken = stub(w.bin, 'checks-broken', 'exit 1');
    ready(w, { WBB_CHECKS_CMD: broken });
    tick(w, { WBB_CHECKS_CMD: broken });
    tick(w, { WBB_CHECKS_CMD: broken });
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy cannot read CI status for [0-9a-f]{7}/);
  });
});

describe('merge-deploy: holds', () => {
  it.each([
    ['deploy/sudoers.d/warsaw-beer-bot', true],
    ['deploy/litestream.yml', true],
    ['deploy/litestream.service', true],
    ['deploy/wbb-autodeploy.timer', true],
    ['deploy/wbb-autodeploy.service', true],
    ['deploy/install-autodeploy.sh', true],
    ['deploy/autodeploy.sh', true],
    ['deploy/ships.sh', true],
    ['deploy/read-env.sh', true],
    ['deploy/installed-current.sh', true],
    ['deploy/db-snapshot.sh', true],
    ['deploy/trial-migrate.cjs', true],
    ['deploy/warsaw-beer-bot.service', false],
    ['deploy/deploy.sh', false],
    ['src/x.ts', false],
  ])('a change to %s holds the deploy: %s', (path, held) => {
    const w = world();
    push(w, { [path]: 'changed\n' }, 'change');
    ready(w);
    tick(w);
    const deployed = events(w).some((e) => e.startsWith('deploy '));
    expect(deployed).toBe(!held);
  });

  it('names the held path, and says so once a day', () => {
    const w = world();
    push(w, { 'deploy/sudoers.d/warsaw-beer-bot': 'x' }, 'sudoers');
    ready(w);
    tick(w);
    tick(w);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⏸ merge-deploy: production is behind main and HELD:\n• path deploy\/sudoers\.d\/warsaw-beer-bot needs a human step/);
  });

  it('holds on a PR labelled exactly deploy:hold', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const labels = stub(w.bin, 'labels-hold', `printf '8\\tbug,deploy:hold\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toContain('• PR #8 carries deploy:hold — https://github.com/ysilvestrov/warsaw-beer-bot/pull/8');
  });

  it('does not hold on a label that merely contains deploy:hold', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const labels = stub(w.bin, 'labels-near', `printf '8\\tdeploy:hold-later,x-deploy:hold\\n'`);
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('holds when PR labels cannot be read — fail closed', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const labels = stub(w.bin, 'labels-broken', 'exit 1');
    ready(w, { WBB_PR_LABELS_CMD: labels });
    tick(w, { WBB_PR_LABELS_CMD: labels });
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toMatch(/• could not read PR labels for [0-9a-f]{7}/);
  });

  it('a manual deploy past the held commit releases the hold', () => {
    const w = world();
    const held = push(w, { 'deploy/sudoers.d/warsaw-beer-bot': 'x' }, 'sudoers');
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    // What deploy.sh → record-deployed.sh writes after the human's manual deploy.
    seedState(w, { DEPLOYED_SHA: held, PREVIOUS_SHA: w.base });
    ready(w);
    tick(w);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });
});

describe('merge-deploy: refusals', () => {
  it('refuses a commit whose build fails, records LAST_FAILED_SHA, and never deploys it', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const build = stub(w.bin, 'build-red', 'echo "tsc: error TS2322"; exit 2');
    ready(w, { WBB_BUILD_CMD: build });
    const r = tick(w, { WBB_BUILD_CMD: build });
    tick(w, { WBB_BUILD_CMD: build });

    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toBe(`⛔ merge-deploy refused ${short(x)}: the build failed.\ntsc: error TS2322`);
  });

  it('refuses a commit whose audit finds a high advisory', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = stub(w.bin, 'audit-red', 'echo "1 high"; exit 1');
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)[0]).toMatch(/^⛔ merge-deploy refused [0-9a-f]{7}: npm audit --omit=dev reports a high or critical advisory\./);
  });

  it('does NOT blame the commit when the audit cannot run', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const audit = stub(w.bin, 'audit-broken', 'echo "ENOTFOUND registry"; exit 2');
    ready(w, { WBB_AUDIT_CMD: audit });
    const r = tick(w, { WBB_AUDIT_CMD: audit });
    expect(r.code).toBe(1);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(notes(w)[0]).toMatch(/npm audit could not run \(exit 2\)/);
  });

  it('refuses when production is not an ancestor of main', () => {
    const w = world();
    git(w.seed, 'checkout', '-q', '-b', 'side');
    const side = commitIn(w.seed, { 'src/side.ts': 's' }, 'side');
    git(w.seed, 'push', '-q', 'origin', 'side');
    git(w.seed, 'checkout', '-q', 'main');
    push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: side, PREVIOUS_SHA: '' });
    ready(w);
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(events(w)).toEqual([]);
    expect(notes(w)[0]).toMatch(/is not an ancestor of main/);
  });

  it('asks for a first manual deploy when there is no baseline, once a day', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: '', PREVIOUS_SHA: '' });
    tick(w);
    tick(w);
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/no recorded baseline/);
  });

  it('waits for a stale installed deployer to be reinstalled, saying so once a day', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const stale = stub(w.bin, 'installed-stale', 'echo "STALE: 1 installed file(s) differ"; exit 1');
    ready(w, { WBB_INSTALLED_CHECK: stale });
    tick(w, { WBB_INSTALLED_CHECK: stale });
    tick(w, { WBB_INSTALLED_CHECK: stale });
    expect(events(w)).toEqual([]);
    expect(notes(w).length).toBe(1);
    expect(notes(w)[0]).toMatch(/^⚠️ merge-deploy is waiting: the installed deployer is out of date/);
  });

  it('does nothing at all while PAUSED', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    writeFileSync(join(w.stateDir, 'wbb-autodeploy', 'PAUSED'), '');
    const r = tick(w);
    expect(r.code).toBe(0);
    expect(readState(w).MAIN_SEEN_SHA).toBe(undefined);
    expect(events(w)).toEqual([]);
  });
});

describe('merge-deploy: state and notifications', () => {
  it('drops the obsolete drift keys on the first write', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    seedState(w, { DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', DRIFT_SINCE: '5', LAST_DRIFT_NOTICE: '2026-08-20' });
    tick(w);
    expect(readState(w)).toEqual({ DEPLOYED_SHA: w.base, PREVIOUS_SHA: '', MAIN_SEEN_SHA: x, MAIN_SEEN_S: '100000' });
  });

  it('truncates a message longer than Telegram accepts', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const build = stub(w.bin, 'build-long', `printf 'E%.0s' $(seq 1 5000); echo; exit 2`);
    ready(w, { WBB_BUILD_CMD: build });
    tick(w, { WBB_BUILD_CMD: build });
    expect(notes(w)[0].length).toBe(3500 + '\n… truncated'.length);
    expect(notes(w)[0].endsWith('\n… truncated')).toBe(true);
  });

  it('exits 4 and says so when the state file cannot be written', () => {
    const w = world();
    tick(w); // creates the lock file while the directory is still writable
    push(w, { 'src/a.ts': '2' }, 'feat');
    const dir = join(w.stateDir, 'wbb-autodeploy');
    chmodSync(dir, 0o500);
    try {
      const r = tick(w);
      expect(r.code).toBe(4);
      expect(notes(w)[0]).toMatch(/^🔥 merge-deploy: failed to write /);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('merge-deploy: a deploy that does not come up (code-only rollback until Task 5)', () => {
  it('redeploys the previous commit, records LAST_FAILED_SHA and exits 2', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = stub(w.bin, 'health-x-bad', `tail -n1 "${w.eventsLog}" | grep -q "deploy ${x}" && exit 1; exit 0`);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(2);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`, `deploy ${w.base}`]);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(readState(w).DEPLOYED_SHA).toBe(w.base);
  });
});
```

The chmod test runs its assertions inside `try/finally` so the temp directory stays removable. That is cleanup, not branching logic: there is one path through it.

Then in `scripts/autodeploy/install-invariant.test.ts`, delete the line `expect(declared).toContain('deploy/autodeploy-guard.sh');` and rename the test to `names every installed script the tick depends on`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: FAIL. The old script is tag-based: it never records `MAIN_SEEN_SHA`, calls a guard that is unstubbed here, and ignores `WBB_CHECKS_CMD`.

- [ ] **Step 3: Rewrite `deploy/autodeploy.sh`**

Replace the whole file with the text below. The one exception is `shipping_paths()` together with its comment header: in the current file it is the block from the line `# #527 — the paths of diff(DEPLOYED_SHA, $1) that actually reach production,` down to the closing `}` of `shipping_paths()`, just before `report_drift_once() {`. Copy that block **verbatim** where the marker below says so. It reads `REPO`, `DEPLOYED_SHA` and `SHIPS_BIN`, all of which keep their names.

```bash
#!/usr/bin/env bash
# Merge-deploy — the host deploys the head of origin/main by itself.
# Spec: docs/superpowers/specs/2026-09/2026-09-30-merge-deploy-design.md
#
# The rule: production runs what was merged into main (by a human, or by the
# Dependabot qualifier's auto-merge), after CI passed on THAT commit, unless a
# hold says a human must be present. A merge is the permission; everything
# else is re-derived here before production is touched.
#
# Runs as the operator user (ysi) from wbb-autodeploy.timer and reuses the
# existing NOPASSWD sudoers scope. It NEVER touches the operator's working
# tree: deploy.sh rsyncs `./`, so it runs from a private clone.
#
# Exit: 0 idle/waiting/settled, 1 refused, 2 rolled back, 3 rollback failed,
#       4 state write failed.
set -euo pipefail
# notify() cuts messages by CHARACTERS. Under systemd's default C locale bash
# counts bytes and can cut a UTF-8 character in half, which Telegram rejects.
export LC_ALL=C.UTF-8

REPO_URL=https://github.com/ysilvestrov/warsaw-beer-bot.git
GH_REPO=ysilvestrov/warsaw-beer-bot
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/wbb-autodeploy"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wbb-autodeploy"
REPO="$DATA_DIR/repo"
STATE="$STATE_DIR/state.env"
LOCK="$STATE_DIR/lock"
NOTIFY_LIMIT=3500
QUIET_S=600
CI_STUCK_S=3600
STARTUP_S=60

SHIPS_BIN="${WBB_SHIPS:-/usr/local/bin/wbb-ships}"
READ_ENV_BIN="${WBB_READ_ENV:-/usr/local/bin/wbb-read-env}"
INSTALLED_CHECK_BIN="${WBB_INSTALLED_CHECK:-/usr/local/bin/wbb-installed-current}"
# Merge-deploy — the snapshot helper, installed like the guard and the predicate.
SNAPSHOT_BIN="${WBB_SNAPSHOT_BIN:-/usr/local/bin/wbb-db-snapshot}"
TRIAL_BIN="${WBB_TRIAL_BIN:-/usr/local/bin/wbb-trial-migrate}"

# --- seams --------------------------------------------------------------------
# I2 (#435), kept: every contact with the outside world is ONE swappable
# command that defaults to the real thing, so a test substitutes all of them
# and never touches sudo, systemd, /opt, GitHub or the network.
_clock_default() { date +%s; }
CLOCK_CMD="${WBB_CLOCK_CMD:-_clock_default}"
_sleep_default() { sleep "$1"; }
SLEEP_CMD="${WBB_SLEEP_CMD:-_sleep_default}"

# ONE probe, no loop: wait_healthy and the watch window own the timing.
_health_default() {
  local body
  body=$(curl -fsS --max-time 3 "http://127.0.0.1:${1}/health" 2>/dev/null) || return 1
  case "$body" in *'"ok":true'*) return 0 ;; esac
  return 1
}
HEALTH_CMD="${WBB_HEALTH_CMD:-_health_default}"
_restarts_default() { systemctl show -p NRestarts --value warsaw-beer-bot; }
RESTARTS_CMD="${WBB_RESTARTS_CMD:-_restarts_default}"

_deploy_default() { ./deploy/deploy.sh; }
DEPLOY_CMD="${WBB_DEPLOY_CMD:-_deploy_default}"
_build_default() { npm ci --no-audit --no-fund && npm run build; }
BUILD_CMD="${WBB_BUILD_CMD:-_build_default}"
# npm audit's exit 1 = advisories at/above the level; any other non-zero = it
# could not run (I3). Callers keep the two apart.
_audit_default() { npm audit --omit=dev --audit-level=high; }
AUDIT_CMD="${WBB_AUDIT_CMD:-_audit_default}"

# GitHub, read as the operator's `gh` (P3: works under the unit's environment).
# One line per check run: name<TAB>status<TAB>conclusion.
_checks_default() {
  gh api "repos/${GH_REPO}/commits/$1/check-runs" --paginate \
    --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'
}
CHECKS_CMD="${WBB_CHECKS_CMD:-_checks_default}"
# One line per PR that contains the commit: number<TAB>label,label,...
_pr_labels_default() {
  gh api "repos/${GH_REPO}/commits/$1/pulls" \
    --jq '.[] | "\(.number)\t\(.labels | map(.name) | join(","))"'
}
PR_LABELS_CMD="${WBB_PR_LABELS_CMD:-_pr_labels_default}"

_read_env_default() {
  sudo -u warsaw-beer-bot bash -lc '"$0" /etc/warsaw-beer-bot/.env "$1"' "$READ_ENV_BIN" "$1"
}
READ_ENV_CMD="${WBB_READ_ENV_CMD:-_read_env_default}"
_notify_default() {
  # Deliberately NOT via the bot: if the deploy took the bot down, the bot
  # cannot report that it is down.
  local tok chat
  tok=$("$READ_ENV_CMD" TELEGRAM_BOT_TOKEN)
  chat=$("$READ_ENV_CMD" ADMIN_TELEGRAM_ID)
  if [ -z "$tok" ] || [ -z "$chat" ]; then
    echo "WARNING: notifier has no token or chat id; cannot report: $1" >&2
    return 1
  fi
  curl -fsS -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=$1" >/dev/null
}
NOTIFY_CMD="${WBB_NOTIFY_CMD:-_notify_default}"
_api_port_default() {
  local p
  p=$("$READ_ENV_CMD" API_PORT)
  echo "${p:-3000}"
}
API_PORT_CMD="${WBB_API_PORT_CMD:-_api_port_default}"

now() { "$CLOCK_CMD"; }

# --- brake, lock --------------------------------------------------------------
# Unprivileged emergency stop (#435 §7): arming the timer costs a password, so
# stopping it must not. Checked before anything else; a paused tick writes
# nothing and says nothing.
if [ -f "$STATE_DIR/PAUSED" ]; then
  echo "wbb-autodeploy: paused ($STATE_DIR/PAUSED exists); exiting quietly"
  exit 0
fi
mkdir -p "$DATA_DIR" "$STATE_DIR"
# Excludes overlapping ticks — a tick can now last the whole 10-min window.
# It does NOT exclude a manual deploy.sh; a manual deploy means a human is
# present, which is the case this mechanism defers to.
exec 9>"$LOCK"
flock -n 9 || { echo "another tick holds the lock; exiting"; exit 0; }

# --- state ----------------------------------------------------------------------
DEPLOYED_SHA=""
PREVIOUS_SHA=""
LAST_FAILED_SHA=""
MAIN_SEEN_SHA=""
MAIN_SEEN_S=""
LAST_CI_NOTICE_SHA=""
LAST_HOLD_NOTICE=""
LAST_STALE_NOTICE=""
LAST_ASSESS_NOTICE=""
# shellcheck disable=SC1090
if [ -f "$STATE" ]; then . "$STATE"; fi

# I6: Telegram caps sendMessage at 4096 chars, and a notify failure must never
# abort the run unnoticed.
notify() {
  local msg="$1"
  if [ "${#msg}" -gt "$NOTIFY_LIMIT" ]; then
    msg="${msg:0:$NOTIFY_LIMIT}"$'\n… truncated'
  fi
  "$NOTIFY_CMD" "$msg" || echo "WARNING: notify failed: $msg"
}

# #497, kept: every key is carried from a shell variable, so a caller changes
# one by ASSIGNING it, never by passing it. Keys not listed here — the old
# DRIFT_SINCE / LAST_DRIFT_NOTICE — are dropped by the first write.
STATE_KEYS=(LAST_FAILED_SHA MAIN_SEEN_SHA MAIN_SEEN_S LAST_CI_NOTICE_SHA LAST_HOLD_NOTICE LAST_STALE_NOTICE LAST_ASSESS_NOTICE)
write_state() {
  local k
  if ! {
    printf 'DEPLOYED_SHA=%s\nPREVIOUS_SHA=%s\n' "$DEPLOYED_SHA" "$PREVIOUS_SHA"
    for k in "${STATE_KEYS[@]}"; do
      if [ -n "${!k}" ]; then printf '%s=%s\n' "$k" "${!k}"; fi
    done
  } > "$STATE.tmp" 2>/dev/null || ! mv "$STATE.tmp" "$STATE" 2>/dev/null; then
    notify "🔥 merge-deploy: failed to write $STATE — its record of what is deployed may now disagree with production."
    exit 4
  fi
}

# A standing condition is reported at most once per UTC day, per marker.
once_a_day() {
  local var="$1" msg="$2" today
  today=$(date -u +%Y-%m-%d)
  [ "${!var}" != "$today" ] || return 0
  notify "$msg"
  printf -v "$var" '%s' "$today"
  write_state
}

# A gate the COMMIT failed. Recorded, so the same head is never retried; the
# next merge is.
refuse() {
  notify "⛔ merge-deploy refused ${1:0:7}: $2"
  LAST_FAILED_SHA="$1"
  write_state
  exit 1
}

# --- installed copies -------------------------------------------------------------
# /usr/local/bin holds COPIES on purpose; a merged fix is not live until
# installed. The honest limit: this check lives in the file it checks.
installed_is_stale() {
  [ -n "$INSTALLED_CHECK_BIN" ] || return 1
  [ -x "$INSTALLED_CHECK_BIN" ] || return 1
  ! STALE_REPORT=$("$INSTALLED_CHECK_BIN" "$REPO" origin/main \
      "deploy/autodeploy.sh=$0" \
      "deploy/read-env.sh=$READ_ENV_BIN" \
      "deploy/ships.sh=$SHIPS_BIN" \
      "deploy/db-snapshot.sh=$SNAPSHOT_BIN" \
      "deploy/trial-migrate.cjs=$TRIAL_BIN" \
      "deploy/installed-current.sh=$INSTALLED_CHECK_BIN" 2>&1)
}

report_stale_once() {
  installed_is_stale || return 0
  once_a_day LAST_STALE_NOTICE "⚠️ merge-deploy: the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
Run: sudo bash deploy/install-autodeploy.sh"
}

# ===== COPY VERBATIM FROM THE CURRENT FILE: the "# #527 — the paths of diff" =====
# ===== comment block and the whole shipping_paths() function.                   =====

# --- holds ------------------------------------------------------------------------
# Paths whose change needs a human on the host: root-installed files, units
# other than the bot's own (deploy.sh installs that one), and every installed
# copy of this deployer. Changing this list is itself a hold (it lives here).
path_is_held() {
  case "$1" in
    deploy/warsaw-beer-bot.service) return 1 ;;
    deploy/sudoers.d/*|deploy/*.service|deploy/*.timer|deploy/litestream.*|deploy/install-*.sh) return 0 ;;
    deploy/autodeploy.sh|deploy/autodeploy-guard.sh|deploy/ships.sh|deploy/read-env.sh) return 0 ;;
    deploy/installed-current.sh|deploy/db-snapshot.sh|deploy/trial-migrate.cjs) return 0 ;;
    *) return 1 ;;
  esac
}

add_unique() {
  local -n _arr="$1"
  local v="$2" e
  for e in "${_arr[@]}"; do
    if [ "$e" = "$v" ]; then return 0; fi
  done
  _arr+=("$v")
}

# Fills HOLDS (reasons) and RANGE_PRS (#n of every PR in DEPLOYED_SHA..$1).
# A failure to look is a hold, never a pass (fail closed).
scan_range() {
  local x="$1" paths commits c out pr labels f
  HOLDS=()
  RANGE_PRS=()
  if ! paths=$(git -C "$REPO" -c core.quotePath=false diff --name-only "$DEPLOYED_SHA" "$x"); then
    HOLDS+=("could not list the changed paths")
  fi
  while IFS= read -r f; do
    if [ -n "$f" ] && path_is_held "$f"; then HOLDS+=("path $f needs a human step"); fi
  done <<< "$paths"
  if ! commits=$(git -C "$REPO" rev-list "${DEPLOYED_SHA}..${x}"); then
    HOLDS+=("could not list the commits")
    return 0
  fi
  while IFS= read -r c; do
    if [ -z "$c" ]; then continue; fi
    if ! out=$("$PR_LABELS_CMD" "$c" 2>/dev/null); then
      add_unique HOLDS "could not read PR labels for ${c:0:7}"
      continue
    fi
    while IFS=$'\t' read -r pr labels; do
      if [ -z "$pr" ]; then continue; fi
      add_unique RANGE_PRS "#$pr"
      case ",$labels," in
        *,deploy:hold,*) add_unique HOLDS "PR #$pr carries deploy:hold — https://github.com/${GH_REPO}/pull/$pr" ;;
      esac
    done <<< "$out"
  done <<< "$commits"
}

# --- CI ---------------------------------------------------------------------------
# PASS | WAIT | FAIL <name=conclusion ...>. Non-zero = could not read.
# The required `ci` must be present AND successful; its absence is WAIT.
ci_verdict() {
  local out name status conclusion ci_ok=0 pending=0 failed=()
  out=$("$CHECKS_CMD" "$1") || return 1
  while IFS=$'\t' read -r name status conclusion; do
    if [ -z "$name" ]; then continue; fi
    if [ "$status" != completed ]; then pending=1; continue; fi
    case "$conclusion" in
      success|skipped|neutral) ;;
      *) failed+=("${name}=${conclusion}") ;;
    esac
    if [ "$name" = ci ] && [ "$conclusion" = success ]; then ci_ok=1; fi
  done <<< "$out"
  if [ "${#failed[@]}" -gt 0 ]; then echo "FAIL ${failed[*]}"; return 0; fi
  if [ "$pending" = 1 ] || [ "$ci_ok" = 0 ]; then echo WAIT; return 0; fi
  echo PASS
}

# --- deploy primitives ----------------------------------------------------------------
# C2 (#435), kept: check explicitly — inside an `if`, set -e is off.
# I5, kept: `clean -xdff` because rsync ships the TREE, not the diff.
checkout_clean() {
  git -C "$REPO" checkout -q --detach "$1" || return 1
  git -C "$REPO" clean -xdffq || return 1
}

wait_healthy() {
  local port="$1" limit="$2" start
  start=$(now)
  while :; do
    if "$HEALTH_CMD" "$port"; then return 0; fi
    if [ $(( $(now) - start )) -ge "$limit" ]; then return 1; fi
    "$SLEEP_CMD" 2
  done
}

settle() {
  local prs="${RANGE_PRS[*]}"
  PREVIOUS_SHA="$2"
  DEPLOYED_SHA="$1"
  write_state
  notify "✅ merge-deploy ${1:0:7} is live and settled${prs:+ — $prs}."
  exit 0
}

# Code-only until Task 5.
roll_back() {
  LAST_FAILED_SHA="$1"
  write_state
  notify "⚠️ merge-deploy ${1:0:7} failed: $2 — rolling back to ${DEPLOYED_SHA:0:7}."
  if checkout_clean "$DEPLOYED_SHA" && ( cd "$REPO" && "$DEPLOY_CMD" ) && wait_healthy "$PORT" "$STARTUP_S"; then
    notify "↩️ rollback to ${DEPLOYED_SHA:0:7} succeeded. ${1:0:7} needs a human."
    exit 2
  fi
  notify "🔥 ROLLBACK FAILED. Production is DOWN at ${DEPLOYED_SHA:0:7}. Manual intervention required."
  exit 3
}

deploy_pipeline() {
  local x="$1" old="$DEPLOYED_SHA" out status
  if ! checkout_clean "$x"; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not check out ${x:0:7}."
    exit 1
  fi
  if ! out=$(cd "$REPO" && "$BUILD_CMD" 2>&1); then
    refuse "$x" "the build failed.
$(tail -n 20 <<< "$out")"
  fi
  out=$(cd "$REPO" && "$AUDIT_CMD" 2>&1) && status=0 || status=$?
  if [ "$status" -eq 1 ]; then
    refuse "$x" "npm audit --omit=dev reports a high or critical advisory.
$out"
  elif [ "$status" -ne 0 ]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: npm audit could not run (exit ${status}) for ${x:0:7} — NOT a finding, just no verification. Retrying next tick.
$out"
    exit 1
  fi
  echo "deploying $x"
  if ( cd "$REPO" && "$DEPLOY_CMD" ) && wait_healthy "$PORT" "$STARTUP_S"; then
    settle "$x" "$old"
  fi
  roll_back "$x" "not healthy within ${STARTUP_S}s"
}

# --- the tick ---------------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  git clone -q "$REPO_URL" "$REPO" || {
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: git clone of $REPO_URL failed."
    exit 1
  }
fi
if ! git -C "$REPO" fetch -q --prune origin; then
  once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: git fetch failed."
  exit 1
fi

X=$(git -C "$REPO" rev-parse origin/main)
NOW=$(now)

if [ -z "$DEPLOYED_SHA" ]; then
  once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: no recorded baseline. Deploy once by hand (bash deploy/deploy.sh), then this becomes automatic."
  exit 0
fi
if [ "$X" = "$DEPLOYED_SHA" ]; then
  report_stale_once
  echo "up to date at $X"
  exit 0
fi
# The downgrade check that used to live in the guard.
if ! git -C "$REPO" rev-parse -q --verify "${DEPLOYED_SHA}^{commit}" >/dev/null \
   || ! git -C "$REPO" merge-base --is-ancestor "$DEPLOYED_SHA" "$X"; then
  once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: production (${DEPLOYED_SHA:0:7}) is not an ancestor of main (${X:0:7}) — refusing what could be a downgrade. Deploy main by hand to reseed."
  exit 0
fi
# #527, kept: "could not tell" is its own state, never "nothing ships".
if ! shipping=$(shipping_paths "$X"); then
  once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy cannot tell whether production is behind main: classifying diff(${DEPLOYED_SHA:0:7}, ${X:0:7}) against deploy/rsync-filter failed. Treat deploys as blocked until this is understood."
  exit 0
fi
if [ -z "$shipping" ]; then
  report_stale_once
  echo "nothing that ships differs between $DEPLOYED_SHA and $X"
  exit 0
fi
if [ "$X" = "$LAST_FAILED_SHA" ]; then
  report_stale_once
  echo "main $X is recorded as LAST_FAILED_SHA; waiting for the next merge"
  exit 0
fi
# D1: ten minutes of quiet, measured from the first tick that saw this head.
if [ "$MAIN_SEEN_SHA" != "$X" ]; then
  MAIN_SEEN_SHA="$X"
  MAIN_SEEN_S="$NOW"
  write_state
  echo "new main head $X; waiting ${QUIET_S}s of quiet"
  exit 0
fi
if [ $(( NOW - MAIN_SEEN_S )) -lt "$QUIET_S" ]; then
  echo "main moved $(( NOW - MAIN_SEEN_S ))s ago; waiting"
  exit 0
fi
if installed_is_stale; then
  echo "$STALE_REPORT"
  once_a_day LAST_STALE_NOTICE "⚠️ merge-deploy is waiting: the installed deployer is out of date — a merged fix is not live until it is installed.
${STALE_REPORT}
Run: sudo bash deploy/install-autodeploy.sh"
  exit 0
fi
scan_range "$X"
if [ "${#HOLDS[@]}" -gt 0 ]; then
  printf '%s\n' "${HOLDS[@]}"
  once_a_day LAST_HOLD_NOTICE "⏸ merge-deploy: production is behind main and HELD:
$(printf '• %s\n' "${HOLDS[@]}")
Do the steps, then run bash deploy/deploy.sh on the host — that releases the hold."
  exit 0
fi
if ! verdict=$(ci_verdict "$X"); then
  once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy cannot read CI status for ${X:0:7} (gh api failed). Waiting."
  exit 0
fi
case "$verdict" in
  PASS) ;;
  WAIT)
    if [ $(( NOW - MAIN_SEEN_S )) -ge "$CI_STUCK_S" ]; then
      once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: CI has not concluded on ${X:0:7} after $(( (NOW - MAIN_SEEN_S) / 60 )) min (the required 'ci' check is pending or absent)."
    fi
    echo "CI not concluded on $X"
    exit 0
    ;;
  FAIL*)
    if [ "$LAST_CI_NOTICE_SHA" != "$X" ]; then
      notify "⛔ merge-deploy: CI failed on ${X:0:7} — not deploying. ${verdict#FAIL }
Re-running the failed job releases it; nothing else to do here."
      LAST_CI_NOTICE_SHA="$X"
      write_state
    fi
    exit 0
    ;;
esac
if ! PORT=$("$API_PORT_CMD"); then
  once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not resolve API_PORT — not deploying ${X:0:7}."
  exit 1
fi

deploy_pipeline "$X"
```

Then paste the verbatim `shipping_paths` block at the marker.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts scripts/autodeploy/install-invariant.test.ts`
Expected: PASS.

Mutation checks (each must turn at least one named test red; revert after each):
1. In `ci_verdict`, change `if [ "$pending" = 1 ] || [ "$ci_ok" = 0 ]` to `if [ "$pending" = 1 ]` → `waits while the required ci check has not appeared` fails.
2. In `path_is_held`, delete the `deploy/warsaw-beer-bot.service) return 1 ;;` line → the `deploy/warsaw-beer-bot.service` row fails.
3. In `scan_range`, change `*,deploy:hold,*)` to `*deploy:hold*)` → `does not hold on a label that merely contains deploy:hold` fails.
4. Change `-lt "$QUIET_S"` to `-le "$QUIET_S"` → `does not deploy 599 s after main moved, and does at 600 s` fails.

Run: `npm test && npm run typecheck`
Expected: all green. `guard.test.ts` still passes: the guard file is untouched and is deleted by the periphery plan.

- [ ] **Step 5: Commit**

```bash
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts scripts/autodeploy/install-invariant.test.ts
git commit -m "feat(deploy): the tick deploys origin/main — quiet, CI on the commit, holds

Replaces the autodeploy-* tag path: a merge is the permission, and the host
re-derives ancestry, what ships, ten minutes of quiet, CI on that exact
commit, and holds (paths + the deploy:hold label, fail closed).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: snapshot, trial migration and the 10-minute window

**Files:**
- Modify: `deploy/autodeploy.sh` (seams, `watch_window`, `deploy_pipeline`)
- Modify: `deploy/wbb-autodeploy.service`
- Modify: `scripts/autodeploy/autodeploy.test.ts`

**Interfaces:**
- Consumes: Task 3's `refuse`, `once_a_day`, `checkout_clean`, `wait_healthy`, `settle`, `roll_back`; `db-snapshot.sh snapshot|prune` (Task 1) and `trial-migrate` (Task 2) through the new seams.
- Produces: `watch_window <port>` → 0 when the window passes clean, 1 with `WATCH_REASON` set; `deploy_pipeline` calls `roll_back <sha> <reason> <pre> <pre_time>`, the signature Task 5 implements. Seams `WBB_SNAPSHOT_CMD <out>`, `WBB_TRIAL_CMD <copy>`, `WBB_PRUNE_CMD`, `WBB_SNAPSHOT_DIR`, `WBB_DB_PATH`.

- [ ] **Step 1: Write the failing tests**

In `autodeploy.test.ts`, change the expected events of the first test (`deploys the head of main once …`) to:

```ts
    const stamp = (e: string) => e.replace(/\d{8}T\d{6}Z/, 'STAMP');
    expect(events(w).map(stamp)).toEqual([
      `checks ${x}`,
      `build ${x}`,
      'audit',
      `snapshot STAMP-${short(x)}-pre.db`,
      'trial pre',
      `deploy ${x}`,
      'prune',
    ]);
```

and append:

```ts
describe('merge-deploy: snapshot, trial migration, window', () => {
  /** health fails from `from` seconds after the latest deploy onwards. */
  function healthFailingFrom(w: World, from: number): string {
    return stub(w.bin, `health-from-${from}`,
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt ${from} ]`);
  }

  it('refuses a commit whose trial migration fails, never deploys it, and removes the copy', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const trial = stub(w.bin, 'trial-red', 'echo "TRIAL FAILED: boom"; exit 1');
    ready(w, { WBB_TRIAL_CMD: trial });
    const r = tick(w, { WBB_TRIAL_CMD: trial });
    expect(r.code).toBe(1);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)[0]).toBe(`⛔ merge-deploy refused ${short(x)}: the trial migration on a copy of production failed.\nTRIAL FAILED: boom`);
    expect(existsSync(join(w.dataDir, 'wbb-autodeploy', 'trial.db'))).toBe(false);
  });

  it('does not deploy when the snapshot fails, and does not blame the commit', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const snapshot = stub(w.bin, 'snapshot-red', 'echo "disk full" >&2; exit 1');
    ready(w, { WBB_SNAPSHOT_CMD: snapshot });
    const r = tick(w, { WBB_SNAPSHOT_CMD: snapshot });
    expect(r.code).toBe(1);
    expect(events(w).some((e) => e.startsWith('deploy '))).toBe(false);
    expect(readState(w).LAST_FAILED_SHA).toBe(undefined);
    expect(notes(w)[0]).toMatch(/^⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying [0-9a-f]{7}\.\ndisk full/);
  });

  it('rolls back on a failure first seen at the last poll inside the window (590 s)', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 590);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(2);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`, `deploy ${w.base}`]);
    expect(notes(w)[0]).toMatch(/health check failed at \+590s/);
  });

  it('settles when the failure only starts at 600 s — after the window', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 600);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
  });

  it('rolls back when the service restarts inside the window, even if health looks fine', () => {
    const w = world();
    push(w, { 'src/a.ts': '2' }, 'feat');
    const restarts = stub(w.bin, 'restarts-bump',
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt 300 ] && echo 0 || echo 1`);
    ready(w, { WBB_RESTARTS_CMD: restarts });
    const r = tick(w, { WBB_RESTARTS_CMD: restarts });
    expect(r.code).toBe(2);
    expect(notes(w)[0]).toMatch(/service restarted \(NRestarts 0 -> 1\) at \+300s/);
  });

  it('keeps a settled deploy settled when pruning fails', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const prune = stub(w.bin, 'prune-red', 'exit 1');
    ready(w, { WBB_PRUNE_CMD: prune });
    const r = tick(w, { WBB_PRUNE_CMD: prune });
    expect(r.code).toBe(0);
    expect(readState(w).DEPLOYED_SHA).toBe(x);
  });

  it('lets the service unit outlive the window', () => {
    const unit = readFileSync(resolve(__dirname, '../../deploy/wbb-autodeploy.service'), 'utf8');
    expect(unit).toMatch(/^TimeoutStartSec=30min$/m);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: FAIL. The events of the first test lack snapshot/trial/prune, the window tests settle or roll back at the wrong time, and the unit has no `TimeoutStartSec`.

- [ ] **Step 3: Implement**

In `deploy/autodeploy.sh`, add to the constants (after `STARTUP_S=60`):

```bash
WINDOW_S=600
POLL_S=10
KEEP_SNAPSHOTS=3
SNAPSHOT_DIR="${WBB_SNAPSHOT_DIR:-/var/lib/warsaw-beer-bot/deploy-snapshots}"
DB_PATH="${WBB_DB_PATH:-/var/lib/warsaw-beer-bot/bot.db}"
```

Add to the seams section (after `API_PORT_CMD`):

```bash
# DB helpers run as the bot user through the existing `bash -lc` rule (P3), so
# snapshots are owned by warsaw-beer-bot and live next to bot.db.
_as_bot() { sudo -u warsaw-beer-bot bash -lc '"$0" "$@"' "$@"; }
_snapshot_default() { _as_bot "$SNAPSHOT_BIN" snapshot "$DB_PATH" "$1"; }
SNAPSHOT_CMD="${WBB_SNAPSHOT_CMD:-_snapshot_default}"
_prune_default() { _as_bot "$SNAPSHOT_BIN" prune "$SNAPSHOT_DIR" "$KEEP_SNAPSHOTS"; }
PRUNE_CMD="${WBB_PRUNE_CMD:-_prune_default}"
_trial_default() { node "$TRIAL_BIN" "$REPO" "$1"; }
TRIAL_CMD="${WBB_TRIAL_CMD:-_trial_default}"
```

Add after `wait_healthy()`:

```bash
# D5/D6: ten minutes after the deploy, anything that goes wrong is the
# deploy's fault and is rolled back; after that, it is an ordinary incident.
# Polls /health and NRestarts (a crash loop can look healthy between polls).
watch_window() {
  local port="$1" start r0 r t
  start=$(now)
  r0=$("$RESTARTS_CMD" 2>/dev/null) || r0=""
  while :; do
    t=$(( $(now) - start ))
    if [ "$t" -ge "$WINDOW_S" ]; then return 0; fi
    if ! "$HEALTH_CMD" "$port"; then
      WATCH_REASON="health check failed at +${t}s"
      return 1
    fi
    r=$("$RESTARTS_CMD" 2>/dev/null) || r=""
    if [ -n "$r0" ] && [ "$r" != "$r0" ]; then
      WATCH_REASON="service restarted (NRestarts ${r0} -> ${r}) at +${t}s"
      return 1
    fi
    "$SLEEP_CMD" "$POLL_S"
  done
}
```

Replace `deploy_pipeline()` with:

```bash
deploy_pipeline() {
  local x="$1" old="$DEPLOYED_SHA" out status pre pre_t trial
  if ! checkout_clean "$x"; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not check out ${x:0:7}."
    exit 1
  fi
  if ! out=$(cd "$REPO" && "$BUILD_CMD" 2>&1); then
    refuse "$x" "the build failed.
$(tail -n 20 <<< "$out")"
  fi
  out=$(cd "$REPO" && "$AUDIT_CMD" 2>&1) && status=0 || status=$?
  if [ "$status" -eq 1 ]; then
    refuse "$x" "npm audit --omit=dev reports a high or critical advisory.
$out"
  elif [ "$status" -ne 0 ]; then
    once_a_day LAST_ASSESS_NOTICE "⚠️ merge-deploy: npm audit could not run (exit ${status}) for ${x:0:7} — NOT a finding, just no verification. Retrying next tick.
$out"
    exit 1
  fi

  # D4 + P1: VACUUM INTO, one point in time. A failed snapshot is the host's
  # problem, not the commit's: no LAST_FAILED_SHA, retried next tick.
  pre="${SNAPSHOT_DIR}/$(date -u +%Y%m%dT%H%M%SZ)-${x:0:7}-pre.db"
  pre_t=$(date -u +%H:%M:%S)
  if ! out=$("$SNAPSHOT_CMD" "$pre" 2>&1); then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: the pre-deploy DB snapshot failed — not deploying ${x:0:7}.
$out"
    exit 1
  fi

  # The trial runs on a COPY of pre, in the operator's own data dir.
  trial="$DATA_DIR/trial.db"
  rm -f "$trial" "$trial-wal" "$trial-shm"
  if ! cp "$pre" "$trial"; then
    once_a_day LAST_ASSESS_NOTICE "⛔ merge-deploy: could not copy the snapshot for the trial migration — not deploying ${x:0:7}."
    exit 1
  fi
  out=$("$TRIAL_CMD" "$trial" 2>&1) && status=0 || status=$?
  rm -f "$trial" "$trial-wal" "$trial-shm"
  if [ "$status" -ne 0 ]; then
    refuse "$x" "the trial migration on a copy of production failed.
$out"
  fi
  echo "$out"

  echo "deploying $x"
  if ! ( cd "$REPO" && "$DEPLOY_CMD" ); then
    roll_back "$x" "deploy.sh failed" "$pre" "$pre_t"
  fi
  if ! wait_healthy "$PORT" "$STARTUP_S"; then
    roll_back "$x" "not healthy within ${STARTUP_S}s" "$pre" "$pre_t"
  fi
  if ! watch_window "$PORT"; then
    roll_back "$x" "$WATCH_REASON" "$pre" "$pre_t"
  fi
  "$PRUNE_CMD" || echo "WARNING: snapshot pruning failed"
  settle "$x" "$old"
}
```

In `deploy/wbb-autodeploy.service`, under `[Service]` after `ExecStart=`:

```ini
# Merge-deploy: a deploying tick lasts the 10-min rollback window plus the
# build; a oneshot's start timeout must not cut the window short.
TimeoutStartSec=30min
```

and replace the `Description=` line with `Description=merge-deploy: deploy origin/main when it is quiet, green and unheld`.

- [ ] **Step 4: Run the tests, the mutation checks, and the full gate**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: PASS.

Mutation checks (revert after each):
1. In `watch_window`, change `-ge "$WINDOW_S"` to `-gt "$WINDOW_S"` → `settles when the failure only starts at 600 s` fails.
2. Delete the whole NRestarts `if` block → `rolls back when the service restarts inside the window` fails.

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add deploy/autodeploy.sh deploy/wbb-autodeploy.service scripts/autodeploy/autodeploy.test.ts
git commit -m "feat(deploy): pre-deploy snapshot, trial migration and a 10-min watch window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: roll back code AND database inside the window

**Files:**
- Modify: `deploy/autodeploy.sh` (seams, `roll_back`, `rollback_failed`)
- Modify: `scripts/autodeploy/autodeploy.test.ts`

**Interfaces:**
- Consumes: `roll_back <sha> <reason> <pre> <pre_time>` as called by Task 4; `db-snapshot.sh mark-rollback|post|restore` (Task 1).
- Produces: exit 2 on a completed rollback, 3 on a failed one. Seams `WBB_SERVICE_CMD <verb> <unit>`, `WBB_MARK_CMD <pre>` (prints the marked path), `WBB_POST_CMD <dir>`, `WBB_RESTORE_CMD <snap>`.

- [ ] **Step 1: Write the failing tests**

Delete the whole `describe('merge-deploy: a deploy that does not come up (code-only rollback until Task 5)', …)` block. Then change the test `rolls back on a failure first seen at the last poll inside the window (590 s)`: its last assertion becomes `expect(notes(w)[0]).toMatch(/failed inside the rollback window: health check failed at \+590s/);`. Append:

```ts
describe('merge-deploy: rollback restores code AND database', () => {
  function healthFailingFrom(w: World, from: number): string {
    return stub(w.bin, `health-from-${from}`,
      `now=$(cat "${w.clock}"); d=$(cat "${w.bin}/deployed_at"); [ $(( now - d )) -lt ${from} ]`);
  }
  const stamp = (e: string) => e.replace(/\d{8}T\d{6}Z/, 'STAMP');

  it('stops, keeps post, restores pre, and redeploys the old code — in that order', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });

    expect(r.code).toBe(2);
    const ev = events(w).map(stamp);
    expect(ev.slice(ev.indexOf(`deploy ${x}`))).toEqual([
      `deploy ${x}`,
      'service stop warsaw-beer-bot',
      'service stop litestream',
      `mark STAMP-${short(x)}-pre.db`,
      `post STAMP-${short(x)}-rollback-post`,
      `restore STAMP-${short(x)}-rollback-pre.db`,
      'service start litestream',
      `deploy ${w.base}`,
    ]);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(readState(w).DEPLOYED_SHA).toBe(w.base);
    const last = notes(w)[notes(w).length - 1];
    expect(last).toMatch(new RegExp(`^🔥 merge-deploy ROLLED BACK ${short(x)} → ${short(w.base)}, code AND database\\.`));
    expect(last).toMatch(/Writes between \d\d:\d\d:\d\d and \d\d:\d\d:\d\d UTC exist only in: \S+-rollback-post\n/);
    expect(last).toMatch(/Pre-deploy snapshot now live: \S+-rollback-pre\.db\n/);
  });

  it('restores the database too when the new code never comes up', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = stub(w.bin, 'health-x-bad', `tail -n1 "${w.eventsLog}" | grep -q "deploy ${x}" && exit 1; exit 0`);
    ready(w, { WBB_HEALTH_CMD: health });
    const r = tick(w, { WBB_HEALTH_CMD: health });
    expect(r.code).toBe(2);
    expect(events(w).map(stamp)).toContain(`restore STAMP-${short(x)}-rollback-pre.db`);
    expect(notes(w)[0]).toMatch(/not healthy within 60s/);
  });

  it('stops at a failed restore, says ROLLBACK FAILED with both paths, and deploys nothing more', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    const restore = stub(w.bin, 'restore-red', `echo "restore $(basename "$1")" >> "${w.eventsLog}"; exit 1`);
    ready(w, { WBB_HEALTH_CMD: health, WBB_RESTORE_CMD: restore });
    const r = tick(w, { WBB_HEALTH_CMD: health, WBB_RESTORE_CMD: restore });

    expect(r.code).toBe(3);
    expect(events(w).map(stamp).slice(-1)).toEqual([`restore STAMP-${short(x)}-rollback-pre.db`]);
    expect(events(w).filter((e) => e.startsWith('deploy '))).toEqual([`deploy ${x}`]);
    const last = notes(w)[notes(w).length - 1];
    expect(last).toMatch(/^🔥 ROLLBACK FAILED at: restore pre\. /);
    expect(last).toMatch(/pre=\S+-rollback-pre\.db post=\S+-rollback-post/);
  });

  it('records LAST_FAILED_SHA before the first rollback step can fail', () => {
    const w = world();
    const x = push(w, { 'src/a.ts': '2' }, 'feat');
    const health = healthFailingFrom(w, 300);
    const service = stub(w.bin, 'service-red', 'exit 1');
    ready(w, { WBB_HEALTH_CMD: health, WBB_SERVICE_CMD: service });
    const r = tick(w, { WBB_HEALTH_CMD: health, WBB_SERVICE_CMD: service });
    expect(r.code).toBe(3);
    expect(readState(w).LAST_FAILED_SHA).toBe(x);
    expect(notes(w)[notes(w).length - 1]).toMatch(/^🔥 ROLLBACK FAILED at: stop warsaw-beer-bot\./);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: FAIL. The code-only `roll_back` calls none of the service/mark/post/restore seams, and its messages differ.

- [ ] **Step 3: Implement**

Add to the seams section:

```bash
_service_default() { sudo systemctl "$1" "$2"; }
SERVICE_CMD="${WBB_SERVICE_CMD:-_service_default}"
_mark_default() { _as_bot "$SNAPSHOT_BIN" mark-rollback "$1"; }
MARK_CMD="${WBB_MARK_CMD:-_mark_default}"
_post_default() { _as_bot "$SNAPSHOT_BIN" post "$DB_PATH" "$1"; }
POST_CMD="${WBB_POST_CMD:-_post_default}"
_restore_default() { _as_bot "$SNAPSHOT_BIN" restore "$1" "$DB_PATH"; }
RESTORE_CMD="${WBB_RESTORE_CMD:-_restore_default}"
```

Replace `roll_back()` with:

```bash
rollback_failed() {
  notify "🔥 ROLLBACK FAILED at: $1. Production state is UNKNOWN — the bot may be down. Snapshots: pre=${2:-?} post=${3:-?}. Manual intervention required."
  exit 3
}

# D5 — inside the window, code AND database go back to pre. Nothing is lost:
# post keeps what the new code wrote (and R2 history keeps it a third time,
# P2), and a human reconciles. One attempt, then a human (#435 §7).
roll_back() {
  local x="$1" reason="$2" pre="$3" pre_t="$4" old="$DEPLOYED_SHA" marked post stop_t
  # C3, kept: recorded FIRST, so whatever happens below, this head is not retried.
  LAST_FAILED_SHA="$x"
  write_state
  notify "⚠️ merge-deploy ${x:0:7} failed inside the rollback window: ${reason} — restoring code and database to ${old:0:7}."
  "$SERVICE_CMD" stop warsaw-beer-bot || rollback_failed "stop warsaw-beer-bot" "$pre" ""
  # P2: litestream must not be replicating while the file is replaced.
  "$SERVICE_CMD" stop litestream || rollback_failed "stop litestream" "$pre" ""
  stop_t=$(date -u +%H:%M:%S)
  # Marked before anything reads it, so prune can never take it.
  marked=$("$MARK_CMD" "$pre") || rollback_failed "mark the pre snapshot" "$pre" ""
  post="${marked%-rollback-pre.db}-rollback-post"
  "$POST_CMD" "$post" || rollback_failed "snapshot post" "$marked" "$post"
  "$RESTORE_CMD" "$marked" || rollback_failed "restore pre" "$marked" "$post"
  "$SERVICE_CMD" start litestream || rollback_failed "start litestream" "$marked" "$post"
  checkout_clean "$old" || rollback_failed "check out ${old:0:7}" "$marked" "$post"
  # deploy.sh restarts the bot itself (and re-records DEPLOYED_SHA=old).
  ( cd "$REPO" && "$DEPLOY_CMD" ) || rollback_failed "deploy ${old:0:7}" "$marked" "$post"
  wait_healthy "$PORT" "$STARTUP_S" || rollback_failed "health after the rollback" "$marked" "$post"
  notify "🔥 merge-deploy ROLLED BACK ${x:0:7} → ${old:0:7}, code AND database.
Writes between ${pre_t} and ${stop_t} UTC exist only in: ${post}
Pre-deploy snapshot now live: ${marked}
R2 history also still holds the post state (litestream restore -txid).
A human must reconcile; nothing will do it automatically."
  exit 2
}
```

- [ ] **Step 4: Run the tests, the mutation checks, and the full gate**

Run: `npx vitest run scripts/autodeploy/autodeploy.test.ts`
Expected: PASS.

Mutation checks (revert after each):
1. Swap the `stop litestream` and `restore` lines' order (restore first) → `… in that order` fails.
2. Move `LAST_FAILED_SHA="$x"; write_state` below the first `SERVICE_CMD` line → `records LAST_FAILED_SHA before the first rollback step can fail` fails.

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add deploy/autodeploy.sh scripts/autodeploy/autodeploy.test.ts
git commit -m "feat(deploy): roll back code and database inside the window, keeping post

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the core: end-to-end review, then the periphery plan

1. **End-to-end review** of Tasks 1–5 against the spec (a dispatched reviewer, not the author). It must check in particular that the claim → evidence table still holds for what was built, and that no seam default runs anything as root beyond the sudoers set (`deploy/sudoers.d/warsaw-beer-bot`).
2. Only then write `docs/superpowers/plans/2026-09/<date>-merge-deploy-periphery.md`: the `deploy-hold` CI job with the title/label pairing; deletion of `autodeploy-tag.yml`, `autodeploy-guard.sh` + `guard.test.ts`, the guard's install line and the tags on origin; `autodeploy` → `automerge` in `dependabot-qualify.yml` (check who else reads the label); `deploy/README.md`; `spec.md` "Deployment"; the `[deploy:hold]` rule in `CLAUDE.md` + `AGENTS.md`; closing #498/#499. **Spec deviation to settle there:** the ⏸ hold message links the PR instead of quoting "the steps from the PR body". Either update the spec's notification table or add the body fetch.
3. **Rollout** is a `[deploy:hold]` PR: `sudo bash deploy/install-autodeploy.sh`, `systemctl daemon-reload` (the unit changed), `bash deploy/deploy.sh`, then the pre-registered live test on the next real merge.
