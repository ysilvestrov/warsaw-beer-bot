/** Total context budget in characters. Roughly 60k tokens. */
export const CONTEXT_BUDGET = 240_000;

/**
 * Share of the budget the diff itself may occupy. The diff is the primary
 * signal, but it must not crowd out the file bodies entirely — and a diff
 * larger than the whole budget has to degrade rather than blow the request up.
 */
export const DIFF_BUDGET_SHARE = 0.75;

/**
 * Cut `diff` to `limit` characters on a line boundary.
 *
 * The caller must announce the cut: a model reasoning about a diff it cannot
 * see is worse than one told plainly that part of it is missing.
 */
function truncateDiff(diff: string, limit: number): { text: string; truncated: boolean } {
  if (diff.length <= limit) return { text: diff, truncated: false };

  const kept: string[] = [];
  let used = 0;
  for (const line of diff.split('\n')) {
    const next = used + line.length + (kept.length > 0 ? 1 : 0);
    if (next > limit) break;
    kept.push(line);
    used = next;
  }
  // A single line longer than the whole allowance still has to be cut.
  return { text: kept.length > 0 ? kept.join('\n') : diff.slice(0, limit), truncated: true };
}

/** Added + removed lines per post-image file path. */
export function fileChurn(diff: string): Map<string, number> {
  const churn = new Map<string, number>();
  let file: string | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && !churn.has(file)) churn.set(file, 0);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') || line.startsWith('-')) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
    }
  }
  return churn;
}

export function buildReviewContext(params: {
  diff: string;
  reviewable: string[];
  readFile: (path: string) => string | null;
  budget?: number;
}): { text: string; diffOnly: string[] } {
  const { diff, reviewable, readFile } = params;
  const budget = params.budget ?? CONTEXT_BUDGET;
  const churn = fileChurn(diff);

  const ordered = [...reviewable].sort(
    (a, b) => (churn.get(b) ?? 0) - (churn.get(a) ?? 0) || a.localeCompare(b),
  );

  const { text: diffText, truncated } = truncateDiff(
    diff,
    Math.max(0, Math.floor(budget * DIFF_BUDGET_SHARE)),
  );

  const sections: string[] = ['# Diff', '```diff', diffText, '```'];
  let used = diffText.length;

  if (truncated) {
    const notice = [
      '',
      `**The diff above is TRUNCATED**: only the first ${diffText.length} of ${diff.length}`,
      'characters fit in this review. Later hunks — possibly whole files — are not',
      'shown. Do not make any claim about a change you were not shown.',
    ];
    sections.push(...notice);
    used += notice.join('\n').length;
  }

  const bodies: string[] = [];
  const diffOnly: string[] = [];

  for (const path of ordered) {
    const content = readFile(path);
    if (content === null) {
      diffOnly.push(path);
      continue;
    }
    const block = `## ${path}\n\`\`\`\n${content}\n\`\`\``;
    if (used + block.length > budget) {
      diffOnly.push(path);
      continue;
    }
    used += block.length;
    bodies.push(block);
  }

  if (bodies.length > 0) {
    sections.push('', '# Full contents of changed files (at HEAD)', ...bodies);
  }

  if (diffOnly.length > 0) {
    sections.push(
      '',
      '# Files where you see only the diff',
      ...diffOnly.map((p) => `- ${p}`),
      '',
      'For the files above you see only the diff. Do not make any claim about the',
      'parts of those files you were not shown — if a claim would require reading',
      'code that is not in this message, do not report it.',
    );
  }

  return { text: sections.join('\n'), diffOnly };
}
