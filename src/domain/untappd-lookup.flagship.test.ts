import { lookupBeer } from './untappd-lookup';
import type { BeerSearch, SearchResult } from '../sources/untappd/search';

function fakeSearch(rows: SearchResult[]): BeerSearch {
  return { search: async () => rows };
}

// beer_id 196 — the row #487 was filed for. `1664` normalizes to the empty string, so the
// target collapses to the brand `kronenbourg`, which BOTH siblings carry in alias_alt and
// therefore both score 1.0. 292835 vs 269076 is 1.09x — no flagship exists here.
const KRONENBOURG: SearchResult[] = [
  { bid: 5939, beer_name: '1664', brewery_name: 'Brasseries Kronenbourg', style: 'Lager - Pale', abv: 5.5, global_rating: 3.13, rating_count: 292835,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['kronenbourg 1664 45', 'kronenbourg', '1664 blonde'] },
  { bid: 5999, beer_name: '1664 Blanc', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Witbier / Blanche', abv: 5, global_rating: 3.48, rating_count: 269076,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['weizen', '1664 blanc 45', 'kronenbourg', 'kronenbourg 1664 blanc', 'blanc'] },
  { bid: 769282, beer_name: '1664 Blanc 0.0%', brewery_name: 'Brasseries Kronenbourg', style: 'Non-Alcoholic - Wheat', abv: 0, global_rating: 2.76, rating_count: 20420,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['1664 blanc alcohol free'] },
  { bid: 420671, beer_name: '1664 Rosé', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Fruited', abv: 4.5, global_rating: 2.9, rating_count: 22720,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: [] },
  { bid: 1034341, beer_name: '1664 Blanc Fruits Rouges', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Fruited', abv: 4.5, global_rating: 3.01, rating_count: 18035,
    brewery_alias: ['brasserie kronenbourg', 'kronenberg', 'Kronenburg'], alias_alt: ['1664 blanc fruits rouges'] },
];

// beer_id 29799 — native-alias pool. The two top-scored candidates stand at 22.05x and the
// leader's 5.1% is exactly ABV_TOLERANCE from the shop's 4.8%, so the veto must not fire.
const BREZNAK: SearchResult[] = [
  { bid: 56797, beer_name: 'Březňák Světlý ležák / Original Böhmisch Pils', brewery_name: 'Velké Březno', style: 'Pilsner - Czech / Bohemian', abv: 5.1, global_rating: 3.04, rating_count: 57139,
    brewery_alias: ['březňák', 'breznak'], alias_alt: ['breznak lager', '12'] },
  { bid: 101155, beer_name: 'Březňák Tmavé výčepní / Schwarzbier', brewery_name: 'Velké Březno', style: 'Lager - Tmavé (Czech Dark)', abv: 3.8, global_rating: 2.98, rating_count: 7601,
    brewery_alias: ['březňák', 'breznak'], alias_alt: [] },
  { bid: 317366, beer_name: 'Březňák Světlé výčepní', brewery_name: 'Velké Březno', style: 'Lager - Světlé (Czech Pale)', abv: 4, global_rating: 2.94, rating_count: 3208,
    brewery_alias: ['březňák', 'breznak'], alias_alt: ['10'] },
  { bid: 1398602, beer_name: 'Březňák 11', brewery_name: 'Velké Březno', style: 'Pilsner - Czech / Bohemian', abv: 4.6, global_rating: 3.09, rating_count: 2592,
    brewery_alias: ['březňák', 'breznak'], alias_alt: [] },
  { bid: 154534, beer_name: 'Starobrno Zelené pivo 13° / Green beer', brewery_name: 'Starobrno', style: 'Spiced / Herbed Beer', abv: 5.8, global_rating: 3, rating_count: 1682,
    brewery_alias: ['pivovar', 'starbrno', 'starobrno brewery'], alias_alt: ['starobrno easter beer', 'breznak zelene 13'] },
];

// beer_id 32117 — reaches the same site but with ONE candidate at the top score, so it
// takes the unchanged single-candidate path. Pinned as a documented limitation, not a win.
const MENABREA: SearchResult[] = [
  { bid: 537752, beer_name: 'La 150° Bionda', brewery_name: 'G. Menabrea & Figli', style: 'Lager - Pale', abv: 4.8, global_rating: 3.25, rating_count: 140299,
    brewery_alias: ['birra menabrea', 'birra menabrea spa', 'g menabrea e filli'], alias_alt: ['Chiara', 'La 150'] },
  { bid: 7482, beer_name: 'Original', brewery_name: 'G. Menabrea & Figli', style: 'Lager - Pale', abv: 4.5, global_rating: 3.16, rating_count: 62820,
    brewery_alias: ['birra menabrea', 'birra menabrea spa', 'g menabrea e filli'], alias_alt: ['pilsner', 'menabrea birra', 'menabrea 1846 lager'] },
  { bid: 46113, beer_name: 'La 150° Ambrata', brewery_name: 'G. Menabrea & Figli', style: 'Lager - Amber / Red', abv: 5, global_rating: 3.35, rating_count: 47919,
    brewery_alias: ['birra menabrea', 'birra menabrea spa', 'g menabrea e filli'], alias_alt: ['amber', 'menabrea ambrata'] },
];

describe('#487 near-name pick: dominance decides, ABV vetoes', () => {
  test('row 196 no longer links Kronenbourg 1664 to 1664 Blanc', async () => {
    const out = await lookupBeer({
      brewery: 'Kronenbourg Brewery', name: 'Kronenbourg 1664', abv: 5.0, search: fakeSearch(KRONENBOURG),
    });
    expect(out.kind).toBe('not_found');
  });

  test('row 196 does not silently flip to the other sibling either', async () => {
    // The honest outcome is an orphan. Matching 1664 here would be luck, not evidence:
    // restoring that identity is the separate digit-identity issue.
    const out = await lookupBeer({
      brewery: 'Kronenbourg Brewery', name: 'Kronenbourg 1664', abv: 5.5, search: fakeSearch(KRONENBOURG),
    });
    expect(out.kind).toBe('not_found');
  });

  test('a dominant native near-name candidate is matched', async () => {
    const out = await lookupBeer({
      brewery: 'Breznak Brewery', name: 'Breznak', abv: 4.8, search: fakeSearch(BREZNAK),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(56797);
  });

  test('the single-candidate path at the same site is unchanged', async () => {
    const out = await lookupBeer({
      brewery: 'Birra Menabrea Brewery', name: 'Menabrea', abv: 4.8, search: fakeSearch(MENABREA),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(7482);
  });
});
