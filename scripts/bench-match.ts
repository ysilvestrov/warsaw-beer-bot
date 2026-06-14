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

// Tolerate a captured payload with trailing junk after the JSON (e.g. a stray `1`):
// parse as-is first, and only on failure fall back to slicing to the last closing
// brace/bracket. A clean array file (`[...]`) must not be truncated to its last `}`.
const raw = readFileSync(jsonPath, 'utf8');
function parsePayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    // Trailing junk only — there must be a closing brace/bracket to slice back to.
    // Otherwise the file is genuinely malformed: surface the original parse error
    // rather than JSON.parse('') ("Unexpected end of JSON input"), which hides it.
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end === -1) throw err;
    return JSON.parse(text.slice(0, end + 1));
  }
}
const parsed = parsePayload(raw);
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
