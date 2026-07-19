const STYLE_WORDS = new Set([
  'ipa', 'apa', 'neipa', 'dipa', 'tipa', 'aipa', 'neneipa',
  'imperial', 'double', 'triple', 'session', 'dry', 'hopped', 'dh', 'ddh',
  'pils', 'pilsner', 'lager', 'stout', 'porter', 'weizen', 'wheat',
  'saison', 'sour', 'gose', 'lambic', 'barleywine', 'bock',
]);
const SPEC_LABEL_WORDS = new Set(['alc', 'abv', 'ibu']);
export const BREWERY_NOISE = new Set([
  // English / Polish
  'browar', 'browary', 'brewery', 'brewing', 'co', 'company', 'contracts',
  'collab', 'collaboration',
  // Czech / Slovak, German, French, Italian, Dutch/Flemish,
  // Scandinavian (+ definite form), Spanish (post-diacritic-strip form)
  'pivovar', 'pivovary', 'brauerei', 'brasserie', 'birrificio',
  'brouwerij', 'bryggeri', 'bryggeriet', 'cerveceria',
  // Compound "nano-brewery" descriptors only (a single glued token). Bare "nano"
  // is deliberately NOT noise — it's a separate word or brand fragment in
  // "Nano Cinco"/"Mandrill Nano Brewing", which stripping would corrupt (#228).
  'nanobrowar', 'nanobrowary', 'nanobryggeri', 'minipivovar',
  // Descriptor in "<brand> Family Brewery"; never the load-bearing brand token (#309).
  'family',
]);

// Separator for collab/bilingual brewery names. Untappd uses:
//   "A / B"  — slash with any spacing (bilingual or collab)
//   "A x B"  — " x "/" X " connector (collab, case-insensitive)
//   "A & B"  — " & " connector (collab)
// String.split() applies this to every occurrence regardless of the global flag.
export const COLLAB_SEP = /\s*\/\s*|\s+[Xx]\s+|\s+&\s+/;

// NFD decomposes most Polish diacritics (ą ć ę ń ó ś ź ż and their
// uppercase forms) into a base letter + a combining mark from the
// U+0300–U+036F block, which the regex then strips. Ł/ł is the one
// Polish letter that is NOT canonically decomposable — it's a base
// letter with an inherent stroke (U+0141 / U+0142), so NFD leaves it
// intact and we replace it explicitly.
function stripDiacritics(s: string): string {
  return s.normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L');
}

// Private-use sentinel survives baseNormalize's punctuation pass, then becomes a
// canonical dot. Percentage/strength suffixes deliberately bypass this protection.
const DECIMAL_SEPARATOR = '\uE000';

function preserveDecimalIdentifiers(s: string): string {
  return s.replace(
    /\b(\d+)[.,](\d+)\b(?!\s*(?:%|°|abv\b))/gi,
    `$1${DECIMAL_SEPARATOR}$2`,
  );
}

export function baseNormalize(s: string): string {
  return stripDiacritics(s).toLowerCase()
    .replace(/[^\p{L}\p{N}\s\uE000]/gu, ' ')
    .replaceAll(DECIMAL_SEPARATOR, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip pure-digit tokens — covers ontap noise like "24" / "8" / "5"
// (left over after baseNormalize splits "24°·8,5%") and Untappd vintage
// suffixes like "2024"/"2026". Trade-off: legitimate numeric beer names
// ("Pinta 555") collapse too — acceptable for now.
const isNumericNoise = (t: string): boolean => /^\d+$/.test(t);

// Legal-entity suffixes carry no brand meaning. Stripped from the RAW brewery
// string before tokenization so we never denylist the bare letters they
// decompose into (z, o, a). Finite, conservative set; dots are required for the
// S.A. form to avoid eating a real "S A" token.
const LEGAL_FORM_RES = [
  /\bsp\.?\s*z\s*o\.?\s*o\.?/gi, // Sp. z o.o. + dotted/spacing variants
  /\bs\.\s*a\.?/gi,             // S.A.
];

export function stripLegalForm(s: string): string {
  let out = s;
  for (const re of LEGAL_FORM_RES) out = out.replace(re, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

export function normalizeName(s: string): string {
  const tokens = baseNormalize(preserveDecimalIdentifiers(stripSearchNoise(s)))
    .split(' ')
    .filter((t) => t && !STYLE_WORDS.has(t) && !SPEC_LABEL_WORDS.has(t) && !isNumericNoise(t));
  return tokens.join(' ');
}

export function normalizeBrewery(s: string): string {
  const tokens = baseNormalize(stripLegalForm(s))
    .split(' ')
    .filter((t) => t && !BREWERY_NOISE.has(t) && !isNumericNoise(t));
  return tokens.join(' ');
}

// Remove brewery noise words ("Browar", "Brewery", "Brewing", "Co", "Company")
// from a brewery label while preserving the original case and diacritics of the
// remaining tokens. Used to build Untappd search queries: the raw ontap label
// often appends "Brewery", which Untappd's term-AND search does not find in the
// real brewery name (e.g. "JBW Brewery" vs the registered "JBW Browar").
export function stripBreweryNoise(brewery: string): string {
  return stripLegalForm(brewery)
    .split(COLLAB_SEP)             // collapse "/", " x ", " & " so glued junk ("collab/") detaches
    .join(' ')
    .split(/\s+/)
    .filter((tok) => tok && !BREWERY_NOISE.has(tok.toLowerCase()))
    .join(' ')
    .trim();
}

// Fold a token for noise/dedup comparison: strip diacritics (incl. ł→l, via the shared
// helper), lowercase, drop non-alphanumerics (so "Co." -> "co", "Bałtycki" -> "baltycki").
function foldToken(tok: string): string {
  return stripDiacritics(tok).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build an Untappd search query from a shop brewery+name without doubling the brewery.
// Cleans the COMBINED "brewery name" string: strip legal-entity forms from the brewery
// (as stripBreweryNoise did), drop BREWERY_NOISE tokens, and dedup repeated tokens (by
// fold), keeping survivors in their original raw form. Fixes #126: a name that repeats
// the brewery ("Track Brewing Company Taking Shape" + "Track Brewing Co.") otherwise
// AND-searches duplicated terms and returns nothing. The raw name is used only as a
// last-resort non-empty fallback when cleaning removes everything and no brewery survives.
// Strip structural search noise from a raw brewery/name string before it becomes an
// Untappd (Algolia) query. Algolia ANDs every term, so bracketed adjunct lists, collab
// parentheticals, and ABV/spec strings over-constrain the search to zero hits (#236).
// The helper is shared by query and match normalization, so structural noise removed
// from the search query cannot be reintroduced by downstream name matching.
export function stripSearchNoise(s: string): string {
  return s
    // Drop a leading "<label> Series:" collection prefix that otherwise ANDs the
    // Algolia query to zero hits (#303). Anchored on the word "series" + a
    // separator, so names without a labelled series ("Time Series IPA") are kept.
    .replace(/^.*?\bseries\b\s*[:\-–—]\s*/iu, '')
    .replace(/\[[^\]]*\]/g, ' ')                     // [adjunct, lists]
    .replace(/\(([^)]*)\)/g, (_group, content: string) =>
      /^(?=[\p{L}\p{N}]*\d)[\p{L}\p{N}]+$/u.test(content) ? ` ${content} ` : ' ')
    // Keep compact digit-bearing identifiers such as (TAP04); drop (BBA), (collab …).
    .replace(/[[\](){}]/g, ' ')                      // stray/unbalanced brackets
    .replace(/[<>]?\s*\d+(?:[.,]\d+)?\s*%/g, ' ')    // <0,5%  4.5%  0,5 %
    .replace(/\d+(?:[.,]\d+)?\s*°/g, ' ')            // 24°
    .replace(/\b(?:alc|abv|ibu)\b/gi, ' ')           // spec labels
    .replace(/["“”„]/g, ' ')                        // wrapping display/straight quotes
    .replace(/\s*[.!?,;:]+\s*$/, '')                  // trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanSearchQuery(brewery: string, name: string): string {
  const cleanBrewery = stripSearchNoise(stripLegalForm(brewery));
  const cleanName = stripSearchNoise(name);

  // Brewery brand tokens: split collab separators (defensive — detaches glued junk like
  // "collab/"), then whitespace; drop BREWERY_NOISE and empty folds; dedup by fold.
  const brandTokens: string[] = [];
  const brandFolds = new Set<string>();
  for (const tok of cleanBrewery.split(COLLAB_SEP).join(' ').split(/\s+/)) {
    const f = foldToken(tok);
    if (!f || BREWERY_NOISE.has(f) || brandFolds.has(f)) continue;
    brandFolds.add(f);
    brandTokens.push(tok);
  }

  // Name tokens: whitespace split, "/" -> space (unambiguous collab slash); drop lone collab
  // connectors ("x"), empty folds, and BREWERY_NOISE anywhere. The name is NEVER split on " x "
  // (#270): a name beginning "x <partner>:" is a shop artifact, not a collab-brewery separator.
  const nameTokens: string[] = [];
  for (const tok of cleanName.replace(/\//g, ' ').split(/\s+/)) {
    const f = foldToken(tok);
    if (!f || f === 'x' || BREWERY_NOISE.has(f)) continue;
    nameTokens.push(tok);
  }

  // Strip only the leading and trailing runs of name tokens that duplicate a brewery brand token
  // (the "name restates the brewery" case: #126 leading, #155 trailing). Mid-name duplicates are
  // KEPT (#270 "Road"/"Upside") — Algolia collapses a repeated identical term to one, so keeping
  // them is harmless while dropping them destroyed the beer name.
  let start = 0;
  let end = nameTokens.length;
  while (start < end && brandFolds.has(foldToken(nameTokens[start]))) start++;
  while (end > start && brandFolds.has(foldToken(nameTokens[end - 1]))) end--;

  const out = [...brandTokens, ...nameTokens.slice(start, end)];
  // Last resort: never emit an empty query.
  return out.length ? out.join(' ') : (cleanName || cleanBrewery || name.trim());
}
