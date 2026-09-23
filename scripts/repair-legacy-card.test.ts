import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import type { HydratedBeer } from '../src/sources/untappd/search';
import { parseRepairCliArgs, runRepairLegacyCard } from './repair-legacy-card';

const proof = 'https://flasker.com.ua/product/de-cam-abrikoos-rabarber-2018-750-ml/';
const args = [
  '--beer', '29955', '--issue', '677', '--card-abv', '6', '--bid', '3615616',
  '--evidence', proof, '--reason', 'Shop printed 6%, Untappd lists 7%',
  '--operator', 'maintainer', '--overwrite-abv',
];

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO beers (id, brewery, name, abv, normalized_brewery, normalized_name)
    VALUES (29955, 'De Cam', 'Abrikoos Rabarber 2018', 6, 'de cam', 'abrikoos rabarber')`).run();
  db.prepare(`INSERT INTO enrich_failures
    (beer_id, brewery, name, search_url, source_url, outcome, candidates_count,
     candidates_summary, fail_count, last_at, review_class, issue_number)
    VALUES (29955, 'De Cam', 'Abrikoos Rabarber 2018', '', 'https://flasker.com.ua/',
      'not_found', 0, '', 1, '2026-09-23T00:00:00Z', 'parser_bug', 677)`).run();
  const hydrated: HydratedBeer = {
    bid: 3615616, beer_name: 'Abrikoos Rabarber 2018', brewery_name: 'Geuzestekerij De Cam',
    style: 'Lambic', abv: 7, global_rating: 4.1,
    beer_slug: 'abrikoos-rabarber-2018', brewery_alias: [],
  };
  const lines: string[] = [];
  const hydrate = async (bids: number[]) => {
    expect(bids).toEqual([3615616]);
    return new Map([[3615616, hydrated]]);
  };
  return { db, lines, hydrate };
}

describe('repair-legacy-card CLI (#696)', () => {
  it('parses explicit old ABV and rejects ambiguous flags', () => {
    expect(parseRepairCliArgs(args)).toMatchObject({
      beerId: 29955, issueNumber: 677, cardAbv: 6, bid: 3615616,
      overwriteAbv: true, apply: false,
    });
    expect(parseRepairCliArgs(args.map((v) => v === '6' ? 'absent' : v)).cardAbv).toBeNull();
    for (const invalid of [
      [...args, '--bid', '9'], [...args, '--unknown'],
      args.filter((value) => value !== '29955'),
      args.map((value) => value === '3615616' ? '0' : value),
      args.map((value) => value === '6' ? 'NaN' : value),
      args.map((value) => value === '6' ? '-1' : value),
      args.map((value) => value === proof ? 'file:///tmp/proof' : value),
    ]) {
      expect(() => parseRepairCliArgs(invalid)).toThrow();
    }
  });

  it('prints the complete dry-run and does not write to the database', async () => {
    const { db, lines, hydrate } = fixture();
    await runRepairLegacyCard(args, { db, hydrate, print: (line) => lines.push(line) });
    const preview = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(preview).toMatchObject({
      apply: false, evidenceUrl: proof, reason: 'Shop printed 6%, Untappd lists 7%',
      operator: 'maintainer', overwriteAbv: true,
      aliasKey: { breweryText: 'de cam', nameText: 'abrikoos rabarber 2018', abvKey: '6' },
      orphan: { id: 29955, storedAbv: 6 }, failure: { issueNumber: 677 },
      hydrated: { bid: 3615616, abv: 7 },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM enrich_failures').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT untappd_id FROM beers WHERE id = 29955').get()).toEqual({ untappd_id: null });
  });

  it('applies only with --apply after a fresh hydration and refuses unavailable bids', async () => {
    const { db, lines, hydrate } = fixture();
    await runRepairLegacyCard([...args, '--apply'], { db, hydrate, print: (line) => lines.push(line) });
    expect(JSON.parse(lines[0])).toMatchObject({ apply: true, aliasKey: { abvKey: '6' } });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'created' });
    expect(db.prepare('SELECT target_bid, overwrite_abv FROM legacy_card_repairs').get())
      .toEqual({ target_bid: 3615616, overwrite_abv: 1 });

    const second = fixture();
    await expect(runRepairLegacyCard([...args, '--apply'], {
      db: second.db, hydrate: async () => new Map([[3615616, null]]), print: () => {},
    })).rejects.toThrow(/hydrat|bid/i);
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM legacy_card_repairs').get()).toEqual({ n: 0 });
  });
});
