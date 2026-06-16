import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/storage/beers';
import { matchBeerList } from '../src/domain/match-list';

async function main(): Promise<void> {
  const db = new Database('/var/lib/warsaw-beer-bot/bot.db', { readonly: true });
  const catalog = loadCatalog(db);
  const beers = JSON.parse(readFileSync('tmp/beerrepublic.json', 'utf8'));
  const t0 = performance.now();
  const results = await matchBeerList(catalog, new Set(), new Map(), beers);
  const ms = performance.now() - t0;
  const matched = results.filter((r) => r.matched_beer !== null).length;
  console.log(`catalog=${catalog.length} beers=${beers.length}`);
  console.log(`total=${ms.toFixed(0)}ms perBeer=${(ms/beers.length).toFixed(1)}ms matched=${matched}/${beers.length}`);
  db.close();
}
void main();
