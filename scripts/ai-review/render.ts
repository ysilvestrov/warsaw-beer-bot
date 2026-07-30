import {
  capOpenFindings,
  orderBySeverity,
  renderState,
  type Spend,
  type StoredFinding,
} from './state';
import type { ClosedFinding } from './incremental';

/**
 * GitHub rejects a review body over 65 536 characters. We stop well short: the
 * marker and heading `wrapBody` adds are charged on top, and a review that
 * fails to post is worth less than one that admits it left something out.
 */
export const MAX_BODY_CHARS = 60_000;

export interface OpenFinding {
  finding: StoredFinding;
  /** Why it is shown this way: carried, re-raised after a failed fix, unverified. */
  note?: string;
}

export interface RenderParams {
  open: OpenFinding[];
  closed: ClosedFinding[];
  counts: {
    raised: number;
    gated: number;
    verified: number;
    carried: number;
    closed: number;
  };
  costLine: string | null;
  /** The commit this review was computed against; goes into the state block. */
  head: string;
  spend: Spend;
}

function openBlock(item: OpenFinding, n: number): string {
  const f = item.finding;
  const lines = [
    `### ${n}. ${f.severity} — ${f.claim}`,
    '',
    `**Where:** \`${f.file}:${f.matchedLine}\``,
    '',
    '```',
    f.quote,
    '```',
    '',
    `**Why it breaks:** ${f.why_it_breaks}`,
    '',
    `**Verified:** ${f.evidence}`,
  ];
  if (item.note) lines.push('', `<sub>${item.note}</sub>`);
  return lines.join('\n');
}

function closedLine(c: ClosedFinding): string {
  const why = c.reason === 'fixed' ? 'fixed by this push' : 'the code it referred to is gone';
  return `- ~~${c.finding.claim}~~ (\`${c.finding.file}\`) — ${why}`;
}

function assemble(p: {
  open: OpenFinding[];
  closed: ClosedFinding[];
  counts: RenderParams['counts'];
  costLine: string | null;
  omitted: number;
  head: string;
  spend: Spend;
}): string {
  const sections: string[] = [];

  if (p.open.length === 0) {
    sections.push('**No verified findings.**');
  } else {
    sections.push('### Open findings', '');
    sections.push(p.open.map((item, i) => openBlock(item, i + 1)).join('\n\n'));
  }

  if (p.closed.length > 0) {
    sections.push('', '### Closed by this push', '', p.closed.map(closedLine).join('\n'));
  }

  if (p.omitted > 0) {
    sections.push(
      '',
      `<sub>${p.omitted} further finding(s) omitted to fit this review's size limit.</sub>`,
    );
  }

  const { raised, gated, verified, carried, closed } = p.counts;
  sections.push(
    '',
    '---',
    '',
    `<sub>${raised} raised → ${gated} gated → ${verified} confirmed · ` +
      `${carried} carried · ${closed} closed.</sub>`,
  );
  if (p.costLine) sections.push('', `<sub>${p.costLine}</sub>`);

  // The state block is written by the same call that writes the text it
  // describes, so the two cannot drift apart — that is the whole reason the
  // state lives in the review body rather than anywhere else.
  sections.push(
    '',
    renderState({
      v: 1,
      head: p.head,
      findings: p.open.map((item) => item.finding),
      spend: p.spend,
    }),
  );

  return sections.join('\n');
}

/**
 * The full review body: what is still open, what this push closed, the
 * counters, the bill, and the hidden state the next run reads.
 *
 * Cumulative on purpose. An incremental run only re-derives findings about the
 * code this push touched, so rendering just those would silently erase every
 * still-open finding from the previous review.
 */
export function renderBody(p: RenderParams): string {
  const { kept, dropped } = capOpenFindings(p.open, (item) => item.finding);
  let open = kept;
  let closed = orderBySeverity(p.closed, (c) => c.finding);
  let omitted = dropped;

  let body = assemble({ ...p, open, closed, omitted });

  // Shrink until it fits: closed entries first — they are a courtesy, while an
  // open finding is the product — then the least severe open findings.
  while (body.length > MAX_BODY_CHARS && closed.length > 0) {
    closed = closed.slice(0, -1);
    omitted += 1;
    body = assemble({ ...p, open, closed, omitted });
  }
  while (body.length > MAX_BODY_CHARS && open.length > 1) {
    open = open.slice(0, -1);
    omitted += 1;
    body = assemble({ ...p, open, closed, omitted });
  }

  return body;
}
