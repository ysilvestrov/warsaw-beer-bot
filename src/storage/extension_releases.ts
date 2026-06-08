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
