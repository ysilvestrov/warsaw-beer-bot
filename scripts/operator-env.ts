import { existsSync } from 'node:fs';
import { config } from 'dotenv';

const SYSTEM_ENV_PATH = '/etc/warsaw-beer-bot/.env';
let loaded = false;

export function resolveOperatorEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  readable: (path: string) => boolean = existsSync,
): string {
  if (env.DOTENV_CONFIG_PATH) return env.DOTENV_CONFIG_PATH;
  return readable(SYSTEM_ENV_PATH) ? SYSTEM_ENV_PATH : '.env';
}

export function loadOperatorEnv(): void {
  if (loaded) return;
  config({ path: resolveOperatorEnvPath(), quiet: true });
  loaded = true;
}
