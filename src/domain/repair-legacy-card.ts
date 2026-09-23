import type { DB } from '../storage/db';
import type { HydratedBeer } from '../sources/untappd/search';
import { cardAbv, cardText } from './card-text';
import { normalizeBrewery, normalizeName } from './normalize';
import { findAliasTarget, mergeIntoCanonical } from '../storage/beers';
import { bumpCatalogVersion } from '../storage/catalog-version';
import { findActiveDispositionForBeer } from '../storage/legacy-orphan-dispositions';

export interface LegacyCardRepairInput {
  beerId: number;
  issueNumber: number;
  cardAbv: number | null;
  bid: number;
  evidenceUrl: string;
  operator: string;
  reason: string;
  overwriteAbv: boolean;
  hydrated: HydratedBeer;
  at: string;
}

export interface LegacyCardRepairPreview {
  orphan: {
    id: number; brewery: string; name: string; storedAbv: number | null;
    lookupAt: string | null; lookupCount: number; rearmCount: number;
  };
  failure: {
    issueNumber: number; brewery: string; name: string;
    sourceUrl: string; reviewClass: string | null; outcome: string;
    failCount: number; lastAt: string;
    retiredAt: string | null; unrescuedAt: string | null; unlockedAt: string | null;
  };
  aliasKey: { breweryText: string; nameText: string; abvKey: string };
  aliasTargetBid: number | null;
  canonical: { id: number; abv: number | null } | null;
  hydrated: HydratedBeer;
  referenceCounts: { matchLinks: number; checkins: number; untappdHad: number };
  overwriteAbv: boolean;
}

interface OrphanRecord {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
  untappd_id: number | null;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  rearm_count: number;
}

interface FailureRecord {
  issue_number: number | null;
  brewery: string;
  name: string;
  source_url: string;
  review_class: string | null;
  outcome: string;
  fail_count: number;
  last_at: string;
  retired_at: string | null;
  unrescued_at: string | null;
  unlocked_at: string | null;
}

interface AuditRecord {
  orphan_beer_id: number;
  issue_number: number;
  card_brewery: string;
  card_name: string;
  card_abv: number | null;
  target_bid: number;
  canonical_beer_id: number;
  evidence_url: string;
  operator: string;
  reason: string;
  overwrite_abv: number;
  final_canonical_abv: number | null;
}

function assertInput(input: LegacyCardRepairInput): void {
  if (!Number.isSafeInteger(input.beerId) || input.beerId <= 0
    || !Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0
    || !Number.isSafeInteger(input.bid) || input.bid <= 0) {
    throw new Error('beer ID, issue number and bid must be positive integers');
  }
  if (input.cardAbv !== null && (!Number.isFinite(input.cardAbv)
    || input.cardAbv < 0 || input.cardAbv > 100)) {
    throw new Error('historical card ABV must be between 0 and 100 or explicitly absent');
  }
  if (input.hydrated.bid !== input.bid || !input.hydrated.beer_name.trim()
    || !input.hydrated.brewery_name.trim()) {
    throw new Error('hydration must identify the exact bid with a beer and brewery');
  }
  if (input.hydrated.abv !== null
    && (!Number.isFinite(input.hydrated.abv)
      || input.hydrated.abv < 0 || input.hydrated.abv > 100)) {
    throw new Error('hydrated ABV must be between 0 and 100 or absent');
  }
  if (!input.reason.trim() || !input.operator.trim()) {
    throw new Error('operator and reason are required');
  }
  let evidence: URL;
  try { evidence = new URL(input.evidenceUrl); } catch { throw new Error('evidence URL is invalid'); }
  if (evidence.protocol !== 'http:' && evidence.protocol !== 'https:') {
    throw new Error('evidence URL must use HTTP(S)');
  }
  if (!Number.isFinite(Date.parse(input.at))) throw new Error('application time must be a date');
}

function countRefs(db: DB, table: 'match_links' | 'checkins' | 'untappd_had', beerId: number): number {
  const field = table === 'match_links' ? 'untappd_beer_id' : 'beer_id';
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${field} = ?`).get(beerId) as { n: number }).n;
}

export function previewLegacyCardRepair(db: DB, input: LegacyCardRepairInput): LegacyCardRepairPreview {
  assertInput(input);
  if (findActiveDispositionForBeer(db, input.beerId)) {
    throw new Error('inactive legacy orphan requires explicit reopen before repair');
  }
  const row = db.prepare(`
    SELECT id, brewery, name, abv, untappd_id, untappd_lookup_at,
           untappd_lookup_count, rearm_count FROM beers WHERE id = ?
  `).get(input.beerId) as OrphanRecord | undefined;
  if (!row || row.untappd_id !== null) throw new Error('beer is missing or already linked');
  const failure = db.prepare(`
    SELECT issue_number, brewery, name, source_url, review_class, outcome, fail_count, last_at,
           retired_at, unrescued_at, unlocked_at
      FROM enrich_failures WHERE beer_id = ?
  `).get(input.beerId) as FailureRecord | undefined;
  if (!failure || failure.issue_number !== input.issueNumber
    || failure.outcome !== 'not_found' || failure.retired_at !== null) {
    throw new Error('orphan failure is missing, retired, or belongs to another issue');
  }
  if (failure.brewery !== row.brewery || failure.name !== row.name) {
    throw new Error('failure card differs from the orphan brewery/name');
  }

  const aliasKey = {
    breweryText: cardText(row.brewery), nameText: cardText(row.name), abvKey: cardAbv(input.cardAbv),
  };
  if (!aliasKey.breweryText || !aliasKey.nameText) throw new Error('old card has an empty alias key');
  const alias = db.prepare(`
    SELECT b.untappd_id AS bid FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
      WHERE a.brewery_text = ? AND a.name_text = ? AND a.abv_key = ?
  `).get(aliasKey.breweryText, aliasKey.nameText, aliasKey.abvKey) as { bid: number | null } | undefined;
  if (alias && alias.bid !== input.bid) throw new Error('old card alias conflicts with another bid');

  const canonical = db.prepare('SELECT id, abv FROM beers WHERE untappd_id = ?')
    .get(input.bid) as { id: number; abv: number | null } | undefined;
  const hydratedAbv = input.hydrated.abv;
  const differsFromHydrated = hydratedAbv !== null
    && ((input.cardAbv !== null && input.cardAbv !== hydratedAbv)
      || (canonical?.abv != null && canonical.abv !== hydratedAbv));
  const unknownHydratedConflict = hydratedAbv === null && input.cardAbv !== null
    && canonical?.abv != null && input.cardAbv !== canonical.abv;
  if (unknownHydratedConflict) throw new Error('ABV conflict cannot be resolved without hydrated ABV');
  if (differsFromHydrated && !input.overwriteAbv) throw new Error('ABV differs: --overwrite-abv is required');
  if (!differsFromHydrated && input.overwriteAbv) throw new Error('ABV does not differ: overwrite is unnecessary');

  return {
    orphan: {
      id: row.id, brewery: row.brewery, name: row.name, storedAbv: row.abv,
      lookupAt: row.untappd_lookup_at, lookupCount: row.untappd_lookup_count,
      rearmCount: row.rearm_count,
    },
    failure: {
      issueNumber: failure.issue_number, brewery: failure.brewery, name: failure.name,
      sourceUrl: failure.source_url, failCount: failure.fail_count, lastAt: failure.last_at,
      reviewClass: failure.review_class, outcome: failure.outcome,
      retiredAt: failure.retired_at, unrescuedAt: failure.unrescued_at,
      unlockedAt: failure.unlocked_at,
    },
    aliasKey, aliasTargetBid: alias?.bid ?? null, canonical: canonical ?? null,
    hydrated: { ...input.hydrated, brewery_alias: [...input.hydrated.brewery_alias] },
    referenceCounts: {
      matchLinks: countRefs(db, 'match_links', row.id),
      checkins: countRefs(db, 'checkins', row.id),
      untappdHad: countRefs(db, 'untappd_had', row.id),
    },
    overwriteAbv: input.overwriteAbv,
  };
}

export function applyLegacyCardRepair(
  db: DB, input: LegacyCardRepairInput, expected?: LegacyCardRepairPreview,
): { canonicalId: number; kind: 'merged' | 'created' | 'noop' } {
  assertInput(input);
  const result = db.transaction(() => {
    const audit = db.prepare('SELECT * FROM legacy_card_repairs WHERE orphan_beer_id = ?')
      .get(input.beerId) as AuditRecord | undefined;
    if (audit) {
      const orphanStillPresent = db.prepare('SELECT 1 FROM beers WHERE id = ?').get(input.beerId);
      if (orphanStillPresent) throw new Error('repair audit conflicts with a live orphan');
      const live = findAliasTarget(db, audit.card_brewery, audit.card_name, audit.card_abv);
      if (audit.issue_number === input.issueNumber
        && (!expected || (audit.card_brewery === expected.orphan.brewery
          && audit.card_name === expected.orphan.name))
        && audit.card_abv === input.cardAbv
        && audit.target_bid === input.bid
        && audit.evidence_url === input.evidenceUrl
        && audit.operator === input.operator
        && audit.reason === input.reason
        && audit.overwrite_abv === Number(input.overwriteAbv)
        && audit.final_canonical_abv === (input.hydrated.abv
          ?? expected?.canonical?.abv ?? audit.final_canonical_abv)
        && live?.untappd_id === input.bid) {
        return { canonicalId: live.id, kind: 'noop' as const };
      }
      throw new Error('repair audit conflicts with this application');
    }

    if (!expected) throw new Error('fresh preview is required before applying a new repair');

    const current = previewLegacyCardRepair(db, input);
    const o = current.orphan;
    const e = expected.orphan;
    const f = current.failure;
    const ef = expected.failure;
    if (o.id !== e.id || o.brewery !== e.brewery || o.name !== e.name
      || o.storedAbv !== e.storedAbv || o.lookupAt !== e.lookupAt
      || o.lookupCount !== e.lookupCount || o.rearmCount !== e.rearmCount
      || f.issueNumber !== ef.issueNumber || f.brewery !== ef.brewery || f.name !== ef.name
      || f.sourceUrl !== ef.sourceUrl
      || f.reviewClass !== ef.reviewClass || f.outcome !== ef.outcome
      || f.failCount !== ef.failCount || f.lastAt !== ef.lastAt
      || f.retiredAt !== ef.retiredAt || f.unrescuedAt !== ef.unrescuedAt
      || f.unlockedAt !== ef.unlockedAt
      || current.aliasKey.breweryText !== expected.aliasKey.breweryText
      || current.aliasKey.nameText !== expected.aliasKey.nameText
      || current.aliasKey.abvKey !== expected.aliasKey.abvKey
      || current.aliasTargetBid !== expected.aliasTargetBid
      || current.canonical?.id !== expected.canonical?.id
      || current.canonical?.abv !== expected.canonical?.abv
      || current.referenceCounts.matchLinks !== expected.referenceCounts.matchLinks
      || current.referenceCounts.checkins !== expected.referenceCounts.checkins
      || current.referenceCounts.untappdHad !== expected.referenceCounts.untappdHad
      || current.hydrated.bid !== expected.hydrated.bid
      || current.hydrated.beer_name !== expected.hydrated.beer_name
      || current.hydrated.brewery_name !== expected.hydrated.brewery_name
      || current.hydrated.abv !== expected.hydrated.abv
      || current.hydrated.style !== expected.hydrated.style
      || current.hydrated.global_rating !== expected.hydrated.global_rating
      || current.overwriteAbv !== expected.overwriteAbv) {
      throw new Error('stale legacy card preview');
    }

    let canonicalId: number;
    const priorAbv = current.canonical?.abv ?? null;
    const kind: 'merged' | 'created' = current.canonical ? 'merged' : 'created';
    if (current.canonical) {
      canonicalId = current.canonical.id;
      db.prepare(`
        UPDATE beers SET style = COALESCE(style, ?), rating_global = COALESCE(rating_global, ?),
          abv = CASE WHEN ? THEN ? ELSE COALESCE(abv, ?) END,
          untappd_id_source = 'curated'
        WHERE id = ?
      `).run(input.hydrated.style, input.hydrated.global_rating,
        Number(input.overwriteAbv), input.hydrated.abv, input.hydrated.abv, canonicalId);
    } else {
      const created = db.prepare(`
        INSERT INTO beers (
          untappd_id, name, brewery, style, abv, rating_global,
          normalized_name, normalized_brewery, untappd_id_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'curated')
      `).run(input.bid, input.hydrated.beer_name, input.hydrated.brewery_name,
        input.hydrated.style, input.hydrated.abv, input.hydrated.global_rating,
        normalizeName(input.hydrated.beer_name), normalizeBrewery(input.hydrated.brewery_name));
      canonicalId = Number(created.lastInsertRowid);
    }

    db.prepare(`
      INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at)
        SELECT telegram_id, ?, last_seen_at FROM untappd_had WHERE beer_id = ?
      ON CONFLICT (telegram_id, beer_id) DO UPDATE SET
        last_seen_at = MAX(untappd_had.last_seen_at, excluded.last_seen_at)
    `).run(canonicalId, input.beerId);
    mergeIntoCanonical(db, input.beerId, canonicalId, input.at, {
      brewery: o.brewery, name: o.name, abv: input.cardAbv, byBid: true,
    }, false);
    const finalAbv = (db.prepare('SELECT abv FROM beers WHERE id = ?').get(canonicalId) as
      { abv: number | null }).abv;
    db.prepare(`
      INSERT INTO legacy_card_repairs (
        orphan_beer_id, issue_number, card_brewery, card_name, card_abv,
        failure_source_url, target_bid, canonical_beer_id, evidence_url,
        operator, reason, overwrite_abv, prior_canonical_abv,
        final_canonical_abv, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.beerId, input.issueNumber, o.brewery, o.name, input.cardAbv,
      f.sourceUrl, input.bid, canonicalId, input.evidenceUrl, input.operator,
      input.reason, Number(input.overwriteAbv), priorAbv, finalAbv, input.at);
    return { canonicalId, kind };
  })();
  if (result.kind !== 'noop') bumpCatalogVersion();
  return result;
}
