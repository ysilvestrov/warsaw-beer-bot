# Extension Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run release` (run as `ysi` in `extension/`) build, write the prod `extension_releases` row, and stage the zip in one command — leaving only the two Telegram steps (forward + 📣) manual.

**Architecture:** Three independent pieces. (1) Make `zip-dist.py` produce a deterministic archive. (2) Refactor `publish-extension-release.ts` into testable seams that pick an adaptive DB-write transport (in-process for writable DBs, a privileged sudo helper for the service-owned prod DB) and stage the zip. (3) A narrow root-owned wrapper + NOPASSWD sudoers rule that lets `ysi` apply exactly one fixed release-row upsert as `warsaw-beer-bot`.

**Tech Stack:** TypeScript (tsx, better-sqlite3, ts-jest), Python 3 (stdlib `zipfile`), Bash + `sqlite3` CLI, vitest (extension), sudoers.

**Spec:** `docs/superpowers/specs/2026-06-09-extension-release-automation-design.md`

---

## File structure

| File | Responsibility |
| --- | --- |
| `extension/scripts/zip-dist.py` (modify) | Deterministic zip; `ZIP_DIST_SRC`/`ZIP_DIST_OUT` overrides for tests |
| `extension/src/build/zip-determinism.test.ts` (create) | Asserts two builds of identical content match (node env) |
| `scripts/publish-extension-release.ts` (modify) | `buildReleaseRow` (kept) + `writeReleaseRow` (adaptive) + `stageZip` + rewired `main` |
| `scripts/publish-extension-release.test.ts` (modify) | Unit tests for in-process write branch, helper-delegation branch, staging |
| `deploy/bin/apply-extension-release.sh` (create) | Privileged fixed-upsert wrapper; hard-coded prod DB path |
| `deploy/sudoers.d/warsaw-beer-extension-release` (create) | NOPASSWD rule scoped to the wrapper |
| `scripts/apply-extension-release.test.ts` (create) | Runs a path-patched copy of the wrapper against a temp DB |
| `docs/extension-release.md` (modify) | Runbook rewritten for the one-command flow + one-time setup |

---

## Task 1: Deterministic zip

**Files:**
- Modify: `extension/scripts/zip-dist.py`
- Test: `extension/src/build/zip-determinism.test.ts`

- [ ] **Step 1: Write the failing test**

Create `extension/src/build/zip-determinism.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '..', '..', 'scripts', 'zip-dist.py');

function build(src: string, out: string): string {
  execFileSync('python3', [script], {
    env: { ...process.env, ZIP_DIST_SRC: src, ZIP_DIST_OUT: out },
  });
  return createHash('sha256').update(readFileSync(out)).digest('hex');
}

describe('zip-dist determinism', () => {
  it('produces a byte-identical zip for identical content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zipdet-'));
    const src = join(dir, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'z.txt'), 'zeta');
    writeFileSync(join(src, 'b.txt'), 'beta');
    writeFileSync(join(src, 'sub', 'a.txt'), 'alpha');

    const first = build(src, join(dir, 'first.zip'));
    const second = build(src, join(dir, 'second.zip'));
    expect(first).toBe(second);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && npx vitest run src/build/zip-determinism.test.ts`
Expected: FAIL — the current `zip-dist.py` ignores `ZIP_DIST_SRC`/`ZIP_DIST_OUT` (writes to the default path; the temp `out` file is absent so `readFileSync` throws), and even if pointed correctly the two zips differ by mtime.

- [ ] **Step 3: Rewrite `extension/scripts/zip-dist.py`**

Replace the whole file with:

```python
#!/usr/bin/env python3
"""Package the built dist/ into a single loadable .zip (dist contents at the zip root).

Used by `npm run package`. Kept in Python because the host has no `zip` binary and
Node has no stdlib zip writer. The resulting archive, once unzipped, is a folder you
load via chrome://extensions -> Load unpacked.

The archive is DETERMINISTIC: entries are sorted and written with a fixed timestamp and
mode, so identical dist/ contents always produce a byte-identical zip (stable sha256).
Override the source dir / output path via ZIP_DIST_SRC / ZIP_DIST_OUT (used by tests).
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = os.path.dirname(HERE)

with open(os.path.join(EXT_ROOT, "package.json"), encoding="utf-8") as f:
    VERSION = json.load(f)["version"]

DIST = os.environ.get("ZIP_DIST_SRC", os.path.join(EXT_ROOT, "dist"))
OUT = os.environ.get(
    "ZIP_DIST_OUT", os.path.join(EXT_ROOT, f"warsaw-beer-overlay-{VERSION}.zip")
)

FIXED_DATE = (1980, 1, 1, 0, 0, 0)  # zip epoch floor — stable across runs

if not os.path.isdir(DIST):
    sys.exit(f"{DIST} not found — run `npm run build` first (or use `npm run package`).")

if os.path.exists(OUT):
    os.remove(OUT)

entries = []
for root, _dirs, files in os.walk(DIST):
    for name in files:
        abs_path = os.path.join(root, name)
        arcname = os.path.relpath(abs_path, DIST)  # dist contents at zip root
        entries.append((arcname, abs_path))
entries.sort()  # deterministic entry order

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for arcname, abs_path in entries:
        with open(abs_path, "rb") as fh:
            data = fh.read()
        info = zipfile.ZipInfo(filename=arcname, date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, data)

print(f"Wrote {OUT} ({len(entries)} files, {os.path.getsize(OUT)} bytes)")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && npx vitest run src/build/zip-determinism.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the real build still works**

Run: `cd extension && npm run package`
Expected: prints `Wrote .../warsaw-beer-overlay-<v>.zip (N files, …)`. Then run it a second time and confirm the sha is identical:
`sha256sum warsaw-beer-overlay-*.zip` (run `npm run package` twice, compare — they must match).

- [ ] **Step 6: Commit**

```bash
git add extension/scripts/zip-dist.py extension/src/build/zip-determinism.test.ts
git commit -m "build(extension): deterministic zip-dist (sorted entries, fixed mtime/mode)"
```

---

## Task 2: Adaptive write + staging seams in the publish script

**Files:**
- Modify: `scripts/publish-extension-release.ts`
- Test: `scripts/publish-extension-release.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/publish-extension-release.test.ts` (keep the existing `buildReleaseRow` test). Add the new imports at the top **and merge the existing `buildReleaseRow` import into the combined line below** — do not leave a duplicate `import { buildReleaseRow }` statement (the existing file already imports it from `./publish-extension-release`):

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReleaseRow, writeReleaseRow, stageZip } from './publish-extension-release';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { getReleaseByVersion } from '../src/storage/extension_releases';

describe('writeReleaseRow', () => {
  it('writes in-process when the DB is writable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rel-'));
    const dbPath = join(dir, 'bot.db');
    const seed = openDb(dbPath);
    migrate(seed);
    seed.close();

    const how = writeReleaseRow(
      dbPath,
      { version: '0.2.0', sha256: 'abc', notes: 'note' },
      { isWritable: () => true },
    );
    expect(how).toBe('in-process');

    const db = openDb(dbPath);
    expect(getReleaseByVersion(db, '0.2.0')!.sha256).toBe('abc');
    db.close();
  });

  it('delegates to the helper when the DB is not writable', () => {
    const calls: string[][] = [];
    const how = writeReleaseRow(
      '/var/lib/warsaw-beer-bot/bot.db',
      { version: '0.2.0', sha256: 'deadbeef', notes: 'release notes' },
      {
        isWritable: () => false,
        helperPath: '/usr/local/bin/apply-extension-release.sh',
        runHelper: (helper, version, sha, notes) => calls.push([helper, version, sha, notes]),
      },
    );
    expect(how).toBe('helper');
    expect(calls).toEqual([
      ['/usr/local/bin/apply-extension-release.sh', '0.2.0', 'deadbeef', 'release notes'],
    ]);
  });
});

describe('stageZip', () => {
  it('copies the zip into the staging dir under the versioned name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stage-'));
    const zipPath = join(dir, 'built.zip');
    writeFileSync(zipPath, 'zip-bytes');
    const stageDir = join(dir, 'out');

    const dest = stageZip(zipPath, '0.2.0', stageDir);
    expect(dest).toBe(join(stageDir, 'warsaw-beer-overlay-0.2.0.zip'));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('zip-bytes');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest scripts/publish-extension-release.test.ts`
Expected: FAIL — `writeReleaseRow` and `stageZip` are not exported yet.

- [ ] **Step 3: Rewrite `scripts/publish-extension-release.ts`**

Replace the whole file with:

```ts
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/storage/db';
import { upsertRelease } from '../src/storage/extension_releases';

export function buildReleaseRow(input: { version: string; zip: Buffer; notes: string }): {
  version: string;
  sha256: string;
  notes: string;
} {
  return {
    version: input.version,
    sha256: createHash('sha256').update(input.zip).digest('hex'),
    notes: input.notes.trim(),
  };
}

export const DEFAULT_HELPER = '/usr/local/bin/apply-extension-release.sh';

export interface WriteReleaseDeps {
  isWritable?: (dbPath: string) => boolean;
  runHelper?: (helperPath: string, version: string, sha256: string, notes: string) => void;
  helperPath?: string;
}

function defaultIsWritable(dbPath: string): boolean {
  try {
    accessSync(dbPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRunHelper(
  helperPath: string,
  version: string,
  sha256: string,
  notes: string,
): void {
  execFileSync('sudo', ['-u', 'warsaw-beer-bot', helperPath, version, sha256], {
    input: notes,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

// Writes the release row. In-process upsert when the DB is writable by this user
// (local dev / CI); otherwise hands the row to the privileged helper, run via sudo as
// the bot's service user (prod, where the DB is owned by warsaw-beer-bot and /home is
// 0750 so the service user can't run this script in place).
export function writeReleaseRow(
  dbPath: string,
  row: { version: string; sha256: string; notes: string },
  deps: WriteReleaseDeps = {},
): 'in-process' | 'helper' {
  const isWritable = deps.isWritable ?? defaultIsWritable;
  if (isWritable(dbPath)) {
    const db = openDb(dbPath);
    upsertRelease(db, row);
    db.close();
    return 'in-process';
  }
  const helperPath = deps.helperPath ?? process.env.RELEASE_APPLY_HELPER ?? DEFAULT_HELPER;
  const runHelper = deps.runHelper ?? defaultRunHelper;
  runHelper(helperPath, row.version, row.sha256, row.notes);
  return 'helper';
}

// Copies the built zip into an accessible staging dir for the manual Telegram forward.
export function stageZip(
  zipPath: string,
  version: string,
  stageDir: string = join(homedir(), 'extension-releases'),
): string {
  mkdirSync(stageDir, { recursive: true });
  const dest = join(stageDir, `warsaw-beer-overlay-${version}.zip`);
  copyFileSync(zipPath, dest);
  return dest;
}

// Run via `npx tsx scripts/publish-extension-release.ts` from the repo root, after
// `npm run package` in extension/. Writes the release row into the bot DB
// (DATABASE_PATH) and stages the zip. The table must already exist (the running bot
// migrated it). The bot fills file_id later when the admin uploads the zip.
function main(): void {
  const root = resolve(__dirname, '..');
  const extDir = resolve(root, 'extension');
  const version = (
    JSON.parse(readFileSync(resolve(extDir, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const zipPath = resolve(extDir, `warsaw-beer-overlay-${version}.zip`);
  const zip = readFileSync(zipPath);
  const notes = readFileSync(resolve(extDir, 'dist', 'RELEASE_NOTES.txt'), 'utf8');

  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath) throw new Error('DATABASE_PATH is not set');

  const row = buildReleaseRow({ version, zip, notes });
  const how = writeReleaseRow(dbPath, row);
  const staged = stageZip(zipPath, version);

  console.log(
    `extension_releases ← v${row.version} (${how}, sha256 ${row.sha256.slice(0, 12)}…, ${zip.length} bytes) @ ${dbPath}`,
  );
  console.log(`staged: ${staged}`);
  console.log(`fetch:  scp ${userInfo().username}@${hostname()}:${staged} .`);
}

// Only run when invoked directly, not when imported by the test.
if (require.main === module) main();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest scripts/publish-extension-release.test.ts`
Expected: PASS (3 tests: buildReleaseRow, writeReleaseRow ×2, stageZip).

- [ ] **Step 5: Commit**

```bash
git add scripts/publish-extension-release.ts scripts/publish-extension-release.test.ts
git commit -m "feat(release): adaptive DB-write transport + zip staging in publish script"
```

---

## Task 3: Privileged wrapper + sudoers

**Files:**
- Create: `deploy/bin/apply-extension-release.sh`
- Create: `deploy/sudoers.d/warsaw-beer-extension-release`
- Test: `scripts/apply-extension-release.test.ts`

- [ ] **Step 1: Create the wrapper `deploy/bin/apply-extension-release.sh`**

```bash
#!/usr/bin/env bash
# Privileged release-row applier. Installed at /usr/local/bin (root:root, 0755) and run
# only via the NOPASSWD sudoers rule as warsaw-beer-bot. Performs exactly one fixed
# upsert into the hard-coded prod bot DB. Keep the DB path literal — the test patches a
# copy, never this file.
set -euo pipefail
version="$1"
sha="$2"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bad version: $version" >&2; exit 2; }
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "bad sha: $sha" >&2; exit 2; }
notes="$(cat)"                  # free text from stdin
notes_esc="${notes//\'/\'\'}"   # SQLite text-literal escape: double single quotes
printf 'PRAGMA busy_timeout=5000;\nINSERT INTO extension_releases (version,sha256,notes) VALUES('"'"'%s'"'"','"'"'%s'"'"','"'"'%s'"'"') ON CONFLICT(version) DO UPDATE SET sha256=excluded.sha256, notes=excluded.notes;\n' \
  "$version" "$sha" "$notes_esc" \
  | sqlite3 /var/lib/warsaw-beer-bot/bot.db
```

- [ ] **Step 2: Create the sudoers snippet `deploy/sudoers.d/warsaw-beer-extension-release`**

```
# Allow ysi to apply an extension release row as the bot's service user without a
# password — only this one fixed-shape command, nothing else.
ysi ALL=(warsaw-beer-bot) NOPASSWD: /usr/local/bin/apply-extension-release.sh
```

- [ ] **Step 3: Write the failing test**

Create `scripts/apply-extension-release.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { getReleaseByVersion } from '../src/storage/extension_releases';

const PROD_DB = '/var/lib/warsaw-beer-bot/bot.db';

function hasSqlite(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v sqlite3'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Patch the hard-coded prod DB path to a temp DB so the wrapper can be exercised without
// sudo. The installed prod copy stays literal — asserted below.
function installPatched(dbPath: string): string {
  const src = readFileSync(
    resolve(__dirname, '..', 'deploy', 'bin', 'apply-extension-release.sh'),
    'utf8',
  );
  expect(src).toContain(PROD_DB);
  const dir = mkdtempSync(join(tmpdir(), 'wrap-'));
  const script = join(dir, 'apply.sh');
  writeFileSync(script, src.replace(PROD_DB, dbPath));
  chmodSync(script, 0o755);
  return script;
}

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wrapdb-'));
  const dbPath = join(dir, 'bot.db');
  const db = openDb(dbPath);
  migrate(db);
  db.close();
  return dbPath;
}

(hasSqlite() ? describe : describe.skip)('apply-extension-release.sh', () => {
  it('upserts a row, preserving single quotes in notes', () => {
    const dbPath = makeDb();
    const script = installPatched(dbPath);
    execFileSync(script, ['0.2.0', 'a'.repeat(64)], { input: "Don't break" });

    const db = openDb(dbPath);
    const row = getReleaseByVersion(db, '0.2.0')!;
    db.close();
    expect(row.sha256).toBe('a'.repeat(64));
    expect(row.notes).toBe("Don't break");
    expect(row.file_id).toBeNull();
  });

  it('is idempotent on version (second run updates sha256 + notes)', () => {
    const dbPath = makeDb();
    const script = installPatched(dbPath);
    execFileSync(script, ['0.2.0', 'a'.repeat(64)], { input: 'first' });
    execFileSync(script, ['0.2.0', 'b'.repeat(64)], { input: 'second' });

    const db = openDb(dbPath);
    const row = getReleaseByVersion(db, '0.2.0')!;
    db.close();
    expect(row.sha256).toBe('b'.repeat(64));
    expect(row.notes).toBe('second');
  });

  it('rejects a malformed version with exit code 2', () => {
    const dbPath = makeDb();
    const script = installPatched(dbPath);
    let status: number | null = null;
    try {
      execFileSync(script, ['not-semver', 'a'.repeat(64)], { input: 'n', stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest scripts/apply-extension-release.test.ts`
Expected: PASS (3 tests) on hosts with `sqlite3` (the prod host and GitHub `ubuntu` runners). If `sqlite3` is absent the suite skips rather than fails.

- [ ] **Step 5: Commit**

```bash
git add deploy/bin/apply-extension-release.sh deploy/sudoers.d/warsaw-beer-extension-release scripts/apply-extension-release.test.ts
git commit -m "feat(release): narrow privileged wrapper + NOPASSWD sudoers for prod row write"
```

---

## Task 4: Runbook + spec review

**Files:**
- Modify: `docs/extension-release.md`
- Review/possibly modify: `spec.md`

- [ ] **Step 1: Rewrite `docs/extension-release.md`**

Replace the whole file with:

```markdown
# Випуск нової версії розширення (для maintainer)

## Одноразовий сетап (раз на хост, під root)

Передумови: приватний ключ підпису `~/warsaw-beer-extension-key.pem` уже існує
(публічний ключ зашитий у `extension/manifest.config.ts` як `key`). Встанови
привілейований applier і sudoers-правило (дають `ysi` беспарольно застосувати
**лише** фіксований release-row upsert як `warsaw-beer-bot`):

```bash
sudo install -o root -g root -m 0755 deploy/bin/apply-extension-release.sh /usr/local/bin/apply-extension-release.sh
sudo install -o root -g root -m 0440 deploy/sudoers.d/warsaw-beer-extension-release /etc/sudoers.d/warsaw-beer-extension-release
sudo visudo -c   # має вивести: /etc/sudoers.d/warsaw-beer-extension-release: parsed OK
```

## Випуск (одна команда)

1. Онови код розширення в `extension/`, підніми версію в `extension/package.json` і
   додай секцію `## [x.y.z] - YYYY-MM-DD` у `extension/CHANGELOG.md` (білд впаде без неї).
2. Збери, запиши рядок у прод-БД і застейдж zip однією командою:

   ```bash
   cd extension
   DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run release
   ```

   `npm run release` = `vite build` → `dist/RELEASE_NOTES.txt` →
   `warsaw-beer-overlay-<version>.zip` (детермінований) → запис рядка
   `extension_releases` (in-process якщо БД писабельна, інакше через привілейований
   applier) → копія zip у `~/extension-releases/`. У кінці друкує шлях, sha256 і
   готовий `scp`-однорядок.
3. Перешли боту в приваті застейджений файл
   `~/extension-releases/warsaw-beer-overlay-<version>.zip` (за потреби забери його
   `scp`-командою з виводу). Бот звірить sha256 з рядком і відповість
   «Прикріплено до v… 📣 Розіслати / Скасувати».
4. Натисни **📣 Розіслати** — бот розішле zip усім власникам токенів, кожному його
   мовою. У відповідь — підсумок «надіслано X, помилок Y».

Нові тестери отримують актуальний zip автоматично через `/extension`.

> Запис іде в живу БД бота. Детермінований zip означає, що повторний `npm run release`
> тієї ж версії безпечний (той самий sha → upsert-no-op). Не редагуй застейджений zip
> вручну — бот матчить саме його sha.
```

- [ ] **Step 2: Review `spec.md` for release/distribution contract**

Run: `grep -niE 'release|extension|\.zip|distribut' spec.md`
If `spec.md` documents the extension release/distribution contract, add one line noting the deterministic artifact + one-command publish under the relevant section. If it does not (release tooling is operational, out of behavioural scope), make no change. Either way this is a deliberate decision recorded by the commit.

- [ ] **Step 3: Commit**

```bash
git add docs/extension-release.md
git add spec.md 2>/dev/null || true
git commit -m "docs: runbook for one-command extension release + spec review"
```

---

## Task 5: Full verification

- [ ] **Step 1: Bot suite**

Run: `npm test`
Expected: all bot/jest suites green, including the new `scripts/*.test.ts`.

- [ ] **Step 2: Extension suite + typecheck**

Run: `cd extension && npm test && npm run typecheck`
Expected: all vitest suites green (incl. `src/build/zip-determinism.test.ts`); `tsc --noEmit` exits 0.

- [ ] **Step 3: Build smoke + determinism**

Run: `cd extension && npm run package && sha256sum warsaw-beer-overlay-*.zip && npm run package && sha256sum warsaw-beer-overlay-*.zip`
Expected: both sha256 values identical.

---

## Self-review notes

- **Spec coverage:** zip determinism (Task 1), adaptive write transport (Task 2), staging (Task 2), narrow wrapper + sudoers (Task 3), runbook + spec review (Task 4), out-of-scope items untouched (no Telegram automation). All spec sections map to a task.
- **Types:** `writeReleaseRow` returns `'in-process' | 'helper'`; `WriteReleaseDeps` props (`isWritable`, `runHelper`, `helperPath`) used consistently across script and tests. `stageZip(zipPath, version, stageDir?)` signature matches its test. `buildReleaseRow` unchanged.
- **No placeholders:** every code/command step is complete and runnable.
- **Execution note:** if implemented in a worktree (branches from `origin/main`), cherry-pick the spec commit (`24a755f`) and this plan's commit into the worktree branch, per project convention.
```
