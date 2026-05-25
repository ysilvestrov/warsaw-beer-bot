import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { upsertPub } from '../../storage/pubs';
import { createTranslator } from '../../i18n';
import { buildPubsMessage } from './pubs-build';

function fresh() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('buildPubsMessage', () => {
  test('returns the pubs.empty fallback when there are no pubs', () => {
    const db = fresh();
    const t = createTranslator('uk');
    const out = buildPubsMessage({ db, t });
    expect(out).toBe(t('pubs.empty'));
  });

  test('lists pubs alphabetically with header and hint', () => {
    const db = fresh();
    // Insert in non-alphabetical order to prove the sort.
    upsertPub(db, { slug: 'cuda', name: 'Cuda', address: null, lat: null, lon: null });
    upsertPub(db, { slug: 'bar',  name: 'Bar',  address: null, lat: null, lon: null });
    upsertPub(db, { slug: 'alfa', name: 'Alfa', address: null, lat: null, lon: null });

    const t = createTranslator('uk');
    const out = buildPubsMessage({ db, t });

    expect(out).toContain(t('pubs.header'));
    expect(out).toContain(t('pubs.hint'));
    expect(out).toContain('Alfa');
    expect(out).toContain('Bar');
    expect(out).toContain('Cuda');
    // Order check: each later pub must appear after the previous.
    expect(out.indexOf('Alfa')).toBeLessThan(out.indexOf('Bar'));
    expect(out.indexOf('Bar')).toBeLessThan(out.indexOf('Cuda'));
  });

  test('HTML-escapes pub names containing special characters', () => {
    const db = fresh();
    upsertPub(db, { slug: 'tricky', name: 'Cuda & <Co>', address: null, lat: null, lon: null });
    const t = createTranslator('uk');
    const out = buildPubsMessage({ db, t });
    expect(out).toContain('Cuda &amp; &lt;Co&gt;');
    expect(out).not.toContain('Cuda & <Co>');
  });
});
