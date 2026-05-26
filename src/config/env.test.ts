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
});
