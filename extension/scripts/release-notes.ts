import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNotes } from '../src/shared/release-notes';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

const dist = resolve(root, 'dist');
if (!existsSync(dist)) {
  throw new Error('dist/ not found — run `vite build` first (npm run package does this).');
}

// Body only: the version lives in manifest.json and the broadcast prepends a
// localized "new version vX" header, so a header here would just duplicate it.
const notes = extractNotes(changelog, pkg.version); // throws if missing/empty → fails the build
writeFileSync(resolve(dist, 'RELEASE_NOTES.txt'), `${notes}\n`);
console.log(`Wrote dist/RELEASE_NOTES.txt for v${pkg.version}`);
