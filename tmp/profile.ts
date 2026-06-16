import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/storage/beers';
import { prepareBeer, makePreparedCatalog, breweryAliases, breweryAliasesMatch } from '../src/domain/matcher';

async function main(): Promise<void> {
  const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true });
  const catalog = loadCatalog(db);
  const beers = JSON.parse(readFileSync('tmp/beerrepublic.json', 'utf8'));

  let tPrep = performance.now();
  const prepared = catalog.map(prepareBeer);
  const pc = makePreparedCatalog(prepared);
  tPrep = performance.now() - tPrep;

  // Per-beer: time the exact-filter brewery-alias scan over the whole catalog.
  let tAliasScan = 0, poolHits = 0, emptyPool = 0;
  for (const item of beers) {
    const ia = breweryAliases(item.brewery);
    const t = performance.now();
    let pool = 0;
    for (const c of prepared) if (breweryAliasesMatch(c.aliases, ia)) pool++;
    tAliasScan += performance.now() - t;
    if (pool === 0) emptyPool++; else poolHits++;
  }
  console.log(`catalog=${catalog.length} beers=${beers.length}`);
  console.log(`prepareCatalog=${tPrep.toFixed(0)}ms`);
  console.log(`aliasScan(1x per beer)=${tAliasScan.toFixed(0)}ms  -> exact+fuzzy do this 2x`);
  console.log(`beers with brewery in catalog=${poolHits}  emptyPool(->fullSearcher)=${emptyPool}`);
  db.close();
}
void main();
