import type { MatchResult } from '../api/types';

export const BADGE_MARKER = 'data-beerbadge';
export const SEEN_MARKER = 'data-beerseen';

/** Mark a card element as processed by the overlay (badged or not). */
export function markSeen(el: HTMLElement): void {
  el.setAttribute(SEEN_MARKER, '');
}

/** True if the overlay has already processed this card element. */
export function isSeen(el: HTMLElement): boolean {
  return el.hasAttribute(SEEN_MARKER);
}

/** Undo the overlay's marks on a card so the next run re-processes it from scratch. */
export function resetCard(el: HTMLElement): void {
  el.querySelector(`[${BADGE_MARKER}]`)?.remove();
  el.removeAttribute(SEEN_MARKER);
}

const untappdUrl = (untappdId: number): string => `https://untappd.com/beer/${untappdId}`;

const untappdSearchUrl = (brewery: string, name: string): string =>
  `https://untappd.com/search?q=${encodeURIComponent(`${brewery} ${name}`.trim())}&type=beer`;

// A badge's click target: the beer's Untappd page when it has a bid, else a prefilled search.
const hrefFor = (untappdId: number | null, brewery: string, name: string): string =>
  untappdId != null ? untappdUrl(untappdId) : untappdSearchUrl(brewery, name);

// Builds the styled badge element. Clickable (opens `href` in a new tab) when href is set.
function makeBadge(text: string, href: string | null): HTMLElement {
  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.textContent = text;
  Object.assign(badge.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    zIndex: '2147483647',
    background: 'rgba(20,20,20,0.82)',
    color: '#fff',
    font: '600 12px/1 system-ui, sans-serif',
    padding: '3px 6px',
    borderRadius: '6px',
    pointerEvents: href != null ? 'auto' : 'none',
    cursor: href != null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);
  if (href != null) wireBadgeClicks(badge, href);
  return badge;
}

// Beershop delegates card navigation on mouseup, before click fires — so all three
// are swallowed. Shared by the legacy setters and by renderState (#648).
function wireBadgeClicks(badge: HTMLElement, href: string): void {
  badge.addEventListener('mouseup', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(href, '_blank', 'noopener');
  });
  badge.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(href, '_blank', 'noopener');
  });
}

function attach(host: HTMLElement, badge: HTMLElement): void {
  const outgoing = host.querySelector(`[${BADGE_MARKER}]`);
  if (outgoing) {
    // Removing an element does NOT cancel its animations, and the spinner runs with
    // `iterations: Infinity` — an infinite animation stays current forever and holds the
    // detached node alive. A card walks queued → working → found on every page run, and
    // the SPA re-render observer runs cards again, so these would accumulate with no
    // ceiling. Guarded because jsdom has no getAnimations.
    const stop = (outgoing as Element & { getAnimations?: (o?: { subtree?: boolean }) => Animation[] }).getAnimations;
    if (typeof stop === 'function') for (const a of stop.call(outgoing, { subtree: true })) a.cancel();
    outgoing.remove();
  }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(badge);
}

// Guard order: drunk → ✅ (+ personal rating); truly unmatched (matched_beer null) → no
// badge; fuzzy-match-but-drunk → ❓ (+ global if present); not-drunk bid → ⭐ (+ global if present);
// not-drunk matched orphan (no bid) → ⚪. All rendered badges are clickable: a bid → the
// Untappd beer page; no bid → an Untappd search prefilled with the tried brewery+name.
function badgeFor(result: MatchResult): HTMLElement | null {
  const { brewery, name } = result.raw;
  if (result.is_drunk) {
    const href = hrefFor(result.matched_beer?.untappd_id ?? null, brewery, name);
    return makeBadge(result.user_rating != null ? `✅ ${result.user_rating.toFixed(1)}` : '✅', href);
  }
  const m = result.matched_beer;
  if (!m) return null;
  if (result.drunk_uncertain) {
    return makeBadge(m.rating_global != null ? `❓ ${m.rating_global.toFixed(1)}` : '❓', hrefFor(m.untappd_id, brewery, name));
  }
  if (m.untappd_id != null) {
    const text = m.rating_global != null ? `⭐ ${m.rating_global.toFixed(1)}` : '⭐';
    return makeBadge(text, untappdUrl(m.untappd_id));
  }
  if (m.untappd_id == null) return makeBadge('⚪', untappdSearchUrl(brewery, name));
  return null;
}

export function renderBadge(host: HTMLElement, result: MatchResult): void {
  if (host.querySelector(`[${BADGE_MARKER}]`)) return; // idempotent for the /match path
  const badge = badgeFor(result);
  if (badge) attach(host, badge);
}

/** Show the ⚪ orphan badge (used by enrichment); clickable to an Untappd search. */
export function setOrphan(host: HTMLElement, brewery: string, name: string): void {
  attach(host, makeBadge('⚪', untappdSearchUrl(brewery, name)));
}

/** Show that the shop explicitly classified this card as not beer. */
export function setNonBeer(host: HTMLElement): void {
  const existing = host.querySelector(`[${BADGE_MARKER}]`);
  if (existing?.textContent === '✕'
    && existing.getAttribute('role') === 'img'
    && existing.getAttribute('aria-label') === 'Не пиво') return;

  const badge = makeBadge('✕', null);
  badge.style.color = '#ff6b6b';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', 'Не пиво');
  attach(host, badge);
}

/** Replace the badge with a loading glyph while an Untappd search is in flight. */
export function setSearching(host: HTMLElement): void {
  attach(host, makeBadge('⏳', null));
}

/** Swap the badge to ⭐ + global rating once the beer is enriched. */
export function setEnriched(host: HTMLElement, untappdId: number, ratingGlobal: number | null): void {
  attach(host, makeBadge(ratingGlobal != null ? `⭐ ${ratingGlobal.toFixed(1)}` : '⭐', untappdUrl(untappdId)));
}

// ── #648: один стан картки — один бейдж ──────────────────────────────────────
// Раніше бейдж будувався в п'ятьох місцях незалежно (badgeFor + чотири сеттери), і
// набору гліфів не бачив цілком ніхто. Тепер абетка живе в одному union: додати
// шостий гліф тихо вже не вийде.

export type FailureReason = 'blocked' | 'network' | 'server' | 'unparsed';

export type CardState =
  | { kind: 'queued' }
  | { kind: 'working' }
  | {
      kind: 'found';
      drunk: boolean;
      /** Твоя оцінка. Сервер заповнює її лише для точного збігу. */
      mine: number | null;
      global: number | null;
      unsure: boolean;
      /** null — випите пиво сидить на рядку-сироті; клік тоді веде в пошук. */
      untappdId: number | null;
      brewery: string;
      name: string;
    }
  | { kind: 'missing'; brewery: string; name: string; orphan: boolean }
  | { kind: 'deferred' }
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'nonBeer' };

const SVG_NS = 'http://www.w3.org/2000/svg';

type IconName = 'ring' | 'arc' | 'check' | 'star' | 'search' | 'reload' | 'warn' | 'cross';

// Кожна іконка — 12×12, малюється на місці через createElementNS. Спрайта в документі
// крамниці навмисно нема: чужа сторінка має свої `id`, і колізія коштувала б німого бейджа.
const ICONS: Record<IconName, [string, Record<string, string>][]> = {
  ring: [['circle', { cx: '6', cy: '6', r: '4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }]],
  arc: [
    ['circle', { cx: '6', cy: '6', r: '4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', opacity: '0.3' }],
    ['path', { d: 'M6 1.6a4.4 4.4 0 0 1 4.4 4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }],
  ],
  check: [['path', { d: 'M2.3 6.3 5 9 9.8 3.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  star: [['path', { d: 'M6 1.15 7.5 4.2l3.35.49-2.42 2.37.57 3.35L6 8.83 3 10.41l.57-3.35L1.15 4.69 4.5 4.2z', fill: 'currentColor' }]],
  search: [
    ['circle', { cx: '5.1', cy: '5.1', r: '3.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
    ['path', { d: 'M7.6 7.6 10.3 10.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' }],
  ],
  reload: [
    ['path', { d: 'M10.2 6a4.2 4.2 0 1 1-1.3-3.03', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }],
    ['path', { d: 'M10.5 1.2v2.5H8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
  ],
  warn: [
    ['path', { d: 'M6 1.5 11 10.4H1z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M6 4.8v2.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }],
    ['circle', { cx: '6', cy: '8.7', r: '0.75', fill: 'currentColor' }],
  ],
  cross: [['path', { d: 'M3 3 9 9M9 3 3 9', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' }]],
};

// Колір носить лише сигнал: це єдині дві картки, між якими людина обирає. Форма
// (галочка проти зірки) каже те саме без кольору — для монохрому й дальтонізму.
const COLOUR_DRUNK = '#63d999';
const COLOUR_RATING = '#ffc24d';

// SVG presentation attributes sit at the bottom of the cascade, so ANY shop stylesheet
// beats them — and two of the most common e-commerce resets are fatal here: `svg {
// width: 100% }` inflates the glyph inside a pill that has no width, and `svg path {
// fill: currentColor }` turns every outline into a blob, which makes the queued ring and
// the rated star the same shape. The old emoji badges were immune because they were text.
// So everything that paints or sizes goes into inline style, where only `!important`
// can reach it; only geometry stays an attribute.
const PAINT_PROPS = new Set([
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity',
]);

function icon(name: IconName, colour?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-icon', name);
  svg.style.setProperty('width', '12px', 'important');
  svg.style.setProperty('height', '12px', 'important');
  svg.style.display = 'block';
  svg.style.flex = 'none';
  if (colour) svg.style.color = colour;
  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (PAINT_PROPS.has(k)) node.style.setProperty(k, v, 'important');
      else node.setAttribute(k, v);
    }
    svg.appendChild(node);
  }
  return svg;
}

function spinning(svg: SVGSVGElement): SVGSVGElement {
  svg.style.transformOrigin = '50% 50%';
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // WAAPI, а не CSS-анімація: @keyframes вимагали б <style> у чужому документі.
  const animate = (svg as unknown as { animate?: Element['animate'] }).animate;
  if (!reduce && typeof animate === 'function') {
    animate.call(
      svg,
      [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 1100, iterations: Infinity },
    );
  }
  return svg;
}

const numberSpan = (text: string): HTMLElement => {
  const s = document.createElement('span');
  s.textContent = text;
  s.style.fontVariantNumeric = 'tabular-nums';
  return s;
};

const questionMark = (): HTMLElement => {
  const s = document.createElement('span');
  s.textContent = '?';
  s.style.font = '700 10px/1 system-ui, sans-serif';
  return s;
};

const glued = (...kids: (HTMLElement | SVGElement)[]): HTMLElement => {
  const w = document.createElement('span');
  w.style.display = 'inline-flex';
  w.style.alignItems = 'center';
  w.style.gap = '2px';
  for (const k of kids) w.appendChild(k);
  return w;
};

// Показуємо крапку (4.1), промовляємо кому (4,1) — так її читає українська озвучка.
const shown = (v: number): string => v.toFixed(1);
const spoken = (v: number): string => v.toFixed(1).replace('.', ',');

const FAILURE_LABEL: Record<FailureReason, string> = {
  blocked: 'Не вдалося перевірити: Untappd не відповів',
  network: 'Не вдалося перевірити: не було звʼязку',
  server: 'Не вдалося перевірити: сервер не відповів',
  unparsed: 'Не змогли розібрати цю картку',
};

function foundLabel(s: Extract<CardState, { kind: 'found' }>): string {
  const head = s.unsure ? 'Непевний збіг. ' : '';
  if (s.drunk) {
    if (s.mine !== null) return `${head}Ти це пив. Твоя оцінка ${spoken(s.mine)}`;
    // «Оцінки не ставив» можна стверджувати лише там, де сервер справді дивився: при
    // непевному збігу `match-list.ts` не віддає особистої оцінки взагалі (user_rating
    // тільки для exact), тож відсутність числа не доводить, що людина не оцінювала.
    if (s.unsure) {
      return s.global !== null
        ? `${head}Схоже, ти це пив. Глобальна оцінка ${spoken(s.global)}`
        : `${head}Схоже, ти це пив. Оцінок на Untappd поки замало`;
    }
    if (s.global !== null) {
      return `${head}Ти це пив, але оцінки не ставив. Глобальна оцінка ${spoken(s.global)}`;
    }
    return `${head}Ти це пив. Ані твоєї, ані глобальної оцінки нема`;
  }
  return s.global !== null
    ? `${head}Ти це не пив. Глобальна оцінка ${spoken(s.global)}`
    : `${head}Ти це не пив. Оцінок на Untappd поки замало`;
}

interface BadgeShape {
  quiet: boolean;
  unsure: boolean;
  href: string | null;
  label: string;
  title: string | null;
}

function buildBadge(parts: (HTMLElement | SVGElement)[], shape: BadgeShape): HTMLElement {
  const badge = document.createElement('div');
  badge.setAttribute(BADGE_MARKER, '');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', shape.label);
  if (shape.title !== null) badge.setAttribute('title', shape.title);
  Object.assign(badge.style, {
    position: 'absolute',
    top: '4px',
    right: '4px',
    zIndex: '2147483647',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: shape.quiet ? 'rgba(20,20,20,0.62)' : 'rgba(20,20,20,0.82)',
    color: shape.quiet ? '#cfd4da' : '#fff',
    font: '600 12px/1 system-ui, sans-serif',
    // Пунктирна рамка з'їдає піксель усередині — padding компенсує, щоб пігулка
    // непевного збігу не стрибала в розмірі проти певного.
    padding: shape.unsure ? '2px 5px' : '3px 6px',
    border: shape.unsure ? '1px dashed rgba(255,255,255,0.8)' : 'none',
    borderRadius: '6px',
    boxSizing: 'border-box',
    // A badge with `pointer-events: none` is never a hit target, so the browser never
    // renders its `title` tooltip — which would have made the tooltip dead in exactly
    // the two states that set one. A sighted mouse user has no other way to learn what
    // a grey reload arrow means; `aria-label` serves only the screen reader.
    pointerEvents: shape.href !== null || shape.title !== null ? 'auto' : 'none',
    cursor: shape.href !== null ? 'pointer' : 'default',
  } as Partial<CSSStyleDeclaration>);
  for (const p of parts) badge.appendChild(p);
  if (shape.href !== null) wireBadgeClicks(badge, shape.href);
  return badge;
}

export function renderState(host: HTMLElement, state: CardState): void {
  const parts: (HTMLElement | SVGElement)[] = [];
  let quiet = false;
  let unsure = false;
  let href: string | null = null;
  let title: string | null = null;
  let label: string;

  switch (state.kind) {
    case 'queued':
      quiet = true;
      parts.push(icon('ring'));
      label = 'Чекає черги';
      break;
    case 'working':
      parts.push(spinning(icon('arc')));
      label = 'Шукаємо це пиво';
      break;
    case 'nonBeer':
      quiet = true;
      parts.push(icon('cross'));
      label = 'Не пиво';
      break;
    case 'deferred':
      quiet = true;
      parts.push(icon('reload'));
      label = 'Не встигли: ліміт пошуків на сторінку. Перезавантаж сторінку';
      title = label;
      break;
    case 'failed':
      parts.push(icon('warn'));
      label = FAILURE_LABEL[state.reason];
      title = label;
      break;
    case 'missing':
      parts.push(icon('search'));
      href = untappdSearchUrl(state.brewery, state.name);
      label = state.orphan
        ? 'Пиво є в каталозі, але сторінки на Untappd нема. Клік відкриє пошук'
        : 'На Untappd не знайшли. Клік відкриє пошук';
      break;
    case 'found':
      unsure = state.unsure;
      href = hrefFor(state.untappdId, state.brewery, state.name);
      if (state.drunk) {
        parts.push(icon('check', COLOUR_DRUNK));
        if (unsure) parts.push(questionMark());
        if (state.mine !== null) parts.push(numberSpan(shown(state.mine)));
        else if (state.global !== null) {
          parts.push(glued(icon('star', COLOUR_RATING), numberSpan(shown(state.global))));
        }
      } else {
        parts.push(icon('star', COLOUR_RATING));
        if (unsure) parts.push(questionMark());
        if (state.global !== null) parts.push(numberSpan(shown(state.global)));
      }
      label = foundLabel(state);
      break;
  }

  attach(host, buildBadge(parts, { quiet, unsure, href, label, title }));
}
