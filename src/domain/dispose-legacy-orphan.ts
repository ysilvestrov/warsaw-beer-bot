import { isDeepStrictEqual } from 'node:util';
import type { DB } from '../storage/db';
import { cardAbv, cardText } from './card-text';
import {
  closeLegacyDisposition, findActiveDispositionForBeer, findActiveDispositionForCard,
  insertLegacyDisposition, type ActiveLegacyDisposition,
} from '../storage/legacy-orphan-dispositions';

export interface LegacyDispositionInput {
  beerId: number;
  issueNumber: number;
  cardBrewery: string;
  cardName: string;
  cardAbv: number | null;
  reason: string;
  evidenceUrl: string;
  operator: string;
  at: string;
}

export interface LegacyReopenInput {
  episodeId: number;
  reason: string;
  evidenceUrl: string;
  operator: string;
  at: string;
}

interface OrphanRecord {
  id: number;
  brewery: string;
  name: string;
  storedAbv: number | null;
  untappdId: number | null;
  lookupAt: string | null;
  lookupCount: number;
  rearmCount: number;
}

interface FailureRecord {
  issueNumber: number | null;
  brewery: string;
  name: string;
  sourceUrl: string;
  reviewClass: string | null;
  outcome: string;
  failCount: number;
  lastAt: string;
  retiredAt: string | null;
  unrescuedAt: string | null;
  unlockedAt: string | null;
}

interface ReferenceCounts {
  matchLinks: number;
  checkins: number;
  untappdHad: number;
}

export interface LegacyDispositionPreview {
  orphan: OrphanRecord;
  failure: FailureRecord;
  key: { breweryText: string; nameText: string; abvKey: string };
  referenceCounts: ReferenceCounts;
}

export interface LegacyReopenPreview {
  episode: ActiveLegacyDisposition;
  orphan: OrphanRecord | null;
  failure: FailureRecord | null;
}

function validId(id: number): boolean {
  return Number.isSafeInteger(id) && id > 0;
}

function validateDecision(reason: string, evidenceUrl: string, operator: string, at: string): void {
  if (!reason.trim() || !operator.trim()) throw new Error('operator and reason are required');
  let url: URL;
  try { url = new URL(evidenceUrl); } catch { throw new Error('evidence URL is invalid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('evidence URL must use HTTP(S)');
  }
  if (!Number.isFinite(Date.parse(at)) || !at.endsWith('Z')) {
    throw new Error('decision time must be a UTC date');
  }
}

function validateDisposition(input: LegacyDispositionInput): void {
  if (!validId(input.beerId) || !validId(input.issueNumber)) {
    throw new Error('beer ID and issue number must be positive integers');
  }
  if (!input.cardBrewery.trim() || !input.cardName.trim()) {
    throw new Error('historical card needs brewery and name');
  }
  if (input.cardAbv !== null && (!Number.isFinite(input.cardAbv)
    || input.cardAbv < 0 || input.cardAbv > 100)) {
    throw new Error('historical card ABV must be between 0 and 100 or explicitly absent');
  }
  validateDecision(input.reason, input.evidenceUrl, input.operator, input.at);
}

function validateReopen(input: LegacyReopenInput): void {
  if (!validId(input.episodeId)) throw new Error('episode ID must be a positive integer');
  validateDecision(input.reason, input.evidenceUrl, input.operator, input.at);
}

function readOrphan(db: DB, beerId: number): OrphanRecord | null {
  const row = db.prepare(`SELECT id, brewery, name, abv, untappd_id,
      untappd_lookup_at, untappd_lookup_count, rearm_count FROM beers WHERE id = ?`)
    .get(beerId) as {
      id: number; brewery: string; name: string; abv: number | null;
      untappd_id: number | null; untappd_lookup_at: string | null;
      untappd_lookup_count: number; rearm_count: number;
    } | undefined;
  return row ? {
    id: row.id, brewery: row.brewery, name: row.name, storedAbv: row.abv,
    untappdId: row.untappd_id, lookupAt: row.untappd_lookup_at,
    lookupCount: row.untappd_lookup_count, rearmCount: row.rearm_count,
  } : null;
}

function readFailure(db: DB, beerId: number): FailureRecord | null {
  const row = db.prepare(`SELECT issue_number, brewery, name, source_url, review_class,
      outcome, fail_count, last_at, retired_at, unrescued_at, unlocked_at
      FROM enrich_failures WHERE beer_id = ?`).get(beerId) as {
    issue_number: number | null; brewery: string; name: string; source_url: string;
    review_class: string | null; outcome: string; fail_count: number;
    last_at: string; retired_at: string | null; unrescued_at: string | null;
    unlocked_at: string | null;
  } | undefined;
  return row ? {
    issueNumber: row.issue_number, brewery: row.brewery, name: row.name,
    sourceUrl: row.source_url, reviewClass: row.review_class, outcome: row.outcome,
    failCount: row.fail_count, lastAt: row.last_at, retiredAt: row.retired_at,
    unrescuedAt: row.unrescued_at, unlockedAt: row.unlocked_at,
  } : null;
}

function countRefs(db: DB, table: 'match_links' | 'checkins' | 'untappd_had', beerId: number): number {
  const field = table === 'match_links' ? 'untappd_beer_id' : 'beer_id';
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${field} = ?`)
    .get(beerId) as { n: number }).n;
}

function referenceCounts(db: DB, beerId: number): ReferenceCounts {
  return {
    matchLinks: countRefs(db, 'match_links', beerId),
    checkins: countRefs(db, 'checkins', beerId),
    untappdHad: countRefs(db, 'untappd_had', beerId),
  };
}

export function previewLegacyOrphanDisposition(
  db: DB, input: LegacyDispositionInput,
): LegacyDispositionPreview {
  validateDisposition(input);
  const orphan = readOrphan(db, input.beerId);
  if (!orphan || orphan.untappdId !== null) throw new Error('beer is missing or already linked');
  const failure = readFailure(db, input.beerId);
  if (!failure || failure.issueNumber !== input.issueNumber || failure.outcome !== 'not_found'
    || failure.retiredAt !== null) {
    throw new Error('orphan failure is missing, retired, or belongs to another issue');
  }
  const key = {
    breweryText: cardText(input.cardBrewery), nameText: cardText(input.cardName),
    abvKey: cardAbv(input.cardAbv),
  };
  if (key.breweryText !== cardText(orphan.brewery)
    || key.nameText !== cardText(orphan.name)
    || key.breweryText !== cardText(failure.brewery)
    || key.nameText !== cardText(failure.name)) {
    throw new Error('historical card differs from orphan/failure');
  }
  if (findActiveDispositionForBeer(db, input.beerId)
    || findActiveDispositionForCard(db, input.cardBrewery, input.cardName, input.cardAbv)) {
    throw new Error('active legacy disposition conflicts with this card or row');
  }
  if (db.prepare(`SELECT 1 FROM beer_aliases
      WHERE brewery_text = ? AND name_text = ? AND abv_key = ?`)
    .get(key.breweryText, key.nameText, key.abvKey)) {
    throw new Error('historical card already has an alias');
  }
  if (db.prepare('SELECT 1 FROM legacy_card_repairs WHERE orphan_beer_id = ?')
    .get(input.beerId)) {
    throw new Error('orphan already has a legacy card repair');
  }
  return { orphan, failure, key, referenceCounts: referenceCounts(db, input.beerId) };
}

function sameActiveAction(existing: ActiveLegacyDisposition, input: LegacyDispositionInput): boolean {
  return existing.beerId === input.beerId && existing.issueNumber === input.issueNumber
    && existing.cardBrewery === input.cardBrewery && existing.cardName === input.cardName
    && existing.cardAbv === input.cardAbv
    && existing.breweryText === cardText(input.cardBrewery)
    && existing.nameText === cardText(input.cardName)
    && existing.abvKey === cardAbv(input.cardAbv)
    && existing.reason === input.reason
    && existing.evidenceUrl === input.evidenceUrl && existing.operator === input.operator;
}

export function applyLegacyOrphanDisposition(
  db: DB, input: LegacyDispositionInput, expected?: LegacyDispositionPreview,
): { episodeId: number; kind: 'applied' | 'noop' } {
  validateDisposition(input);
  return db.transaction(() => {
    const existing = findActiveDispositionForBeer(db, input.beerId);
    if (existing) {
      if (sameActiveAction(existing, input)) return { episodeId: existing.id, kind: 'noop' as const };
      throw new Error('active disposition audit conflicts with this application');
    }
    if (!expected) throw new Error('fresh preview is required before applying a new disposition');
    const current = previewLegacyOrphanDisposition(db, input);
    if (!isDeepStrictEqual(current, expected)) throw new Error('stale disposition preview');
    const episodeId = insertLegacyDisposition(db, {
      beerId: input.beerId, issueNumber: input.issueNumber,
      cardBrewery: input.cardBrewery, cardName: input.cardName, cardAbv: input.cardAbv,
      ...current.key, failureSourceUrl: current.failure.sourceUrl,
      reason: input.reason, evidenceUrl: input.evidenceUrl, operator: input.operator,
      inactiveAt: input.at,
    });
    return { episodeId, kind: 'applied' as const };
  })();
}

interface EpisodeRow {
  id: number;
  beer_id: number;
  issue_number: number;
  card_brewery: string;
  card_name: string;
  card_abv: number | null;
  brewery_text: string;
  name_text: string;
  abv_key: string;
  failure_source_url: string;
  reason: string;
  evidence_url: string;
  operator: string;
  inactive_at: string;
  reopened_at: string | null;
  reopening_reason: string | null;
  reopening_evidence_url: string | null;
  reopening_operator: string | null;
}

function readEpisode(db: DB, id: number): EpisodeRow | null {
  return (db.prepare('SELECT * FROM legacy_orphan_dispositions WHERE id = ?')
    .get(id) as EpisodeRow | undefined) ?? null;
}

export function previewLegacyOrphanReopen(db: DB, input: LegacyReopenInput): LegacyReopenPreview {
  validateReopen(input);
  const episode = readEpisode(db, input.episodeId);
  if (!episode || episode.reopened_at !== null) throw new Error('active episode is missing');
  const active = findActiveDispositionForBeer(db, episode.beer_id);
  if (!active || active.id !== episode.id) throw new Error('active episode changed');
  return {
    episode: active,
    orphan: readOrphan(db, episode.beer_id),
    failure: readFailure(db, episode.beer_id),
  };
}

export function applyLegacyOrphanReopen(
  db: DB, input: LegacyReopenInput, expected?: LegacyReopenPreview,
): { episodeId: number; kind: 'reopened' | 'noop' } {
  validateReopen(input);
  return db.transaction(() => {
    const episode = readEpisode(db, input.episodeId);
    if (!episode) throw new Error('episode is missing');
    if (episode.reopened_at !== null) {
      if (episode.reopening_reason === input.reason
        && episode.reopening_evidence_url === input.evidenceUrl
        && episode.reopening_operator === input.operator) {
        return { episodeId: input.episodeId, kind: 'noop' as const };
      }
      throw new Error('reopen audit conflicts with this application');
    }
    if (!expected) throw new Error('fresh preview is required before reopening');
    const current = previewLegacyOrphanReopen(db, input);
    if (!isDeepStrictEqual(current, expected)) throw new Error('stale reopen preview');
    if (!closeLegacyDisposition(db, input.episodeId, {
      reopenedAt: input.at, reopeningReason: input.reason,
      reopeningEvidenceUrl: input.evidenceUrl, reopeningOperator: input.operator,
    })) throw new Error('episode is no longer active');
    return { episodeId: input.episodeId, kind: 'reopened' as const };
  })();
}
