import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// #924: the extension may reach outside its own package only into src/shared/ — the browser-safe
// core it shares with the server. Any other path into the repo root would bundle server code.
const EXT_SRC = resolve(__dirname, '..');
const EXT_ROOT = resolve(EXT_SRC, '..');
const SHARED = resolve(EXT_ROOT, '../src/shared');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s+['"](\.[^'"]*)['"]/g;

function violationsOf(file: string, text: string): string[] {
  return [...text.matchAll(IMPORT_RE)].map((m) => m[1]).flatMap((spec) => {
    const target = resolve(dirname(file), spec);
    const insideExtension = target === EXT_ROOT || target.startsWith(EXT_ROOT + sep);
    const insideShared = target === SHARED || target.startsWith(SHARED + sep);
    return insideExtension || insideShared ? [] : [`${relative(EXT_ROOT, file).split(sep).join('/')}: ${spec}`];
  });
}

describe('extension import boundary', () => {
  it('imports from outside the extension only src/shared/', () => {
    const found = sourceFiles(EXT_SRC).flatMap((file) => violationsOf(file, readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });

  it('reports a server import and accepts shared and extension-local ones', () => {
    const file = join(EXT_SRC, 'local', 'probe.ts');
    const text = [
      "import { openDb } from '../../../src/storage/db';",
      "import { checkPage } from '../../../src/shared/checkin-sync/guards';",
      "import { ApiError } from '../api/client';",
    ].join('\n');
    expect(violationsOf(file, text)).toEqual(['src/local/probe.ts: ../../../src/storage/db']);
  });
});
