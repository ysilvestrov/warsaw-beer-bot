// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildManifest } from '../manifest.config';
import pkg from '../package.json';

const dev = buildManifest({ store: false });
const store = buildManifest({ store: true });

describe('manifest (both variants)', () => {
  it('derives version from package.json', () => {
    expect(dev.version).toBe(pkg.version);
    expect(store.version).toBe(pkg.version);
  });

  it('drops tabs, keeps activeTab, in both variants', () => {
    for (const m of [dev, store]) {
      expect(m.permissions).toContain('activeTab');
      expect(m.permissions).not.toContain('tabs');
    }
  });

  it('injects the content script on supported shop pages', () => {
    const [cs] = dev.content_scripts;
    expect(cs.matches).toContain('https://beerfreak.org/*');
    expect(cs.matches).toContain('https://*.beerfreak.org/*');
    expect(cs.matches).toContain('https://funkyshop.pl/*');
  });

  it('exposes a popup action with a default icon', () => {
    expect(dev.action.default_popup).toBe('src/popup/popup.html');
    expect(dev.action.default_icon[16]).toBe('public/icons/icon-16.png');
    expect(dev.action.default_icon[128]).toBe('public/icons/icon-128.png');
  });

  it('declares icons at 16/32/48/128', () => {
    for (const size of [16, 32, 48, 128] as const) {
      expect(dev.icons[size]).toBe(`public/icons/icon-${size}.png`);
    }
  });

  it('ships the referenced icon PNG files', () => {
    for (const size of [16, 32, 48, 128]) {
      expect(existsSync(resolve(__dirname, `../public/icons/icon-${size}.png`))).toBe(true);
    }
  });

  it('keeps enrichment optional origins in both variants', () => {
    for (const m of [dev, store]) {
      expect(m.optional_host_permissions).toContain('https://untappd.com/*');
      expect(m.optional_host_permissions).toContain('https://*.algolia.net/*');
    }
  });
});

describe('dev variant', () => {
  it('pins a stable extension id via key', () => {
    expect(typeof dev.key).toBe('string');
    expect((dev.key as string).length).toBeGreaterThan(100);
  });
  it('allows a custom baseUrl origin (https://*/*)', () => {
    expect(dev.optional_host_permissions).toContain('https://*/*');
  });
});

describe('store variant', () => {
  it('omits key (CWS rejects packages that carry one)', () => {
    expect(dev.key).toBeDefined();
    expect(store.key).toBeUndefined();
  });
  it('omits the broad https://*/* optional origin', () => {
    expect(store.optional_host_permissions).not.toContain('https://*/*');
  });
});
