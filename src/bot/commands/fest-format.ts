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

/** The line under a beer, or null when the status says nothing (unknown): the section head counts those. */
export function statusLabel(t: Translator, s: TapStatus | undefined, now: Date): string | null {
  if (!s || s.kind === 'unknown') return null;
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
  // One "no status" line for the section instead of the same line under every beer (rank.unknown is
  // the ❔ count the ranking shows, so the two screens agree).
  const head = [
    `<b>${escapeHtml(rank.section)}</b>${stand ? ` · ${escapeHtml(stand)}` : ''}`,
    ...(rank.unknown > 0 ? [t('fest.section_unknown', { count: rank.unknown })] : []),
    '',
  ];
  const items = rank.targets.map((target) => {
    const beer = view.beerNames.get(target.beerId);
    const name = beer ? beer.name : `#${target.beerId}`;
    const rating = target.rating !== null ? ` · ⭐ ${target.rating.toFixed(2)}` : '';
    const status = statusLabel(t, view.statusByBeer.get(target.beerId), now);
    return `${escapeHtml(name)}${rating}${status === null ? '' : `\n   ${status}`}`;
  });
  return fitMessage(t, head, items);
}

export const TARGETS_SHOWN = 40;

function reasonsLabel(t: Translator, target: FestView['targets'][number]): string {
  return target.reasons.map((r) =>
    r === 'rating' ? t('fest.reason_rating', { rating: (target.rating ?? 0).toFixed(2) })
      : r === 'style' ? t('fest.reason_style')
      : r === 'abv' ? t('fest.reason_abv')
      : r === 'name' ? t('fest.reason_name')
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

/**
 * /fest queue (spec §7): the glasses someone has not checked in yet (⏳), who got each, and every
 * member's ✅/⏳. Glasses checked in by everyone are hidden and only counted
 * (2026-10-15-fest-queue-hide-done-design.md): on a long fest they buried what is left to drink.
 */
export function formatQueue(t: Translator, view: QueueView): string {
  // The hint names a placeholder in angle brackets; the reply is HTML, so it must be escaped.
  if (view.items.length === 0) return escapeHtml(t('fest.queue_empty'));
  const open = queueOrder(view).filter(isOpen);
  const hidden = view.items.length - open.length;
  const items = open.map((item) => t('fest.queue_line', {
    glass: item.glassNo,
    name: escapeHtml(item.name),
    section: item.section ? ` (${escapeHtml(item.section)})` : '',
    taker: escapeHtml(item.takenBy),
    marks: item.closedBy.map((c) => `${c.checkinId === null ? '⏳' : '✅'} ${escapeHtml(c.initials)}`).join(' '),
  }));
  return fitMessage(t, [t('fest.queue_header'), ''], items, hidden > 0 ? [t('fest.queue_done_hidden', { count: hidden })] : []);
}

export const QUEUE_LINKS = 20;

/** Untappd links for the open glasses that have a bid: the page to check in from. */
export function queueLinks(view: QueueView): { glassNo: number; name: string; bid: number }[] {
  return queueOrder(view)
    .filter((item) => isOpen(item) && item.bid !== null)
    .slice(0, QUEUE_LINKS)
    .map((item) => ({ glassNo: item.glassNo, name: item.name, bid: item.bid! }));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** Code units segmented past the cut, so a cluster straddling it is seen whole (or dropped). */
const CAP_LOOKAHEAD = 64;

/**
 * `text` cut to at most `max` UTF-16 code units — the unit Telegram's message limit counts — with
 * "…" as the last one when anything was cut. The cut falls only between grapheme clusters, so a
 * flag or a skin-toned emoji is never split; a single cluster longer than `max` leaves just "…".
 * Only a bounded prefix is segmented, so a huge field costs no more than a normal one.
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 1) return '';
  // Segment only a prefix a little past the cut: cost stays O(max) even for one cluster of a
  // million combining marks. The prefix's last segment may be a cluster the slice cut short, so it
  // is dropped; every segment before it ends inside the prefix and is whole.
  const segments = Array.from(graphemes.segment(text.slice(0, max + CAP_LOOKAHEAD)), (g) => g.segment);
  segments.pop();
  let kept = '';
  for (const segment of segments) {
    if (kept.length + segment.length > max - 1) break;
    kept += segment;
  }
  return `${kept}…`;
}

/**
 * UTF-16 code units kept of each free-text field of an alert line (name, brewery, place). Even with
 * every character escaped (`&amp;` is 5 units) three fields and the template stay far below the
 * message limit, so any one line fits an empty message.
 */
export const ALERT_FIELD_MAX = 120;

/**
 * The group alert (spec §6.5): fresh first check-ins as "🆕", older ones as "already pouring",
 * in one message. Lines are added only while the message fits Telegram's limit, and the beers
 * actually included are returned: only those may be recorded as announced — the rest wait for the
 * next tick. Null when there is nothing to say.
 */
export function formatAlert(t: Translator, view: FestView, plan: AlertPlan, limit = MESSAGE_LIMIT): { html: string; beerIds: number[] } | null {
  // Every field is capped, so any one line fits an empty message: a line that could never fit
  // would stop its block for good, since the loop below keeps order and stops at the first misfit.
  const cap = (text: string) => capText(text, ALERT_FIELD_MAX);
  const line = (item: OnTapTarget) => {
    const beer = view.beerNames.get(item.beerId);
    const section = view.targets.find((target) => target.beerId === item.beerId)?.section ?? '';
    const stand = standLabel(t, view.stands.get(section));
    return t('fest.alert_line', {
      name: escapeHtml(cap(beer?.name ?? `#${item.beerId}`)),
      brewery: escapeHtml(cap(beer?.brewery ?? '')),
      place: escapeHtml(cap(stand ? `${section} · ${stand}` : section)),
      time: hhmm(item.firstAt),
    });
  };
  let html = '';
  const beerIds: number[] = [];
  for (const [header, items] of [[t('fest.alert_new'), plan.fresh], [t('fest.alert_pouring'), plan.pouring]] as const) {
    let opened = false;
    for (const item of items) {
      const piece = (opened ? '\n' : `${html ? '\n\n' : ''}${header}\n`) + line(item);
      if ((html + piece).length > limit) break;
      html += piece;
      opened = true;
      beerIds.push(item.beerId);
    }
  }
  return beerIds.length > 0 ? { html, beerIds } : null;
}
