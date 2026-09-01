import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { findTelegramIdByHash, hashToken } from '../../storage/api_tokens';
import { generateAndStoreToken, buildExtensionMessage, STORE_URL } from './extension';

describe('generateAndStoreToken', () => {
  it('mints a 64-hex token, stores its hash, and rotates 1:1', () => {
    const db = openDb(':memory:'); migrate(db);
    ensureProfile(db, 42);
    const first = generateAndStoreToken(db, 42, '2026-06-07T00:00:00Z');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(findTelegramIdByHash(db, hashToken(first))).toBe(42);

    const second = generateAndStoreToken(db, 42, '2026-06-07T01:00:00Z');
    expect(second).not.toBe(first);
    expect(findTelegramIdByHash(db, hashToken(first))).toBeNull(); // old revoked
    expect(findTelegramIdByHash(db, hashToken(second))).toBe(42);
  });
});

describe('buildExtensionMessage', () => {
  const t = ((key: string, params?: Record<string, string>) =>
    key === 'extension.success'
      ? `Use & enjoy: ${params?.url}`
      : key === 'extension.store'
        ? `Install: ${params?.url}`
        : key) as never;

  it('wraps the token in a <code> block and escapes the instructions', () => {
    const html = buildExtensionMessage(t, 'deadbeef', 'https://beer-api.example/match');
    expect(html).toContain('<code>deadbeef</code>');
    expect(html).toContain('Use &amp; enjoy:'); // & escaped
  });

  it('includes the Chrome Web Store link instead of shipping a zip', () => {
    const html = buildExtensionMessage(t, 'deadbeef', 'https://beer-api.example/match');
    expect(html).toContain(`Install: ${STORE_URL}`);
    expect(STORE_URL).toContain('fdelmnhijeiojadcaihfdpecfcldbndg');
  });

  test('STORE_URL is built from the single CWS item id (#379)', async () => {
    const { CWS_ITEM_ID } = await import('../../sources/cws-version.js');
    expect(STORE_URL).toContain(CWS_ITEM_ID);
    expect(STORE_URL).toBe(`https://chromewebstore.google.com/detail/${CWS_ITEM_ID}`);
  });
});
