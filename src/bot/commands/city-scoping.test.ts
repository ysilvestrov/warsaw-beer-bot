import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { buildPubsMessage } from './pubs-build';
import { buildBeersMessage } from './beers-build';
import { buildNewbeersMessage } from './newbeers-build';
import { createSnapshot } from '../../storage/snapshots';
import { createTranslator } from '../../i18n';

function fresh() { const db = openDb(':memory:'); migrate(db); return db; }
const t = createTranslator('en');
const base = { address: null, lat: null, lon: null };

test('buildPubsMessage lists only the given city', () => {
  const db = fresh();
  upsertPub(db, { slug: 'wa', name: 'Pub WA', city: 'warszawa', ...base });
  upsertPub(db, { slug: 'kr', name: 'Pub KR', city: 'krakow', ...base });
  const msg = buildPubsMessage({ db, t, city: 'krakow' });
  expect(msg).toContain('Pub KR');
  expect(msg).not.toContain('Pub WA');
});

test('buildBeersMessage cannot find an out-of-city pub', () => {
  const db = fresh();
  upsertPub(db, { slug: 'wa', name: 'Pub WA', city: 'warszawa', ...base });
  upsertPub(db, { slug: 'kr', name: 'Pub KR', city: 'krakow', ...base });
  const res = buildBeersMessage({ db, locale: 'en', t, pubQuery: 'Pub WA', city: 'krakow' });
  expect(res.kind).toBe('pub_not_found');
});

test('buildNewbeersMessage excludes out-of-city pubs', () => {
  const db = fresh();
  const krId = upsertPub(db, { slug: 'kr', name: 'Pub KR', city: 'krakow', ...base });
  createSnapshot(db, krId, new Date().toISOString());
  // user is on warszawa; the only pub (+snapshot) is in krakow → nothing to show
  const res = buildNewbeersMessage({ db, telegramId: 1, locale: 'en', t, city: 'warszawa' });
  expect(res.kind).toBe('empty');
});
