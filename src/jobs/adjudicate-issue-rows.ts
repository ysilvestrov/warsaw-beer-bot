import type pino from 'pino';
import type { DB } from '../storage/db';
import type { LookupOutcome } from '../domain/untappd-lookup';
import { markUnrescued } from '../storage/enrich_failures';

// #558: адюдикація рядків одного фіксу. Політика вже вимагає реплею перед фіксом —
// різниця лише в тому, що досі його результат жив у чаті й помирав із сесією.
//
// Свідомо НЕ застосовує наслідків: не пише лінк на `matched`, не рухає бекоф на
// `not_found`. Інструмент виносить вердикт про долю рядка, а не робить роботу крона —
// інакше одна помилка в ньому псувала б каталог. Тому й `lookup` — це шов: у проді
// сюди передають `(beer) => lookupBeer({ ...beer, search })`.
export interface AdjudicateDeps {
  db: DB;
  log: pino.Logger;
  lookup: (beer: { brewery: string; name: string; abv: number | null }) => Promise<LookupOutcome>;
  now?: () => Date;
}

export interface AdjudicateResult {
  probed: number;
  rescued: number;       // проба знайшла пиво — рядок лишається як є, крон його злінкує
  marked: number;        // проба не знайшла нічого — маркер поставлено
  inconclusive: number;  // transient/blocked — не вердикт, нічого не пишемо (#316)
}

export async function adjudicateIssueRows(
  deps: AdjudicateDeps,
  issueNumber: number,
): Promise<AdjudicateResult> {
  const now = (deps.now ?? (() => new Date()))();
  const rows = deps.db
    .prepare(
      `SELECT b.id, b.brewery, b.name, b.abv
         FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.issue_number = ?
          AND ef.retired_at IS NULL
          AND b.untappd_id IS NULL`,
    )
    .all(issueNumber) as { id: number; brewery: string; name: string; abv: number | null }[];

  const out: AdjudicateResult = { probed: 0, rescued: 0, marked: 0, inconclusive: 0 };
  for (const row of rows) {
    out.probed += 1;
    const outcome = await deps.lookup({ brewery: row.brewery, name: row.name, abv: row.abv });
    if (outcome.kind === 'matched') {
      out.rescued += 1;
      continue;
    }
    if (outcome.kind !== 'not_found') {
      // Мережевий збій — не свідчення про рядок. Позначити його тут означало б записати
      // «фікс тебе не рятує» на підставі того, що впав проксі.
      out.inconclusive += 1;
      deps.log.warn({ beerId: row.id, kind: outcome.kind }, 'adjudicate: inconclusive probe');
      continue;
    }
    if (markUnrescued(deps.db, row.id, issueNumber, now.toISOString())) out.marked += 1;
  }
  deps.log.info({ issueNumber, ...out }, 'adjudicate-issue-rows finished');
  return out;
}
