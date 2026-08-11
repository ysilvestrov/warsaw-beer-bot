import type { Translator } from '../i18n/types';
import { OUTSIDE_CITY, cityLabel } from '../domain/cities';

// Single place that turns a stored city slug into user-facing text: real cities carry
// a static label from the domain, the pseudo-city is a translated string (#399).
export function cityDisplayLabel(t: Translator, slug: string): string {
  return slug === OUTSIDE_CITY ? t('city.outside') : cityLabel(slug);
}
