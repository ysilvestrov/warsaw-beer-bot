import type { DB } from './db';
import { bumpCatalogVersion } from './catalog-version';
import { numericTokensCompatible } from '../domain/normalize';
import { cardAbv, cardText } from '../domain/card-text';

export type UntappdIdSource = 'search' | 'bid' | 'curated' | 'checkin';

// #384: a stored link may be replaced by a shop-published bid only when WE put it there
// by guessing. 'curated' is a human decision; 'checkin' is Untappd's own record. The same
// list keeps a bid from *weakening* either stamp when it merely confirms the link.
export const PROVENANCE_REFUSING_OVERRIDE: readonly UntappdIdSource[] = ['curated', 'checkin'];

export function refusesBidOverride(source: string | null | undefined): boolean {
  return (PROVENANCE_REFUSING_OVERRIDE as readonly string[]).includes(source ?? '');
}

// Stamps 'bid' on whichever row now owns this untappd_id (the enriched row, or the
// canonical row it was merged into). untappd_id is UNIQUE, so this touches one row.
export function stampBidProvenance(db: DB, bid: number): void {
  const holes = PROVENANCE_REFUSING_OVERRIDE.map(() => '?').join(', ');
  db.prepare(
    `UPDATE beers SET untappd_id_source = 'bid'
       WHERE untappd_id = ? AND COALESCE(untappd_id_source, '') NOT IN (${holes})`,
  ).run(bid, ...PROVENANCE_REFUSING_OVERRIDE);
}

export interface BeerInput {
  untappd_id?: number | null;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
  /** #384: provenance of untappd_id. Omitted leaves any existing value untouched. */
  untappd_id_source?: UntappdIdSource;
}

export interface BeerRow extends BeerInput {
  id: number;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
  rating_checked_at: string | null;
  web_tried_at: string | null;
}

// #617: провенанс лінка лише посилюється. 'curated' — рішення людини, 'checkin' — власний запис
// Untappd, 'bid' — опублікований крамницею, 'search' — наше вгадування. Старий upsertBeer робив
// COALESCE(нове, старе) і так понижував пін до 'checkin'.
const SOURCE_RANK: Record<UntappdIdSource, number> = { search: 1, bid: 2, checkin: 3, curated: 4 };

function strongerSource(stored: UntappdIdSource | null, incoming: UntappdIdSource): UntappdIdSource {
  if (stored === null) return incoming;
  return SOURCE_RANK[incoming] > SOURCE_RANK[stored] ? incoming : stored;
}

export interface BidBeerInput {
  untappd_id: number;
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
  untappd_id_source: UntappdIdSource;
}

// #617: сирота, яку можна резолвити цим bid — рівно одна з тією самою нормалізованою парою і
// сумісними цифровими токенами назви. normalizeName викидає цифри, тож без другої умови чекін
// «Rochefort 10» віддав би bid сироті «Rochefort 8». Двозначність не вирішується вгадуванням.
function resolvableOrphan(db: DB, b: BidBeerInput): { id: number; untappd_id_source: UntappdIdSource | null } | null {
  const orphans = db
    .prepare(
      `SELECT id, name, untappd_id_source FROM beers
        WHERE untappd_id IS NULL AND normalized_brewery = ? AND normalized_name = ?`,
    )
    .all(b.normalized_brewery, b.normalized_name) as {
      id: number; name: string; untappd_id_source: UntappdIdSource | null;
    }[];
  const compatible = orphans.filter((o) => numericTokensCompatible(o.name, b.name));
  return compatible.length === 1 ? compatible[0] : null;
}

// #617: ідентичність за Untappd bid — для синку чекінів, /import і refresh-untappd.
// Рядок шукається за bid; не знайдено — серед сиріт (resolvableOrphan); інакше новий рядок.
// Злінкованого рядка з іншим bid не торкається ніколи. Назва й броварня не змінюються (#618),
// провенанс лише посилюється. Пошук і запис — одна транзакція.
export function upsertBeerByBid(db: DB, b: BidBeerInput): number {
  return db.transaction((): number => {
    const byBid = db
      .prepare('SELECT id, untappd_id_source FROM beers WHERE untappd_id = ?')
      .get(b.untappd_id) as { id: number; untappd_id_source: UntappdIdSource | null } | undefined;

    if (byBid) {
      // Рядок уже злінкований цим bid: факти лише заповнюють порожнє. Синк передає null, і
      // саме тут старий upsertBeer стирав рейтинг/стиль/ABV.
      db.prepare(
        `UPDATE beers SET
           style = COALESCE(style, ?),
           abv = COALESCE(abv, ?),
           rating_global = COALESCE(rating_global, ?),
           untappd_id_source = ?
         WHERE id = ?`,
      ).run(
        b.style ?? null, b.abv ?? null, b.rating_global ?? null,
        strongerSource(byBid.untappd_id_source, b.untappd_id_source), byBid.id,
      );
      bumpCatalogVersion();
      return byBid.id;
    }

    const orphan = resolvableOrphan(db, b);
    if (orphan) {
      // #614: «сирота» тут може бути рядком з обнуленим вручну bid, чиї аліаси доводили старий bid; без скидання
      // синк чекінів чи /import оживляв би їх під новим bid (рев'ю 9, M2). Та сама умова IS NOT, що й у
      // recordLookupSuccess і pinMatch.
      dropAliasesOnRelink(db, orphan.id, b.untappd_id);
      // Факти сироти прийшли з тексту крана/крамниці, а той ABV «буває помилковим» (spec.md
      // §/newbeers) — Untappd переважає, як у recordLookupSuccess; порожній вхід лишає факти
      // сироти. Разом із лінком іде й стан сироти: listUntriagedFailures і listLockedRows не
      // фільтрують untappd_id IS NULL, тож він тріажив би вже злінковане пиво.
      db.prepare(
        `UPDATE beers SET
           untappd_id = ?,
           style = COALESCE(?, style),
           abv = COALESCE(?, abv),
           rating_global = COALESCE(?, rating_global),
           untappd_id_source = ?
         WHERE id = ?`,
      ).run(
        b.untappd_id, b.style ?? null, b.abv ?? null, b.rating_global ?? null,
        strongerSource(orphan.untappd_id_source, b.untappd_id_source), orphan.id,
      );
      db.prepare('DELETE FROM enrich_failures WHERE beer_id = ?').run(orphan.id);
      bumpCatalogVersion();
      return orphan.id;
    }

    const res = db.prepare(
      `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
         normalized_name, normalized_brewery, untappd_id_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      b.untappd_id, b.name, b.brewery, b.style ?? null, b.abv ?? null, b.rating_global ?? null,
      b.normalized_name, b.normalized_brewery, b.untappd_id_source,
    );
    bumpCatalogVersion();
    return Number(res.lastInsertRowid);
  })();
}

export interface OrphanBeerInput {
  name: string;
  brewery: string;
  style?: string | null;
  abv?: number | null;
  rating_global?: number | null;
  normalized_name: string;
  normalized_brewery: string;
}

// #617: рядок без bid — для гілки сироти refresh-ontap і рядків /import без bid. Шукає лише серед
// сиріт із сумісними цифровими токенами назви; знайдену (найстарішу) повертає без перезапису.
// Злінкованого рядка не торкається ніколи: сирота поряд зі злінкованим вінтажем тієї ж назви —
// нормальний стан (UNIQUE лише на untappd_id). Фільтр цифр — з рев'ю гілки: у гілці сироти
// refresh-ontap сирота з тією ж парою досяжна лише коли матчер відкинув її як інший рік, тож без
// фільтра кран «2025» прилипав би до сироти «2024».
// Відоме обмеження: сироти з однаковою парою й сумісними цифрами злипаються (напр. різниця лише в ABV).
export function ensureOrphan(db: DB, b: OrphanBeerInput): number {
  const orphans = db
    .prepare(
      `SELECT id, name FROM beers
        WHERE untappd_id IS NULL AND normalized_brewery = ? AND normalized_name = ?
        ORDER BY id`,
    )
    .all(b.normalized_brewery, b.normalized_name) as { id: number; name: string }[];
  const existing = orphans.find((o) => numericTokensCompatible(o.name, b.name));
  if (existing) return existing.id;

  const res = db.prepare(
    `INSERT INTO beers (untappd_id, name, brewery, style, abv, rating_global,
       normalized_name, normalized_brewery)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.name, b.brewery, b.style ?? null, b.abv ?? null, b.rating_global ?? null,
    b.normalized_name, b.normalized_brewery,
  );
  bumpCatalogVersion();
  return Number(res.lastInsertRowid);
}

// #369: one place decides whether a relayed ABV is usable. Kept permissive on
// purpose — 0 is a real value (a 0.0% beer, the #322 disambiguator), and the upper
// bound is a garbage filter, not a domain limit (freeze-distilled beers reach ~67%).
export function sanitizeAbv(abv: number | undefined): number | undefined {
  if (abv === undefined) return undefined;
  if (!Number.isFinite(abv)) return undefined;
  if (abv < 0 || abv > 100) return undefined;
  return abv;
}

export interface OrphanFacts {
  abv?: number;
  style?: string;
}

export interface FillResult {
  /** An orphan row gained an ABV it did not have — the caller should re-arm its backoff. */
  abvGained: boolean;
  /** Any column was written. */
  changed: boolean;
}

// #369: shop-published facts for a beer that arrived over the extension relay.
// Fills ONLY columns that are currently NULL, and ONLY on orphan rows: a matched
// row's abv/style belong to Untappd, matching is already done, and a shop value
// could only introduce drift. Never overwrites.
export function fillOrphanFacts(db: DB, beerId: number, facts: OrphanFacts): FillResult {
  const none: FillResult = { abvGained: false, changed: false };
  const abv = sanitizeAbv(facts.abv);
  const style = facts.style;
  if (abv === undefined && style === undefined) return none;

  const row = db
    .prepare('SELECT untappd_id, abv, style FROM beers WHERE id = ?')
    .get(beerId) as { untappd_id: number | null; abv: number | null; style: string | null } | undefined;
  if (!row || row.untappd_id != null) return none;

  const abvGained = row.abv == null && abv !== undefined;
  const styleGained = row.style == null && style !== undefined;
  if (!abvGained && !styleGained) return none;

  db.prepare('UPDATE beers SET abv = COALESCE(abv, ?), style = COALESCE(style, ?) WHERE id = ?')
    .run(abvGained ? abv : null, styleGained ? style : null, beerId);
  bumpCatalogVersion();
  return { abvGained, changed: true };
}

// #369: a row that just gained an ABV deserves an immediate retry — the previous
// lookup ran blind, which is the whole bug. Resets the backoff so isEligible()
// returns true at once. isNotABeer still gates eligibility separately.
// #558: and ALWAYS clears the `unrescued` marker. unlock-fixed-orphans skips calling this
// for a row ONLY when the marker names the very issue that just closed (its guard compares
// `unrescued_issue` against `issue_number`, review finding #1, 2026-09-02) — a marker naming
// a different, stale issue (re-triage, or a CLAUDE.md sub-issue remap) reaches here along
// the ordinary re-arm path, and clearing it is correct: that marker was evidence about a
// fix nobody has replayed against the row's current issue, so it must not survive a re-arm
// that just gave the row a fresh, untested shot. Every OTHER caller (an ops re-arm, or a
// fresh ABV in ensureBeerRow) is unconditionally explicit new evidence, same as before.
export function rearmLookup(db: DB, beerId: number): void {
  // #576: `rearm_count` монотонний і НЕ обнуляється — саме він робить ре-арм спостережуваним
  // тоді, коли обнулення нічого не змінює (рядок уже мав нулі). Див. міграцію 28.
  db.prepare(
    `UPDATE beers
        SET untappd_lookup_at = NULL, untappd_lookup_count = 0, rearm_count = rearm_count + 1
      WHERE id = ?`,
  ).run(beerId);
  db.prepare(
    'UPDATE enrich_failures SET unrescued_at = NULL, unrescued_issue = NULL WHERE beer_id = ?',
  ).run(beerId);
}

export interface CatalogRow {
  id: number;
  brewery: string;
  name: string;
  abv: number | null;
  rating_global: number | null;
  untappd_id: number | null;
}

export function loadCatalog(db: DB): CatalogRow[] {
  return db
    .prepare('SELECT id, brewery, name, abv, rating_global, untappd_id FROM beers')
    .all() as CatalogRow[];
}

// #614: аліаси пам'яті злиття для перевірки перед матчером. Аліас рядка без untappd_id не читається —
// та сама жива перевірка, що й isRememberedMerge (#366). Правило «рядок каталогу з тим самим текстом
// важить більше» застосовує buildAliasIndex, бо кеш і так має весь каталог.
export interface AliasRow {
  beer_id: number;
  brewery_text: string;
  name_text: string;
  abv_key: string;
}

export function loadAliases(db: DB): AliasRow[] {
  return db
    .prepare(
      `SELECT a.beer_id, a.brewery_text, a.name_text, a.abv_key
         FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
        WHERE b.untappd_id IS NOT NULL
        ORDER BY a.id`,
    )
    .all() as AliasRow[];
}

// #614: ключ аліасу картки — той самий, що в /match (aliasTarget): cardText броварні й назви і cardAbv
// СИРОГО ABV картки. Порожній текст ключа не має.
function cardAliasKey(brewery: string, name: string, abv: number | null | undefined) {
  const breweryText = cardText(brewery);
  const nameText = cardText(name);
  if (breweryText === '' || nameText === '') return null;
  return { breweryText, nameText, abvKey: cardAbv(abv) };
}

// #614: рядок, який довело злиття для цієї картки. Лише злінкований — та сама жива перевірка, що в loadAliases.
export function findAliasTarget(
  db: DB, brewery: string, name: string, abv: number | null | undefined,
): BeerRow | null {
  const key = cardAliasKey(brewery, name, abv);
  if (!key) return null;
  const row = db
    .prepare(
      `SELECT b.* FROM beer_aliases a JOIN beers b ON b.id = a.beer_id
        WHERE a.brewery_text = ? AND a.name_text = ? AND a.abv_key = ? AND b.untappd_id IS NOT NULL`,
    )
    .get(key.breweryText, key.nameText, key.abvKey) as BeerRow | undefined;
  return row ?? null;
}

// #614: прийнятий суперечливий bid спростовує аліас саме цієї картки; інші ключі того самого рядка лишаються.
export function deleteAlias(db: DB, brewery: string, name: string, abv: number | null | undefined): void {
  const key = cardAliasKey(brewery, name, abv);
  if (!key) return;
  db.prepare('DELETE FROM beer_aliases WHERE brewery_text = ? AND name_text = ? AND abv_key = ?')
    .run(key.breweryText, key.nameText, key.abvKey);
  bumpCatalogVersion();
}

export function findBeerByNormalized(
  db: DB, normBrewery: string, normName: string,
): BeerRow | null {
  const row = db
    .prepare('SELECT * FROM beers WHERE normalized_brewery = ? AND normalized_name = ?')
    .get(normBrewery, normName) as BeerRow | undefined;
  return row ?? null;
}

export function getBeer(db: DB, beerId: number): BeerRow | null {
  const row = db
    .prepare('SELECT * FROM beers WHERE id = ?')
    .get(beerId) as BeerRow | undefined;
  return row ?? null;
}

// #614: аліас доводить «картка = пиво з цим bid». Коли в рядка змінюється untappd_id — зокрема з NULL,
// обнуленого вручну, — його аліаси втрачають доказ і видаляються. Для того самого bid умова
// `untappd_id IS NOT ?` не виконується, тож нічого не відбувається.
export function dropAliasesOnRelink(db: DB, beerId: number, newBid: number): void {
  db.prepare(
    `DELETE FROM beer_aliases
      WHERE beer_id = ?
        AND EXISTS (SELECT 1 FROM beers WHERE id = ? AND untappd_id IS NOT ?)`,
  ).run(beerId, beerId, newBid);
}

export function recordLookupSuccess(
  db: DB,
  beerId: number,
  r: {
    bid: number;
    style: string | null;
    abv: number | null;
    global_rating: number | null;
  },
  at: string,
): void {
  // #614: транзакція — якщо UPDATE впаде на UNIQUE (bid уже має власника), аліаси не стираються
  // наполовину: applyLookupOutcome далі зливає рядок, і їх забирає каскад.
  db.transaction(() => {
    dropAliasesOnRelink(db, beerId, r.bid);
    db.prepare(
      `UPDATE beers SET
         untappd_id = ?,
         untappd_id_source = 'search',
         style = COALESCE(?, style),
         abv = COALESCE(?, abv),
         rating_global = COALESCE(?, rating_global),
         untappd_lookup_at = ?
       WHERE id = ?`,
    ).run(r.bid, r.style, r.abv, r.global_rating, at, beerId);
  })();
  bumpCatalogVersion();
}

// Merges an orphan beer into a canonical catalog entry by redirecting all match_links and
// deleting the orphan. Called when recordLookupSuccess hits a UNIQUE constraint (the found
// untappd_id already belongs to another row).
export function mergeIntoCanonical(
  db: DB,
  orphanId: number,
  canonicalId: number,
  at: string,
  aliasSource?: { brewery: string; name: string; abv?: number | null },
): void {
  db.transaction(() => {
    // #366: the merge is the only moment we learn "this ontap_ref is that canonical beer".
    // The stamp keeps that knowledge past the next ingest; without it refreshOntap recomputes,
    // misses again (that is why the row needed a merge) and re-creates the orphan — ~65 wasted
    // Untappd lookups a day, plus repeat metered web-fallback calls.
    // Only an exact/parser-choice link (confidence 1.0) carries evidence: its own tap text is
    // what the lookup resolved. A fuzzy satellite (<1) was a matcher guess about the orphan, so
    // it is redirected like before but NOT made durable — it keeps re-orphaning and gets looked
    // up on its own text, which is the more accurate answer.
    db.prepare(
      'UPDATE match_links SET untappd_beer_id = ?, merged_at = ? WHERE untappd_beer_id = ? AND confidence >= 1.0',
    ).run(canonicalId, at, orphanId);
    db.prepare('UPDATE match_links SET untappd_beer_id = ? WHERE untappd_beer_id = ?')
      .run(canonicalId, orphanId);
    // checkins.beer_id → beers(id) has NO ON DELETE CASCADE and foreign_keys=ON, so a check-in
    // on the orphan would abort the DELETE. Point it at the canonical row first (as pinMatch does).
    db.prepare('UPDATE checkins SET beer_id = ? WHERE beer_id = ?').run(canonicalId, orphanId);
    // #614: злиття — єдиний момент, коли відомо «картка, яку перевірив пошук, = канонічний
    // рядок». DELETE нижче знищив би це знання, і /match на кожне завантаження сторінки знову не
    // впізнавав би ту саму картку крамниці. Власні аліаси рядка, що зливається, НЕ переносяться —
    // їх забирає ON DELETE CASCADE. Крон і пошуковий шлях /enrich/result збагачують лише сироти, а
    // сирота аліасів не має; рядок з аліасами доходить сюди лише через репарацію #384, тобто коли
    // його bid виявився хибним — а аліаси доводили саме той bid.
    const orphan = db
      .prepare('SELECT brewery, name, abv FROM beers WHERE id = ?')
      .get(orphanId) as { brewery: string; name: string; abv: number | null } | undefined;
    // #614: аліас — лише коли злита сирота і є цією карткою. ensureBeerRow цифр не бачить, тож сирота могла
    // прийти від іншої картки («Ґвара #6» для запиту «Ґвара #7»), а частину доказу зібрано з полів рядка, а не
    // картки: веб-фолбек шукає текстом і ABV рядка, lookupBeer — з його ABV. Тоді невідомо, яку з двох карток
    // довів пошук, і промах безпечніший за аліас. ABV не порівнюється: шлях пошуку передає row.abv, а доказ
    // шляху bid узятий з полів картки, тоді як репарація #384 зливає рядок з ABV з Untappd.
    const source = aliasSource ?? orphan;
    const sameCard = source !== undefined && orphan !== undefined
      && cardText(source.brewery) === cardText(orphan.brewery) && cardText(source.name) === cardText(orphan.name);
    if (source && sameCard) {
      const breweryText = cardText(source.brewery);
      const nameText = cardText(source.name);
      const abvKey = cardAbv(source.abv);
      // Порожній текст не прив'язаний ні до крамниці, ні до пива: доказ злиття на ньому ділився б між
      // картками (рев'ю 3: «Browar», «2085 Brewery» і '' зводились в один ключ нормалізатора).
      if (breweryText !== '' && nameText !== '') {
        // Той самий текст уже вказує на інший рядок → переходить на новий: найсвіжіше злиття має
        // найсвіжіший доказ. Рядок каталогу з тим самим текстом вимикає аліас під час читання
        // (buildAliasIndex), тож перевірки власника під час запису немає.
        db.prepare(
          `INSERT INTO beer_aliases (beer_id, brewery, name, brewery_text, name_text, abv_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(brewery_text, name_text, abv_key) DO UPDATE SET
             beer_id = excluded.beer_id,
             brewery = excluded.brewery,
             name = excluded.name,
             created_at = excluded.created_at`,
        ).run(canonicalId, source.brewery, source.name, breweryText, nameText, abvKey, at);
      }
    }
    db.prepare('DELETE FROM beers WHERE id = ?').run(orphanId);
  })();
  bumpCatalogVersion();
}

export function recordLookupNotFound(db: DB, beerId: number, at: string): void {
  db.prepare(
    `UPDATE beers SET
       untappd_lookup_at = ?,
       untappd_lookup_count = untappd_lookup_count + 1
     WHERE id = ?`,
  ).run(at, beerId);
}

export function recordLookupTransient(
  db: DB,
  beerId: number,
  at: string,
): void {
  db.prepare(
    'UPDATE beers SET untappd_lookup_at = ? WHERE id = ?',
  ).run(at, beerId);
}

import { isEligible, RECURRING_CLASSES } from '../domain/lookup-backoff';

export interface LookupCandidate {
  id: number;
  brewery: string;
  name: string;
  untappd_lookup_at: string | null;
  untappd_lookup_count: number;
  // #421: the backoff schedule differs by class — `not_on_untappd` waits on Untappd's
  // catalogue growing and so repeats its last delay forever, while every other class
  // keeps the terminal schedule. Selected here so the pool query stays the single place
  // that reads enrich_failures for a candidate.
  review_class: string | null;
}

// #421: a verdict that names an unfixed bug is a settled question — while the issue is
// open the answer cannot move, so re-asking Untappd spends quota on nothing AND burns the
// row's four backoff attempts before its fix ships. The row is held out of both pools
// until `unlock-fixed-orphans` sees its issue leave the open set and stamps `unlocked_at`.
//
// Three conditions, each load-bearing: the class must name a fix owner (only matcher_bug
// and parser_bug do), the row must name WHICH fix (`issue_number`, v23 — a verdict with no
// issue could never be unlocked, so locking it would be a permanent seal, the very thing
// #377 spent a design removing), and the free retry must not already be spent.
//
// Deliberately NOT applied in two places. `/enrich/candidates` searches in the user's own
// Untappd session (#89), so the quota this saves is not ours to save and a locked row may
// still be findable there. `orphansRelayQueue` in stats.ts counts the whole drain QUEUE, not
// the slice eligible right now — which is why it already skips the backoff filter too;
// hiding locked rows there would make the backlog look like it shrank when it only went
// quiet. Hence this is appended at the two pool call sites rather than folded into
// orphanNotOnTapPredicate, which stats.ts shares.
//
// Assumes the `beers` alias `b`, like orphanNotOnTapPredicate.
export const lockedRowPredicate = `EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND ef.review_class IN ('matcher_bug', 'parser_bug')
             AND ef.issue_number IS NOT NULL
             AND ef.unlocked_at IS NULL
         )`;

// #486: the single definition of "this beer is on a tap right now" — a `match_links` row
// reaching a tap on some pub's LATEST snapshot. `listLookupCandidates` interpolates it as-is;
// `orphanNotOnTapPredicate` below interpolates its negation, which is what makes the two pools
// a partition rather than two conditions that merely looked complementary. Bakes in the `beers`
// alias `b`, like the fragments around it; WHERE-clause fragment only.
export const onLatestTapPredicate = `EXISTS (
           SELECT 1 FROM match_links ml
           JOIN taps t ON t.beer_ref = ml.ontap_ref
           JOIN tap_snapshots ts ON ts.id = t.snapshot_id
           JOIN (
             SELECT pub_id, MAX(snapshot_at) AS m
             FROM tap_snapshots
             GROUP BY pub_id
           ) latest ON latest.pub_id = ts.pub_id
                  AND latest.m = ts.snapshot_at
           WHERE ml.untappd_beer_id = b.id
         )`;

export function listLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  // SQL pre-filter: orphan beers (untappd_id NULL) whose beer_id is on the
  // latest snapshot of at least one pub, excluding ones triaged as `not_a_beer`
  // (merch, bundles, wine — re-querying a T-shirt can never match) or retired
  // (provably resolved by a shipped fix — re-querying is dead work).
  // #377 part B: `not_a_beer` is the ONLY verdict that removes a row from a pool.
  // Every other class is a statement about what we can resolve TODAY and is
  // overturned by shipped fixes, so those rows must stay reachable — otherwise the
  // 0<->>0 auto-unseal in recordEnrichFailure can never fire, because the seal is
  // what keeps the row away from the lookup that would lift it.
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count,
              (SELECT ef.review_class FROM enrich_failures ef WHERE ef.beer_id = b.id)
                AS review_class
       FROM beers b
       WHERE b.untappd_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
         )
         AND NOT ${lockedRowPredicate}
         AND ${onLatestTapPredicate}
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // JS-side backoff filter (isEligible lives in lookup-backoff; reproducing
  // its math in SQLite julianday arithmetic would duplicate the schedule
  // and drift over time).
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count,
      RECURRING_CLASSES.includes(r.review_class ?? '')),
  );

  return eligible.slice(0, limit);
}

// #368/#486: shared WHERE predicate — "orphan that is NOT on a tap right now" (untappd_id
// IS NULL, minus not_a_beer/retired, minus anything currently on a latest-snapshot tap). Used
// by listRelayLookupCandidates below (the drain query) AND by orphansRelayQueue in stats.ts
// (the digest metric), so the two can't silently diverge if one is edited later. Bakes in `b`
// as the `beers` table alias — every call site must FROM/JOIN beers AS b. Fragment only, no
// WHERE keyword/SELECT/ORDER BY/LIMIT — each caller keeps owning its own query shape. The
// digest metric interpolates this as-is and deliberately skips the JS-side backoff filter
// (isEligible) applied below: it counts the whole drain queue, not just the slice eligible to
// query right now.
//
// #486: the third clause is the NEGATION of onLatestTapPredicate, not an independent test.
// It used to be `NOT EXISTS(match_links)`, which is strictly narrower — a beer whose link no
// longer reaches a latest-snapshot tap satisfied neither pool and became unreachable by any
// cron. spec.md called that deliberate; it cost 462 of 911 orphans, 376 of them never queried
// once. Writing it as the negation makes the partition a property of the construction.
export const orphanNotOnTapPredicate = `b.untappd_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM enrich_failures ef
           WHERE ef.beer_id = b.id
             AND (ef.review_class = 'not_a_beer' OR ef.retired_at IS NOT NULL)
         )
         AND NOT ${onLatestTapPredicate}`;

// #368/#486: relay-пул — його вміст тепер визначає ЗАПЕРЕЧЕННЯ onLatestTapPredicate.
// Рядки, намінчені `/enrich/candidates` (ensureBeerRow біжить по кожній картці сторінки
// крамниці), не отримують рядка в `match_links`, бо лінки пише лише on-tap ingest — їх
// onLatestTapPredicate виключає структурно, а не тому, що вони зійшли з кранів.
// Виключення not_a_beer/retired, backoff і сортування — ті самі. Оскільки
// orphanNotOnTapPredicate — буквальне заперечення onLatestTapPredicate, пули диз'юнктні
// за побудовою (дедуп не потрібен) і разом покривають усіх orphan'ів: включно з тим, у
// кого є рядок у `match_links`, але кран зійшов з останнього снапшоту паба — такий тепер
// потрапляє саме сюди, в relay-пул, а не в жоден.
export function listRelayLookupCandidates(
  db: DB,
  limit: number,
  now: Date,
): LookupCandidate[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.brewery, b.name,
              b.untappd_lookup_at, b.untappd_lookup_count,
              (SELECT ef.review_class FROM enrich_failures ef WHERE ef.beer_id = b.id)
                AS review_class
       FROM beers b
       WHERE ${orphanNotOnTapPredicate}
         AND NOT ${lockedRowPredicate}
       ORDER BY b.untappd_lookup_count ASC, b.id ASC`,
    )
    .all() as LookupCandidate[];

  // Той самий JS-фільтр backoff, що й у listLookupCandidates: відтворювати його
  // математику в julianday-арифметиці SQLite означало б дублювати розклад.
  const eligible = rows.filter((r) =>
    isEligible(now, r.untappd_lookup_at, r.untappd_lookup_count,
      RECURRING_CLASSES.includes(r.review_class ?? '')),
  );

  return eligible.slice(0, limit);
}

// #616: звірка рейтингу злінкованого пива з Untappd (Algolia getObjects за bid). На відміну від
// колишньої HTML-джоби — без гейту «на крані» і з повторною звіркою наявних рейтингів.
export const RATING_RECHECK_DAYS = 30;

export interface RatingHydrationCandidate {
  id: number;
  untappd_id: number;
  rating_refresh_at: string | null;
  rating_refresh_count: number;
}

export function listRatingHydrationCandidates(
  db: DB,
  limit: number,
  now: Date,
): RatingHydrationCandidate[] {
  const cutoff = new Date(now.getTime() - RATING_RECHECK_DAYS * 86_400_000).toISOString();
  // Порядок: спершу рядки без рейтингу (0 — наслідок старих записів до межі парсерів, #616),
  // далі ніколи не звірені, далі найдавніше звірені. «Ніколи не звірені» окремого ключа не мають:
  // у SQLite NULL при ASC іде першим. Штампи пишуться toISOString(), тож лексикографічне
  // порівняння рядків = хронологічне.
  const rows = db
    .prepare(
      `SELECT id, untappd_id, rating_refresh_at, rating_refresh_count
       FROM beers
       WHERE untappd_id IS NOT NULL
         AND (rating_checked_at IS NULL OR rating_checked_at < ?)
       ORDER BY (rating_global IS NULL OR rating_global = 0) DESC,
                rating_checked_at ASC,
                id ASC`,
    )
    .all(cutoff) as RatingHydrationCandidate[];
  // rating_refresh_* тепер — бекоф лише для bid, якого Algolia не знає; після успішної звірки
  // count = 0 і at = NULL, тож на решту рядків фільтр не діє.
  return rows
    .filter((r) => isEligible(now, r.rating_refresh_at, r.rating_refresh_count))
    .slice(0, Math.max(0, limit));   // від'ємний limit у slice означав би «усі, крім останніх»
}

export interface HydratedRatingFacts {
  global_rating: number | null;
  style: string | null;
  abv: number | null;
}

export interface RatingHydrationOutcome {
  updated: number;
  changed: number;
  unknown: number;
  skipped: number;
}

export function applyHydratedRatings(
  db: DB,
  hits: Map<number, HydratedRatingFacts | null>,
  bids: number[],
  nowIso: string,
): RatingHydrationOutcome {
  const read = db.prepare('SELECT rating_global, style, abv FROM beers WHERE untappd_id = ?');
  // Рейтинг — перезапис (зокрема NULL: Untappd не показує рейтинг до 10 оцінок); стиль і ABV лише
  // заповнюють порожнє. Пошук за untappd_id (UNIQUE), а не за id вибірки: рядок, злитий між
  // вибіркою й записом, дає 0 змінених рядків, а не запис у чужий рядок.
  const write = db.prepare(
    `UPDATE beers SET
       rating_global = ?,
       style = COALESCE(style, ?),
       abv = COALESCE(abv, ?),
       rating_checked_at = ?,
       rating_refresh_at = NULL,
       rating_refresh_count = 0
     WHERE untappd_id = ?`,
  );
  const backoff = db.prepare(
    `UPDATE beers SET
       rating_refresh_at = ?,
       rating_refresh_count = rating_refresh_count + 1
     WHERE untappd_id = ?`,
  );
  const out: RatingHydrationOutcome = { updated: 0, changed: 0, unknown: 0, skipped: 0 };
  db.transaction(() => {
    for (const bid of bids) {
      const before = read.get(bid) as
        | { rating_global: number | null; style: string | null; abv: number | null }
        | undefined;
      if (!before) continue;
      // #616: відсутній ключ — відповідь нічого не довела про цей bid (запис не розібрався або належить
      // іншому bid): ні штампа, ні бекофу. Явний null — Algolia цього bid не знає: лише бекоф.
      if (!hits.has(bid)) {
        out.skipped++;
        continue;
      }
      const hit = hits.get(bid);
      if (!hit) {
        backoff.run(nowIso, bid);
        out.unknown++;
        continue;
      }
      write.run(hit.global_rating, hit.style, hit.abv, nowIso, bid);
      out.updated++;
      const style = before.style ?? hit.style;
      const abv = before.abv ?? hit.abv;
      if (before.rating_global !== hit.global_rating || style !== before.style || abv !== before.abv) {
        out.changed++;
      }
    }
  })();
  // Кеш /match залежить від рейтингу/стилю/ABV, не від штампа: без змін — без перебудови.
  if (out.changed > 0) bumpCatalogVersion();
  return out;
}

export interface ProfileBeerFacts {
  global_rating: number | null;
  global_rating_shown: boolean;
  abv: number | null;
}

// #616: рядок, знайдений за bid зі сторінки `/beers` профілю (refreshAllUntappd). Блок «Global Rating»
// (число або «N/A») — пряма відповідь Untappd про рейтинг: перезапис і штамп звірки. Без блоку
// сторінка про рейтинг нічого не каже — рейтинг і штамп не чіпаються. ABV сторінки перемагає, коли
// він є (як і до #616). Сторінка — власний запис Untappd про те, що користувач пив цей bid, тож
// провенанс лінка посилюється до 'checkin' ('curated' лишається).
export function recordProfileBeer(
  db: DB,
  beerId: number,
  facts: ProfileBeerFacts,
  nowIso: string,
): void {
  const before = db
    .prepare('SELECT rating_global, abv, untappd_id_source FROM beers WHERE id = ?')
    .get(beerId) as
    | { rating_global: number | null; abv: number | null; untappd_id_source: UntappdIdSource | null }
    | undefined;
  if (!before) return;
  const source = strongerSource(before.untappd_id_source, 'checkin');
  if (facts.global_rating_shown) {
    db.prepare(
      // Рейтинг звірено — бекоф «Algolia не знає bid» скидається: сторінка довела, що bid живий, тож
      // вичерпаний бекоф не має назавжди виключати рядок із гідратора (рев'ю #625).
      `UPDATE beers SET
         rating_global = ?,
         abv = COALESCE(?, abv),
         rating_checked_at = ?,
         rating_refresh_at = NULL,
         rating_refresh_count = 0,
         untappd_id_source = ?
       WHERE id = ?`,
    ).run(facts.global_rating, facts.abv, nowIso, source, beerId);
  } else {
    db.prepare('UPDATE beers SET abv = COALESCE(?, abv), untappd_id_source = ? WHERE id = ?')
      .run(facts.abv, source, beerId);
  }
  const abvChanged = facts.abv !== null && facts.abv !== before.abv;
  const ratingChanged = facts.global_rating_shown && facts.global_rating !== before.rating_global;
  // Кеш /match залежить від рейтингу й ABV, не від штампа чи провенансу.
  if (abvChanged || ratingChanged) bumpCatalogVersion();
}

export function readWebTriedAt(db: DB, beerId: number): string | null {
  const row = db
    .prepare('SELECT web_tried_at FROM beers WHERE id = ?')
    .get(beerId) as { web_tried_at: string | null } | undefined;
  return row?.web_tried_at ?? null;
}

export function stampWebTried(db: DB, beerId: number, iso: string): void {
  db.prepare('UPDATE beers SET web_tried_at = ? WHERE id = ?').run(iso, beerId);
}
