import { loadEnv } from './env';

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
