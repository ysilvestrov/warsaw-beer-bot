// Stand map entered by people (spec §7, /fest stands): one line per menu section,
// "section;floor;stand", UTF-8, an optional header line. Pure.

export interface StandRow {
  section: string;
  floor: string | null;
  stand: string | null;
}

export interface StandsCsv {
  rows: StandRow[];
  /** 1-based line numbers that could not be read, with the reason. */
  errors: { line: number; reason: 'fields' | 'quotes' | 'empty_section' }[];
}

const HEADER_RE = /^\s*(section|секція|sekcja)\s*;/i;
const blank = (s: string | undefined): string | null => {
  const v = (s ?? '').trim();
  return v === '' ? null : v;
};

export function parseStandsCsv(text: string): StandsCsv {
  const out: StandsCsv = { rows: [], errors: [] };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let seenContent = false;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') return;
    // The header may only be the first line with content: exports often start with blank lines.
    const first = !seenContent;
    seenContent = true;
    if (first && HEADER_RE.test(raw)) return;
    // Quoting is not supported: a quoted ';' would silently shift the columns, so refuse the line.
    if (raw.includes('"')) {
      out.errors.push({ line, reason: 'quotes' });
      return;
    }
    const cells = raw.split(';');
    if (cells.length < 2 || cells.length > 3) {
      out.errors.push({ line, reason: 'fields' });
      return;
    }
    const section = blank(cells[0]);
    if (section === null) {
      out.errors.push({ line, reason: 'empty_section' });
      return;
    }
    out.rows.push({ section, floor: blank(cells[1]), stand: blank(cells[2]) });
  });
  return out;
}
