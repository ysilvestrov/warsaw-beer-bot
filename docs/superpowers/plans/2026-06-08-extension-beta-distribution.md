# Extension Beta Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship new browser-extension versions to a small group of technical beta-testers by having the build write a release row (version, notes, sha256) into the bot DB, then letting the admin forward the zip to the bot, which attaches a reusable Telegram `file_id` and broadcasts it to all token holders.

**Architecture:** The extension build is the single source of metadata — it embeds version + notes in the zip (for humans) and writes them plus the zip's sha256 into a new `extension_releases` table (for the bot). The bot never parses the zip; on an admin upload it only hash-matches the file against the latest release row to capture its `file_id`, then broadcasts on confirmation. Off-store distribution for ~10 technical testers; no Chrome Web Store.

**Tech Stack:** TypeScript, Telegraf (Composer/`on('document')`/`action`/inline keyboards), better-sqlite3 (WAL + pinned busy_timeout), Vite + crxjs (MV3), Jest (bot), Vitest (extension), tsx (release script).

Spec: `docs/superpowers/specs/2026-06-08-extension-beta-distribution-design.md`.

---

## Task 1: Migration v9 — `extension_releases` table

**Files:**
- Modify: `src/storage/schema.ts` (append to `MIGRATIONS`)
- Test: `src/storage/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/storage/schema.test.ts`:

```ts
it('migration v9 creates extension_releases with version PK and nullable file_id', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db
    .prepare('PRAGMA table_info(extension_releases)')
    .all() as { name: string; pk: number; notnull: number }[];
  const names = cols.map((c) => c.name);
  expect(names).toEqual(
    expect.arrayContaining(['version', 'sha256', 'notes', 'file_id', 'published_at', 'attached_by']),
  );
  expect(cols.find((c) => c.name === 'version')?.pk).toBe(1);
  expect(cols.find((c) => c.name === 'sha256')?.notnull).toBe(1);
  expect(cols.find((c) => c.name === 'file_id')?.notnull).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/schema.test.ts -t "migration v9" -v`
Expected: FAIL — `PRAGMA table_info(extension_releases)` returns `[]`, `version` pk is undefined.

- [ ] **Step 3: Append the migration**

In `src/storage/schema.ts`, add to the `MIGRATIONS` array after the `version: 8` entry:

```ts
  {
    version: 9,
    sql: `
      CREATE TABLE extension_releases (
        version      TEXT NOT NULL PRIMARY KEY,
        sha256       TEXT NOT NULL,
        notes        TEXT NOT NULL,
        file_id      TEXT,
        published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        attached_by  INTEGER
      );
    `,
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/schema.test.ts -t "migration v9" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/schema.test.ts
git commit -m "feat(db): migration v9 — extension_releases table"
```

---

## Task 2: `extension_releases` storage module

**Files:**
- Create: `src/storage/extension_releases.ts`
- Test: `src/storage/extension_releases.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/extension_releases.test.ts`:

```ts
import { openDb } from './db';
import { migrate } from './schema';
import {
  compareVersions,
  upsertRelease,
  latestRelease,
  getReleaseByVersion,
  attachFileId,
  listExtensionTokenHolders,
} from './extension_releases';

function seedToken(db: ReturnType<typeof openDb>, telegramId: number) {
  db.prepare('INSERT OR IGNORE INTO user_profiles (telegram_id) VALUES (?)').run(telegramId);
  db.prepare('INSERT INTO api_tokens (token_hash, telegram_id, created_at) VALUES (?, ?, ?)')
    .run(`hash-${telegramId}`, telegramId, '2026-06-08T00:00:00Z');
}

describe('extension_releases storage', () => {
  it('compareVersions orders numerically, not lexically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });

  it('upsert + latestRelease returns the highest semver', () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.9.0', sha256: 'a', notes: 'old' });
    upsertRelease(db, { version: '0.10.0', sha256: 'b', notes: 'new' });
    expect(latestRelease(db)!.version).toBe('0.10.0');
  });

  it('upsert is idempotent on version (updates sha256 + notes)', () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.2.0', sha256: 'a', notes: 'first' });
    upsertRelease(db, { version: '0.2.0', sha256: 'b', notes: 'second' });
    const r = getReleaseByVersion(db, '0.2.0')!;
    expect(r.sha256).toBe('b');
    expect(r.notes).toBe('second');
  });

  it('attachFileId sets file_id + attached_by on the row', () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.2.0', sha256: 'a', notes: 'n' });
    attachFileId(db, '0.2.0', 'FILEID', 42);
    const r = getReleaseByVersion(db, '0.2.0')!;
    expect(r.file_id).toBe('FILEID');
    expect(r.attached_by).toBe(42);
  });

  it('listExtensionTokenHolders returns distinct telegram_ids', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedToken(db, 1);
    seedToken(db, 2);
    expect(listExtensionTokenHolders(db).sort()).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/storage/extension_releases.test.ts -v`
Expected: FAIL — `Cannot find module './extension_releases'`.

- [ ] **Step 3: Write the module**

Create `src/storage/extension_releases.ts`:

```ts
import type { DB } from './db';

export interface ExtensionRelease {
  version: string;
  sha256: string;
  notes: string;
  file_id: string | null;
  published_at: string;
  attached_by: number | null;
}

// Numeric 3-part semver compare. >0 if a>b, <0 if a<b, 0 if equal.
// Avoids lexical bugs like "0.10.0" < "0.9.0".
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Written by the build (npm run release). file_id stays NULL until the admin uploads.
export function upsertRelease(
  db: DB,
  r: { version: string; sha256: string; notes: string },
): void {
  db.prepare(
    `INSERT INTO extension_releases (version, sha256, notes)
     VALUES (@version, @sha256, @notes)
     ON CONFLICT(version) DO UPDATE SET sha256 = excluded.sha256, notes = excluded.notes`,
  ).run(r);
}

export function getReleaseByVersion(db: DB, version: string): ExtensionRelease | null {
  return (
    (db
      .prepare('SELECT * FROM extension_releases WHERE version = ?')
      .get(version) as ExtensionRelease | undefined) ?? null
  );
}

export function latestRelease(db: DB): ExtensionRelease | null {
  const rows = db.prepare('SELECT * FROM extension_releases').all() as ExtensionRelease[];
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
}

export function attachFileId(
  db: DB,
  version: string,
  fileId: string,
  adminId: number,
): void {
  db.prepare(
    'UPDATE extension_releases SET file_id = ?, attached_by = ? WHERE version = ?',
  ).run(fileId, adminId, version);
}

export function listExtensionTokenHolders(db: DB): number[] {
  const rows = db
    .prepare('SELECT DISTINCT telegram_id FROM api_tokens')
    .all() as { telegram_id: number }[];
  return rows.map((r) => r.telegram_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/storage/extension_releases.test.ts -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/storage/extension_releases.ts src/storage/extension_releases.test.ts
git commit -m "feat(storage): extension_releases module (upsert/latest/attach/holders)"
```

---

## Task 3: Extension — single-source version + stable extension ID

**Files:**
- Modify: `extension/manifest.config.ts`
- Modify: `extension/package.json` (version stays the single source; bump to `0.1.0` baseline kept)
- Create: `extension/tests/manifest.test.ts`
- Create (outside repo, not committed): the signing keypair

- [ ] **Step 1: Generate the signing keypair (one-time, do not commit the private key)**

Run from the repo root:

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out ~/warsaw-beer-extension-key.pem
openssl rsa -in ~/warsaw-beer-extension-key.pem -pubout -outform DER 2>/dev/null | base64 -w0
```

Copy the single-line base64 output — it is the manifest `key` (the public key; it pins the unpacked extension ID regardless of install path). Keep `~/warsaw-beer-extension-key.pem` private; it is never committed and is only needed if you later sign a `.crx`.

- [ ] **Step 2: Write the failing test**

Create `extension/tests/manifest.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import manifest from '../manifest.config';
import pkg from '../package.json';

describe('manifest', () => {
  it('derives version from package.json (single source of truth)', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('pins a stable extension id via the key field', () => {
    expect(typeof manifest.key).toBe('string');
    expect((manifest.key as string).length).toBeGreaterThan(100);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/manifest.test.ts`
Expected: FAIL — `manifest.version` is the hardcoded `'0.1.0'` only by coincidence; `manifest.key` is undefined (second test fails).

- [ ] **Step 4: Update the manifest to import the version and add the key**

Edit `extension/manifest.config.ts` — replace the hardcoded version and add `key`:

```ts
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Warsaw Beer Overlay',
  description: 'Shows which beers you have already drunk + your rating on craft beer stores.',
  version: pkg.version,
  key: 'PASTE_THE_BASE64_PUBLIC_KEY_FROM_STEP_1',
  permissions: ['storage'],
  host_permissions: ['https://beer-api.ysilvestrov-ai.uk/*'],
  optional_host_permissions: ['https://*/*'],
  options_page: 'src/options/options.html',
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: [
        'https://beerrepublic.eu/*',
        'https://*.beerrepublic.eu/*',
        'https://onemorebeer.pl/*',
        'https://*.onemorebeer.pl/*',
      ],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/manifest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add extension/manifest.config.ts extension/tests/manifest.test.ts
git commit -m "feat(extension): derive manifest version from package.json + pin stable id via key"
```

---

## Task 4: Extension — CHANGELOG + release-notes slicer

**Files:**
- Create: `extension/CHANGELOG.md`
- Create: `extension/src/shared/release-notes.ts`
- Create: `extension/scripts/release-notes.ts`
- Test: `extension/tests/release-notes.test.ts`

- [ ] **Step 1: Create the changelog seed**

Create `extension/CHANGELOG.md`:

```markdown
# Changelog

## [0.1.0] - 2026-06-08

- Initial beta: drunk-status + rating overlay for beerrepublic.eu and onemorebeer.pl.
```

- [ ] **Step 2: Write the failing test**

Create `extension/tests/release-notes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractNotes } from '../src/shared/release-notes';

const CHANGELOG = `# Changelog

## [0.2.0] - 2026-06-09

- Added Bierloods22 adapter.
- Fixed badge flicker on SPA re-render.

## [0.1.0] - 2026-06-08

- Initial beta.
`;

describe('extractNotes', () => {
  it('returns the body of the matching version section, trimmed', () => {
    expect(extractNotes(CHANGELOG, '0.2.0')).toBe(
      '- Added Bierloods22 adapter.\n- Fixed badge flicker on SPA re-render.',
    );
  });

  it('returns the last section when it is the target', () => {
    expect(extractNotes(CHANGELOG, '0.1.0')).toBe('- Initial beta.');
  });

  it('throws when the version section is missing', () => {
    expect(() => extractNotes(CHANGELOG, '9.9.9')).toThrow(/no section for 9\.9\.9/);
  });

  it('throws when the section body is empty', () => {
    expect(() => extractNotes('## [1.0.0] - 2026-01-01\n\n## [0.9.0] - x\n- y', '1.0.0')).toThrow(
      /empty/,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd extension && npx vitest run tests/release-notes.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/release-notes'`.

- [ ] **Step 4: Write the slicer**

Create `extension/src/shared/release-notes.ts`:

```ts
// Extracts the body of a keep-a-changelog section: everything between the
// `## [version] - date` heading and the next `## ` heading (or EOF), trimmed.
export function extractNotes(changelog: string, version: string): string {
  const lines = changelog.split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headRe = new RegExp(`^##\\s*\\[${escaped}\\]`);
  const start = lines.findIndex((l) => headRe.test(l));
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const body = (endRel === -1 ? rest : rest.slice(0, endRel)).join('\n').trim();
  if (!body) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd extension && npx vitest run tests/release-notes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the build script that emits `dist/RELEASE_NOTES.txt`**

Create `extension/scripts/release-notes.ts`:

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractNotes } from '../src/shared/release-notes';

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

const dist = resolve(root, 'dist');
if (!existsSync(dist)) {
  throw new Error('dist/ not found — run `vite build` first (npm run package does this).');
}

const notes = extractNotes(changelog, pkg.version); // throws if missing/empty → fails the build
const out = `Warsaw Beer Overlay v${pkg.version}\n\n${notes}\n`;
writeFileSync(resolve(dist, 'RELEASE_NOTES.txt'), out);
console.log(`Wrote dist/RELEASE_NOTES.txt for v${pkg.version}`);
```

- [ ] **Step 7: Commit**

```bash
git add extension/CHANGELOG.md extension/src/shared/release-notes.ts extension/scripts/release-notes.ts extension/tests/release-notes.test.ts
git commit -m "feat(extension): CHANGELOG + release-notes slicer/build step"
```

---

## Task 5: Extension — versioned zip + package wiring

**Files:**
- Modify: `extension/scripts/zip-dist.py`
- Modify: `extension/package.json` (`package` script)

- [ ] **Step 1: Make the zip name version-aware**

Edit `extension/scripts/zip-dist.py` — replace the fixed `OUT` with a version-derived name read from `package.json`:

```python
import json

with open(os.path.join(EXT_ROOT, "package.json"), encoding="utf-8") as f:
    VERSION = json.load(f)["version"]
OUT = os.path.join(EXT_ROOT, f"warsaw-beer-overlay-{VERSION}.zip")
```

(Place these lines where `OUT = ...` currently is, after `EXT_ROOT`/`DIST` are defined.)

- [ ] **Step 2: Wire the package script to build → notes → zip**

Edit `extension/package.json` `scripts.package`:

```json
"package": "vite build && tsx scripts/release-notes.ts && python3 scripts/zip-dist.py",
```

- [ ] **Step 3: Verify the pipeline end to end**

Run: `cd extension && npm run package`
Expected: builds, prints `Wrote dist/RELEASE_NOTES.txt for v0.1.0`, then `Wrote .../warsaw-beer-overlay-0.1.0.zip (... files ...)`. Confirm `RELEASE_NOTES.txt` is inside the zip:

```bash
cd extension && python3 -c "import zipfile; print('RELEASE_NOTES.txt' in zipfile.ZipFile('warsaw-beer-overlay-0.1.0.zip').namelist())"
```
Expected: `True`.

- [ ] **Step 4: Ignore the built zip**

Add to the repo root `.gitignore` (if not already covered). `RELEASE_NOTES.txt`
lives in `dist/`, which is already ignored, so only the zip needs a new rule:

```
extension/warsaw-beer-overlay-*.zip
```

- [ ] **Step 5: Commit**

```bash
git add extension/scripts/zip-dist.py extension/package.json .gitignore
git commit -m "feat(extension): versioned zip name + package pipeline (build→notes→zip)"
```

---

## Task 6: Release script — write the row into the bot DB

**Files:**
- Create: `scripts/publish-extension-release.ts`
- Modify: `extension/package.json` (`release` script)
- Test: `scripts/publish-extension-release.test.ts`

The script is a thin orchestration around `upsertRelease` (already tested in Task 2). The test covers the metadata-assembly helper; the DB write reuses the tested storage fn.

- [ ] **Step 1: Write the failing test**

Create `scripts/publish-extension-release.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { buildReleaseRow } from './publish-extension-release';

describe('buildReleaseRow', () => {
  it('computes sha256 of the zip and pairs version + notes', () => {
    const zip = Buffer.from('fake-zip-bytes');
    const row = buildReleaseRow({ version: '0.2.0', zip, notes: 'hello\n' });
    expect(row).toEqual({
      version: '0.2.0',
      sha256: createHash('sha256').update(zip).digest('hex'),
      notes: 'hello',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest scripts/publish-extension-release.test.ts -v`
Expected: FAIL — `Cannot find module './publish-extension-release'`.

- [ ] **Step 3: Write the script**

Create `scripts/publish-extension-release.ts`:

```ts
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
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

// Run via `npx tsx scripts/publish-extension-release.ts` from the repo root.
// Reads the freshly built extension artifacts and writes the release row into
// the bot DB (DATABASE_PATH). The table must already exist (the running bot
// has migrated it). The bot fills file_id later when the admin uploads the zip.
function main(): void {
  const root = resolve(__dirname, '..');
  const extDir = resolve(root, 'extension');
  const version = (JSON.parse(readFileSync(resolve(extDir, 'package.json'), 'utf8')) as {
    version: string;
  }).version;
  const zip = readFileSync(resolve(extDir, `warsaw-beer-overlay-${version}.zip`));
  const notes = readFileSync(resolve(extDir, 'dist', 'RELEASE_NOTES.txt'), 'utf8');

  const dbPath = process.env.DATABASE_PATH;
  if (!dbPath) throw new Error('DATABASE_PATH is not set');

  const row = buildReleaseRow({ version, zip, notes });
  const db = openDb(dbPath);
  upsertRelease(db, row);
  db.close();
  console.log(
    `extension_releases ← v${row.version} (sha256 ${row.sha256.slice(0, 12)}…, ${zip.length} bytes) @ ${dbPath}`,
  );
}

// Only run when invoked directly, not when imported by the test.
if (require.main === module) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest scripts/publish-extension-release.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Wire the `release` npm script**

Edit `extension/package.json` `scripts.release`:

```json
"release": "npm run package && cd .. && npx tsx scripts/publish-extension-release.ts",
```

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-extension-release.ts scripts/publish-extension-release.test.ts extension/package.json
git commit -m "feat(release): npm run release writes extension_releases row (version+notes+sha256)"
```

---

## Task 7: Bot — admin publish handler (hash-match → attach file_id)

**Files:**
- Create: `src/bot/commands/extension-release.ts`
- Modify: `src/i18n/types.ts`, `src/i18n/locales/{uk,pl,en}.ts`
- Test: `src/bot/commands/extension-release.test.ts`

This task adds the document handler + the i18n strings + the publish path. The broadcast action handlers come in Task 8 (this task leaves the buttons wired to callbacks defined there — define both action handlers as stubs here so the file compiles, fully implemented in Task 8).

- [ ] **Step 1: Add i18n keys to the type**

In `src/i18n/types.ts`, add to the `Messages` interface (near the `extension` keys):

```ts
  // extension release / distribution
  'extrel.no_match': string;
  'extrel.attached': string;          // {version}, {n}
  'extrel.btn_send': string;
  'extrel.btn_cancel': string;
  'extrel.sending': string;           // {version}
  'extrel.broadcast_done': string;    // {sent}, {failed}
  'extrel.cancelled': string;
  'extrel.new_version': string;       // {version}
  'extrel.how_to_update': string;
  'extension.download': string;       // {version}
```

- [ ] **Step 2: Add the strings to all three locales**

In `src/i18n/locales/uk.ts`:

```ts
  'extrel.no_match':
    'Цей файл не відповідає останньому релізу в таблиці. Спершу зроби `npm run release`, потім надішли саме той zip.',
  'extrel.attached': 'Прикріплено файл до v{version}. Отримають {n} тестер(ів).',
  'extrel.btn_send': '📣 Розіслати',
  'extrel.btn_cancel': 'Скасувати',
  'extrel.sending': 'Розсилаю v{version}…',
  'extrel.broadcast_done': 'Готово. Надіслано {sent}, помилок {failed}.',
  'extrel.cancelled': 'Скасовано, не розіслано.',
  'extrel.new_version': '🔔 Нова версія розширення v{version}',
  'extrel.how_to_update':
    'Як оновити: розпакуй zip поверх тієї ж теки й натисни ↻ на картці розширення в chrome://extensions. Токен і налаштування збережуться.',
  'extension.download': 'Актуальна версія розширення: v{version} (файл нижче).',
```

In `src/i18n/locales/pl.ts`:

```ts
  'extrel.no_match':
    'Ten plik nie odpowiada ostatniemu wydaniu w tabeli. Najpierw uruchom `npm run release`, potem wyślij ten zip.',
  'extrel.attached': 'Dołączono plik do v{version}. Otrzyma {n} testerów.',
  'extrel.btn_send': '📣 Roześlij',
  'extrel.btn_cancel': 'Anuluj',
  'extrel.sending': 'Wysyłam v{version}…',
  'extrel.broadcast_done': 'Gotowe. Wysłano {sent}, błędów {failed}.',
  'extrel.cancelled': 'Anulowano, nie wysłano.',
  'extrel.new_version': '🔔 Nowa wersja rozszerzenia v{version}',
  'extrel.how_to_update':
    'Jak zaktualizować: rozpakuj zip do tego samego folderu i kliknij ↻ na karcie rozszerzenia w chrome://extensions. Token i ustawienia zostaną zachowane.',
  'extension.download': 'Aktualna wersja rozszerzenia: v{version} (plik poniżej).',
```

In `src/i18n/locales/en.ts`:

```ts
  'extrel.no_match':
    'This file does not match the latest release row. Run `npm run release` first, then send that exact zip.',
  'extrel.attached': 'Attached the file to v{version}. {n} tester(s) will receive it.',
  'extrel.btn_send': '📣 Broadcast',
  'extrel.btn_cancel': 'Cancel',
  'extrel.sending': 'Broadcasting v{version}…',
  'extrel.broadcast_done': 'Done. Sent {sent}, failed {failed}.',
  'extrel.cancelled': 'Cancelled, not broadcast.',
  'extrel.new_version': '🔔 New extension version v{version}',
  'extrel.how_to_update':
    'How to update: unzip over the same folder and click ↻ on the extension card in chrome://extensions. Your token and settings are kept.',
  'extension.download': 'Current extension version: v{version} (file below).',
```

- [ ] **Step 3: Write the failing test**

Create `src/bot/commands/extension-release.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertRelease, getReleaseByVersion } from '../../storage/extension_releases';
import { handleReleaseDocument } from './extension-release';

function ctxFor(opts: {
  fromId: number;
  adminId?: string;
  fileName: string;
  bytes: Buffer;
}) {
  const replies: Array<{ text: string; extra?: unknown }> = [];
  const db = openDb(':memory:');
  migrate(db);
  return {
    db,
    replies,
    nextCalled: { v: false },
    ctx: {
      from: { id: opts.fromId },
      message: { document: { file_id: 'FID', file_name: opts.fileName } },
      deps: { db, env: { ADMIN_TELEGRAM_ID: opts.adminId } },
      t: (k: string, p?: Record<string, unknown>) => `${k}:${JSON.stringify(p ?? {})}`,
      telegram: {
        getFileLink: async () => new URL('https://example/file'),
      },
      reply: async (text: string, extra?: unknown) => {
        replies.push({ text, extra });
      },
    },
  };
}

describe('handleReleaseDocument', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('passes through (next) when the sender is not the admin', async () => {
    const h = ctxFor({ fromId: 5, adminId: '999', fileName: 'warsaw-beer-overlay-0.2.0.zip', bytes: Buffer.from('x') });
    let nexted = false;
    await handleReleaseDocument(h.ctx as never, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(h.replies).toHaveLength(0);
  });

  it('passes through (next) for a non-release filename from the admin', async () => {
    const h = ctxFor({ fromId: 7, adminId: '7', fileName: 'untappd-export.zip', bytes: Buffer.from('x') });
    let nexted = false;
    await handleReleaseDocument(h.ctx as never, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
  });

  it('rejects when the uploaded hash matches no latest release', async () => {
    const h = ctxFor({ fromId: 7, adminId: '7', fileName: 'warsaw-beer-overlay-0.2.0.zip', bytes: Buffer.from('zip') });
    upsertRelease(h.db, { version: '0.2.0', sha256: 'DIFFERENT', notes: 'n' });
    global.fetch = (async () => ({ arrayBuffer: async () => Buffer.from('zip') })) as never;
    await handleReleaseDocument(h.ctx as never, async () => {});
    expect(h.replies[0].text).toContain('extrel.no_match');
    expect(getReleaseByVersion(h.db, '0.2.0')!.file_id).toBeNull();
  });

  it('attaches file_id + shows the broadcast keyboard on a hash match', async () => {
    const bytes = Buffer.from('the-real-zip');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const h = ctxFor({ fromId: 7, adminId: '7', fileName: 'warsaw-beer-overlay-0.2.0.zip', bytes });
    upsertRelease(h.db, { version: '0.2.0', sha256: sha, notes: 'n' });
    global.fetch = (async () => ({ arrayBuffer: async () => bytes })) as never;
    await handleReleaseDocument(h.ctx as never, async () => {});
    expect(getReleaseByVersion(h.db, '0.2.0')!.file_id).toBe('FID');
    expect(h.replies[0].text).toContain('extrel.attached');
    expect(h.replies[0].extra).toBeDefined(); // inline keyboard present
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx jest src/bot/commands/extension-release.test.ts -v`
Expected: FAIL — `Cannot find module './extension-release'`.

- [ ] **Step 5: Write the handler + composer (broadcast action stubs filled in Task 8)**

Create `src/bot/commands/extension-release.ts`:

```ts
import { Composer, Markup } from 'telegraf';
import { createHash } from 'node:crypto';
import type { BotContext } from '../index';
import {
  latestRelease,
  attachFileId,
  listExtensionTokenHolders,
} from '../../storage/extension_releases';

const RELEASE_ZIP = /^warsaw-beer-overlay.*\.zip$/i;

export function isAdmin(ctx: BotContext): boolean {
  const id = ctx.deps.env.ADMIN_TELEGRAM_ID;
  return !!id && String(ctx.from?.id) === id;
}

// Exported for unit testing. `next` lets non-release documents fall through to
// the /import document handler (which is registered AFTER this one).
export async function handleReleaseDocument(
  ctx: BotContext & { message: { document: { file_id: string; file_name?: string } } },
  next: () => Promise<void>,
): Promise<void> {
  const doc = ctx.message.document;
  if (!isAdmin(ctx) || !RELEASE_ZIP.test(doc.file_name ?? '')) return next();

  const link = await ctx.telegram.getFileLink(doc.file_id);
  const res = await fetch(link.toString());
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(buf).digest('hex');

  const latest = latestRelease(ctx.deps.db);
  if (!latest || latest.sha256 !== sha256) {
    await ctx.reply(ctx.t('extrel.no_match'));
    return;
  }

  attachFileId(ctx.deps.db, latest.version, doc.file_id, ctx.from!.id);
  const n = listExtensionTokenHolders(ctx.deps.db).length;
  await ctx.reply(
    ctx.t('extrel.attached', { version: latest.version, n }),
    Markup.inlineKeyboard([
      [Markup.button.callback(ctx.t('extrel.btn_send'), `extrel:send:${latest.version}`)],
      [Markup.button.callback(ctx.t('extrel.btn_cancel'), 'extrel:cancel')],
    ]),
  );
}

export const extensionReleaseCommand = new Composer<BotContext>();

extensionReleaseCommand.on('document', (ctx, next) =>
  handleReleaseDocument(ctx as never, next),
);

// Broadcast action handlers are implemented in Task 8.
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/bot/commands/extension-release.test.ts -v`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/extension-release.ts src/bot/commands/extension-release.test.ts src/i18n/types.ts src/i18n/locales
git commit -m "feat(bot): admin extension-release upload handler (hash-match → attach file_id)"
```

---

## Task 8: Bot — broadcast to token holders

**Files:**
- Modify: `src/bot/commands/extension-release.ts`
- Test: `src/bot/commands/extension-release.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `src/bot/commands/extension-release.test.ts`:

```ts
import { broadcastRelease } from './extension-release';
import { attachFileId } from '../../storage/extension_releases';

function seedToken(db: ReturnType<typeof openDb>, id: number, lang?: string) {
  db.prepare('INSERT OR IGNORE INTO user_profiles (telegram_id, language) VALUES (?, ?)').run(id, lang ?? null);
  db.prepare('INSERT INTO api_tokens (token_hash, telegram_id, created_at) VALUES (?, ?, ?)')
    .run(`h-${id}`, id, '2026-06-08T00:00:00Z');
}

describe('broadcastRelease', () => {
  it('sends notes + document to every token holder and counts failures', async () => {
    const db = openDb(':memory:');
    migrate(db);
    upsertRelease(db, { version: '0.2.0', sha256: 's', notes: 'changelog body' });
    attachFileId(db, '0.2.0', 'FID', 1);
    seedToken(db, 1, 'en');
    seedToken(db, 2, 'uk');

    const sentDocs: Array<{ chat: number; fileId: string }> = [];
    const telegram = {
      sendMessage: async (chat: number) => {
        if (chat === 2) throw new Error('blocked');
      },
      sendDocument: async (chat: number, fileId: string) => {
        sentDocs.push({ chat, fileId });
      },
    };

    const result = await broadcastRelease(telegram as never, db, '0.2.0');
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sentDocs).toEqual([{ chat: 1, fileId: 'FID' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/commands/extension-release.test.ts -t broadcastRelease -v`
Expected: FAIL — `broadcastRelease is not a function` / not exported.

- [ ] **Step 3: Implement `broadcastRelease` + the action handlers**

In `src/bot/commands/extension-release.ts`, add imports at the top:

```ts
import type { Telegram } from 'telegraf';
import type { DB } from '../../storage/db';
import { createTranslator } from '../../i18n';
import { getUserLanguage } from '../../storage/user_profiles';
import { getReleaseByVersion } from '../../storage/extension_releases';
```

Add the broadcast function (a blocked/failed recipient is counted, never aborts the loop; notes go as a message, the zip as a separate document so the 1024-char caption cap is never a problem):

```ts
export async function broadcastRelease(
  telegram: Pick<Telegram, 'sendMessage' | 'sendDocument'>,
  db: DB,
  version: string,
): Promise<{ sent: number; failed: number }> {
  const rel = getReleaseByVersion(db, version);
  if (!rel || !rel.file_id) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  for (const id of listExtensionTokenHolders(db)) {
    const t = createTranslator(getUserLanguage(db, id) ?? 'uk');
    const text = `${t('extrel.new_version', { version })}\n\n${rel.notes}\n\n${t('extrel.how_to_update')}`;
    try {
      await telegram.sendMessage(id, text);
      await telegram.sendDocument(id, rel.file_id);
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}
```

Add the action handlers (replace the `// Broadcast action handlers are implemented in Task 8.` comment):

```ts
extensionReleaseCommand.action(/^extrel:send:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx as never)) return;
  const version = ctx.match[1];
  await ctx.editMessageText(ctx.t('extrel.sending', { version }));
  const { sent, failed } = await broadcastRelease(ctx.telegram, ctx.deps.db, version);
  await ctx.reply(ctx.t('extrel.broadcast_done', { sent, failed }));
});

extensionReleaseCommand.action('extrel:cancel', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx as never)) return;
  await ctx.editMessageText(ctx.t('extrel.cancelled'));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/bot/commands/extension-release.test.ts -v`
Expected: PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/extension-release.ts src/bot/commands/extension-release.test.ts
git commit -m "feat(bot): broadcast extension release to token holders (per-locale, fault-tolerant)"
```

---

## Task 9: Bot — `/extension` also serves the latest zip

**Files:**
- Modify: `src/bot/commands/extension.ts`
- Test: `src/bot/commands/extension.test.ts`

This file tests pure helpers (not the Composer), so we extract a testable
helper `latestDeliverableRelease` and assert on it, matching the file's style.

- [ ] **Step 1: Write the failing test**

Add to `src/bot/commands/extension.test.ts`:

```ts
import { upsertRelease, attachFileId } from '../../storage/extension_releases';
import { latestDeliverableRelease } from './extension';

describe('latestDeliverableRelease', () => {
  it('returns file_id + version only once a release is attached', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(latestDeliverableRelease(db)).toBeNull(); // no releases

    upsertRelease(db, { version: '0.3.0', sha256: 's', notes: 'n' });
    expect(latestDeliverableRelease(db)).toBeNull(); // row exists but file_id NULL

    attachFileId(db, '0.3.0', 'FID', 1);
    expect(latestDeliverableRelease(db)).toEqual({ fileId: 'FID', version: '0.3.0' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/bot/commands/extension.test.ts -t latestDeliverableRelease -v`
Expected: FAIL — `latestDeliverableRelease is not exported`.

- [ ] **Step 3: Add the helper and call it from the command**

In `src/bot/commands/extension.ts`, add imports + helper:

```ts
import type { DB } from '../../storage/db';
import { latestRelease } from '../../storage/extension_releases';

// The newest release that has a Telegram file_id attached (i.e. ready to send).
export function latestDeliverableRelease(
  db: DB,
): { fileId: string; version: string } | null {
  const rel = latestRelease(db);
  return rel?.file_id ? { fileId: rel.file_id, version: rel.version } : null;
}
```

In the `extensionCommand.command('extension', ...)` handler, after `await ctx.replyWithHTML(...)`:

```ts
  const delivery = latestDeliverableRelease(ctx.deps.db);
  if (delivery) {
    await ctx.replyWithDocument(delivery.fileId, {
      caption: ctx.t('extension.download', { version: delivery.version }),
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/bot/commands/extension.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/extension.ts src/bot/commands/extension.test.ts
git commit -m "feat(bot): /extension also delivers the latest release zip to new testers"
```

---

## Task 10: Wire the release handler into the bot (before /import)

**Files:**
- Modify: `src/index.ts`

The release `on('document')` handler MUST be registered **before** `importCommand`, because `importCommand.on('document')` consumes every document (and `.zip` is a valid import format). The release handler calls `next()` for anything that isn't an admin release upload, so `/import` still works.

- [ ] **Step 1: Import the composer**

In `src/index.ts`, add near the other command imports:

```ts
import { extensionReleaseCommand } from './bot/commands/extension-release';
```

- [ ] **Step 2: Register it before importCommand**

In the `bot.use(...)` list, place `extensionReleaseCommand` immediately before `importCommand`:

```ts
  bot.use(
    startCommand,
    linkCommand,
    extensionReleaseCommand,
    importCommand,
    newbeersCommand,
    // …unchanged…
```

- [ ] **Step 3: Verify ordering by build + full test run**

Run: `npm run build && npm test`
Expected: tsc clean; all tests pass (existing import tests still green — proving the release handler falls through for non-release documents).

- [ ] **Step 4: Manual smoke (optional, requires a bot token + admin id)**

With `ADMIN_TELEGRAM_ID` set, send the bot a `warsaw-beer-overlay-*.zip` whose row is NOT yet in the DB → expect the `extrel.no_match` reply; send a non-matching `.csv`/`.json` → expect normal `/import` behavior.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(bot): register extension-release handler ahead of /import"
```

---

## Task 11: Documentation + spec.md

**Files:**
- Modify: `docs/extension-install-uk.md`
- Create: `docs/extension-release.md`
- Modify: `spec.md`

- [ ] **Step 1: Rewrite install Part 2 to use the bot-delivered zip**

In `docs/extension-install-uk.md`, replace Part 2 ("Встановлення") build-from-source steps with:

```markdown
## Частина 2. Встановлення розширення

Тепер розширення видає сам бот — збирати з сорсів не треба.

### 2.1. Отримати zip

Надішли `/extension`. Бот пришле токен **і файл** `warsaw-beer-overlay-<версія>.zip`.
Збережи його й **розпакуй у постійну теку** (напр. `~/warsaw-beer-overlay/`) — саме її
завантажуватимеш у браузер, і саме поверх неї оновлюватимеш.

### 2.2. Завантажити в браузер (Chrome)

1. `chrome://extensions` → увімкни **Developer mode**.
2. **Load unpacked** → обери теку з розпакованого zip.

### 2.3. Оновлення

Коли вийде нова версія, бот пришле новий zip. **Розпакуй його поверх тієї ж теки**
(з заміною) і натисни **↻** на картці розширення в `chrome://extensions`. Токен і
налаштування збережуться (ID розширення зафіксовано).
```

Keep the old build-from-source steps as an appendix titled "Для розробників: збірка з сорсів".

- [ ] **Step 2: Write the release runbook**

Create `docs/extension-release.md`:

```markdown
# Випуск нової версії розширення (для maintainer)

1. Онови код розширення в `extension/`.
2. Підніми версію в `extension/package.json` (єдине місце) і додай секцію
   `## [x.y.z] - YYYY-MM-DD` у `extension/CHANGELOG.md`.
3. Збери і запиши реліз у БД бота:
   ```bash
   cd extension
   DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db npm run release
   ```
   `npm run release` = build → `RELEASE_NOTES.txt` → `warsaw-beer-overlay-<version>.zip`
   → запис рядка `extension_releases` (version, notes, sha256). Якщо для версії
   немає секції в CHANGELOG — білд впаде (це навмисно).
   > Запис іде в живу БД бота. Якщо файл БД належить сервісному юзеру, запусти
   > крок запису під ним: `sudo -u warsaw-beer-bot bash -lc '... npm run release'`.
4. Перешли боту в приваті файл `extension/warsaw-beer-overlay-<version>.zip`.
   Бот звірить sha256 з останнім рядком і відповість «Прикріплено… 📣 Розіслати / Скасувати».
5. Натисни **📣 Розіслати** — бот розішле zip усім власникам токенів.
```

- [ ] **Step 3: Update spec.md (OpenSpec single source of truth)**

In `spec.md`:
- Under **§3 Data Models**, insert a new subsection right after **§3.11 `api_tokens`** as `### 3.12 extension_releases — релізи браузерного розширення (v9)` describing the columns (version PK, sha256, notes from the build; file_id/attached_by from the bot). Renumber the subsequent subsections: `schema_version` 3.12→3.13, `Зв'язки (ER)` 3.13→3.14, `Історія міграцій` 3.14→3.15.
- In **Історія міграцій** (now §3.15), add the line: `v9 — extension_releases`.
- Under **§6 Browser Extension Client**, add a subsection **«Дистрибуція бета-версій»** summarizing: build writes version+notes+sha256 to `extension_releases`; admin forwards the zip; bot hash-matches and captures the Telegram `file_id`; broadcast to all `api_tokens` holders; `/extension` also delivers the latest zip. Reference `docs/extension-release.md`.

- [ ] **Step 4: Verify nothing else references the removed build-only flow**

Run: `grep -rn "npm run build" docs/extension-install-uk.md`
Expected: only inside the "Для розробників" appendix.

- [ ] **Step 5: Commit**

```bash
git add docs/extension-install-uk.md docs/extension-release.md spec.md
git commit -m "docs: bot-delivered extension install/update + release runbook + spec v9"
```

---

## Final verification

- [ ] **Run the whole suite + build**

Run: `npm run build && npm test && (cd extension && npm test)`
Expected: tsc clean; all bot (Jest) and extension (Vitest) tests pass.

- [ ] **Dry-run the release pipeline locally (against a throwaway DB)**

```bash
cd extension && npm run package
DATABASE_PATH=/tmp/rel-test.db node -e "require('better-sqlite3')('/tmp/rel-test.db').exec(require('fs').readFileSync('/dev/stdin','utf8'))" <<'SQL'
CREATE TABLE extension_releases (version TEXT PRIMARY KEY, sha256 TEXT NOT NULL, notes TEXT NOT NULL, file_id TEXT, published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, attached_by INTEGER);
SQL
cd .. && DATABASE_PATH=/tmp/rel-test.db npx tsx scripts/publish-extension-release.ts
```
Expected: prints `extension_releases ← v0.1.0 (sha256 …, … bytes) @ /tmp/rel-test.db`.

- [ ] **Follow the PR review loop** (per project convention): open PR → wait for AI review → assess + address comments.

---

## Self-review notes (coverage map)

- Spec "build is single source / writes table" → Tasks 4, 5, 6.
- Spec "bot only hash-matches, no zip parsing" → Task 7 (`handleReleaseDocument`).
- Spec "file_id captured for re-send" → Task 7 (`attachFileId`) + Task 8 (`sendDocument`).
- Spec "two-step broadcast with confirmation" → Task 7 keyboard + Task 8 actions.
- Spec "broadcast to api_tokens holders, fault-tolerant, per-locale" → Task 8.
- Spec "/extension serves latest zip to new testers" → Task 9.
- Spec "stable extension ID via key" → Task 3.
- Spec "single-source version" → Task 3.
- Spec "CHANGELOG → RELEASE_NOTES, build fails if missing" → Task 4.
- Spec "migration v9 extension_releases" → Task 1.
- Spec error-handling rows (non-admin/non-zip → next; hash mismatch → reject; build fails on missing CHANGELOG; recipient failure counted) → Tasks 7, 4, 8.
- Spec docs (install update + runbook) + CLAUDE.md spec.md rule → Task 11.
- Ordering hazard vs `/import` `on('document')` → Task 10.
