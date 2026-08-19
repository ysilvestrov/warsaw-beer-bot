import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from '../types';
import {
  findBeerByNormalized,
  getBeer,
  upsertBeer,
  fillOrphanFacts,
  rearmLookup,
  refusesBidOverride,
  sanitizeAbv,
  stampBidProvenance,
  type OrphanFacts,
} from '../../storage/beers';
import { isNotABeer, reviewClassOf } from '../../storage/enrich_failures';
import { normalizeBrewery, normalizeName, searchQueryLadder } from '../../domain/normalize';
import { isEligible, RECURRING_CLASSES } from '../../domain/lookup-backoff';
import { buildSearchUrl, htmlSearch } from '../../sources/untappd/search';
import {
  ALGOLIA_DEFAULTS,
  ALGOLIA_HITS_PER_PAGE,
  ALGOLIA_INDEX_NAME,
  parseAlgoliaResponse,
  type AlgoliaQuery,
  type AlgoliaResponse,
} from '../../sources/untappd/algolia';
import { lookupBeer, type LookupOutcome } from '../../domain/untappd-lookup';
import { resolveByBid } from '../../domain/bid-identity';
import { lookupWithFallback } from '../../domain/web-fallback';
import { applyLookupOutcome } from '../../domain/lookup-outcome';
import {
  BEER_TEXT_LIMIT_CHARS,
  ENRICH_CANDIDATES_BODY_LIMIT_BYTES,
  ENRICH_HTML_LIMIT_CHARS,
  ENRICH_RESULT_BODY_LIMIT_BYTES,
  PAGE_URL_LIMIT_CHARS,
  payloadBodyLimit,
  payloadSizeValidationHook,
} from '../middleware/payload-limit';

const CandidatesBody = z.object({
  beers: z
    .array(z.object({
      brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
      name: z.string().max(BEER_TEXT_LIMIT_CHARS),
      // #369: deliberately unbounded here — sanitizeAbv applies the sanity range.
      // A strict .min/.max would reject the entire 200-beer batch over one rogue card.
      // nullable() for the same reason: JSON.stringify turns NaN/Infinity into null,
      // so a single malformed card would otherwise 400 the whole page's payload.
      abv: z.number().nullable().optional(),
      style: z.string().max(BEER_TEXT_LIMIT_CHARS).nullable().optional(),
      // #384: the Untappd id the shop publishes for this product. Only the id is needed
      // here — eligibility asks whether it contradicts the stored link; the slug/brand
      // the guard verifies against travel with /enrich/result. Strict (unlike abv):
      // a bid is machine-extracted from a URL, so a malformed one is a client bug.
      bid: z.number().int().positive().optional(),
    }))
    .min(1)
    .max(200),
});

const ResultBody = z.object({
  brewery: z.string().max(BEER_TEXT_LIMIT_CHARS),
  name: z.string().max(BEER_TEXT_LIMIT_CHARS),
  abv: z.number().nullable().optional(),
  style: z.string().max(BEER_TEXT_LIMIT_CHARS).nullable().optional(),
  // #384: the Untappd identity the shop publishes on its own product page, plus the
  // page's brand (what the guard verifies against). Optional — absent from every
  // client below 0.14, and absent from every shop that does not publish a bid.
  bid: z.number().int().positive().optional(),
  bidSlug: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
  brand: z.string().max(BEER_TEXT_LIMIT_CHARS).optional(),
  html: z.string().max(ENRICH_HTML_LIMIT_CHARS).optional(),
  algolia: z.object({
    hits: z.array(z.record(z.string(), z.unknown())).optional(),
    nbHits: z.number().optional(),
  }).optional(),
  // #391: the ladder rung the client actually executed. The relayed hits answer exactly
  // one query, and only the client knows which — without this the failure row cites a
  // search nobody ran. Optional: absent from every build below 0.14.
  //
  // The bound is derived, not borrowed: a rung is built from brewery AND name (joined by a
  // space), each of which /enrich/candidates accepts at BEER_TEXT_LIMIT_CHARS. Reusing the
  // single-field limit here would 413 the whole request over a query this very server had
  // offered — losing the enrichment entirely for an advisory field whose only other failure
  // mode is being silently ignored (withRelayQuery).
  query: z.string().max(BEER_TEXT_LIMIT_CHARS * 2 + 1).optional(),
  pageUrl: z.string().max(PAGE_URL_LIMIT_CHARS).optional(),
}).refine((v) => typeof v.html === 'string' || v.algolia !== undefined, {
  message: 'html or algolia is required',
});

function algoliaQuery(deps: ApiDeps, query: string): AlgoliaQuery {
  return {
    appId: deps.env.UNTAPPD_ALGOLIA_APP_ID ?? ALGOLIA_DEFAULTS.appId,
    searchKey: deps.env.UNTAPPD_ALGOLIA_SEARCH_KEY ?? ALGOLIA_DEFAULTS.searchKey,
    indexName: ALGOLIA_INDEX_NAME,
    query,
    hitsPerPage: ALGOLIA_HITS_PER_PAGE,
  };
}

// #391: replace the search URLs `lookupBeer` invented with the rung the client reports
// having executed. Only a value that is genuinely one of the rungs /enrich/candidates
// would have offered is honoured — the check is a pure function, and it keeps a buggy or
// forged client from writing arbitrary text into the column triage reads (#381).
function withRelayQuery(
  outcome: LookupOutcome,
  brewery: string,
  name: string,
  query: string | undefined,
): LookupOutcome {
  if (query === undefined || !searchQueryLadder(brewery, name).includes(query)) return outcome;
  const url = buildSearchUrl(query);
  if (outcome.kind === 'not_found') return { ...outcome, searchUrls: [url] };
  if (outcome.kind === 'blocked') return { ...outcome, searchUrl: url };
  return outcome;
}

// Ensures a beer row exists for (brewery, name) and returns it.
// May return a pre-existing matched row, not only a freshly created orphan.
// #369: `facts` are shop-published abv/style relayed by the extension. On insert
// they seed the row; on an existing orphan they fill NULL columns only. A newly
// gained ABV re-arms the lookup backoff, because the previous attempt ran blind.
function ensureBeerRow(db: ApiDeps['db'], brewery: string, name: string, facts: OrphanFacts = {}) {
  const normalized_brewery = normalizeBrewery(brewery);
  const normalized_name = normalizeName(name);
  const existing = findBeerByNormalized(db, normalized_brewery, normalized_name);
  if (existing) {
    const { abvGained, changed } = fillOrphanFacts(db, existing.id, facts);
    if (abvGained) rearmLookup(db, existing.id);
    return abvGained || changed ? getBeer(db, existing.id)! : existing;
  }
  const id = upsertBeer(db, {
    untappd_id: null, name, brewery,
    style: facts.style ?? null, abv: sanitizeAbv(facts.abv) ?? null,
    rating_global: null, normalized_name, normalized_brewery,
  });
  return getBeer(db, id)!;
}

export function enrichRoute(app: Hono<ApiEnv>, deps: ApiDeps): void {
  app.post(
    '/enrich/candidates',
    payloadBodyLimit(deps, ENRICH_CANDIDATES_BODY_LIMIT_BYTES, 'route'),
    zValidator('json', CandidatesBody, payloadSizeValidationHook(deps) as never),
    (c) => {
    const { beers } = c.req.valid('json');
    const now = new Date();
    const candidates = deps.db.transaction(() =>
      beers.map((b) => {
        const row = ensureBeerRow(deps.db, b.brewery, b.name, {
          abv: b.abv ?? undefined, style: b.style ?? undefined,
        });
        // #384: a linked row is normally done. The exception is a shop that publishes a
        // *different* Untappd id than the one we stored — then the row is a repair
        // candidate. refusesBidOverride is the same helper /enrich/result applies, so a
        // curated or check-in-sourced link is never even offered here.
        //
        // The not_a_beer veto and the lookup backoff still apply, but note what the backoff
        // does NOT cover: /enrich/result records nothing when it *rejects* a bid (guard
        // veto, hydrate failure, unknown bid) — it returns the stored link untouched — so
        // untappd_lookup_at/count never move and such a row stays eligible indefinitely.
        // What bounds it is the extension's badge cache: a card that stays a cache hit is
        // never re-offered, so a rejected bid costs one search slot per ~8h per browser.
        const contradicts =
          b.bid !== undefined && row.untappd_id != null && row.untappd_id !== b.bid;
        const eligible =
          (row.untappd_id == null ||
            (contradicts && !refusesBidOverride(row.untappd_id_source))) &&
          !isNotABeer(deps.db, row.id) &&
          isEligible(now, row.untappd_lookup_at, row.untappd_lookup_count,
            RECURRING_CLASSES.includes(reviewClassOf(deps.db, row.id) ?? ''));
        // #421: the fix-keyed lock is deliberately ABSENT here. This search runs in the
        // user's own Untappd session (#89), so it costs none of the quota the lock exists
        // to protect, and a locked row may still be found by a client the matcher cannot
        // reach. The recurring backoff tail, by contrast, DOES apply — it is a statement
        // about the beer's chance of existing, not about whose quota pays.
        // #391: the #382 ladder, narrowest first. The LAST rung is by construction
        // cleanSearchQuery(brewery, name) — the query this endpoint has always sent — so
        // `algolia` keeps its meaning and a published 0.13.0 client is untouched. The
        // narrow rung travels as an extra optional field the old client ignores, and is
        // absent whenever the rungs agree (every all-Latin pair).
        const rungs = searchQueryLadder(b.brewery, b.name);
        const narrow = rungs.length > 1 ? rungs[0] : null;
        return {
          brewery: b.brewery,
          name: b.name,
          eligible,
          algolia: algoliaQuery(deps, rungs[rungs.length - 1]),
          ...(narrow ? { algoliaNarrow: algoliaQuery(deps, narrow) } : {}),
        };
      }),
    )();
    return c.json({ candidates });
    },
  );

  app.post(
    '/enrich/result',
    payloadBodyLimit(deps, ENRICH_RESULT_BODY_LIMIT_BYTES, 'route'),
    zValidator('json', ResultBody, payloadSizeValidationHook(deps) as never),
    async (c) => {
    const { brewery, name, abv, style, html, algolia, pageUrl, bid, bidSlug, brand, query } =
      c.req.valid('json');
    const row = ensureBeerRow(deps.db, brewery, name, {
      abv: abv ?? undefined, style: style ?? undefined,
    });
    // Only orphans need enrichment. If the row was already enriched by an earlier
    // relay/cron, report the existing canonical match so the extension can update
    // the page without reprocessing or overwriting it.
    //
    // #384: EXCEPT when the shop publishes a bid that disagrees with a link we
    // derived ourselves. Without that exception a wrong machine-made link is
    // unreachable here and can never be repaired. Inert for every client that
    // sends no bid — i.e. everything in production today.
    const stored = row.untappd_id ?? null;
    const mayOverride =
      bid !== undefined && stored !== bid && !refusesBidOverride(row.untappd_id_source);
    if (stored != null && !mayOverride) {
      return c.json({ status: 'matched', untappd_id: stored, rating_global: row.rating_global });
    }

    const nowIso = new Date().toISOString();

    // The shop knows its own product's Untappd page; that beats our guessing. Any
    // rejection (guard veto, hydrate failure, unknown bid) falls through to the
    // normal pipeline below, so this path is never worse than not having it.
    if (bid !== undefined) {
      const resolved = await resolveByBid({
        db: deps.db, bid, bidSlug, brand,
        shopName: name, shopAbv: abv ?? null,
        hydrate: deps.hydrateByBid,
      });
      if (resolved.kind === 'accepted') {
        // `notes` (slug/name/abv divergence) are the only signal that would ever
        // surface a same-brewery wrong bid, which the guard cannot veto.
        deps.log.info(
          {
            beerId: row.id, bid, source: resolved.source,
            notes: resolved.notes, replaced: stored,
          },
          'enrich: identity from shop-published bid',
        );
        // Reuses the shared writer: UNIQUE clash → merge into the canonical row.
        const kind = applyLookupOutcome(
          { db: deps.db, log: deps.log }, row.id,
          { kind: 'matched', result: resolved.result }, nowIso,
          { brewery, name, sourceUrl: pageUrl },
        );
        if (kind === 'matched' || kind === 'merged') {
          stampBidProvenance(deps.db, resolved.result.bid);
          return c.json({
            status: 'matched',
            untappd_id: resolved.result.bid,
            rating_global: resolved.result.global_rating,
          });
        }
      } else {
        deps.log.warn(
          {
            beerId: row.id, bid, reason: resolved.reason,
            brand, recordBrewery: resolved.recordBrewery, err: resolved.error,
          },
          'enrich: shop-published bid rejected',
        );
      }
    }

    // The bid did not produce a link. A row that already has one must go back to
    // answering with it: only an orphan belongs in the search pipeline, and letting
    // a linked row through would mean a transient hydrate failure could re-guess and
    // clobber the stored link — strictly worse than not consulting the bid at all.
    if (stored != null) {
      return c.json({ status: 'matched', untappd_id: stored, rating_global: row.rating_global });
    }

    // Reuse the full server pick pipeline; the client already fetched, so the
    // injected search adapter just returns the relayed result payload.
    const search = algolia
      ? { search: async () => parseAlgoliaResponse(algolia as AlgoliaResponse) }
      : htmlSearch(html!);
    const outcome = withRelayQuery(
      await lookupWithFallback(
        () => lookupBeer({ brewery, name, abv: row.abv, search }),
        row.id,
        deps.webFallback ?? null,
      ),
      brewery,
      name,
      query,
    );
    // pageUrl (the shop page the beer was scraped from) becomes the failure row's sourceUrl.
    const kind = applyLookupOutcome({ db: deps.db, log: deps.log }, row.id, outcome, nowIso, { brewery, name, sourceUrl: pageUrl });
    // A merge is a success: the bid is real and already owned by a canonical row,
    // so answer like a match instead of the old not_found. `outcome.result` still
    // holds the bid — nothing needs plumbing through applyLookupOutcome. The
    // extension's status union is untouched ('merged' never crosses the boundary),
    // so old extension versions benefit without an update (#351).
    if ((kind === 'matched' || kind === 'merged') && outcome.kind === 'matched') {
      return c.json({ status: 'matched', untappd_id: outcome.result.bid, rating_global: outcome.result.global_rating });
    }
    return c.json({ status: kind });
    },
  );
}
