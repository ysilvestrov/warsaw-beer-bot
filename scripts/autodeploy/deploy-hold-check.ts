/**
 * Merge-deploy — the PR-side hold check (spec 2026-09-30, "Holds").
 *
 * The deployer on the host decides holds by itself (path_is_held in
 * deploy/autodeploy.sh, plus the deploy:hold label) and does not rely on this.
 * This check exists so that whoever presses merge SEES that the deploy will
 * not be unattended: the title carries [deploy:hold] exactly when the label
 * does, and every PR touching a hold path carries both.
 */
import { readFileSync } from 'node:fs';

export const HOLD_LABEL = 'deploy:hold';
export const HOLD_MARKER = '[deploy:hold]';

const HELD_EXACT = new Set([
  'deploy/rsync-filter',
  'deploy/autodeploy.sh',
  'deploy/ships.sh',
  'deploy/read-env.sh',
  'deploy/installed-current.sh',
  'deploy/db-snapshot.sh',
  'deploy/trial-migrate.cjs',
]);

/** Mirrors path_is_held() in deploy/autodeploy.sh; a parity test pins the two. */
export function isHoldPath(path: string): boolean {
  if (path === 'deploy/warsaw-beer-bot.service') return false;
  if (path.startsWith('deploy/sudoers.d/')) return true;
  if (/^deploy\/.*\.(service|timer)$/.test(path)) return true;
  if (path.startsWith('deploy/litestream.')) return true;
  if (/^deploy\/install-.*\.sh$/.test(path)) return true;
  return HELD_EXACT.has(path);
}

export function checkHold(i: { title: string; labels: string[]; paths: string[] }): {
  ok: boolean; held: string[]; problems: string[];
} {
  const marked = i.title.startsWith(HOLD_MARKER);
  const labelled = i.labels.includes(HOLD_LABEL);
  const held = i.paths.filter(isHoldPath);
  const problems: string[] = [];
  if (marked && !labelled) problems.push(`the title carries ${HOLD_MARKER} but the ${HOLD_LABEL} label is missing`);
  if (!marked && labelled) problems.push(`the title has no ${HOLD_MARKER} marker but the label is set`);
  if (held.length > 0 && !marked) {
    problems.push(`hold paths changed without a ${HOLD_MARKER} title: ${held.join(', ')} — prefix the title with ${HOLD_MARKER}, add the ${HOLD_LABEL} label, and list the host steps in the PR body`);
  }
  return { ok: problems.length === 0, held, problems };
}

function main(): number {
  let labels: unknown;
  try {
    labels = JSON.parse(process.env.PR_LABELS ?? '[]');
  } catch {
    console.error('PR_LABELS must be a JSON array of label names');
    return 2;
  }
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string')) {
    console.error('PR_LABELS must be a JSON array of label names');
    return 2;
  }
  const paths = readFileSync(0, 'utf8').split('\n').filter((p) => p !== '');
  const r = checkHold({ title: process.env.PR_TITLE ?? '', labels, paths });
  for (const p of r.problems) console.log(`✗ ${p}`);
  if (r.ok) console.log(r.held.length > 0 ? `OK: held for ${r.held.join(', ')}` : 'OK');
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
