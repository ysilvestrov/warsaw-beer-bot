import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BADGE_MARKER, markSeen, isSeen, SEEN_MARKER, resetCard } from './badge';
import { renderState, type CardState } from './badge';

function el(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('seen marker', () => {
  it('marks and detects a processed element', () => {
    const host = document.createElement('div');
    expect(isSeen(host)).toBe(false);
    markSeen(host);
    expect(host.hasAttribute(SEEN_MARKER)).toBe(true);
    expect(isSeen(host)).toBe(true);
  });
});

describe('resetCard', () => {
  it('removes the badge and the seen marker', () => {
    const host = document.createElement('div');
    renderState(host, { kind: 'queued' });
    markSeen(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
    expect(isSeen(host)).toBe(true);

    resetCard(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(host)).toBe(false);
  });
});

// Ported from the deleted renderBadge suite: the #648 table dispatches `click` only,
// and these two paths live in wireBadgeClicks, which outlived the setters.
describe('badge click interception (#167)', () => {
  const clickable = (host: HTMLElement) => renderState(host, {
    kind: 'found', drunk: false, mine: null, global: 3.9, unsure: false,
    untappdId: 222, brewery: 'PINTA', name: 'New One',
  });

  it('suppresses mouseup before Beershop delegates card navigation', () => {
    const host = el();
    host.setAttribute('data-href', '/p/new-one');
    const navigate = vi.fn();
    const handleMouseup = (event: MouseEvent) => {
      if ((event.target as Element).closest('[data-href]')) navigate();
    };
    document.body.addEventListener('mouseup', handleMouseup);
    try {
      clickable(host);
      const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
      badge.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener('mouseup', handleMouseup);
    }
  });

  it('opens Untappd on middle-button auxclick after suppressing card navigation', () => {
    const host = el();
    host.setAttribute('data-href', '/p/new-one');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const navigate = vi.fn();
    const handleMouseup = (event: MouseEvent) => {
      if ((event.target as Element).closest('[data-href]')) navigate();
    };
    document.body.addEventListener('mouseup', handleMouseup);
    try {
      clickable(host);
      const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
      badge.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
      badge.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
      expect(navigate).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
    } finally {
      document.body.removeEventListener('mouseup', handleMouseup);
    }
  });

});

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
  const unlinkedTable: [string, CardState, string[], string][] = [
    ['queued', { kind: 'queued' }, ['ring'], 'Чекає черги'],
    ['working', { kind: 'working' }, ['arc'], 'Шукаємо це пиво'],
    ['nonBeer', { kind: 'nonBeer' }, ['cross'], 'Не пиво'],
    ['deferred', { kind: 'deferred' }, ['reload'],
      'Не встигли перевірити цього разу. Спробуй перезавантажити сторінку'],
    ['failed blocked', { kind: 'failed', reason: 'blocked' }, ['warn'],
      'Не вдалося перевірити: Untappd не відповів'],
    ['failed unparsed', { kind: 'failed', reason: 'unparsed' }, ['warn'],
      'Не змогли розібрати цю картку'],
    ['failed network', { kind: 'failed', reason: 'network' }, ['warn'],
      'Не вдалося перевірити: не було зв\u02bcязку'],
    ['failed server', { kind: 'failed', reason: 'server' }, ['warn'],
      'Не вдалося перевірити: сервер не відповів'],
  ];

  const linkedTable: [string, CardState, string[], string, string][] = [
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
      'Непевний збіг. Схоже, ти це пив. Глобальна оцінка 4,1',
      'https://untappd.com/beer/111'],
    ['found, drunk on an orphan row', found({ drunk: true, untappdId: null, global: null }), ['check'],
      'Ти це пив. Ані твоєї, ані глобальної оцінки нема',
      'https://untappd.com/search?q=PINTA%20Hazy%20Morning&type=beer'],
  ];

  it.each(unlinkedTable)('renders unlinked badge for %s', (_name, state, wantIcons, wantLabel) => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderState(host, state);
    const badge = badgeOf(host);
    expect(icons(host)).toEqual(wantIcons);
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe(wantLabel);
    expect(badge.getAttribute('title')).toBe(wantLabel);
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(open).not.toHaveBeenCalled();
  });

  it.each(linkedTable)('renders linked badge for %s and navigates on click', (_name, state, wantIcons, wantLabel, wantHref) => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderState(host, state);
    const badge = badgeOf(host);
    expect(icons(host)).toEqual(wantIcons);
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe(wantLabel);
    expect(badge.getAttribute('title')).toBe(wantLabel);
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(open).toHaveBeenCalledWith(wantHref, '_blank', 'noopener');
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

  // The drunk branch builds its own parts list, so it needs its own proof that the
  // question mark is there — a mutation that dropped it only from this branch survived
  // the table above, which pins icons and the label but not the text.
  it('marks an unsure DRUNK badge with the question mark too', () => {
    const host = el();
    renderState(host, found({ drunk: true, unsure: true, mine: 4.2 }));
    expect(badgeOf(host).textContent).toBe('?4.2');
    renderState(host, found({ drunk: true, unsure: true, global: 4.1 }));
    expect(badgeOf(host).textContent).toBe('?4.1');
  });

  // The server withholds user_rating for every fuzzy match, so a missing number there
  // is our ignorance, not proof the person never rated it.
  it('never claims you left a beer unrated when the match itself is unsure', () => {
    const host = el();
    renderState(host, found({ drunk: true, unsure: true, global: 4.1 }));
    expect(badgeOf(host).getAttribute('aria-label'))
      .toBe('Непевний збіг. Схоже, ти це пив. Глобальна оцінка 4,1');
    renderState(host, found({ drunk: true, unsure: true, global: null }));
    expect(badgeOf(host).getAttribute('aria-label'))
      .toBe('Непевний збіг. Схоже, ти це пив. Оцінок на Untappd поки замало');
  });

  // §4.1: everything that is not a choice recedes. Nothing asserted the pill itself,
  // so deleting every `quiet = true` left the suite green.
  it('keeps the non-signal states quiet: a dimmer pill and dimmer ink', () => {
    const host = el();
    const quiet: CardState[] = [
      { kind: 'queued' }, { kind: 'deferred' }, { kind: 'nonBeer' },
    ];
    for (const state of quiet) {
      renderState(host, state);
      expect(badgeOf(host).style.background).toBe('rgba(20, 20, 20, 0.62)');
      expect(badgeOf(host).style.color).toBe('rgb(207, 212, 218)');
    }
    renderState(host, found({ global: 4.1 }));
    expect(badgeOf(host).style.background).toBe('rgba(20, 20, 20, 0.82)');
    expect(badgeOf(host).style.color).toBe('rgb(255, 255, 255)');
  });

  it('lets every badge receive a hover tooltip without making passive states clickable', () => {
    const host = el();
    for (const state of [
      { kind: 'queued' } as CardState,
      { kind: 'working' } as CardState,
      { kind: 'nonBeer' } as CardState,
      { kind: 'deferred' } as CardState,
      { kind: 'failed', reason: 'network' } as CardState,
    ]) {
      renderState(host, state);
      const badge = badgeOf(host);
      expect(badge.getAttribute('title')).toBe(badge.getAttribute('aria-label'));
      expect(badge.style.pointerEvents).toBe('auto');
      expect(badge.style.cursor).toBe('default');
    }
  });

  // Host shops ship resets like `svg { width: 100% }` and `svg path { fill: currentColor }`.
  // Presentation attributes lose to those; inline styles do not.
  it('pins icon size and paint in inline style, out of reach of shop CSS', () => {
    const host = el();
    renderState(host, { kind: 'queued' });
    const glyph = badgeOf(host).querySelector('[data-icon="ring"]') as SVGElement;
    expect(glyph.style.getPropertyValue('width')).toBe('12px');
    expect(glyph.style.getPropertyPriority('width')).toBe('important');
    const ring = glyph.firstElementChild as SVGElement;
    expect(ring.style.getPropertyValue('fill')).toBe('none');
    expect(ring.style.getPropertyPriority('fill')).toBe('important');
    expect(ring.getAttribute('fill')).toBeNull();
  });

  it('cancels the outgoing badge animations instead of leaving them running detached', () => {
    const host = el();
    const cancel = vi.fn();
    withSpinnerEnv(false, () => {
      renderState(host, { kind: 'working' });
      const badge = badgeOf(host) as HTMLElement & { getAnimations?: unknown };
      badge.getAnimations = () => [{ cancel } as unknown as Animation];
      renderState(host, found({ global: 4.1 }));
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  it('colours only the check and the star', () => {
    const host = el();
    renderState(host, found({ drunk: true, mine: 4.2 }));
    expect((badgeOf(host).querySelector('[data-icon="check"]') as HTMLElement).style.color)
      .toBe('rgb(99, 217, 153)');

    renderState(host, found({ global: 4.1 }));
    expect((badgeOf(host).querySelector('[data-icon="star"]') as HTMLElement).style.color)
      .toBe('rgb(255, 194, 77)');

    const colourless: CardState[] = [
      { kind: 'nonBeer' },
      { kind: 'failed', reason: 'network' },
      { kind: 'deferred' },
      { kind: 'missing', brewery: 'a', name: 'b', orphan: false },
    ];
    for (const state of colourless) {
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

  // jsdom provides NEITHER window.matchMedia NOR Element.animate, so both are defined
  // here and put back afterwards — otherwise every later test in the file inherits a
  // fake the suite never asked for. That jsdom lacks matchMedia is also why the guard
  // in `spinning` is load-bearing and not defensive noise.
  function withSpinnerEnv(reduceMotion: boolean | 'absent', body: (animate: () => void) => void): void {
    const w = window as unknown as { matchMedia?: unknown };
    const proto = SVGElement.prototype as unknown as { animate?: unknown };
    const hadMm = Object.prototype.hasOwnProperty.call(w, 'matchMedia');
    const prevMm = w.matchMedia;
    const hadAnim = Object.prototype.hasOwnProperty.call(proto, 'animate');
    const prevAnim = proto.animate;
    const animate = vi.fn();
    if (reduceMotion !== 'absent') {
      w.matchMedia = (q: string) => ({
        matches: reduceMotion, media: q, addEventListener() {}, removeEventListener() {},
      });
    }
    proto.animate = animate;
    try {
      body(animate);
    } finally {
      if (hadMm) w.matchMedia = prevMm;
      else delete w.matchMedia;
      if (hadAnim) proto.animate = prevAnim;
      else delete proto.animate;
    }
  }

  it('does not animate the spinner when the viewer asked for reduced motion', () => {
    const host = el();
    withSpinnerEnv(true, (animate) => {
      renderState(host, { kind: 'working' });
      expect(animate).not.toHaveBeenCalled();
    });
  });

  it('animates the spinner when reduced motion was not asked for', () => {
    const host = el();
    withSpinnerEnv(false, (animate) => {
      renderState(host, { kind: 'working' });
      expect(animate).toHaveBeenCalledTimes(1);
    });
  });

  // No matchMedia means no preference was expressed, which is not the same as asking
  // for reduced motion: the spinner still spins, and the guard only keeps the missing
  // API from throwing.
  it('still spins where matchMedia does not exist, instead of throwing', () => {
    const host = el();
    withSpinnerEnv('absent', (animate) => {
      renderState(host, { kind: 'working' });
      expect(icons(host)).toEqual(['arc']);
      expect(animate).toHaveBeenCalledTimes(1);
    });
  });
});
