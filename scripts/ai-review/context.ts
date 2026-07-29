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

function truncationNotice(shown: number, total: number): string[] {
  return [
    '',
    `**The diff above is TRUNCATED**: only the first ${shown} of ${total}`,
    'characters fit in this review. Later hunks — possibly whole files — are not',
    'shown. Do not make any claim about a change you were not shown.',
  ];
}

/**
 * The diff section — heading, fences, diff text and truncation notice — sized
 * so the whole section, not just the diff text inside it, fits `allowance`.
 *
 * The scaffolding is small but not free, and charging only the diff text let
 * the assembled message overrun the caller's budget.
 */
function renderDiffSection(diff: string, allowance: number): string[] {
  const scaffolding = ['# Diff', '```diff', '', '```'].join('\n').length;
  let limit = Math.max(0, allowance - scaffolding);
  let { text, truncated } = truncateDiff(diff, limit);

  if (truncated) {
    // The notice quotes the kept length, so a second pass could in principle
    // shrink it — never grow it, since fewer characters means no more digits.
    // Reserving the first pass's size is therefore safe.
    const reserved = truncationNotice(text.length, diff.length).join('\n').length + 1;
    limit = Math.max(0, limit - reserved);
    ({ text, truncated } = truncateDiff(diff, limit));
  }

  const parts = ['# Diff', '```diff', text, '```'];
  if (truncated) parts.push(...truncationNotice(text.length, diff.length));
  return parts;
}

function assemble(diffSection: string[], bodies: string[], diffOnly: string[]): string {
  const sections = [...diffSection];

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

  return sections.join('\n');
}

/**
 * The review message: the diff, as many full file bodies as fit, and an
 * explicit list of the files the model is seeing only as a diff.
 *
 * `budget` bounds the assembled message, not just the parts that vary — the
 * only floor is the two notices, which are never dropped to make room: a model
 * that is not told what it is missing invents claims about it.
 */
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

  const blocks = new Map<string, string>();
  for (const path of ordered) {
    const content = readFile(path);
    if (content !== null) blocks.set(path, `## ${path}\n\`\`\`\n${content}\n\`\`\``);
  }

  let allowance = Math.max(0, Math.floor(budget * DIFF_BUDGET_SHARE));

  // `budget` is the size of the message we send, so everything in it is
  // charged: headings, fences, both notices and the separators between them.
  // Fitting is not a single pass — moving a file to the diff-only list adds a
  // line there — so select greedily, then shrink until the assembled text
  // really fits, giving the diff back its space last.
  for (let attempt = 0; ; attempt++) {
    const diffSection = renderDiffSection(diff, allowance);
    const included: string[] = [];
    const rest = (): string[] => ordered.filter((p) => !included.includes(p));

    for (const path of ordered) {
      if (!blocks.has(path)) continue;
      included.push(path);
      const bodies = included.map((p) => blocks.get(p)!);
      if (assemble(diffSection, bodies, rest()).length > budget) included.pop();
    }

    let text = assemble(diffSection, included.map((p) => blocks.get(p)!), rest());
    while (text.length > budget && included.length > 0) {
      included.pop();
      text = assemble(diffSection, included.map((p) => blocks.get(p)!), rest());
    }

    // Out of file bodies to give back: the diff itself has to yield. Bounded
    // because each pass strictly shrinks the allowance, and an empty diff plus
    // the notices is the floor we cannot go below.
    if (text.length <= budget || allowance === 0 || attempt >= 3) {
      return { text, diffOnly: rest() };
    }
    allowance = Math.max(0, allowance - (text.length - budget));
  }
}
