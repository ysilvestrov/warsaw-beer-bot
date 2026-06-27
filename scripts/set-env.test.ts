import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, 'set-env.sh');

function run(file: string, key: string, value: string) {
  execFileSync('bash', [SCRIPT, key, value, file], { stdio: 'pipe' });
}
function freshFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'setenv-'));
  const f = join(dir, '.env');
  writeFileSync(f, contents);
  return f;
}

describe('set-env.sh', () => {
  test('replaces an existing key in place, preserving other lines', () => {
    const f = freshFile('A=1\nADMIN_TELEGRAM_ID=old\nB=2\n');
    run(f, 'ADMIN_TELEGRAM_ID', '207079110');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nADMIN_TELEGRAM_ID=207079110\nB=2\n');
  });
  test('appends a new key when absent', () => {
    const f = freshFile('A=1\nB=2\n');
    run(f, 'WEBSHARE_PROXY', 'user:pass@host:1080');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\nWEBSHARE_PROXY=user:pass@host:1080\n');
  });
  test('appends a guaranteed newline when file lacks a trailing one', () => {
    const f = freshFile('A=1');
    run(f, 'B', '2');
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\n');
  });
  test('writes a value with =, spaces and parens literally, round-trips via cut', () => {
    const f = freshFile('X=1\n');
    const val = 'warsaw-beer-bot (yuriy@silvestrov.com) a=b';
    run(f, 'NOMINATIM_USER_AGENT', val);
    const line = readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('NOMINATIM_USER_AGENT='))!;
    expect(line.slice('NOMINATIM_USER_AGENT='.length)).toBe(val);
  });
  test('creates a timestamped backup', () => {
    const f = freshFile('A=1\n');
    run(f, 'A', '2');
    const dir = join(f, '..');
    const baks = readdirSync(dir).filter((n) => n.startsWith('.env.bak.'));
    expect(baks.length).toBe(1);
  });
  test('rejects an invalid key name', () => {
    const f = freshFile('A=1\n');
    expect(() => run(f, 'bad-key', 'x')).toThrow();
  });
});
