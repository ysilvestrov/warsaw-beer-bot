import type { OwnerlessRow } from '../storage/enrich_failures';

export const MAX_INBOX_GROUPS = 10;
export const MAX_INBOX_ROWS_PER_GROUP = 15;

export interface InboxGroup { key: string; reason: string; rows: OwnerlessRow[]; }

// #509: the note is now `off-scope <target>: <reason> | <the model's original
// review_note>` — the scope refusal is prepended to what the model said, not a
// replacement for it. The reason group is non-greedy and stops at the first
// ` | `, so the model's free-text tail (which itself may contain further text,
// even further ` | `-joined fragments from retireEnrichFailure) never leaks into
// the group's displayed reason. A note with no separator — the routing refused
// before any model note existed, or nothing follows the colon but `no scope
// block` — still matches whole: the optional tail is optional.
const OFF_SCOPE = /^off-scope (\S+): (.*?)(?: \| .*)?$/;
const ABSENCE_KEY = 'absence not probed';

// #509: the refused target IS the mechanism label. The model already said "these are
// ciders, they belong to #485"; the scope refused the routing, but the meaning survived,
// so grouping on it costs nothing and produces clusters a human can act on directly.
export function groupOwnerless(rows: OwnerlessRow[]): InboxGroup[] {
  const by = new Map<string, InboxGroup>();
  for (const r of rows) {
    const m = OFF_SCOPE.exec(r.review_note ?? '');
    const key = m ? m[1] : ABSENCE_KEY;
    const reason = m ? m[2] : 'absence was never probed';
    const g = by.get(key) ?? { key, reason, rows: [] };
    g.rows.push(r);
    by.set(key, g);
  }
  // Sorted by size: the biggest cluster is the most likely to be one real mechanism, and
  // the cap below has to drop something, so it should drop the smallest.
  return [...by.values()].sort((a, b) => b.rows.length - a.rows.length).slice(0, MAX_INBOX_GROUPS);
}

export function buildInboxBody(
  groups: InboxGroup[], totalOwnerless: number, dateKey: string,
): string {
  const groupable = groups.reduce((n, g) => n + g.rows.length, 0);
  const head = [
    `Оновлено автоматично: ${dateKey}. Не редагуй тіло — воно перезаписується щодня.`,
    '',
    `Рядків з класом і без issue: **${totalOwnerless}** (з них ${groupable} з машинною причиною; `
    + `решта — вільні нотатки моделі, вони належать #508).`,
    '',
  ];
  const body = groups.flatMap((g) => {
    // Exactly two leading spaces before the beer id: the inbox is read by a human in a
    // browser, and the indent is what keeps a 15-row group scannable.
    const listed = g.rows.slice(0, MAX_INBOX_ROWS_PER_GROUP)
      .map((r) => `  ${r.beer_id} ${r.brewery} / ${r.name}`);
    const rest = g.rows.length - listed.length;
    return [
      `## ${g.key} — ${g.rows.length} рядків`,
      `причина відмови: ${g.reason}`,
      ...listed,
      ...(rest > 0 ? [`  ще ${rest}`] : []),
      '',
    ];
  });
  return [
    ...head, ...body,
    'Закрий це issue, коли розгребеш — наступний ран заведе свіже з того, що лишилось.',
  ].join('\n');
}
