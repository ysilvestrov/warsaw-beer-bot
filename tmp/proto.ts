import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/storage/beers';
import { prepareBeer, breweryAliases, breweryAliasesMatch } from '../src/domain/matcher';

const firstTok = (a: string) => a.split(' ', 1)[0];

async function main(): Promise<void> {
  const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true });
  const catalog = loadCatalog(db);
  const beers = JSON.parse(readFileSync('tmp/beerrepublic.json', 'utf8'));
  const prepared = catalog.map(prepareBeer);

  // Build first-token -> rows index
  const idx = new Map<string, typeof prepared>();
  for (const c of prepared) for (const a of c.aliases) {
    const k = firstTok(a);
    let b = idx.get(k); if (!b) idx.set(k, b = []);
    if (b[b.length-1] !== c) b.push(c);
  }

  let mismatch = 0, tIdx = 0, tFull = 0;
  for (const item of beers) {
    const ia = breweryAliases(item.brewery);
    // full scan (baseline)
    let t = performance.now();
    const full = prepared.filter((c) => breweryAliasesMatch(c.aliases, ia));
    tFull += performance.now() - t;
    // indexed
    t = performance.now();
    const seen = new Set<typeof prepared[0]>();
    for (const a of ia) for (const c of (idx.get(firstTok(a)) ?? [])) {
      if (!seen.has(c) && breweryAliasesMatch(c.aliases, ia)) seen.add(c);
    }
    tIdx += performance.now() - t;
    if (seen.size !== full.length || !full.every((c) => seen.has(c))) mismatch++;
  }
  console.log(`fullScan=${tFull.toFixed(0)}ms indexed=${tIdx.toFixed(0)}ms mismatchBeers=${mismatch}/${beers.length}`);
  db.close();
}
void main();
