export interface Card {
  el: HTMLElement;
  brewery: string;
  name: string;
  abv?: number;
  skip?: boolean;
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
  /**
   * Optional bounded detail hydration for fields that are absent from listing cards.
   * Called only for uncached cards before they are sent to /match.
   */
  loadCardDetails?(cards: Card[]): Promise<void>;
  /**
   * Optional perf scope for the re-render check — narrows where cards are
   * re-parsed. Does NOT enable re-render (that is always on). Omit it freely.
   */
  reRenderContainerSelector?: string;
}
