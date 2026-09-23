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
  /** The active `--only` filter, if any. Echoed in the header so a filtered
   *  report cannot be mistaken for — or pasted into a document as — a full run. */
  only?: string;
}): string {
  const header = p.only
    ? `=== verify corpus · ${p.model} · ${p.draws.length} draw(s) · FILTERED by --only ${p.only} ===`
    : `=== verify corpus · ${p.model} · ${p.draws.length} draw(s) ===`;
  const lines: string[] = [header, ''];

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
  //
  // The union alone flatters a coin-flipper: verdicts are binary, so over N draws
  // a judge answering at random is right at least once with p ≈ 1 - 0.5^N (≈0.875
  // at N=3) per entry — its union row is then byte-identical to a perfect judge's.
  // Consensus (correct in EVERY draw) is the number a coin-flipper cannot fake,
  // so it is reported beside the union, never in its place, with the same splits.
  const draws = p.draws.length;
  const ids = [...new Set(p.draws.flat().map((o) => o.id))];
  const byId = new Map<string, EntryOutcome[]>();
  for (const o of p.draws.flat()) {
    const list = byId.get(o.id);
    if (list) list.push(o);
    else byId.set(o.id, [o]);
  }

  const unionRows: EntryOutcome[] = ids.map((id) => {
    const all = byId.get(id)!;
    return { ...all[0], correct: all.some((o) => o.correct) };
  });
  const consensusRows: EntryOutcome[] = ids.map((id) => {
    const all = byId.get(id)!;
    return { ...all[0], correct: all.every((o) => o.correct) };
  });

  const splitLine = (label: string, rows: EntryOutcome[]) =>
    `${label}: confirmed ${tally(rows, (o) => o.expected === 'confirmed')} · ` +
    `refuted ${tally(rows, (o) => o.expected === 'refuted')} · ` +
    `harvested ${tally(rows, (o) => o.provenance === 'harvested')} · ` +
    `constructed ${tally(rows, (o) => o.provenance === 'constructed')}`;

  lines.push(
    '',
    splitLine(`union (correct in any of ${draws} draws)`, unionRows),
    splitLine(`consensus (correct in all ${draws} draws)`, consensusRows),
  );

  // Drill-down keys off WRONG IN ANY DRAW, not wrong in the union: the union goes
  // blank the moment even one draw is right, which is exactly when a flip-flop
  // (the thing a reader most needs to see) is happening.
  lines.push('', '--- wrong or errored in any draw, by entry ---');
  for (const id of ids) {
    const all = byId.get(id)!;
    if (all.every((o) => o.correct)) continue;
    const perDraw = all.map((o, i) => `draw ${i + 1} ${o.actual}`).join(', ');
    lines.push(`  ${id}: expected ${all[0].expected} — ${perDraw}`);
  }

  const cost = p.costUsd === null ? '(unpriced model)' : `$${p.costUsd.toFixed(4)}`;
  lines.push(
    '',
    `cost: ${p.usage.calls} call(s) ${formatTokens(p.usage.promptTokens)}→${formatTokens(p.usage.completionTokens)} · ${cost}`,
  );
  return lines.join('\n');
}
