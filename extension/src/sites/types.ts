export interface Card {
  el: HTMLElement;
  brewery: string;
  name: string;
  abv?: number;
}

export interface SiteAdapter {
  hostMatch(url: URL): boolean;
  parseCards(root: ParentNode): Card[];
  /** Optional: resolve once the (client-rendered) grid has painted cards. */
  waitForGrid?(root: ParentNode): Promise<void>;
  /** Optional: container whose child mutations signal an SPA page change (re-render observer). */
  reRenderContainerSelector?: string;
}
