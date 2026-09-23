import pino from 'pino';
import { openDb } from '../storage/db';
import { migrate } from '../storage/schema';
import { getBeer, mergeIntoCanonical } from '../storage/beers';
import { seedBeer } from '../storage/seed-beer.testing';
import { normalizeName, normalizeBrewery } from './normalize';
import { applyLookupOutcome } from './lookup-outcome';
import type { LookupOutcome } from './untappd-lookup';
import type { SearchResult } from '../sources/untappd/search';
import { SHADOW_ONLY, classifyOrphanAsNonBeer } from './drink-boundary';
import { setEnrichFailureReview } from '../storage/enrich_failures';
import { cardAbv, cardText } from './card-text';
import { insertLegacyDisposition } from '../storage/legacy-orphan-dispositions';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  const id = seedBeer(db, {
    untappd_id: null, name: 'Taking Shape', brewery: 'Track', style: null, abv: null, rating_global: null,
    normalized_name: normalizeName('Taking Shape'), normalized_brewery: normalizeBrewery('Track'),
  });
  return { db, id, log: pino({ level: 'silent' }) };
}
const input = { brewery: 'Track', name: 'Taking Shape' };
const cand = (over: Partial<SearchResult>): SearchResult => ({
  bid: 1, beer_name: 'Some Beer', brewery_name: 'Some Brewery', style: null, abv: null, global_rating: null, ...over,
});
const failRow = (db: any, id: number) =>
  db.prepare('SELECT * FROM enrich_failures WHERE beer_id = ?').get(id);

describe('applyLookupOutcome failure logging', () => {
  test.each<LookupOutcome>([
    { kind: 'matched', result: cand({ bid: 999 }) },
    { kind: 'not_found', searchUrls: ['u'], candidates: [] },
    { kind: 'transient', error: new Error('timeout') },
    { kind: 'blocked', searchUrl: 'u' },
  ])('refuses %s writes after a disposition becomes active', (outcome) => {
    const { db, id, log } = fresh();
    insertLegacyDisposition(db, {
      beerId: id, issueNumber: 677, cardBrewery: input.brewery, cardName: input.name, cardAbv: null,
      breweryText: cardText(input.brewery), nameText: cardText(input.name), abvKey: cardAbv(null),
      failureSourceUrl: '', reason: 'Identity unknown', evidenceUrl: 'https://example.com/evidence',
      operator: 'test', inactiveAt: '2026-09-23T00:00:00Z',
    });
    const before = getBeer(db, id);
    expect(applyLookupOutcome({ db, log }, id, outcome, '2026-09-24T00:00:00Z', input)).toBe('skipped');
    expect(getBeer(db, id)).toEqual(before);
    expect(failRow(db, id)).toBeUndefined();
    db.close();
  });
  test('not_found records a failure row with candidate summary', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = {
      kind: 'not_found',
      searchUrls: ['https://untappd.com/search?q=Track+Taking+Shape&type=beer'],
      candidates: [cand({ brewery_name: 'Track Brewing', beer_name: 'Taking Shape XPA' })],
    };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    const row = failRow(db, id);
    expect(row).toMatchObject({ outcome: 'not_found', candidates_count: 1, fail_count: 1 });
    expect(row.candidates_summary).toContain('Track Brewing — Taking Shape XPA');
    expect(row.search_url).toContain('Track+Taking+Shape');
  });

  test('blocked records a failure row with zero candidates', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'https://untappd.com/search?q=Track&type=beer' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toMatchObject({ outcome: 'blocked', candidates_count: 0 });
  });

  test('matched clears any prior failure row', () => {
    const { db, id, log } = fresh();
    applyLookupOutcome({ db, log }, id,
      { kind: 'not_found', searchUrls: ['u'], candidates: [] }, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toBeDefined();
    applyLookupOutcome({ db, log }, id,
      { kind: 'matched', result: cand({ bid: 999 }) }, '2026-06-11T01:00:00Z', input);
    expect(failRow(db, id)).toBeUndefined();
    expect(getBeer(db, id)?.untappd_id).toBe(999);
  });

  test('transient does not record a failure', () => {
    const { db, id, log } = fresh();
    applyLookupOutcome({ db, log }, id,
      { kind: 'transient', error: new Error('x') }, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id)).toBeUndefined();
  });

  test('not_found persists the supplied sourceUrl', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'not_found', searchUrls: ['u'], candidates: [] };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z',
      { ...input, sourceUrl: 'https://beerfreak.org/p/x' });
    expect(failRow(db, id).source_url).toBe('https://beerfreak.org/p/x');
  });

  test('blocked persists the supplied sourceUrl', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'u' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z',
      { ...input, sourceUrl: 'https://beerfreak.org/p/x' });
    expect(failRow(db, id).source_url).toBe('https://beerfreak.org/p/x');
  });

  test('omitting sourceUrl stores empty string', () => {
    const { db, id, log } = fresh();
    const outcome: LookupOutcome = { kind: 'blocked', searchUrl: 'u' };
    applyLookupOutcome({ db, log }, id, outcome, '2026-06-11T00:00:00Z', input);
    expect(failRow(db, id).source_url).toBe('');
  });
});

describe('applyLookupOutcome merge', () => {
  test("returns 'merged' and redirects match_links when the bid already belongs to another row", () => {
    const { db, id, log } = fresh();
    const canonicalId = seedBeer(db, {
      untappd_id: 777, name: 'Canonical Beer', brewery: 'Canonical Brewery',
      style: null, abv: null, rating_global: 4.2,
      normalized_name: normalizeName('Canonical Beer'),
      normalized_brewery: normalizeBrewery('Canonical Brewery'),
    });
    db.prepare(
      "INSERT INTO match_links (ontap_ref, untappd_beer_id, confidence, reviewed_by_user) VALUES ('ref-1', ?, 0.9, 0)",
    ).run(id);

    const kind = applyLookupOutcome(
      { db, log }, id,
      { kind: 'matched', result: cand({ bid: 777 }) },
      '2026-07-27T00:00:00Z', input,
    );

    expect(kind).toBe('merged');
    expect(getBeer(db, id)).toBeNull();              // orphan row deleted
    expect(getBeer(db, canonicalId)!.untappd_id).toBe(777);
    const link = db.prepare('SELECT untappd_beer_id FROM match_links WHERE ontap_ref = ?').get('ref-1') as
      { untappd_beer_id: number };
    expect(link.untappd_beer_id).toBe(canonicalId);  // match_links redirected to the canonical row
    db.close();
  });

  test('#614 records no alias when the merged orphan was created by another card', () => {
    const { db, log } = fresh();
    const g7 = seedBeer(db, {
      untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
      style: 'Stout', abv: 7, rating_global: 3.9,
      normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
    });
    // Сирота картки «#6»; ensureBeerRow цифр не бачить і віддає її запиту картки «#7».
    const orphanId = seedBeer(db, {
      name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
      normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
    });

    const kind = applyLookupOutcome(
      { db, log }, orphanId,
      { kind: 'matched', result: cand({ bid: 4007 }) },
      '2026-09-14T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7', abv: 7 },
    );

    expect(kind).toBe('merged');
    // Сирота «#6» — не картка «#7»: доказ міг стосуватися будь-якої з них, тож аліасу немає.
    expect(db.prepare('SELECT COUNT(*) AS n FROM beer_aliases').get()).toEqual({ n: 0 });
    db.close();
  });

  test('#614 a card proved by its published bid keeps its alias through the merge, whatever the orphan text', () => {
    const { db, log } = fresh();
    const g7 = seedBeer(db, {
      untappd_id: 4007, name: 'Ґвара Series Seven', brewery: 'Gvara Brewery',
      style: 'Stout', abv: 7, rating_global: 3.9,
      normalized_name: normalizeName('Ґвара Series Seven'), normalized_brewery: normalizeBrewery('Gvara Brewery'),
    });
    const orphanId = seedBeer(db, {
      name: 'Ґвара #6', brewery: 'Ґвара', style: null, abv: 7, rating_global: null,
      normalized_name: normalizeName('Ґвара #6'), normalized_brewery: normalizeBrewery('Ґвара'),
    });

    const kind = applyLookupOutcome(
      { db, log }, orphanId,
      { kind: 'matched', result: cand({ bid: 4007 }) },
      '2026-09-15T07:13:20Z', { brewery: 'Ґвара', name: 'Ґвара #7', abv: 7, byBid: true },
    );

    expect(kind).toBe('merged');
    expect(db.prepare('SELECT beer_id, name_text FROM beer_aliases').all()).toEqual([{ beer_id: g7, name_text: 'ґвара #7' }]);
    db.close();
  });

  test('#614 a link of the card\'s own row moves the card key alias onto it', () => {
    const { db, log } = fresh();
    const card = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
    const old = seedBeer(db, {
      untappd_id: 1001, name: 'Black Bean', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.1,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const first = seedBeer(db, {
      name: card.name, brewery: card.brewery, style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName(card.name), normalized_brewery: normalizeBrewery(card.brewery),
    });
    mergeIntoCanonical(db, first, old, '2026-09-14T12:00:00Z', card);
    const own = seedBeer(db, {
      name: card.name, brewery: card.brewery, style: null, abv: null, rating_global: null,
      normalized_name: normalizeName(card.name), normalized_brewery: normalizeBrewery(card.brewery),
    });

    const kind = applyLookupOutcome(
      { db, log }, own, { kind: 'matched', result: cand({ bid: 2002, abv: 10.8 }) }, '2026-09-14T12:05:00Z', card,
    );

    expect(kind).toBe('matched');
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: own, abv_key: '11' }]);
    db.close();
  });

  test('#614 a bid-proved card moves its alias onto a same-pair row spelled differently', () => {
    const { db, log } = fresh();
    const card = { brewery: 'VARVAR', name: 'BLACK BEAN IS', abv: 11 };
    const old = seedBeer(db, {
      untappd_id: 1001, name: 'Black Bean', brewery: 'Varvar Brew', style: 'Stout', abv: 11, rating_global: 4.1,
      normalized_name: normalizeName('Black Bean'), normalized_brewery: normalizeBrewery('Varvar Brew'),
    });
    const first = seedBeer(db, {
      name: card.name, brewery: card.brewery, style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName(card.name), normalized_brewery: normalizeBrewery(card.brewery),
    });
    mergeIntoCanonical(db, first, old, '2026-09-15T12:00:00Z', card);
    const spelled = seedBeer(db, {
      name: 'Black Bean IS', brewery: 'Browar Varvar', style: null, abv: 11, rating_global: null,
      normalized_name: normalizeName('Black Bean IS'), normalized_brewery: normalizeBrewery('Browar Varvar'),
    });

    const kind = applyLookupOutcome(
      { db, log }, spelled, { kind: 'matched', result: cand({ bid: 2002, abv: 10.8 }) }, '2026-09-15T12:05:00Z',
      { ...card, byBid: true },
    );

    expect(kind).toBe('matched');
    expect(db.prepare('SELECT beer_id, abv_key FROM beer_aliases').all()).toEqual([{ beer_id: spelled, abv_key: '11' }]);
    db.close();
  });
});

describe('#430 post-search non-beer enforcer', () => {
  test('logs what it would classify and writes NO review_class while shadowed', () => {
    expect(SHADOW_ONLY).toBe(true); // the flip is a deliberate, separate change
    const { db, id } = fresh();
    const warns: unknown[] = [];
    const log = { warn: (o: unknown) => warns.push(o), error: () => {} } as unknown as pino.Logger;

    applyLookupOutcome({ db, log }, id, {
      kind: 'not_found', searchUrls: ['https://x/?q=aperol+spritz'], candidates: [],
    } as LookupOutcome, '2026-08-22T00:00:00.000Z', { brewery: 'Culaccino', name: 'Aperol Spritz' });

    const row = db.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?')
      .get(id) as { review_class: string | null };
    expect(row.review_class).toBeNull();          // the DB write, not just the log
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ beerId: id, token: 'aperol', shadow: true });
  });

  test('says nothing at all about a row it would not classify', () => {
    const { db, id } = fresh();
    const warns: unknown[] = [];
    const log = { warn: (o: unknown) => warns.push(o), error: () => {} } as unknown as pino.Logger;

    applyLookupOutcome({ db, log }, id, {
      kind: 'not_found', searchUrls: ['https://x/?q=hazy+ipa'], candidates: [],
    } as LookupOutcome, '2026-08-22T00:00:00.000Z', { brewery: 'Pinta', name: 'Hazy IPA' });

    expect(warns).toHaveLength(0);
  });
});

describe('#430 auto-classify must not overwrite an existing verdict (Critical A)', () => {
  test('a row already triaged keeps its review_class across a not_found retry that would otherwise trip the classifier', () => {
    const { db, id, log } = fresh();

    // Seed: a prior not_found failure, then a real triage verdict on it — exactly the
    // shape of a row `enrichOneOrphan` retries every day (matcher_bug stays in the
    // retry pool, unlike not_a_beer).
    applyLookupOutcome({ db, log }, id, {
      kind: 'not_found', searchUrls: ['u'], candidates: [],
    } as LookupOutcome, '2026-08-20T00:00:00.000Z', { brewery: 'Nalej Se', name: 'Some Real Beer' });
    const seeded = setEnrichFailureReview(db, id, 'matcher_bug', 'seed', '2026-08-20T00:00:01.000Z');
    expect(seeded).toBe('written'); // fails loud if the seed itself didn't take
    expect(failRow(db, id).review_class).toBe('matcher_bug');

    // Retry: zero candidates again (0<->0, no crossing, so recordEnrichFailure
    // preserves review_class) with a name carrying a surviving NON_BEER_NAME_TOKENS
    // token ('nalewka') — exactly what trips classifyOrphanAsNonBeer.
    applyLookupOutcome({ db, log }, id, {
      kind: 'not_found', searchUrls: ['u'], candidates: [],
    } as LookupOutcome, '2026-08-22T00:00:00.000Z', { brewery: 'Nalej Se', name: 'Nalewka gruszkowa' });

    // Since F3, the guard (matched + existing review_class → 'none') runs BEFORE the
    // shadow check, so this integration test genuinely exercises it under the real
    // committed SHADOW_ONLY=true wiring — before F3 it could not: shadow used to
    // short-circuit to 'log' first, so this assertion would have passed even with a
    // broken guard. The guard itself is still proved exhaustively and directly, with
    // no flag to flip, by autoClassifyAction's own tests in drink-boundary.test.ts
    // ("the guard wins under shadow too").
    expect(failRow(db, id).review_class).toBe('matcher_bug');
  });
});

describe('#430 F1: the enforcer reads the beer\'s stored style, not a hard-coded null', () => {
  test('an eligible style (Cydr) protects a name that carries a surviving non-beer token (nalewka)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const brewery = 'Sad Trzebnicki';
    const name = 'Nalewka gruszkowa';
    const id = seedBeer(db, {
      untappd_id: null, name, brewery, style: 'Cydr', abv: null, rating_global: null,
      normalized_name: normalizeName(name), normalized_brewery: normalizeBrewery(brewery),
    });

    // Proves the fix is load-bearing: with style dropped to null (the pre-fix
    // behaviour this task removes), the very same row WOULD be classified via the
    // 'nalewka' token — there is no other guard standing between this row and
    // not_a_beer once style is discarded.
    expect(classifyOrphanAsNonBeer({ brewery, name, style: null, candidates_count: 0 }))
      .toEqual({ nonBeer: true, token: 'nalewka' });

    const warns: unknown[] = [];
    const log = { warn: (o: unknown) => warns.push(o), error: () => {} } as unknown as pino.Logger;
    applyLookupOutcome({ db, log }, id, {
      kind: 'not_found', searchUrls: ['u'], candidates: [],
    } as LookupOutcome, '2026-08-22T00:00:00.000Z', { brewery, name });

    // With the real stored style read via getBeer (the fix), the eligible family
    // wins and the enforcer says nothing at all about this row.
    expect(warns).toHaveLength(0);
    db.close();
  });
});

describe('#430 F4: the pre-mutation review_class must be captured before recordEnrichFailure runs', () => {
  test('a 0<->>0 candidates crossing clears review_class for re-triage, but the value captured before the crossing still protects this same call', () => {
    const { db, id, log } = fresh();

    // Seed: a not_found failure WITH candidates (candidates_count > 0), then a real
    // triage verdict on it.
    applyLookupOutcome({ db, log }, id, {
      kind: 'not_found', searchUrls: ['u'], candidates: [cand({})],
    } as LookupOutcome, '2026-08-20T00:00:00.000Z', { brewery: 'Nalej Se', name: 'Some Real Beer' });
    const seeded = setEnrichFailureReview(db, id, 'matcher_bug', 'seed', '2026-08-20T00:00:01.000Z');
    expect(seeded).toBe('written'); // fails loud if the seed itself didn't take
    expect(failRow(db, id).review_class).toBe('matcher_bug');
    expect(failRow(db, id).candidates_count).toBeGreaterThan(0);

    // Retry: candidates_count crosses back to 0 (a genuine 0<->>0 crossing, so
    // recordEnrichFailure nulls review_class to reopen the row for re-triage) AND the
    // name now carries a surviving NON_BEER_NAME_TOKENS token ('nalewka'), tripping
    // classifyOrphanAsNonBeer, in the SAME call.
    const warns: unknown[] = [];
    const spyLog = { warn: (o: unknown) => warns.push(o), error: () => {} } as unknown as pino.Logger;
    applyLookupOutcome({ db, log: spyLog }, id, {
      kind: 'not_found', searchUrls: ['u'], candidates: [],
    } as LookupOutcome, '2026-08-22T00:00:00.000Z', { brewery: 'Nalej Se', name: 'Nalewka gruszkowa' });

    // The row genuinely IS reopened for re-triage...
    expect(failRow(db, id).review_class).toBeNull();
    // ...but auto-classify must not have PROPOSED not_a_beer against it in this same
    // call: it must take the 'none' (guarded-skip) path, not the 'log' (shadow
    // proposal) path. Both paths log a warning, so the distinguishing signal is the
    // message shape: only the 'log' path carries `shadow: true` — case 'none' does
    // not. The value captured BEFORE recordEnrichFailure ('matcher_bug') is what
    // routes this call through 'none'.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ beerId: id, token: 'nalewka', name: 'Nalewka gruszkowa' });
    expect(warns[0]).not.toHaveProperty('shadow');
  });
});
