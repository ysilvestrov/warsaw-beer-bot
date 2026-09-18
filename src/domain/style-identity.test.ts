import { describe, expect, it } from 'vitest';
import { styleNameIdentity } from './style-identity';

describe('styleNameIdentity', () => {
  it('strips extract grades and specs while keeping the style word', () => {
    expect(styleNameIdentity('Pils 12°', 'zakladowy')).toBe('pils');
    expect(styleNameIdentity('Pils 12,0°', 'remeslo')).toBe('pils');
    expect(styleNameIdentity('WEIZEN 12°', 'kraftwerk remeslo')).toBe('weizen');
    expect(styleNameIdentity('Weizen 12,5°', 'trzech kumpli')).toBe('weizen');
    expect(styleNameIdentity('LAGER 10.5°', 'funky fluid')).toBe('lager');
    expect(styleNameIdentity('Session IPA 12°', 'nieczajna')).toBe('session ipa');
    expect(styleNameIdentity('Dry Stout 16°', 'maryensztadt')).toBe('dry stout');
    expect(styleNameIdentity('Saison 12,5°', 'palatum')).toBe('saison');
  });

  it('keeps style word from unadorned names', () => {
    expect(styleNameIdentity('Pils', 'zakladowy')).toBe('pils');
    expect(styleNameIdentity('WEIZEN', 'kraftwerk remeslo')).toBe('weizen');
    expect(styleNameIdentity('Stout', 'magic road')).toBe('stout');
    expect(styleNameIdentity('LAGER', 'magic road')).toBe('lager');
  });

  it('preserves numeric names when raw name is purely numeric', () => {
    expect(styleNameIdentity('21', 'funky fluid')).toBe('21');
    expect(styleNameIdentity('10', 'kamenice')).toBe('10');
  });

  it('strips brewery brand echo from candidate name', () => {
    expect(styleNameIdentity('Lager Trzech Kumpli', 'trzech kumpli')).toBe('lager');
    expect(styleNameIdentity('Browar Zakładowy Pils', 'zakladowy')).toBe('pils');
    expect(styleNameIdentity('Saison (MBC)', 'palatum')).toBe('saison');
  });

  it('distinguishes distinct styles and numbers', () => {
    expect(styleNameIdentity('Stout', 'magic road')).not.toBe(styleNameIdentity('LAGER', 'magic road'));
    expect(styleNameIdentity('Pils 12°', 'remeslo')).not.toBe(styleNameIdentity('WEIZEN', 'remeslo'));
    expect(styleNameIdentity('LAGER 10.5°', 'funky fluid')).not.toBe(styleNameIdentity('21', 'funky fluid'));
  });
});
