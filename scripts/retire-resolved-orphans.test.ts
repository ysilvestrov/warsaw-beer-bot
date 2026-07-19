import { describe, expect, it } from 'vitest';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeBrewery, normalizeName } from '../src/domain/normalize';
import { selectAutoRetireTargets, selectIdTargets, applyRetire } from './retire-resolved-orphans';

interface Seed {
  name: string;
  brewery: string;
  style?: string | null;
  untappd_id?: number | null;
  review_class?: 'parser_bug' | 'matcher_bug' | 'not_on_untappd' | 'wontfix' | null;
  retired_at?: string | null;
}

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function seed(db: DB, s: Seed): number {
  const info = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global, normalized_name, normalized_brewery)
     VALUES (@untappd_id, @name, @brewery, @style, NULL, NULL, @nn, @nb)`,
  ).run({
    untappd_id: s.untappd_id ?? null, name: s.name, brewery: s.brewery, style: s.style ?? null,
    nn: normalizeName(s.name), nb: normalizeBrewery(s.brewery),
  });
  const id = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
        fail_count, last_at, source_url, review_class, retired_at)
     VALUES (?, ?, ?, 'u', 'not_found', 0, '', 1, '2026-07-01T00:00:00Z', '', ?, ?)`,
  ).run(id, s.brewery, s.name, s.review_class ?? null, s.retired_at ?? null);
  return id;
}

describe('selectAutoRetireTargets', () => {
  it('selects classified orphans the current non-beer filter now rejects', () => {
    const db = fresh();
    const wine = seed(db, { name: 'Biały bez', brewery: 'WINO KARPATIA', review_class: 'parser_bug' });
    seed(db, { name: 'Hazy IPA', brewery: 'Real Brewery', review_class: 'parser_bug' });
    const ids = selectAutoRetireTargets(db).map((t) => t.beer_id);
    expect(ids).toEqual([wine]);
  });

  it('excludes matched beers, untriaged rows, and already-retired rows', () => {
    const db = fresh();
    seed(db, { name: 'Wino A', brewery: 'WINO A', review_class: 'parser_bug', untappd_id: 555 });
    seed(db, { name: 'Wino B', brewery: 'WINO B', review_class: null });
    seed(db, { name: 'Wino C', brewery: 'WINO C', review_class: 'wontfix', retired_at: '2026-07-01T00:00:00Z' });
    expect(selectAutoRetireTargets(db)).toEqual([]);
  });
});

describe('selectIdTargets', () => {
  it('returns only existing, orphan, not-yet-retired rows for the given ids', () => {
    const db = fresh();
    const a = seed(db, { name: 'Forest IPA', brewery: 'Forest IPA Brewery', review_class: 'parser_bug' });
    const matched = seed(db, { name: 'M', brewery: 'M Brew', review_class: 'parser_bug', untappd_id: 9 });
    const retired = seed(db, { name: 'R', brewery: 'R Brew', review_class: 'parser_bug', retired_at: '2026-07-01T00:00:00Z' });
    const got = selectIdTargets(db, [a, matched, retired, 12345]).map((t) => t.beer_id);
    expect(got).toEqual([a]);
  });
});

describe('applyRetire', () => {
  it('retires the targets and is idempotent', () => {
    const db = fresh();
    const a = seed(db, { name: 'Biały bez', brewery: 'WINO KARPATIA', review_class: 'parser_bug' });
    const targets = selectAutoRetireTargets(db);
    expect(applyRetire(db, targets, 'retired: current non-beer filter rejects')).toBe(1);
    const got = db.prepare('SELECT retired_at, review_class FROM enrich_failures WHERE beer_id = ?').get(a) as any;
    expect(got.retired_at).not.toBeNull();
    expect(got.review_class).toBe('parser_bug');
    expect(selectAutoRetireTargets(db)).toEqual([]);
  });
});
