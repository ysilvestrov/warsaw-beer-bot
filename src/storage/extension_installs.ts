import { randomUUID } from 'crypto';
import type { DB } from './db';

// A raw install token is this prefix + 64 hex chars. The prefix tells the auth layer which table to
// look in, and tells a person who pasted it into the wrong field what it is (spec #923 §1.1).
export const INSTALL_TOKEN_PREFIX = 'wbi_';

// Global ceiling on new installs per Warsaw day (spec #923 §2.1). Counted in
// install_registrations_daily, which deleting an install never decrements.
export const REGISTRATIONS_PER_DAY = 2000;

export type RegisterOutcome = { kind: 'ok'; installId: string } | { kind: 'capped' };

/**
 * Registers an install, or refuses it at the daily cap. One IMMEDIATE transaction: the cap read and
 * the increment cannot interleave with another registration. A refusal is counted in `rejected`,
 * so the digest can show how often the cap was hit (#929).
 */
export function registerInstall(
  db: DB,
  args: { date: string; at: string; version: string; tokenHash: string },
): RegisterOutcome {
  return db.transaction((): RegisterOutcome => {
    const row = db
      .prepare('SELECT registrations FROM install_registrations_daily WHERE date = ?')
      .get(args.date) as { registrations: number } | undefined;
    if ((row?.registrations ?? 0) >= REGISTRATIONS_PER_DAY) {
      db.prepare(
        `INSERT INTO install_registrations_daily (date, rejected) VALUES (?, 1)
         ON CONFLICT(date) DO UPDATE SET rejected = rejected + 1`,
      ).run(args.date);
      return { kind: 'capped' };
    }
    const installId = randomUUID();
    db.prepare(
      `INSERT INTO extension_installs (install_id, token_hash, created_at, last_seen_date, ext_version)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(installId, args.tokenHash, args.at, args.date, args.version);
    db.prepare(
      `INSERT INTO install_registrations_daily (date, registrations) VALUES (?, 1)
       ON CONFLICT(date) DO UPDATE SET registrations = registrations + 1`,
    ).run(args.date);
    return { kind: 'ok', installId };
  }).immediate();
}

export interface InstallRow {
  installId: string;
  lastSeenDate: string;
  extVersion: string | null;
}

export function findInstallByHash(db: DB, tokenHash: string): InstallRow | null {
  const row = db
    .prepare('SELECT install_id, last_seen_date, ext_version FROM extension_installs WHERE token_hash = ?')
    .get(tokenHash) as { install_id: string; last_seen_date: string; ext_version: string | null } | undefined;
  return row ? { installId: row.install_id, lastSeenDate: row.last_seen_date, extVersion: row.ext_version } : null;
}

/**
 * Records that an install was seen today with this version. Writes only when the date or the
 * version changed, so an install costs one write a day, not one per request. Returns whether a
 * row was written.
 */
export function touchInstall(db: DB, install: InstallRow, args: { date: string; version?: string }): boolean {
  const version = args.version ?? install.extVersion;
  if (install.lastSeenDate === args.date && version === install.extVersion) return false;
  db.prepare('UPDATE extension_installs SET last_seen_date = ?, ext_version = ? WHERE install_id = ?')
    .run(args.date, version, install.installId);
  return true;
}

/** Deletes an install and (by cascade) its usage rows. The registration counter is left as it is. */
export function deleteInstall(db: DB, installId: string): boolean {
  return db.prepare('DELETE FROM extension_installs WHERE install_id = ?').run(installId).changes === 1;
}
