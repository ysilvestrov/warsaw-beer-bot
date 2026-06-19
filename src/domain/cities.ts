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
];

export const DEFAULT_CITY = 'warszawa';

const SLUGS = new Set(CITIES.map((c) => c.slug));

export function isKnownCity(slug: string): boolean {
  return SLUGS.has(slug);
}

export function cityLabel(slug: string): string {
  return CITIES.find((c) => c.slug === slug)?.label ?? slug;
}
