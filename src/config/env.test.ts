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
  test('reports all expected keys when none set', () => {
    const env = loadEnv({ ...base });
    expect(missingExpectedKeys(env).map((m) => m.key).sort()).toEqual(
      [
        'ADMIN_API_TOKEN',
        'ADMIN_TELEGRAM_ID',
        'ANTHROPIC_API_KEY',
        'GITHUB_TOKEN',
        'UNTAPPD_SESSION_COOKIE',
        'WEBSHARE_PROXY',
      ],
    );
  });
  test('empty array when all expected keys present', () => {
    const env = loadEnv({
      ...base,
      UNTAPPD_SESSION_COOKIE: 'c',
      WEBSHARE_PROXY: 'p',
      ADMIN_TELEGRAM_ID: '207079110',
      ADMIN_API_TOKEN: 't',
      GITHUB_TOKEN: 'gh',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
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

describe('env: orphan-triage job', () => {
  const validBase = {
    TELEGRAM_BOT_TOKEN: 'x'.repeat(10),
    DATABASE_PATH: '/tmp/bot.db',
    OSRM_BASE_URL: 'http://localhost:5000',
    NOMINATIM_USER_AGENT: 'test-agent',
  };

  test('triage env: defaults', () => {
    const env = loadEnv({ ...validBase });
    expect(env.TRIAGE_LLM_PROVIDER).toBe('anthropic');
    expect(env.TRIAGE_LLM_MODEL).toBe('claude-opus-4-8');
    expect(env.GITHUB_REPO).toBe('ysilvestrov/warsaw-beer-bot');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  test('triage env: rejects unknown provider', () => {
    expect(() => loadEnv({ ...validBase, TRIAGE_LLM_PROVIDER: 'gemini' } as never)).toThrow();
  });

  test('missingExpectedKeys reports GITHUB_TOKEN', () => {
    const env = loadEnv({ ...validBase });
    expect(missingExpectedKeys(env).map((k) => k.key)).toContain('GITHUB_TOKEN');
  });

  test('triage env: round-trips all fields when set', () => {
    const env = loadEnv({
      ...validBase,
      TRIAGE_LLM_PROVIDER: 'openai',
      TRIAGE_LLM_MODEL: 'gpt-4o-mini',
      GITHUB_REPO: 'o/r',
      OPENAI_API_KEY: 'k',
      ANTHROPIC_API_KEY: 'k2',
      GITHUB_TOKEN: 't',
    });
    expect(env.TRIAGE_LLM_PROVIDER).toBe('openai');
    expect(env.TRIAGE_LLM_MODEL).toBe('gpt-4o-mini');
    expect(env.GITHUB_REPO).toBe('o/r');
    expect(env.OPENAI_API_KEY).toBe('k');
    expect(env.ANTHROPIC_API_KEY).toBe('k2');
    expect(env.GITHUB_TOKEN).toBe('t');
  });

  test('missingExpectedKeys does not flag ANTHROPIC_API_KEY when provider=openai and OPENAI_API_KEY is set', () => {
    const env = loadEnv({
      ...validBase,
      TRIAGE_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-openai',
    });
    expect(missingExpectedKeys(env).map((k) => k.key)).not.toContain('ANTHROPIC_API_KEY');
  });

  test('missingExpectedKeys still flags ANTHROPIC_API_KEY when provider=openai but OPENAI_API_KEY is unset', () => {
    const env = loadEnv({
      ...validBase,
      TRIAGE_LLM_PROVIDER: 'openai',
    });
    expect(missingExpectedKeys(env).map((k) => k.key)).toContain('ANTHROPIC_API_KEY');
  });
});
