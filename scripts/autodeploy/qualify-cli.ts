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
import { qualify, needsHoldCheck, type AuditReport } from './qualify';
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

/**
 * Every package NAME appearing anywhere in a lockfile's `packages` map — the
 * segment after the LAST `node_modules/` in each key, so a scoped name
 * (`@scope/pkg`) and a hoisted-vs-nested path both resolve to the same name
 * `resolvedVersions` already keys on. The lockfile's root entry (`""`) has no
 * `node_modules/` and is not a package.
 */
function packageNamesIn(packages: LockPackages): Set<string> {
  const marker = 'node_modules/';
  const names = new Set<string>();
  for (const path of Object.keys(packages)) {
    const idx = path.lastIndexOf(marker);
    if (idx === -1) continue;
    names.add(path.slice(idx + marker.length));
  }
  return names;
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
 * The hold rests on what this pull request INTRODUCES, not on the package
 * that was vulnerable (#435 §4 amendment, measured 2026-08-18). Scoping to
 * the base audit's actionable names was wrong for the shape transitive
 * fixes normally take: bumping the PARENT makes the vulnerable CHILD vanish
 * from the head lockfile entirely, so there was no version of it to date —
 * "unknown" forced the hold, the hourly re-evaluation recomputed "now"
 * every run, and the pull request parked in `autodeploy-pending`
 * permanently.
 *
 * So this scans every package name appearing in EITHER lockfile (not just
 * the base audit's), and for each whose resolved version set changed,
 * dates the versions in `head \ base` — the versions actually introduced.
 * A package that only disappears (head set empty) contributes nothing: it
 * did not bring anything new to distrust. A package that introduces a
 * version with no resolvable timestamp is UNKNOWN, which must still force
 * the hold — never silently skipped — so an unresolved lookup makes the
 * whole result "just now" rather than falling back to whatever `youngest`
 * happens to hold. If nothing new was introduced anywhere, there is nothing
 * to have aged, so the hold stands too.
 */
export async function selectPublishedAt(params: {
  basePackages: LockPackages;
  headPackages: LockPackages;
  lookup?: (name: string, version: string) => Promise<Date | null>;
}): Promise<Date> {
  const { basePackages, headPackages, lookup = publishedAt } = params;

  const names = new Set<string>([...packageNamesIn(basePackages), ...packageNamesIn(headPackages)]);

  let youngest: Date | null = null;
  let unknown = false;

  for (const name of names) {
    const baseVersions = resolvedVersions(basePackages, name);
    const headVersions = resolvedVersions(headPackages, name);

    if (versionSetsEqual(baseVersions, headVersions)) {
      // This PR did not move this package — it isn't the fix, so it doesn't
      // get a vote on the fix's age.
      continue;
    }

    const introducedVersions = [...headVersions].filter((v) => !baseVersions.has(v));
    if (introducedVersions.length === 0) {
      // The resolved version set changed but nothing NEW arrived — the
      // normal shape being "package removed entirely" (headVersions empty)
      // when a transitive advisory is fixed by bumping its parent. Nothing
      // new arrived to distrust, so this must NOT force the hold — forcing
      // it here is exactly the permanent-stall bug this rescoping fixes.
      continue;
    }

    for (const version of introducedVersions) {
      const when = await lookup(name, version);
      if (when) {
        if (youngest === null || when > youngest) youngest = when;
      } else {
        // A version this PR actually introduces, with no resolvable publish
        // time. Fail closed, but SAY SO.
        console.error(
          `selectPublishedAt: ${name}@${version} was introduced by this PR but no publish time was resolvable — forcing the hold`,
        );
        unknown = true;
      }
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

      // needsHoldCheck(base, head) is the SAME determination qualify() makes
      // internally (its shared `assessFix` helper) — computed once here so a PR whose
      // verdict can never depend on the fix's age (base clean, or head still
      // vulnerable, or a cleared critical) pays no npm registry lookups at
      // all. Before this gate, a 13-package non-security bump fired 13
      // registry requests every hourly re-evaluation, forever, for a
      // decision none of them could change.
      const publishTime = needsHoldCheck(base, head)
        ? await selectPublishedAt({
            basePackages: readLockPackages(baseDir),
            headPackages: readLockPackages(headDir),
          })
        : null;

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
