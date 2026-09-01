import {
  CWS_ITEM_ID,
  compareVersions,
  fetchPublishedVersion,
  parsePublishedVersion,
  updateCheckUrl,
} from './cws-version';

// Captured live 2026-09-01 from the real item (truncated blobs, structure intact).
const REAL_XML =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" ' +
  'protocol="2.0" server="prod"><daystart elapsed_days="7183" elapsed_seconds="32714"/>' +
  '<app appid="fdelmnhijeiojadcaihfdpecfcldbndg" cohort="1::" cohortname="" status="ok">' +
  '<updatecheck _esbAllowlist="false" codebase="https://clients2.googleusercontent.com/crx/blobs/Abe5cL7' +
  '/FDELMNHIJEIOJADCAIHFDPECFCLDBNDG_0_15_0_0.crx" fp="1.4e50" hash_sha256="4e50" protected="0" ' +
  'size="55919" status="ok" version="0.15.0"/></app></gupdate>';

// Captured live 2026-09-01 with a garbage app id — the control.
const UNKNOWN_APP_XML =
  '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" ' +
  'protocol="2.0" server="prod"><daystart elapsed_days="7183" elapsed_seconds="32723"/>' +
  '<app appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" status="error-unknownApplication"/></gupdate>';

describe('parsePublishedVersion', () => {
  test('reads the version from a real ok response', () => {
    expect(parsePublishedVersion(REAL_XML)).toBe('0.15.0');
  });

  test('unknown application → null, not a version (the live control)', () => {
    expect(parsePublishedVersion(UNKNOWN_APP_XML)).toBeNull();
  });

  test('updatecheck present but not ok → null', () => {
    const xml = '<gupdate><app status="ok"><updatecheck status="noupdate" version="0.15.0"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBeNull();
  });

  test('updatecheck ok but no version attribute → null', () => {
    const xml = '<gupdate><app status="ok"><updatecheck status="ok" size="10"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBeNull();
  });

  test('a non-numeric version is rejected rather than passed through', () => {
    const xml = '<gupdate><app status="ok"><updatecheck status="ok" version="not-a-version"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBeNull();
  });

  test('empty body and garbage → null', () => {
    expect(parsePublishedVersion('')).toBeNull();
    expect(parsePublishedVersion('<html>404</html>')).toBeNull();
  });

  test('attribute order does not matter — version may precede status', () => {
    const xml = '<gupdate><app><updatecheck version="1.2.3" status="ok"/></app></gupdate>';
    expect(parsePublishedVersion(xml)).toBe('1.2.3');
  });
});

describe('compareVersions', () => {
  test.each([
    ['0.15.0', '0.15.0', 0],
    ['0.16.0', '0.15.0', 1],
    ['0.15.0', '0.16.0', -1],
    ['0.16', '0.16.0', 0],       // missing segments are zeros
    ['0.16.1', '0.16', 1],
    ['0.10.0', '0.9.0', 1],      // numeric, not lexicographic
    ['0.9.0', '0.10.0', -1],
    ['1.0.0', '0.99.99', 1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a as string, b as string)).toBe(expected);
  });
});

describe('updateCheckUrl', () => {
  test('encodes the id inside the x parameter the way the endpoint expects', () => {
    expect(updateCheckUrl('abc')).toContain('x=id%3Dabc%26uc');
    expect(updateCheckUrl('abc')).toContain('clients2.google.com/service/update2/crx');
  });
});

describe('fetchPublishedVersion', () => {
  test('parses the body of a 200 and defaults to our item id', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return { ok: true, text: async () => REAL_XML } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await fetchPublishedVersion({ fetchImpl })).toBe('0.15.0');
    expect(seen[0]).toContain(encodeURIComponent(`id=${CWS_ITEM_ID}&uc`));
  });

  test('a non-2xx response is null, not a throw', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503, text: async () => '' } as unknown as Response)) as unknown as typeof fetch;
    expect(await fetchPublishedVersion({ fetchImpl })).toBeNull();
  });

  test('a network failure propagates so the caller can log it', async () => {
    const fetchImpl = (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch;
    await expect(fetchPublishedVersion({ fetchImpl })).rejects.toThrow('ENOTFOUND');
  });
});
