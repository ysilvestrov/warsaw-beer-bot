import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Vitest isolates modules per file. Keep collection/beforeAll fixtures alive until
// that file finishes, including when setup or an assertion throws.
const directories: string[] = [];

function cleanup(): void {
  const failures: unknown[] = [];
  for (const directory of directories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Test temporary directory cleanup failed');
}

// Collection failures skip afterAll. Keep an exit fallback until the file's
// normal teardown runs; SIGKILL and abruptly terminated workers remain excluded.
process.once('exit', cleanup);
afterAll(() => {
  process.off('exit', cleanup);
  cleanup();
});

export function makeTempDirectory(prefix: string): string {
  if (!prefix || prefix === '.' || prefix === '..' || prefix.includes('/') || prefix.includes('\\')) {
    throw new Error('Test temporary directory prefix must be a nonempty filename prefix');
  }
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
