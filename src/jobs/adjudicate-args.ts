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

// Strict integer parse: `parseInt('5x', 10)` is `5` and `parseInt('', 10)` is `NaN`-but-truthy
// in some call shapes — both are exactly the silent-coercion failure mode I2 named. A full-string
// digit match rejects both, and `--issue`/`--limit` never take a negative number in this tool, so
// a leading `-` is rejected too rather than special-cased.
function parseStrictInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// #576 (рев'ю PR #580): раніше кожен прапорець шукався незалежно (`argv.indexOf`), тому
// нічого не помічало ані зайвих токенів, ані того, що «значення» саме є прапорцем. Обхід
// зліва направо робить обидва випадки неможливими за побудовою: кожен токен або прапорець,
// який ми знаємо, або його значення, або помилка. Мовчазного ігнорування не лишається.
export function parseAdjudicateArgs(argv: string[]): AdjudicateArgs {
  const seen = new Map<string, string>();
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) return usage(`unexpected argument '${a}'`);
    if (a.includes('=')) return usage(`'${a}' — use '--flag value', not '--flag=value'`);
    if (!KNOWN_FLAGS.includes(a)) return usage(`unknown flag '${a}'`);
    if (a === '--force') {
      if (force) return usage(`'--force' given twice`);
      force = true;
      continue;
    }
    if (seen.has(a)) return usage(`'${a}' given twice`);
    const value = argv[i + 1];
    // Прапорець на місці значення — це не значення. Інакше `--apply --force` читалося б як
    // «застосуй файл з іменем --force».
    if (value === undefined || value.startsWith('--')) {
      return usage(`${a} requires a value`);
    }
    seen.set(a, value);
    i += 1;
  }

  const hasApply = seen.has('--apply');
  const hasIssue = seen.has('--issue');
  if (hasApply && hasIssue) return usage('--apply and --issue are mutually exclusive');

  if (hasApply) {
    // Прапорець із чужого режиму — це не дрібниця, яку можна проковтнути: він означає, що
    // оператор думав, що робить щось інше, ніж робить насправді.
    if (seen.has('--limit')) return usage('--limit belongs to a probe run, not to --apply');
    return { mode: 'apply', path: seen.get('--apply') as string, force };
  }

  if (!hasIssue) return { mode: 'usage', reason: USAGE };
  if (force) return usage('--force belongs to --apply, not to a probe run');

  const issueRaw = seen.get('--issue');
  const issue = parseStrictInt(issueRaw);
  if (issue === null) return usage(`--issue must be a plain integer, got '${issueRaw}'`);

  if (seen.has('--limit')) {
    const limitRaw = seen.get('--limit');
    const limit = parseStrictInt(limitRaw);
    if (limit === null || limit < 1) {
      return usage(`--limit must be an integer >= 1, got '${limitRaw}'`);
    }
    return { mode: 'probe', issue, limit };
  }

  return { mode: 'probe', issue };
}
