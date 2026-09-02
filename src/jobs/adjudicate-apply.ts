import type { DB } from '../storage/db';
import { markUnrescued } from '../storage/enrich_failures';
import type { Verdict, VerdictFile } from './adjudicate-issue-rows';

const VERDICTS = ['unrescued', 'rescued', 'inconclusive', 'already_marked'] as const;

// #576: файл приходить з диска, тобто з-поза межі типів. Розбираємо суворо: краще
// відмовитись цілком, ніж застосувати половину чогось незрозумілого.
export function parseVerdictFile(raw: unknown): VerdictFile {
  const f = raw as VerdictFile;
  if (!f || typeof f !== 'object') throw new Error('verdict file: not an object');
  if (!Number.isInteger(f.issue)) throw new Error('verdict file: `issue` must be an integer');
  if (typeof f.probed_at !== 'string') throw new Error('verdict file: `probed_at` must be a string');
  if (!Array.isArray(f.verdicts)) throw new Error('verdict file: `verdicts` must be an array');
  for (const v of f.verdicts) {
    if (!Number.isInteger(v?.beer_id)) throw new Error('verdict file: verdict without an integer `beer_id`');
    if (typeof v.brewery !== 'string' || typeof v.name !== 'string') {
      throw new Error(`verdict file: verdict ${v.beer_id} is missing the probed brewery/name`);
    }
    if (!VERDICTS.includes(v.verdict)) {
      throw new Error(`verdict file: verdict ${v.beer_id} has unknown verdict '${v.verdict}'`);
    }
  }
  return f;
}

export type SkipReason = 'not_orphan' | 'issue_moved' | 'retired' | 'input_changed' | 'missing';

export interface ApplyReport {
  marked: number;
  alreadyMarked: number;
  skipped: { beer_id: number; reason: SkipReason }[];
}

// #576: між пробою і застосуванням рядок міг зматчитись, перетріажитись, бути ретайреним,
// або йому могли переписати brewery/name. Записати вердикт наосліп означало б поставити
// `unrescued_issue`, який не дорівнює `issue_number` — рівно та поломка, яку виправляли як
// Critical у #575. Тому кожен вердикт звіряється з поточним рядком, а що зрушило —
// називається у звіті, а не ковтається.
export function applyVerdicts(db: DB, file: VerdictFile, atIso: string): ApplyReport {
  const report: ApplyReport = { marked: 0, alreadyMarked: 0, skipped: [] };
  const read = db.prepare(
    `SELECT b.brewery, b.name, b.untappd_id, ef.issue_number, ef.retired_at, ef.unrescued_at
       FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE ef.beer_id = ?`,
  );

  const run = db.transaction((verdicts: Verdict[]) => {
    for (const v of verdicts) {
      if (v.verdict !== 'unrescued') continue;
      const row = read.get(v.beer_id) as {
        brewery: string; name: string; untappd_id: number | null;
        issue_number: number | null; retired_at: string | null; unrescued_at: string | null;
      } | undefined;
      const skip = (reason: SkipReason) => report.skipped.push({ beer_id: v.beer_id, reason });
      if (!row) { skip('missing'); continue; }
      if (row.untappd_id !== null) { skip('not_orphan'); continue; }
      if (row.retired_at !== null) { skip('retired'); continue; }
      if (row.issue_number !== file.issue) { skip('issue_moved'); continue; }
      if (row.brewery !== v.brewery || row.name !== v.name) { skip('input_changed'); continue; }
      if (markUnrescued(db, v.beer_id, file.issue, atIso)) report.marked += 1;
      else report.alreadyMarked += 1;
    }
  });
  run(file.verdicts);
  return report;
}
