import { stripSearchNoise, baseNormalize } from './normalize';
import { stripBreweryFromName } from './matcher';

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
