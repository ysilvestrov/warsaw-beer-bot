import {
  matchPrepared,
  createFallbackBudget,
  type CatalogBeer,
  type PreparedCatalog,
  type FallbackBudget,
} from './matcher';
import { cardAbv, cardText } from './card-text';
import { bidBreweryAgrees, FLASKER_IMPORTED_BEER_PLACEHOLDER } from './bid-identity';

export interface CatalogBeerWithRating extends CatalogBeer {
  rating_global: number | null;
  untappd_id?: number | null;
}

export interface MatchInput {
  brewery: string;
  name: string;
  abv?: number | null;
  /** #633: Untappd id, який крамниця публікує на сторінці товару. */
  bid?: number;
  /** #633: brand зі сторінки товару — доказ броварні, проти якого перевіряється bid. */
  brand?: string;
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

// Ключ — JSON-масив полів, а не склейка роздільником: cardText зберігає будь-який символ картки, тож і пробіл, і `|`
// склеїли б «a|b» + «c» з «a» + «b|c» в один ключ, і картка отримала б чужий аліас (AI-рев'ю PR #644). У JSON межі
// полів однозначні за побудовою.
const aliasKey = (breweryText: string, nameText: string, abvKey: string): string =>
  JSON.stringify([breweryText, nameText, abvKey]);

// #614: індекс пам'яті злиття — «ключ картки → рядок». Аліас відповідає за свій точний ключ завжди; конфлікт
// доказів для тієї самої картки розв'язує запис (ON CONFLICT у mergeIntoCanonical, recordLookupSuccess переносить
// аліас ключа на рядок самої картки), а не вгадування під час читання. Три версії правила «рядок каталогу важить
// більше» (за текстом; лише злінковані; з ABV рядка) кожна давала хибну ідентичність, бо порівнювали поля різного
// походження: ABV злінкованого рядка — з Untappd, ключ аліасу — з картки крамниці (рев'ю 8–10).
export function buildAliasIndex(aliases: readonly AliasSource[]): AliasIndex {
  return new Map(aliases.map((a) => [aliasKey(a.brewery_text, a.name_text, a.abv_key), a.beer_id]));
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
  // #633: untappd_id → рядок того самого знімка каталогу. Без нього bid ігнорується.
  byUntappdId?: ReadonlyMap<number, CatalogBeerWithRating>;
}

/** #633: скільки карток несли опублікований bid і чим це скінчилося — для лічильників у лозі роуту. */
export interface BidStats {
  sent: number;
  exact: number;
  conflict: number;
  /** #614: картка мала аліас пам'яті злиття, а bid суперечив броварні — виграв аліас. */
  aliasKept: number;
}

export interface MatchListOutcome {
  results: MatchListResult[];
  fallback: FallbackBudget;
  bid: BidStats;
}

// #633: доказ броварні для опублікованого bid — brand зі сторінки товару. Заглушка Flasker
// «Імпортне пиво» — не броварня, а розділ вітрини, тож для неї (і для порожнього brand) доказом
// стає броварня самої картки, яку клієнт і так надсилає.
function bidEvidenceBrewery(item: MatchInput): string | null {
  const brand = (item.brand ?? '').trim();
  // Заглушка Flasker — не броварня, а розділ вітрини: для неї доказом стає броварня картки.
  if (brand === FLASKER_IMPORTED_BEER_PLACEHOLDER) return item.brewery.trim() || null;
  // Немає brand — немає чим перевіряти. Броварню картки саму по собі доказом не беремо: у Flasker
  // вона виводиться з назви товару й для 57 з 709 карток неправильна (#650).
  return brand === '' ? null : brand;
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
  const bid: BidStats = { sent: 0, exact: 0, conflict: 0, aliasKept: 0 };
  const out: MatchListResult[] = [];
  for (const item of items) {
    const raw = { brewery: item.brewery, name: item.name };
    const exactOn = (beer: CatalogBeerWithRating): MatchListResult => ({
      raw,
      matched_beer: toMatchedBeer(beer),
      is_drunk: drunkSet.has(beer.id),
      drunk_uncertain: false,
      user_rating: ratingByBeerId.get(beer.id) ?? null,
      source: 'exact',
      searched: true,
    });

    // #633: рядок опублікованого bid — лише з цього знімка каталогу.
    const bidRow = item.bid === undefined ? null : (opts.byUntappdId?.get(item.bid) ?? null);
    if (item.bid !== undefined) bid.sent++;
    // Доказ броварні потрібен кроку 2 (прийняти bid) і кроку 4 (віддати рядок bid попри
    // суперечність). Крок 3 його не питає: там доказ — збіг самої назви.
    const evidence = bidRow ? bidEvidenceBrewery(item) : null;

    // Крок 2: броварня картки підтверджує bid — відповідь готова, матчер не потрібен,
    // бюджет фолбеку не витрачається.
    if (bidRow && evidence !== null && bidBreweryAgrees(evidence, bidRow.brewery)) {
      bid.exact++;
      out.push(exactOn(bidRow));
      await yield_();
      continue;
    }

    const viaAlias = aliasTarget(opts.aliases, item, byId);
    let result: MatchListResult;
    if (viaAlias) {
      result = exactOn(viaAlias);
    } else {
      // The budget is shared across the batch, so per-item "was it searched" is read as a
      // delta on the shared counter — no change to matcher.ts is needed.
      const skippedBefore = budget.budgetSkipped;
      const m = matchPrepared(item, prepared, budget);
      const searched = budget.budgetSkipped === skippedBefore;
      if (!m) {
        result = {
          raw, matched_beer: null, is_drunk: false, drunk_uncertain: false,
          user_rating: null, source: null, searched,
        };
      } else {
        const beer = byId.get(m.id)!;
        result = {
          raw,
          matched_beer: toMatchedBeer(beer),
          is_drunk: m.source === 'exact' && drunkSet.has(m.id),
          drunk_uncertain: m.source === 'fuzzy' && drunkSet.has(m.id),
          user_rating: m.source === 'exact' ? (ratingByBeerId.get(m.id) ?? null) : null,
          source: m.source,
          searched,
        };
      }
    }

    if (bidRow) {
      if (result.matched_beer?.id === bidRow.id) {
        // Крок 3: bid і назва вказали на один рядок — два незалежні докази, тож exact
        // (назва могла дійти туди fuzzy: броварня з самих цифр, заглушка вітрини).
        bid.exact++;
        result = exactOn(bidRow);
      } else if (evidence === null) {
        // bid без brand доказу броварні не має — картка лишається на відповіді назви чи аліасу,
        // так наче bid не надсилали. Суперечність побачить клієнт і поведе її в репарацію #384.
      } else if (viaAlias) {
        // Крок 4а (#614): аліас — наш доведений запис саме для цієї картки, а суперечливий bid —
        // найслабший доказ у цьому правилі. Забирати картку в аліасу він не може; розбіжність
        // усе одно доїде до /enrich, бо untappd_id відповіді не дорівнює опублікованому bid.
        bid.aliasKept++;
      } else {
        // Крок 4: броварня суперечить bid, і назва повела в інший бік. Пиво ми знайшли, але
        // впевненості немає: рядок bid віддається як fuzzy — ✅ не ставиться ніколи, а ❓
        // з'являється рівно за наявним правилом (fuzzy + випите).
        bid.conflict++;
        result = {
          raw,
          matched_beer: toMatchedBeer(bidRow),
          is_drunk: false,
          drunk_uncertain: drunkSet.has(bidRow.id),
          user_rating: null,
          source: 'fuzzy',
          // Бюджет фолбеку належить матчеру: якщо він цій позиції в пошуку відмовив, відповідь
          // за bid цього не приховує (spec.md §POST /match).
          searched: result.searched,
        };
      }
    }

    out.push(result);
    await yield_();
  }
  return { results: out, fallback: budget, bid };
}
