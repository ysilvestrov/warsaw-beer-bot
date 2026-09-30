import { createHash } from 'node:crypto';
import type { Translator } from '../../i18n';
import type { FestView } from '../../jobs/fest-view';
import type { QueueItemView, QueueView } from '../../jobs/fest-queue-view';
import type { AlertPlan, OnTapTarget } from '../../domain/fest/alerts';
import type { TapStatus } from '../../domain/fest/tap-status';
import type { FestStand } from '../../storage/fest_stands';
import { escapeHtml } from './html';

// Telegram callback data is capped at 64 bytes, and a section name is free text of any length, so
// buttons carry a short stable hash of the section and the handler resolves it back.
export function sectionKey(section: string): string {
  return createHash('sha1').update(section).digest('hex').slice(0, 10);
}

// Telegram rejects a message over 4096 characters outright, so a long festival (many sections,
// long names) must lose lines, not the whole reply. The margin covers the "not shown" line.
export const MESSAGE_LIMIT = 4000;

/** head + as many items as fit + tail, with a "N lines not shown" line when items were dropped. */
export function fitMessage(t: Translator, head: string[], items: string[], tail: string[] = [], limit = MESSAGE_LIMIT): string {
  const all = [...head, ...items, ...tail].join('\n');
  if (all.length <= limit) return all;
  const reserve = t('fest.lines_more', { count: items.length }).length + 1;
  let size = [...head, ...tail].join('\n').length + reserve;
  const kept: string[] = [];
  for (const item of items) {
    if (size + item.length + 1 > limit) break;
    kept.push(item);
    size += item.length + 1;
  }
  const out = [...head, ...kept, t('fest.lines_more', { count: items.length - kept.length }), ...tail].join('\n');
  // Head and tail alone can outgrow the limit (a big team's history lines): a clipped reply is still
  // an answer and a rejected one is none. Cut at a line boundary (an entity never spans lines) and
  // drop the markup, since a tag may open before the cut and close after it.
  if (out.length <= limit) return out;
  const nl = out.slice(0, limit - 1).lastIndexOf('\n');
  return nl > 0 ? out.slice(0, nl).replace(/<[^>]*>/g, '') + '\n…' : '…';
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
  if (view.menuUpdatedAt === null) return menuLine(t, view);
  if (view.ranking.length === 0) return [menuLine(t, view), '', t('fest.no_targets')].join('\n');
  const items = view.ranking.map((r) => {
    const stand = standLabel(t, view.stands.get(r.section));
    return `🍺 ${r.onTap} · ❔ ${r.unknown} · <b>${escapeHtml(r.section)}</b>${stand ? ` · ${escapeHtml(stand)}` : ''}`;
  });
  return fitMessage(t, [menuLine(t, view), ''], items, ['', t('fest.legend')]);
}

/** One section's Targets with their tap status; null when the section is not in the ranking. */
export function formatSection(t: Translator, view: FestView, key: string, now: Date): string | null {
  const rank = view.ranking.find((r) => sectionKey(r.section) === key);
  if (!rank) return null;
  const stand = standLabel(t, view.stands.get(rank.section));
  const head = [`<b>${escapeHtml(rank.section)}</b>${stand ? ` · ${escapeHtml(stand)}` : ''}`, ''];
  const items = rank.targets.map((target) => {
    const beer = view.beerNames.get(target.beerId);
    const name = beer ? beer.name : `#${target.beerId}`;
    const rating = target.rating !== null ? ` · ⭐ ${target.rating.toFixed(2)}` : '';
    return `${escapeHtml(name)}${rating}\n   ${statusLabel(t, view.statusByBeer.get(target.beerId), now)}`;
  });
  return fitMessage(t, head, items);
}

export const TARGETS_SHOWN = 40;

function reasonsLabel(t: Translator, target: FestView['targets'][number]): string {
  return target.reasons.map((r) =>
    r === 'rating' ? t('fest.reason_rating', { rating: (target.rating ?? 0).toFixed(2) })
      : r === 'style' ? t('fest.reason_style')
      : t('fest.reason_manual')).join(' · ');
}

/**
 * /fest targets (spec §7): Targets with reasons, the untried-but-unrated list apart, and how
 * complete each member's history is — "nobody has had it" is only as true as the worst history.
 */
export function formatTargets(t: Translator, view: FestView): string {
  const head = [t('fest.history_header')];
  for (const m of view.members) {
    head.push(t('fest.history_line', {
      initials: escapeHtml(m.initials),
      inBot: m.inBot,
      total: m.profileTotal === null ? t('fest.history_unknown') : m.profileTotal,
    }));
  }
  head.push('', t('fest.targets_header', { count: view.targets.length }));
  const items: string[] = [];
  for (const target of view.targets.slice(0, TARGETS_SHOWN)) {
    const beer = view.beerNames.get(target.beerId);
    items.push(`• ${escapeHtml(beer?.name ?? `#${target.beerId}`)} — ${escapeHtml(beer?.brewery ?? target.section)} · ${reasonsLabel(t, target)}`);
  }
  if (view.targets.length > TARGETS_SHOWN) items.push(t('fest.targets_more', { count: view.targets.length - TARGETS_SHOWN }));
  if (view.unrated.length > 0) {
    items.push('', t('fest.unrated_header', { count: view.unrated.length }));
    for (const u of view.unrated.slice(0, TARGETS_SHOWN)) {
      const beer = view.beerNames.get(u.beer_id);
      items.push(`• ${escapeHtml(beer?.name ?? `#${u.beer_id}`)} — ${escapeHtml(u.style ?? '?')}`);
    }
    if (view.unrated.length > TARGETS_SHOWN) items.push(t('fest.targets_more', { count: view.unrated.length - TARGETS_SHOWN }));
  }
  return fitMessage(t, head, items);
}

/** Menu beers whose name or brewery contains `query` (case-insensitive), at most `limit`. */
export function searchMenu(view: FestView, query: string, limit = 8): { beerId: number; label: string }[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const out: { beerId: number; label: string }[] = [];
  for (const [beerId, b] of view.beerNames) {
    if (`${b.name} ${b.brewery}`.toLowerCase().includes(q)) out.push({ beerId, label: `${b.name} — ${b.brewery}` });
    if (out.length === limit) break;
  }
  return out;
}

const isOpen = (item: QueueItemView): boolean => item.closedBy.some((c) => c.checkinId === null);

/** Queue items not yet checked in by everyone first, each group by glass number. */
export function queueOrder(view: QueueView): QueueItemView[] {
  return [...view.items].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || a.glassNo - b.glassNo);
}

/** /fest queue (spec §7): every glass, who got it, and who has checked it in (✅) or not yet (⏳). */
export function formatQueue(t: Translator, view: QueueView): string {
  if (view.items.length === 0) return t('fest.queue_empty');
  const items = queueOrder(view).map((item) => t('fest.queue_line', {
    glass: item.glassNo,
    name: escapeHtml(item.name),
    section: item.section ? ` (${escapeHtml(item.section)})` : '',
    taker: escapeHtml(item.takenBy),
    marks: item.closedBy.map((c) => `${c.checkinId === null ? '⏳' : '✅'} ${escapeHtml(c.initials)}`).join(' '),
  }));
  return fitMessage(t, [t('fest.queue_header'), ''], items);
}

export const QUEUE_LINKS = 20;

/** Untappd links for the open glasses that have a bid: the page to check in from. */
export function queueLinks(view: QueueView): { glassNo: number; name: string; bid: number }[] {
  return queueOrder(view)
    .filter((item) => isOpen(item) && item.bid !== null)
    .slice(0, QUEUE_LINKS)
    .map((item) => ({ glassNo: item.glassNo, name: item.name, bid: item.bid! }));
}

/**
 * The group alert (spec §6.5): fresh first check-ins as "🆕", older ones as "already pouring",
 * in one message. Null when there is nothing to say.
 */
export function formatAlert(t: Translator, view: FestView, plan: AlertPlan): string | null {
  const line = (item: OnTapTarget) => {
    const beer = view.beerNames.get(item.beerId);
    const section = view.targets.find((target) => target.beerId === item.beerId)?.section ?? '';
    const stand = standLabel(t, view.stands.get(section));
    return t('fest.alert_line', {
      name: escapeHtml(beer?.name ?? `#${item.beerId}`),
      brewery: escapeHtml(beer?.brewery ?? ''),
      place: escapeHtml(stand ? `${section} · ${stand}` : section),
      time: hhmm(item.firstAt),
    });
  };
  const blocks: string[][] = [];
  if (plan.fresh.length) blocks.push([t('fest.alert_new'), ...plan.fresh.map(line)]);
  if (plan.pouring.length) blocks.push([t('fest.alert_pouring'), ...plan.pouring.map(line)]);
  if (blocks.length === 0) return null;
  return fitMessage(t, [], blocks.map((b) => b.join('\n')).join('\n\n').split('\n'));
}
