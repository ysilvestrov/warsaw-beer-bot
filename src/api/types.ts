import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type pino from 'pino';

export interface ApiDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
}

// Hono generics: variables set on the request context by middleware.
export type ApiEnv = { Variables: { telegramId: number | null } };
