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
  UNTAPPD_BLOCK_RETRIES: z.coerce.number().int().min(1).default(6),
  ADMIN_TELEGRAM_ID: z.string().optional(),
  ADMIN_API_TOKEN: z.string().optional(),
  UNTAPPD_ALGOLIA_APP_ID: z.string().optional(),
  UNTAPPD_ALGOLIA_SEARCH_KEY: z.string().optional(),
  BRAVE_API_KEY: z.string().optional(),
  WEB_SEARCH_DAILY_CAP: z.coerce.number().int().positive().default(30),

  // Orphan-triage job: keys are optional or defaulted; absence disables the job, never crashes startup.
  TRIAGE_LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  TRIAGE_LLM_MODEL: z.string().min(1).default('claude-opus-4-8'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  BUG_REPORT_SELECT_MODEL: z.string().min(1).default('typesafe/jev-1.13'),
  BUG_REPORT_VERDICT_MODEL: z.string().min(1).default('gpt-5.6-luna'),
  BUG_REPORT_MEDIA_DIR: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().min(1).default('ysilvestrov/warsaw-beer-bot'),
  // Optional diagnostic archive of raw triage LLM I/O; unset ⇒ archive disabled.
  TRIAGE_LOG_DIR: z.string().optional(),
  // Untappd searches the triage job may spend per run on evidence probes and on
  // verifying proposed causes; 0 disables both (job behaves as before).
  TRIAGE_PROBE_LIMIT: z.coerce.number().int().min(0).default(120),

  // WFP festival: the third-party Untappd MCP the bot reads team check-ins through (spec
  // 2026-09-29-wfp-team-assistant-design.md §4.5). Unset ⇒ the MCP eye is off; closure then relies
  // on the venue feeds alone. The OAuth file comes from scripts/fest-mcp-login.ts.
  FEST_MCP_URL: z.string().url().optional(),
  FEST_MCP_OAUTH_FILE: z.string().min(1).default('/var/lib/warsaw-beer-bot/fest-mcp-oauth.json'),
  // Where phones reach the bot's API (the Cloudflare tunnel): the print station link points here.
  FEST_PRINT_BASE_URL: z.string().url().default('https://beer-api.ysilvestrov-ai.uk'),
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
  { key: 'GITHUB_TOKEN', disables: 'orphan-triage job (GitHub issue filing) and /report bug reports' },
  { key: 'ANTHROPIC_API_KEY', disables: 'orphan-triage job (LLM analysis; not needed if TRIAGE_LLM_PROVIDER=openai)' },
  { key: 'BRAVE_API_KEY', disables: 'Brave web fallback resolver for 0-candidate lookups (#139)' },
  { key: 'OPENROUTER_API_KEY', disables: '/report bug reports' },
  { key: 'OPENAI_API_KEY', disables: '/report bug reports and OpenAI orphan-triage LLM when selected' },
  { key: 'BUG_REPORT_MEDIA_DIR', disables: '/report bug reports' },
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
