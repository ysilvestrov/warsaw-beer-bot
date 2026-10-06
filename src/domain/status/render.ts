import type { Colour, Evaluation, SubsystemId } from './types';

export const TELEGRAM_LIMIT = 4096;
const TRUNCATION_MARK = '\n… (обрізано)';

const EMOJI: Record<Colour, string> = { green: '🟢', yellow: '🟡', red: '🔴' };
const VERDICT: Record<Colour, string> = { green: 'все гаразд', yellow: 'потребує уваги', red: 'потрібна реакція' };
const NAME: Record<SubsystemId, string> = {
  taps: 'Крани', untappd: 'Untappd', orphans: 'Сироти', channels: 'Канали', fest: 'Фест', infra: 'Інфраструктура',
};

export interface StatusReport {
  stamp: string;          // Warsaw "YYYY-MM-DD HH:mm"
  overall: Colour;
  subsystems: Evaluation[];
  footers: string[];
  events: string[];
  users: string[];
  trends: string[];
}

// Cuts to at most `max` UTF-16 units without leaving a lone high surrogate (half an emoji) at the end.
function cutAtCodePoint(text: string, max: number): string {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

const section = (title: string, lines: string[]): string[][] =>
  lines.length === 0 ? [] : [[title, ...lines.map((l) => `  • ${l}`)]];

// Order is urgency: what needs a reaction first, trends last — so truncation eats trends first.
export function renderStatusReport(r: StatusReport): string {
  const blocks: string[][] = [
    [
      `${EMOJI[r.overall]} Статус бота — ${r.stamp} · ${VERDICT[r.overall]}`,
      '',
      r.subsystems.map((s) => `${EMOJI[s.colour]} ${NAME[s.subsystem]}`).join('  '),
    ],
    ...r.subsystems
      .filter((s) => s.colour !== 'green')
      .map((s) => [`${EMOJI[s.colour]} ${NAME[s.subsystem]}`, ...s.reasons.map((x) => `  • ${x}`)]),
    ...(r.footers.length === 0 ? [] : [r.footers.map((x) => `ℹ️ ${x}`)]),
    ...section('Події', r.events),
    ...section('Живі користувачі', r.users),
    ...section('Тренди', r.trends),
  ];
  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  return text.length <= TELEGRAM_LIMIT
    ? text
    : cutAtCodePoint(text, TELEGRAM_LIMIT - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}
