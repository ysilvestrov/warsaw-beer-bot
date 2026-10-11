import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The container sees from the host only what deploy/image/warsaw-beer-bot.container mounts
 * (spec docs/superpowers/specs/2026-10/2026-10-11-wbb-image-deployment-design.md §3.2).
 * Every absolute host path literal in the bot's own source must sit under one of its
 * Volume= entries, or be listed below with the reason it needs none. A new path without
 * a Volume= fails here, in CI, instead of as EROFS/ENOENT in production.
 */
const ROOT = resolve(__dirname, '..');
const TEMPLATE = join(ROOT, 'deploy/image/warsaw-beer-bot.container');

/** Prefix -> why no Volume= is needed. */
const NO_VOLUME_NEEDED: Record<string, string> = {
  '/usr/bin/id': "a binary of the image itself; inside the container WBB_OPERATOR_UID replaces the lookup of 'ysi'",
  '/proc/self/fd/': "the container's own procfs (hardened-json.ts reopens a file through its directory fd)",
};

const HOST_PATH_LITERAL =
  /(['"`])(\/(?:var|etc|run|home|usr|proc|opt|srv|mnt|root|media)\/[^'"`\n]*)\1/g;

function hostPathLiterals(text: string): string[] {
  return [...text.matchAll(HOST_PATH_LITERAL)].map((m) => m[2]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test(ing)?\.ts$/.test(entry.name) ? [path] : [];
  });
}

interface Volume { host: string; container: string; mode: string }

function volumes(template: string): Volume[] {
  return template.split('\n')
    .filter((line) => line.startsWith('Volume='))
    .map((line) => {
      const [host, container, mode] = line.slice('Volume='.length).split(':');
      return { host, container, mode };
    });
}

/** At or below `prefix`, component-wise: /var/lib/wbb-x is not under /var/lib/wbb. */
const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix.replace(/\/$/, '')}/`);

function literalsInSrc(): { file: string; literal: string }[] {
  return sourceFiles(join(ROOT, 'src')).flatMap((file) =>
    hostPathLiterals(readFileSync(file, 'utf8')).map((literal) => ({ file: relative(ROOT, file), literal })));
}

describe('image Volume= coverage', () => {
  test('the template mounts exactly the four host paths of spec §3.2, each at the same path', () => {
    expect(volumes(readFileSync(TEMPLATE, 'utf8'))).toEqual([
      { host: '/var/lib/warsaw-beer-bot', container: '/var/lib/warsaw-beer-bot', mode: 'rw' },
      { host: '/var/lib/wbb-host-patch', container: '/var/lib/wbb-host-patch', mode: 'rw' },
      { host: '/var/tmp/wbb-host-patch', container: '/var/tmp/wbb-host-patch', mode: 'ro' },
      { host: '/var/tmp/wbb-resource-monitor', container: '/var/tmp/wbb-resource-monitor', mode: 'ro' },
    ]);
  });

  test('the scanner finds host paths in all three quote styles and nothing else', () => {
    const text = [
      "const a = '/var/lib/x/db.sqlite';",
      'const b = "/etc/wbb/conf";',
      'const c = `/proc/self/fd/${fd}/name`;',
      "const route = '/api/health';",
      "const rel = 'var/lib/not-absolute';",
      "const tmp = '/tmp/scratch';",
    ].join('\n');
    expect(hostPathLiterals(text)).toEqual(['/var/lib/x/db.sqlite', '/etc/wbb/conf', '/proc/self/fd/${fd}/name']);
  });

  test('every host path literal in src/ is under a Volume= or needs none', () => {
    const mounted = volumes(readFileSync(TEMPLATE, 'utf8')).map((v) => v.container);
    const covers = [...mounted, ...Object.keys(NO_VOLUME_NEEDED)];
    const uncovered = literalsInSrc().filter(({ literal }) => !covers.some((p) => under(literal, p)));
    expect(uncovered).toEqual([]);
  });

  test('every no-Volume exception still matches a literal in src/', () => {
    const literals = literalsInSrc().map((l) => l.literal);
    const stale = Object.keys(NO_VOLUME_NEEDED).filter((p) => !literals.some((l) => under(l, p)));
    expect(stale).toEqual([]);
  });
});
