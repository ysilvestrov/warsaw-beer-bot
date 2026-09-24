import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { seedBeer } from '../storage/seed-beer.testing';
import { recordEnrichFailure, setEnrichFailureReview, markRescued } from '../storage/enrich_failures';
import { insertLegacyDisposition } from '../storage/legacy-orphan-dispositions';
import { cardAbv, cardText } from '../domain/card-text';
import { inspectOrphanIssue } from './orphan-closeout';

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  const add = (name: string) => {
    const beerId = seedBeer(db, {
      untappd_id: null, name, brewery: 'Mad Brew', style: null, abv: null,
      rating_global: null, normalized_name: name.toLowerCase(), normalized_brewery: 'mad brew',
    });
    recordEnrichFailure(db, {
      beer_id: beerId, brewery: 'Mad Brew', name, search_url: '', source_url: '',
      outcome: 'not_found', candidates_count: 0, candidates_summary: '',
      at: '2026-09-24T08:00:00Z',
    });
    expect(setEnrichFailureReview(db, beerId, 'parser_bug', 'note', '2026-09-24T08:01:00Z', 697))
      .toBe('written');
    return beerId;
  };
  return { db, add };
}

it('classifies every live row and reports repairs without excusing a blocker', () => {
  const { db, add } = fixture();
  const rescued = add('Resolved card');
  const inactive = add('Unknown card');
  const blocked = add('Still unknown');
  markRescued(db, {
    beerId: rescued, issueNumber: 697, bid: 3615616, brewery: 'Mad Brew', name: 'Resolved card',
    abv: null, lookupCount: 0, lookupAt: null, rearmCount: 0,
    probedAt: '2026-09-24T09:00:00Z', appliedAt: '2026-09-24T09:01:00Z',
  });
  insertLegacyDisposition(db, {
    beerId: inactive, issueNumber: 697, cardBrewery: 'Mad Brew', cardName: 'Unknown card',
    cardAbv: null, breweryText: cardText('Mad Brew'), nameText: cardText('Unknown card'),
    abvKey: cardAbv(null), failureSourceUrl: '', reason: 'Identity unknown',
    evidenceUrl: 'https://example.com/evidence', operator: 'maintainer',
    inactiveAt: '2026-09-24T09:02:00Z',
  });
  db.prepare(`INSERT INTO legacy_card_repairs (
    orphan_beer_id, issue_number, card_brewery, card_name, card_abv, failure_source_url,
    target_bid, canonical_beer_id, evidence_url, operator, reason, overwrite_abv,
    prior_canonical_abv, final_canonical_abv, applied_at
  ) VALUES (4, 697, 'Mad Brew', 'Repaired card', NULL, '', 42, 5,
    'https://example.com/repair', 'maintainer', 'Known identity', 0, NULL, NULL,
    '2026-09-24T09:03:00Z')`).run();

  expect(inspectOrphanIssue(db, 697)).toMatchObject({
    ready: false,
    rows: [
      { beerId: rescued, state: 'rescued' },
      { beerId: inactive, state: 'inactive' },
      { beerId: blocked, state: 'blocked' },
    ],
    repairs: [{ orphanBeerId: 4, targetBid: 42 }],
  });
  db.prepare('UPDATE enrich_failures SET issue_number = 698 WHERE beer_id = ?').run(blocked);
  expect(inspectOrphanIssue(db, 697).ready).toBe(true);
});

it('refuses a disposition whose exact card no longer matches and a bare retired row', () => {
  const { db, add } = fixture();
  const changed = add('Old card');
  const retired = add('Retired card');
  insertLegacyDisposition(db, {
    beerId: changed, issueNumber: 697, cardBrewery: 'Mad Brew', cardName: 'Old card',
    cardAbv: null, breweryText: cardText('Mad Brew'), nameText: cardText('Old card'),
    abvKey: cardAbv(null), failureSourceUrl: '', reason: 'Identity unknown',
    evidenceUrl: 'https://example.com/evidence', operator: 'maintainer',
    inactiveAt: '2026-09-24T09:02:00Z',
  });
  db.prepare('UPDATE beers SET name = ? WHERE id = ?').run('Different card', changed);
  db.prepare('UPDATE enrich_failures SET retired_at = ? WHERE beer_id = ?')
    .run('2026-09-24T09:03:00Z', retired);
  expect(inspectOrphanIssue(db, 697).rows).toMatchObject([
    { beerId: changed, state: 'blocked' },
    { beerId: retired, state: 'blocked', reason: 'retired without a closeout disposition' },
  ]);
});

it('reports an empty cohort explicitly', () => {
  const { db } = fixture();
  expect(inspectOrphanIssue(db, 697)).toEqual({ issueNumber: 697, rows: [], repairs: [], ready: true });
});
