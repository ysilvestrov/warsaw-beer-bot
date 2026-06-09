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
