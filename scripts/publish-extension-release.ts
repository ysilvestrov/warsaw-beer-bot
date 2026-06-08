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
