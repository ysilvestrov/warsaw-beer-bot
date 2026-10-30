import type { DB } from './db';

export interface InstallDayStats {
  /** Distinct installs with any counted request on the date — installs, not people (spec #923 claim table). */
  active: number;
  misses: number;
  enrichLinks: number;
  /** Registrations accepted on the date; includes installs deleted the same day. */
  registrations: number;
  registrationsRejected: number;
  /** Distinct installs refused at least once at the daily enrich limit. */
  enrichCapped: number;
}

// The daily digest's two install lines (spec #923 §2.6), for one Warsaw date.
export function installDayStats(db: DB, date: string): InstallDayStats {
  const usage = db.prepare(`
    SELECT COUNT(DISTINCT install_id) AS active,
           COALESCE(SUM(match_misses), 0) AS misses,
           COALESCE(SUM(enrich_links), 0) AS enrichLinks,
           COUNT(DISTINCT CASE WHEN enrich_rejected > 0 THEN install_id END) AS enrichCapped
      FROM install_usage_daily WHERE date = ?
  `).get(date) as { active: number; misses: number; enrichLinks: number; enrichCapped: number };
  const reg = db.prepare('SELECT registrations, rejected FROM install_registrations_daily WHERE date = ?')
    .get(date) as { registrations: number; rejected: number } | undefined;
  return {
    ...usage,
    registrations: reg?.registrations ?? 0,
    registrationsRejected: reg?.rejected ?? 0,
  };
}
