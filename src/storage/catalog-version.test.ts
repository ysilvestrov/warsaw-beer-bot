import { catalogVersion, bumpCatalogVersion } from './catalog-version';
import { openDb } from './db';
import { migrate } from './schema';
import { recordLookupSuccess, recordLookupNotFound, upsertBeerByBid, ensureOrphan, applyHydratedRatings } from './beers';
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

    // #617: продакшн-мутатори рядка пива — ensureOrphan (вставка сироти) і upsertBeerByBid
    // (оновлення за bid). Тестовий seedBeer тут нічого не доводив би про продакшн.
    let v = catalogVersion();
    const id = ensureOrphan(db, {
      name: 'Atak Chmielu', brewery: 'Pinta', style: 'IPA', abv: 6.1, rating_global: 3.7,
      normalized_name: normalizeName('Atak Chmielu'),
      normalized_brewery: normalizeBrewery('Pinta'),
    });
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    upsertBeerByBid(db, {
      untappd_id: 222, name: 'Other', brewery: 'Pinta', style: null, abv: 5.0, rating_global: null,
      normalized_name: normalizeName('Other'), normalized_brewery: normalizeBrewery('Pinta'),
      untappd_id_source: 'checkin',
    });
    expect(catalogVersion()).toBeGreaterThan(v);

    v = catalogVersion();
    recordLookupSuccess(db, id, { bid: 111, style: 'IPA', abv: 6.1, global_rating: 3.9 }, '2026-01-01T00:00:00Z');
    expect(catalogVersion()).toBeGreaterThan(v);

    // #616: гідратор рейтингів (рядок уже має bid 111 після recordLookupSuccess вище).
    v = catalogVersion();
    applyHydratedRatings(db, new Map([[111, { global_rating: 4.1, style: 'IPA', abv: 6.1 }]]), [111], '2026-01-02T00:00:00Z');
    expect(catalogVersion()).toBeGreaterThan(v);
  });

  it('does NOT bump on timestamp/counter-only mutators', () => {
    const db = openDb(':memory:');
    migrate(db);
    const id = seedAtakChmielu(db);

    // #616: невідомий Algolia bid пише лише бекоф; повторна звірка без змін — лише штамп.
    const linked = seedBeer(db, {
      untappd_id: 333, name: 'Linked', brewery: 'Pinta', style: 'IPA', abv: 6.1, rating_global: 3.9,
      normalized_name: normalizeName('Linked'), normalized_brewery: normalizeBrewery('Pinta'),
    });
    expect(linked).toBeGreaterThan(0);
    const v = catalogVersion();
    recordLookupNotFound(db, id, '2026-01-01T00:00:00Z');
    applyHydratedRatings(db, new Map(), [333], '2026-01-01T00:00:00Z');
    applyHydratedRatings(db, new Map([[333, { global_rating: 3.9, style: 'IPA', abv: 6.1 }]]), [333], '2026-01-02T00:00:00Z');
    expect(catalogVersion()).toBe(v);
  });
});
