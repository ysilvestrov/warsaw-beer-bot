import { openDb } from './db';
import { migrate } from './schema';
import { accountKeyFor, getHistoryOwner, isCurrentHistoryOwner } from './history-owner';

test.each([[null, ''], ['', ''], ['Old_Name', 'old_name']] as const)('normalizes username %s to the history key', (username, key) => {
  expect(accountKeyFor(username)).toBe(key);
});

test('missing profiles retain the unlinked repository context without accepting a named binding', () => {
  const db = openDb(':memory:');
  migrate(db);
  expect(getHistoryOwner(db, 123)).toEqual({ telegramId: 123, accountKey: '', linkRevision: 0 });
  expect(isCurrentHistoryOwner(db, { telegramId: 123, accountKey: 'named', linkRevision: 0 })).toBe(false);
  db.close();
});
