import type { DB } from '../src/storage/db';
import type { HydratedBeer } from '../src/sources/untappd/search';
import { previewLegacyCardRepair, applyLegacyCardRepair } from '../src/domain/repair-legacy-card';
import { loadOperatorEnv } from './operator-env';
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';
import { ALGOLIA_DEFAULTS, createAlgoliaSearch } from '../src/sources/untappd/algolia';

export interface RepairCliArgs {
  beerId: number;
  issueNumber: number;
  cardAbv: number | null;
  bid: number;
  evidenceUrl: string;
  reason: string;
  operator: string;
  overwriteAbv: boolean;
  apply: boolean;
}

const VALUE_FLAGS = [
  '--beer', '--issue', '--card-abv', '--bid', '--evidence', '--reason', '--operator',
] as const;
const SWITCH_FLAGS = ['--overwrite-abv', '--apply'] as const;

export function parseRepairCliArgs(argv: string[]): RepairCliArgs {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      if (values.has(flag)) throw new Error(`repeated flag: ${flag}`);
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      values.set(flag, value);
    } else if ((SWITCH_FLAGS as readonly string[]).includes(flag)) {
      if (switches.has(flag)) throw new Error(`repeated flag: ${flag}`);
      switches.add(flag);
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  for (const flag of VALUE_FLAGS) {
    if (!values.has(flag)) throw new Error(`missing required flag: ${flag}`);
  }
  const positiveId = (flag: string): number => {
    const raw = values.get(flag)!;
    if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
    return value;
  };
  const rawAbv = values.get('--card-abv')!;
  if (rawAbv !== 'absent' && !/^\d+(?:\.\d+)?$/.test(rawAbv)) {
    throw new Error('--card-abv must be a decimal or absent');
  }
  const cardAbv = rawAbv === 'absent' ? null : Number(rawAbv);
  if (cardAbv !== null && (!Number.isFinite(cardAbv) || cardAbv > 100)) {
    throw new Error('--card-abv must be between 0 and 100');
  }
  const evidenceUrl = values.get('--evidence')!;
  let url: URL;
  try { url = new URL(evidenceUrl); } catch { throw new Error('--evidence must be an HTTP(S) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--evidence must be an HTTP(S) URL');
  }
  const reason = values.get('--reason')!;
  const operator = values.get('--operator')!;
  if (!reason.trim() || !operator.trim()) throw new Error('--reason and --operator must be nonempty');
  return {
    beerId: positiveId('--beer'), issueNumber: positiveId('--issue'),
    cardAbv, bid: positiveId('--bid'), evidenceUrl, reason, operator,
    overwriteAbv: switches.has('--overwrite-abv'), apply: switches.has('--apply'),
  };
}

export async function runRepairLegacyCard(
  argv: string[], deps: {
    db: DB;
    hydrate: (bids: number[]) => Promise<Map<number, HydratedBeer | null>>;
    print: (line: string) => void;
  },
): Promise<void> {
  const args = parseRepairCliArgs(argv);
  const schemaVersion = (deps.db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as
    { version: number | null }).version ?? 0;
  const readyToApply = schemaVersion >= 34;
  if (args.apply && !readyToApply) {
    throw new Error(`schema v34 migration is required before --apply (current v${schemaVersion})`);
  }
  const record = (await deps.hydrate([args.bid])).get(args.bid);
  if (!record || record.bid !== args.bid) throw new Error(`could not hydrate exact bid ${args.bid}`);
  const input = {
    beerId: args.beerId, issueNumber: args.issueNumber, cardAbv: args.cardAbv,
    bid: args.bid, evidenceUrl: args.evidenceUrl, reason: args.reason,
    operator: args.operator, overwriteAbv: args.overwriteAbv,
    hydrated: record, at: new Date().toISOString(),
  };
  if (args.apply && deps.db.prepare('SELECT 1 FROM legacy_card_repairs WHERE orphan_beer_id = ?')
    .get(args.beerId)) {
    deps.print(JSON.stringify(applyLegacyCardRepair(deps.db, input)));
    return;
  }
  const preview = previewLegacyCardRepair(deps.db, input);
  deps.print(JSON.stringify({
    ...preview, schemaVersion, readyToApply,
    evidenceUrl: args.evidenceUrl, reason: args.reason,
    operator: args.operator, apply: args.apply,
  }, null, 2));
  if (!args.apply) return;
  deps.print(JSON.stringify(applyLegacyCardRepair(deps.db, input, preview)));
}

async function main(argv: string[]): Promise<void> {
  parseRepairCliArgs(argv); // Usage errors must not open a database or load production config.
  loadOperatorEnv();
  const env = loadEnv();
  const db = openDb(env.DATABASE_PATH);
  try {
    const search = createAlgoliaSearch({
      appId: env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
      searchKey: env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
      proxyUrl: env.WEBSHARE_PROXY,
    });
    await runRepairLegacyCard(argv, {
      db, hydrate: (bids) => search.hydrateByBid(bids), print: console.log,
    });
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
