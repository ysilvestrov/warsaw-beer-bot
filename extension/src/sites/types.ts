export interface Card {
  el: HTMLElement;
  brewery: string;
  name: string;
  abv?: number;
  /** Shop-published style, relayed to /enrich/* for orphan rows (#369). Not sent to /match. */
  style?: string;
  /** #384: Untappd beer id the shop publishes on its product page. */
  bid?: number;
  /** #384: the slug published alongside `bid`; server-side integrity signal. */
  bidSlug?: string;
  /** Product-page brand used to verify a published bid; may differ from parsed brewery. */
  brand?: string;
  /**
   * The card cannot go to /match as it stands. Why decides what the user sees (#648):
   * without a reason the overlay can only guess, and used to guess "draw nothing".
   */
  skip?: boolean;
  /**
   * #648: why `skip` is set.
   *  • `pending-detail` — the product page decides; while it is in flight the card reads
   *    as "working", and if `skip` survives the hydration pass the detail failed.
   *  • `unparsed` — the title never parsed, or the detail page carried no brewery. No
   *    later pass will fix it; the card says so instead of vanishing.
   */
  skipReason?: 'pending-detail' | 'unparsed';
  /** Shop-confirmed non-beer; renders a status badge and never reaches /match. */
  nonBeer?: boolean;
}

export interface SiteAdapter {
  /** Stable, unique adapter id; also the fixture name: tests/fixtures/<id>.html. */
  id: string;
  hostMatch(url: URL): boolean;
  parseCards(root: ParentNode): Card[];
  /**
   * Optional: true when this URL is a whole non-beer category page (e.g. accessories,
   * delicatessen/soft-drinks) whose products carry no usable beer signal. The overlay skips
   * the page entirely. Per-product non-beers are handled in parseCards instead.
   */
  isNonBeerPage?(url: URL): boolean;
  /** Optional: resolve once the (client-rendered) grid has painted cards. */
  waitForGrid?(root: ParentNode): Promise<void>;
  /** Hydrate all cards before cache lookup when details determine eligibility. */
  loadDetailsBeforeCache?: boolean;
  /**
   * Optional detail hydration for fields that are absent from listing cards.
   * Called for all cards before cache lookup when loadDetailsBeforeCache is true;
   * otherwise called only for uncached cards before they are sent to /match.
   */
  loadCardDetails?(cards: Card[]): Promise<void>;
  /**
   * Optional perf scope for the re-render check — narrows where cards are
   * re-parsed. Does NOT enable re-render (that is always on). Omit it freely.
   */
  reRenderContainerSelector?: string;
}
