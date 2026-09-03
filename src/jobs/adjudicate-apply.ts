import type { DB } from '../storage/db';
import { markUnrescued } from '../storage/enrich_failures';
import type { Verdict, VerdictFile } from './adjudicate-issue-rows';
import { tallyVerdicts, formatVerdictTally } from './adjudicate-issue-rows';

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
    // Без цих двох полів застосування не може побачити ре-арм, тож файл без них — не
    // недостатній, а небезпечний: він виглядає застосовним і мовчки скасовує ре-арм.
    if (!Number.isInteger(v.lookup_count)) {
      throw new Error(`verdict file: verdict ${v.beer_id} is missing the probed lookup_count`);
    }
    if (v.lookup_at !== null && typeof v.lookup_at !== 'string') {
      throw new Error(`verdict file: verdict ${v.beer_id} has a non-string lookup_at`);
    }
  }
  return f;
}

export type SkipReason =
  | 'not_orphan' | 'issue_moved' | 'retired' | 'input_changed' | 'missing' | 'lookup_moved';

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
    `SELECT b.brewery, b.name, b.untappd_id, b.untappd_lookup_at, b.untappd_lookup_count,
            ef.issue_number, ef.retired_at
       FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
      WHERE ef.beer_id = ?`,
  );

  const run = db.transaction((verdicts: Verdict[]) => {
    for (const v of verdicts) {
      if (v.verdict !== 'unrescued') continue;
      const row = read.get(v.beer_id) as {
        brewery: string; name: string; untappd_id: number | null;
        untappd_lookup_at: string | null; untappd_lookup_count: number;
        issue_number: number | null; retired_at: string | null;
      } | undefined;
      const skip = (reason: SkipReason) => report.skipped.push({ beer_id: v.beer_id, reason });
      if (!row) { skip('missing'); continue; }
      if (row.untappd_id !== null) { skip('not_orphan'); continue; }
      if (row.retired_at !== null) { skip('retired'); continue; }
      if (row.issue_number !== file.issue) { skip('issue_moved'); continue; }
      if (row.brewery !== v.brewery || row.name !== v.name) { skip('input_changed'); continue; }
      // #576: рядок здобув нове свідчення відтоді, як ми його пробували — його або явно
      // ре-армили (обидва поля обнулено), або крон устиг зробити свій лукап (лічильник
      // зріс). Обидва випадки означають одне: наша проба більше не найсвіжіше, що про
      // цей рядок відомо, і писати за нею термінальний маркер не можна. Пропускаємо —
      // оператор перепробує. Вікно свіжості файлу цього не ловить: воно судить прогін
      // цілком, а зрушити може окремий рядок усередині свіжого файлу.
      if (row.untappd_lookup_count !== v.lookup_count || row.untappd_lookup_at !== v.lookup_at) {
        skip('lookup_moved'); continue;
      }
      if (markUnrescued(db, v.beer_id, file.issue, atIso)) report.marked += 1;
      else report.alreadyMarked += 1;
    }
  });
  run(file.verdicts);
  return report;
}

// #576 I3: a defensible number, not a precise one — the design's own mitigation for staleness
// was "`--apply` is done in the same session, alongside", which is convention, not code. Four
// hours covers a same-session apply with a break for a coffee or an interruption, while still
// catching "I found this file from three days ago and scrolled up to the wrong `apply with:`
// line".
//
// Це вікно судить ПРОГІН цілком і тому не замінює `lookup_moved`: окремий рядок може зрушити
// всередині цілком свіжого файлу. Так само `lookup_moved` не замінює вікна: воно ловить те,
// чого не видно в жодному полі рядка — що світ навколо прогону встиг змінитись. Дві різні
// перевірки, і жодна з них не є слабшою версією іншої.
export const STALE_VERDICT_FILE_MS = 4 * 60 * 60 * 1000;

export function verdictFileAgeMs(file: VerdictFile, nowIso: string): number {
  return new Date(nowIso).getTime() - Date.parse(file.probed_at);
}

export function isVerdictFileStale(file: VerdictFile, nowIso: string): boolean {
  return verdictFileAgeMs(file, nowIso) > STALE_VERDICT_FILE_MS;
}

// Short, human-readable age for the pre-apply print and the refusal message. Deliberately coarse
// (one decimal on hours) — an operator deciding whether to trust a file does not need seconds.
export function formatAge(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(hours * 10) / 10}h`;
}

// #576 I3: printed before any write, so the operator sees exactly what they are about to apply
// (which file, from which run, how many verdicts of each kind) instead of a bare "marked N,
// already marked M" after the fact.
export function summarizeVerdictFile(file: VerdictFile, nowIso: string): string {
  const age = verdictFileAgeMs(file, nowIso);
  const tally = formatVerdictTally(tallyVerdicts(file.verdicts));
  return `issue ${file.issue}, probed_at ${file.probed_at} (${formatAge(age)} ago), `
    + `${file.verdicts.length} verdicts: ${tally}`;
}
