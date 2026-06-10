import type { SiteAdapter } from './types';
import { beerrepublic } from './beerrepublic';
import { onemorebeer } from './onemorebeer';
import { beerfreak } from './beerfreak';
import { bierloods22 } from './bierloods22';

export const ADAPTERS: SiteAdapter[] = [beerrepublic, onemorebeer, beerfreak, bierloods22];

export function pickAdapter(url: URL): SiteAdapter | null {
  return ADAPTERS.find((a) => a.hostMatch(url)) ?? null;
}
