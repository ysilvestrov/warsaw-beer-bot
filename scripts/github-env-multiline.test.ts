import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function parseEnvFile(path: string): Record<string, string> {
  const lines = readFileSync(path, 'utf8').split('\n');
  const parsed: Record<string, string> = {};

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([^<]+)<<(.+)$/);
    if (!m) continue;

    const [, name, delimiter] = m;
    const value: string[] = [];
    i += 1;
    while (i < lines.length && lines[i] !== delimiter) {
      value.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) throw new Error(`missing delimiter ${delimiter}`);
    parsed[name] = value.join('\n');
  }

  return parsed;
}

describe('github-env-multiline.sh', () => {
  it('keeps the closing delimiter on its own line when stdin has no final newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'github-env-'));
    const envFile = join(dir, 'env');

    try {
      const result = spawnSync(
        'bash',
        ['-c', 'printf %s "$TEST_INPUT" | bash "$SCRIPT" REVIEW_PROMPT'],
        {
          env: {
            ...process.env,
            GITHUB_ENV: envFile,
            SCRIPT: resolve(__dirname, 'github-env-multiline.sh'),
            TEST_INPUT: 'last line has no newline',
          },
          timeout: 5000,
        },
      );
      expect(result.status).toBe(0);

      expect(parseEnvFile(envFile).REVIEW_PROMPT).toBe('last line has no newline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
