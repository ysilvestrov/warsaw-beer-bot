import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { findActiveDispositionForBeer } from '../storage/legacy-orphan-dispositions';
import {
  applyLegacyOrphanDisposition, applyLegacyOrphanReopen,
  previewLegacyOrphanDisposition, previewLegacyOrphanReopen,
  type LegacyDispositionInput, type LegacyReopenInput,
} from './dispose-legacy-orphan';

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO beers (id, brewery, name, abv, normalized_brewery, normalized_name)
    VALUES (29955, 'De Cam', 'Abrikoos 2018', 6, 'de cam', 'abrikoos')`).run();
  db.prepare(`INSERT INTO enrich_failures
    (beer_id, brewery, name, search_url, source_url, outcome, candidates_count,
     candidates_summary, fail_count, last_at, review_class, issue_number)
    VALUES (29955, 'De Cam', 'Abrikoos 2018', '', 'https://flasker.com.ua/',
      'not_found', 0, '', 1, '2026-09-23T00:00:00Z', 'parser_bug', 677)`).run();
  const input: LegacyDispositionInput = {
    beerId: 29955, issueNumber: 677, cardBrewery: 'De Cam', cardName: 'Abrikoos 2018',
    cardAbv: 6, reason: 'Historical card has no defensible identity',
    evidenceUrl: 'https://example.com/issue/677#investigation', operator: 'maintainer',
    at: '2026-09-23T17:00:00Z',
  };
  return { db, input };
}

describe('dispose legacy orphan (#695)', () => {
  it('previews without writing and applies one audited inactive episode', () => {
    const { db, input } = fixture();
    const preview = previewLegacyOrphanDisposition(db, input);
    expect(preview).toMatchObject({
      orphan: { id: 29955, storedAbv: 6, lookupCount: 0 },
      failure: { issueNumber: 677, sourceUrl: 'https://flasker.com.ua/' },
      key: { breweryText: 'de cam', nameText: 'abrikoos 2018', abvKey: '6' },
      referenceCounts: { matchLinks: 0, checkins: 0, untappdHad: 0 },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_orphan_dispositions').get()).toEqual({ n: 0 });
    expect(applyLegacyOrphanDisposition(db, input, preview).kind).toBe('applied');
    expect(findActiveDispositionForBeer(db, 29955)).toMatchObject({
      issueNumber: 677, reason: input.reason, evidenceUrl: input.evidenceUrl,
      cardAbv: 6, failureSourceUrl: 'https://flasker.com.ua/',
    });
    expect(db.prepare(`SELECT review_class, issue_number, unrescued_at
      FROM enrich_failures WHERE beer_id = 29955`).get()).toEqual({
      review_class: 'parser_bug', issue_number: 677, unrescued_at: null,
    });
    expect(db.prepare('SELECT untappd_lookup_count FROM beers WHERE id = 29955').get())
      .toEqual({ untappd_lookup_count: 0 });
    expect(applyLegacyOrphanDisposition(db, input).kind).toBe('noop');
    expect(() => applyLegacyOrphanDisposition(db, { ...input, reason: 'Different judgement' }))
      .toThrow(/conflict/i);
    db.close();
  });

  it('refuses stale review, lookup, alias, and historical-card changes', () => {
    const mutations = [
      `UPDATE enrich_failures SET issue_number = 678 WHERE beer_id = 29955`,
      `UPDATE enrich_failures SET last_at = '2026-09-24T00:00:00Z' WHERE beer_id = 29955`,
      `UPDATE beers SET untappd_lookup_count = 1 WHERE id = 29955`,
      `UPDATE beers SET name = 'Different card' WHERE id = 29955`,
      `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, abv_key, created_at)
        VALUES (29955, 'De Cam', 'Abrikoos 2018', 'de cam', 'abrikoos 2018', '6', '2026-09-23T00:00:00Z')`,
    ];
    for (const sql of mutations) {
      const { db, input } = fixture();
      const preview = previewLegacyOrphanDisposition(db, input);
      db.prepare(sql).run();
      expect(() => applyLegacyOrphanDisposition(db, input, preview)).toThrow();
      expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_orphan_dispositions').get())
        .toEqual({ n: 0 });
      db.close();
    }
  });

  it('rejects rows already linked, retired, repaired, or carrying another card', () => {
    const { db, input } = fixture();
    expect(() => previewLegacyOrphanDisposition(db, { ...input, cardName: 'Other' }))
      .toThrow(/card/i);
    db.prepare(`UPDATE enrich_failures SET retired_at = '2026-09-23T18:00:00Z' WHERE beer_id = 29955`).run();
    expect(() => previewLegacyOrphanDisposition(db, input)).toThrow(/retired/i);
    db.prepare('UPDATE enrich_failures SET retired_at = NULL WHERE beer_id = 29955').run();
    db.prepare('UPDATE beers SET untappd_id = 3615616 WHERE id = 29955').run();
    expect(() => previewLegacyOrphanDisposition(db, input)).toThrow(/linked/i);
    db.close();
  });

  it('manually reopens with new evidence while retaining the original decision', () => {
    const { db, input } = fixture();
    const episodeId = applyLegacyOrphanDisposition(
      db, input, previewLegacyOrphanDisposition(db, input),
    ).episodeId;
    db.prepare('UPDATE enrich_failures SET issue_number = NULL, review_class = NULL WHERE beer_id = 29955').run();
    const reopen: LegacyReopenInput = {
      episodeId, reason: 'Archived product page found',
      evidenceUrl: 'https://example.com/archive', operator: 'maintainer',
      at: '2026-09-24T12:00:00Z',
    };
    const preview = previewLegacyOrphanReopen(db, reopen);
    expect(preview).toMatchObject({ episode: { id: episodeId }, failure: { issueNumber: null } });
    expect(applyLegacyOrphanReopen(db, reopen, preview).kind).toBe('reopened');
    expect(findActiveDispositionForBeer(db, 29955)).toBeNull();
    expect(db.prepare(`SELECT reason, evidence_url, reopened_at, reopening_reason,
      reopening_evidence_url FROM legacy_orphan_dispositions WHERE id = ?`).get(episodeId))
      .toEqual({
        reason: input.reason, evidence_url: input.evidenceUrl,
        reopened_at: reopen.at, reopening_reason: reopen.reason,
        reopening_evidence_url: reopen.evidenceUrl,
      });
    expect(applyLegacyOrphanReopen(db, reopen).kind).toBe('noop');
    expect(() => applyLegacyOrphanReopen(db, { ...reopen, reason: 'Different reason' }))
      .toThrow(/conflict/i);
    db.close();
  });

  it('does not call a retry identical when the persisted exact card key changed', () => {
    const { db, input } = fixture();
    applyLegacyOrphanDisposition(db, input, previewLegacyOrphanDisposition(db, input));
    db.prepare(`UPDATE legacy_orphan_dispositions SET abv_key = '7' WHERE beer_id = 29955`).run();
    expect(() => applyLegacyOrphanDisposition(db, input)).toThrow(/conflict/i);
    db.close();
  });
});
