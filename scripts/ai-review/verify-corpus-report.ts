/**
 * The verify-corpus scoreboard.
 *
 * Deliberately prints no single overall percentage. The corpus is skewed toward
 * `refuted` (6 known-true against 13 known-false when complete), so a judge that
 * answers `refuted` to everything would score 68% — which reads as work. Counts
 * are therefore split by expected verdict and by provenance, and a model that
 * fails the `confirmed` row is rejected whatever the `refuted` row says.
 */
import { formatTokens, type Usage } from './usage';
import type { EntryOutcome } from './verify-corpus-run';

function tally(outcomes: EntryOutcome[], pick: (o: EntryOutcome) => boolean): string {
  const rows = outcomes.filter(pick);
  const right = rows.filter((o) => o.correct).length;
  return `${right}/${rows.length}`;
}

export function formatReport(p: {
  model: string;
  draws: EntryOutcome[][];
  usage: Usage;
  costUsd: number | null;
}): string {
  const lines: string[] = [`=== verify corpus · ${p.model} · ${p.draws.length} draw(s) ===`, ''];

  p.draws.forEach((draw, i) => {
    const errors = draw.filter((o) => o.actual === 'error').length;
    lines.push(
      `draw ${i + 1}: confirmed ${tally(draw, (o) => o.expected === 'confirmed')} · ` +
        `refuted ${tally(draw, (o) => o.expected === 'refuted')} · ` +
        `harvested ${tally(draw, (o) => o.provenance === 'harvested')} · ` +
        `constructed ${tally(draw, (o) => o.provenance === 'constructed')} · ` +
        `error ${errors}`,
    );
  });

  // Union: an entry counts as answered correctly if ANY draw got it right. Reported
  // beside the per-draw rows and never instead of them — conflating the two is the
  // 2026-09-22 mistake (a union of three runs compared against a single draw).
  const ids = [...new Set(p.draws.flat().map((o) => o.id))];
  const unionRows: EntryOutcome[] = ids.map((id) => {
    const all = p.draws.flat().filter((o) => o.id === id);
    return all.find((o) => o.correct) ?? all[0];
  });
  lines.push(
    '',
    `union: confirmed ${tally(unionRows, (o) => o.expected === 'confirmed')} · ` +
      `refuted ${tally(unionRows, (o) => o.expected === 'refuted')}`,
  );

  lines.push('', '--- wrong or errored, by entry ---');
  for (const o of unionRows.filter((o) => !o.correct)) {
    lines.push(`  ${o.id}: expected ${o.expected}, got ${o.actual} — ${o.evidence.slice(0, 160)}`);
  }

  const cost = p.costUsd === null ? '(unpriced model)' : `$${p.costUsd.toFixed(4)}`;
  lines.push(
    '',
    `cost: ${p.usage.calls} call(s) ${formatTokens(p.usage.promptTokens)}→${formatTokens(p.usage.completionTokens)} · ${cost}`,
  );
  return lines.join('\n');
}
