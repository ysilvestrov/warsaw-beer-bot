import { openDb } from '../../storage/db';
import { migrate } from '../../storage/schema';
import { ensureProfile } from '../../storage/user_profiles';
import { findTelegramIdByHash, hashToken } from '../../storage/api_tokens';
import { upsertRelease, attachFileId } from '../../storage/extension_releases';
import { generateAndStoreToken, buildExtensionMessage, latestDeliverableRelease } from './extension';

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
  it('wraps the token in a <code> block and escapes the instructions', () => {
    const t = ((key: string, params?: Record<string, string>) =>
      key === 'extension.success' ? `Use & enjoy: ${params?.url}` : key) as never;
    const html = buildExtensionMessage(t, 'deadbeef', 'https://beer-api.example/match');
    expect(html).toContain('<code>deadbeef</code>');
    expect(html).toContain('Use &amp; enjoy:'); // & escaped
  });
});

describe('latestDeliverableRelease', () => {
  it('returns file_id + version only once a release is attached', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(latestDeliverableRelease(db)).toBeNull(); // no releases

    upsertRelease(db, { version: '0.3.0', sha256: 's', notes: 'n' });
    expect(latestDeliverableRelease(db)).toBeNull(); // row exists but file_id NULL

    attachFileId(db, '0.3.0', 'FID', 1);
    expect(latestDeliverableRelease(db)).toEqual({ fileId: 'FID', version: '0.3.0' });
  });
});
