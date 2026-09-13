import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const SRC = resolve(__dirname, '..');
// Рев'ю гілки #617: `scripts/` rsync-иться в прод і запускається там (`npm run …`), тож він такий
// самий продакшн-код, як `src/`, і страж дивиться в обидва.
const SCRIPTS = resolve(__dirname, '..', '..', 'scripts');
const ROOT = resolve(__dirname, '..', '..');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsFiles(p));
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    if (name === 'seed-beer.testing.ts') continue;
    out.push(p);
  }
  return out;
}

// Той самий прийом, що в fetch-dispatcher-guard.test.ts: страж дивиться на код, а не на прозу —
// коментарі в beers.ts пояснюють, чому upsertBeer прибрано, і мусять лишатися можливими.
function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

// #617: upsertBeer (безумовний перезапис + фолбек за назвою) стирав рейтинги синком і переписував
// bid вінтаж-близнюка. Продакшн ходить через upsertBeerByBid / ensureOrphan; стара поведінка живе
// лише в тестовому сіді. Шостий викликач, що відродить її, мусить впасти тут, а не в проді.
test('no production module imports the test seed or revives upsertBeer (#617)', () => {
  const offenders: string[] = [];
  for (const file of [...tsFiles(SRC), ...tsFiles(SCRIPTS)]) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/seed-beer\.testing/.test(code) || /\b(?:upsertBeer|seedBeer)\b/.test(code)) {
      offenders.push(relative(ROOT, file));
    }
  }
  expect(offenders).toEqual([]);
});
