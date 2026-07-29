// A spec atom is one strength/grade token: "12°", "5,8%%", "<0,5%", "N/D°", "3;5%".
// Shops emit doubled unit characters ("%%", "°°", "%°") and ";" for a decimal comma.
const SPEC_ATOM = String.raw`[<>]?\s*(?:\d+(?:[.,;]\d+)?|N\/D)\s*[°%]{1,2}`;
// A truncated tail, i.e. an atom whose unit was cut off by the shop: "…12,5°·4".
const SPEC_TRUNCATED = String.raw`[<>]?\s*\d+(?:[.,;]\d+)?`;
// Atoms are joined by a mid-dot ONLY. Space-joined atoms are NOT chained, so an
// interior spec that is part of the name ("Litovel Pomelo 0% 12°·<0,5%") survives.
const SPEC_SEPARATOR = String.raw`\s*[·•∙]\s*`;
// Anchored to the end of the string: an interior degree ("La 150° Bionda") is never touched.
const TRAILING_SPEC = new RegExp(
  String.raw`\s+(${SPEC_ATOM})(?:${SPEC_SEPARATOR}(?:${SPEC_ATOM}|${SPEC_TRUNCATED}))*\s*$`,
  'iu',
);
// A °Plato grade: numeric, no "<"/">" bound, and its LAST unit character is a degree sign.
// This accepts the mangled shop forms "12°°" and "11,8%°" and normalizes both to "12°"/"11,8°".
const GRADE_ATOM = /^(\d+(?:[.,]\d+)?)\s*[°%]*°$/u;

// Remove a trailing strength/spec block from a tap name, preserving a °Plato grade.
// #306: the grade is part of the identity ("Konrad 10°" ≠ "Konrad 12°"), so it stays in
// the name; the search layer strips it on its own (`stripSearchNoise`) while the czech-grade
// stage (#321) reads it back from the raw name. Never returns an empty string.
export function stripTrailingSpec(raw: string): string {
  const s = raw.trim();
  const match = s.match(TRAILING_SPEC);
  if (!match) return s;
  const grade = match[1].trim().match(GRADE_ATOM);
  const cleaned = `${s.slice(0, match.index)}${grade ? ` ${grade[1]}°` : ''}`.trim();
  return cleaned || s;
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compact(raw: string): string {
  return raw.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function normalized(raw: string): string {
  return compact(raw).toLowerCase();
}

// Brewery label without its trailing legal/kind word, e.g. "Pinta Brewery" → "Pinta".
export function breweryCore(raw: string): string {
  return compact(raw)
    .replace(/\s+(?:brewery|browar|brasserie|brouwerij|brauerei|pivovar|birrificio)$/iu, '')
    .trim();
}

function stripLeadingCider(raw: string): string {
  return compact(raw).replace(/^(?:cydr|cider)(?:\s+|$)/iu, '').trim();
}

// Brewery values that are not breweries: a shop location, an ingredient list, or pure
// punctuation. #306: these clear the brewery FIELD; the beer itself is kept, because the
// matcher supports an empty input brewery (relaxed pool, exact-name-only — #149).
const POLLUTED_BREWERIES = new Set([
  'w brzesku brewery',
  'w brzesku',
  'vaisiu sultys',
]);

function isPunctuationOnly(raw: string): boolean {
  const core = breweryCore(raw);
  return core !== '' && !/[\p{L}\p{N}]/u.test(core);
}

export interface TapFields {
  brewery: string;
  name: string;
}

// Normalize the brewery field and any brewery-derived noise inside the name.
export function sanitizeBrewery(breweryRef: string | null, beerRef: string): TapFields {
  const brewery = compact(breweryRef ?? '');
  const name = compact(beerRef);
  const breweryNorm = normalized(brewery);

  if (POLLUTED_BREWERIES.has(breweryNorm) || isPunctuationOnly(brewery)) {
    return { brewery: '', name };
  }

  if (breweryNorm === 'cydr dzik' || breweryNorm === 'cydr dzik brewery') {
    if (normalized(name) === 'polski cydr') return { brewery: 'Cydrownia', name: 'Dzik' };
    const ciderName = stripLeadingCider(name);
    if (!ciderName) return { brewery, name };
    return { brewery: 'Cydrownia', name: `Dzik ${ciderName}` };
  }

  if (breweryNorm === 'cydr flirt tradycynis') {
    const ciderName = stripLeadingCider(name);
    return {
      brewery: 'Kauno Alus',
      name: ciderName ? `Tradycynis Cydr Flirt ${ciderName}` : 'Tradycynis Cydr Flirt',
    };
  }

  const core = breweryCore(brewery);
  if (core) {
    const ciderPrefix = new RegExp(`^(?:cydr|cider)\\s+${escapeRegExp(core)}\\s*[-–—:]\\s*`, 'iu');
    const stripped = name.replace(ciderPrefix, '').trim();
    if (stripped) return { brewery, name: stripped };
  }

  return { brewery, name };
}

// Drop a leading brewery prefix from a tap title. Both the full label ("PINTA Brewery ")
// and its core ("PINTA ") are tried, longest first. #306: when the title IS the brand
// ("Guinness Brewery" / "Guinness"), the name is kept as-is — emptying it here is what
// used to make single-brand taps disappear at ingest.
export function dedupeBreweryPrefix(name: string, breweryRef: string | null): string {
  const brewery = compact(breweryRef ?? '');
  if (!brewery) return name;
  const prefixes = [brewery, breweryCore(brewery)]
    .filter((p) => p !== '')
    .sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (name.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
      const remainder = name.slice(prefix.length + 1).trim();
      if (remainder) return remainder;
    }
  }
  return name;
}

// Turn an <h4> tap title into a beer name: "Harpagan Brewery Buzdygan 24°·8,5%" → "Buzdygan 24°".
export function extractBeerName(h4Text: string, breweryRef: string | null): string {
  return dedupeBreweryPrefix(stripTrailingSpec(compact(h4Text)), breweryRef);
}
