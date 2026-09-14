import { cardAbv, cardText } from './card-text';

describe('cardText (#614)', () => {
  test('equal representations of the same text are equal: NFC, whitespace, case', () => {
    // «é» складена (U+00E9) і розкладена (E + U+0301) — один текст. Escape-послідовності, щоб редактор
    // не склав розкладену форму непомітно.
    expect(cardText('Caf\u00e9 Noir')).toBe(cardText('CAFE\u0301  NOIR'));
    expect(cardText('  VARVAR\n BLACK\tBEAN IS ')).toBe('varvar black bean is');
  });

  test('keeps every piece of content the candidate normalizer drops', () => {
    expect(cardText('Trappistes Rochefort 10')).not.toBe(cardText('Trappistes Rochefort 8'));
    expect(cardText('BQE Nitro (2024 Extra Vanilla)')).not.toBe(cardText('BQE Nitro (2023 Banana Pudding)'));
    expect(cardText('MJØD IS 2023')).not.toBe(cardText('MJØD IS'));
    expect(cardText('Leffe Blonde 0,0%')).not.toBe(cardText('Leffe Blonde'));
    expect(cardText('Browar')).toBe('browar');
  });
});

describe('cardAbv (#614)', () => {
  test('keeps the card ABV to hundredths; 0 is a real ABV', () => {
    expect(cardAbv(6.6)).toBe('6.6');
    expect(cardAbv(0)).toBe('0');
    expect(cardAbv(4.25)).toBe('4.25');
    expect(cardAbv(6.6000000001)).toBe('6.6');
  });

  test('a card without an ABV has its own empty key', () => {
    expect(cardAbv(null)).toBe('');
    expect(cardAbv(undefined)).toBe('');
    expect(cardAbv(Number.NaN)).toBe('');
  });
});
