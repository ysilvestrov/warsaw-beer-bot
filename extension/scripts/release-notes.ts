import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractNotes } from '../src/shared/release-notes';

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');

const dist = resolve(root, 'dist');
if (!existsSync(dist)) {
  throw new Error('dist/ not found — run `vite build` first (npm run package does this).');
}

const notes = extractNotes(changelog, pkg.version); // throws if missing/empty → fails the build
const out = `Warsaw Beer Overlay v${pkg.version}\n\n${notes}\n`;
writeFileSync(resolve(dist, 'RELEASE_NOTES.txt'), out);
console.log(`Wrote dist/RELEASE_NOTES.txt for v${pkg.version}`);
