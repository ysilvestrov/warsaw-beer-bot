// Badge-cache key half. Latin is folded to ASCII exactly as before; Cyrillic letters are kept
// (#994), because dropping them gave different beers one key ("Ципа / Орєнтал" and
// "Ципа / з огірками" both became "|") and the cache then showed one beer's rating on the other.
// For any string with no Cyrillic after NFKD the result is byte-identical to the old ASCII key,
// so cached Latin entries stay valid (spec 2026-11-23-cyrillic-cache-key-design.md §3).
function norm(s: string): string {
  return s
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .normalize('NFKD')
    // Only a Cyrillic letter with its marks is recomposed, so й, ї, ё stay single letters.
    .replace(/\p{Script=Cyrillic}[̀-ͯ]+/gu, (m) => m.normalize('NFC'))
    // The same range as before; on Cyrillic it drops a stress accent (за́мок → замок).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Only Cyrillic letters are kept: a Cyrillic-script mark or symbol (҂, ҃) is a separator,
    // as is everything else outside a-z0-9, as it always was.
    .replace(/(?:[^a-z0-9\p{Script=Cyrillic}]|(?!\p{L})\p{Script=Cyrillic})+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeKey(brewery: string, name: string): string {
  return `${norm(brewery)}|${norm(name)}`;
}
