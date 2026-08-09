// Fixture capture targets. Selectors are copied from each adapter's own CARD_SELECTOR
// and the URLs from the canonical link inside the fixture they replace, so a re-capture
// reproduces the same page the tests were written against.
export interface CaptureTarget {
  /** CLI name, also the --parse selector. */
  name: string;
  url: string;
  /** Adapter's own card selector — used to count cards for the guard. */
  cardSelector: string;
  /** Extra scroll+wait passes after networkidle, for shops that hydrate lazily. */
  scrolls?: number;
  /** Fixture filename under extension/tests/fixtures/. */
  out: string;
  /** SiteAdapter.id, for --parse. */
  adapter: string;
}

export const CAPTURE_TARGETS: CaptureTarget[] = [
  {
    name: 'flasker.block',
    url: 'https://flasker.com.ua/',
    cardSelector: 'li.wc-block-grid__product',
    out: 'flasker.block.html',
    adapter: 'flasker',
  },
  {
    name: 'onemorebeer',
    url: 'https://onemorebeer.pl/piwa',
    cardSelector: '.one-product-list-view__tile',
    scrolls: 4,
    out: 'onemorebeer.html',
    adapter: 'onemorebeer',
  },
  {
    name: 'beerfreak',
    url: 'https://beerfreak.org/beer/',
    cardSelector: '.catalogCard.j-catalog-card',
    out: 'beerfreak.html',
    adapter: 'beerfreak',
  },
  {
    name: 'funkyshop',
    url: 'https://funkyshop.pl/pl/4-piwo-rzemieslnicze',
    cardSelector: 'article.product-miniature',
    out: 'funkyshop.html',
    adapter: 'funkyshop',
  },
  {
    name: 'winetime',
    url: 'https://winetime.com.ua/ua/napoyi-slaboalkogolni/pyvo',
    cardSelector: 'a.product-micro',
    out: 'winetime.html',
    adapter: 'winetime',
  },
];

// A shop behind a challenge page renders zero cards, and a partial hydration renders a
// handful — both would silently replace a good fixture with a useless one. Refuse both;
// --force exists for a genuine catalogue shrink.
export function shouldWriteFixture(
  prevCount: number | null,
  nextCount: number,
  force: boolean,
): { ok: boolean; reason: string } {
  if (nextCount === 0) {
    return { ok: false, reason: 'captured 0 cards — empty, blocked, or a challenge page' };
  }
  if (prevCount !== null && nextCount * 2 < prevCount && !force) {
    return {
      ok: false,
      reason: `captured ${nextCount} cards vs ${prevCount} in the existing fixture (<50%) — pass --force to accept`,
    };
  }
  return { ok: true, reason: `captured ${nextCount} cards` };
}
