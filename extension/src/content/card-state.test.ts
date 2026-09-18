import { describe, it, expect } from 'vitest';
import { stateFromMatch } from './card-state';
import type { MatchResult } from '../api/types';

const base: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: 'exact',
  searched: true,
};
const r = (over: Partial<MatchResult>): MatchResult => ({ ...base, ...over });
const orphanRow = { id: 2, name: 'Ghost', brewery: 'PINTA', rating_global: null, untappd_id: null };

const noEnrich = { enrichmentPossible: false };
const withEnrich = { enrichmentPossible: true };

describe('#648 stateFromMatch', () => {
  it('a linked row is found, and an exact match is not unsure', () => {
    expect(stateFromMatch(base, withEnrich)).toEqual({
      kind: 'found', drunk: false, mine: null, global: 4.1, unsure: false,
      untappdId: 111, brewery: 'PINTA', name: 'Hazy Morning',
    });
  });

  it('a fuzzy match is unsure even though nothing else changes', () => {
    const s = stateFromMatch(r({ source: 'fuzzy' }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', unsure: true });
  });

  it('puts the personal rating in `mine` and the global one in `global`, never crossed', () => {
    const s = stateFromMatch(r({ is_drunk: true, user_rating: 4.2 }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', drunk: true, mine: 4.2, global: 4.1 });
  });

  it('treats drunk_uncertain as drunk AND unsure', () => {
    const s = stateFromMatch(r({ drunk_uncertain: true, source: 'fuzzy' }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', drunk: true, unsure: true });
  });

  it('a drunk beer on an orphan row is still found, with no bid to click', () => {
    const s = stateFromMatch(r({ matched_beer: orphanRow, is_drunk: true }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', drunk: true, untappdId: null });
  });

  // Сирота в черзі — це ще не вердикт: питання відкрите, доки дошук не відповів.
  it('an undrunk orphan row is queued while enrichment can still run', () => {
    expect(stateFromMatch(r({ matched_beer: orphanRow }), withEnrich)).toEqual({ kind: 'queued' });
  });

  it('an undrunk orphan row is missing when enrichment cannot run', () => {
    expect(stateFromMatch(r({ matched_beer: orphanRow }), noEnrich)).toEqual({
      kind: 'missing', brewery: 'PINTA', name: 'Hazy Morning', orphan: true,
    });
  });

  it('nothing matched but we DID look: missing', () => {
    expect(stateFromMatch(r({ matched_beer: null }), noEnrich)).toEqual({
      kind: 'missing', brewery: 'PINTA', name: 'Hazy Morning', orphan: false,
    });
  });

  // Це і є різниця, якої сьогодні не видно: «нема» проти «ми не дивилися».
  it('nothing matched and we never looked: deferred, not missing', () => {
    expect(stateFromMatch(r({ matched_beer: null, searched: false }), noEnrich))
      .toEqual({ kind: 'deferred' });
  });

  it('an unsearched card is still queued while enrichment can run', () => {
    expect(stateFromMatch(r({ matched_beer: null, searched: false }), withEnrich))
      .toEqual({ kind: 'queued' });
  });

  // The 8-hour cache holds raw /match responses, and entries written by the previous
  // version have no `searched` at all — the client never declared the field. Reading it
  // for truthiness would put every one of them on the loudest claim we have.
  it('a cached response from before this version is not accused of "we never looked"', () => {
    const legacy = {
      raw: { brewery: 'PINTA', name: 'Hazy Morning' },
      matched_beer: null,
      is_drunk: false,
      drunk_uncertain: false,
      user_rating: null,
    } as unknown as MatchResult;
    expect(stateFromMatch(legacy, noEnrich)).toEqual({
      kind: 'missing', brewery: 'PINTA', name: 'Hazy Morning', orphan: false,
    });
  });

  // "Пиво є в каталозі" is exactly what a fuzzy match has not established.
  it('does not claim catalogue membership when the row was reached fuzzily', () => {
    expect(stateFromMatch(r({ matched_beer: orphanRow, source: 'fuzzy' }), noEnrich))
      .toMatchObject({ kind: 'missing', orphan: false });
    expect(stateFromMatch(r({ matched_beer: orphanRow, source: 'exact' }), noEnrich))
      .toMatchObject({ kind: 'missing', orphan: true });
  });
});
