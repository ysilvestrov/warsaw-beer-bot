// #576 I2: argument parsing lived inline in `scripts/adjudicate-runner.ts`, un-tested by
// convention (`scripts/` isn't covered by `npm test`), and it showed: `--limit abc` parsed as
// `NaN`, sliced the row list to `[]`, and the run printed "verdicts written to …" and exited 0 —
// a rejected argument wearing the clothes of "this issue has no rows left", on the one tool built
// to stop confident wrong conclusions. `--limit=2` (the equals form) was silently ignored
// entirely, turning a requested trial run into a full live pass. Moving parsing here, as a pure
// function, is what makes both failure modes testable.
export const USAGE = 'usage: npm run adjudicate -- --issue <n> [--limit <n>] | --apply <file> [--force]';

const KNOWN_FLAGS = ['--issue', '--limit', '--apply', '--force'];

export type AdjudicateArgs =
  | { mode: 'probe'; issue: number; limit?: number }
  | { mode: 'apply'; path: string; force: boolean }
  | { mode: 'usage'; reason: string };

function usage(detail: string): { mode: 'usage'; reason: string } {
  return { mode: 'usage', reason: `${USAGE}\n(${detail})` };
}

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i < 0 ? undefined : argv[i + 1];
}

// Strict integer parse: `parseInt('5x', 10)` is `5` and `parseInt('', 10)` is `NaN`-but-truthy
// in some call shapes — both are exactly the silent-coercion failure mode I2 named. A full-string
// digit match rejects both, and `--issue`/`--limit` never take a negative number in this tool, so
// a leading `-` is rejected too rather than special-cased.
function parseStrictInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseAdjudicateArgs(argv: string[]): AdjudicateArgs {
  for (const a of argv) {
    if (a.startsWith('--') && a.includes('=')) {
      return usage(`'${a}' — use '--flag value', not '--flag=value'`);
    }
  }
  for (const a of argv) {
    if (a.startsWith('--') && !KNOWN_FLAGS.includes(a)) {
      return usage(`unknown flag '${a}'`);
    }
  }

  const hasApply = argv.includes('--apply');
  const hasIssue = argv.includes('--issue');
  if (hasApply && hasIssue) {
    return usage('--apply and --issue are mutually exclusive');
  }

  if (hasApply) {
    const path = arg(argv, '--apply');
    if (!path) return usage('--apply requires a file path');
    return { mode: 'apply', path, force: argv.includes('--force') };
  }

  if (!hasIssue) return { mode: 'usage', reason: USAGE };

  const issueRaw = arg(argv, '--issue');
  const issue = parseStrictInt(issueRaw);
  if (issue === null) return usage(`--issue must be a plain integer, got '${issueRaw}'`);

  if (argv.includes('--limit')) {
    const limitRaw = arg(argv, '--limit');
    const limit = parseStrictInt(limitRaw);
    if (limit === null || limit < 1) {
      return usage(`--limit must be an integer >= 1, got '${limitRaw}'`);
    }
    return { mode: 'probe', issue, limit };
  }

  return { mode: 'probe', issue };
}
