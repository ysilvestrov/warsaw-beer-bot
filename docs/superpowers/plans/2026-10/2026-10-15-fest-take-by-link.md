# План: `/fest take <посилання>` і лічильник пошуку (PR 1)

Спека: `docs/superpowers/specs/2026-10/2026-10-15-fest-queue-reality-design.md` §PR 1.
Ядро (PR 2 — присутність, відмітки, стіл, `queue all`) — окремим планом після рев'ю цього PR.

Гейт кожної задачі: `npm test && npm run typecheck` (24 падіння в `scripts/` і одне в
`src/jobs/host-patch.test.ts` — середовище хмарної сесії, ідентичні на чистому `main`).

## Задача 1 — розбір і розгортання посилання (`src/sources/untappd/beer-link.ts`)

```ts
export type BeerLink = { bid: number } | { short: string } | null;
/** The first Untappd beer link in the text: a full /b/<slug>/<bid> or a short untp.beer one. */
export function beerLinkOf(text: string): BeerLink;
/** One GET without following: the bid from a 3xx Location on untappd.com/b/…/<bid>, else null. */
export async function resolveShortLink(url: string, fetchFn: typeof fetch, timeoutMs = 5000): Promise<number | null>;
```

- Повне: `^https://(www\.)?untappd\.com/b/[^/?#\s]+/(\d+)` (запит/фрагмент дозволені після bid).
- Коротке: `^https://untp\.beer/[A-Za-z0-9]+$` (лише цей хост і https — без SSRF).
- `resolveShortLink`: `fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(ms) })`;
  статус 300–399, `Location` → `beerLinkOf` → `{ bid }`; інше чи виняток → `null`.

Тести: обидві форми; `http://`, чужий хост, `/c/…`, `/v/…`, `untp.beer` з шляхом — null; `302` з
пивом / з закладом; `200`; виняток fetch.

## Задача 2 — `parseMcpBeer` (`src/sources/untappd/mcp-beer.ts`)

```ts
export function parseMcpBeer(result: ToolCallResult): BidBeerInput | null;
```

zod `{ beer: { bid, beer_name, beer_style?, beer_abv?, rating_score?, brewery: { brewery_name } } }`
(у тілі `get_beer` броварня лежить усередині `beer`). `rating_score` 0 → null (Untappd дає 0 для
пива без оцінок). Нормалізація — `normalizeName`/`normalizeBrewery`, `untappd_id_source: 'checkin'`.

Тести: урізане тіло з проби (6134008, PINTA); `isError`; не JSON; без броварні; рейтинг 0.

## Задача 3 — `/fest take <посилання>` (fest.ts, index.ts)

- `FestCommandDeps.resolveShortLink?(url)` і `lookupBeer?(bid)`; за замовчуванням у `index.ts` —
  `resolveShortLink(url, fetch)` і, з `FEST_MCP_URL`, `parseMcpBeer(await mcp.call('get_beer', { beerId }))`.
  `createFestMcp` виноситься вище за бота, крон бере той самий екземпляр.
- У `take`: `beerLinkOf(query)` ≠ null → bid → `beers.untappd_id` або `lookupBeer` + `upsertBeerByBid`
  → `takeBeer` → відповідь `fest.taken` з `↩️ Скасувати` (спільний хелпер із колбеком `fest:q`).
  Помилки: `fest.take_link_bad` (не пиво / не розгорнулося), `fest.take_link_unknown` (пива нема в БД
  і MCP не дав). Збій MCP-виклику (виняток) — те саме `take_link_unknown`, у лог.
- i18n uk/pl/en, `types.ts`.

Тести (`fest.wiring.test.ts`): пиво в БД — келих; пиво лише в MCP — рядок `beers` і келих;
без `lookupBeer` — `take_link_unknown`; коротке посилання; погане посилання; не член команди.

## Задача 4 — лічильник пошуку (#873) і документи

- `searchMenu` → `{ found, total }`; `add`/`take` при `total > found.length` — `fest.search_more`
  «Показано {shown} з {total} — уточніть запит.» (текст повідомлення з кнопками).
- `spec.md` (черга й `/fest take`), `docs/USER-GUIDE.md`.

Тести: 8 збігів — без рядка; 9 — «Показано 8 з 9».
