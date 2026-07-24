import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type pino from 'pino';
import type { SearchResult } from '../sources/untappd/search';

export interface ApiDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
  // Optional Google 0-candidate fallback; null/absent when unconfigured.
  googleFallback?: ((beerId: number) => Promise<SearchResult | null>) | null;
}

// Hono generics: variables set on the request context by middleware.
export type ApiEnv = { Variables: { telegramId: number | null } };
