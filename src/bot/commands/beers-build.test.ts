import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createSnapshot, insertTaps } from '../../storage/snapshots';
import { upsertBeer } from '../../storage/beers';
import { upsertMatch } from '../../storage/match_links';
import { createTranslator } from '../../i18n';
import { buildBeersMessage } from './beers-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const t = createTranslator('uk');
const base = (db: ReturnType<typeof fresh>, pubQuery?: string) =>
  buildBeersMessage({ db, locale: 'uk' as const, t, pubQuery, city: 'warszawa' });

describe('buildBeersMessage — resolution', () => {
  test('missing argument returns no_arg', () => {
    const db = fresh();
    expect(base(db)).toEqual({ kind: 'no_arg' });
  });

  test('whitespace-only argument returns no_arg', () => {
    const db = fresh();
    expect(base(db, '   ')).toEqual({ kind: 'no_arg' });
  });

  test('unknown query returns pub_not_found with trimmed query', () => {
    const db = fresh();
    upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    expect(base(db, '  zzz  ')).toEqual({ kind: 'pub_not_found', query: 'zzz' });
  });

  test('two name-matches return ambiguous with both pubs', () => {
    const db = fresh();
    upsertPub(db, { slug: 'a', name: 'PINTA Warszawa', address: 'Chmielna 7', lat: null, lon: null, city: 'warszawa' });
    upsertPub(db, { slug: 'b', name: 'PINTA Warszawa', address: 'Nowogrodzka 4', lat: null, lon: null, city: 'warszawa' });
    const out = base(db, 'pinta');
    expect(out.kind).toBe('ambiguous');
    if (out.kind !== 'ambiguous') return;
    expect(out.pubs).toEqual([
      { name: 'PINTA Warszawa', address: 'Chmielna 7' },
      { name: 'PINTA Warszawa', address: 'Nowogrodzka 4' },
    ]);
  });

  test('ambiguous caps the list at 3 pubs', () => {
    const db = fresh();
    for (let i = 1; i <= 4; i++) {
      upsertPub(db, { slug: `m${i}`, name: `Multi Bar ${i}`, address: null, lat: null, lon: null, city: 'warszawa' });
    }
    const out = base(db, 'multi');
    expect(out.kind).toBe('ambiguous');
    if (out.kind !== 'ambiguous') return;
    expect(out.pubs).toHaveLength(3);
  });

  test('matched pub without any snapshot returns empty with pub name', () => {
    const db = fresh();
    upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    expect(base(db, 'kufel')).toEqual({ kind: 'empty', pub: 'Kufel' });
  });

  test('matched pub with snapshot but no taps returns empty', () => {
    const db = fresh();
    const id = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    createSnapshot(db, id, '2026-05-25T12:00:00Z');
    expect(base(db, 'kufel')).toEqual({ kind: 'empty', pub: 'Kufel' });
  });
});

describe('buildBeersMessage — ok rendering', () => {
  test('shows every tap incl. orphan and already-tried, with 🟢/⚪ icons', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: 'Foo 1', lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 1, name: 'Atak Chmielu', brewery: 'Pinta', style: 'AIPA',
      abv: 6.1, rating_global: 3.85,
      normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA Atak Chmielu', beerId, 1.0);
    // tap 1: matched; tap 2: orphan (no match_link)
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA',
        abv: 6.1, ibu: null, style: 'AIPA & <Ale>', u_rating: 3.9 },
      { tap_number: 2, beer_ref: 'Mystery Brew', brewery_ref: 'Unknown Co',
        abv: 5.0, ibu: null, style: null, u_rating: 4.2 },
    ]);
    // mark the matched beer as already tried — must STILL appear (no filtering)
    db.prepare('INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)')
      .run(1, beerId, '2026-05-25T11:00:00Z');

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.html).toContain('PINTA Atak Chmielu'); // tried, still shown
    expect(out.html).toContain('Mystery Brew');       // orphan, still shown
    expect(out.html).toContain('🟢');                 // matched icon
    expect(out.html).toContain('⚪');                 // orphan icon
    expect(out.html).toContain('Kufel');              // header pub name
    expect(out.html).toContain('Foo 1');              // header address
    expect(out.html).toContain('Кранів: 2');          // header count
    const matchedLine = out.html.split('\n').find((line) => line.startsWith('1 '))!;
    expect(matchedLine).toContain(
      '<b>PINTA PINTA Atak Chmielu</b> • AIPA &amp; &lt;Ale&gt; • 6.1%',
    );
  });

  test('null tap_number / abv / rating render as em dash', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    insertTaps(db, snap, [
      { tap_number: null, beer_ref: 'No Numbers', brewery_ref: null,
        abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // line is: "— • <b>No Numbers</b> • — • — • ⚪"
    expect(out.html).toContain('— • <b>No Numbers</b> • — • — • ⚪');
  });

  test('empty tap (beer_ref "N/A") collapses to "{tap#} • N/A"', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    insertTaps(db, snap, [
      { tap_number: 2, beer_ref: 'N/A', brewery_ref: null,
        abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.html.split('\n').find((l) => l.startsWith('2 '));
    expect(line).toBe('2 • N/A'); // no abv/rating/icon trailing fields
  });

  test('tap matched to an orphan beers row (untappd_id NULL) shows ⚪, not 🟢', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    // Orphan beers row: created from ontap, no untappd_id yet, but match_links
    // points the ontap_ref at this row's own id (as refreshOntap does).
    const orphanId = upsertBeer(db, {
      untappd_id: null, name: 'Wocky Talky', brewery: 'JBW Brewery', style: null,
      abv: 4.2, rating_global: null,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery Wocky Talky', orphanId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.html.split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toContain('⚪');
    expect(line).not.toContain('🟢');
  });

  test('tap matched to a real catalog beer (untappd_id set) shows 🟢', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = upsertBeer(db, {
      untappd_id: 6172039, name: 'Wocky Talky', brewery: 'JBW Browar', style: null,
      abv: 4.2, rating_global: 3.18,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery Wocky Talky', beerId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.html.split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toContain('🟢');
  });
});
