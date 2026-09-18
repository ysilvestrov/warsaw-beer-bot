import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderBadge, BADGE_MARKER, markSeen, isSeen, SEEN_MARKER, resetCard } from './badge';
import { setSearching, setEnriched, setOrphan, setNonBeer } from './badge';
import { renderState, type CardState } from './badge';
import type { MatchResult } from '../api/types';

function el(): HTMLElement {
  const d = document.createElement('div');
  document.body.appendChild(d);
  return d;
}

const drunk = (userRating: number | null): MatchResult => ({
  raw: { brewery: 'PINTA', name: 'Hazy Morning' },
  matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
  is_drunk: true,
  drunk_uncertain: false,
  user_rating: userRating,
  source: 'exact',
  searched: true,
});

const notDrunkRated: MatchResult = {
  raw: { brewery: 'PINTA', name: 'New One' },
  matched_beer: { id: 2, name: 'New One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 222 },
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: 'exact',
  searched: true,
};

const notDrunkOrphan: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Orphan' },
  matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: 'exact',
  searched: true,
};

const unmatched: MatchResult = {
  raw: { brewery: 'Nowhere', name: 'Ghost' },
  matched_beer: null,
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: null,
  searched: true,
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('renderBadge', () => {
  it('adds a ✅ + personal rating badge for a drunk beer', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain('✅');
    expect(badge!.textContent).toContain('4.0');
  });

  it('shows just ✅ when drunk with no personal rating', () => {
    const host = el();
    renderBadge(host, drunk(null));
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('✅');
  });

  it('adds a ⭐ + global rating badge for a not-drunk catalog beer with a bid', () => {
    const host = el();
    renderBadge(host, notDrunkRated);
    const badge = host.querySelector(`[${BADGE_MARKER}]`);
    expect(badge!.textContent).toContain('⭐');
    expect(badge!.textContent).toContain('3.9');
  });

  it('shows a clickable bare ⭐ when a catalog beer has a bid but no global rating', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderBadge(host, {
      ...notDrunkRated,
      matched_beer: { ...notDrunkRated.matched_beer!, rating_global: null },
    });

    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge?.textContent).toBe('⭐');

    badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
  });

  it('renders ⚪ for a not-drunk orphan (matched, no bid / no global rating)', () => {
    const host = el();
    renderBadge(host, notDrunkOrphan);
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⚪');
  });

  it('renders nothing for an unmatched beer', () => {
    const host = el();
    renderBadge(host, unmatched);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
  });

  it('opens the Untappd beer page on click and suppresses card navigation', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderBadge(host, notDrunkRated);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    const notPrevented = badge.dispatchEvent(evt);
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
    expect(notPrevented).toBe(false); // preventDefault() was called
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
      renderBadge(host, notDrunkRated);
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
      renderBadge(host, notDrunkRated);
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

  it('is idempotent — does not double-render', () => {
    const host = el();
    renderBadge(host, drunk(4.0));
    renderBadge(host, drunk(4.0));
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);
  });
});

const orphan: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Orphan' },
  matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
  is_drunk: false,
  drunk_uncertain: false,
  user_rating: null,
  source: 'exact',
  searched: true,
};

describe('orphan + enrichment badge states', () => {
  it('renders ⚪ for a not-drunk orphan (matched, no untappd_id)', () => {
    const host = el();
    renderBadge(host, orphan);
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⚪');
  });

  it('setSearching replaces the badge with a loading glyph; setEnriched swaps to ⭐ + opens Untappd', () => {
    const host = el();
    setOrphan(host, 'PINTA', 'Orphan');
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⚪');

    setSearching(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)!.textContent).toBe('⏳');
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`).length).toBe(1);

    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    setEnriched(host, 222, 3.9);
    const badge = host.querySelector(`[${BADGE_MARKER}]`)!;
    expect(badge.textContent).toContain('⭐');
    expect(badge.textContent).toContain('3.9');
    (badge as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
  });
});

describe('non-beer badge (#615)', () => {
  it('preserves an already-correct non-beer badge element', () => {
    const host = el();
    setNonBeer(host);
    const badge = host.querySelector(`[${BADGE_MARKER}]`);

    setNonBeer(host);

    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBe(badge);
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`)).toHaveLength(1);
  });

  it.each(['text', 'role', 'label'])('replaces a badge with incorrect %s', (field) => {
    const host = el();
    setNonBeer(host);
    const previous = host.querySelector(`[${BADGE_MARKER}]`)!;
    if (field === 'text') previous.textContent = '⚪';
    if (field === 'role') previous.removeAttribute('role');
    if (field === 'label') previous.setAttribute('aria-label', 'Other');

    setNonBeer(host);

    const badge = host.querySelector(`[${BADGE_MARKER}]`)!;
    expect(badge).not.toBe(previous);
    expect(badge.textContent).toBe('✕');
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Не пиво');
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`)).toHaveLength(1);
  });

  it('renders a red accessible ✕ without an Untappd action', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    setNonBeer(host);
    setNonBeer(host); // repeated rendering stays idempotent

    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge.textContent).toBe('✕');
    expect(badge.getAttribute('role')).toBe('img');
    expect(badge.getAttribute('aria-label')).toBe('Не пиво');
    expect(badge.style.color).toBe('rgb(255, 107, 107)');
    expect(badge.style.pointerEvents).toBe('none');
    expect(badge.style.cursor).toBe('default');
    expect(badge.tabIndex).toBe(-1);
    expect(host.querySelectorAll(`[${BADGE_MARKER}]`)).toHaveLength(1);

    badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    badge.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(open).not.toHaveBeenCalled();
  });
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
  it('resetCard removes the badge and the seen marker', () => {
    const host = document.createElement('div');
    renderBadge(host, { is_drunk: true, drunk_uncertain: false, user_rating: 4, source: null, searched: true, raw: { brewery: 'b', name: 'n' }, matched_beer: null });
    markSeen(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).not.toBeNull();
    expect(isSeen(host)).toBe(true);

    resetCard(host);
    expect(host.querySelector(`[${BADGE_MARKER}]`)).toBeNull();
    expect(isSeen(host)).toBe(false);
  });
});

describe('badge click targets (#167)', () => {
  const openSpy = () => vi.spyOn(window, 'open').mockReturnValue(null);
  const clickBadge = (host: HTMLElement) => {
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return badge;
  };

  it('✅ with a bid opens the matched beer page', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'PINTA', name: 'Hazy Morning' },
      matched_beer: { id: 1, name: 'Hazy Morning', brewery: 'PINTA', rating_global: 4.1, untappd_id: 111 },
      is_drunk: true, drunk_uncertain: false, user_rating: 4.0, source: 'exact', searched: true,
    });
    const badge = clickBadge(host);
    expect(badge.style.cursor).toBe('pointer');
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/111', '_blank', 'noopener');
  });

  it('✅ on a had orphan (no bid) opens an Untappd search', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'Mad Brew', name: 'Bendera ya Uhuru' },
      matched_beer: { id: 2, name: 'Bendera ya Uhuru', brewery: 'Mad Brew', rating_global: null, untappd_id: null },
      is_drunk: true, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    });
    clickBadge(host);
    expect(open).toHaveBeenCalledWith('https://untappd.com/search?q=Mad%20Brew%20Bendera%20ya%20Uhuru&type=beer', '_blank', 'noopener');
  });

  it('⚪ orphan opens an Untappd search prefilled with brewery+name', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'PINTA', name: 'Orphan' },
      matched_beer: { id: 3, name: 'Orphan', brewery: 'PINTA', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    });
    const badge = clickBadge(host);
    expect(badge.style.cursor).toBe('pointer');
    expect(open).toHaveBeenCalledWith('https://untappd.com/search?q=PINTA%20Orphan&type=beer', '_blank', 'noopener');
  });

  it('❓ orphan (drunk_uncertain, no bid) opens an Untappd search', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'Rebrew', name: 'Fuzzy Orphan' },
      matched_beer: { id: 4, name: 'Fuzzy Orphan', brewery: 'Rebrew', rating_global: null, untappd_id: null },
      is_drunk: false, drunk_uncertain: true, user_rating: null, source: 'fuzzy', searched: true,
    });
    clickBadge(host);
    expect(open).toHaveBeenCalledWith('https://untappd.com/search?q=Rebrew%20Fuzzy%20Orphan&type=beer', '_blank', 'noopener');
  });

  it('⭐ still opens the matched beer page', () => {
    const host = el();
    const open = openSpy();
    renderBadge(host, {
      raw: { brewery: 'PINTA', name: 'New One' },
      matched_beer: { id: 5, name: 'New One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 222 },
      is_drunk: false, drunk_uncertain: false, user_rating: null, source: 'exact', searched: true,
    });
    clickBadge(host);
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/222', '_blank', 'noopener');
  });
});

// Base for spreading — always overridden with a real matched_beer per case. (The server
// never emits drunk_uncertain with matched_beer null; that combination is not rendered.)
const baseUncertain: MatchResult = {
  raw: { brewery: 'PINTA', name: 'Fuzzy One' },
  is_drunk: false,
  drunk_uncertain: true,
  user_rating: null,
  source: 'fuzzy',
  searched: true,
  matched_beer: null,
};

describe('❓ uncertain-drunk badge', () => {
  it('renders ❓ + global rating when drunk_uncertain with a bid and rating_global', () => {
    const host = el();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const result: MatchResult = {
      ...baseUncertain,
      matched_beer: { id: 5, name: 'Fuzzy One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 555 },
    };
    renderBadge(host, result);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('❓ 3.9');
    expect(badge.style.cursor).toBe('pointer');
    badge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith('https://untappd.com/beer/555', '_blank', 'noopener'); // ❓ with a bid → beer page
  });

  it('renders bare ❓ when drunk_uncertain with a bid but rating_global is null', () => {
    const host = el();
    const result: MatchResult = {
      ...baseUncertain,
      matched_beer: { id: 5, name: 'Fuzzy One', brewery: 'PINTA', rating_global: null, untappd_id: 555 },
    };
    renderBadge(host, result);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('❓');
    expect(badge.style.cursor).toBe('pointer'); // bid present → still clickable, even without a rating
  });

  it('renders bare ❓ clickable to Untappd search when drunk_uncertain but matched_beer has no untappd_id (orphan)', () => {
    const host = el();
    const result: MatchResult = {
      ...baseUncertain,
      matched_beer: { id: 5, name: 'Fuzzy One', brewery: 'PINTA', rating_global: null, untappd_id: null },
    };
    renderBadge(host, result);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('❓');
    expect(badge.style.cursor).toBe('pointer'); // no bid → search URL → still clickable
  });

  it('is_drunk wins over drunk_uncertain — renders ✅ + personal rating', () => {
    const host = el();
    const result: MatchResult = {
      ...baseUncertain,
      is_drunk: true,
      user_rating: 4.2,
      source: 'exact',
      searched: true,
      matched_beer: { id: 5, name: 'Fuzzy One', brewery: 'PINTA', rating_global: 3.9, untappd_id: 555 },
    };
    renderBadge(host, result);
    const badge = host.querySelector(`[${BADGE_MARKER}]`) as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('✅ 4.2');
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
  const table: [string, CardState, string[], string, string | null][] = [
    ['queued', { kind: 'queued' }, ['ring'], 'Чекає черги', null],
    ['working', { kind: 'working' }, ['arc'], 'Шукаємо це пиво', null],
    ['nonBeer', { kind: 'nonBeer' }, ['cross'], 'Не пиво', null],
    ['deferred', { kind: 'deferred' }, ['reload'],
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
