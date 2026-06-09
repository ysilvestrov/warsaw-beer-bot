import type { SiteAdapter } from './types';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';

export const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer];

export function pickAdapter(url: URL): SiteAdapter | null {
  return ADAPTERS.find((a) => a.hostMatch(url)) ?? null;
}
