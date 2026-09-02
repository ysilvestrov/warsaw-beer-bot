import fs from 'fs';
import type { DB } from './db';
import { getJobState } from './job_state';
import { getUsageForDate } from './api_usage';
import { orphanNotOnTapPredicate } from './beers';
import { warsawDateAndHour, previousDate } from '../domain/warsaw-time';

export interface StatusMetrics {
  lastScrapeHoursAgo: number | null;
  pubsScraped24h: number;
  beersTotal: number;
  beersMatched: number;
  orphansPending: number;
  // #368/#486: розмір черги relay-дренажу — orphan'и, яких enrich-крон бачить ЛИШЕ через
  // relay-пул (не на крані зараз), за винятком not_a_beer/retired. Той самий предикат, що
  // й у listRelayLookupCandidates, мінус backoff. Назва «offCron» була неправдою: цей
  // лічильник ніколи не міряв cron-недосяжність — недосяжних за побудовою партиції немає
  // (замок і вичерпаний backoff — окремі, свідомі фільтри поверх неї).
  orphansRelayQueue: number;
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
  extMatchRequests: number;   // total /match requests, previous Warsaw day
  extMatchAnon: number;       // anonymous subset
  extMatchBeers: number;      // sum of beers, previous Warsaw day
  // #377 part B. Two of these can refute the design that produced them:
  // `sealUnidentifiableReobserved` at 0 means the rows are formally back in a pool but
  // the cron never reaches them — the mechanism is dead. A high re-observed count with
  // a FLAT `sealUnidentifiable` means it runs and buys nothing. Counting seals *lifted*
  // is impossible after the fact: the auto-unseal in recordEnrichFailure nulls
  // review_class AND reviewed_at, erasing the evidence the row was ever sealed.
  sealUnidentifiable: number;
  sealUnidentifiableReobserved: number;
  sealNotABeer: number;
  sealNotABeer7d: number;
  // retired_at claims "a shipped fix resolved this". If it had, clearEnrichFailure
  // would have deleted the row outright — so a retired row that is still an orphan is
  // an assertion falsified by its own existence. Growth means retired_at is being
  // written as blindly as wontfix was.
  sealRetiredFalsified: number;
  // #421. Each falsifies a premise of the fix-keyed lock. `lockedRows` is the quota the
  // lock is saving; a number that only grows means fixes are not shipping, which is a
  // backlog signal rather than a mechanism failure. `unlocked7d` at zero across a week in
  // which issues closed means the mechanism is DEAD — the same shape as part B's signal.
  // `verdictsOutlived7d` near the unlock count means our fixes never cover the rows that
  // motivated them, i.e. the lock buys reversibility with nothing behind it.
  lockedRows: number;
  unlocked7d: number;
  verdictsOutlived7d: number;
  // #558. `unrescuedRows` робить новий стан видимим, а не мовчазним. `unlockedUnadjudicated7d`
  // — міра ДОТРИМАННЯ правила: рядок, який розімкнули без вердикту адюдикації і який досі
  // сирота. Правило застосовують — цифра мала; тихо пропускають — росте. Обидві дешеві й
  // не потребують знімка стану: порівнювати outcome+candidates_count до/після перезарядки
  // було б неможливо без двох додаткових колонок, бо recordEnrichFailure їх перезаписує.
  unrescuedRows: number;
  unlockedUnadjudicated7d: number;
}

export function collectStatus(db: DB, now: Date): StatusMetrics {
  const nowMs = now.getTime();
  const cutoff24 = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const cutoff7d = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString();

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

  const usage = getUsageForDate(db, previousDate(warsawDateAndHour(now).date));

  return {
    lastScrapeHoursAgo,
    pubsScraped24h: count('SELECT COUNT(DISTINCT pub_id) AS c FROM tap_snapshots WHERE snapshot_at >= ?', [cutoff24]),
    beersTotal: count('SELECT COUNT(*) AS c FROM beers'),
    beersMatched: count('SELECT COUNT(*) AS c FROM beers WHERE untappd_id IS NOT NULL'),
    orphansPending: count(
      `SELECT COUNT(*) AS c FROM beers b
        WHERE b.untappd_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM enrich_failures ef
            WHERE ef.beer_id = b.id AND ef.retired_at IS NOT NULL
          )`,
    ),
    orphansRelayQueue: count(
      `SELECT COUNT(*) AS c FROM beers b WHERE ${orphanNotOnTapPredicate}`,
    ),
    sealUnidentifiable: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.review_class = 'unidentifiable' AND b.untappd_id IS NULL`,
    ),
    // "Looked up since the verdict was written" — the only observable proof that
    // un-sealing actually put the row back in front of the cron.
    sealUnidentifiableReobserved: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.review_class = 'unidentifiable' AND b.untappd_id IS NULL
          AND ef.reviewed_at IS NOT NULL AND b.untappd_lookup_at > ef.reviewed_at`,
    ),
    // Deliberately NOT joined to beers: this is a debt counter about the ingest filter,
    // not about orphan reachability, so a row that later acquired a bid still counts.
    sealNotABeer: count(
      `SELECT COUNT(*) AS c FROM enrich_failures WHERE review_class = 'not_a_beer'`,
    ),
    sealNotABeer7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures
        WHERE review_class = 'not_a_beer' AND reviewed_at > ?`,
      [cutoff7d],
    ),
    // #421 audit — see the StatusMetrics comment for what each number can refute. The
    // retired_at exclusion mirrors listLockedRows: a retired row keeps its class for audit
    // but is held out of the pools by retired_at, so counting it here would overstate the
    // quota the lock saves and hide the retired-orphan debt sealRetiredFalsified reports.
    lockedRows: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.review_class IN ('matcher_bug','parser_bug')
          AND ef.issue_number IS NOT NULL AND ef.unlocked_at IS NULL
          AND ef.retired_at IS NULL
          AND b.untappd_id IS NULL`,
    ),
    // Beat 1 firing. Counts only rows still IN FLIGHT: beat 2 clears unlocked_at, so a row
    // that settles within the same week leaves this count and appears in the next one. The
    // two numbers partition the week's unlocks between "still being tested" and "fix
    // disproved" — a row that matched left the table entirely (clearEnrichFailure).
    unlocked7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures WHERE unlocked_at >= ?`,
      [cutoff7d],
    ),
    // Beat 2 firing. It cannot be counted directly — beat 2 nulls the very columns that
    // would prove it fired — so this reads the residue it deliberately leaves: issue_number
    // survives, so an untriaged row still naming an issue is one whose fix was tested and
    // did not cover it. Slight overcount by construction (the 0<->>0 clause can also clear
    // a verdict that carried an issue); accepted, because both readings mean the same
    // thing — a shipped fix did not settle this row.
    verdictsOutlived7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures
        WHERE review_class IS NULL AND issue_number IS NOT NULL AND last_at >= ?`,
      [cutoff7d],
    ),
    sealRetiredFalsified: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.retired_at IS NOT NULL AND b.untappd_id IS NULL`,
    ),
    unrescuedRows: count(
      'SELECT COUNT(*) AS c FROM enrich_failures WHERE unrescued_at IS NOT NULL',
    ),
    unlockedUnadjudicated7d: count(
      `SELECT COUNT(*) AS c FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.unlocked_at >= ? AND ef.unrescued_at IS NULL AND b.untappd_id IS NULL`,
      [cutoff7d],
    ),
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
    extMatchRequests: usage.anonRequests + usage.authedRequests,
    extMatchAnon: usage.anonRequests,
    extMatchBeers: usage.beers,
  };
}
