const key = Symbol.for('warsaw-beer-bot.test-temp-cleanups');
type TempGlobal = typeof globalThis & { [key]?: Set<() => void> };

// The runner and isolated test modules share the worker's global object.
export function tempCleanups(): Set<() => void> {
  const worker = globalThis as TempGlobal;
  return worker[key] ??= new Set();
}
