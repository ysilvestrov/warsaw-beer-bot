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
