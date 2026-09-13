import { catalogVersion, bumpCatalogVersion } from './catalog-version';
import { openDb } from './db';
import { migrate } from './schema';
import { recordLookupSuccess, recordRatingSuccess, recordLookupNotFound, recordRatingNotFound } from './beers';
import { seedBeer } from './seed-beer.testing';
import { normalizeName, normalizeBrewery } from '../domain/normalize';

describe('catalog-version', () => {
  it('bumpCatalogVersion increments the version', () => {
    const before = catalogVersion();
    bumpCatalogVersion();
    expect(catalogVersion()).toBe(before + 1);
  });
});

function seedAtakChmielu(db: ReturnType<typeof openDb>) {
  return seedBeer(db, {
    name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA', abv: 6.1, rating_global: 3.7,
    normalized_name: normalizeName('Atak Chmielu'),
    normalized_brewery: normalizeBrewery('Pinta'),
  });
}

describe('catalog-version — storage instrumentation', () => {
  it('bumps on matchable-field mutators', () => {
    const db = openDb(':memory:');
    migrate(db);

    let v = catalogVersion();
    const id = seedAtakChmielu(db);           // seedBeer (insert)
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    seedBeer(db, {                   // seedBeer (update — same normalized keys)
      name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA', abv: 6.2, rating_global: 3.8,
      normalized_name: normalizeName('Atak Chmielu'),
      normalized_brewery: normalizeBrewery('Pinta'),
    });
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    recordLookupSuccess(db, id, { bid: 111, style: 'IPA', abv: 6.1, global_rating: 3.9 }, '2026-01-01T00:00:00Z');
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    recordRatingSuccess(db, id, 4.1);
    expect(catalogVersion()).toBeGreaterThan(v);
  });

  it('does NOT bump on timestamp/counter-only mutators', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = seedAtakChmielu(db);

    const v = catalogVersion();
    recordLookupNotFound(db, id, '2026-01-01T00:00:00Z');
    recordRatingNotFound(db, id, '2026-01-01T00:00:00Z');
    expect(catalogVersion()).toBe(v);
  });
});
