export interface City {
  slug: string;
  label: string;
}

// Curated. `slug` is the ontap.pl city-index path segment (ontap.pl/<slug>).
// Confirm each slug against a captured page before launch — a wrong slug yields
// an empty index, not an error.
export const CITIES: readonly City[] = [
  { slug: 'warszawa', label: 'Warszawa' },
  { slug: 'krakow', label: 'Kraków' },
  { slug: 'wroclaw', label: 'Wrocław' },
  { slug: 'poznan', label: 'Poznań' },
  { slug: 'trojmiasto', label: 'Trójmiasto' },
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
