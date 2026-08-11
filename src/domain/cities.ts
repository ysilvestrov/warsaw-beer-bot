export interface City {
  slug: string;
  label: string;
}

// Curated. `slug` is the ontap.pl city-index path segment (ontap.pl/<slug>).
// All slugs below were validated against live ontap.pl pages (each parses to >0 pub
// subdomains). NB: ontap has no "trojmiasto" pub page — the Tri-City is split into
// gdansk/gdynia/sopot; we list Gdańsk (the largest, ~9 pubs). A wrong slug returns a
// city-selector page that parses to an EMPTY index, not an error — re-validate on change.
export const CITIES: readonly City[] = [
  { slug: 'warszawa', label: 'Warszawa' },
  { slug: 'krakow', label: 'Kraków' },
  { slug: 'wroclaw', label: 'Wrocław' },
  { slug: 'poznan', label: 'Poznań' },
  { slug: 'gdansk', label: 'Gdańsk' },
  { slug: 'lodz', label: 'Łódź' },
  { slug: 'katowice', label: 'Katowice' },
  { slug: 'lublin', label: 'Lublin' },
  { slug: 'szczecin', label: 'Szczecin' },
];

export const DEFAULT_CITY = 'warszawa';

// Pseudo-city for users who are not in Poland (extension-only users, #399).
// Deliberately NOT in CITIES: that array is also the crawl list for refreshOntap,
// and `outside-pl` is not an ontap.pl path segment.
export const OUTSIDE_CITY = 'outside-pl';

const SLUGS = new Set(CITIES.map((c) => c.slug));

export function isKnownCity(slug: string): boolean {
  return SLUGS.has(slug);
}

// A slug the user is allowed to pick in /city: a real ontap city, or the pseudo-city.
// `isKnownCity` stays the narrower predicate — it also answers "are city-scoped
// commands available for this user?".
export function isSelectableCity(slug: string): boolean {
  return isKnownCity(slug) || slug === OUTSIDE_CITY;
}

export function cityLabel(slug: string): string {
  return CITIES.find((c) => c.slug === slug)?.label ?? slug;
}
