import { describe, expect, test, vi } from 'vitest';
import { resolveOperatorEnvPath } from './operator-env';

describe('resolveOperatorEnvPath', () => {
  test('prefers an explicit DOTENV_CONFIG_PATH', () => {
    const readable = vi.fn(() => true);
    expect(resolveOperatorEnvPath({ DOTENV_CONFIG_PATH: '/tmp/custom.env' }, readable))
      .toBe('/tmp/custom.env');
    expect(readable).not.toHaveBeenCalled();
  });

  test('uses the systemd env file when it is readable', () => {
    expect(resolveOperatorEnvPath({}, (path) => path === '/etc/warsaw-beer-bot/.env'))
      .toBe('/etc/warsaw-beer-bot/.env');
  });

  test('falls back to the checkout-local .env', () => {
    expect(resolveOperatorEnvPath({}, () => false)).toBe('.env');
  });
});
