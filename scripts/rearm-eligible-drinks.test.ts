import { describe, expect, it, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { normalizeBrewery, normalizeName } from '../src/domain/normalize';
import { IDS, main } from './rearm-eligible-drinks';

interface Seed {
  id: number;
  brewery: string;
  name: string;
  retired_at: string | null;
}

function seedTempDb(rows: Seed[]): { dbPath: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rearm-eligible-drinks-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  migrate(db);
  for (const r of rows) {
    db.prepare(
      `INSERT INTO beers (id, untappd_id, name, brewery, style, abv, rating_global, normalized_name, normalized_brewery)
       VALUES (@id, NULL, @name, @brewery, NULL, NULL, NULL, @nn, @nb)`,
    ).run({
      id: r.id, name: r.name, brewery: r.brewery,
      nn: normalizeName(r.name), nb: normalizeBrewery(r.brewery),
    });
    db.prepare(
      `INSERT INTO enrich_failures
         (beer_id, brewery, name, search_url, outcome, candidates_count, candidates_summary,
          fail_count, last_at, source_url, review_class, retired_at)
       VALUES (?, ?, ?, 'u', 'not_found', 0, '', 1, '2026-08-20T00:00:00Z', '', 'not_a_beer', ?)`,
    ).run(r.id, r.brewery, r.name, r.retired_at);
  }
  db.close();
  return { dbPath, dir };
}

describe('rearm-eligible-drinks (#430 F2): a retired row must not be corrupted', () => {
  let dirToClean: string | null = null;

  afterEach(() => {
    if (dirToClean) fs.rmSync(dirToClean, { recursive: true, force: true });
    dirToClean = null;
    vi.restoreAllMocks();
  });

  it('dry run: names the retired row as skipped and leaves the live row eligible for re-arm, untouched by this run', () => {
    const [liveId, retiredId] = IDS; // real ids from the #430 repair list: 258, 298
    const { dbPath, dir } = seedTempDb([
      { id: liveId, brewery: 'Chyliczki', name: 'Cydr Chyliczki - Japoński Sad', retired_at: null },
      { id: retiredId, brewery: 'Dzik', name: 'Cydr Perry', retired_at: '2026-08-21T00:00:00.000Z' },
    ]);
    dirToClean = dir;

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });

    main([dbPath]); // dry run — no --apply

    const output = lines.join('\n');
    // The retired row must be named, not silently dropped from the count.
    expect(output).toContain(String(retiredId));
    expect(output.toLowerCase()).toContain('retired');
    // The live row is still reported as a normal target.
    expect(output).toContain(String(liveId));
    // Verified against production 2026-08-22: 0 of the 16 real ids are retired, so
    // this fixture (1 retired) is deliberately NOT the shape of a clean prod run —
    // it exists to prove the skip-and-name path, which prod exercises zero times.
    expect(output).toMatch(/rows matching the id list AND still not_a_beer: 1 of 16/);

    // Dry run: neither row was written.
    const db = openDb(dbPath);
    const live = db.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?').get(liveId) as
      { review_class: string | null };
    const retired = db.prepare('SELECT review_class, retired_at FROM enrich_failures WHERE beer_id = ?').get(retiredId) as
      { review_class: string | null; retired_at: string | null };
    db.close();
    expect(live.review_class).toBe('not_a_beer');
    expect(retired.review_class).toBe('not_a_beer');
    expect(retired.retired_at).not.toBeNull();
  });

  it('--apply: re-arms the live row but leaves the retired row and its audit verdict untouched', () => {
    const [liveId, retiredId] = IDS;
    const { dbPath, dir } = seedTempDb([
      { id: liveId, brewery: 'Chyliczki', name: 'Cydr Chyliczki - Japoński Sad', retired_at: null },
      { id: retiredId, brewery: 'Dzik', name: 'Cydr Perry', retired_at: '2026-08-21T00:00:00.000Z' },
    ]);
    dirToClean = dir;

    vi.spyOn(console, 'log').mockImplementation(() => {});
    main([dbPath, '--apply']);

    const db = openDb(dbPath);
    const live = db.prepare('SELECT review_class FROM enrich_failures WHERE beer_id = ?').get(liveId) as
      { review_class: string | null };
    const retired = db.prepare('SELECT review_class, retired_at FROM enrich_failures WHERE beer_id = ?').get(retiredId) as
      { review_class: string | null; retired_at: string | null };
    db.close();

    expect(live.review_class).toBeNull(); // re-armed
    expect(retired.review_class).toBe('not_a_beer'); // untouched — audit verdict preserved
    expect(retired.retired_at).not.toBeNull(); // untouched
  });
});
