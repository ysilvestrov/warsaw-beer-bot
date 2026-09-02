import type pino from 'pino';
import type { DB } from '../storage/db';
import type { LookupOutcome } from '../domain/untappd-lookup';
import { noopBreaker, type CircuitBreaker } from '../domain/untappd-circuit';

export interface Verdict {
  beer_id: number; brewery: string; name: string;
  verdict: 'unrescued' | 'rescued' | 'inconclusive' | 'already_marked';
}

export interface VerdictFile {
  issue: number;
  probed_at: string;
  verdicts: Verdict[];
}

// #576: проба або ціла, або її немає. Часткового результату не буває — тому ніякого
// `{status:'ok', partial:true}`.
export type ProbeOutcome =
  | { status: 'ok'; file: VerdictFile }
  | { status: 'circuit_open' }
  | { status: 'canary_failed'; at: 'before' | 'after' };

// #558: адюдикація рядків одного фіксу. Політика вже вимагає реплею перед фіксом —
// різниця лише в тому, що досі його результат жив у чаті й помирав із сесією.
//
// Свідомо НЕ застосовує наслідків: не пише лінк на `matched`, не рухає бекоф на
// `not_found`. Інструмент виносить вердикт про долю рядка, а не робить роботу крона —
// інакше одна помилка в ньому псувала б каталог. Тому й `lookup` — це шов: у проді
// сюди передають `(beer) => lookupBeer({ ...beer, search })`.
//
// Контракт `lookup` (не виведений з типів — цикл нижче навмисно без try/catch): він НЕ
// МАЄ кидати. Мережеву/проксі помилку `lookupBeer` завжди нормалізує в
// `{ kind: 'transient' }`, а не в exception — той самий контракт, що й тут. Кидок із
// `lookup` пробив би адюдикацію одного рядка й обірвав пробу решти рядків issue без
// жодного запису, і жоден тип цього не зловить.
export interface ProbeDeps {
  db: DB;
  log: pino.Logger;
  lookup: (beer: { brewery: string; name: string; abv: number | null }) => Promise<LookupOutcome>;
  // #576: один пошук завідомо наявного пива. Системний збій (ротований ключ, перейменований
  // індекс, м'який IP-бан) віддає 200+порожньо НА ВСЕ, що для нас невідрізненне від чесного
  // not_found — і без цієї перевірки перетворилося б на маркер `unrescued` на КОЖНОМУ рядку
  // issue. Захист від transient/blocked (#316) цього не бачить: збій виглядає добропорядно.
  canary: () => Promise<boolean>;
  breaker?: CircuitBreaker;
  sleep?: (ms: number) => Promise<void>;
  sleepMs?: number;
  limit?: number;
  now?: () => Date;
}

// #576: a throwing canary must read as a FAILED canary, not as a crash. A rotated key raises
// an auth error rather than returning 200+empty, and that is precisely the case the canary
// exists for — letting it escape would turn "we write nothing" into an unhandled rejection.
// Mirrors the inline try/catch in `enrich-orphans.ts` around its identical canary call.
async function canaryOk(canary: () => Promise<boolean>): Promise<boolean> {
  try {
    return await canary();
  } catch {
    return false;
  }
}

export async function probeIssueRows(
  deps: ProbeDeps,
  issueNumber: number,
): Promise<ProbeOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const breaker = deps.breaker ?? noopBreaker;
  const sleepMs = deps.sleepMs ?? 500;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // #576: брейкер ЧИТАЄМО, але не пишемо. Разова ручна команда не повинна поглиблювати
  // чужу аварію — і так само не повинна автоматично гальмувати фонові джоби.
  if (!breaker.canAttempt(now)) {
    deps.log.warn('adjudicate: circuit open, refusing to probe');
    return { status: 'circuit_open' };
  }

  if (!(await canaryOk(deps.canary))) {
    deps.log.error('adjudicate: opening canary failed — Untappd search looks broken');
    return { status: 'canary_failed', at: 'before' };
  }

  const rows = deps.db
    .prepare(
      `SELECT b.id, b.brewery, b.name, b.abv, ef.unrescued_at
         FROM enrich_failures ef JOIN beers b ON b.id = ef.beer_id
        WHERE ef.issue_number = ?
          AND ef.retired_at IS NULL
          AND b.untappd_id IS NULL
        ORDER BY b.id`,
    )
    .all(issueNumber) as {
      id: number; brewery: string; name: string; abv: number | null; unrescued_at: string | null;
    }[];

  const selected = deps.limit === undefined ? rows : rows.slice(0, deps.limit);
  const verdicts: Verdict[] = [];

  for (const row of selected) {
    const base = { beer_id: row.id, brewery: row.brewery, name: row.name };
    // Уже вирішений рядок не варто пробувати вдруге — це чиста витрата квоти, а вердикт
    // від неї не зміниться (маркер знімає лише явний ре-арм).
    if (row.unrescued_at !== null) {
      verdicts.push({ ...base, verdict: 'already_marked' });
      continue;
    }
    const outcome = await deps.lookup({ brewery: row.brewery, name: row.name, abv: row.abv });
    await sleep(sleepMs);
    if (outcome.kind === 'matched') verdicts.push({ ...base, verdict: 'rescued' });
    else if (outcome.kind === 'not_found') verdicts.push({ ...base, verdict: 'unrescued' });
    else {
      deps.log.warn({ beerId: row.id, kind: outcome.kind }, 'adjudicate: inconclusive probe');
      verdicts.push({ ...base, verdict: 'inconclusive' });
    }
  }

  // #576: закривна канарка. Якщо Untappd зламався ПОСЕРЕДИНІ, хвіст прогону складається з
  // хибних `unrescued` — а оскільки досі нічого не записано, достатньо не віддати файл.
  if (!(await canaryOk(deps.canary))) {
    deps.log.error('adjudicate: closing canary failed — discarding the whole run');
    return { status: 'canary_failed', at: 'after' };
  }

  return {
    status: 'ok',
    file: { issue: issueNumber, probed_at: now.toISOString(), verdicts },
  };
}
