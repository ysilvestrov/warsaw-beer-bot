import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempCleanups } from './test-temp-lifecycle';

// Vitest isolates modules per file. Keep collection/beforeAll fixtures alive until
// that file finishes, including when setup or an assertion throws.
const directories: string[] = [];

function cleanup(): void {
  const failures: unknown[] = [];
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      directories.push(directory);
      failures.push(new Error(`Cannot remove test temporary directory: ${directory}`, { cause: error }));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Test temporary directory cleanup failed');
  tempCleanups().delete(cleanup);
}

afterAll(cleanup);

export function makeTempDirectory(prefix: string): string {
  if (!prefix || prefix === '.' || prefix === '..' || prefix.includes('/') || prefix.includes('\\')) {
    throw new Error('Test temporary directory prefix must be a nonempty filename prefix');
  }
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  tempCleanups().add(cleanup);
  return directory;
}
