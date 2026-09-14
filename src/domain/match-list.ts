import {
  matchPrepared,
  createFallbackBudget,
  type CatalogBeer,
  type PreparedCatalog,
  type FallbackBudget,
} from './matcher';
import { cardAbv, cardText } from './card-text';

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

/** #614: аліас із пам'яті злиття — точний текст і ABV картки крамниці → канонічний рядок. */
export interface AliasSource {
  beer_id: number;
  brewery_text: string;
  name_text: string;
  abv_key: string;
}

export type AliasIndex = ReadonlyMap<string, number>;

// Роздільник `|`: cardText зберігає пробіли, тож пробіл склеїв би «a b» + «c» і «a» + «b c».
const textKey = (breweryText: string, nameText: string): string => `${breweryText}|${nameText}`;
const aliasKey = (breweryText: string, nameText: string, abvKey: string): string =>
  `${textKey(breweryText, nameText)}|${abvKey}`;

const ALIAS_CATALOG_CHUNK = 2000;

// #614: ЗЛІНКОВАНИЙ рядок каталогу з тим самим ключем картки — точний текст І cardAbv(abv), рівний abv_key
// аліасу, — важить більше за аліас: це конфлікт двох доказів для тієї самої картки, і картку тоді відповідає
// матчер. Сирота з тим самим текстом аліас НЕ вимикає: це наш незакритий плейсхолдер (/enrich/candidates для
// ABV-близнюка), і /match віддав би на неї exact без untappd_id і без статусу «пив» (проби periph-*).
// Злінкований близнюк з ІНШИМ ABV теж не вимикає (рев'ю 9, M1): матчер віддавав картці його рядок як exact,
// розширення бачило суперечливий bid, і репарація #384 зливала рядок близнюка в канонічний — пінг-понг на кожному
// завантаженні з переїздом чекінів. Той самий ключ у самій цілі аліас не вимикає. cardText на ~33.6k рядках
// одним шматком блокував цикл подій на 74–113 мс (рев'ю 4), тож поступаємося циклу кожні 2000 рядків, як
// prepareCatalogChunked.
export async function buildAliasIndex(
  aliases: readonly AliasSource[],
  catalog: readonly { id: number; brewery: string; name: string; abv?: number | null; untappd_id?: number | null }[],
  yield_: () => Promise<void> = yieldToEventLoop,
): Promise<AliasIndex> {
  const holders = new Map<string, Set<number>>();
  for (let i = 0; i < catalog.length; i += ALIAS_CATALOG_CHUNK) {
    const end = Math.min(i + ALIAS_CATALOG_CHUNK, catalog.length);
    for (let j = i; j < end; j++) {
      const row = catalog[j];
      if (row.untappd_id == null) continue;
      const key = aliasKey(cardText(row.brewery), cardText(row.name), cardAbv(row.abv));
      (holders.get(key) ?? holders.set(key, new Set()).get(key)!).add(row.id);
    }
    await yield_();
  }
  const index = new Map<string, number>();
  for (const a of aliases) {
    const held = holders.get(aliasKey(a.brewery_text, a.name_text, a.abv_key));
    if (held && [...held].some((id) => id !== a.beer_id)) continue;
    index.set(aliasKey(a.brewery_text, a.name_text, a.abv_key), a.beer_id);
  }
  return index;
}

// #614: ключ — точний текст картки (cardText): нічого зі змісту не губиться, тож картка з іншими
// цифрами, роком у дужках чи іншою броварнею аліасу не дістає. Порожній текст аліасу не має.
// Рядок, якого немає в цьому знімку каталогу, — не влучання. ABV картки — частина ключа: 0%-аліас не
// дістається алкогольній картці з тим самим текстом.
function aliasTarget(
  aliases: AliasIndex | undefined,
  item: MatchInput,
  byId: Map<number, CatalogBeerWithRating>,
): CatalogBeerWithRating | null {
  if (!aliases || aliases.size === 0) return null;
  const breweryText = cardText(item.brewery);
  const nameText = cardText(item.name);
  if (breweryText === '' || nameText === '') return null;
  const beerId = aliases.get(aliasKey(breweryText, nameText, cardAbv(item.abv)));
  return beerId === undefined ? null : (byId.get(beerId) ?? null);
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
