/**
 * `npm run verify-corpus -- --model <m> [--draws N] [--only <id-prefix>]`
 * `npm run verify-corpus -- --check [--only <id-prefix>]`
 *
 * The first form scores one model against the labelled verify corpus. Posts
 * nothing, writes nothing, reads file bodies out of git at each entry's pinned
 * sha, and spends money on the given model.
 *
 * `--check` makes no API call and takes no model: it re-derives each entry's
 * span from its own `quote` (the same way production does, `gate.ts`) and
 * checks it against the pinned tree, so an edited `matchedLine` or a retyped
 * `quote` is caught before it silently points every future measurement at the
 * wrong lines. See I5, final review fix wave.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_MAX_COMPLETION_TOKENS } from './openai';
import { addUsage, costUsd, EMPTY_USAGE } from './usage';
import { loadCorpus, type CorpusEntry } from './verify-corpus';
import { formatReport } from './verify-corpus-report';
import { gitBody, runDraw, type EntryOutcome } from './verify-corpus-run';
import { verifyAll } from './verify';

export interface ResolvedArgs {
  check: boolean;
  model: string;
  draws: number;
  only?: string;
}

export function resolveArgs(argv: string[]): ResolvedArgs {
  let model = '';
  let draws = 1;
  let drawsGiven = false;
  let only: string | undefined;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') model = argv[++i] ?? '';
    else if (a === '--draws') {
      draws = Number(argv[++i]);
      drawsGiven = true;
    } else if (a === '--only') {
      const v = argv[++i];
      // A `--only` with nothing usable behind it must stop the run. Both shapes
      // reach the same end if allowed through: `undefined` (it was the last
      // token) and `''` or whitespace (an unexpanded shell variable, the common
      // case). Downstream the filter is applied as `only ? filter : all`, so an
      // empty string reads as "no filter" — the operator asks for a subset and
      // silently pays for the whole corpus, with no FILTERED marker in the
      // report to show it happened. Found by the AI review on PR #698.
      if (v === undefined || v.trim() === '') throw new Error('--only requires a non-empty value');
      only = v;
    } else if (a === '--check') check = true;
    else throw new Error(`unrecognised argument: ${a}`);
  }
  if (check) {
    if (model) throw new Error('--check cannot be combined with --model');
    // #698's P2: `--check` used to return before the draw-count validation, so
    // `--draws 0` — and a valueless `--draws`, which is NaN — were accepted and
    // then quietly ignored. Rejecting the combination is the fix, not reordering
    // the validation: silently discarding an argument the operator typed is the
    // same defect as silently widening `--only`. This stands BEFORE the
    // positive-integer check on purpose, so the message names the real mistake
    // rather than complaining about a count that was never going to be used.
    if (drawsGiven) throw new Error('--draws is meaningless with --check, which never calls a model');
    return { check: true, model: '', draws, only };
  }
  if (!model) throw new Error('--model <name> is required');
  if (!Number.isInteger(draws) || draws < 1) throw new Error('--draws must be a positive integer');
  return { check: false, model, draws, only };
}

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * Re-derive one entry's span from its `quote` and check it against the pinned
 * tree. `readBody` is injected (same shape as `gitBody`) so tests never shell
 * out — see `runDraw`, which does the same for the same reason.
 */
export function checkEntry(entry: CorpusEntry, readBody: (sha: string, file: string) => string | null): CheckResult {
  const body = readBody(entry.sha, entry.file);
  if (body === null) {
    return { id: entry.id, ok: false, detail: `${entry.sha}:${entry.file} does not resolve` };
  }

  const lines = body.split('\n');
  const quoteLines = entry.quote.split('\n');
  const expectedSpan = entry.matchedEndLine - entry.matchedLine + 1;

  if (expectedSpan !== quoteLines.length) {
    return {
      id: entry.id,
      ok: false,
      detail:
        `matchedEndLine - matchedLine + 1 is ${expectedSpan} but the quote has ${quoteLines.length} line(s)`,
    };
  }

  if (entry.matchedLine < 1 || entry.matchedLine - 1 + quoteLines.length > lines.length) {
    return {
      id: entry.id,
      ok: false,
      detail: `matchedLine ${entry.matchedLine} is out of range for a ${lines.length}-line body`,
    };
  }

  const actual = lines.slice(entry.matchedLine - 1, entry.matchedLine - 1 + quoteLines.length).join('\n');
  if (actual !== entry.quote) {
    return {
      id: entry.id,
      ok: false,
      detail: `quote does not match ${entry.file}:${entry.matchedLine}-${entry.matchedEndLine} byte-for-byte`,
    };
  }

  return { id: entry.id, ok: true, detail: 'ok' };
}

function runCheck(only: string | undefined): number {
  const all = loadCorpus();
  const entries = only ? all.filter((e) => e.id.startsWith(only)) : all;
  if (entries.length === 0) throw new Error(`--only ${only} matched no entry`);

  let failed = 0;
  for (const entry of entries) {
    const result = checkEntry(entry, gitBody);
    console.log(`${result.ok ? 'ok' : 'FAIL'} ${result.id}: ${result.detail}`);
    if (!result.ok) failed++;
  }
  return failed;
}

async function main(): Promise<void> {
  const args = resolveArgs(process.argv.slice(2));

  if (args.check) {
    const failed = runCheck(args.only);
    if (failed > 0) process.exit(1);
    return;
  }

  const { model, draws, only } = args;
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

  console.log(formatReport({ model, draws: results, usage, costUsd: costUsd(model, usage), only }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
