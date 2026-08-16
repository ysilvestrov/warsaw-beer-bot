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
import { qualify, type AuditReport } from './qualify';
import { manifestScope } from './manifest-scope';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function auditReport(dir: string): AuditReport {
  // `npm audit --json` exits non-zero when it finds anything, so the workflow
  // captures stdout regardless; an empty file means "clean".
  const raw = readFileSync(join(dir, 'audit.json'), 'utf8').trim();
  if (raw === '') return { vulnerabilities: {} };
  const parsed = JSON.parse(raw) as { vulnerabilities?: AuditReport['vulnerabilities'] };
  return { vulnerabilities: parsed.vulnerabilities ?? {} };
}

function directDeps(dir: string): Record<string, string> {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(dir, 'package.json'),
  );
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

/** Resolved version of a package in a v3 lockfile, or null if it is absent. */
function resolvedVersion(dir: string, name: string): string | null {
  const lock = readJson<{ packages?: Record<string, { version?: string }> }>(join(dir, 'package-lock.json'));
  return lock.packages?.[`node_modules/${name}`]?.version ?? null;
}

async function publishedAt(name: string, version: string): Promise<Date | null> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  const meta = (await res.json()) as { time?: Record<string, string> };
  const t = meta.time?.[version];
  return t ? new Date(t) : null;
}

async function main(): Promise<void> {
  const [baseDir, headDir, changedPathsFile] = process.argv.slice(2);
  if (!baseDir || !headDir || !changedPathsFile) {
    throw new Error('usage: qualify-cli.ts <baseDir> <headDir> <changedPathsFile>');
  }

  const changedPaths = readFileSync(changedPathsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const scope = manifestScope({
    changedPaths,
    base: directDeps(baseDir),
    head: directDeps(headDir),
  });

  let verdict: string;
  let reason: string;

  if (!scope.ok) {
    verdict = 'manual';
    reason = `manifest scope: ${scope.violations.join('; ')}`;
  } else {
    const base = auditReport(baseDir);
    const head = auditReport(headDir);

    // The hold is only as strong as its YOUNGEST component, so take the max
    // publish time across every package the base reported as vulnerable.
    let youngest: Date | null = null;
    for (const name of Object.keys(base.vulnerabilities)) {
      const version = resolvedVersion(headDir, name);
      if (!version) continue;
      const when = await publishedAt(name, version);
      if (when && (youngest === null || when > youngest)) youngest = when;
    }

    const result = qualify({
      base,
      head,
      // Unknown publish time must never shorten the hold: treat it as just published.
      publishedAt: youngest ?? new Date(),
      now: new Date(),
    });
    verdict = result.verdict;
    reason = result.reason;
  }

  console.log(`verdict=${verdict}`);
  console.log(`reason=${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\nreason=${reason}\n`);
  }
}

main().catch((err) => {
  console.error(`::error::qualify-cli failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
