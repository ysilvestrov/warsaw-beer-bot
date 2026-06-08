// @vitest-environment node
import { describe, it, expect } from 'vitest';
import manifest from '../manifest.config';
import pkg from '../package.json';

describe('manifest', () => {
  it('derives version from package.json (single source of truth)', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('pins a stable extension id via the key field', () => {
    expect(typeof manifest.key).toBe('string');
    expect((manifest.key as string).length).toBeGreaterThan(100);
  });
});
