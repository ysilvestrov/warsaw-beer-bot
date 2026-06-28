import { loadEnv, missingExpectedKeys, EXPECTED_PROD_KEYS } from './env';

describe('loadEnv', () => {
  const baseEnv = {
    TELEGRAM_BOT_TOKEN: 'abc:1234567',
    DATABASE_PATH: '/tmp/bot.db',
    OSRM_BASE_URL: 'https://osrm.example',
    NOMINATIM_USER_AGENT: 'ua',
  };

  it('parses a complete env map', () => {
    const env = loadEnv({
      ...baseEnv,
      LOG_LEVEL: 'debug',
      DEFAULT_ROUTE_N: '7',
    });
    expect(env.DEFAULT_ROUTE_N).toBe(7);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('rejects missing token', () => {
    expect(() => loadEnv({ DATABASE_PATH: '/tmp/x.db' } as any)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('UNTAPPD_LOOKUP_ENABLED defaults to true when unset', () => {
    const env = loadEnv(baseEnv);
    expect(env.UNTAPPD_LOOKUP_ENABLED).toBe(true);
  });

  it('UNTAPPD_LOOKUP_ENABLED="false" parses to false', () => {
    const env = loadEnv({ ...baseEnv, UNTAPPD_LOOKUP_ENABLED: 'false' });
    expect(env.UNTAPPD_LOOKUP_ENABLED).toBe(false);
  });

  it('UNTAPPD_LOOKUP_ENABLED="true" parses to true', () => {
    const env = loadEnv({ ...baseEnv, UNTAPPD_LOOKUP_ENABLED: 'true' });
    expect(env.UNTAPPD_LOOKUP_ENABLED).toBe(true);
  });

  it('ADMIN_API_TOKEN passes through when set', () => {
    const env = loadEnv({ ...baseEnv, ADMIN_API_TOKEN: 'secret-token' });
    expect(env.ADMIN_API_TOKEN).toBe('secret-token');
  });

  it('ADMIN_API_TOKEN is undefined when absent', () => {
    const env = loadEnv(baseEnv);
    expect(env.ADMIN_API_TOKEN).toBeUndefined();
  });
});

describe('env: proxy + block threshold', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 'x'.repeat(12),
    DATABASE_PATH: '/tmp/x.db',
    OSRM_BASE_URL: 'https://osrm.example.com',
    NOMINATIM_USER_AGENT: 'test-agent',
  };

  test('WEBSHARE_PROXY is optional and passes through', () => {
    expect(loadEnv({ ...base } as never).WEBSHARE_PROXY).toBeUndefined();
    expect(
      loadEnv({ ...base, WEBSHARE_PROXY: 'u:p@p.webshare.io:80' } as never).WEBSHARE_PROXY,
    ).toBe('u:p@p.webshare.io:80');
  });

  test('UNTAPPD_BLOCK_THRESHOLD defaults to 3 and coerces', () => {
    expect(loadEnv({ ...base } as never).UNTAPPD_BLOCK_THRESHOLD).toBe(3);
    expect(
      loadEnv({ ...base, UNTAPPD_BLOCK_THRESHOLD: '5' } as never).UNTAPPD_BLOCK_THRESHOLD,
    ).toBe(5);
  });
});

describe('env: Algolia keys', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 'x'.repeat(12),
    DATABASE_PATH: '/tmp/x.db',
    OSRM_BASE_URL: 'https://osrm.example.com',
    NOMINATIM_USER_AGENT: 'test-agent',
  };

  test('UNTAPPD_ALGOLIA_APP_ID and SEARCH_KEY are undefined when absent', () => {
    const env = loadEnv({ ...base } as never);
    expect(env.UNTAPPD_ALGOLIA_APP_ID).toBeUndefined();
    expect(env.UNTAPPD_ALGOLIA_SEARCH_KEY).toBeUndefined();
  });

  test('UNTAPPD_ALGOLIA_APP_ID and SEARCH_KEY round-trip when present', () => {
    const env = loadEnv({
      ...base,
      UNTAPPD_ALGOLIA_APP_ID: '9WBO4RQ3HO',
      UNTAPPD_ALGOLIA_SEARCH_KEY: '1d347324d67ec472bb7132c66aead485',
    } as never);
    expect(env.UNTAPPD_ALGOLIA_APP_ID).toBe('9WBO4RQ3HO');
    expect(env.UNTAPPD_ALGOLIA_SEARCH_KEY).toBe('1d347324d67ec472bb7132c66aead485');
  });
});

describe('missingExpectedKeys', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: 'x'.repeat(10),
    DATABASE_PATH: '/tmp/bot.db',
    OSRM_BASE_URL: 'http://localhost:5000',
    NOMINATIM_USER_AGENT: 'test-agent',
  };
  test('reports all four expected keys when none set', () => {
    const env = loadEnv({ ...base });
    expect(missingExpectedKeys(env).map((m) => m.key).sort()).toEqual(
      ['ADMIN_API_TOKEN', 'ADMIN_TELEGRAM_ID', 'UNTAPPD_SESSION_COOKIE', 'WEBSHARE_PROXY'],
    );
  });
  test('empty array when all expected keys present', () => {
    const env = loadEnv({ ...base, UNTAPPD_SESSION_COOKIE: 'c', WEBSHARE_PROXY: 'p', ADMIN_TELEGRAM_ID: '207079110', ADMIN_API_TOKEN: 't' });
    expect(missingExpectedKeys(env)).toEqual([]);
  });
  test('treats empty string as missing', () => {
    const env = loadEnv({ ...base, ADMIN_TELEGRAM_ID: '' });
    expect(missingExpectedKeys(env).map((m) => m.key)).toContain('ADMIN_TELEGRAM_ID');
  });
  test('each entry carries a non-empty disables description', () => {
    for (const e of EXPECTED_PROD_KEYS) expect(e.disables.length).toBeGreaterThan(0);
  });
  test('only optional keys are expected (no required key listed)', () => {
    const keys = EXPECTED_PROD_KEYS.map((e) => e.key);
    expect(keys).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(keys).not.toContain('DATABASE_PATH');
  });
});
