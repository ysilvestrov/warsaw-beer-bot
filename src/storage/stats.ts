import fs from 'fs';
import type { DB } from './db';
import { getJobState } from './job_state';

export interface StatusMetrics {
  lastScrapeHoursAgo: number | null;
  pubsScraped24h: number;
  beersTotal: number;
  beersMatched: number;
  orphansPending: number;
  ratingsMissing: number;
  snapshots: number;
  taps: number;
  dbSizeMb: number | null;
  usersTotal: number;
  usersLinked: number;
  onTapDistinct: number;
  onTapPubs: number;
  newOnTap24h: number;
  enrichMatched24h: number;
  enrichFailures24h: number;
  untappdSearchHealthy: boolean;
}

export function collectStatus(db: DB, now: Date): StatusMetrics {
  const nowMs = now.getTime();
  const cutoff24 = new Date(nowMs - 24 * 3600 * 1000).toISOString();

  const count = (sql: string, params: unknown[] = []): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  const canaryRaw = getJobState(db, 'untappd_search_canary');
  const canaryOk = canaryRaw ? (JSON.parse(canaryRaw) as { ok: boolean }).ok : true;
  const circuitOpenUntil = getJobState(db, 'untappd_circuit_open_until');
  const circuitOpen = circuitOpenUntil != null && Date.parse(circuitOpenUntil) > nowMs;

  const maxAt = (db.prepare('SELECT MAX(snapshot_at) AS m FROM tap_snapshots').get() as { m: string | null }).m;
  const lastScrapeHoursAgo = maxAt === null ? null : (nowMs - Date.parse(maxAt)) / 3600000;

  const latestCte = `
    WITH latest AS (
      SELECT s.id AS id, s.pub_id AS pub_id FROM tap_snapshots s
      INNER JOIN (SELECT pub_id, MAX(snapshot_at) AS m FROM tap_snapshots GROUP BY pub_id) x
        ON x.pub_id = s.pub_id AND x.m = s.snapshot_at
    )`;

  let dbSizeMb: number | null = null;
  if (db.name && db.name !== ':memory:') {
    try { dbSizeMb = Math.round(fs.statSync(db.name).size / 1e5) / 10; } catch { dbSizeMb = null; }
  }

  return {
    lastScrapeHoursAgo,
    pubsScraped24h: count('SELECT COUNT(DISTINCT pub_id) AS c FROM tap_snapshots WHERE snapshot_at >= ?', [cutoff24]),
    beersTotal: count('SELECT COUNT(*) AS c FROM beers'),
    beersMatched: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL'),
    orphansPending: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NULL'),
    ratingsMissing: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL AND rating_global IS NULL'),
    snapshots: count('SELECT COUNT(*) AS c FROM tap_snapshots'),
    taps: count('SELECT COUNT(*) AS c FROM taps'),
    dbSizeMb,
    usersTotal: count('SELECT COUNT(*) AS c FROM user_profiles'),
    usersLinked: count('SELECT COUNT(*) AS c FROM user_profiles WHERE untappd_username IS NOT NULL'),
    onTapDistinct: count(`${latestCte} SELECT COUNT(DISTINCT t.beer_ref) AS c FROM taps t WHERE t.snapshot_id IN (SELECT id FROM latest)`),
    onTapPubs: count(`${latestCte} SELECT COUNT(DISTINCT l.pub_id) AS c FROM latest l WHERE l.id IN (SELECT snapshot_id FROM taps)`),
    newOnTap24h: count(
      `SELECT COUNT(*) AS c FROM (
         SELECT DISTINCT t.beer_ref FROM taps t JOIN tap_snapshots s ON s.id = t.snapshot_id
         WHERE s.snapshot_at >= ?
           AND t.beer_ref NOT IN (
             SELECT t2.beer_ref FROM taps t2 JOIN tap_snapshots s2 ON s2.id = t2.snapshot_id
             WHERE s2.snapshot_at < ?
           )
       )`, [cutoff24, cutoff24]),
    enrichMatched24h: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL AND untappd_lookup_at >= ?', [cutoff24]),
    enrichFailures24h: count('SELECT COUNT(*) AS c FROM enrich_failures WHERE last_at >= ?', [cutoff24]),
    untappdSearchHealthy: canaryOk && !circuitOpen,
  };
}
