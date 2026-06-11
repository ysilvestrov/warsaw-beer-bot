// @vitest-environment node
import { describe, it, expect } from 'vitest';
import manifestExport from '../manifest.config';
import pkg from '../package.json';

// defineManifest's return type is a union (object | Promise | fn); at build time
// we pass a plain object, so narrow to a record for property access in the test.
const manifest = manifestExport as {
  version: string;
  key: string;
  content_scripts: Array<{ matches: string[] }>;
  permissions: string[];
  action?: { default_popup?: string };
};

describe('manifest', () => {
  it('derives version from package.json (single source of truth)', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('pins a stable extension id via the key field', () => {
    expect(typeof manifest.key).toBe('string');
    expect(manifest.key.length).toBeGreaterThan(100);
  });

  it('injects the content script on supported shop pages', () => {
    expect(Array.isArray(manifest.content_scripts)).toBe(true);
    expect(manifest.content_scripts.length).toBeGreaterThan(0);
    const [contentScript] = manifest.content_scripts;
    expect(Array.isArray(contentScript.matches)).toBe(true);
    expect(contentScript.matches).toContain('https://beerfreak.org/*');
    expect(contentScript.matches).toContain('https://*.beerfreak.org/*');
    expect(contentScript.matches).toContain('https://bierloods22.nl/*');
    expect(contentScript.matches).toContain('https://*.bierloods22.nl/*');
    expect(contentScript.matches).toContain('https://winetime.com.ua/*');
    expect(contentScript.matches).toContain('https://*.winetime.com.ua/*');
  });

  it('exposes a popup action', () => {
    expect(manifest.action?.default_popup).toBe('src/popup/popup.html');
  });

  it('requests activeTab + tabs permissions for the popup', () => {
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('tabs');
  });
});
