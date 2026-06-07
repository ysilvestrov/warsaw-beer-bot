import type { SiteAdapter } from './types';

export const beerrepublic: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'beerrepublic.eu' || url.hostname.endsWith('.beerrepublic.eu'),
  parseCards: () => [],
};
