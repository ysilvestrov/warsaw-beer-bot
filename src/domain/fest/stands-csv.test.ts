import { parseStandsCsv } from './stands-csv';

describe('parseStandsCsv', () => {
  it('reads rows, skips a header, blank lines and a BOM, and trims cells', () => {
    expect(parseStandsCsv('﻿sekcja;piętro;stoisko\r\nPINTA; 2 ;B14\n\nVerdant Brewing Co;1;\n')).toEqual({
      rows: [
        { section: 'PINTA', floor: '2', stand: 'B14' },
        { section: 'Verdant Brewing Co', floor: '1', stand: null },
      ],
      errors: [],
    });
  });

  it('accepts a two-column line (no stand number)', () => {
    expect(parseStandsCsv('Browar X;3').rows).toEqual([{ section: 'Browar X', floor: '3', stand: null }]);
  });

  it('refuses quoted lines, wrong column counts and an empty section, by line number', () => {
    expect(parseStandsCsv('"A;B";1;2\nonly-one\na;b;c;d\n;1;2\nOK;1;2').errors).toEqual([
      { line: 1, reason: 'quotes' },
      { line: 2, reason: 'fields' },
      { line: 3, reason: 'fields' },
      { line: 4, reason: 'empty_section' },
    ]);
  });

  it('a header is only recognised on the first line', () => {
    expect(parseStandsCsv('PINTA;2;B14\nsection;floor;stand').rows.map((r) => r.section)).toEqual(['PINTA', 'section']);
  });

  it('an empty file has no rows and no errors', () => {
    expect(parseStandsCsv('')).toEqual({ rows: [], errors: [] });
  });
});
