/**
 * #795 — reads `npm audit --omit=dev --json` on stdin, prints the verdict, and
 * exits 0 clean / 1 advisory / 2 could not run.
 *
 * Usage: npm audit --omit=dev --json | tsx scripts/autodeploy/audit-verdict-cli.ts
 *
 * A crash here must exit 2, never 1: merge-deploy reads 1 as "this commit carries
 * an advisory" and never retries it.
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
