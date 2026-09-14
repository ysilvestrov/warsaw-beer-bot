import {
  matchPrepared,
  createFallbackBudget,
  type CatalogBeer,
  type PreparedCatalog,
  type FallbackBudget,
} from './matcher';
import { normalizeBrewery, normalizeName, numericTokensCompatible } from './normalize';

export interface CatalogBeerWithRating extends CatalogBeer {
  rating_global: number | null;
  untappd_id?: number | null;
}

export interface MatchInput {
  brewery: string;
  name: string;
  abv?: number | null;
}

export interface MatchedBeer {
  id: number;
  name: string;
  brewery: string;
  rating_global: number | null;
  untappd_id: number | null;
}

/** #614: аліас із пам'яті злиття — нормалізована пара картки крамниці → канонічний рядок. */
export interface AliasSource {
  beer_id: number;
  /** Сира назва картки: числові токени, які normalizeName відкидає, порівнюються лише з неї. */
  name: string;
  normalized_brewery: string;
  normalized_name: string;
}

export type AliasIndex = ReadonlyMap<string, { beerId: number; name: string }>;

// Роздільник `|`, а не пробіл: нормалізовані рядки складаються з літер, цифр і пробілів, тож
// пробіл склеїв би «a b» + «c» і «a» + «b c» в один ключ.
const aliasKey = (normalizedBrewery: string, normalizedName: string): string =>
  `${normalizedBrewery}|${normalizedName}`;

export function buildAliasIndex(rows: readonly AliasSource[]): AliasIndex {
  return new Map(rows.map((r) => [
    aliasKey(r.normalized_brewery, r.normalized_name),
    { beerId: r.beer_id, name: r.name },
  ]));
}

// #614: ключ — ті самі normalizeBrewery/normalizeName, якими ensureBeerRow рахував пару сироти з
// того самого сирого тексту картки. Цифри нормалізація відкидає, тож аліас картки «…8» мав би той
// самий ключ, що й картка «…10»; numericTokensCompatible (#617) не пускає таку картку на чужий
// аліас. Рядок, якого немає в цьому знімку каталогу, — не влучання.
function aliasTarget(
  aliases: AliasIndex | undefined,
  item: MatchInput,
  byId: Map<number, CatalogBeerWithRating>,
): CatalogBeerWithRating | null {
  if (!aliases || aliases.size === 0) return null;
  const hit = aliases.get(aliasKey(normalizeBrewery(item.brewery), normalizeName(item.name)));
  if (!hit || !numericTokensCompatible(item.name, hit.name)) return null;
  return byId.get(hit.beerId) ?? null;
}

const toMatchedBeer = (beer: CatalogBeerWithRating): MatchedBeer => ({
  id: beer.id,
  name: beer.name,
  brewery: beer.brewery,
  rating_global: beer.rating_global,
  untappd_id: beer.untappd_id ?? null,
});

export interface MatchListResult {
  raw: { brewery: string; name: string };
  matched_beer: MatchedBeer | null;
  is_drunk: boolean;
  drunk_uncertain: boolean;
  user_rating: number | null;
  /** How the catalog row was reached; null when nothing matched. */
  source: 'exact' | 'fuzzy' | null;
  /**
   * False when the per-request full-catalog fallback budget (#279) denied this item a
   * search. `matched_beer: null` with `searched: false` means "never looked at", NOT
   * "absent from the catalog" — collapsing the two lets a caller assert what we never checked.
   */
  searched: boolean;
}

// Hands control back to the event loop so the long-poll bot processes its updates
// between CPU bursts. setImmediate fires after pending I/O callbacks.
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

export interface MatchListOptions {
  // DI seam so tests can count yields deterministically; production uses the default.
  yield?: () => Promise<void>;
  // #614: пам'ять злиття. Перевіряється до матчера; без неї — поведінка як до #614.
  aliases?: AliasIndex;
}

export interface MatchListOutcome {
  results: MatchListResult[];
  fallback: FallbackBudget;
}

export async function matchBeerList(
  prepared: PreparedCatalog,
  byId: Map<number, CatalogBeerWithRating>,
  drunkSet: Set<number>,
  ratingByBeerId: Map<number, number>,
  items: MatchInput[],
  opts: MatchListOptions = {},
): Promise<MatchListOutcome> {
  const yield_ = opts.yield ?? yieldToEventLoop;
  const budget = createFallbackBudget();
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const viaAlias = aliasTarget(opts.aliases, item, byId);
    if (viaAlias) {
      out.push({
        raw,
        matched_beer: toMatchedBeer(viaAlias),
        is_drunk: drunkSet.has(viaAlias.id),
        drunk_uncertain: false,
        user_rating: ratingByBeerId.get(viaAlias.id) ?? null,
        source: 'exact',
        searched: true,
      });
      await yield_();
      continue;
    }
    // The budget is shared across the batch, so per-item "was it searched" is read as a
    // delta on the shared counter — no change to matcher.ts is needed.
    const skippedBefore = budget.budgetSkipped;
    const m = matchPrepared(item, prepared, budget);
    const searched = budget.budgetSkipped === skippedBefore;
    if (!m) {
      out.push({
        raw, matched_beer: null, is_drunk: false, drunk_uncertain: false,
        user_rating: null, source: null, searched,
      });
    } else {
      const beer = byId.get(m.id)!;
      out.push({
        raw,
        matched_beer: toMatchedBeer(beer),
        is_drunk: m.source === 'exact' && drunkSet.has(m.id),
        drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
        user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
        source: m.source,
        searched,
      });
    }
    await yield_();
  }
  return { results: out, fallback: budget };
}
