# #648 Ядро: стан картки як один тип і один рендер

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Зробити механізм, заради якого все робиться: один тип `CardState`, один рендер `renderState`, і чиста функція, що перекладає відповідь `/match` у цей тип.

**Architecture:** Сьогодні бейдж будується в пʼятьох незалежних місцях (`badgeFor` + `setOrphan`/`setNonBeer`/`setSearching`/`setEnriched`), і саме тому абетка розповзлася. Ядро додає поруч із ними один union і один рендер, не чіпаючи старі експорти — гейт лишається зеленим, а виклики переводить уже план на обвʼязку. Іконки малюються через `createElementNS` просто в бейджі: жодного спрайта в чужому DOM, жодного стилю поза інлайном.

**Tech Stack:** TypeScript, Vitest + jsdom, розширення для Chrome (content script, без бандлерних стилів).

**Spec:** `docs/superpowers/specs/2026-09/2026-09-18-648-card-state-badges-design.md`

## Global Constraints

- **Колір носить лише сигнал.** Кольорові лише два знаки: галочка `#63d999` і зірка `#ffc24d`. «Не пиво» і «помилка» кольору **не мають** (сьогодні ✕ червоний, а попередження бурштинове — це прибирається).
- **Колір ніде не єдиний носій змісту**: галочку від зірки відрізняє форма, а стан повністю промовляє `aria-label`.
- **Жодного нового гліфа** понад вісім: `ring`, `arc`, `check`, `star`, `search`, `reload`, `warn`, `cross`.
- **Кожен бейдж має `role="img"` і `aria-label`.** Сьогодні підпис має лише ✕.
- **Бейдж — 12px тексту й 12px іконки**, пігулка `rgba(20,20,20,0.82)`, тьмяний варіант `rgba(20,20,20,0.62)` з текстом `#cfd4da`.
- **Тільки інлайнові стилі.** Content script працює на чужій сторінці: жодного `<style>`, жодного спрайта з `id` у документі крамниці (колізії), жодного мережевого ресурсу.
- **Обертання вимикається** під `prefers-reduced-motion: reduce`.
- **Серверного контракту не чіпаємо.** `/match` уже надсилає `source` і `searched`; клієнт лише оголошує їх у типі.
- **Старі експорти `badge.ts` лишаються на місці** до плану на обвʼязку: `renderBadge`, `setOrphan`, `setNonBeer`, `setSearching`, `setEnriched`, `markSeen`, `isSeen`, `resetCard`, `BADGE_MARKER`, `SEEN_MARKER`.
- **Повний гейт на кожну задачу:** `npm test && npm run typecheck` у корені **і** `npm test && npm run typecheck` в `extension/`.

## Уточнення проти §6 спеки

У спеці варіант `found` виписано без `brewery`/`name`. Тут він їх має: випите пиво може сидіти на рядку-сироті (`untappd_id === null`), і тоді клік має вести в пошук Untappd, а для пошукового URL потрібні саме текст броварні й назви з картки. Це уточнення, а не зміна моделі; `spec.md` і документ дизайну оновлює план на обвʼязку.

---

### Task 1: `CardState` і `renderState`

**Files:**
- Modify: `extension/src/content/badge.ts`
- Test: `extension/src/content/badge.test.ts`

**Interfaces:**
- Consumes: наявні в `badge.ts` `BADGE_MARKER`, `attach`, `untappdUrl`, `untappdSearchUrl`, `hrefFor`.
- Produces:
  - `export type FailureReason = 'blocked' | 'network' | 'server' | 'unparsed'`
  - `export type CardState` (сім варіантів, нижче)
  - `export function renderState(host: HTMLElement, state: CardState): void`

- [ ] **Step 1: Write the failing test**

Додай у кінець `extension/src/content/badge.test.ts`:

```ts
import { renderState, type CardState } from './badge';

function icons(host: HTMLElement): string[] {
  const badge = host.querySelector(`[${BADGE_MARKER}]`)!;
  return [...badge.querySelectorAll('[data-icon]')].map((n) => n.getAttribute('data-icon')!);
}
function badgeOf(host: HTMLElement): HTMLElement {
  return host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
}

const found = (over: Partial<Extract<CardState, { kind: 'found' }>> = {}): CardState => ({
  kind: 'found',
  drunk: false,
  mine: null,
  global: 4.1,
  unsure: false,
  untappdId: 111,
  brewery: 'PINTA',
  name: 'Hazy Morning',
  ...over,
});

describe('#648 renderState', () => {
  const table: [string, CardState, string[], string, string | null][] = [
    ['queued',        { kind: 'queued' },  ['ring'],   'Чекає черги', null],
    ['working',       { kind: 'working' }, ['arc'],    'Шукаємо це пиво', null],
    ['nonBeer',       { kind: 'nonBeer' }, ['cross'],  'Не пиво', null],
    ['deferred',      { kind: 'deferred' }, ['reload'],
      'Не встигли: ліміт пошуків на сторінку. Перезавантаж сторінку', null],
    ['failed blocked', { kind: 'failed', reason: 'blocked' }, ['warn'],
      'Не вдалося перевірити: Untappd не відповів', null],
    ['failed unparsed', { kind: 'failed', reason: 'unparsed' }, ['warn'],
      'Не змогли розібрати цю картку', null],
    ['missing orphan', { kind: 'missing', brewery: 'PINTA', name: 'Ghost', orphan: true }, ['search'],
      'Пиво є в каталозі, але сторінки на Untappd нема. Клік відкриє пошук',
      'https://untappd.com/search?q=PINTA%20Ghost&type=beer'],
    ['missing absent', { kind: 'missing', brewery: 'PINTA', name: 'Ghost', orphan: false }, ['search'],
      'На Untappd не знайшли. Клік відкриє пошук',
      'https://untappd.com/search?q=PINTA%20Ghost&type=beer'],
    ['found, not drunk, rated', found(), ['star'],
      'Ти це не пив. Глобальна оцінка 4,1', 'https://untappd.com/beer/111'],
    ['found, not drunk, unrated', found({ global: null }), ['star'],
      'Ти це не пив. Оцінок на Untappd поки замало', 'https://untappd.com/beer/111'],
    ['found, drunk, own rating', found({ drunk: true, mine: 4.2 }), ['check'],
      'Ти це пив. Твоя оцінка 4,2', 'https://untappd.com/beer/111'],
    ['found, drunk, no own rating', found({ drunk: true }), ['check', 'star'],
      'Ти це пив, але оцінки не ставив. Глобальна оцінка 4,1', 'https://untappd.com/beer/111'],
    ['found, drunk, no rating at all', found({ drunk: true, global: null }), ['check'],
      'Ти це пив. Ані твоєї, ані глобальної оцінки нема', 'https://untappd.com/beer/111'],
    ['found, unsure', found({ drunk: true, unsure: true }), ['check', 'star'],
      'Непевний збіг. Ти це пив, але оцінки не ставив. Глобальна оцінка 4,1',
      'https://untappd.com/beer/111'],
    ['found, drunk on an orphan row', found({ drunk: true, untappdId: null, global: null }), ['check'],
      'Ти це пив. Ані твоєї, ані глобальної оцінки нема',
      'https://untappd.com/search?q=PINTA%20Hazy%20Morning&type=beer'],
  ];

  it.each(table)('%s', (_name, state, wantIcons, wantLabel, wantHref) => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderState(host, state);
    const badge = badgeOf(host);
    expect(icons(host)).toEqual(wantIcons);
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe(wantLabel);
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (wantHref === null) expect(open).not.toHaveBeenCalled();
    else expect(open).toHaveBeenCalledWith(wantHref, '_blank', 'noopener');
  });

  it('shows the rating number with a dot, and only when there is one', () => {
    const host = el();
    renderState(host, found({ global: 4.1 }));
    expect(badgeOf(host).textContent).toBe('4.1');
    renderState(host, found({ global: null }));
    expect(badgeOf(host).textContent).toBe('');
  });

  it('marks an unsure badge with a dashed border and a question mark', () => {
    const host = el();
    renderState(host, found({ unsure: true, global: 4.1 }));
    const badge = badgeOf(host);
    expect(badge.style.border).toContain('dashed');
    expect(badge.textContent).toBe('?4.1');
  });

  it('colours only the check and the star', () => {
    const host = el();
    renderState(host, found({ drunk: true, mine: 4.2 }));
    expect((badgeOf(host).querySelector('[data-icon="check"]') as HTMLElement).style.color)
      .toBe('rgb(99, 217, 153)');

    renderState(host, found({ global: 4.1 }));
    expect((badgeOf(host).querySelector('[data-icon="star"]') as HTMLElement).style.color)
      .toBe('rgb(255, 194, 77)');

    for (const state of [
      { kind: 'nonBeer' } as CardState,
      { kind: 'failed', reason: 'network' } as CardState,
      { kind: 'deferred' } as CardState,
      { kind: 'missing', brewery: 'a', name: 'b', orphan: false } as CardState,
    ]) {
      renderState(host, state);
      const glyph = badgeOf(host).querySelector('[data-icon]') as HTMLElement;
      expect(glyph.style.color).toBe('');
    }
  });

  it('replaces the previous badge instead of stacking, so a transition is visible', () => {
    const host = el();
    renderState(host, { kind: 'queued' });
    renderState(host, { kind: 'working' });
    renderState(host, found({ global: 4.1 }));
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`)).toHaveLength(1);
    expect(icons(host)).toEqual(['star']);
  });

  it('does not animate the spinner when the viewer asked for reduced motion', () => {
    const host = el();
    vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({
      matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {},
    })) as unknown as typeof window.matchMedia);
    const animate = vi.fn();
    // jsdom has no Element.animate, so define it — and put the prototype back, or every
    // later test in the file inherits a fake the suite never asked for.
    const proto = SVGElement.prototype as unknown as { animate?: unknown };
    const had = Object.prototype.hasOwnProperty.call(proto, 'animate');
    const previous = proto.animate;
    proto.animate = animate;
    try {
      renderState(host, { kind: 'working' });
      expect(animate).not.toHaveBeenCalled();
    } finally {
      if (had) proto.animate = previous;
      else delete proto.animate;
    }
  });

  it('animates the spinner when reduced motion was not asked for', () => {
    const host = el();
    vi.spyOn(window, 'matchMedia').mockImplementation(((q: string) => ({
      matches: false, media: q, addEventListener() {}, removeEventListener() {},
    })) as unknown as typeof window.matchMedia);
    const animate = vi.fn();
    const proto = SVGElement.prototype as unknown as { animate?: unknown };
    const had = Object.prototype.hasOwnProperty.call(proto, 'animate');
    const previous = proto.animate;
    proto.animate = animate;
    try {
      renderState(host, { kind: 'working' });
      expect(animate).toHaveBeenCalledTimes(1);
    } finally {
      if (had) proto.animate = previous;
      else delete proto.animate;
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd extension && npx vitest run src/content/badge.test.ts`
Expected: FAIL — `renderState` is not exported from `./badge`.

- [ ] **Step 3: Implement**

Додай у `extension/src/content/badge.ts`. Нічого наявного не видаляй і не перейменовуй.

```ts
// ── #648: один стан картки — один бейдж ──────────────────────────────────────
// Раніше бейдж будувався в пʼятьох місцях незалежно, і набір гліфів ніхто не бачив
// цілком. Тепер абетка живе в одному union: додати шостий гліф тихо вже не вийде.

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

// Колір носить лише сигнал: це єдині дві картки, між якими людина обирає.
// Форма (галочка проти зірки) каже те саме без кольору — для монохрому й дальтонізму.
const COLOUR_DRUNK = '#63d999';
const COLOUR_RATING = '#ffc24d';

function icon(name: IconName, colour?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('data-icon', name);
  svg.style.display = 'block';
  svg.style.flex = 'none';
  if (colour) svg.style.color = colour;
  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
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
    pointerEvents: shape.href !== null ? 'auto' : 'none',
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
```

Клік-слухачі вже написані всередині `makeBadge`. Винеси їх у функцію, щоб `buildBadge` використовував ті самі: заміни тіло `if (href != null) { … }` у `makeBadge` на виклик `wireBadgeClicks(badge, href)` і додай поруч

```ts
// Beershop перехоплює навігацію картки на mouseup, до click — тому глушимо всі три.
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
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `cd extension && npx vitest run src/content/badge.test.ts`
Expected: PASS, і всі наявні тести `badge.test.ts` теж зелені — старі експорти не мінялися.

- [ ] **Step 5: Mutation-prove the table, one mutation per branch**

Це не формальність: на #636 таблиця мутацій на сім правил пропустила тринадцять живих мутацій, бо писалася по заголовках, а не по гілках. Тут по одній мутації на кожну гілку, і кожна має **впасти**:

| Мутація | Має впасти на |
|---|---|
| в `renderState` для `found` + `drunk` прибрати `icon('check', COLOUR_DRUNK)` | «found, drunk, own rating» |
| поміняти `COLOUR_DRUNK` і `COLOUR_RATING` місцями | «colours only the check and the star» |
| дати колір `icon('cross')` | «colours only the check and the star» |
| у гілці `drunk` віддати `state.global` перед `state.mine` | «found, drunk, own rating» |
| прибрати `glued(...)` і пушити саме число | «found, drunk, no own rating» |
| прибрати `if (unsure) parts.push(questionMark())` | «marks an unsure badge…» |
| прибрати `border` з `buildBadge` | «marks an unsure badge…» |
| у `missing` завжди віддавати підпис не-сироти | «missing orphan» |
| прибрати `title` у `deferred` | (навмисно не покрито — див. нижче) |
| в `attach` не знімати попередній бейдж | «replaces the previous badge…» |
| прибрати перевірку `reduce` у `spinning` | «does not animate the spinner…» |
| ніколи не кликати `animate` у `spinning` | «animates the spinner when reduced motion was not asked for» |
| повернути `shown` з комою замість крапки | «shows the rating number with a dot…» |
| повернути `spoken` з крапкою замість коми | будь-який рядок таблиці з оцінкою |

Рядок про `title` у `deferred` лишається непокритим навмисно: `title` дублює `aria-label`, і тест на нього перевіряв би копію рядка, а не поведінку. Якщо котрась мутація **не** валить тест — допиши тест, а не викреслюй мутацію.

- [ ] **Step 6: Full gate**

```bash
cd extension && npm test && npm run typecheck
cd .. && npm test && npm run typecheck
```
Expected: усе зелене.

- [ ] **Step 7: Commit**

```bash
git add extension/src/content/badge.ts extension/src/content/badge.test.ts
git commit -m "feat(#648): one CardState union and one renderState behind the old badge setters"
```

---

### Task 2: `stateFromMatch` — відповідь `/match` стає станом

**Files:**
- Modify: `extension/src/api/types.ts`
- Create: `extension/src/content/card-state.ts`
- Test: `extension/src/content/card-state.test.ts`

**Interfaces:**
- Consumes: `CardState` з `./badge` (Task 1), `MatchResult` з `../api/types`.
- Produces: `export function stateFromMatch(result: MatchResult, opts: { enrichmentPossible: boolean }): CardState`

- [ ] **Step 1: Write the failing test**

Створи `extension/src/content/card-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { stateFromMatch } from './card-state';
import type { MatchResult } from '../api/types';

const base: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: 'exact',
  searched: true,
};
const r = (over: Partial<MatchResult>): MatchResult => ({ ...base, ...over });
const orphanRow = { id: 2, name: 'Ghost', brewery: 'PINTA', rating_global: null, untappd_id: null };

const noEnrich = { enrichmentPossible: false };
const withEnrich = { enrichmentPossible: true };

describe('#648 stateFromMatch', () => {
  it('a linked row is found, and an exact match is not unsure', () => {
    expect(stateFromMatch(base, withEnrich)).toEqual({
      kind: 'found', drunk: false, mine: null, global: 4.1, unsure: false,
      untappdId: 111, brewery: 'PINTA', name: 'Hazy Morning',
    });
  });

  it('a fuzzy match is unsure even though nothing else changes', () => {
    const s = stateFromMatch(r({ source: 'fuzzy' }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', unsure: true });
  });

  it('carries the personal rating only, never the global one, when both exist', () => {
    const s = stateFromMatch(r({ is_drunk: true, user_rating: 4.2 }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', drunk: true, mine: 4.2, global: 4.1 });
  });

  it('treats drunk_uncertain as drunk AND unsure', () => {
    const s = stateFromMatch(r({ drunk_uncertain: true, source: 'fuzzy' }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', drunk: true, unsure: true });
  });

  it('a drunk beer on an orphan row is still found, with no bid to click', () => {
    const s = stateFromMatch(r({ matched_beer: orphanRow, is_drunk: true }), withEnrich);
    expect(s).toMatchObject({ kind: 'found', drunk: true, untappdId: null });
  });

  // Сирота в черзі — це ще не вердикт: питання відкрите, доки дошук не відповів.
  it('an undrunk orphan row is queued while enrichment can still run', () => {
    expect(stateFromMatch(r({ matched_beer: orphanRow }), withEnrich)).toEqual({ kind: 'queued' });
  });

  it('an undrunk orphan row is missing when enrichment cannot run', () => {
    expect(stateFromMatch(r({ matched_beer: orphanRow }), noEnrich)).toEqual({
      kind: 'missing', brewery: 'PINTA', name: 'Hazy Morning', orphan: true,
    });
  });

  it('nothing matched but we DID look: missing', () => {
    expect(stateFromMatch(r({ matched_beer: null }), noEnrich)).toEqual({
      kind: 'missing', brewery: 'PINTA', name: 'Hazy Morning', orphan: false,
    });
  });

  // Це і є різниця, якої сьогодні не видно: «нема» проти «ми не дивилися».
  it('nothing matched and we never looked: deferred, not missing', () => {
    expect(stateFromMatch(r({ matched_beer: null, searched: false }), noEnrich))
      .toEqual({ kind: 'deferred' });
  });

  it('an unsearched card is still queued while enrichment can run', () => {
    expect(stateFromMatch(r({ matched_beer: null, searched: false }), withEnrich))
      .toEqual({ kind: 'queued' });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd extension && npx vitest run src/content/card-state.test.ts`
Expected: FAIL — файла `./card-state` нема, і `MatchResult` не має полів `source`/`searched`.

- [ ] **Step 3: Declare the two fields the server already sends**

У `extension/src/api/types.ts` заміни інтерфейс `MatchResult` на:

```ts
export interface MatchResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  drunk_uncertain: boolean;
  user_rating: number | null;
  /**
   * #648: сервер надсилав ці два поля завжди (src/api/routes/match.ts віддає повний
   * MatchListResult), а клієнт їх не оголошував — і мовчки викидав. `source: 'fuzzy'`
   * — єдине джерело непевності, зокрема для суперечливого bid із крамниці (#633).
   */
  source: 'exact' | 'fuzzy' | null;
  /** false — бюджет повнокаталожного фолбеку (#279) відмовив цій позиції в пошуку. */
  searched: boolean;
}
```

- [ ] **Step 4: Implement the mapper**

Створи `extension/src/content/card-state.ts`:

```ts
import type { CardState } from './badge';
import type { MatchResult } from '../api/types';

/**
 * #648: відповідь `/match` → стан картки.
 *
 * Два розрізнення, які легко зліпити й які ламають модель, якщо зліпити:
 *  • «не знайшли» проти «не встигли» розводить `searched`, а не `matched_beer`:
 *    в обох `matched_beer === null`, різниця в тому, чи ми взагалі дивилися;
 *  • сирота в черзі — це `queued`, а не `missing`: рядок є, але питання ще відкрите.
 *    Вердиктом воно стане, коли відповість дошук.
 *
 * `enrichmentPossible` — чи ця картка взагалі поїде в чергу дошуку. Знає це викликач:
 * дошук вимикається опцією, відсутнім токеном і правилом «випите не перелінковуємо».
 */
export function stateFromMatch(
  result: MatchResult,
  opts: { enrichmentPossible: boolean },
): CardState {
  const { brewery, name } = result.raw;
  const matched = result.matched_beer;
  // drunk_uncertain — це fuzzy-збіг на випите пиво, тож він тягне обидві ознаки.
  const drunk = result.is_drunk || result.drunk_uncertain;
  const unsure = result.source === 'fuzzy' || result.drunk_uncertain;

  if (matched !== null && (matched.untappd_id !== null || drunk)) {
    return {
      kind: 'found',
      drunk,
      mine: result.user_rating,
      global: matched.rating_global,
      unsure,
      untappdId: matched.untappd_id,
      brewery,
      name,
    };
  }
  if (opts.enrichmentPossible) return { kind: 'queued' };
  if (matched !== null) return { kind: 'missing', brewery, name, orphan: true };
  return result.searched
    ? { kind: 'missing', brewery, name, orphan: false }
    : { kind: 'deferred' };
}
```

- [ ] **Step 5: Fix the fixtures the new required fields break**

`source` і `searched` тепер обовʼязкові, тож кожен літерал `MatchResult` у тестах без них перестане компілюватися. Знайди їх і додай `source: 'exact', searched: true` (для незматчених — `source: null, searched: true`):

```bash
cd extension && npx tsc --noEmit
```
Виправ рівно те, на що вкаже компілятор — здебільшого `src/content/badge.test.ts`, `src/content/index.test.ts`, `src/cache/store.test.ts`. Значень існуючих полів не чіпай: тести доводять свою поведінку, а не цю.

- [ ] **Step 6: Run the test and watch it pass**

Run: `cd extension && npx vitest run src/content/card-state.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation-prove the mapper**

| Мутація | Має впасти на |
|---|---|
| прибрати `|| drunk` з умови `found` | «a drunk beer on an orphan row…» |
| прибрати `|| result.drunk_uncertain` з `unsure` | «treats drunk_uncertain as drunk AND unsure» |
| прибрати `|| result.drunk_uncertain` з `drunk` | «treats drunk_uncertain as drunk AND unsure» |
| віддати `matched.rating_global` в `mine` | «carries the personal rating only…» |
| повернути `missing` замість `queued` при `enrichmentPossible` | «an undrunk orphan row is queued…» |
| ігнорувати `searched` і завжди віддавати `missing` | «nothing matched and we never looked…» |
| віддати `orphan: false` у гілці з рядком | «an undrunk orphan row is missing when enrichment cannot run» |

- [ ] **Step 8: Full gate**

```bash
cd extension && npm test && npm run typecheck
cd .. && npm test && npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add extension/src/api/types.ts extension/src/content/card-state.ts extension/src/content/card-state.test.ts extension/src/content/*.test.ts extension/src/cache/*.test.ts
git commit -m "feat(#648): map a /match result onto CardState; declare the source and searched the server already sends"
```

---

## Після ядра

Наскрізне рев'ю всієї гілки — і лише після нього пишеться план на обвʼязку. У ньому:

- переходи в `content/index.ts`: бейдж «в черзі» **до** кеш-лукапу, «працюємо» на час `/match`, `failed` замість мовчазного `return`;
- переходи в `content/enrich.ts`: `working` на час пошуку, `deferred` на залишку за `MAX_SEARCHES_PER_PAGE`, `failed` для `blocked`/`transient`/`catch`;
- розклад `card.skip` на три поняття (§5.2 спеки) по адаптерах;
- видалення `renderBadge`, `setOrphan`, `setNonBeer`, `setSearching`, `setEnriched` і їхніх тестів;
- `spec.md`, `docs/extension-install-uk.md` **і** `-en.md`, `docs/cws-listing.md`, скриншоти CWS, рядок у `extension/CHANGELOG.md` користувацькою мовою;
- уточнення §6 документа дизайну: варіант `found` несе `brewery`/`name`.

Реліз розширення — спільний із #666 і #667: без #666 бейдж «не встигли, перезавантаж» бреше.
