/**
 * Migration contract lint (spec 2026-10-11 §6.5) — a REVIEW SIGNAL, not a proof.
 *
 * Rolling back only the code means the previous release must still run on the schema the
 * candidate left behind. Expand changes (new table, nullable/DEFAULT column, index) keep
 * that true; contract changes (DROP, RENAME, table rebuild, UPDATE/DELETE of existing rows)
 * do not, so they wait until the release that stopped using the old form is settled and
 * are deployed by a human (§6.2, §6.4). This check reads the SQL of the migrations the PR
 * adds and asks for the `migration:contract` label + [deploy:hold] when it sees contract
 * keywords. It does not see data-format changes made in TypeScript — those are
 * `rollback:unsafe` or a targeted compatibility test, decided on review.
 *
 * Usage (deploy-hold workflow; HEAD is the PR merge ref, HEAD^1 the base):
 *   git show HEAD^1:src/storage/schema.ts | PR_TITLE=… PR_LABELS='[…]' tsx scripts/migrations/contract-lint.ts
 * Exits 0 ok / 1 problems / 2 could not run.
 */
import { readFileSync } from 'node:fs';
import { HOLD_LABEL, HOLD_MARKER } from '../autodeploy/deploy-hold-check';
import { MIGRATIONS } from '../../src/storage/schema';

export const CONTRACT_LABEL = 'migration:contract';
export const UNSAFE_LABEL = 'rollback:unsafe';
export const REVIEW_SIGNAL_NOTE =
  'This lint is a review signal, not a proof of rollback safety: it reads migration SQL only and never sees data-format changes in TypeScript (spec 2026-10-11 §6.2, §6.5).';

type Migration = { version: number; sql: string };

/**
 * One pass over the SQL: comments become a single space; string literals ('…', with ''
 * escapes) and quoted identifiers ("…") are kept, or blanked when `maskQuoted` — a keyword
 * inside them is data, and a comment opener inside them is not a comment.
 */
function scan(sql: string, maskQuoted: boolean): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      out += ' ';
      i = nl === -1 ? sql.length : nl;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j += 1;
      }
      const body = sql.slice(i + 1, j);
      out += c + (maskQuoted ? ' '.repeat(body.length) : body) + (j < sql.length ? c : '');
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export function stripSqlComments(sql: string): string {
  return scan(sql, false);
}

const KEYWORDS: ReadonlyArray<[string, RegExp]> = [
  ['DROP', /\bDROP\b/i],
  ['RENAME', /\bRENAME\b/i],
  ['UPDATE', /\bUPDATE\b/i],
  ['DELETE', /\bDELETE\b/i],
  // Within one statement: the table-rebuild copy. A ; inside a literal is already masked.
  ['INSERT … SELECT', /\bINSERT\b[^;]*\bSELECT\b/i],
];

/** Contract keywords the SQL runs, outside comments and literals, in KEYWORDS order. */
export function contractKeywords(sql: string): string[] {
  // A foreign-key action (REFERENCES … ON DELETE CASCADE) is part of a CREATE TABLE, not DML.
  const code = scan(sql, true).replace(/\bON\s+(DELETE|UPDATE)\b/gi, ' ');
  return KEYWORDS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

/** Largest `version:` key of a MIGRATIONS entry in schema.ts source (a line's first token). */
export function baseMaxVersion(schemaSource: string): number {
  const versions = [...schemaSource.matchAll(/^\s*(?:\{\s*)?version:\s*(\d+)/gm)].map((m) => Number(m[1]));
  if (versions.length === 0) throw new Error('no `version:` entries in the base schema.ts');
  return Math.max(...versions);
}

export function lintMigrations(i: {
  migrations: ReadonlyArray<Migration>; baseMax: number; title: string; labels: string[];
}): { ok: boolean; contract: Array<{ version: number; keywords: string[] }>; problems: string[] } {
  const contract = i.migrations
    .filter((m) => m.version > i.baseMax)
    .map((m) => ({ version: m.version, keywords: contractKeywords(m.sql) }))
    .filter((m) => m.keywords.length > 0);
  const held = i.title.startsWith(HOLD_MARKER) && i.labels.includes(HOLD_LABEL);
  const problems: string[] = [];
  if (!i.labels.includes(CONTRACT_LABEL)) {
    for (const m of contract) {
      problems.push(`migration v${m.version} runs ${m.keywords.join(', ')} — contract SQL (spec 2026-10-11 §6.2): label the PR ${CONTRACT_LABEL}, prefix the title with ${HOLD_MARKER} and add the ${HOLD_LABEL} label`);
    }
  }
  for (const label of [CONTRACT_LABEL, UNSAFE_LABEL]) {
    if (i.labels.includes(label) && !held) {
      problems.push(`${label} needs the ${HOLD_MARKER} title marker and the ${HOLD_LABEL} label — such a change is deployed by a human (spec 2026-10-11 §6.4)`);
    }
  }
  return { ok: problems.length === 0, contract, problems };
}

function main(): number {
  let labels: unknown;
  try {
    labels = JSON.parse(process.env.PR_LABELS ?? '[]');
  } catch {
    labels = null;
  }
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    console.error('PR_LABELS must be a JSON array of label names');
    return 2;
  }
  let baseMax: number;
  try {
    baseMax = baseMaxVersion(readFileSync(0, 'utf8'));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const r = lintMigrations({ migrations: MIGRATIONS, baseMax, title: process.env.PR_TITLE ?? '', labels });
  for (const p of r.problems) console.log(`✗ ${p}`);
  if (!r.ok) {
    console.log(REVIEW_SIGNAL_NOTE);
    return 1;
  }
  const found = r.contract.map((m) => `v${m.version} (${m.keywords.join(', ')})`).join(', ');
  console.log(r.contract.length > 0 ? `OK: contract SQL in ${found}, labelled ${CONTRACT_LABEL} and held. ${REVIEW_SIGNAL_NOTE}` : 'OK');
  return 0;
}

if (require.main === module) process.exitCode = main();
