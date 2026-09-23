/**
 * `npm run verify-corpus -- --model <m> [--draws N] [--only <id-prefix>]`
 *
 * Scores one model against the labelled verify corpus. Posts nothing, writes
 * nothing, reads file bodies out of git at each entry's pinned sha.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_MAX_COMPLETION_TOKENS } from './openai';
import { addUsage, costUsd, EMPTY_USAGE } from './usage';
import { loadCorpus } from './verify-corpus';
import { formatReport } from './verify-corpus-report';
import { gitBody, runDraw, type EntryOutcome } from './verify-corpus-run';
import { verifyAll } from './verify';

export function resolveArgs(argv: string[]): { model: string; draws: number; only?: string } {
  let model = '';
  let draws = 1;
  let only: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') model = argv[++i] ?? '';
    else if (a === '--draws') draws = Number(argv[++i]);
    else if (a === '--only') only = argv[++i];
    else throw new Error(`unrecognised argument: ${a}`);
  }
  if (!model) throw new Error('--model <name> is required');
  if (!Number.isInteger(draws) || draws < 1) throw new Error('--draws must be a positive integer');
  return { model, draws, only };
}

async function main(): Promise<void> {
  const { model, draws, only } = resolveArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const endpoint = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';

  const all = loadCorpus();
  const entries = only ? all.filter((e) => e.id.startsWith(only)) : all;
  if (entries.length === 0) throw new Error(`--only ${only} matched no entry`);

  const instructions = readFileSync('.github/ai-review/VERIFY.md', 'utf8');
  const results: EntryOutcome[][] = [];
  let usage = EMPTY_USAGE;

  for (let d = 0; d < draws; d++) {
    const out = await runDraw({
      entries,
      instructions,
      readBody: gitBody,
      verify: verifyAll,
      deps: { endpoint, apiKey, model },
      // Every judge gets the same generous budget so a verbose one does not hit
      // the production ceiling more often and lose findings to #691.
      maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
    });
    results.push(out.outcomes);
    usage = addUsage(usage, out.usage);
  }

  console.log(formatReport({ model, draws: results, usage, costUsd: costUsd(model, usage) }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
