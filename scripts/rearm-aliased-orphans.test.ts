import { describe, it, expect } from 'vitest';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeName, normalizeBrewery } from '../src/domain/normalize';
import { selectRearmTargets, applyRearm } from './rearm-aliased-orphans';

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

interface SeedBeer {
  name: string;
  brewery: string;
  untappd_id?: number | null;
  untappd_lookup_count: number;
  untappd_lookup_at?: string | null;
}

function insertBeer(db: DB, b: SeedBeer): void {
  db.prepare(
    `INSERT INTO beers
       (untappd_id, name, brewery, style, abv, rating_global,
        normalized_name, normalized_brewery, untappd_lookup_at, untappd_lookup_count)
     VALUES
       (@untappd_id, @name, @brewery, NULL, NULL, NULL,
        @normalized_name, @normalized_brewery, @untappd_lookup_at, @untappd_lookup_count)`,
  ).run({
    untappd_id: b.untappd_id ?? null,
    name: b.name,
    brewery: b.brewery,
    normalized_name: normalizeName(b.name),
    normalized_brewery: normalizeBrewery(b.brewery),
    untappd_lookup_at: b.untappd_lookup_at ?? null,
    untappd_lookup_count: b.untappd_lookup_count,
  });
}

function seedAll(db: DB): void {
  // alias-covered, attempted orphan -> SELECTED
  insertBeer(db, { name: 'Hoppiness Pils', brewery: 'Nepomucen Brewery', untappd_lookup_count: 4, untappd_lookup_at: '2026-06-23T06:30:18.348Z' });
  // second alias-covered, attempted orphan -> also SELECTED
  insertBeer(db, { name: 'SZOSA', brewery: 'Nepomucen Brewery', untappd_lookup_count: 3, untappd_lookup_at: '2026-06-20T00:00:00.000Z' });
  // alias-covered but untried (count 0) -> not selected
  insertBeer(db, { name: 'Tonkowiec Bałtycki', brewery: 'Starkaft Brewery', untappd_lookup_count: 0 });
  // plain collab, attempted -> not selected (no curated alias)
  insertBeer(db, { name: 'Some Hazy', brewery: 'Stu Mostów / Ophiussa', untappd_lookup_count: 2 });
  // already matched alias-brewery beer -> not selected (has untappd_id)
  insertBeer(db, { name: 'Black Grodzisz', brewery: 'Nepomucen Brewery', untappd_id: 999, untappd_lookup_count: 4 });
}

describe('selectRearmTargets', () => {
  it('selects only attempted, alias-covered orphans', () => {
    const db = fresh();
    seedAll(db);
    const targets = selectRearmTargets(db);
    expect(targets.map((t) => t.name).sort()).toEqual(['Hoppiness Pils', 'SZOSA']);
    expect(targets.find((t) => t.name === 'Hoppiness Pils')!.untappd_lookup_count).toBe(4);
  });
});

describe('applyRearm', () => {
  it('resets count + lookup_at for all targets and is idempotent', () => {
    const db = fresh();
    seedAll(db);
    const targets = selectRearmTargets(db);
    expect(applyRearm(db, targets)).toBe(2);

    const rowHoppiness = db
      .prepare('SELECT untappd_lookup_count AS c, untappd_lookup_at AS a FROM beers WHERE name = ?')
      .get('Hoppiness Pils') as { c: number; a: string | null };
    expect(rowHoppiness.c).toBe(0);
    expect(rowHoppiness.a).toBeNull();

    const rowSzosa = db
      .prepare('SELECT untappd_lookup_count AS c, untappd_lookup_at AS a FROM beers WHERE name = ?')
      .get('SZOSA') as { c: number; a: string | null };
    expect(rowSzosa.c).toBe(0);
    expect(rowSzosa.a).toBeNull();

    // count > 0 filter now excludes all re-armed rows -> second pass is a no-op.
    expect(selectRearmTargets(db)).toEqual([]);
  });
});
