import { describe, it, expect } from 'vitest';
import { extractColonTails, isColonPrefixTailMatch } from './colon-prefix';

describe('extractColonTails', () => {
  it('extracts the tail after a colon and whitespace', () => {
    expect(extractColonTails('Classic: Pils')).toEqual(['Pils']);
    expect(extractColonTails('10th Anniversary Collab: Casimir')).toEqual(['Casimir']);
    expect(extractColonTails('10th Anniversary Collab: Jozsef')).toEqual(['Jozsef']);
  });

  it('handles multiple colons with whitespace by returning tails from each colon split', () => {
    expect(extractColonTails('Carles: Gelato: Sangria')).toEqual(['Gelato: Sangria', 'Sangria']);
  });

  it('rejects digital time notations, codes, or colons without trailing whitespace', () => {
    expect(extractColonTails('6:15')).toEqual([]);
    expect(extractColonTails('7:45 Escalation')).toEqual([]);
    expect(extractColonTails('AB:20')).toEqual([]);
    expect(extractColonTails('Series:NoSpace')).toEqual([]);
  });

  it('returns empty array if no colon is present', () => {
    expect(extractColonTails('Pilsner Urquell')).toEqual([]);
    expect(extractColonTails('')).toEqual([]);
  });
});

describe('isColonPrefixTailMatch', () => {
  it('matches input name against candidate colon tail', () => {
    expect(isColonPrefixTailMatch('Pils 11,5°', 'Classic: Pils')).toBe(true);
    expect(isColonPrefixTailMatch('CASIMIR 13,0°', '10th Anniversary Collab: Casimir')).toBe(true);
    expect(isColonPrefixTailMatch('JOZSEF 17,0°', '10th Anniversary Collab: Jozsef')).toBe(true);
  });

  it('matches collab sides in input against candidate colon tail', () => {
    expect(isColonPrefixTailMatch('Casimir / Other Beer', '10th Anniversary Collab: Casimir')).toBe(true);
  });

  it('strictly rejects typos in the tail (Josef trap)', () => {
    expect(isColonPrefixTailMatch('JOZSEF 17,0°', '10th Anniversary Collab: Josef')).toBe(false);
  });

  it('strictly rejects partial or substring tail matches', () => {
    expect(isColonPrefixTailMatch('Pils', 'Classic: Pilsner')).toBe(false);
    expect(isColonPrefixTailMatch('Pilsner', 'Classic: Pils')).toBe(false);
  });

  it('returns false for candidates without valid colon prefix', () => {
    expect(isColonPrefixTailMatch('Pils', 'Pils')).toBe(false);
    expect(isColonPrefixTailMatch('15', '6:15')).toBe(false);
  });
});
