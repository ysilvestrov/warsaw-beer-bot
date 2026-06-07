import type { SiteAdapter } from './types';

export const onemorebeer: SiteAdapter = {
  hostMatch: (url) => url.hostname === 'onemorebeer.pl' || url.hostname.endsWith('.onemorebeer.pl'),
  parseCards: () => [],
};
