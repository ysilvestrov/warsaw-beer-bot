import { stripSearchNoise, baseNormalize, BREWERY_NOISE } from './normalize';

/**
 * Strip a brewery duplicated into a normalized name (e.g. title "PRIMÁTOR Free Mother
 * In Law" with brewery "Primátor", or a trailing "… Trzech Kumpli"). Removes every
 * non-overlapping contiguous run of the brewery tokens — at ANY position — but never
 * strips the name to empty, then trims any leftover leading/trailing BREWERY_NOISE.
 */
export function stripBreweryFromName(nameNorm: string, breweryNorm: string): string {
  if (!breweryNorm) return nameNorm;
  const bt = breweryNorm.split(' ').filter(Boolean);
  if (!bt.length) return nameNorm;
  const nt = nameNorm.split(' ').filter(Boolean);
  for (let i = 0; i + bt.length <= nt.length; ) {
    if (nt.length - bt.length >= 1 && bt.every((t, j) => nt[i + j] === t)) {
      nt.splice(i, bt.length);
    } else {
      i++;
    }
  }
  while (nt.length > 1 && BREWERY_NOISE.has(nt[0])) nt.shift();
  while (nt.length > 1 && BREWERY_NOISE.has(nt[nt.length - 1])) nt.pop();
  return nt.join(' ');
}

/**
 * #663 — clean style identity for names that normalize to empty (`normalizeName(name) === ''`).
 *
 * `normalizeName` removes style words, degree grades, spec labels, and numeric noise.
 * When a tap name consists only of those tokens (`Pils 12°`, `Stout`, `LAGER 10.5°`),
 * `normalizeName` collapses it to `''`.
 *
 * `styleNameIdentity` extracts the underlying style representation by:
 * 1. Stripping search noise (grades like `12°`, `10.5%`, packaging/brackets like `(MBC)`);
 * 2. Base-normalizing the remaining text (lowercase, ASCII transliteration);
 * 3. Stripping any brewery brand echo.
 */
export function styleNameIdentity(rawName: string, breweryNorm: string): string {
  const clean = baseNormalize(stripSearchNoise(rawName));
  return stripBreweryFromName(clean, breweryNorm).trim();
}
