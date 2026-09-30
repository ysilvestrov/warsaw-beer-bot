import { createHash } from 'node:crypto';
import type { Translator } from '../../i18n';
import type { FestView } from '../../jobs/fest-view';
import type { TapStatus } from '../../domain/fest/tap-status';
import type { FestStand } from '../../storage/fest_stands';
import { escapeHtml } from './html';

// Telegram callback data is capped at 64 bytes, and a section name is free text of any length, so
// buttons carry a short stable hash of the section and the handler resolves it back.
export function sectionKey(section: string): string {
  return createHash('sha1').update(section).digest('hex').slice(0, 10);
}

const hhmm = (iso: string): string =>
  new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso));

export function standLabel(t: Translator, stand: FestStand | undefined): string {
  if (!stand || (!stand.floor && !stand.stand)) return '';
  if (stand.floor && stand.stand) return t('fest.stand', { floor: stand.floor, stand: stand.stand });
  return stand.stand ?? t('fest.stand_floor_only', { floor: stand.floor! });
}

export function statusLabel(t: Translator, s: TapStatus | undefined, now: Date): string {
  if (!s || s.kind === 'unknown') return t('fest.status_unknown');
  if (s.kind === 'not_seen') return t('fest.status_not_seen');
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(s.lastAt)) / 60000));
  return t('fest.status_on_tap', { mins, count: s.count });
}

function menuLine(t: Translator, view: FestView): string {
  return view.menuUpdatedAt === null
    ? t('fest.menu_empty')
    : t('fest.menu_line', { count: view.menuCount, time: hhmm(view.menuUpdatedAt) });
}

/** "Where to go" (spec §7): one line per section with Targets, best first. */
export function formatRanking(t: Translator, view: FestView): string {
  const lines = [menuLine(t, view)];
  if (view.menuUpdatedAt === null) return lines.join('\n');
  if (view.ranking.length === 0) {
    lines.push('', t('fest.no_targets'));
    return lines.join('\n');
  }
  lines.push('');
  for (const r of view.ranking) {
    const stand = standLabel(t, view.stands.get(r.section));
    lines.push(`🍺 ${r.onTap} · ❔ ${r.unknown} · <b>${escapeHtml(r.section)}</b>${stand ? ` · ${escapeHtml(stand)}` : ''}`);
  }
  lines.push('', t('fest.legend'));
  return lines.join('\n');
}

/** One section's Targets with their tap status; null when the section is not in the ranking. */
export function formatSection(t: Translator, view: FestView, key: string, now: Date): string | null {
  const rank = view.ranking.find((r) => sectionKey(r.section) === key);
  if (!rank) return null;
  const stand = standLabel(t, view.stands.get(rank.section));
  const lines = [`<b>${escapeHtml(rank.section)}</b>${stand ? ` · ${escapeHtml(stand)}` : ''}`, ''];
  for (const target of rank.targets) {
    const beer = view.beerNames.get(target.beerId);
    const name = beer ? beer.name : `#${target.beerId}`;
    const rating = target.rating !== null ? ` · ⭐ ${target.rating.toFixed(2)}` : '';
    lines.push(`${escapeHtml(name)}${rating}`, `   ${statusLabel(t, view.statusByBeer.get(target.beerId), now)}`);
  }
  return lines.join('\n');
}
