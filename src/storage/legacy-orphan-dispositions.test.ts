import { openDb } from './db';
import { migrate } from './schema';
import {
  findActiveDispositionForBeer, findActiveDispositionForCard,
  insertLegacyDisposition, closeLegacyDisposition,
} from './legacy-orphan-dispositions';

describe('active legacy orphan dispositions', () => {
  it('uses the exact historical card key and stops reading a manually reopened episode', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(findActiveDispositionForBeer(db, 29955)).toBeNull();
    const id = insertLegacyDisposition(db, {
      beerId: 29955, issueNumber: 677,
      cardBrewery: 'De Cam', cardName: 'Abrikoos 2018', cardAbv: 6,
      breweryText: 'de cam', nameText: 'abrikoos 2018', abvKey: '6',
      failureSourceUrl: '', reason: 'No defensible bid',
      evidenceUrl: 'https://example.com/evidence', operator: 'maintainer',
      inactiveAt: '2026-09-23T00:00:00Z',
    });
    expect(findActiveDispositionForCard(db, ' DE  CAM ', 'Abrikoos 2018', 6)?.beerId).toBe(29955);
    expect(findActiveDispositionForCard(db, 'De Cam', 'Abrikoos 2018', 7)).toBeNull();
    expect(findActiveDispositionForCard(db, 'De Cam', 'Abrikoos 2018', null)).toBeNull();
    expect(findActiveDispositionForCard(db, 'De Cam', 'Abrikoos 2018', 0)).toBeNull();
    expect(closeLegacyDisposition(db, id, {
      reopenedAt: '2026-09-24T00:00:00Z', reopeningReason: 'New evidence',
      reopeningEvidenceUrl: 'https://example.com/new', reopeningOperator: 'maintainer',
    })).toBe(true);
    expect(closeLegacyDisposition(db, id, {
      reopenedAt: '2026-09-24T00:00:00Z', reopeningReason: 'New evidence',
      reopeningEvidenceUrl: 'https://example.com/new', reopeningOperator: 'maintainer',
    })).toBe(false);
    expect(findActiveDispositionForBeer(db, 29955)).toBeNull();
    expect(findActiveDispositionForCard(db, 'De Cam', 'Abrikoos 2018', 6)).toBeNull();
    db.close();
  });
});
