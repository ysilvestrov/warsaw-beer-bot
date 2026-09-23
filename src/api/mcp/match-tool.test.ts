import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { mergeCheckin } from '../../storage/checkins';
import { markHad } from '../../storage/untappd_had';
import { prepareCatalog, FULL_FALLBACK_BUDGET } from '../../domain/matcher';
import type { CatalogCache } from '../../domain/catalog-cache';
import type { CatalogBeerWithRating } from '../../domain/match-list';
import { runMatchTool, renderMatchToolText } from './match-tool';
import { cardAbv, cardText } from '../../domain/card-text';
import { insertLegacyDisposition } from '../../storage/legacy-orphan-dispositions';

const CATALOG: CatalogBeerWithRating[] = [
  { id: 105, brewery: 'Trzech Kumpli', name: 'Pan IPAni', abv: 6.0, rating_global: 3.85, untappd_id: 9001 },
  { id: 200, brewery: 'PINTA', name: 'Atak Chmielu', abv: 6.1, rating_global: 3.7, untappd_id: 9002 },
];

function cacheOf(rows: CatalogBeerWithRating[]): CatalogCache {
  return {
    get: async () => ({
      prepared: prepareCatalog(rows),
      byId: new Map(rows.map((r) => [r.id, r])),
      byUntappdId: new Map(rows.filter((r) => r.untappd_id != null).map((r) => [r.untappd_id!, r])),
      aliases: new Map(),
    }),
    idle: async () => {},
  };
}

// `checkins.beer_id` and `untappd_had.beer_id` are FK-constrained to `beers(id)`.
// The catalog cache below is constructed directly (it never touches the `beers`
// table), so tests that call mergeCheckin/markHad against CATALOG's ids need those
// rows to actually exist in `beers` first — same setup shape as checkins.test.ts.
function seedBeer(db: ReturnType<typeof openDb>, row: CatalogBeerWithRating) {
  db.prepare(
    `INSERT INTO beers (id, untappd_id, name, brewery, abv, rating_global, normalized_name, normalized_brewery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.untappd_id ?? null, row.name, row.brewery, row.abv, row.rating_global,
    row.name.toLowerCase(), row.brewery.toLowerCase());
}

function db0() {
  const db = openDb(':memory:');
  migrate(db);
  ensureProfile(db, 1);
  for (const row of CATALOG) seedBeer(db, row);
  return db;
}

describe('runMatchTool', () => {
  it('does not disclose a sealed row from an old catalog snapshot', async () => {
    const db = db0();
    const old = { id: 300, brewery: 'De Cam', name: 'Abrikoos 2018', abv: 6,
      rating_global: null, untappd_id: null };
    seedBeer(db, old);
    const staleCache = cacheOf([...CATALOG, old]);
    insertLegacyDisposition(db, {
      beerId: old.id, issueNumber: 677, cardBrewery: old.brewery, cardName: old.name, cardAbv: old.abv,
      breweryText: cardText(old.brewery), nameText: cardText(old.name), abvKey: cardAbv(old.abv),
      failureSourceUrl: '', reason: 'Identity unknown', evidenceUrl: 'https://example.com/evidence',
      operator: 'test', inactiveAt: '2026-09-23T00:00:00Z',
    });
    const { output } = await runMatchTool(db, staleCache, 1, [
      { brewery: old.brewery, name: old.name, abv: 6 },
      { brewery: old.brewery, name: old.name, abv: 7 },
    ]);
    expect(output.results.map((r) => r.beer)).toEqual([null, null]);
    expect(output.results.map((r) => r.status)).toEqual(['not_in_catalog', 'not_in_catalog']);
    db.close();
  });
  it('an exact match on a beer the user rated is claimed as drunk, with the rating', async () => {
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 105,
      user_rating: 4.0, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.results[0]).toEqual({
      input: { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
      status: 'drunk',
      confidence: 'exact',
      beer: {
        name: 'Pan IPAni', brewery: 'Trzech Kumpli',
        rating_global: 3.85, untappd_url: 'https://untappd.com/beer/9001',
      },
      your_rating: 4.0,
    });
  });

  it('a fuzzy match on a beer in the drunk set is only PROBABLY drunk, and carries no rating', async () => {
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 200,
      user_rating: 4.5, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'PINTA', name: 'Atak Chmiel' },   // typo → fuzzy stage only
    ]);
    expect(output.results[0].status).toBe('probably_drunk');
    expect(output.results[0].confidence).toBe('fuzzy');
    expect(output.results[0].your_rating).toBeNull();
  });

  it('a fuzzy match on a beer the user has NOT drunk still says so — the confidence is the caveat', async () => {
    // This is the case the whole `confidence` field exists for: without it, this row is
    // indistinguishable from an exact "you have not drunk this".
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 105,
      user_rating: 3.0, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'PINTA', name: 'Atak Chmiel' },
    ]);
    expect(output.results[0].status).toBe('not_drunk');
    expect(output.results[0].confidence).toBe('fuzzy');
    expect(output.results[0].beer?.rating_global).toBe(3.7);
  });

  it('an item the fallback budget never searched is not_searched, not not_in_catalog', async () => {
    const db = db0();
    markHad(db, 1, 105, '2026-01-05T18:00:00Z');   // non-empty drunk set, so `unknown` is not in play
    const n = FULL_FALLBACK_BUDGET + 2;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, items);
    expect(output.results.slice(0, FULL_FALLBACK_BUDGET).every((r) => r.status === 'not_in_catalog')).toBe(true);
    expect(output.results.slice(FULL_FALLBACK_BUDGET).map((r) => r.status)).toEqual(['not_searched', 'not_searched']);
  });

  it('an empty drunk set downgrades not_drunk to unknown, and leaves the catalogue answer intact', async () => {
    // A user who installed the MCP but never ran the extension has nothing in
    // checkins ∪ untappd_had. "not_drunk" would be a claim about the person; we only
    // have a claim about our database.
    const db = db0();
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.results[0].status).toBe('unknown');
    expect(output.results[0].confidence).toBe('exact');
    expect(output.results[0].beer?.rating_global).toBe(3.85);
    expect(output.profile).toEqual({
      checkins_known: 0, untappd_had_known: 0, latest_checkin_at: null, drunk_set_empty: true,
    });
  });

  it('reports the profile that "not_drunk" rests on', async () => {
    // Asymmetric counts (2 check-ins, 1 markHad) so checkins_known and
    // untappd_had_known can't be confused for each other: swapping the two fields
    // in the implementation must make this test fail (see fix-round-1 report).
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: 105,
      user_rating: 4.0, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    mergeCheckin(db, {
      checkin_id: 'c2', telegram_id: 1, beer_id: 200,
      user_rating: 3.0, checkin_at: '2026-01-06T10:00:00Z', venue: null,
    });
    markHad(db, 1, 200, '2026-02-01T10:00:00Z');
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.profile.checkins_known).toBe(2);
    expect(output.profile.untappd_had_known).toBe(1);
    // mergeCheckin stores canonicalCheckinAt's 'YYYY-MM-DD HH:MM:SS' form (see
    // src/domain/checkin-time.ts), so this is what latestCheckinAt reads back —
    // not the raw ISO string this test passed in. c2 is the later checkin.
    expect(output.profile.latest_checkin_at).toBe('2026-01-06 10:00:00');
    expect(output.profile.drunk_set_empty).toBe(false);
  });

  it('the NOTE tracks the same emptiness the status rule uses, not raw check-in counts', async () => {
    // A check-in row with beer_id NULL contributes to checkins_known (COUNT(*) over
    // all checkins rows) but NOT to the drunk set (drunkBeerIds/triedBeerIds filter
    // out NULL beer_id) — so the profile line looks non-empty while every status
    // still downgrades to 'unknown'. The NOTE must follow the status rule, not the
    // raw counters.
    const db = db0();
    mergeCheckin(db, {
      checkin_id: 'c1', telegram_id: 1, beer_id: null,
      user_rating: null, checkin_at: '2026-01-05T18:00:00Z', venue: null,
    });
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, [
      { brewery: 'Trzech Kumpli', name: 'Pan IPAni' },
    ]);
    expect(output.profile.checkins_known).toBe(1);
    expect(output.profile.drunk_set_empty).toBe(true);
    expect(output.results[0].status).toBe('unknown');
    const text = renderMatchToolText(output);
    expect(text).toContain("nothing is known about this user's drinking");
  });

  it('a beer with no untappd id gets no link rather than a broken one', async () => {
    const db = db0();
    markHad(db, 1, 200, '2026-02-01T10:00:00Z');
    const noLink: CatalogBeerWithRating[] = [
      { id: 300, brewery: 'Nepomucen', name: 'Cytra', abv: 5.2, rating_global: 3.6, untappd_id: null },
    ];
    const { output } = await runMatchTool(db, cacheOf(noLink), 1, [
      { brewery: 'Nepomucen', name: 'Cytra' },
    ]);
    expect(output.results[0].beer?.untappd_url).toBeNull();
  });

  it('the text rendering says out loud that not_searched is not an absence', async () => {
    const db = db0();
    markHad(db, 1, 105, '2026-01-05T18:00:00Z');
    const n = FULL_FALLBACK_BUDGET + 1;
    const items = Array.from({ length: n }, (_, i) => ({ brewery: `Unknown${i}`, name: `Mystery ${i}` }));
    const { output } = await runMatchTool(db, cacheOf(CATALOG), 1, items);
    const text = renderMatchToolText(output);
    expect(text).toContain('not_searched');
    expect(text).toContain('search budget');
  });
});
