import type { DB } from '../src/storage/db';
import {
  applyLegacyOrphanDisposition, applyLegacyOrphanReopen,
  previewLegacyOrphanDisposition, previewLegacyOrphanReopen,
  type LegacyDispositionInput, type LegacyReopenInput,
} from '../src/domain/dispose-legacy-orphan';
import { findActiveDispositionForBeer } from '../src/storage/legacy-orphan-dispositions';
import { loadOperatorEnv } from './operator-env';
import { loadEnv } from '../src/config/env';
import { openDb } from '../src/storage/db';

type CliArgs =
  | { mode: 'activate'; input: Omit<LegacyDispositionInput, 'at'>; apply: boolean }
  | { mode: 'reopen'; input: Omit<LegacyReopenInput, 'at'>; apply: boolean };

const VALUE_FLAGS = [
  '--beer', '--issue', '--card-brewery', '--card-name', '--card-abv',
  '--reopen', '--reason', '--evidence', '--operator',
] as const;

function positiveId(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

export function parseDispositionCliArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      if (apply) throw new Error('repeated flag: --apply');
      apply = true;
    } else if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
      if (values.has(flag)) throw new Error(`repeated flag: ${flag}`);
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      values.set(flag, value);
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  for (const flag of ['--reason', '--evidence', '--operator']) {
    if (!values.has(flag)) throw new Error(`missing required flag: ${flag}`);
  }
  const reason = values.get('--reason')!;
  const evidenceUrl = values.get('--evidence')!;
  const operator = values.get('--operator')!;
  if (!reason.trim() || !operator.trim()) throw new Error('--reason and --operator must be nonempty');
  let url: URL;
  try { url = new URL(evidenceUrl); } catch { throw new Error('--evidence must be an HTTP(S) URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--evidence must be an HTTP(S) URL');
  }
  if (values.has('--reopen')) {
    for (const flag of ['--beer', '--issue', '--card-brewery', '--card-name', '--card-abv']) {
      if (values.has(flag)) throw new Error(`${flag} is not valid with --reopen`);
    }
    return {
      mode: 'reopen', apply,
      input: { episodeId: positiveId(values.get('--reopen')!, '--reopen'), reason, evidenceUrl, operator },
    };
  }
  for (const flag of ['--beer', '--issue', '--card-brewery', '--card-name', '--card-abv']) {
    if (!values.has(flag)) throw new Error(`missing required flag: ${flag}`);
  }
  const rawAbv = values.get('--card-abv')!;
  if (rawAbv !== 'absent' && !/^\d+(?:\.\d+)?$/.test(rawAbv)) {
    throw new Error('--card-abv must be a decimal or absent');
  }
  const cardAbv = rawAbv === 'absent' ? null : Number(rawAbv);
  if (cardAbv !== null && (!Number.isFinite(cardAbv) || cardAbv > 100)) {
    throw new Error('--card-abv must be between 0 and 100');
  }
  const cardBrewery = values.get('--card-brewery')!;
  const cardName = values.get('--card-name')!;
  if (!cardBrewery.trim() || !cardName.trim()) {
    throw new Error('--card-brewery and --card-name must be nonempty');
  }
  return {
    mode: 'activate', apply,
    input: {
      beerId: positiveId(values.get('--beer')!, '--beer'),
      issueNumber: positiveId(values.get('--issue')!, '--issue'),
      cardBrewery, cardName, cardAbv, reason, evidenceUrl, operator,
    },
  };
}

export function runDisposeLegacyOrphan(
  argv: string[], deps: { db: DB; print: (line: string) => void },
): void {
  const args = parseDispositionCliArgs(argv);
  const schemaVersion = (deps.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
    { v: number | null }).v ?? 0;
  const readyToApply = schemaVersion >= 35;
  if (args.apply && !readyToApply) {
    throw new Error(`schema v35 required before --apply (current v${schemaVersion})`);
  }
  if (!readyToApply) {
    deps.print(JSON.stringify({ schemaVersion, readyToApply, apply: false, ...args }, null, 2));
    return;
  }
  const at = new Date().toISOString();
  if (args.mode === 'activate') {
    const input = { ...args.input, at };
    if (args.apply && findActiveDispositionForBeer(deps.db, input.beerId)) {
      deps.print(JSON.stringify(applyLegacyOrphanDisposition(deps.db, input)));
      return;
    }
    const preview = previewLegacyOrphanDisposition(deps.db, input);
    deps.print(JSON.stringify({ ...preview, schemaVersion, readyToApply,
      apply: args.apply, reason: input.reason, evidenceUrl: input.evidenceUrl,
      operator: input.operator }, null, 2));
    if (args.apply) deps.print(JSON.stringify(applyLegacyOrphanDisposition(deps.db, input, preview)));
    return;
  }
  const input = { ...args.input, at };
  const episode = deps.db.prepare('SELECT reopened_at FROM legacy_orphan_dispositions WHERE id = ?')
    .get(input.episodeId) as { reopened_at: string | null } | undefined;
  if (args.apply && episode?.reopened_at != null) {
    deps.print(JSON.stringify(applyLegacyOrphanReopen(deps.db, input)));
    return;
  }
  const preview = previewLegacyOrphanReopen(deps.db, input);
  deps.print(JSON.stringify({ ...preview, schemaVersion, readyToApply,
    apply: args.apply, reason: input.reason, evidenceUrl: input.evidenceUrl,
    operator: input.operator }, null, 2));
  if (args.apply) deps.print(JSON.stringify(applyLegacyOrphanReopen(deps.db, input, preview)));
}

function main(argv: string[]): void {
  parseDispositionCliArgs(argv); // Refuse usage errors before touching production config or DB.
  loadOperatorEnv();
  const env = loadEnv();
  const db = openDb(env.DATABASE_PATH);
  try {
    runDisposeLegacyOrphan(argv, { db, print: console.log });
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
