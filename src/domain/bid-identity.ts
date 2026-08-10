import type { DB } from '../storage/db';
import type { HydratedBeer, SearchResult } from '../sources/untappd/search';
import { breweryAliases, breweryAliasesMatch } from './matcher';

export type BidResolution =
  | { kind: 'accepted'; result: SearchResult; source: 'local' | 'hydrated'; notes: string[] }
  | {
      kind: 'rejected';
      reason: BidRejection;
      /**
       * The swallowed hydrate error ('hydrate-failed' only). Carried out so the caller
       * can log it: a 403 IP-block, a transient 5xx and a programming error are otherwise
       * indistinguishable downstream.
       */
      error?: unknown;
      /**
       * The brewery on the record the bid actually points at ('brewery-mismatch' only).
       * Logged next to the shop's brand so alias blind spots are measurable in production.
       */
      recordBrewery?: string;
    };

export type BidRejection =
  | 'not-hydrated'
  | 'hydrate-failed'
  | 'brewery-mismatch'
  | 'no-brand-to-verify';

export interface ResolveByBidArgs {
  db: DB;
  bid: number;
  /** Slug the shop published next to the bid. Logged on divergence, never a veto. */
  bidSlug?: string;
  /** JSON-LD brand from the product page. Absent ⇒ nothing to verify against ⇒ reject. */
  brand?: string;
  /** Shop-published name/abv. Divergence is recorded in `notes`, never a veto. */
  shopName?: string;
  shopAbv?: number | null;
  /** Absent when no Algolia client is wired — the local-catalog path still works. */
  hydrate?: (bids: number[]) => Promise<Map<number, HydratedBeer>>;
}

interface Candidate {
  result: SearchResult;
  slug: string | null;
  aliases: string[];
  source: 'local' | 'hydrated';
}

function fromLocal(db: DB, bid: number): Candidate | null {
  const row = db
    .prepare(
      `SELECT untappd_id, name, brewery, style, abv, rating_global
         FROM beers WHERE untappd_id = ?`,
    )
    .get(bid) as
    | { untappd_id: number; name: string; brewery: string; style: string | null; abv: number | null; rating_global: number | null }
    | undefined;
  if (!row) return null;
  return {
    result: {
      bid: row.untappd_id,
      beer_name: row.name,
      brewery_name: row.brewery,
      style: row.style,
      abv: row.abv,
      global_rating: row.rating_global,
    },
    // beer_slug is not stored locally — this is why slug divergence is logged, not vetoed.
    slug: null,
    aliases: [],
    source: 'local',
  };
}

// The ONLY veto. The shop can link someone else's beer; it cannot plausibly link a
// beer by a different brewery than the one it names on the same page.
function breweryAgrees(brand: string, c: Candidate): boolean {
  const shop = breweryAliases(brand);
  const record = [
    ...breweryAliases(c.result.brewery_name),
    ...c.aliases.flatMap((a) => breweryAliases(a)),
  ];
  return breweryAliasesMatch(shop, record);
}

export async function resolveByBid(args: ResolveByBidArgs): Promise<BidResolution> {
  const { db, bid, bidSlug, brand, shopName, shopAbv } = args;

  // 1. Local catalog first: ~34k rows, UNIQUE-indexed, and it keeps working while
  //    Untappd is blocking us.
  let candidate = fromLocal(db, bid);

  // 2. Miss → hydrate. Never throw: a hydrate failure must fall through to the
  //    normal lookup path, not fail the request.
  if (!candidate) {
    if (!args.hydrate) return { kind: 'rejected', reason: 'not-hydrated' };
    let hydrated: HydratedBeer | undefined;
    try {
      hydrated = (await args.hydrate([bid])).get(bid);
    } catch (e: unknown) {
      return { kind: 'rejected', reason: 'hydrate-failed', error: e };
    }
    if (!hydrated) return { kind: 'rejected', reason: 'not-hydrated' };
    candidate = {
      result: {
        bid: hydrated.bid,
        beer_name: hydrated.beer_name,
        brewery_name: hydrated.brewery_name,
        style: hydrated.style,
        abv: hydrated.abv,
        global_rating: hydrated.global_rating,
      },
      slug: hydrated.beer_slug,
      aliases: hydrated.brewery_alias,
      source: 'hydrated',
    };
  }

  // 3. Guard.
  if (!brand) return { kind: 'rejected', reason: 'no-brand-to-verify' };
  if (!breweryAgrees(brand, candidate)) {
    return {
      kind: 'rejected', reason: 'brewery-mismatch',
      recordBrewery: candidate.result.brewery_name,
    };
  }

  // Divergences worth seeing in logs, deliberately NOT vetoes — every one of these is
  // real for Tomatol Bulgogi, the case this feature exists to fix.
  const notes: string[] = [];
  if (bidSlug && candidate.slug && bidSlug !== candidate.slug) notes.push('slug-divergence');
  if (shopName && shopName !== candidate.result.beer_name) notes.push('name-divergence');
  if (shopAbv != null && candidate.result.abv != null && shopAbv !== candidate.result.abv) {
    notes.push('abv-divergence');
  }

  return { kind: 'accepted', result: candidate.result, source: candidate.source, notes };
}
