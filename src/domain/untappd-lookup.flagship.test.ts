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

// beer_id 427 (Okocim) — legacy HTML relay shape: near-name-tied candidates that carry
// NO rating_count at all (the legacy HTML relay and the web fallback never supply it).
// Dominance must not fire here; ABV stays the only signal, exactly as before #487.
const OKOCIM_NO_RATINGS: SearchResult[] = [
  { bid: 9055, beer_name: 'Okocim Jasne Okocimskie / Jasne Pełne', brewery_name: 'Browar Okocim', style: 'Pilsner', abv: 5, global_rating: 3.1,
    brewery_alias: ['Carlsberg Polska'], alias_alt: ['Okocim Jasne Pełne'] },
  { bid: 1768290, beer_name: 'Okocim Jasne Pełne 3,4%', brewery_name: 'Browar Okocim', style: 'Lager', abv: 3.4, global_rating: 2.7,
    brewery_alias: ['Carlsberg Polska'] },
  { bid: 4555473, beer_name: 'Okocim Jasne Lekkie', brewery_name: 'Browar Okocim', style: 'Lager', abv: 3.5, global_rating: 0,
    brewery_alias: ['Carlsberg Polska'] },
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

  test('a rating-less transport keeps its ABV disambiguation', async () => {
    // The legacy HTML relay supplies no rating_count on any candidate; with no popularity
    // evidence at all, the site must fall back to ABV rather than let dominance's null
    // refusal swallow the only signal this pool has (see #427).
    const out = await lookupBeer({
      brewery: 'Carlsberg Brewery', name: 'okocim jasne', abv: 5, search: fakeSearch(OKOCIM_NO_RATINGS),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(9055);
  });
});

// beer_id 1 — Untappd files it under `Plzeňský Prazdroj`, so only the brand pool survives.
const PILSNER_URQUELL: SearchResult[] = [
  { bid: 37936, beer_name: 'Pilsner Urquell', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 4.4, global_rating: 3.38, rating_count: 458401,
    brewery_alias: ['pivovar'], alias_alt: ['pilsener urquell', 'pu 1842', 'the original pilsner'] },
  { bid: 481334, beer_name: 'Pilsner Urquell Nefiltrovaný / Unfiltered', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 4.4, global_rating: 3.71, rating_count: 22704,
    brewery_alias: ['pivovar'], alias_alt: ['pilsner urquell unfiltered unpasteurized'] },
  { bid: 88241, beer_name: 'Pilsner Urquell Nepasterizovaný / Tank Beer', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 4.4, global_rating: 3.73, rating_count: 13569,
    brewery_alias: ['pivovar'], alias_alt: ['tankova', 'unpasteurized'] },
  { bid: 122973, beer_name: 'Pilsner Urquell 3.5%', brewery_name: 'Plzeňský Prazdroj', style: 'Pilsner - Czech / Bohemian', abv: 3.5, global_rating: 2.9, rating_count: 3345,
    brewery_alias: ['pivovar'], alias_alt: [] },
];

// beer_id 11933 — strict pool. The flagship's name shares nothing with the brand, which is
// exactly why a "flagship name must resemble the brewery" rule would have been wrong.
const BLUE_MOON: SearchResult[] = [
  { bid: 3839, beer_name: 'Belgian White', brewery_name: 'Blue Moon Brewing Company', style: 'Wheat Beer - Witbier / Blanche', abv: 5.4, global_rating: 3.5, rating_count: 625400,
    brewery_alias: ['bluemoon'], alias_alt: ['blue moon belgian style white', 'belgian white ale', 'blue moon'] },
  { bid: 3837, beer_name: 'Harvest Pumpkin Ale', brewery_name: 'Blue Moon Brewing Company', style: 'Pumpkin / Yam Beer', abv: 5.7, global_rating: 3.32, rating_count: 106143,
    brewery_alias: ['bluemoon'], alias_alt: ['harvest moon'] },
  { bid: 39740, beer_name: 'Summer Honey Wheat', brewery_name: 'Blue Moon Brewing Company', style: 'Wheat Beer - American Pale Wheat', abv: 5.2, global_rating: 3.32, rating_count: 81325,
    brewery_alias: ['bluemoon'], alias_alt: ['honeymoon summer ale'] },
  { bid: 1695486, beer_name: 'Mango Wheat', brewery_name: 'Blue Moon Brewing Company', style: 'Wheat Beer - Fruited', abv: 5.4, global_rating: 3.54, rating_count: 84491,
    brewery_alias: ['bluemoon'], alias_alt: [] },
];

// beer_ids 32 and 73 — the style word `Weizen` is stripped by normalizeName, so the target
// collapses to the brand even though the shop named the product.
const PRIMATOR: SearchResult[] = [
  { bid: 30947, beer_name: 'Weizen', brewery_name: 'Primátor', style: 'Wheat Beer - Hefeweizen', abv: 4.8, global_rating: 3.48, rating_count: 36240,
    brewery_alias: ['pivovar nachod'], alias_alt: ['premium hefeweissbier', 'hefeweizen', 'Weizenbier'] },
  { bid: 552690, beer_name: 'Hron Weizen', brewery_name: 'Primátor', style: 'Wheat Beer - Hefeweizen', abv: 5, global_rating: 3.31, rating_count: 111,
    brewery_alias: ['pivovar nachod'], alias_alt: [] },
  { bid: 642221, beer_name: 'Diver Hefe', brewery_name: 'Primátor', style: 'Wheat Beer - Hefeweizen', abv: 4.8, global_rating: 3.29, rating_count: 41,
    brewery_alias: ['pivovar nachod'], alias_alt: ['Weizenbier'] },
];

// beer_id 1391 — a bare-brand TARGET that already matches on its own at the near-name stage.
// The terminal stage must never get the chance to second-guess it. (Brewmen Stout, beer_id
// 23207, is the same shape with 19 ratings — far below the floor — so if the terminal stage
// were ever reached for it, it would answer null and the match would be lost.)
const GOOSE: SearchResult[] = [
  { bid: 1353, beer_name: 'Goose IPA', brewery_name: 'Goose Island Beer Co.', style: 'IPA - American', abv: 5.9, global_rating: 3.51, rating_count: 664549,
    brewery_alias: ['goose island brewery', 'goose island brewing co'], alias_alt: ['goose island ipa'] },
  { bid: 12943, beer_name: 'Green Line Pale Ale', brewery_name: 'Goose Island Beer Co.', style: 'Pale Ale - American', abv: 5.4, global_rating: 3.48, rating_count: 129062,
    brewery_alias: ['goose island brewery', 'goose island brewing co'], alias_alt: ['greenline'] },
  { bid: 2036410, beer_name: 'Midway IPA', brewery_name: 'Goose Island Beer Co.', style: 'IPA - Session', abv: 4.1, global_rating: 3.43, rating_count: 110235,
    brewery_alias: ['goose island brewery', 'goose island brewing co'], alias_alt: ['midway session ipa'] },
];

const BREWMEN: SearchResult[] = [
  { bid: 2697316, beer_name: 'Oatmeal Stout', brewery_name: 'Brewmen', style: 'Stout - Oatmeal', abv: 6.2, global_rating: 3.84, rating_count: 25,
    brewery_alias: ['bryumen'], alias_alt: [] },
  { bid: 4472578, beer_name: 'Brewmen Stout', brewery_name: 'Brewmen', style: 'Stout - Coffee', abv: 5.5, global_rating: 3.57, rating_count: 19,
    brewery_alias: [], alias_alt: [] },
  { bid: 5336905, beer_name: 'Karjalan Milk Stout', brewery_name: 'Brewmen', style: 'Stout - Milk / Sweet', abv: 6.5, global_rating: 3.6, rating_count: 24,
    brewery_alias: ['bryumen'], alias_alt: [] },
];

// A brewery whose products are evenly popular has no flagship, whatever the shop typed.
const NO_FLAGSHIP: SearchResult[] = [
  { bid: 900, beer_name: 'Erlkönig Hell', brewery_name: 'Erl-Bräu', style: 'Lager - Helles', abv: 5, global_rating: 3.4, rating_count: 18744, brewery_alias: [], alias_alt: [] },
  { bid: 901, beer_name: 'Erl Hell', brewery_name: 'Erl-Bräu', style: 'Lager - Helles', abv: 5, global_rating: 3.3, rating_count: 16157, brewery_alias: [], alias_alt: [] },
];

// A strict-pool flagship (50000 vs 900) alongside a far more popular brand-pool
// interloper from a different brewery. Flattening the pools would hand the match to
// the interloper purely on rating count.
const POOL_PRECEDENCE: SearchResult[] = [
  { bid: 100, beer_name: 'Sesja', brewery_name: 'Brewmen', style: 'Pale Ale', abv: 4.5, global_rating: 3.4, rating_count: 50000,
    brewery_alias: [], alias_alt: [] },
  { bid: 101, beer_name: 'Porter Baltycki', brewery_name: 'Brewmen', style: 'Porter', abv: 9, global_rating: 3.6, rating_count: 900,
    brewery_alias: [], alias_alt: [] },
  { bid: 102, beer_name: 'Brewmen Tribute Lager', brewery_name: 'Totally Other Brewery', style: 'Lager', abv: 4.5, global_rating: 3.1, rating_count: 900000,
    brewery_alias: [], alias_alt: [] },
];

describe('#487 terminal flagship stage', () => {
  test('a bare-brand target matches its flagship from the brand pool', async () => {
    const out = await lookupBeer({
      brewery: 'Pilsner Urquell Brewery', name: 'Pilsner Urquell', abv: 4.4, search: fakeSearch(PILSNER_URQUELL),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(37936);
  });

  test('a flagship whose name shares nothing with the brand still wins', async () => {
    const out = await lookupBeer({
      brewery: 'Blue Moon Brewery', name: 'Blue Moon', abv: 5.4, search: fakeSearch(BLUE_MOON),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(3839);
  });

  test('a target left bare by style-word stripping reaches its flagship', async () => {
    const out = await lookupBeer({
      brewery: 'Primator Brewery', name: 'Primator Weizen', abv: 4.8, search: fakeSearch(PRIMATOR),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(30947);
  });

  test('an evenly popular brewery yields no flagship', async () => {
    const out = await lookupBeer({
      brewery: 'Erl Brau Brewery', name: 'Erl Brau', abv: 5, search: fakeSearch(NO_FLAGSHIP),
    });
    expect(out.kind).toBe('not_found');
  });

  test('a stage that already matches is never reconsidered', async () => {
    const out = await lookupBeer({
      brewery: 'Goose Island Beer Co.', name: 'Goose IPA', abv: 5.9, search: fakeSearch(GOOSE),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1353);
  });

  test('a small brewery keeps its near-name match despite a tiny rating count', async () => {
    const out = await lookupBeer({
      brewery: 'Brewmen', name: 'Brewmen Stout', abv: 5.5, search: fakeSearch(BREWMEN),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(4472578);
  });

  test('a distinguishing token in the target keeps the stage out of it', async () => {
    // `Mango Wheat` is not bare-brand, so the flagship stage must not fire and hand back
    // `Belgian White` just because it is the most popular beer of the brewery.
    const out = await lookupBeer({
      brewery: 'Blue Moon Brewery', name: 'Blue Moon Mango Wheat', abv: 5.4, search: fakeSearch(BLUE_MOON),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(1695486);
  });

  test('a non-bare target reaches the terminal stage and is still refused', async () => {
    // `Blue Moon Mango Wheat` cannot witness this guard: stage 2a.5 resolves it first.
    // `Elderflower` matches no candidate at all, so every earlier stage misses and the
    // terminal stage IS reached — with a target that carries a distinguishing token.
    // Without the bare-brand guard the stage would hand back `Belgian White` (5.89x
    // dominance, ABV 5.4 = 5.4) for a beer the brewery may not even make.
    const out = await lookupBeer({
      brewery: 'Blue Moon Brewery', name: 'Blue Moon Elderflower', abv: 5.4, search: fakeSearch(BLUE_MOON),
    });
    expect(out.kind).toBe('not_found');
  });

  test('the strongest pool decides alone — a popular brand-pool interloper cannot win', async () => {
    const out = await lookupBeer({
      brewery: 'Brewmen', name: 'Brewmen', abv: 4.5, search: fakeSearch(POOL_PRECEDENCE),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(100);
  });
});

// beer_id — reviewer repro for the ordering bug. The name is the BREWERY's own brand,
// swapped in order ("Zamkowy Nepomucen" vs brewery "Nepomucen Zamkowy"), so it strips to
// nothing and bareBrandTarget fires. bid 700 carries a bounded one-character brewery typo
// ("Zamkovy" vs "Zamkowy") on an EXACT name match — exactly what typoRescue exists for. The
// other two candidates sit in the brewery's real strict pool with a 500x rating gap, so the
// flagship stage would confidently — and wrongly — pick the 500000-rated one if it ever ran
// before the rescue got a chance.
const NEPOMUCEN_TYPO_VS_FLAGSHIP: SearchResult[] = [
  { bid: 700, beer_name: 'Zamkowy Nepomucen', brewery_name: 'Nepomucen Zamkovy', style: 'Lager', abv: 4.4, global_rating: 3.2,
    brewery_alias: [], alias_alt: [] },
  { bid: 900001, beer_name: 'Sztandarowe', brewery_name: 'Nepomucen Zamkowy', style: 'Lager', abv: 4.4, global_rating: 3.3, rating_count: 500000,
    brewery_alias: [], alias_alt: [] },
  { bid: 900002, beer_name: 'Zimowe', brewery_name: 'Nepomucen Zamkowy', style: 'Lager', abv: 5.8, global_rating: 3.1, rating_count: 1000,
    brewery_alias: [], alias_alt: [] },
];

describe('#487 finding 1: the exact-name typo rescue outranks the flagship guess', () => {
  test('the exact-name typo rescue outranks the flagship guess', async () => {
    const out = await lookupBeer({
      brewery: 'Nepomucen Zamkowy', name: 'Zamkowy Nepomucen', abv: 4.4, search: fakeSearch(NEPOMUCEN_TYPO_VS_FLAGSHIP),
    });
    expect(out.kind).toBe('matched');
    if (out.kind !== 'matched') return;
    expect(out.result.bid).toBe(700);
  });
});

// beer_id — finding 2 repro. `1664` is pure digits, so normalizeName strips it to nothing
// and fuzzyTargets discards the resulting empty value entirely: targetNames is [], not a
// single empty-string target. `[].every()` is vacuously true, so without the
// `targetNames.length > 0` clause a nameless target would still satisfy bareBrandTarget and
// hand back the brewery's most popular beer for a name that named nothing.
const KRONENBOURG_BARE_DIGIT: SearchResult[] = [
  { bid: 6001, beer_name: '1664', brewery_name: 'Brasseries Kronenbourg', style: 'Lager - Pale', abv: 5.5, global_rating: 3.13, rating_count: 292835,
    brewery_alias: [], alias_alt: [] },
  { bid: 6002, beer_name: '1664 Blanc', brewery_name: 'Brasseries Kronenbourg', style: 'Wheat Beer - Witbier / Blanche', abv: 5, global_rating: 3.48, rating_count: 1000,
    brewery_alias: [], alias_alt: [] },
];

describe('#487 finding 2: a nameless target must not reach the flagship stage', () => {
  test('a name that normalizes away entirely stays an orphan', async () => {
    const out = await lookupBeer({
      brewery: 'Kronenbourg Brewery', name: '1664', abv: null, search: fakeSearch(KRONENBOURG_BARE_DIGIT),
    });
    expect(out.kind).toBe('not_found');
  });
});

// beer_id — finding 3 repro. Both candidates tie at the top near-name score (identical
// beer_name), so the site must fall through to `hasPopularity`. One candidate carries an
// EXPLICIT `rating_count: 0`, the other omits the field entirely (`undefined`). The two are
// different facts — 0 is a measured absence, undefined is a transport that never reports
// ratings at all — and only `!== undefined` tells them apart: `.some(r => r.rating_count)`
// would call both "no popularity" and fall back to ABV, silently matching the wrong beer.
const ZUBR_TIED_ZERO_VS_UNDEFINED: SearchResult[] = [
  { bid: 8001, beer_name: 'Zubr Premium Lager', brewery_name: 'Different Legal Entity', style: 'Lager', abv: 5.0, global_rating: 3.1, rating_count: 0,
    brewery_alias: ['zubr'], alias_alt: [] },
  { bid: 8002, beer_name: 'Zubr Premium Lager', brewery_name: 'Different Legal Entity', style: 'Lager', abv: 9.0, global_rating: 3.0, rating_count: undefined,
    brewery_alias: ['zubr'], alias_alt: [] },
];

describe('#487 finding 3: an explicit zero rating_count is not the same as absent', () => {
  test('a tied native near-name pool with one explicit zero and one undefined count stays unmatched', async () => {
    const out = await lookupBeer({
      brewery: 'Zubr Brewery', name: 'Zubr', abv: 5.0, search: fakeSearch(ZUBR_TIED_ZERO_VS_UNDEFINED),
    });
    expect(out.kind).toBe('not_found');
  });
});
