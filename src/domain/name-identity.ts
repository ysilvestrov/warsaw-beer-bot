import { baseNormalize, normalizeBrewery, normalizeName } from './normalize';
import { stripBreweryFromName } from './matcher';

/**
 * #505 — a beer name's identity, and whether we had to dig it back out.
 *
 * `normalizeName` is one filter chaining STYLE_WORDS, SPEC_LABEL_WORDS and
 * isNumericNoise. Each predicate removes real noise; between them they can remove
 * every token that says *which* beer this is, leaving either the empty string
 * ("Weizen") or the bare brewery brand ("Kronenbourg 1664" -> "kronenbourg").
 * A name in that state cannot discriminate, and the matcher then decides on some
 * other property — which is how a 0.5% ABV typo picked a different product (#487).
 */
export interface NameIdentity {
  /** The identity tokens, brewery echo removed. */
  value: string;
  /** True when the filter destroyed everything and we fell back to unfiltered tokens. */
  restored: boolean;
}

/**
 * Identity means "a token that is not part of the brewery brand". Testing for the
 * EMPTY STRING is not enough: `stripBreweryFromName` refuses to strip a name to
 * nothing, so "Kronenbourg 1664" survives as the non-empty but identity-less
 * "kronenbourg".
 */
function hasIdentity(norm: string, breweryNorm: string): boolean {
  const brandTokens = new Set(breweryNorm.split(' ').filter(Boolean));
  return norm.split(' ').filter(Boolean).some((token) => !brandTokens.has(token));
}

/**
 * Today's value, unless the filter left nothing beyond the brand — then re-derive
 * from the unfiltered tokens. Self-limiting by construction: the fallback can only
 * fire where the filtered form has nothing to lose, so every name the filter was
 * built for ("Buzdygan Rozkoszy IPA") is untouched.
 *
 * `breweryNorm` must already be normalized (`normalizeBrewery`), because callers
 * on the hot path have it in hand and re-normalizing per candidate is wasted work.
 */
export function nameIdentity(rawName: string, breweryNorm: string): NameIdentity {
  const filtered = normalizeName(rawName);
  if (hasIdentity(filtered, breweryNorm)) {
    return { value: stripBreweryFromName(filtered, breweryNorm), restored: false };
  }
  const unfiltered = baseNormalize(rawName);
  if (hasIdentity(unfiltered, breweryNorm)) {
    return { value: stripBreweryFromName(unfiltered, breweryNorm), restored: true };
  }
  // Nothing to recover — the name really is only the brand. #306 owns that case.
  return { value: stripBreweryFromName(filtered, breweryNorm), restored: false };
}

/** A search candidate's identity, keyed on the candidate's OWN brewery. */
export function candidateIdentity(beerName: string, breweryName: string): NameIdentity {
  return nameIdentity(beerName, normalizeBrewery(breweryName));
}
