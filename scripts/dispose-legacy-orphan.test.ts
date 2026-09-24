import { openDb } from '../src/storage/db';
import { migrate } from '../src/storage/schema';
import { findActiveDispositionForBeer } from '../src/storage/legacy-orphan-dispositions';
import { parseDispositionCliArgs, runDisposeLegacyOrphan } from './dispose-legacy-orphan';

const args = [
  '--beer', '29955', '--issue', '677', '--card-brewery', 'De Cam',
  '--card-name', 'Abrikoos 2018', '--card-abv', '6',
  '--reason', 'No defensible bid for old card',
  '--evidence', 'https://example.com/issue/677#investigation',
  '--operator', 'maintainer',
];

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  db.prepare(`INSERT INTO beers (id, brewery, name, abv, normalized_brewery, normalized_name)
    VALUES (29955, 'De Cam', 'Abrikoos 2018', 6, 'de cam', 'abrikoos')`).run();
  db.prepare(`INSERT INTO enrich_failures
    (beer_id, brewery, name, search_url, source_url, outcome, candidates_count,
     candidates_summary, fail_count, last_at, review_class, issue_number)
    VALUES (29955, 'De Cam', 'Abrikoos 2018', '', 'https://flasker.com.ua/',
      'not_found', 0, '', 1, '2026-09-23T00:00:00Z', 'parser_bug', 677)`).run();
  return db;
}

describe('dispose-legacy-orphan CLI (#695)', () => {
  it('requires exact explicit arguments and separates activate from reopen', () => {
    expect(parseDispositionCliArgs(args)).toMatchObject({
      mode: 'activate', apply: false,
      input: { beerId: 29955, issueNumber: 677, cardAbv: 6 },
    });
    expect(parseDispositionCliArgs(args.map((v) => v === '6' ? 'absent' : v)))
      .toMatchObject({ input: { cardAbv: null } });
    expect(parseDispositionCliArgs(args.map((v) => v === '6' ? '0' : v)))
      .toMatchObject({ input: { cardAbv: 0 } });
    const reopen = ['--reopen', '1', '--reason', 'New evidence',
      '--evidence', 'https://example.com/new', '--operator', 'maintainer'];
    expect(parseDispositionCliArgs(reopen)).toMatchObject({
      mode: 'reopen', input: { episodeId: 1 }, apply: false,
    });
    for (const invalid of [
      [...args, '--beer', '9'], [...args, '--unknown'],
      args.filter((v) => v !== '29955'),
      args.map((v) => v === '29955' ? '0' : v),
      args.map((v) => v === '6' ? '-1' : v),
      args.map((v) => v === '6' ? '100.01' : v),
      args.map((v) => v === '6' ? 'NaN' : v),
      args.map((v) => v === 'https://example.com/issue/677#investigation' ? 'file:///tmp/x' : v),
      [...reopen, '--beer', '29955'],
    ]) expect(() => parseDispositionCliArgs(invalid)).toThrow();
  });

  it('prints an exact dry run without writes, applies, and audits a repeat', () => {
    const db = fixture();
    const lines: string[] = [];
    runDisposeLegacyOrphan(args, { db, print: (line) => lines.push(line) });
    expect(JSON.parse(lines[0])).toMatchObject({
      apply: false, readyToApply: true, schemaVersion: 36,
      key: { breweryText: 'de cam', nameText: 'abrikoos 2018', abvKey: '6' },
      orphan: { id: 29955 }, failure: { issueNumber: 677 },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_orphan_dispositions').get())
      .toEqual({ n: 0 });
    runDisposeLegacyOrphan([...args, '--apply'], { db, print: (line) => lines.push(line) });
    expect(findActiveDispositionForBeer(db, 29955)).toMatchObject({
      reason: 'No defensible bid for old card', cardAbv: 6,
    });
    runDisposeLegacyOrphan([...args, '--apply'], { db, print: (line) => lines.push(line) });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'noop' });
    expect(() => runDisposeLegacyOrphan([
      ...args.map((v) => v === 'No defensible bid for old card' ? 'Different reason' : v), '--apply',
    ], { db, print: () => {} })).toThrow(/conflict/i);
    db.close();
  });

  it('reopens only by an explicit episode command and preserves its audit', () => {
    const db = fixture();
    runDisposeLegacyOrphan([...args, '--apply'], { db, print: () => {} });
    const episodeId = findActiveDispositionForBeer(db, 29955)!.id;
    const reopen = ['--reopen', String(episodeId), '--reason', 'Archived page found',
      '--evidence', 'https://example.com/archive', '--operator', 'maintainer'];
    runDisposeLegacyOrphan(reopen, { db, print: () => {} });
    expect(findActiveDispositionForBeer(db, 29955)).not.toBeNull();
    runDisposeLegacyOrphan([...reopen, '--apply'], { db, print: () => {} });
    expect(findActiveDispositionForBeer(db, 29955)).toBeNull();
    const lines: string[] = [];
    runDisposeLegacyOrphan([...reopen, '--apply'], { db, print: (line) => lines.push(line) });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'noop' });
    db.close();
  });

  it('refuses apply when migration v35 has not been recorded', () => {
    const db = fixture();
    db.prepare('DELETE FROM schema_version WHERE version >= 35').run();
    const lines: string[] = [];
    runDisposeLegacyOrphan(args, { db, print: (line) => lines.push(line) });
    expect(JSON.parse(lines[0])).toMatchObject({ schemaVersion: 34, readyToApply: false });
    expect(() => runDisposeLegacyOrphan([...args, '--apply'], { db, print: () => {} }))
      .toThrow(/schema v35/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_orphan_dispositions').get())
      .toEqual({ n: 0 });
    db.close();
  });
});
