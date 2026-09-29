import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Vitest isolates modules per file. Keep collection/beforeAll fixtures alive until
// that file finishes, including when setup or an assertion throws.
const directories: string[] = [];

afterAll(() => {
  const failures: unknown[] = [];
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Test temporary directory cleanup failed');
});

export function makeTempDirectory(prefix: string): string {
  if (!prefix || prefix === '.' || prefix === '..' || prefix.includes('/') || prefix.includes('\\')) {
    throw new Error('Test temporary directory prefix must be a nonempty filename prefix');
  }
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
