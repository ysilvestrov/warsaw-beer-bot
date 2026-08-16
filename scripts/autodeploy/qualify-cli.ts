/**
 * #435 — I/O wrapper around qualify() and manifestScope().
 *
 * Usage: tsx scripts/autodeploy/qualify-cli.ts <baseDir> <headDir> <changedPathsFile>
 *
 * <baseDir> and <headDir> each hold a package.json, a package-lock.json and an
 * audit.json produced by `npm audit --omit=dev --json`. The workflow extracts
 * them with `git show`; nothing here installs anything, so no package's install
 * scripts ever run.
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { qualify, type AuditReport, type Severity } from './qualify';
import { manifestScope, type DepSections } from './manifest-scope';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * An absent or malformed audit report must be an ERROR, never a silent pass.
 * A failing `npm audit` invocation (e.g. `ENOLOCK`) emits `{"error":{...}}`
 * with no `vulnerabilities` key; the workflow captures stdout with `|| true`
 * regardless of exit code, and the two audits are separate invocations, so a
 * transient registry failure on one of them is an ordinary CI event that
 * must stop the run rather than read as "clean".
 */
export function auditReport(dir: string): AuditReport {
  const raw = readFileSync(join(dir, 'audit.json'), 'utf8').trim();
  if (raw === '') {
    throw new Error(`audit.json in ${dir} is empty — npm audit did not produce a report`);
  }
  const parsed = JSON.parse(raw) as { error?: unknown; vulnerabilities?: AuditReport['vulnerabilities'] };
  if ('error' in parsed) {
    throw new Error(`audit.json in ${dir} reports an error, not an audit: ${JSON.stringify(parsed.error)}`);
  }
  if (parsed.vulnerabilities === undefined) {
    throw new Error(`audit.json in ${dir} has no "vulnerabilities" field — not a well-formed audit report`);
  }
  return { vulnerabilities: parsed.vulnerabilities };
}

function directDeps(dir: string): DepSections {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(dir, 'package.json'),
  );
  return { dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} };
}

export type LockPackages = Record<string, { version?: string }>;

function readLockPackages(dir: string): LockPackages {
  const lock = readJson<{ packages?: LockPackages }>(join(dir, 'package-lock.json'));
  return lock.packages ?? {};
}

/**
 * Every resolved version of `name` anywhere in the lockfile — top level or
 * hoisted under a parent (`node_modules/parent/node_modules/name`). The
 * transitive advisories this design exists for are usually fixed by bumping
 * the PARENT, so a top-level-only lookup misses the normal case.
 */
export function resolvedVersions(packages: LockPackages, name: string): Set<string> {
  const suffix = `node_modules/${name}`;
  const versions = new Set<string>();
  for (const [path, pkg] of Object.entries(packages)) {
    if (pkg.version && path.endsWith(suffix)) versions.add(pkg.version);
  }
  return versions;
}

function versionSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

const ACTIONABLE: Severity[] = ['high', 'critical'];

function actionableNames(report: AuditReport): string[] {
  return Object.entries(report.vulnerabilities)
    .filter(([, v]) => ACTIONABLE.includes(v.severity))
    .map(([name]) => name);
}

/**
 * Publish time of a package version from the npm registry, or `null` if it
 * cannot be determined — a missing timestamp must never be mistaken for "just
 * published" by the CALLER; `selectPublishedAt` is what turns `null` into a
 * forced hold. Bounded by a 10s timeout, and any network throw becomes `null`
 * rather than escaping, so a registry hiccup can only lengthen the hold.
 */
export async function publishedAt(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Date | null> {
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const meta = (await res.json()) as { time?: Record<string, string> };
    const t = meta.time?.[version];
    if (!t) return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? new Date(ms) : null;
  } catch {
    return null;
  }
}

/**
 * The publish time to gate the 48h hold on.
 *
 * Scoped to packages that are BOTH high/critical in the base audit AND whose
 * resolved lockfile version(s) actually changed between base and head — an
 * untouched base-vulnerable package (e.g. a stale, unrelated `postcss` entry)
 * is not what this PR fixed and must not set the clock. A package inside that
 * scope with no resolvable timestamp is UNKNOWN, which must force the hold —
 * never silently skipped — so an unresolved lookup makes the whole result
 * "just now" rather than falling back to whatever `youngest` happens to hold.
 */
export async function selectPublishedAt(params: {
  base: AuditReport;
  basePackages: LockPackages;
  headPackages: LockPackages;
  lookup?: (name: string, version: string) => Promise<Date | null>;
}): Promise<Date> {
  const { base, basePackages, headPackages, lookup = publishedAt } = params;

  let youngest: Date | null = null;
  let unknown = false;

  for (const name of actionableNames(base)) {
    const baseVersions = resolvedVersions(basePackages, name);
    const headVersions = resolvedVersions(headPackages, name);

    if (baseVersions.size === 0 && headVersions.size === 0) {
      console.error(`selectPublishedAt: ${name} is actionable in the base audit but matches no lockfile entry`);
      unknown = true;
      continue;
    }
    if (versionSetsEqual(baseVersions, headVersions)) {
      // This PR did not move this package — it isn't the fix, so it doesn't
      // get a vote on the fix's age.
      continue;
    }

    const fixingVersions = [...headVersions].filter((v) => !baseVersions.has(v));
    let sawTimestamp = false;
    for (const version of fixingVersions) {
      const when = await lookup(name, version);
      if (when) {
        sawTimestamp = true;
        if (youngest === null || when > youngest) youngest = when;
      }
    }
    if (!sawTimestamp) {
      // Includes the "package removed entirely" shape, where there is no new
      // version to date. Fail closed, but SAY SO: a hold with no signal is
      // permanent, because the hourly re-evaluation recomputes "now" each run
      // and the age is therefore always ~0.
      console.error(
        `selectPublishedAt: ${name} changed but no publish time was resolvable ` +
          `(base=[${[...baseVersions]}] head=[${[...headVersions]}]) — forcing the hold`,
      );
      unknown = true;
    }
  }

  // Unknown publish time must never shorten the hold: treat it as just published.
  return unknown || youngest === null ? new Date() : youngest;
}

/** Strips CR/LF so a dependency name can never inject a second `$GITHUB_OUTPUT` line. */
function sanitizeOutputValue(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

function writeGithubOutput(entries: Record<string, string>): void {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    // Random per-write delimiter, not a fixed token: the heredoc form is
    // still injectable if the value can contain the delimiter itself.
    const delimiter = `ghadelim_${randomUUID()}`;
    lines.push(`${key}<<${delimiter}`, value, delimiter);
  }
  appendFileSync(path, lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const [baseDir, headDir, changedPathsFile] = process.argv.slice(2);
  if (!baseDir || !headDir || !changedPathsFile) {
    throw new Error('usage: qualify-cli.ts <baseDir> <headDir> <changedPathsFile>');
  }

  const changedPaths = readFileSync(changedPathsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

  let verdict: string;
  let reason: string;

  if (changedPaths.length === 0) {
    // manifestScope({ changedPaths: [] }) reads as "touches nothing outside
    // the allowlist" and would pass — but the check's whole job is "this PR
    // touches only these two files", not "touches zero files". Fail closed.
    verdict = 'manual';
    reason = 'no changed paths reported; refusing to qualify an empty diff';
  } else {
    const scope = manifestScope({
      changedPaths,
      base: directDeps(baseDir),
      head: directDeps(headDir),
    });

    if (!scope.ok) {
      verdict = 'manual';
      reason = `manifest scope: ${scope.violations.join('; ')}`;
    } else {
      const base = auditReport(baseDir);
      const head = auditReport(headDir);

      const publishTime = await selectPublishedAt({
        base,
        basePackages: readLockPackages(baseDir),
        headPackages: readLockPackages(headDir),
      });

      const result = qualify({ base, head, publishedAt: publishTime, now: new Date() });
      verdict = result.verdict;
      reason = result.reason;
    }
  }

  reason = sanitizeOutputValue(reason);

  console.log(`verdict=${verdict}`);
  console.log(`reason=${reason}`);
  writeGithubOutput({ verdict, reason });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::qualify-cli failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
