import type { Severity, VerifiedFinding } from './types';

const ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

export function renderBody(p: {
  confirmed: VerifiedFinding[];
  counts: { raised: number; gated: number; verified: number };
}): string {
  const { raised, gated, verified } = p.counts;
  const footer =
    `\n---\n\n<sub>${raised} raised → ${gated} passed the evidence gate → ` +
    `${verified} confirmed on review.</sub>`;

  if (p.confirmed.length === 0) {
    return `**No verified findings.**${footer}`;
  }

  const sorted = [...p.confirmed].sort(
    (a, b) => ORDER[a.finding.severity] - ORDER[b.finding.severity],
  );

  const blocks = sorted.map((v, i) => {
    const f = v.finding;
    const where = `${f.file}:${f.matchedLine}`;
    return [
      `### ${i + 1}. ${f.severity} — ${f.claim}`,
      '',
      `**Where:** \`${where}\``,
      '',
      '```',
      f.quote,
      '```',
      '',
      `**Why it breaks:** ${f.why_it_breaks}`,
      '',
      `**Verified:** ${v.evidence}`,
    ].join('\n');
  });

  return `### Findings\n\n${blocks.join('\n\n')}${footer}`;
}
