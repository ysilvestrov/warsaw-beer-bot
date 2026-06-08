// Manual benchmark — NOT part of CI. Measures matchBeerList over a real payload
// against the prod DB (read-only). Run:
//   npx tsx scripts/bench-match.ts /var/lib/warsaw-beer-bot/bot.db /home/ysi/warsaw-beer-bot/input.json
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/storage/beers';
import { matchBeerList } from '../src/domain/match-list';

const [dbPath, jsonPath] = process.argv.slice(2);
if (!dbPath || !jsonPath) {
  console.error('usage: bench-match.ts <db-path> <input.json>');
  process.exit(1);
}

// input.json has a stray trailing `1` after the JSON — slice to the last `}`.
const raw = readFileSync(jsonPath, 'utf8');
const json = raw.slice(0, raw.lastIndexOf('}') + 1);
const parsed = JSON.parse(json);
const beers: { brewery: string; name: string; abv?: number }[] =
  Array.isArray(parsed) ? parsed : parsed.beers;

// Wrapped in an async main() because matchBeerList is async and the project
// compiles to CommonJS (no top-level await).
async function main(): Promise<void> {
  const db = new Database(dbPath, { readonly: true });
  const catalog = loadCatalog(db);

  const t0 = performance.now();
  const results = await matchBeerList(catalog, new Set(), new Map(), beers);
  const ms = performance.now() - t0;

  const matched = results.filter((r) => r.matched_beer !== null).length;
  console.log(`catalog=${catalog.length} beers=${beers.length}`);
  console.log(`total=${ms.toFixed(0)}ms  perBeer=${(ms / beers.length).toFixed(1)}ms  matched=${matched}/${beers.length}`);
  db.close();
}

void main();
