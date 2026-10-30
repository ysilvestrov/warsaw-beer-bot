import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleEnrichCandidates } from './index';
import { setSettings } from '../shared/config';

// Own file: ensureInstall is one attempt per service-worker lifetime, i.e. per module instance,
// so this test needs a module whose registration has not run yet.
afterEach(() => { vi.unstubAllGlobals(); });

describe('enrich candidates on the first page after install (#923)', () => {
  it('waits for the registration that is due, then asks with the token it issued', async () => {
    await setSettings({ enrichEnabled: true, baseUrl: 'https://api.test' });
    const asked: { url: string; auth: string | undefined }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      asked.push({ url, auth: (init.headers as Record<string, string>).Authorization });
      return url.endsWith('/installs')
        ? new Response(JSON.stringify({ install_id: 'i', token: 'wbi_new' }), { status: 201 })
        : new Response(JSON.stringify({ candidates: [{ brewery: 'B', name: 'N', eligible: true }] }), { status: 200 });
    }));
    const out = await handleEnrichCandidates({ type: 'enrich:candidates', beers: [{ brewery: 'B', name: 'N' }] });
    expect(out).toEqual({ type: 'enrich:candidates:ok', candidates: [{ brewery: 'B', name: 'N', eligible: true }] });
    expect(asked).toEqual([
      { url: 'https://api.test/installs', auth: undefined },
      { url: 'https://api.test/enrich/candidates', auth: 'Bearer wbi_new' },
    ]);
  });
});
