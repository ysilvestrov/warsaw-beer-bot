import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const READ_ENV = resolve(__dirname, '../../deploy/read-env.sh');

/**
 * #435 — the operator env file is DATA, not a shell script.
 *
 * `set -a; . /etc/warsaw-beer-bot/.env` was the first implementation and it is
 * wrong in a way that hides itself: a value containing shell metacharacters is
 * a syntax error, sourcing ABORTS there, and every key BELOW that line silently
 * stays unset. On the live host that meant the autodeploy notifier had a token
 * (line 1) and no chat id (line 13) — so it posted to a valid bot URL with an
 * empty chat_id, got HTTP 400, and died in `|| echo WARNING` in the journal.
 * The deployer would have run, failed, rolled back and told nobody.
 */

function read(file: string, key: string): string {
  return execFileSync('bash', [READ_ENV, file, key], { encoding: 'utf8' }).replace(/\n$/, '');
}

describe('read-env.sh', () => {
  let envFile: string;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), 'wbb-env-'));
    envFile = join(dir, '.env');
    // Line 4 reproduces the real file's shape: unquoted parentheses, which are
    // a bash syntax error. Everything the notifier needs sits BELOW it.
    writeFileSync(
      envFile,
      [
        'TELEGRAM_BOT_TOKEN=123456:AAref-token',
        'DATABASE_PATH=/var/lib/warsaw-beer-bot/bot.db',
        'OSRM_BASE_URL=https://osrm.example',
        'NOMINATIM_USER_AGENT=warsaw-beer-bot (yuriy@silvestrov.com)',
        '',
        '# a comment line',
        'ADMIN_TELEGRAM_ID=207079110',
        'QUOTED_VALUE="has spaces"',
        "SINGLE_QUOTED='also quoted'",
        'EMPTY=',
        'WITH_EQUALS=a=b=c',
        '',
      ].join('\n'),
    );
  });

  it('reads a key that sits ABOVE the metacharacter line', () => {
    expect(read(envFile, 'TELEGRAM_BOT_TOKEN')).toBe('123456:AAref-token');
  });

  it('reads a key that sits BELOW the metacharacter line — the regression', () => {
    // `. file` never reaches this line. This assertion is the whole point.
    expect(read(envFile, 'ADMIN_TELEGRAM_ID')).toBe('207079110');
  });

  it('returns the metacharacter value itself, literally', () => {
    expect(read(envFile, 'NOMINATIM_USER_AGENT')).toBe('warsaw-beer-bot (yuriy@silvestrov.com)');
  });

  it('strips surrounding quotes, as systemd EnvironmentFile does', () => {
    expect(read(envFile, 'QUOTED_VALUE')).toBe('has spaces');
    expect(read(envFile, 'SINGLE_QUOTED')).toBe('also quoted');
  });

  it('keeps everything after the FIRST equals sign', () => {
    expect(read(envFile, 'WITH_EQUALS')).toBe('a=b=c');
  });

  it('returns nothing for an absent key, an empty value, or an unreadable file', () => {
    expect(read(envFile, 'API_PORT')).toBe('');
    expect(read(envFile, 'EMPTY')).toBe('');
    expect(read('/nonexistent/.env', 'TELEGRAM_BOT_TOKEN')).toBe('');
  });

  it('does not match a key that merely ends with the requested name', () => {
    expect(read(envFile, 'TOKEN')).toBe('');
  });
});
