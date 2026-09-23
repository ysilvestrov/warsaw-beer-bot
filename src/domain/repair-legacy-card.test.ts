import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { findAliasTarget } from '../storage/beers';
import type { HydratedBeer } from '../sources/untappd/search';
import { applyLegacyCardRepair, previewLegacyCardRepair, type LegacyCardRepairInput } from './repair-legacy-card';

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`
    INSERT INTO beers (id, brewery, name, abv, normalized_brewery, normalized_name)
    VALUES (29955, 'De Cam', 'Abrikoos Rabarber 2018', 6, 'de cam', 'abrikoos rabarber')
  `).run();
  db.prepare(`
    INSERT INTO enrich_failures (
      beer_id, brewery, name, search_url, source_url, outcome,
      candidates_count, candidates_summary, fail_count, last_at,
      review_class, issue_number
    ) VALUES (29955, 'De Cam', 'Abrikoos Rabarber 2018', '',
      'https://flasker.com.ua/', 'not_found', 0, '', 1,
      '2026-09-23T00:00:00Z', 'parser_bug', 677)
  `).run();
  const hydrated: HydratedBeer = {
    bid: 3615616,
    beer_name: 'Abrikoos Rabarber 2018',
    brewery_name: 'Geuzestekerij De Cam',
    style: 'Lambic',
    abv: 7,
    global_rating: 4.1,
    beer_slug: 'abrikoos-rabarber-2018',
    brewery_alias: [],
  };
  const input: LegacyCardRepairInput = {
    beerId: 29955,
    issueNumber: 677,
    cardAbv: 6,
    bid: 3615616,
    evidenceUrl: 'https://flasker.com.ua/product/de-cam-abrikoos-rabarber-2018-750-ml/',
    operator: 'maintainer',
    reason: 'The shop printed 6%; the product links to the 7% Untappd vintage',
    overwriteAbv: true,
    hydrated,
    at: '2026-09-23T17:00:00Z',
  };
  return { db, input };
}

describe('repairLegacyCard (#696)', () => {
  it('preserves the old 6% card while merging into an existing 7% bid with an audit', () => {
    const { db, input } = fixture();
    db.prepare(`
      INSERT INTO beers (id, untappd_id, brewery, name, abv, normalized_brewery, normalized_name)
      VALUES (77, 3615616, 'Geuzestekerij De Cam', 'Abrikoos Rabarber 2018', 7,
              'geuzestekerij de cam', 'abrikoos rabarber')
    `).run();

    const preview = previewLegacyCardRepair(db, input);
    expect(preview.aliasKey).toEqual({
      breweryText: 'de cam', nameText: 'abrikoos rabarber 2018', abvKey: '6',
    });
    expect(preview.canonical).toEqual({ id: 77, abv: 7 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });
    expect(applyLegacyCardRepair(db, input, preview)).toEqual({ canonicalId: 77, kind: 'merged' });

    expect(findAliasTarget(db, 'De Cam', 'Abrikoos Rabarber 2018', 6)?.id).toBe(77);
    expect(findAliasTarget(db, 'De Cam', 'Abrikoos Rabarber 2018', 7)).toBeNull();
    expect((db.prepare('SELECT id FROM beers WHERE id = 29955').get())).toBeUndefined();
    expect((db.prepare('SELECT beer_id FROM enrich_failures WHERE beer_id = 29955').get())).toBeUndefined();
    expect(db.prepare('SELECT orphan_beer_id, target_bid, card_abv, final_canonical_abv, reason FROM legacy_card_repairs')
      .get()).toEqual({
      orphan_beer_id: 29955, target_bid: 3615616, card_abv: 6, final_canonical_abv: 7,
      reason: input.reason,
    });
    expect(db.prepare(`SELECT issue_number, failure_source_url, evidence_url, operator,
      overwrite_abv, prior_canonical_abv FROM legacy_card_repairs`).get()).toEqual({
      issue_number: 677, failure_source_url: 'https://flasker.com.ua/',
      evidence_url: input.evidenceUrl, operator: 'maintainer', overwrite_abv: 1,
      prior_canonical_abv: 7,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('creates a separate canonical row instead of adopting another same-name orphan', () => {
    const { db, input } = fixture();
    db.prepare(`INSERT INTO beers (id, brewery, name, normalized_brewery, normalized_name)
      VALUES (88, 'Geuzestekerij De Cam', 'Abrikoos Rabarber 2018',
              'geuzestekerij de cam', 'abrikoos rabarber')`).run();
    const preview = previewLegacyCardRepair(db, input);
    expect(preview.canonical).toBeNull();
    const result = applyLegacyCardRepair(db, input, preview);
    expect(result.kind).toBe('created');
    expect((db.prepare('SELECT untappd_id FROM beers WHERE id = 88').get() as { untappd_id: number | null })
      .untappd_id).toBeNull();
    expect(findAliasTarget(db, 'De Cam', 'Abrikoos Rabarber 2018', 6)?.id).toBe(result.canonicalId);
    expect((db.prepare('SELECT abv FROM beers WHERE id = ?').get(result.canonicalId) as { abv: number }).abv)
      .toBe(7);
  });

  it('keys the alias to the proven old card ABV even if the orphan catalog ABV changed later', () => {
    const { db, input } = fixture();
    db.prepare('UPDATE beers SET abv = 7 WHERE id = 29955').run();
    const preview = previewLegacyCardRepair(db, input);
    expect(preview.orphan.storedAbv).toBe(7);
    expect(preview.aliasKey.abvKey).toBe('6');
    applyLegacyCardRepair(db, input, preview);
    expect(findAliasTarget(db, 'De Cam', 'Abrikoos Rabarber 2018', 6)?.untappd_id).toBe(3615616);
    expect(findAliasTarget(db, 'De Cam', 'Abrikoos Rabarber 2018', 7)).toBeNull();
  });

  it('requires an explicit ABV overwrite and rejects a meaningless flag', () => {
    const { db, input } = fixture();
    expect(() => previewLegacyCardRepair(db, { ...input, overwriteAbv: false }))
      .toThrow(/ABV|overwrite/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });
    const equalAbv = { ...input, cardAbv: 7, overwriteAbv: false };
    expect(previewLegacyCardRepair(db, equalAbv).aliasKey.abvKey).toBe('7');
    expect(() => previewLegacyCardRepair(db, { ...equalAbv, overwriteAbv: true }))
      .toThrow(/ABV|overwrite/i);
  });

  it('refuses to take an alias that already points at another bid', () => {
    const { db, input } = fixture();
    db.prepare(`INSERT INTO beers (id, untappd_id, brewery, name, normalized_brewery, normalized_name)
      VALUES (78, 222, 'Other', 'Other', 'other', 'other')`).run();
    db.prepare(`INSERT INTO beer_aliases
      (beer_id, brewery, name, brewery_text, name_text, abv_key, created_at)
      VALUES (78, 'De Cam', 'Abrikoos Rabarber 2018',
              'de cam', 'abrikoos rabarber 2018', '6', '2026-09-22T00:00:00Z')`).run();
    expect(() => previewLegacyCardRepair(db, input)).toThrow(/alias|conflict/i);
    expect((db.prepare('SELECT beer_id FROM beer_aliases').get() as { beer_id: number }).beer_id).toBe(78);
  });

  it('rejects a stale preview after issue movement or a re-arm', () => {
    const { db, input } = fixture();
    const preview = previewLegacyCardRepair(db, input);
    db.prepare('UPDATE enrich_failures SET issue_number = 695 WHERE beer_id = 29955').run();
    expect(() => applyLegacyCardRepair(db, input, preview)).toThrow(/issue|stale/i);
    db.prepare('UPDATE enrich_failures SET issue_number = 677 WHERE beer_id = 29955').run();
    db.prepare('UPDATE beers SET rearm_count = rearm_count + 1 WHERE id = 29955').run();
    expect(() => applyLegacyCardRepair(db, input, preview)).toThrow(/stale|rearm/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });
  });

  it('rejects a new failure observation even when the issue and orphan lookup counters stay fixed', () => {
    const { db, input } = fixture();
    const preview = previewLegacyCardRepair(db, input);
    db.prepare(`UPDATE enrich_failures SET fail_count = fail_count + 1,
      last_at = '2026-09-23T17:01:00Z' WHERE beer_id = 29955`).run();
    expect(() => applyLegacyCardRepair(db, input, preview)).toThrow(/stale/i);
  });

  it('moves had/checkin/tap references without losing a newer had timestamp', () => {
    const { db, input } = fixture();
    db.prepare(`INSERT INTO beers (id, untappd_id, brewery, name, abv, normalized_brewery, normalized_name)
      VALUES (77, 3615616, 'Geuzestekerij De Cam', 'Abrikoos Rabarber 2018', 7,
              'geuzestekerij de cam', 'abrikoos rabarber')`).run();
    db.prepare(`INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at)
      VALUES (1, 29955, '2026-09-23T00:00:00Z'), (1, 77, '2026-09-22T00:00:00Z'),
             (2, 29955, '2026-09-21T00:00:00Z')`).run();
    db.prepare(`INSERT INTO checkins (checkin_id, telegram_id, beer_id, checkin_at)
      VALUES ('c1', 1, 29955, '2026-09-20T00:00:00Z')`).run();
    db.prepare(`INSERT INTO match_links (ontap_ref, brewery_ref, untappd_beer_id, confidence)
      VALUES ('Abrikoos', 'De Cam', 29955, 1)`).run();
    applyLegacyCardRepair(db, input, previewLegacyCardRepair(db, input));
    expect(db.prepare('SELECT telegram_id, beer_id, last_seen_at FROM untappd_had ORDER BY telegram_id').all())
      .toEqual([
        { telegram_id: 1, beer_id: 77, last_seen_at: '2026-09-23T00:00:00Z' },
        { telegram_id: 2, beer_id: 77, last_seen_at: '2026-09-21T00:00:00Z' },
      ]);
    expect(db.prepare('SELECT beer_id FROM checkins').get()).toEqual({ beer_id: 77 });
    expect(db.prepare('SELECT untappd_beer_id FROM match_links').get()).toEqual({ untappd_beer_id: 77 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('returns a no-op only for the same audited repair and still-live alias', () => {
    const { db, input } = fixture();
    const preview = previewLegacyCardRepair(db, input);
    const result = applyLegacyCardRepair(db, input, preview);
    expect(applyLegacyCardRepair(db, input, preview))
      .toEqual({ canonicalId: result.canonicalId, kind: 'noop' });
    expect(() => applyLegacyCardRepair(db, { ...input, reason: 'new reason' }, preview))
      .toThrow(/audit|different|conflict/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 1 });
  });

  it('treats absent hydrated ABV as no change to an existing canonical ABV on repeat', () => {
    const { db, input } = fixture();
    db.prepare(`INSERT INTO beers (id, untappd_id, brewery, name, abv, normalized_brewery, normalized_name)
      VALUES (77, 3615616, 'Geuzestekerij De Cam', 'Abrikoos Rabarber 2018', 6,
              'geuzestekerij de cam', 'abrikoos rabarber')`).run();
    const withoutAbv = { ...input, overwriteAbv: false, hydrated: { ...input.hydrated, abv: null } };
    const preview = previewLegacyCardRepair(db, withoutAbv);
    expect(applyLegacyCardRepair(db, withoutAbv, preview)).toEqual({ canonicalId: 77, kind: 'merged' });
    expect(applyLegacyCardRepair(db, withoutAbv, preview)).toEqual({ canonicalId: 77, kind: 'noop' });
  });

  it('rejects a changed hydration result or alias target after the displayed preview', () => {
    const { db, input } = fixture();
    const preview = previewLegacyCardRepair(db, input);
    input.hydrated.abv = 8;
    expect(() => applyLegacyCardRepair(db, input, preview)).toThrow(/stale|hydration|ABV/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });

    const second = fixture();
    const secondPreview = previewLegacyCardRepair(second.db, second.input);
    second.db.prepare(`INSERT INTO beers (id, untappd_id, brewery, name, normalized_brewery, normalized_name)
      VALUES (78, 222, 'Other', 'Other', 'other', 'other')`).run();
    second.db.prepare(`INSERT INTO beer_aliases
      (beer_id, brewery, name, brewery_text, name_text, abv_key, created_at)
      VALUES (78, 'De Cam', 'Abrikoos Rabarber 2018',
              'de cam', 'abrikoos rabarber 2018', '6', '2026-09-22T00:00:00Z')`).run();
    expect(() => applyLegacyCardRepair(second.db, second.input, secondPreview)).toThrow(/alias|conflict/i);
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });
  });

  it('does not call an unfinished repair a no-op merely because an audit row exists', () => {
    const { db, input } = fixture();
    db.prepare(`INSERT INTO beers (id, untappd_id, brewery, name, abv, normalized_brewery, normalized_name)
      VALUES (77, 3615616, 'Geuzestekerij De Cam', 'Abrikoos Rabarber 2018', 7,
              'geuzestekerij de cam', 'abrikoos rabarber')`).run();
    const preview = previewLegacyCardRepair(db, input);
    db.prepare(`INSERT INTO beer_aliases
      (beer_id, brewery, name, brewery_text, name_text, abv_key, created_at)
      VALUES (77, 'De Cam', 'Abrikoos Rabarber 2018',
              'de cam', 'abrikoos rabarber 2018', '6', '2026-09-23T17:00:00Z')`).run();
    db.prepare(`INSERT INTO legacy_card_repairs (
      orphan_beer_id, issue_number, card_brewery, card_name, card_abv,
      failure_source_url, target_bid, canonical_beer_id, evidence_url,
      operator, reason, overwrite_abv, prior_canonical_abv,
      final_canonical_abv, applied_at
    ) VALUES (29955, 677, 'De Cam', 'Abrikoos Rabarber 2018', 6,
      'https://flasker.com.ua/', 3615616, 77, ?, ?, ?, 1, 7, 7, ?)`).run(
      input.evidenceUrl, input.operator, input.reason, input.at,
    );
    expect(() => applyLegacyCardRepair(db, input, preview)).toThrow(/audit|unfinished|conflict/i);
    expect(db.prepare('SELECT id FROM beers WHERE id = 29955').get()).toEqual({ id: 29955 });
  });

  it('refuses contradictory failure-card text rather than aliasing a different historical card', () => {
    const { db, input } = fixture();
    db.prepare("UPDATE enrich_failures SET name = 'Different Card' WHERE beer_id = 29955").run();
    expect(() => previewLegacyCardRepair(db, input)).toThrow(/card|name|different/i);
  });

  it('requires overwrite when the existing canonical ABV disagrees with Untappd', () => {
    const { db, input } = fixture();
    db.prepare(`INSERT INTO beers (id, untappd_id, brewery, name, abv, normalized_brewery, normalized_name)
      VALUES (77, 3615616, 'Geuzestekerij De Cam', 'Abrikoos Rabarber 2018', 6,
              'geuzestekerij de cam', 'abrikoos rabarber')`).run();
    const cardMatchesUntappd = { ...input, cardAbv: 7, overwriteAbv: false };
    expect(() => previewLegacyCardRepair(db, cardMatchesUntappd)).toThrow(/ABV|overwrite/i);
    const approved = { ...cardMatchesUntappd, overwriteAbv: true };
    applyLegacyCardRepair(db, approved, previewLegacyCardRepair(db, approved));
    expect(db.prepare('SELECT abv FROM beers WHERE id = 77').get()).toEqual({ abv: 7 });
    expect(db.prepare('SELECT prior_canonical_abv, final_canonical_abv FROM legacy_card_repairs').get())
      .toEqual({ prior_canonical_abv: 6, final_canonical_abv: 7 });
  });

  it('rolls back canonical insertion, alias and merge if the audit write fails', () => {
    const { db, input } = fixture();
    const preview = previewLegacyCardRepair(db, input);
    db.exec(`CREATE TRIGGER reject_legacy_audit BEFORE INSERT ON legacy_card_repairs
      BEGIN SELECT RAISE(ABORT, 'audit rejected'); END`);
    expect(() => applyLegacyCardRepair(db, input, preview)).toThrow(/audit rejected/);
    expect(db.prepare('SELECT id FROM beers WHERE id = 29955').get()).toEqual({ id: 29955 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM beers WHERE untappd_id = 3615616').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT issue_number FROM enrich_failures WHERE beer_id = 29955').get())
      .toEqual({ issue_number: 677 });
  });
});
