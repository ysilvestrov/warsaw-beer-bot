import { z } from 'zod';

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  DATABASE_PATH: z.string().min(1),
  OSRM_BASE_URL: z.string().url(),
  NOMINATIM_USER_AGENT: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DEFAULT_ROUTE_N: z.coerce.number().int().positive().default(5),
  API_PORT: z.coerce.number().int().positive().default(3000),
  SNAPSHOT_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  UNTAPPD_LOOKUP_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  UNTAPPD_SESSION_COOKIE: z.string().optional(),
  WEBSHARE_PROXY: z.string().optional(),
  UNTAPPD_BLOCK_THRESHOLD: z.coerce.number().int().positive().default(3),
  ADMIN_TELEGRAM_ID: z.string().optional(),
  ADMIN_API_TOKEN: z.string().optional(),
  UNTAPPD_ALGOLIA_APP_ID: z.string().optional(),
  UNTAPPD_ALGOLIA_SEARCH_KEY: z.string().optional(),

  // Orphan-triage job: keys are optional or defaulted; absence disables the job, never crashes startup.
  TRIAGE_LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  TRIAGE_LLM_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().min(1).default('ysilvestrov/warsaw-beer-bot'),
});

export type Env = z.infer<typeof Schema>;

// Optional keys that are expected to be set in production. Missing ones do NOT
// fail startup (unlike the required schema keys) — they only warn — because each
// merely disables a feature. Single source of truth for the startup warning and
// docs. Keep in sync with .env.example.
export const EXPECTED_PROD_KEYS = [
  { key: 'UNTAPPD_SESSION_COOKIE', disables: 'Untappd profile scraping (had-list / ratings refresh)' },
  { key: 'WEBSHARE_PROXY', disables: 'proxied Untappd traffic (block protection)' },
  { key: 'ADMIN_TELEGRAM_ID', disables: 'daily status digest + admin alerts' },
  { key: 'ADMIN_API_TOKEN', disables: 'admin HTTP endpoints (enrich-failures review)' },
  { key: 'GITHUB_TOKEN', disables: 'orphan-triage job (GitHub issue filing)' },
  { key: 'ANTHROPIC_API_KEY', disables: 'orphan-triage job (LLM analysis; not needed if TRIAGE_LLM_PROVIDER=openai)' },
] as const satisfies ReadonlyArray<{ key: keyof Env; disables: string }>;

// Expected keys that are unset or empty-string in the parsed env.
export function missingExpectedKeys(env: Env): { key: string; disables: string }[] {
  return EXPECTED_PROD_KEYS
    .filter(({ key }) => env[key] === undefined || env[key] === '')
    // ANTHROPIC_API_KEY is only meaningful when the triage LLM provider is
    // Anthropic (the default). When the operator has switched to OpenAI and
    // supplied OPENAI_API_KEY, the job is fully configured and flagging the
    // (irrelevant) missing Anthropic key would be a misleading warning.
    .filter(
      ({ key }) =>
        !(key === 'ANTHROPIC_API_KEY' && env.TRIAGE_LLM_PROVIDER === 'openai' && !!env.OPENAI_API_KEY),
    )
    .map(({ key, disables }) => ({ key, disables }));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Schema.parse(source);
}
