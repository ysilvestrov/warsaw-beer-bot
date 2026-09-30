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

  it('the festival MCP eye is off without FEST_MCP_URL, and its OAuth file has a production default', () => {
    const env = loadEnv(baseEnv);
    expect([env.FEST_MCP_URL, env.FEST_MCP_OAUTH_FILE]).toEqual([undefined, '/var/lib/warsaw-beer-bot/fest-mcp-oauth.json']);
  });

  it('the print station link points at the production tunnel unless FEST_PRINT_BASE_URL says otherwise', () => {
    expect([loadEnv(baseEnv).FEST_PRINT_BASE_URL, loadEnv({ ...baseEnv, FEST_PRINT_BASE_URL: 'http://localhost:3000' }).FEST_PRINT_BASE_URL])
      .toEqual(['https://beer-api.ysilvestrov-ai.uk', 'http://localhost:3000']);
  });

  it('FEST_MCP_URL must be a URL', () => {
    expect(() => loadEnv({ ...baseEnv, FEST_MCP_URL: 'not a url' })).toThrow(/FEST_MCP_URL/);
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

  it('WEB_SEARCH_DAILY_CAP defaults to 30', () => {
    const env = loadEnv(baseEnv);
    expect(env.WEB_SEARCH_DAILY_CAP).toBe(30);
  });

  it('WEB_SEARCH_DAILY_CAP parses an override', () => {
    const env = loadEnv({ ...baseEnv, WEB_SEARCH_DAILY_CAP: '10' });
    expect(env.WEB_SEARCH_DAILY_CAP).toBe(10);
  });

  it('reports BRAVE_API_KEY as an expected prod key that disables the #139 fallback', () => {
    expect(EXPECTED_PROD_KEYS.map((k) => k.key)).toContain('BRAVE_API_KEY');
    expect(EXPECTED_PROD_KEYS.map((k) => k.key)).not.toContain('GOOGLE_CSE_KEY');
    expect(missingExpectedKeys(loadEnv(baseEnv)).map((k) => k.key)).toContain('BRAVE_API_KEY');
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

  test('UNTAPPD_BLOCK_RETRIES defaults to 6 and coerces', () => {
    expect(loadEnv({ ...base } as never).UNTAPPD_BLOCK_RETRIES).toBe(6);
    expect(
      loadEnv({ ...base, UNTAPPD_BLOCK_RETRIES: '8' } as never).UNTAPPD_BLOCK_RETRIES,
    ).toBe(8);
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
    const keys = missingExpectedKeys(env).map((m) => m.key);
    for (const key of [
        'ADMIN_API_TOKEN',
        'ADMIN_TELEGRAM_ID',
        'ANTHROPIC_API_KEY',
        'BRAVE_API_KEY',
        'BUG_REPORT_MEDIA_DIR',
        'GITHUB_TOKEN',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'UNTAPPD_SESSION_COOKIE',
        'WEBSHARE_PROXY',
      ]) expect(keys).toContain(key);
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
      BRAVE_API_KEY: 'bk',
      BUG_REPORT_MEDIA_DIR: '/tmp/bug-reports',
      OPENAI_API_KEY: 'sk-openai',
      OPENROUTER_API_KEY: 'sk-openrouter',
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

describe('env: bug reports', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: '0123456789', DATABASE_PATH: '/tmp/x.db',
    OSRM_BASE_URL: 'http://localhost', NOMINATIM_USER_AGENT: 'ua',
  };

  test('bug report models have defaults and credentials remain optional', () => {
    const env = loadEnv(base);
    expect(env.BUG_REPORT_SELECT_MODEL).toBe('typesafe/jev-1.13');
    expect(env.BUG_REPORT_VERDICT_MODEL).toBe('gpt-5.6-luna');
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.BUG_REPORT_MEDIA_DIR).toBeUndefined();
  });

  test('bug report settings accept overrides', () => {
    const env = loadEnv({ ...base, OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key',
      BUG_REPORT_SELECT_MODEL: 'selection', BUG_REPORT_VERDICT_MODEL: 'verdict',
      BUG_REPORT_MEDIA_DIR: '/srv/reports' });
    expect(env.OPENROUTER_API_KEY).toBe('or-key');
    expect(env.OPENAI_API_KEY).toBe('oa-key');
    expect(env.BUG_REPORT_SELECT_MODEL).toBe('selection');
    expect(env.BUG_REPORT_VERDICT_MODEL).toBe('verdict');
    expect(env.BUG_REPORT_MEDIA_DIR).toBe('/srv/reports');
  });

  test('missing keys identify /report once for each missing credential', () => {
    const missing = missingExpectedKeys(loadEnv(base));
    for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'BUG_REPORT_MEDIA_DIR']) {
      expect(missing.map((entry) => entry.key)).toContain(key);
      expect(missing.filter((entry) => entry.key === key)).toHaveLength(1);
    }
    expect(missing.find((entry) => entry.key === 'OPENAI_API_KEY')?.disables)
      .toContain('/report bug reports');
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
    expect(env.TRIAGE_PROBE_LIMIT).toBe(120);
  });

  test('TRIAGE_PROBE_LIMIT coerces and accepts 0 (probes + verification off)', () => {
    expect(loadEnv({ ...validBase, TRIAGE_PROBE_LIMIT: '40' } as never).TRIAGE_PROBE_LIMIT).toBe(40);
    expect(loadEnv({ ...validBase, TRIAGE_PROBE_LIMIT: '0' } as never).TRIAGE_PROBE_LIMIT).toBe(0);
    expect(() => loadEnv({ ...validBase, TRIAGE_PROBE_LIMIT: '-1' } as never)).toThrow();
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

describe('BRAVE_API_KEY config', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: '0123456789',
    DATABASE_PATH: '/tmp/x.db',
    OSRM_BASE_URL: 'http://localhost',
    NOMINATIM_USER_AGENT: 'ua',
  };

  it('BRAVE_API_KEY is optional and undefined when absent', () => {
    const env = loadEnv({ ...base } as never);
    expect(env.BRAVE_API_KEY).toBeUndefined();
  });

  it('BRAVE_API_KEY passes through when set', () => {
    const env = loadEnv({ ...base, BRAVE_API_KEY: 'brave-key' } as never);
    expect(env.BRAVE_API_KEY).toBe('brave-key');
  });
});
