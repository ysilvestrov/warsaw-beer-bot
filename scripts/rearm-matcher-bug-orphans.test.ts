import { describe, expect, it } from 'vitest';
import type { DB } from '../src/storage/db';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeBrewery, normalizeName } from '../src/domain/normalize';
import { applyRearm, selectRearmTargets, selectRearmTargetsByIds } from './rearm-matcher-bug-orphans';

interface SeedFailure {
  name: string;
  brewery: string;
  untappd_id?: number | null;
  untappd_lookup_count?: number;
  candidates_count?: number;
  review_class?: 'parser_bug' | 'matcher_bug';
}

function fresh(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function insertFailure(db: DB, seed: SeedFailure): number {
  const result = db
    .prepare(
      `INSERT INTO beers
         (untappd_id, name, brewery, style, abv, rating_global,
          normalized_name, normalized_brewery, untappd_lookup_at, untappd_lookup_count,
          rating_refresh_at, rating_refresh_count)
       VALUES
         (@untappd_id, @name, @brewery, NULL, NULL, NULL,
          @normalized_name, @normalized_brewery, @untappd_lookup_at, @untappd_lookup_count,
          NULL, 0)`,
    )
    .run({
      untappd_id: seed.untappd_id ?? null,
      name: seed.name,
      brewery: seed.brewery,
      normalized_name: normalizeName(seed.name),
      normalized_brewery: normalizeBrewery(seed.brewery),
      untappd_lookup_at: '2026-07-10T12:00:00.000Z',
      untappd_lookup_count: seed.untappd_lookup_count ?? 3,
    });
  const beerId = Number(result.lastInsertRowid);

  db.prepare(
    `INSERT INTO enrich_failures
       (beer_id, brewery, name, search_url, outcome, candidates_count,
        candidates_summary, fail_count, last_at, source_url, review_class,
        review_note, reviewed_at)
     VALUES
       (@beer_id, @brewery, @name, @search_url, 'not_found', @candidates_count,
        @candidates_summary, 1, @last_at, @source_url, @review_class,
        @review_note, @reviewed_at)`,
  ).run({
    beer_id: beerId,
    brewery: seed.brewery,
    name: seed.name,
    search_url: 'https://untappd.com/search?q=test',
    candidates_count: seed.candidates_count ?? 2,
    candidates_summary: 'Candidate Brewery — Candidate Beer',
    last_at: '2026-07-10T12:00:00.000Z',
    source_url: 'https://example.com/beer',
    review_class: seed.review_class ?? 'matcher_bug',
    review_note: 'reviewed',
    reviewed_at: '2026-07-10T13:00:00.000Z',
  });

  return beerId;
}

describe('selectRearmTargets', () => {
  it('selects candidate-present matcher failures in deterministic id order', () => {
    const db = fresh();
    try {
      const firstId = insertFailure(db, { name: 'First Match', brewery: 'Brewery One' });
      insertFailure(db, {
        name: 'No Candidates',
        brewery: 'Brewery Two',
        candidates_count: 0,
      });
      insertFailure(db, {
        name: 'Parser Failure',
        brewery: 'Brewery Three',
        review_class: 'parser_bug',
      });
      insertFailure(db, {
        name: 'Untried',
        brewery: 'Brewery Four',
        untappd_lookup_count: 0,
      });
      insertFailure(db, {
        name: 'Already Matched',
        brewery: 'Brewery Five',
        untappd_id: 12345,
      });
      const lastId = insertFailure(db, {
        name: 'Last Match',
        brewery: 'Brewery Six',
        untappd_lookup_count: 4,
      });

      expect(selectRearmTargets(db)).toEqual([
        {
          id: firstId,
          brewery: 'Brewery One',
          name: 'First Match',
          untappd_lookup_count: 3,
        },
        {
          id: lastId,
          brewery: 'Brewery Six',
          name: 'Last Match',
          untappd_lookup_count: 4,
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('selectRearmTargetsByIds', () => {
  it('returns orphan rows for the given ids in id order, ignoring class/candidate filters', () => {
    const db = fresh();
    try {
      const parserZero = insertFailure(db, {
        name: 'Parser Zero',
        brewery: 'Brewery Zero',
        review_class: 'parser_bug',
        candidates_count: 0,
      });
      const matched = insertFailure(db, {
        name: 'Already Matched',
        brewery: 'Brewery Matched',
        untappd_id: 999,
      });
      const plain = insertFailure(db, { name: 'Plain Orphan', brewery: 'Brewery Plain' });
      const missing = plain + 10_000;

      expect(selectRearmTargetsByIds(db, [plain, parserZero, matched, missing])).toEqual([
        { id: parserZero, brewery: 'Brewery Zero', name: 'Parser Zero', untappd_lookup_count: 3 },
        { id: plain, brewery: 'Brewery Plain', name: 'Plain Orphan', untappd_lookup_count: 3 },
      ]);
    } finally {
      db.close();
    }
  });

  it('returns an empty array for an empty id list', () => {
    const db = fresh();
    try {
      expect(selectRearmTargetsByIds(db, [])).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('applyRearm', () => {
  it('resets lookup backoff and leaves no targets on a second selection', () => {
    const db = fresh();
    try {
      const beerId = insertFailure(db, {
        name: 'Retry Me',
        brewery: 'Retry Brewery',
        untappd_lookup_count: 4,
      });
      const targets = selectRearmTargets(db);

      expect(applyRearm(db, targets)).toBe(1);
      expect(
        db
          .prepare(
            `SELECT untappd_lookup_count, untappd_lookup_at
               FROM beers
              WHERE id = ?`,
          )
          .get(beerId),
      ).toEqual({ untappd_lookup_count: 0, untappd_lookup_at: null });
      expect(selectRearmTargets(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
