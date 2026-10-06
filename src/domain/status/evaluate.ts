import type { Colour, Evaluation, FestInputs, StatusInputs, SubsystemId } from './types';
import { STATUS_RULES as R } from './rules';
import { gib, groupThousands, median, previousDays, shiftDate, snapshotOn, warsawClock } from './helpers';

type Finding = { colour: 'yellow' | 'red'; reason: string };
const red = (reason: string): Finding => ({ colour: 'red', reason });
const yellow = (reason: string): Finding => ({ colour: 'yellow', reason });

const RANK: Record<Colour, number> = { green: 0, yellow: 1, red: 2 };

export function worst(colours: Colour[]): Colour {
  return colours.reduce<Colour>((acc, c) => (RANK[c] > RANK[acc] ? c : acc), 'green');
}

function evaluation(subsystem: SubsystemId, findings: Finding[]): Evaluation {
  return { subsystem, colour: worst(findings.map((f) => f.colour)), reasons: findings.map((f) => f.reason) };
}

const openUntil = (until: string | null, now: Date): string | null =>
  until !== null && Date.parse(until) > now.getTime() ? until : null;

export function evaluateTaps(i: StatusInputs): Evaluation {
  const m = i.metrics;
  const f: Finding[] = [];
  if (m.lastScrapeHoursAgo === null) {
    f.push(red('скрейпів кранів немає взагалі'));
  } else if (!Number.isFinite(m.lastScrapeHoursAgo) || m.lastScrapeHoursAgo < 0) {
    f.push(yellow('нема даних: некоректний час останнього скрейпу'));
  } else {
    const ago = `останній скрейп ${Math.round(m.lastScrapeHoursAgo)} год тому`;
    if (m.lastScrapeHoursAgo > R.scrapeRedHours) f.push(red(ago));
    else if (m.lastScrapeHoursAgo > R.scrapeYellowHours) f.push(yellow(ago));
    if (m.onTapPubs === 0) f.push(red('у свіжих знімках 0 пабів із кранами'));
  }
  const week = previousDays(i.history, i.dateKey, R.historyDays);
  if (week !== null) {
    const usual = median(week.map((s) => s.metrics.pubsScraped24h));
    if (m.pubsScraped24h < usual * R.pubsYellowShare) {
      f.push(yellow(`скрейп за 24 год охопив ${m.pubsScraped24h} пабів проти звичних ${usual}`));
    }
  }
  return evaluation('taps', f);
}

export function evaluateUntappd(i: StatusInputs): Evaluation {
  const f: Finding[] = [];
  if (!i.canary.ok) f.push(yellow(`нема даних: ${i.canary.reason}`));
  else if (i.canary.value === null) f.push(yellow('нема даних: канарка пошуку ще не запускалась'));
  else if (!i.canary.value.ok) {
    f.push(red(`канарка пошуку порожня на останньому запуску (${warsawClock(i.canary.value.at)})`));
  }
  const algolia = openUntil(i.algoliaOpenUntil, i.now);
  if (algolia !== null) f.push(red(`Algolia-breaker відкритий до ${warsawClock(algolia)}`));
  const profile = openUntil(i.profileOpenUntil, i.now);
  if (profile !== null) f.push(yellow(`breaker профіль-скрейпу відкритий до ${warsawClock(profile)}`));
  const week = previousDays(i.history, i.dateKey, R.historyDays);
  if (week !== null) {
    const usual = median(week.map((s) => s.metrics.ratingsMissing));
    const excess = i.metrics.ratingsMissing - usual;
    if (excess > R.ratingsMissingAbs && excess > usual * R.ratingsMissingRel) {
      f.push(yellow(`зматчених без рейтингу ${groupThousands(i.metrics.ratingsMissing)} проти звичних ${groupThousands(usual)}`));
    }
  }
  return evaluation('untappd', f);
}

function staleness(what: string, lastAt: string | null, cycleMs: number, now: Date): Finding[] {
  if (lastAt === null) return [yellow(`${what}: ще жодного успішного оновлення`)];
  const age = now.getTime() - Date.parse(lastAt);
  if (!Number.isFinite(age) || age < 0) return [yellow(`${what}: нема даних (некоректний час)`)];
  const text = `${what} не оновлювалось ${Math.round(age / 3_600_000)} год`;
  if (age > cycleMs * R.festRedCycles) return [red(text)];
  if (age > cycleMs * R.festYellowCycles) return [yellow(text)];
  return [];
}

export function evaluateFest(fest: FestInputs, now: Date): Evaluation {
  return evaluation('fest', [
    ...staleness('меню фесту', fest.menuLastAt, fest.menuCycleMs, now),
    ...staleness('MCP keep-alive фесту', fest.keepaliveLastAt, fest.keepaliveCycleMs, now),
  ]);
}

export function evaluateInfra(i: StatusInputs): Evaluation {
  if (!i.disk.ok) return evaluation('infra', [yellow(`нема даних: ${i.disk.reason}`)]);
  const d = i.disk.value;
  const f: Finding[] = [];
  if (d.bytesAvailable <= R.diskRedBytes) f.push(red(`диск: ${gib(d.bytesAvailable)} GiB вільно`));
  else if (d.bytesAvailable <= R.diskYellowBytes) f.push(yellow(`диск: ${gib(d.bytesAvailable)} GiB вільно`));
  if (d.inodesFree < R.inodesRedFree) f.push(red(`inode: ${groupThousands(d.inodesFree)} вільно`));
  if (d.pendingRuns === null) f.push(yellow('нема даних: інвентар тестових каталогів'));
  else if (d.pendingRuns > 0) f.push(yellow(`тестових каталогів на перевірку: ${d.pendingRuns}`));
  const weekAgo = snapshotOn(i.history, shiftDate(i.dateKey, -R.historyDays));
  if (weekAgo !== null && weekAgo.metrics.diskBytesAvailable !== null) {
    const perDay = (weekAgo.metrics.diskBytesAvailable - d.bytesAvailable) / R.historyDays;
    if (perDay > R.diskFallYellowBytesPerDay) f.push(yellow(`диск тане ~${gib(perDay)} GiB/добу`));
  }
  return evaluation('infra', f);
}

const WITHHELD_EXAMPLES = 5;

// Capped at yellow by construction: an orphan is "rating unknown", never a wrong answer. Every
// finding below is built with yellow(); there is deliberately no red() call in this function.
export function evaluateOrphans(i: StatusInputs): Evaluation {
  const m = i.metrics;
  const f: Finding[] = [];
  if (!i.triage.ranToday) f.push(yellow('тріаж сиріт сьогодні не відпрацював'));
  if (i.triage.saturated !== null) f.push(yellow(i.triage.saturated));
  if (!i.unlock.ranToday) f.push(yellow('замок сьогодні не перевірявся (unlock-fixed-orphans)'));
  const w = i.unlock.withheld;
  if (w.length > 0) {
    const examples = w.slice(0, WITHHELD_EXAMPLES).map((r) => `#${r.issueNumber} / beer ${r.beerId}`).join(', ');
    f.push(yellow(`утримано після закриття: ${w.length} (${examples}${w.length > WITHHELD_EXAMPLES ? ', …' : ''})`));
  }
  if (m.unlockedUnadjudicated7d > 0) {
    f.push(yellow(`розімкнено без негативного маркера за 7 днів: ${m.unlockedUnadjudicated7d}`));
  }
  const yesterday = snapshotOn(i.history, shiftDate(i.dateKey, -1));
  if (yesterday !== null && m.sealRetiredFalsified > yesterday.metrics.sealRetiredFalsified) {
    f.push(yellow(`спростованих retire: ${yesterday.metrics.sealRetiredFalsified} → ${m.sealRetiredFalsified}`));
  }
  return evaluation('orphans', f);
}

// Stage 1 sees only the bug-report worker; /match and MCP error counters arrive in stage 2.
export function evaluateChannels(i: StatusInputs): Evaluation {
  const f: Finding[] = [];
  if (i.bugReports !== null) {
    const { summary, paused } = i.bugReports;
    if (paused !== null) {
      f.push(red(`скарги на паузі з ${paused.since.slice(0, 16).replace('T', ' ')} UTC: ключ відхилено (${paused.status})`));
    }
    const review = [...summary.needsReview, ...summary.failed];
    if (review.length > 0) f.push(yellow(`скарги потребують перевірки: ${review.map((id) => `R-${id}`).join(', ')}`));
  }
  return evaluation('channels', f);
}

export interface StatusEvaluation {
  overall: Colour;
  subsystems: Evaluation[];
  footers: string[];
}

export function evaluateAll(i: StatusInputs): StatusEvaluation {
  const subsystems = [
    evaluateTaps(i),
    evaluateUntappd(i),
    evaluateOrphans(i),
    evaluateChannels(i),
    ...(i.fest === null ? [] : [evaluateFest(i.fest, i.now)]),
    evaluateInfra(i),
  ];
  const known = Array.from({ length: R.historyDays }, (_, k) => shiftDate(i.dateKey, -(k + 1)))
    .filter((d) => snapshotOn(i.history, d) !== null).length;
  const footers = known < R.historyDays
    ? [`історія: ${known}/${R.historyDays} днів — порівняльні правила ще не діють`]
    : [];
  return { overall: worst(subsystems.map((s) => s.colour)), subsystems, footers };
}
