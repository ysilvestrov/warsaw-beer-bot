import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// #924: src/shared/ is bundled into the browser extension. Its code may import only itself and
// the browser-safe packages below; anything else would either break the extension build or pull
// server code (SQLite, Node APIs) into the service worker.
const ALLOWED_PACKAGES = ['cheerio', 'domhandler'];
const SHARED = resolve(__dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g;

function violationsOf(file: string, text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1]).flatMap((spec) => {
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec);
      return target === SHARED || target.startsWith(SHARED + sep) ? [] : [`${spec} (outside src/shared)`];
    }
    return ALLOWED_PACKAGES.includes(spec) ? [] : [`${spec} (package not allowed)`];
  }).map((v) => `${relative(SHARED, file).split(sep).join('/')}: ${v}`);
}

describe('src/shared import boundary', () => {
  it('imports nothing outside src/shared except the allowed browser packages', () => {
    const found = sourceFiles(SHARED).flatMap((file) => violationsOf(file, readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });

  it('reports a server import, a Node built-in and a foreign package, and accepts shared and allowed ones', () => {
    const file = join(SHARED, 'untappd', 'probe.ts');
    const text = [
      "import { db } from '../../storage/db';",
      "import { readFileSync } from 'node:fs';",
      "import { z } from 'zod';",
      "import * as cheerio from 'cheerio';",
      "import type { Element } from 'domhandler';",
      "export * from './checkin-feed';",
      "import { mergeRange } from '../checkin-sync/coverage';",
    ].join('\n');
    expect(violationsOf(file, text)).toEqual([
      'untappd/probe.ts: ../../storage/db (outside src/shared)',
      'untappd/probe.ts: node:fs (package not allowed)',
      'untappd/probe.ts: zod (package not allowed)',
    ]);
  });
});
