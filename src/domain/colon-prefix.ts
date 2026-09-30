import { baseNormalize, stripSearchNoise, NAME_COLLAB_SEP } from './normalize';

/**
 * #746 — Untappd beer names registered with a line/anniversary/series prefix followed
 * by a colon (`<prefix>: <tail>`), when the tap or menu lists only the tail.
 *
 * Colons in digital timestamps (6:15, 7:45) and alphanumeric code identifiers (AB:20)
 * are excluded. Only colons followed by whitespace (`:\s+`) separate prefix and tail.
 */
const DIGIT_OR_CODE_PREFIX = /^\d+:\d+/;

export function extractColonTails(beerName: string): string[] {
  if (DIGIT_OR_CODE_PREFIX.test(beerName)) return [];
  const parts = beerName.split(/:\s+/);
  if (parts.length < 2 || parts[0].trim().length === 0) return [];
  // For names with multiple colons (e.g. `Series: Subseries: Name`), emit each progressive tail.
  const tails: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    const tail = parts.slice(i).join(': ').trim();
    if (tail.length > 0 && !DIGIT_OR_CODE_PREFIX.test(tail)) tails.push(tail);
  }
  return tails;
}

export function isColonPrefixTailMatch(inputName: string, candidateBeerName: string): boolean {
  const tails = extractColonTails(candidateBeerName);
  if (tails.length === 0) return false;

  const inputSides = (NAME_COLLAB_SEP.test(inputName) ? inputName.split(NAME_COLLAB_SEP) : [inputName])
    .map((s) => baseNormalize(stripSearchNoise(s)))
    .filter(Boolean);
  if (inputSides.length === 0) return false;

  const normalizedTails = tails
    .map((t) => baseNormalize(stripSearchNoise(t)))
    .filter(Boolean);

  return normalizedTails.some((t) => inputSides.includes(t));
}
