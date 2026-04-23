import { z } from 'zod';

const Schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  DATABASE_PATH: z.string().min(1),
  OSRM_BASE_URL: z.string().url(),
  NOMINATIM_USER_AGENT: z.string().min(1),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  DEFAULT_ROUTE_N: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof Schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return Schema.parse(source);
}
