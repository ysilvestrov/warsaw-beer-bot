import { openDb } from './db';
import { migrate } from './schema';
import { handlerFailuresSince, pruneHandlerFailures, recordHandlerFailure } from './handler_failures';

function emptyDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}
const rows = (db: ReturnType<typeof emptyDb>) =>
  db.prepare('SELECT at, source, error FROM handler_failures ORDER BY id').all();

test('migration v47 records its version and creates the table with its index', () => {
  const db = emptyDb();
  expect(db.prepare('SELECT version FROM schema_version WHERE version = 47').get()).toEqual({ version: 47 });
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'handler_failures' ORDER BY name").all(),
  ).toEqual([{ name: 'handler_failures' }, { name: 'handler_failures_at' }]);
});

test('a failure is stored as given', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: '/beers', error: 'message is too long' });
  expect(rows(db)).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/beers', error: 'message is too long' }]);
});

test('the error text is cut at 200 code points: 199 and 200 stay whole, 201 loses one', () => {
  const db = emptyDb();
  for (const n of [199, 200, 201]) {
    recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: `n${n}`, error: 'x'.repeat(n) });
  }
  expect(
    db.prepare('SELECT source, length(error) AS len FROM handler_failures ORDER BY id').all(),
  ).toEqual([{ source: 'n199', len: 199 }, { source: 'n200', len: 200 }, { source: 'n201', len: 200 }]);
});

test('the cut never splits a surrogate pair: an emoji as the 200th code point is kept whole', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: 's', error: `${'x'.repeat(199)}🍺yz` });
  expect(rows(db)).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: 's', error: `${'x'.repeat(199)}🍺` }]);
});

test('an empty error text is stored as an empty string', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-11T10:00:00.000Z', source: '/pubs', error: '' });
  expect(rows(db)).toEqual([{ at: '2026-10-11T10:00:00.000Z', source: '/pubs', error: '' }]);
});

test('groups by source and error, most frequent first, ties by source then error', () => {
  const db = emptyDb();
  const at = '2026-10-11T10:00:00.000Z';
  recordHandlerFailure(db, { at, source: '/route', error: 'b' });
  recordHandlerFailure(db, { at, source: '/beers', error: 'long' });
  recordHandlerFailure(db, { at, source: '/route', error: 'a' });
  recordHandlerFailure(db, { at, source: '/beers', error: 'long' });
  recordHandlerFailure(db, { at, source: '/beers', error: 'other' });
  expect(handlerFailuresSince(db, '2026-10-11T00:00:00.000Z')).toEqual([
    { source: '/beers', error: 'long', count: 2 },
    { source: '/beers', error: 'other', count: 1 },
    { source: '/route', error: 'a', count: 1 },
    { source: '/route', error: 'b', count: 1 },
  ]);
});

test('the window includes a row exactly at the boundary and excludes one a millisecond older', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-10-10T09:59:59.999Z', source: 'older', error: 'e' });
  recordHandlerFailure(db, { at: '2026-10-10T10:00:00.000Z', source: 'boundary', error: 'e' });
  expect(handlerFailuresSince(db, '2026-10-10T10:00:00.000Z')).toEqual([{ source: 'boundary', error: 'e', count: 1 }]);
});

test('no rows gives an empty list', () => {
  expect(handlerFailuresSince(emptyDb(), '2026-10-10T10:00:00.000Z')).toEqual([]);
});

test('prune deletes rows strictly older than the cutoff', () => {
  const db = emptyDb();
  recordHandlerFailure(db, { at: '2026-07-13T09:59:59.999Z', source: 'old', error: 'e' });
  recordHandlerFailure(db, { at: '2026-07-13T10:00:00.000Z', source: 'kept', error: 'e' });
  pruneHandlerFailures(db, '2026-07-13T10:00:00.000Z');
  expect(rows(db)).toEqual([{ at: '2026-07-13T10:00:00.000Z', source: 'kept', error: 'e' }]);
});
