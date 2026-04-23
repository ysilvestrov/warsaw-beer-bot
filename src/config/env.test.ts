import { loadEnv } from './env';

describe('loadEnv', () => {
  it('parses a complete env map', () => {
    const env = loadEnv({
      TELEGRAM_BOT_TOKEN: 'abc:1234567',
      DATABASE_PATH: '/tmp/bot.db',
      OSRM_BASE_URL: 'https://osrm.example',
      NOMINATIM_USER_AGENT: 'ua',
      LOG_LEVEL: 'debug',
      DEFAULT_ROUTE_N: '7',
    });
    expect(env.DEFAULT_ROUTE_N).toBe(7);
    expect(env.LOG_LEVEL).toBe('debug');
  });

  it('rejects missing token', () => {
    expect(() => loadEnv({ DATABASE_PATH: '/tmp/x.db' } as any)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});
