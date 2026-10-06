/**
 * #795 — reads `npm audit --omit=dev --json` on stdin, prints the verdict, and
 * exits 0 clean / 10 advisory / 2 could not run; 10 because Node itself exits 1 on any
 * uncaught load or transform error, so 1 must never mean advisory. Callers treat anything
 * other than 0 and 10 as could not run.
 *
 * Usage: npm audit --omit=dev --json | tsx scripts/autodeploy/audit-verdict-cli.ts
 *
 * A crash inside the try exits 2; a crash outside it (failed import) exits 1, which
 * callers read as could not run.
 */
import { readFileSync } from 'node:fs';
import { auditVerdict, renderVerdict, verdictExitCode } from './audit-verdict';

try {
  const verdict = auditVerdict(readFileSync(0, 'utf8'));
  process.stdout.write(`${renderVerdict(verdict)}\n`);
  process.exitCode = verdictExitCode(verdict);
} catch (e) {
  process.stderr.write(`audit-verdict: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
