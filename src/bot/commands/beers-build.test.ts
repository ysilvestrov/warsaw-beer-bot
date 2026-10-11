import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as had from '../../storage/untappd_had';
import { ensureProfile, setUntappdUsername } from '../../storage/user_profiles';
import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createSnapshot, insertTaps } from '../../storage/snapshots';
import { seedBeer } from '../../storage/seed-beer.testing';
import { upsertMatch } from '../../storage/match_links';
import { ensureOrphan } from '../../storage/beers';
import { mergeCheckin } from '../../storage/checkins';
import { markHad } from '../../storage/untappd_had';
import { createTranslator } from '../../i18n';
import { buildBeersMessage } from './beers-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

const t = createTranslator('uk');
const base = (db: ReturnType<typeof fresh>, pubQuery?: string, telegramId = 1) =>
  buildBeersMessage({ db, locale: 'uk' as const, t, pubQuery, city: 'warszawa', telegramId });

describe('buildBeersMessage — resolution', () => {
  test('a pub beer displays a profile rating when no rated check-in exists', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-09-28T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 9001, name: 'Atak Chmielu', brewery: 'PINTA',
      normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA', 'Atak Chmielu', beerId, 1.0);
    insertTaps(db, snap, [{ tap_number: 1, beer_ref: 'Atak Chmielu', brewery_ref: 'PINTA',
      abv: null, ibu: null, style: null, u_rating: null }]);
    markHad(db, 1, beerId, '2026-09-28T03:00:00Z', 4.25);
    const result = base(db, 'kufel');
    expect(result).toMatchObject({ kind: 'ok', messages: [expect.stringContaining(' • ✅ 4.3')] });
    db.close();
  });

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
  test('tried matched beer stays listed with its latest personal rating', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: 'Foo 1', lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 1, name: 'Atak Chmielu', brewery: 'Pinta', style: 'AIPA',
      abv: 6.1, rating_global: 3.85,
      normalized_name: 'atak chmielu', normalized_brewery: 'pinta',
    });
    upsertMatch(db, 'PINTA', 'PINTA Atak Chmielu', beerId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'PINTA Atak Chmielu', brewery_ref: 'PINTA',
        abv: 6.1, ibu: null, style: 'AIPA & <Ale>', u_rating: 3.9 },
    ]);
    mergeCheckin(db, {
      checkin_id: 'checkin-1', telegram_id: 1, beer_id: beerId,
      user_rating: 4.2, checkin_at: '2026-05-25T11:00:00Z', venue: null,
    });

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.messages[0]).toContain('PINTA Atak Chmielu');
    expect(out.messages[0]).toContain('Kufel');
    expect(out.messages[0]).toContain('Foo 1');
    expect(out.messages[0]).toContain('Кранів: 1');
    const matchedLine = out.messages[0].split('\n').find((line) => line.startsWith('1 '))!;
    expect(matchedLine).toBe(
      '1 • ' +
      '<a href="https://untappd.com/beer/1"><b>PINTA PINTA Atak Chmielu</b></a>' +
      ' • AIPA &amp; &lt;Ale&gt; • 6.1% • 3.9 • ✅ 4.2',
    );
  });

  test('beer tried only through untappd_had shows bare ✅ even for an orphan beers row', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const orphanId = seedBeer(db, {
      untappd_id: null, name: 'Wocky Talky', brewery: 'JBW Brewery', style: null,
      abv: 4.2, rating_global: null,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery', 'JBW Brewery Wocky Talky', orphanId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);
    db.prepare('INSERT INTO untappd_had (telegram_id, beer_id, last_seen_at) VALUES (?, ?, ?)')
      .run(1, orphanId, '2026-05-25T11:00:00Z');

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.messages[0].split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toMatch(/ • ✅$/);
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
    expect(out.messages[0]).toContain('— • <b>No Numbers</b> • — • — • ⚪');
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
    const line = out.messages[0].split('\n').find((l) => l.startsWith('2 '));
    expect(line).toBe('2 • N/A'); // no abv/rating/icon trailing fields
  });

  test('untried tap matched to an orphan beers row shows ⚪', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    // Orphan beers row: created from ontap, no untappd_id yet, but match_links
    // points the ontap_ref at this row's own id (as refreshOntap does).
    const orphanId = seedBeer(db, {
      untappd_id: null, name: 'Wocky Talky', brewery: 'JBW Brewery', style: null,
      abv: 4.2, rating_global: null,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery', 'JBW Brewery Wocky Talky', orphanId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.messages[0].split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toMatch(/ • ⚪$/);
  });

  test('untried real catalog beer shows ⭐', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 6172039, name: 'Wocky Talky', brewery: 'JBW Browar', style: null,
      abv: 4.2, rating_global: 3.18,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, 'JBW Brewery', 'JBW Brewery Wocky Talky', beerId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: 'JBW Brewery',
        abv: 4.2, ibu: null, style: null, u_rating: null },
    ]);

    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const line = out.messages[0].split('\n').find((l) => l.startsWith('1 '))!;
    expect(line).toMatch(/ • ⭐$/);
  });

  test('matched beer name is a tappable Untappd link', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 6172039, name: 'Wocky Talky', brewery: 'JBW Browar', style: null,
      abv: 5, rating_global: 4.1,
      normalized_name: 'wocky talky', normalized_brewery: 'jbw',
    });
    upsertMatch(db, null, 'JBW Brewery Wocky Talky', beerId, 1.0);
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'JBW Brewery Wocky Talky', brewery_ref: null,
        abv: 5, ibu: null, style: null, u_rating: null },
    ]);
    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.messages[0]).toContain('<a href="https://untappd.com/beer/6172039"><b>JBW Brewery Wocky Talky</b></a>');
  });

  test('orphan beer name has no link', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-05-25T12:00:00Z');
    insertTaps(db, snap, [
      { tap_number: 1, beer_ref: 'Mystery Brew', brewery_ref: 'Nobody',
        abv: null, ibu: null, style: null, u_rating: null },
    ]);
    const out = base(db, 'kufel');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.messages[0]).not.toContain('<a href=');
  });
});


test('/beers uses one account snapshot for its drunk badge and rating', () => {
  const dir = mkdtempSync(join(tmpdir(), '611-beers-'));
  const db = openDb(join(dir, 'bot.db')); migrate(db); ensureProfile(db, 1); setUntappdUsername(db, 1, 'account-a');
  const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
  const snap = createSnapshot(db, pubId, '2026-09-28T12:00:00Z');
  const beerId = seedBeer(db, { untappd_id: 9001, name: 'Atak Chmielu', brewery: 'PINTA',
    normalized_name: 'atak chmielu', normalized_brewery: 'pinta' });
  upsertMatch(db, 'PINTA', 'Atak Chmielu', beerId, 1);
  insertTaps(db, snap, [{ tap_number: 1, beer_ref: 'Atak Chmielu', brewery_ref: 'PINTA',
    abv: null, ibu: null, style: null, u_rating: null }]);
  markHad(db, 1, beerId, '2026-09-28T03:00:00Z', 0);
  const other = openDb(join(dir, 'bot.db'));
  const original = had.triedBeerIds;
  const spy = vi.spyOn(had, 'triedBeerIds').mockImplementationOnce((...args) => {
    const result = original(...args); setUntappdUsername(other, 1, 'account-b'); return result;
  });
  try {
    expect(base(db, 'kufel')).toMatchObject({ kind: 'ok', messages: [expect.stringContaining(' • ✅ 0.0')] });
  } finally { spy.mockRestore(); other.close(); db.close(); rmSync(dir, { recursive: true }); }
});

describe('buildBeersMessage — #835 long lists and descriptions', () => {
  // 78 linked taps: the size of the pub that broke /beers (Piw Paw, Foksal). The expected split below
  // was computed independently of the implementation (greedy pack at 4096 over these exact strings).
  function seedBigPub(db: ReturnType<typeof fresh>) {
    const pubId = upsertPub(db, { slug: 'big', name: 'Wielokran Testowy', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const numbers = Array.from({ length: 78 }, (_, i) => i + 1);
    for (const n of numbers) {
      const beerId = seedBeer(db, {
        untappd_id: 1000 + n, name: `Piwo Numer ${n}`, brewery: 'Browar Testowy',
        normalized_name: `piwo numer ${n}`, normalized_brewery: 'browar testowy',
      });
      upsertMatch(db, 'Browar Testowy', `Piwo Numer ${n}`, beerId, 1.0);
    }
    insertTaps(db, snap, numbers.map((n) => ({
      tap_number: n, beer_ref: `Piwo Numer ${n}`, brewery_ref: 'Browar Testowy',
      abv: null, ibu: null, style: null, u_rating: null,
    })));
    return numbers;
  }

  const tapNumbers = (message: string): number[] =>
    message.split('\n').filter((line) => /^\d+ • /.test(line)).map((line) => Number(line.split(' ')[0]));

  test('78 taps arrive as two messages, the first filled to 4094 of 4096', () => {
    const db = fresh();
    seedBigPub(db);
    const out = base(db, 'wielokran');
    expect(out).toMatchObject({ kind: 'ok' });
    const { messages } = out as { messages: string[] };
    expect(messages.map((m) => m.length)).toEqual([4094, 3491]);
    db.close();
  });

  test('the header is in the first message only and no tap is lost or reordered', () => {
    const db = fresh();
    const numbers = seedBigPub(db);
    const { messages } = base(db, 'wielokran') as { messages: string[] };
    expect(messages[0].split('\n').slice(0, 2)).toEqual(['🍺 <b>Wielokran Testowy</b>', 'Кранів: 78']);
    expect(messages[1].startsWith('43 • ')).toBe(true);
    expect(messages.flatMap(tapNumbers)).toEqual(numbers);
    db.close();
  });

  test('every message is self-contained HTML: tags open and close inside it', () => {
    const db = fresh();
    seedBigPub(db);
    const { messages } = base(db, 'wielokran') as { messages: string[] };
    const count = (text: string, token: string): number => text.split(token).length - 1;
    expect(messages.map((m) => [count(m, '<a '), count(m, '</a>'), count(m, '<b>'), count(m, '</b>')])).toEqual([
      [42, 42, 43, 43],
      [36, 36, 36, 36],
    ]);
    db.close();
  });

  test('a description on a linked tap is replaced by the catalogue style', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 7001, name: 'The Quiet Man', brewery: 'Garage Beer Co.', style: 'Stout - Irish Dry',
      normalized_name: 'the quiet man', normalized_brewery: 'garage beer',
    });
    upsertMatch(db, 'Garage Beer Co.', 'The Quiet Man', beerId, 1.0);
    insertTaps(db, snap, [{ tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
      abv: null, ibu: null, style: 'Ahhhh the old country. Where the grass is green and the pints are cream.', u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe(
      '9 • <a href="https://untappd.com/beer/7001"><b>Garage Beer Co. The Quiet Man</b></a> • Stout - Irish Dry • — • — • ⭐',
    );
    db.close();
  });

  test('a description on an unlinked tap leaves the style out', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    insertTaps(db, snap, [{ tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
      abv: null, ibu: null, style: 'Ahhhh the old country. Where the grass is green and the pints are cream.', u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe('9 • <b>Garage Beer Co. The Quiet Man</b> • — • — • ⚪');
    db.close();
  });

  test('a description on a tap linked to an orphan row made by ingest leaves the style out', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const description = 'Ahhhh the old country. Where the grass is green and the pints are cream.';
    const beerId = ensureOrphan(db, {
      name: 'The Quiet Man', brewery: 'Garage Beer Co.', style: description, abv: null, rating_global: null,
      normalized_name: 'the quiet man', normalized_brewery: 'garage beer',
    });
    upsertMatch(db, 'Garage Beer Co.', 'The Quiet Man', beerId, 1.0);
    insertTaps(db, snap, [{ tap_number: 9, beer_ref: 'The Quiet Man', brewery_ref: 'Garage Beer Co.',
      abv: null, ibu: null, style: description, u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe('9 • <b>Garage Beer Co. The Quiet Man</b> • — • — • ⚪');
    db.close();
  });

  test('a plain style is printed as the pub wrote it, even when the catalogue has another', () => {
    const db = fresh();
    const pubId = upsertPub(db, { slug: 'p', name: 'Kufel', address: null, lat: null, lon: null, city: 'warszawa' });
    const snap = createSnapshot(db, pubId, '2026-10-11T12:00:00Z');
    const beerId = seedBeer(db, {
      untappd_id: 7002, name: 'Hop Cloud', brewery: 'Browar Testowy', style: 'IPA - New England / Hazy',
      normalized_name: 'hop cloud', normalized_brewery: 'browar testowy',
    });
    upsertMatch(db, 'Browar Testowy', 'Hop Cloud', beerId, 1.0);
    insertTaps(db, snap, [{ tap_number: 3, beer_ref: 'Hop Cloud', brewery_ref: 'Browar Testowy',
      abv: null, ibu: null, style: 'NEIPA /Riwaka Cryo', u_rating: null }]);
    const { messages } = base(db, 'kufel') as { messages: string[] };
    expect(messages[0].split('\n')[2]).toBe(
      '3 • <a href="https://untappd.com/beer/7002"><b>Browar Testowy Hop Cloud</b></a> • NEIPA /Riwaka Cryo • — • — • ⭐',
    );
    db.close();
  });
});
