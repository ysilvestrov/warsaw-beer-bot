import type { DB } from '../storage/db';
import type { Env } from '../config/env';
import type pino from 'pino';
import type { HydratedBeer, SearchResult } from '../sources/untappd/search';

export interface ApiDeps {
  db: DB;
  env: Env;
  log: pino.Logger;
  // Optional web 0-candidate fallback; null/absent when unconfigured.
  webFallback?: ((beerId: number) => Promise<SearchResult | null>) | null;
  /**
   * #384: server-side Algolia hydrate-by-bid, used to resolve a shop-published bid
   * the local catalog does not know. Absent ⇒ bid resolution stays local-only.
   */
  hydrateByBid?: (bids: number[]) => Promise<Map<number, HydratedBeer | null>>;
  /** #923: admin Telegram message (install registration cap alert). Absent ⇒ no alert. */
  notifyAdmin?: (msg: string) => Promise<void>;
}

/**
 * Who is calling (#923). `install` is an extension install registered without Telegram: it carries
 * no personal data and is admitted only where optionalAuthMiddleware runs. `lastSeenDate` and
 * `extVersion` are the stored row, so a route can update the version without reading it again.
 */
export type Principal =
  | { kind: 'user'; telegramId: number }
  | { kind: 'install'; installId: string; lastSeenDate: string; extVersion: string | null };

// Hono generics: variables set on the request context by middleware. `telegramId` stays set for
// user principals only, so the routes that read it keep working unchanged.
export type ApiEnv = { Variables: { telegramId: number | null; principal: Principal | null } };
